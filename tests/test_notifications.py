"""The daily alert as a notification on a phone.

Three parts are tried here: the words of the notice (made by the daily check),
the button on the page, and the small script beside the page that shows a
notification when one arrives. The two scripts run in a browser. Here they are
run with Node against stand-ins, see ``run_notify.js`` and ``run_sw.js``.
Where Node is missing, those tests are skipped.

The backend that sends the notifications has its own tests in ``notifications/``.
"""

import html
import json
import re
import shutil
import struct
import subprocess
import tempfile
import unittest
import zlib
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from parkbot import config as config_module
from parkbot import message, site, weather
from parkbot.config import ConfigError
from parkbot.council import parse
from parkbot.status import DayPlan, plan_days
from parkbot.store import CouncilStore
from parkbot.timeparse import Slot

from .helpers import CONFIG_FILE, FIXTURES, ROOT, forecast_json, load_config, seasons

MELBOURNE = ZoneInfo("Australia/Melbourne")
FRIDAY = date(2026, 11, 20)
BACKEND = "https://alerts.example"
TESTS = Path(__file__).parent


def at(day: date, hour: int, minute: int = 0) -> datetime:
    return datetime(day.year, day.month, day.day, hour, minute, tzinfo=MELBOURNE)


def november_store(read_at: datetime) -> CouncilStore:
    store = CouncilStore()
    html = (FIXTURES / "council_november_2026.html").read_text(encoding="utf-8")
    store.update(parse(html, read_at.date(), MELBOURNE), read_at.date(), read_at)
    return store


def november_plans(built: datetime, config=None) -> list[DayPlan]:
    config = config or load_config()
    return plan_days(built.date(), 8, november_store(built), seasons(), config.day_start, config.lights_off)


def wet_evening() -> weather.Forecast:
    """Rain on the Friday from 3 PM until 8, then dry. Every other day is dry."""

    def chance(day: date, hour: int) -> int:
        return 90 if day == FRIDAY and 15 <= hour < 20 else 5

    def mm(day: date, hour: int) -> float:
        return 2.0 if day == FRIDAY and 15 <= hour < 20 else 0.0

    return weather.parse(forecast_json(FRIDAY, 8, chance=chance, mm=mm))


class NoticeWordsTest(unittest.TestCase):
    """The notice says what the Telegram post says, as a title and a few lines."""

    def setUp(self):
        self.config = load_config()

    def test_the_title_is_what_is_booked_and_the_rest_follows(self):
        plan = november_plans(at(FRIDAY, 14, 45))[0]
        notice = message.notice(plan, wet_evening(), 14 * 60 + 45, self.config)
        self.assertEqual(notice["title"], "🔴 Booked 4 to 8 PM")
        self.assertEqual(
            notice["body"].split("\n"),
            [
                "🌧 Rain likely between 3 PM and 8 PM (up to 90%, about 10 mm).",
                "Heavy rain can cancel training, so the oval may free up early.",
                "Based on the hourly forecast, the best window to avoid the rain is 8 to 9 PM.",
            ],
        )

    def test_it_says_the_same_as_the_post(self):
        forecast = wet_evening()
        for built in (at(FRIDAY, 14, 45), at(FRIDAY, 17, 47), at(FRIDAY + timedelta(days=1), 14, 45), at(FRIDAY + timedelta(days=2), 15, 0)):
            with self.subTest(built=built):
                plan = november_plans(built)[0]
                post = message.daily(plan, forecast, built, self.config).split("\n")
                notice = message.notice(plan, forecast, built.hour * 60 + built.minute, self.config)
                # The post is the heading, the booked times, the rest, and the link.
                said = [line for line in post[1:-1] if line]
                self.assertEqual([line.rstrip(".") for line in said], [line.rstrip(".") for line in [notice["title"], *notice["body"].split("\n")] if line])

    def test_a_title_of_one_sentence_has_no_full_stop(self):
        free = DayPlan(FRIDAY, (), "council", note="From the council's schedule.")
        self.assertEqual(message.notice(free, None, 870, self.config)["title"], "🟢 No bookings today")
        over = DayPlan(FRIDAY, (Slot(600, 660),), "council")
        self.assertEqual(message.notice(over, None, 870, self.config)["title"], "🟢 Today's bookings have finished")

    def test_a_title_of_two_sentences_keeps_its_full_stops(self):
        unknown = DayPlan(FRIDAY, (), "none")
        self.assertEqual(message.notice(unknown, None, 870, self.config)["title"], "❔ No booking information for today. Check the signs at the park.")

    def test_a_closed_day_puts_the_council_notice_under_the_title(self):
        closed = DayPlan(FRIDAY, (Slot(360, 1320),), "council", closed=True, label="Turf works until 1 December.")
        notice = message.notice(closed, None, 870, self.config)
        self.assertEqual(notice["title"], "⛔ The oval is closed today")
        self.assertEqual(notice["body"].split("\n")[0], "Council notice: Turf works until 1 December.")

    def test_a_notice_is_plain_text_and_the_post_is_escaped(self):
        # A phone shows a notification exactly as it is written. Telegram reads "<" as markup.
        label = "Cricket & <finals>"
        plan = DayPlan(FRIDAY, (Slot(16 * 60, 20 * 60),), "council", label=label)
        self.assertEqual(message.notice(plan, None, 870, self.config)["title"], "🔴 Booked 4 to 8 PM (Cricket & <finals>)")
        post = message.daily(plan, None, at(FRIDAY, 14, 30), self.config)
        self.assertIn("🔴 Booked 4 to 8 PM (Cricket &amp; &lt;finals&gt;)", post)
        self.assertNotIn("<finals>", post)

    def test_a_day_that_is_not_confirmed_carries_its_warning(self):
        usual = DayPlan(FRIDAY, (Slot(16 * 60, 18 * 60),), "usual", note="Usual pattern, not confirmed by the council's page.")
        notice = message.notice(usual, None, 870, self.config)
        self.assertEqual(notice["title"], "🟠 Usually booked 4 to 6 PM")
        self.assertIn("⚠️ Usual pattern, not confirmed by the council's page.", notice["body"])


