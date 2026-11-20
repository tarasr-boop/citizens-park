import json
import re
import tempfile
import unittest
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from parkbot import site, weather
from parkbot.status import DayPlan, plan_days
from parkbot.store import CouncilStore
from parkbot.timeparse import Slot

from .helpers import ROOT, forecast_json, load_config, october_store, seasons

MELBOURNE = ZoneInfo("Australia/Melbourne")
FRIDAY = date(2026, 11, 20)


def plans_from(first: date, store: CouncilStore | None = None, count: int = 8) -> list[DayPlan]:
    config = load_config()
    return plan_days(first, count, store or october_store(first), seasons(), config.day_start, config.lights_off)


def afternoon(day: date) -> datetime:
    return datetime(day.year, day.month, day.day, 14, 45, tzinfo=MELBOURNE)


class BuildTest(unittest.TestCase):
    def setUp(self):
        self._folder = tempfile.TemporaryDirectory()
        self.addCleanup(self._folder.cleanup)
        self.out = Path(self._folder.name) / "site"

    def build(self, config=None, plans=None, forecast=None, day: date = FRIDAY) -> str:
        """Build the site and return the text of its main page."""
        config = config or load_config()
        plans = plans or plans_from(day)
        site.build(config, plans, forecast, october_store(day), afternoon(day), self.out, ROOT / "assets")
        return (self.out / "index.html").read_text(encoding="utf-8")

    def embedded_data(self, page: str) -> dict:
        found = re.search(r'<script id="park-data" type="application/json">(.*?)</script>', page, re.DOTALL)
        self.assertIsNotNone(found, "the page should carry its data")
        return json.loads(found.group(1))

    def test_writes_every_file_the_page_needs(self):
        self.build()
        names = {item.name for item in self.out.iterdir()}
        for wanted in (
            "index.html",
            "data.json",
            "poster.html",
            "manifest.webmanifest",
            "qr.svg",
            "favicon.svg",
            "icon-192.png",
            "icon-512.png",
            "icon-maskable-512.png",
            "apple-touch-icon.png",
        ):
            self.assertIn(wanted, names)
        # The note about what the QR code holds is for the repository, not the public.
        self.assertNotIn("qr-url.txt", names)

    def test_no_template_marker_is_left_behind(self):
        for config in (load_config(), load_config(channel="", repo_url="", site_name="Citizens Bark")):
            with self.subTest(channel=config.channel):
                self.build(config)
                for name in ("index.html", "poster.html"):
                    self.assertNotIn("{{", (self.out / name).read_text(encoding="utf-8"), name)

    def test_page_reads_sensibly_before_the_script_runs(self):
        page = self.build()
        self.assertIn("<h1>Usually booked 4 to 8 PM today</h1>", page)
        self.assertIn("Fri 20 Nov, as of 2:45 PM", page)
        self.assertIn("<strong>Sat 21 Nov</strong>: 10 AM to 6 PM", page)
        self.assertIn("Last checked Fri 20 Nov, 2:45 PM.", page)

    def test_page_says_it_is_unofficial_and_credits_its_sources(self):
        page = self.build()
        self.assertIn("<strong>Unofficial.</strong>", page)
        self.assertIn("check the signs at the park", page)
        self.assertIn('<a href="https://open-meteo.com/" rel="noopener">Weather data by Open-Meteo.com</a>', page)
        self.assertIn('href="https://council.example/parks/citizens-park"', page)
        self.assertIn('<a href="https://example.org/code" rel="noopener">How this page is made</a>', page)

    def test_embedded_data_matches_the_data_file(self):
        forecast = weather.parse(forecast_json(FRIDAY, 8, chance=lambda day, hour: 40 if hour == 17 else 5))
        page = self.build(forecast=forecast)
        data = self.embedded_data(page)
        self.assertEqual(data, json.loads((self.out / "data.json").read_text(encoding="utf-8")))
        self.assertEqual(data["site"], "https://example.org/park/")
        self.assertEqual(data["zone"], "Australia/Melbourne")
        self.assertEqual((data["dayStart"], data["lightsOff"]), (360, 1320))
        self.assertEqual(data["generated"], "2026-11-20T14:45+11:00")
        self.assertEqual(data["council"]["latestDay"], "2026-10-31")

    def test_data_for_each_day(self):
        forecast = weather.parse(forecast_json(FRIDAY, 8, chance=lambda day, hour: 40 if hour == 17 else 5))
        data = site.page_data(load_config(), plans_from(FRIDAY), forecast, october_store(FRIDAY), afternoon(FRIDAY))
        self.assertEqual([day["date"] for day in data["days"]], [(FRIDAY + timedelta(days=n)).isoformat() for n in range(8)])
        today = data["days"][0]
        self.assertEqual(today["name"], "Fri 20 Nov")
        self.assertEqual(today["slots"], [[16 * 60, 20 * 60]])
        self.assertEqual(today["basis"], "usual")
        self.assertEqual(today["rain"]["chance"], 40)
        # Hour-by-hour rain is only carried for today and tomorrow, to keep the page small.
        self.assertEqual(len(today["hours"]), 24)
        self.assertIn([17, 40, 0.0], today["hours"])
        self.assertIsNotNone(data["days"][1]["hours"])
        self.assertTrue(all(day["hours"] is None for day in data["days"][2:]))
        self.assertTrue(all(day["rain"] is not None for day in data["days"]))

    def test_data_without_a_forecast(self):
        data = site.page_data(load_config(), plans_from(FRIDAY), None, october_store(FRIDAY), afternoon(FRIDAY))
        self.assertTrue(all(day["rain"] is None and day["hours"] is None for day in data["days"]))

    def test_a_closed_day_carries_no_booked_times(self):
        closed = DayPlan(FRIDAY, (Slot(360, 1320),), "council", closed=True, label="Turf works until 1 October.")
        data = site.page_data(load_config(), [closed], None, CouncilStore(), afternoon(FRIDAY))
        self.assertEqual(data["days"][0]["slots"], [])
        self.assertTrue(data["days"][0]["closed"])

    def test_telegram_button_only_with_a_channel(self):
        page = self.build()
        self.assertIn('<a class="button primary" href="https://t.me/ExampleParkDogs" rel="noopener">Get the daily alert on Telegram</a>', page)
        self.assertIn("A free alert goes out on Telegram at about 3 PM each day", page)
        self.assertIn("A free alert at about 3 PM each day on Telegram", (self.out / "poster.html").read_text(encoding="utf-8"))

        page = self.build(load_config(channel=""))
        self.assertNotIn("Telegram", page)
        self.assertNotIn("t.me/", page)
        poster = (self.out / "poster.html").read_text(encoding="utf-8")
        self.assertNotIn("Telegram", poster)
        self.assertIn("Free, with no sign-up", poster)

    def test_tip_button_only_with_a_tip_link(self):
        self.assertNotIn("Leave a tip", self.build())
        page = self.build(load_config(tip_url="https://ko-fi.com/example"))
        self.assertIn('<a class="button" href="https://ko-fi.com/example" rel="noopener">Leave a tip</a>', page)

    def test_share_button_and_qr_code_are_always_there(self):
        page = self.build(load_config(channel=""))
        self.assertIn('id="share"', page)
        self.assertIn('<img src="qr.svg"', page)
        self.assertIn('<a href="poster.html">', page)

    def test_the_page_can_have_its_own_name(self):
        plain = self.build()
        self.assertIn("<title>Citizens Park oval: free for dogs right now?</title>", plain)
        self.assertNotIn('class="brand"', plain)
        self.assertIn('<meta name="apple-mobile-web-app-title" content="Citizens Park">', plain)
        manifest = json.loads((self.out / "manifest.webmanifest").read_text(encoding="utf-8"))
        self.assertEqual(manifest["short_name"], "Citizens Park")

        named = self.build(load_config(site_name="Citizens Bark"))
        self.assertIn("<title>Citizens Bark: is the Citizens Park oval free for dogs?</title>", named)
        self.assertIn('<p class="brand"><img src="favicon.svg" width="26" height="26" alt="">Citizens Bark</p>', named)
        self.assertIn('<meta name="apple-mobile-web-app-title" content="Citizens Bark">', named)
        # The park's real name stays on the page, so a stranger knows which oval this is.
        self.assertIn('<p class="eyebrow">Citizens Park oval<span', named)
        manifest = json.loads((self.out / "manifest.webmanifest").read_text(encoding="utf-8"))
        self.assertEqual(manifest["short_name"], "Citizens Bark")
        self.assertEqual(manifest["name"], "Citizens Bark: Citizens Park oval")
        poster = (self.out / "poster.html").read_text(encoding="utf-8")
        self.assertIn("Citizens Bark is an unofficial page run by a local dog owner.", poster)

    def test_the_page_says_who_runs_it(self):
        plain = self.build()
        self.assertIn("This page is run by a local dog owner, not by the council or the clubs.", plain)

        changed = self.build(load_config(run_by="a local dog trainer & <friends>"))
        self.assertIn("This page is run by a local dog trainer &amp; &lt;friends&gt;, not by the council or the clubs.", changed)
        self.assertNotIn("dog owner,", changed)
        poster = (self.out / "poster.html").read_text(encoding="utf-8")
        self.assertIn("Unofficial page run by a local dog trainer &amp; &lt;friends&gt;.", poster)

    def test_manifest_lets_the_page_be_saved_to_a_home_screen(self):
        self.build()
        manifest = json.loads((self.out / "manifest.webmanifest").read_text(encoding="utf-8"))
        self.assertEqual(manifest["display"], "standalone")
        self.assertEqual(manifest["start_url"], "./")
        for icon in manifest["icons"]:
            self.assertTrue((self.out / icon["src"]).is_file(), icon["src"])

    def test_poster_shows_the_address_and_the_code(self):
        self.build()
        poster = (self.out / "poster.html").read_text(encoding="utf-8")
        self.assertIn('<p class="address">example.org/park</p>', poster)
        self.assertIn('<img class="qr" src="qr.svg" alt="QR code for https://example.org/park/">', poster)
        self.assertIn("Unofficial page run by a local dog owner.", poster)
        self.assertIn("Ask the council before putting posters up", poster)

    def test_words_from_outside_cannot_break_the_page(self):
        nasty = '</script><script>alert("x")</script> & <b>bold</b>'
        plans = [
            DayPlan(FRIDAY, (Slot(600, 660),), "council", label=nasty, note=nasty),
            DayPlan(FRIDAY + timedelta(days=1), (), "council", label=nasty, note=nasty),
        ]
        config = load_config(park_name='Dogs & <Cats> "Oval"', suburb="<i>Richmond</i>", site_name="<u>Bark</u>")
        page = self.build(config, plans)
        # Exactly two script blocks: the data and the page's own script.
        self.assertEqual(page.count("<script"), 2)
        self.assertEqual(page.count("</script>"), 2)
        self.assertNotIn("<b>bold</b>", page)
        self.assertNotIn("<i>Richmond</i>", page)
        self.assertNotIn("<u>Bark</u>", page)
        self.assertIn("Dogs &amp; &lt;Cats&gt; &quot;Oval&quot;", page)
        # The data still arrives whole.
        data = self.embedded_data(page)
        self.assertEqual(data["days"][0]["label"], nasty)
        poster = (self.out / "poster.html").read_text(encoding="utf-8")
        self.assertNotIn("<i>Richmond</i>", poster)
        self.assertNotIn("<u>Bark</u>", poster)

    def test_building_twice_replaces_the_old_page(self):
        self.build(day=FRIDAY)
        page = self.build(day=FRIDAY + timedelta(days=1))
        self.assertIn("Sat 21 Nov, as of 2:45 PM", page)
        self.assertNotIn("Fri 20 Nov, as of", page)

    def test_missing_assets_folder_does_not_stop_the_build(self):
        site.build(load_config(), plans_from(FRIDAY), None, october_store(FRIDAY), afternoon(FRIDAY), self.out, self.out / "nowhere")
        self.assertTrue((self.out / "index.html").is_file())