class NoticeInThePageDataTest(unittest.TestCase):
    """Every coming day has its notice ready, written for the time the alert goes out."""

    def data(self, built: datetime, forecast=None, config=None) -> dict:
        config = config or load_config()
        store = november_store(built)
        plans = plan_days(built.date(), 8, store, seasons(), config.day_start, config.lights_off)
        return site.page_data(config, plans, forecast, store, built)

    def test_every_day_has_a_notice(self):
        data = self.data(at(FRIDAY, 14, 45), wet_evening())
        self.assertEqual(len(data["days"]), 8)
        for day in data["days"]:
            with self.subTest(day=day["date"]):
                self.assertTrue(day["notice"]["title"])
                self.assertIsInstance(day["notice"]["body"], str)

    def test_a_morning_check_writes_todays_notice_for_the_afternoon(self):
        # At 6:17 AM "rain likely from about 7 AM" would be true, and no use at 3 PM.
        def chance(day: date, hour: int) -> int:
            return 90 if day == FRIDAY and (7 <= hour < 9 or 17 <= hour < 19) else 5

        forecast = weather.parse(forecast_json(FRIDAY, 8, chance=chance, mm=lambda day, hour: 1.0 if chance(day, hour) == 90 else 0.0))
        notice = self.data(at(FRIDAY, 6, 17), forecast)["days"][0]["notice"]
        self.assertEqual(notice["title"], "🔴 Booked 4 to 8 PM")
        self.assertIn("Rain likely between 5 PM and 7 PM", notice["body"])
        self.assertNotIn("7 AM", notice["body"])

    def test_an_evening_check_does_not_look_back(self):
        notice = self.data(at(FRIDAY, 17, 47), wet_evening())["days"][0]["notice"]
        self.assertEqual(notice["title"], "🔴 Booked until 8 PM")

    def test_a_later_days_notice_is_written_for_the_alert_time(self):
        built = at(FRIDAY, 19, 47)
        config = load_config()
        data = self.data(built, wet_evening())
        plans = november_plans(built)
        for index in (1, 2, 7):
            with self.subTest(day=data["days"][index]["date"]):
                expected = message.notice(plans[index], wet_evening(), config.alert_from(plans[index].day), config)
                self.assertEqual(data["days"][index]["notice"], expected)
        # Saturday's alert goes out in the morning, before the booking starts, so its notice names the whole booking.
        self.assertEqual(data["days"][1]["notice"]["title"], "🔴 Booked 10 AM to 6 PM")
        self.assertEqual(message.notice(plans[1], wet_evening(), config.alert_from(FRIDAY), config)["title"], "🔴 Booked until 6 PM")

    def test_at_the_weekend_todays_notice_is_written_for_the_morning(self):
        saturday = FRIDAY + timedelta(days=1)
        # The 6:17 AM check writes for the time the alert may first go out, half an hour before 8 AM.
        early = self.data(at(saturday, 6, 17))["days"][0]
        self.assertEqual((early["date"], early["notice"]["title"]), ("2026-11-21", "🔴 Booked 10 AM to 6 PM"))
        # A check later in the day does not look back.
        self.assertEqual(self.data(at(saturday, 11, 47))["days"][0]["notice"]["title"], "🔴 Booked until 6 PM")

    def test_an_earlier_forecast_is_named_only_in_todays_notice(self):
        forecast = wet_evening()
        forecast.saved_at = "11:47 AM"
        data = self.data(at(FRIDAY, 14, 45), forecast)
        self.assertIn("Forecast from 11:47 AM.", data["days"][0]["notice"]["body"])
        self.assertNotIn("Forecast from", data["days"][1]["notice"]["body"])

    def test_the_data_says_when_the_alert_goes_out_and_where_the_backend_is(self):
        data = self.data(at(FRIDAY, 14, 45))
        self.assertEqual(data["alert"], {"weekdays": 15 * 60, "weekends": 8 * 60, "until": 19 * 60})
        self.assertIsNone(data["push"])
        data = self.data(at(FRIDAY, 14, 45), config=load_config(push_url=BACKEND))
        self.assertEqual(data["push"], BACKEND)