class FallbackTest(unittest.TestCase):
    """The plain text version, shown until the page's script has run."""

    def title(self, plan: DayPlan) -> str:
        html = site.fallback([plan], afternoon(plan.day))
        return re.search(r"<h1>(.*?)</h1>", html).group(1)

    def state(self, plan: DayPlan) -> str:
        return re.search(r'data-state="(\w+)"', site.fallback([plan], afternoon(plan.day))).group(1)

    def test_titles(self):
        booked = (Slot(16 * 60 + 15, 19 * 60 + 30),)
        cases = [
            (DayPlan(FRIDAY, booked, "council"), "Booked 4:15 to 7:30 PM today", "unknown"),
            (DayPlan(FRIDAY, booked, "usual"), "Usually booked 4:15 to 7:30 PM today", "unknown"),
            (DayPlan(FRIDAY, (), "council"), "No bookings today", "free"),
            (DayPlan(FRIDAY, (), "usual"), "Usually no bookings today", "free"),
            (DayPlan(FRIDAY, (), "council", label="Maintenance"), "Maintenance listed today", "unknown"),
            (DayPlan(FRIDAY, (), "none"), "No booking information today", "unknown"),
            (DayPlan(FRIDAY, (Slot(360, 1320),), "council", closed=True, label="Turf works."), "Oval closed today", "closed"),
        ]
        for plan, title, state in cases:
            with self.subTest(title=title):
                self.assertEqual(self.title(plan), title)
                self.assertEqual(self.state(plan), state)

    def test_a_closed_day_shows_the_council_notice(self):
        plan = DayPlan(FRIDAY, (), "council", closed=True, label="Turf works until 1 October.", note="From a notice on the council's page.")
        self.assertIn('<p class="sub">Turf works until 1 October.</p>', site.fallback([plan], afternoon(FRIDAY)))

    def test_week_list_marks_unconfirmed_days(self):
        plans = [
            DayPlan(FRIDAY, (), "council"),
            DayPlan(FRIDAY + timedelta(days=1), (Slot(600, 1080),), "council"),
            DayPlan(FRIDAY + timedelta(days=2), (Slot(660, 1020),), "usual"),
            DayPlan(FRIDAY + timedelta(days=3), (), "none"),
            DayPlan(FRIDAY + timedelta(days=4), (), "council", closed=True),
            DayPlan(FRIDAY + timedelta(days=5), (Slot(600, 660),), "council", label="Maintenance"),
        ]
        html = site.fallback(plans, afternoon(FRIDAY))
        self.assertIn("<li><strong>Sat 21 Nov</strong>: 10 AM to 6 PM</li>", html)
        self.assertIn('<li><strong>Sun 22 Nov</strong>: 11 AM to 5 PM <span class="tag">usual</span></li>', html)
        self.assertIn("<li><strong>Mon 23 Nov</strong>: No information</li>", html)
        self.assertIn("<li><strong>Tue 24 Nov</strong>: Closed</li>", html)
        self.assertIn("<li><strong>Wed 25 Nov</strong>: 10 to 11 AM (Maintenance)</li>", html)


class FillTest(unittest.TestCase):
    def test_fills_markers_in_one_pass(self):
        # Text that was put in is never scanned again, so it cannot smuggle in a marker.
        self.assertEqual(site._fill("{{a}} and {{b}}", {"a": "{{b}}", "b": "two"}), "{{b}} and two")

    def test_unknown_markers_are_left_alone(self):
        self.assertEqual(site._fill("{{known}} {{unknown}}", {"known": "yes"}), "yes {{unknown}}")


if __name__ == "__main__":
    unittest.main()