class SettingTest(unittest.TestCase):
    def load(self, extra: str, before: str = ""):
        """The test settings with ``extra`` added at the end, or ``before`` put ahead of the first section."""
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "config.toml"
            path.write_text(before + CONFIG_FILE.read_text(encoding="utf-8") + extra, encoding="utf-8")
            return config_module.load(path)

    def test_without_the_section_there_are_no_notifications(self):
        self.assertEqual(load_config().push_url, "")
        self.assertEqual(self.load('\n[notifications]\nurl = ""\n').push_url, "")

    def test_the_backend_address_loses_its_closing_slash(self):
        self.assertEqual(self.load('\n[notifications]\nurl = "https://alerts.example/"\n').push_url, "https://alerts.example")

    def test_the_backend_address_must_be_a_plain_https_address(self):
        for bad in ("http://alerts.example", "alerts.example", "https://alerts.example/<x>"):
            with self.subTest(bad=bad):
                with self.assertRaises(ConfigError) as caught:
                    self.load(f'\n[notifications]\nurl = "{bad}"\n')
                self.assertIn("notifications.url", str(caught.exception))

    def test_a_section_of_the_wrong_kind_is_reported(self):
        with self.assertRaises(ConfigError) as caught:
            self.load("", before='notifications = "yes"\n')
        self.assertIn("[notifications]", str(caught.exception))

    def test_the_real_settings_file_has_the_section(self):
        self.assertIsInstance(config_module.load(ROOT / "config.toml").push_url, str)


class BuildTest(unittest.TestCase):
    def setUp(self):
        self._folder = tempfile.TemporaryDirectory()
        self.addCleanup(self._folder.cleanup)
        self.out = Path(self._folder.name) / "site"

    def build(self, config) -> str:
        built = at(FRIDAY, 14, 45)
        site.build(config, november_plans(built, config), None, november_store(built), built, self.out, ROOT / "assets")
        return (self.out / "index.html").read_text(encoding="utf-8")

    def rules(self, page: str) -> dict[str, str]:
        found = re.search(r'<meta http-equiv="Content-Security-Policy" content="([^"]*)">', page)
        return dict(part.split(" ", 1) for part in html.unescape(found.group(1)).split("; "))

    def test_without_a_backend_the_page_offers_no_notifications(self):
        page = self.build(load_config())
        self.assertNotIn('id="notify"', page)
        self.assertFalse((self.out / "sw.js").exists())
        rules = self.rules(page)
        self.assertEqual(rules["connect-src"], "'self'")
        self.assertNotIn("worker-src", rules)

    def test_with_a_backend_the_button_comes_first_and_is_the_filled_one(self):
        page = self.build(load_config(push_url=BACKEND, tip_url="https://ko-fi.com/example"))
        button = '<button class="button primary" type="button" id="notify" hidden>Get alerts on this device</button>'
        self.assertIn(button, page)
        # Hidden until the script finds that this browser can do it, with a line under it for what happened.
        note = '<p class="notify-note" id="notify-note" role="status" hidden></p>'
        self.assertIn(note, page)
        telegram = '<a class="button" href="https://t.me/ExampleParkDogs" rel="noopener">Get alerts on Telegram</a>'
        self.assertLess(page.index(button), page.index(note))
        self.assertLess(page.index(note), page.index(telegram))
        self.assertLess(page.index(telegram), page.index("Leave a tip"))
        self.assertEqual(page.count('id="notify"'), 1)
        # Only one button is filled in.
        self.assertEqual(page.count('class="button primary"'), 1)

    def test_the_button_stands_alone_when_there_is_no_telegram_channel(self):
        page = self.build(load_config(push_url=BACKEND, channel=""))
        self.assertIn('<nav class="actions"', page)
        self.assertIn('id="notify"', page)
        self.assertNotIn("Telegram", page)

    def test_the_page_may_talk_to_the_backend_and_to_nothing_else(self):
        page = self.build(load_config(push_url=BACKEND + "/v1"))
        # In the page the rules are written with their quote marks escaped, like any other attribute.
        self.assertIn("connect-src &#x27;self&#x27; https://alerts.example; manifest-src", page)
        rules = self.rules(page)
        self.assertEqual(rules["connect-src"], "'self' https://alerts.example")
        # The script that shows the notification is the page's own file, and no other may be started.
        self.assertEqual(rules["worker-src"], "'self'")
        self.assertEqual(rules["default-src"], "'none'")
        self.assertNotIn("unsafe-inline", rules["script-src"])

    def test_the_script_that_shows_the_notification_is_published_beside_the_page(self):
        self.build(load_config(push_url=BACKEND))
        self.assertEqual((self.out / "sw.js").read_bytes(), (site.WEB / "sw.js").read_bytes())
        # And taken away again if notifications are ever switched off.
        self.build(load_config())
        self.assertFalse((self.out / "sw.js").exists())

    def test_a_hidden_button_stays_hidden(self):
        # The button's own layout rule would otherwise show it despite "hidden".
        css = (site.WEB / "page.css").read_text(encoding="utf-8")
        self.assertIn(".button[hidden] { display: none; }", css)

    def test_the_icon_for_the_status_bar_is_published(self):
        self.build(load_config(push_url=BACKEND))
        self.assertTrue((self.out / "badge.png").is_file())
        self.assertIn('badge: "badge.png"', (site.WEB / "sw.js").read_text(encoding="utf-8"))

    def test_the_picture_with_nothing_on_it_is_published_and_is_empty(self):
        # A notification names it on Android phones, in place of the page's icon.
        self.build(load_config(push_url=BACKEND))
        shower = (site.WEB / "sw.js").read_text(encoding="utf-8")
        self.assertIn('"blank.png"', shower)
        self.assertNotIn("icon-192.png", shower)
        picture = (self.out / "blank.png").read_bytes()
        self.assertEqual(picture[:8], b"\x89PNG\r\n\x1a\n")
        # 192 by 192 dots, each with a colour and how far it lets the background through.
        self.assertEqual(struct.unpack(">IIBB", picture[16:26]), (192, 192, 8, 6))
        dots, at = b"", 8
        while at < len(picture):
            (length,) = struct.unpack(">I", picture[at : at + 4])
            if picture[at + 4 : at + 8] == b"IDAT":
                dots += picture[at + 8 : at + 8 + length]
            at += 12 + length
        # Every dot is nought: no colour, and nothing that covers what is behind it.
        self.assertEqual(set(zlib.decompress(dots)), {0})


ANDROID = "Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36"
IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1"
DESKTOP = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:145.0) Gecko/20100101 Firefox/145.0"
# The backend's public key as it sends it, and the same key as the bytes a browser wants.
KEY = "BAECAwQFBgcICQoLDA0ODw"
KEY_BYTES = [4, *range(1, 16)]
GOOD = {"/key": {"body": {"key": KEY}}, "/subscribe": {"body": {"ok": True, "new": True}}, "/unsubscribe": {"body": {"ok": True}}}


@unittest.skipUnless(shutil.which("node"), "node is needed to run the page's script")
class ButtonTest(unittest.TestCase):
    """What the button on the page does in different browsers."""

    def setUp(self):
        self._folder = tempfile.TemporaryDirectory()
        self.addCleanup(self._folder.cleanup)
        built = at(FRIDAY, 14, 45)
        config = load_config(push_url=BACKEND)
        self.data = site.page_data(config, november_plans(built, config), None, november_store(built), built)

    def press(self, data: dict | None = None, **scenario) -> dict:
        folder = Path(self._folder.name)
        (folder / "data.json").write_text(json.dumps(data or self.data), encoding="utf-8")
        (folder / "scenario.json").write_text(json.dumps(scenario), encoding="utf-8")
        result = subprocess.run(
            ["node", str(TESTS / "run_notify.js"), str(site.WEB / "page.js"), str(folder / "data.json"), str(folder / "scenario.json")],
            capture_output=True,
            text=True,
            timeout=60,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        # The script ties "3" to "PM" with a non-breaking space. A plain one is easier to read here.
        return json.loads(result.stdout.replace(" ", " "))

    def test_the_button_appears_where_notifications_can_work(self):
        result = self.press(agent=ANDROID, backend=GOOD, clicks=0)
        # The line under the button says when the alert comes, before anybody has pressed anything.
        self.assertEqual(
            result["states"][0],
            {"hidden": False, "label": "Get alerts on this phone", "disabled": False, "note": "One alert a day, at about 3 PM on weekdays and 8 AM on weekends."},
        )
        # Nothing is asked of the browser or the backend until the button is pressed.
        self.assertEqual(result["log"], {"requests": [], "registered": [], "subscribed": [], "unsubscribed": 0, "asked": 0})

    def test_a_computer_is_called_a_device(self):
        result = self.press(agent=DESKTOP, backend=GOOD, clicks=0)
        self.assertEqual(result["states"][0]["label"], "Get alerts on this device")

    def test_the_button_stays_hidden_where_notifications_cannot_work(self):
        result = self.press(agent=ANDROID, able=False, backend=GOOD)
        self.assertTrue(result["states"][0]["hidden"])
        self.assertFalse(result["wired"])

    def test_the_button_stays_hidden_without_a_backend(self):
        for push in (None, "", "http://alerts.example", "javascript:alert(1)"):
            with self.subTest(push=push):
                result = self.press(dict(self.data, push=push), agent=ANDROID, backend=GOOD)
                self.assertTrue(result["states"][0]["hidden"])
                self.assertEqual(result["log"]["requests"], [])

    def test_pressing_it_turns_the_alerts_on(self):
        result = self.press(agent=ANDROID, backend=GOOD)
        log = result["log"]
        self.assertEqual(log["asked"], 1)
        self.assertEqual(log["registered"], ["sw.js"])
        # The browser is given the backend's key, and promises to show every alert it gets.
        self.assertEqual(log["subscribed"], [{"userVisibleOnly": True, "keyBytes": KEY_BYTES}])
        self.assertEqual([(request["method"], request["path"]) for request in log["requests"]], [("GET", "/key"), ("POST", "/subscribe")])
        handed_over = log["requests"][1]
        self.assertEqual(handed_over["type"], "application/json")
        # Only the address the browser made for this device goes to the backend. Nothing about the person.
        self.assertEqual(
            handed_over["body"],
            {"subscription": {"endpoint": "https://push.example/new-1", "expirationTime": None, "keys": {"p256dh": "device-key", "auth": "device-secret"}}},
        )
        self.assertEqual(
            result["states"][1],
            {
                "hidden": False,
                "label": "Turn off alerts on this phone",
                "disabled": False,
                "note": "Alerts are on for this phone. A first notification is on its way, to show that it works.",
            },
        )

    def test_the_line_under_the_button_names_the_times_the_alert_goes_out(self):
        def resting(alert) -> str:
            data = dict(self.data, alert=alert) if alert is not None else {key: value for key, value in self.data.items() if key != "alert"}
            return self.press(data, agent=ANDROID, backend=GOOD, clicks=0)["states"][0]["note"]

        self.assertEqual(resting({"weekdays": 16 * 60, "weekends": 8 * 60, "until": 19 * 60}), "One alert a day, at about 4 PM on weekdays and 8 AM on weekends.")
        self.assertEqual(resting({"weekdays": 9 * 60 + 30, "weekends": 9 * 60 + 30, "until": 12 * 60}), "One alert a day, at about 9:30 AM.")
        # Data that does not say when: the line stays empty and out of sight, and nothing is made up.
        for unknown in (None, {}, {"from": 14 * 60 + 30, "until": 19 * 60}, {"weekdays": "16:00", "weekends": "08:00"}):
            with self.subTest(alert=unknown):
                self.assertEqual(resting(unknown), "")

    def test_the_line_comes_back_when_there_is_nothing_else_to_say(self):
        # A device that already has alerts on is reminded when they come.
        result = self.press(agent=ANDROID, backend=GOOD, permission="granted", subscribed="https://push.example/mine", clicks=0)
        self.assertEqual(result["states"][0]["note"], "One alert a day, at about 3 PM on weekdays and 8 AM on weekends.")

    def test_pressing_it_again_turns_them_off(self):
        result = self.press(agent=ANDROID, backend=GOOD, clicks=2)
        self.assertEqual(result["states"][2], {"hidden": False, "label": "Get alerts on this phone", "disabled": False, "note": "Alerts are off for this phone."})
        self.assertEqual(result["log"]["unsubscribed"], 1)
        self.assertEqual(result["log"]["requests"][-1], {"path": "/unsubscribe", "method": "POST", "type": "application/json", "body": {"endpoint": "https://push.example/new-1"}})
        self.assertIsNone(result["nowSubscribed"])

    def test_only_the_offer_is_the_filled_button(self):
        # Off, then on, then off again: the button is filled in only while it offers alerts.
        result = self.press(agent=ANDROID, backend=GOOD, clicks=2)
        self.assertEqual([state["label"] for state in result["states"]], ["Get alerts on this phone", "Turn off alerts on this phone", "Get alerts on this phone"])
        self.assertEqual(result["filled"], [True, False, True])
        # A device that already has alerts on finds the quiet button straight away.
        result = self.press(agent=ANDROID, backend=GOOD, permission="granted", subscribed="https://push.example/mine", clicks=0)
        self.assertEqual(result["filled"], [False])
        # A try that fails leaves the offer as it was.
        result = self.press(agent=ANDROID, backend="down")
        self.assertEqual(result["filled"], [True, True])

    def test_a_device_with_alerts_on_shows_the_way_to_turn_them_off(self):
        result = self.press(agent=ANDROID, backend=GOOD, permission="granted", subscribed="https://push.example/mine", clicks=0)
        self.assertEqual(result["states"][0]["label"], "Turn off alerts on this phone")

    def test_turning_off_works_even_when_the_backend_cannot_be_told(self):
        # The backend finds out by itself the next time it sends.
        result = self.press(agent=ANDROID, backend="down", permission="granted", subscribed="https://push.example/mine", stored={"alertCheck": "1795149900000"})
        self.assertEqual(result["states"][1]["label"], "Get alerts on this phone")
        self.assertEqual(result["states"][1]["note"], "Alerts are off for this phone.")
        self.assertIsNone(result["nowSubscribed"])

    def test_an_iphone_is_told_to_save_the_page_to_its_home_screen_first(self):
        result = self.press(agent=IPHONE, able=False, backend=GOOD)
        self.assertFalse(result["states"][0]["hidden"])
        self.assertIn("alerts only work from the Home Screen", result["states"][1]["note"])
        self.assertIn("“Add to Home Screen”", result["states"][1]["note"])
        self.assertEqual(result["log"]["requests"], [])
        self.assertEqual(result["states"][1]["label"], "Get alerts on this phone")

    def test_an_ipad_that_calls_itself_a_mac_gets_the_same_advice(self):
        agent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15"
        result = self.press(agent=agent, platform="MacIntel", maxTouchPoints=5, able=False, backend=GOOD)
        self.assertIn("Home Screen", result["states"][1]["note"])

    def test_an_iphone_page_opened_from_the_home_screen_works_like_any_other(self):
        result = self.press(agent=IPHONE, standalone=True, backend=GOOD)
        self.assertEqual(result["states"][1]["label"], "Turn off alerts on this phone")

    def test_an_old_iphone_saved_to_the_home_screen_is_offered_nothing(self):
        # Saved already, and still no notifications: there is no further step to suggest.
        result = self.press(agent=IPHONE, standalone=True, able=False, backend=GOOD)
        self.assertTrue(result["states"][0]["hidden"])

    def test_saying_no_to_the_browsers_question(self):
        result = self.press(agent=ANDROID, backend=GOOD, answer="denied")
        self.assertIn("Notifications are blocked for this page", result["states"][1]["note"])
        self.assertEqual(result["states"][1]["label"], "Get alerts on this phone")
        self.assertEqual(result["log"]["requests"], [])

    def test_closing_the_browsers_question_without_an_answer(self):
        result = self.press(agent=ANDROID, backend=GOOD, answer="default")
        # Nothing happened, so the line under the button says what it said before.
        self.assertEqual(
            result["states"][1],
            {"hidden": False, "label": "Get alerts on this phone", "disabled": False, "note": "One alert a day, at about 3 PM on weekdays and 8 AM on weekends."},
        )

    def test_notifications_blocked_earlier_are_not_asked_about_again(self):
        result = self.press(agent=ANDROID, backend=GOOD, permission="denied")
        self.assertEqual(result["log"]["asked"], 0)
        self.assertIn("Allow them in your browser’s settings", result["states"][1]["note"])

    def test_a_backend_that_cannot_be_reached(self):
        result = self.press(agent=ANDROID, backend="down")
        self.assertEqual(result["states"][1]["note"], "The alerts service could not be reached. Check your connection and try again in a minute.")
        self.assertEqual(result["states"][1]["label"], "Get alerts on this phone")
        self.assertEqual(result["log"]["subscribed"], [])

    def test_an_address_the_backend_did_not_take_is_not_kept(self):
        # Otherwise the button would say the alerts are on while none would ever come.
        for answer in ("down", {"status": 503, "body": {"ok": False, "reason": "later"}}, {"status": 502, "body": "garbage"}):
            with self.subTest(answer=answer):
                result = self.press(agent=ANDROID, backend=dict(GOOD, **{"/subscribe": answer}))
                self.assertEqual(result["log"]["unsubscribed"], 1)
                self.assertIsNone(result["nowSubscribed"])
                self.assertEqual(result["states"][1]["label"], "Get alerts on this phone")
                self.assertIn("could not be reached", result["states"][1]["note"])

    def test_a_full_backend_says_so(self):
        full = {"status": 507, "body": {"ok": False, "reason": "full"}}
        result = self.press(agent=ANDROID, backend=dict(GOOD, **{"/subscribe": full}))
        self.assertEqual(result["states"][1]["note"], "No more devices can be added at the moment. Please try again another day.")

    # What a browser says no to in a private window, which a page cannot see for itself.
    PRIVATE = "This browser could not set up notifications. If this is a private or incognito window, open the page in a normal one and try again."

    def test_a_browser_that_will_not_give_an_address_is_asked_about_a_private_window(self):
        # Seen in a real Chromium: in an incognito window it refuses exactly here.
        result = self.press(agent=ANDROID, backend=GOOD, subscribeFails=True)
        self.assertEqual(result["states"][1]["note"], self.PRIVATE)
        self.assertEqual([request["path"] for request in result["log"]["requests"]], ["/key"])
        self.assertEqual(result["states"][1]["label"], "Get alerts on this phone")
        self.assertFalse(result["states"][1]["disabled"])

    def test_a_browser_that_will_not_start_the_script_gets_the_same_advice(self):
        result = self.press(agent=ANDROID, backend=GOOD, registerFails=True)
        self.assertEqual(result["states"][1]["note"], self.PRIVATE)
        self.assertEqual(result["log"]["requests"], [])

    def test_an_address_that_no_longer_works_is_replaced_once(self):
        gone = {"status": 410, "body": {"ok": False, "reason": "gone"}}
        answers = dict(GOOD, **{"/subscribe": [gone, {"body": {"ok": True, "new": True}}]})
        result = self.press(agent=ANDROID, backend=answers, permission="granted", subscribed="https://push.example/old", clicks=0, stored={})
        # The daily check found the old address dead, dropped it and handed over a new one.
        self.assertEqual([request["path"] for request in result["log"]["requests"]], ["/subscribe", "/key", "/subscribe"])
        self.assertEqual(result["log"]["requests"][0]["body"]["subscription"]["endpoint"], "https://push.example/old")
        self.assertEqual(result["log"]["requests"][2]["body"]["subscription"]["endpoint"], "https://push.example/new-1")
        self.assertEqual(result["nowSubscribed"], "https://push.example/new-1")
        self.assertEqual(result["states"][0]["label"], "Turn off alerts on this phone")
        self.assertEqual(result["log"]["asked"], 0)

    def test_an_address_that_keeps_failing_is_given_up(self):
        gone = {"status": 410, "body": {"ok": False, "reason": "gone"}}
        result = self.press(agent=ANDROID, backend=dict(GOOD, **{"/subscribe": gone}))
        self.assertEqual([request["path"] for request in result["log"]["requests"]], ["/key", "/subscribe", "/key", "/subscribe"])
        self.assertEqual(result["states"][1]["note"], "This browser could not set up notifications. Please try again later.")
        self.assertIsNone(result["nowSubscribed"])

    def test_the_check_with_the_backend_happens_once_a_day_at_most(self):
        now = "2026-11-20T04:45:00Z"
        an_hour_ago = str(int(datetime(2026, 11, 20, 3, 45, tzinfo=ZoneInfo("UTC")).timestamp() * 1000))
        two_days_ago = str(int(datetime(2026, 11, 18, 3, 45, tzinfo=ZoneInfo("UTC")).timestamp() * 1000))
        on = {"agent": ANDROID, "backend": GOOD, "permission": "granted", "subscribed": "https://push.example/mine", "clicks": 0, "now": now}

        recent = self.press(**on, stored={"alertCheck": an_hour_ago})
        self.assertEqual(recent["log"]["requests"], [])

        due = self.press(**on, stored={"alertCheck": two_days_ago})
        self.assertEqual([request["path"] for request in due["log"]["requests"]], ["/subscribe"])
        self.assertEqual(due["stored"]["alertCheck"], str(int(datetime(2026, 11, 20, 4, 45, tzinfo=ZoneInfo("UTC")).timestamp() * 1000)))
        self.assertEqual(due["states"][0]["label"], "Turn off alerts on this phone")

        # A browser with nowhere to remember the last check does not ask on every visit.
        forgetful = self.press(**on, noStorage=True)
        self.assertEqual(forgetful["log"]["requests"], [])

    def test_a_hiccup_during_the_daily_check_changes_nothing(self):
        for answer in ("down", {"status": 503, "body": {"ok": False, "reason": "later"}}):
            with self.subTest(answer=answer):
                result = self.press(agent=ANDROID, backend={"/subscribe": answer}, permission="granted", subscribed="https://push.example/mine", clicks=0, stored={})
                self.assertEqual(result["nowSubscribed"], "https://push.example/mine")
                self.assertEqual(result["states"][0]["label"], "Turn off alerts on this phone")


def page_data_with_notice(day: str = "2026-11-20", **extra) -> dict:
    data = {
        "zone": "Australia/Melbourne",
        "push": BACKEND,
        "days": [
            {"date": "2026-11-19", "notice": {"title": "Yesterday's news", "body": "Old."}},
            {"date": day, "notice": {"title": "🔴 Booked 4 to 8 PM", "body": "🌧 Rain likely from about 3 PM."}},
        ],
    }
    data.update(extra)
    return data


@unittest.skipUnless(shutil.which("node"), "node is needed to run the script that shows notifications")
class ShowTest(unittest.TestCase):
    """What the script beside the page does when an alert arrives."""

    def setUp(self):
        self._folder = tempfile.TemporaryDirectory()
        self.addCleanup(self._folder.cleanup)

    def run_script(self, **scenario) -> dict:
        path = Path(self._folder.name) / "scenario.json"
        path.write_text(json.dumps(scenario), encoding="utf-8")
        result = subprocess.run(["node", str(TESTS / "run_sw.js"), str(site.WEB / "sw.js"), str(path)], capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def alert(self, **notification) -> dict:
        return {"web_push": 8030, "notification": notification}

    def test_an_alert_shows_the_words_it_brought(self):
        sent = self.alert(title="🔴 Booked 4 to 8 PM", body="🌧 Rain likely.", navigate="https://example.org/park/", tag="daily")
        log = self.run_script(event="push", payload=sent, data="down")["log"]
        self.assertEqual(
            log["shown"],
            [
                {
                    "title": "🔴 Booked 4 to 8 PM",
                    "options": {
                        "body": "🌧 Rain likely.",
                        "tag": "daily",
                        "renotify": True,
                        # An Android phone: the picture with nothing on it, so that the phone draws none of its own.
                        "icon": "blank.png",
                        "badge": "badge.png",
                        "lang": "en-AU",
                        "data": {"url": "https://example.org/park/"},
                    },
                }
            ],
        )
        # The words came with the alert, so nothing had to be fetched.
        self.assertEqual(log["requests"], [])

    def test_a_notification_names_no_picture_except_the_empty_one_on_android(self):
        sent = self.alert(title="🔴 Booked 4 to 8 PM", body="🌧 Rain likely.", navigate="https://example.org/park/", tag="daily")
        others = {
            "a computer": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
            "a Mac": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:145.0) Gecko/20100101 Firefox/145.0",
            "an iPhone": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1",
            "a browser that does not say": None,
        }
        for name, agent in others.items():
            with self.subTest(browser=name):
                shown = self.run_script(event="push", payload=sent, data="down", agent=agent)["log"]["shown"]
                self.assertEqual(len(shown), 1)
                self.assertEqual(shown[0]["title"], "🔴 Booked 4 to 8 PM")
                self.assertNotIn("icon", shown[0]["options"])
                self.assertEqual(shown[0]["options"]["badge"], "badge.png")
        phones = {
            "Chrome": "Mozilla/5.0 (Linux; Android 16; SM-S938B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36",
            "Firefox": "Mozilla/5.0 (Android 16; Mobile; rv:145.0) Gecko/145.0 Firefox/145.0",
        }
        for name, agent in phones.items():
            with self.subTest(android=name):
                shown = self.run_script(event="push", payload=sent, data="down", agent=agent)["log"]["shown"]
                self.assertEqual(shown[0]["options"]["icon"], "blank.png")

    def test_an_alert_without_words_reads_todays_notice_from_the_page(self):
        # 04:45 UTC on 20 November is 3:45 PM that day in Melbourne.
        log = self.run_script(event="push", payload=None, data=page_data_with_notice(), now="2026-11-20T04:45:00Z")["log"]
        self.assertEqual(log["requests"], [{"address": "data.json?t=…", "method": "GET", "cache": "no-store"}])
        self.assertEqual(len(log["shown"]), 1)
        self.assertEqual(log["shown"][0]["title"], "🔴 Booked 4 to 8 PM")
        self.assertEqual(log["shown"][0]["options"]["body"], "🌧 Rain likely from about 3 PM.")
        self.assertEqual(log["shown"][0]["options"]["data"], {"url": "https://example.org/park/"})

    def test_today_is_the_parks_day_not_the_day_in_london(self):
        # 20:30 UTC on 19 November is already 7:30 AM on the 20th in Melbourne.
        log = self.run_script(event="push", payload=None, data=page_data_with_notice(), now="2026-11-19T20:30:00Z")["log"]
        self.assertEqual(log["shown"][0]["title"], "🔴 Booked 4 to 8 PM")

    def test_something_is_always_shown(self):
        # A browser may stop the alerts of a page that receives one and shows nothing.
        cases = {
            "the page's data cannot be reached": {"payload": None, "data": "down"},
            "the page's data is missing": {"payload": None, "data": "missing"},
            "the page's data takes too long": {"payload": None, "data": "slow"},
            "the page's data has no notice for today": {"payload": None, "data": page_data_with_notice("2026-11-25")},
            "the page's data is not what was expected": {"payload": None, "data": {"days": "none"}},
            "the alert cannot be read": {"payload": "garbage", "data": "down"},
            "the alert has no title": {"payload": {"web_push": 8030, "notification": {"body": "No title."}}, "data": "down"},
            "the alert is something else": {"payload": {"hello": "there"}, "data": "down"},
        }
        for name, scenario in cases.items():
            with self.subTest(name):
                log = self.run_script(event="push", **scenario)["log"]
                self.assertEqual(len(log["shown"]), 1)
                self.assertEqual(log["shown"][0]["title"], "Today's update is ready")
                self.assertEqual(log["shown"][0]["options"]["body"], "Tap to see when the oval is booked.")
                self.assertEqual(log["shown"][0]["options"]["tag"], "daily")

    def test_an_alert_can_only_ever_open_this_page(self):
        for address in ("https://evil.example/", "https://example.org/other/", "javascript:alert(1)", 7, None):
            with self.subTest(address=address):
                sent = self.alert(title="Hello", navigate=address)
                shown = self.run_script(event="push", payload=sent)["log"]["shown"][0]
                self.assertEqual(shown["options"]["data"], {"url": "https://example.org/park/"})

    def test_a_tap_opens_the_page(self):
        log = self.run_script(event="notificationclick", notificationData={"url": "https://example.org/park/"}, windows=[])["log"]
        self.assertEqual(log["closed"], 1)
        self.assertEqual(log["opened"], ["https://example.org/park/"])

    def test_a_tap_brings_an_open_page_forward_instead_of_opening_another(self):
        log = self.run_script(
            event="notificationclick",
            notificationData={"url": "https://example.org/park/"},
            windows=["https://elsewhere.example/", "https://example.org/park/?from=home"],
        )["log"]
        self.assertEqual(log["focused"], ["https://example.org/park/?from=home"])
        self.assertEqual(log["opened"], [])

    def test_a_tap_never_opens_another_site(self):
        for data in ({"url": "https://evil.example/"}, None, {}):
            with self.subTest(data=data):
                log = self.run_script(event="notificationclick", notificationData=data, windows=[])["log"]
                self.assertEqual(log["opened"], ["https://example.org/park/"])

    def test_a_new_version_of_the_script_takes_over_at_once(self):
        result = self.run_script(event=["install", "activate"])
        self.assertEqual((result["log"]["skippedWaiting"], result["log"]["claimed"]), (1, 1))
        # It does not stand between the page and the web: it has no "fetch" handler.
        self.assertEqual(result["kinds"], ["activate", "install", "notificationclick", "push", "pushsubscriptionchange"])

    def test_a_replaced_address_is_passed_on_to_the_backend(self):
        log = self.run_script(
            event="pushsubscriptionchange",
            old={"endpoint": "https://push.example/old", "options": {"applicationServerKey": "the-key"}},
            renewed={"endpoint": "https://push.example/new"},
            data=page_data_with_notice(),
        )["log"]
        posts = [request for request in log["requests"] if request["method"] == "POST"]
        self.assertEqual(
            posts,
            [
                {
                    "address": "https://alerts.example/subscribe",
                    "method": "POST",
                    "body": {"subscription": {"endpoint": "https://push.example/new", "expirationTime": None, "keys": {"p256dh": "device-key", "auth": "device-secret"}}},
                },
                {"address": "https://alerts.example/unsubscribe", "method": "POST", "body": {"endpoint": "https://push.example/old"}},
            ],
        )
        self.assertEqual(log["subscribed"], [])

    def test_an_address_that_was_only_taken_away_is_asked_for_again(self):
        log = self.run_script(
            event="pushsubscriptionchange",
            old={"endpoint": "https://push.example/old", "options": {"applicationServerKey": "the-key"}},
            data=page_data_with_notice(),
        )["log"]
        self.assertEqual(log["subscribed"], [{"userVisibleOnly": True, "applicationServerKey": "the-key"}])
        posts = [request["address"] for request in log["requests"] if request["method"] == "POST"]
        self.assertEqual(posts, ["https://alerts.example/subscribe", "https://alerts.example/unsubscribe"])

    def test_without_a_backend_a_replaced_address_goes_nowhere(self):
        for data in (page_data_with_notice(push=None), page_data_with_notice(push="http://alerts.example"), "down"):
            with self.subTest(data=data):
                log = self.run_script(event="pushsubscriptionchange", old={"endpoint": "https://push.example/old"}, renewed={"endpoint": "https://push.example/new"}, data=data)["log"]
                self.assertEqual([request for request in log["requests"] if request["method"] == "POST"], [])


if __name__ == "__main__":
    unittest.main()
