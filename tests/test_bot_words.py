"""The words of the Telegram bot's custom alerts (parkbot/bot.py), and the [bot] settings."""

from __future__ import annotations

import json
import tempfile
import unittest
from datetime import date, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from parkbot import bot, config as config_module, message, site, weather
from parkbot.status import plan_days

from .helpers import CONFIG_FILE, forecast_json, load_config, october_store, seasons

ZONE = ZoneInfo("Australia/Melbourne")
FRIDAY = date(2026, 10, 23)  # booked 4 to 8 PM; Saturday the 24th is booked 10 AM to 6 PM


def at(day: date, hour: int, minute: int = 0) -> datetime:
    return datetime(day.year, day.month, day.day, hour, minute, tzinfo=ZONE)


class AlertsTest(unittest.TestCase):
    def setUp(self):
        self.config = load_config()
        self.plans = plan_days(FRIDAY, 8, october_store(FRIDAY), seasons(), self.config.day_start, self.config.lights_off)

    def alerts(self, now, forecast=None):
        return bot.alerts(self.config, self.plans, forecast, now)

    def find(self, made, sent_on, hour):
        return next(entry for entry in made["alerts"] if entry["date"] == sent_on.isoformat() and entry["hour"] == hour)

    def test_every_hour_still_to_come_today_and_every_hour_tomorrow(self):
        made = self.alerts(at(FRIDAY, 6, 17))
        hours = [(entry["date"], entry["hour"]) for entry in made["alerts"]]
        today = [("2026-10-23", hour) for hour in range(6, 24)]
        tomorrow = [("2026-10-24", hour) for hour in range(4, 24)]
        self.assertEqual(hours, today + tomorrow)
        self.assertEqual(made["generated"], "2026-10-23T06:17+11:00")
        self.assertEqual(made["generatedText"], "Fri 23 Oct, 6:17 AM")

    def test_under_a_picture_goes_one_line_on_the_bookings_and_the_link(self):
        made = self.alerts(at(FRIDAY, 6, 17))
        link = '<a href="https://example.org/park/">Press here for the week ahead and rain by the hour</a>'
        captions = {(entry["date"], entry["hour"]): entry["caption"] for entry in made["alerts"]}
        self.assertEqual(captions[("2026-10-23", 8)], f"<b>🔴 Citizens Park oval booked 4 to 8 PM</b>\n{link}")
        self.assertEqual(captions[("2026-10-23", 17)], f"<b>🔴 Citizens Park oval booked until 8 PM</b>\n{link}")
        self.assertEqual(captions[("2026-10-23", 20)], f"<b>🟢 Today's bookings at Citizens Park oval have finished</b>\n{link}")
        # From the evening hour, about the whole of the next day.
        self.assertEqual(captions[("2026-10-23", 21)], f"<b>🔴 Citizens Park oval booked 10 AM to 6 PM tomorrow</b>\n{link}")
        # The hour that has begun is written for the moment the check runs, like its words.
        later = self.alerts(at(FRIDAY, 16, 47))
        self.assertEqual(later["alerts"][0]["caption"], f"<b>🔴 Citizens Park oval booked until 8 PM</b>\n{link}")
        # The words for an alert without a picture end with the same link.
        for entry in made["alerts"]:
            self.assertTrue(entry["text"].endswith("\n\n" + link), entry["text"])
        self.assertNotIn("caption", made)

    def test_the_current_hour_is_kept_and_written_for_now(self):
        made = self.alerts(at(FRIDAY, 17, 47))
        self.assertEqual(made["alerts"][0]["hour"], 17)
        self.assertIn("🔴 Booked until 8 PM", made["alerts"][0]["text"])

    def test_each_alert_is_the_channels_post_written_for_its_own_hour(self):
        made = self.alerts(at(FRIDAY, 6, 17))
        morning = self.find(made, FRIDAY, 8)
        self.assertEqual(morning["text"], message.daily(self.plans[0], None, at(FRIDAY, 8), self.config))
        self.assertIn("🔴 Booked 4 to 8 PM", morning["text"])
        self.assertIn("🔴 Booked until 8 PM", self.find(made, FRIDAY, 17)["text"])
        self.assertIn("🟢 Today's bookings have finished.", self.find(made, FRIDAY, 20)["text"])
        self.assertFalse(morning["weekend"])
        self.assertEqual(morning["about"], "2026-10-23")

    def test_from_the_evening_hour_an_alert_is_about_the_next_day(self):
        made = self.alerts(at(FRIDAY, 6, 17))
        late = self.find(made, FRIDAY, 21)
        self.assertEqual(late["about"], "2026-10-24")
        # Saturday is a weekend day, so a person's weekend time decides whether they get it.
        self.assertTrue(late["weekend"])
        self.assertTrue(late["text"].startswith("🐕 <b>Citizens Park oval, tomorrow</b>\n\n🔴 Booked 10 AM to 6 PM\n"))
        self.assertFalse(self.find(made, FRIDAY, 20)["weekend"])
        # Sunday evening's late alert is about Monday, a weekday.
        sunday = self.alerts(at(date(2026, 10, 25), 6, 17))
        self.assertFalse(self.find(sunday, date(2026, 10, 25), 22)["weekend"])
        self.assertEqual(self.find(sunday, date(2026, 10, 25), 22)["about"], "2026-10-26")

    def test_tomorrows_words_say_tomorrow(self):
        forecast = weather.parse(forecast_json(FRIDAY, 3))
        late = self.find(self.alerts(at(FRIDAY, 6, 17), forecast), FRIDAY, 21)["text"]
        self.assertIn("No rain expected tomorrow.", late)
        self.assertNotIn("today", late.lower())
        wet = weather.parse(forecast_json(FRIDAY, 3, chance=lambda day, hour: 90, mm=lambda day, hour: 0.5))
        late = self.find(self.alerts(at(FRIDAY, 6, 17), wet), FRIDAY, 21)["text"]
        self.assertIn("Rain likely all day", late)

    def test_a_day_with_no_bookings_tomorrow(self):
        day = plan_days(date(2026, 10, 26), 1, october_store(FRIDAY), seasons())[0]
        text = message.daily(day, None, at(date(2026, 10, 25), 21), self.config, ahead=True)
        self.assertIn("tomorrow", text)
        self.assertNotIn("today", text)

    def test_an_hour_with_no_plan_is_left_out(self):
        short = bot.alerts(self.config, self.plans[:1], None, at(FRIDAY, 6, 17))
        self.assertEqual({entry["about"] for entry in short["alerts"]}, {"2026-10-23"})
        self.assertEqual(max(entry["hour"] for entry in short["alerts"] if entry["date"] == "2026-10-23"), 20)

    def test_the_site_publishes_the_file_next_to_the_page(self):
        with tempfile.TemporaryDirectory() as folder:
            out = site.build(self.config, self.plans, None, october_store(FRIDAY), at(FRIDAY, 6, 17), folder, Path(folder) / "none")
            made = json.loads((out / bot.FILE).read_text(encoding="utf-8"))
        self.assertEqual(made, self.alerts(at(FRIDAY, 6, 17)))


class ButtonTest(unittest.TestCase):
    def page(self, **changes):
        config = load_config(**changes)
        plans = plan_days(FRIDAY, 8, october_store(FRIDAY), seasons(), config.day_start, config.lights_off)
        with tempfile.TemporaryDirectory() as folder:
            out = site.build(config, plans, None, october_store(FRIDAY), at(FRIDAY, 6, 17), folder, Path(folder) / "none")
            return (out / "index.html").read_text(encoding="utf-8")

    def test_with_the_bots_name_the_telegram_button_opens_a_chat_with_the_bot(self):
        page = self.page(bot_name="ExampleParkBot")
        # The one way to get the alert, so the filled button, and the channel's button gives way to it.
        self.assertIn('<a class="button primary" href="https://t.me/ExampleParkBot" rel="noopener">Get alerts on Telegram</a>', page)
        self.assertIn('<p class="button-note">One alert a day, at a time you choose.</p>', page)
        self.assertEqual(page.count(">Get alerts on Telegram<"), 1)
        # While the channel still posts, "How this works" names both.
        self.assertIn('The <a href="https://t.me/ExampleParkBot" rel="noopener">Citizens Park bot</a> sends the same alert at a time you choose.', page)

    def test_once_the_channel_has_moved_to_the_bot_the_page_names_only_the_bot(self):
        page = self.page(bot_name="ExampleParkBot", channel_retired=True)
        self.assertIn(">Get alerts on Telegram</a>", page)
        self.assertNotIn("t.me/ExampleParkDogs", page)
        self.assertIn(
            '<p>The <a href="https://t.me/ExampleParkBot" rel="noopener">Citizens Park bot</a> on Telegram sends a free alert once a day, '
            "at a time you choose: one for weekdays and one for weekends.</p>",
            page,
        )
        # Without the bot's name, a retired channel leaves no Telegram button at all.
        self.assertNotIn("Telegram</a>", self.page(channel_retired=True, bot_name="").split("How this works")[0])

    def test_without_it_the_button_leads_to_the_channel(self):
        page = self.page()
        self.assertIn(">Get alerts on Telegram</a>", page)
        self.assertNotIn("custom alerts", page)


class SettingsTest(unittest.TestCase):
    def write(self, extra: str) -> Path:
        handle = tempfile.NamedTemporaryFile("w", suffix=".toml", delete=False, encoding="utf-8")
        with handle:
            handle.write(CONFIG_FILE.read_text(encoding="utf-8") + "\n[bot]\n" + extra)
        self.addCleanup(Path(handle.name).unlink)
        return Path(handle.name)

    def test_the_defaults(self):
        config = load_config()
        self.assertEqual(
            (config.bot_first, config.bot_last, config.bot_evening, config.bot_weekday, config.bot_weekend),
            (4 * 60, 23 * 60, 21 * 60, 16 * 60, 8 * 60),
        )

    def test_times_are_read(self):
        config = config_module.load(self.write('first = "05:00"\nlast = "22:00"\nevening = "20:00"\nweekday = "07:00"\nweekend = "09:00"\n'))
        self.assertEqual((config.bot_first, config.bot_last, config.bot_evening, config.bot_weekday, config.bot_weekend), (300, 1320, 1200, 420, 540))

    def test_what_makes_no_sense_is_refused(self):
        for extra in ('weekday = "16:30"\n', 'first = "10:00"\n', 'weekend = "23:30"\n', 'evening = "03:00"\n', 'first = "nine"\n'):
            with self.subTest(extra=extra), self.assertRaises(config_module.ConfigError):
                config_module.load(self.write(extra))

    def test_the_bots_name_is_a_link_name(self):
        for written in ("CitizensParkBot", "@CitizensParkBot", "https://t.me/CitizensParkBot/"):
            with self.subTest(written=written):
                config = config_module.load(self.write(f'name = "{written}"\n'))
                self.assertEqual(config.bot_name, "CitizensParkBot")
                self.assertEqual(config.bot_url, "https://t.me/CitizensParkBot")
        with self.assertRaises(config_module.ConfigError):
            config_module.load(self.write('name = "not a name"\n'))
        self.assertEqual(load_config().bot_url, "")

    def test_a_retired_channel_needs_the_bot(self):
        config = config_module.load(self.write('name = "ExampleParkBot"\n'))
        self.assertFalse(config.channel_retired)
        for text, extra in (("retired = true", 'name = "ExampleParkBot"\n'), ('retired = "yes"', 'name = "ExampleParkBot"\n'), ("retired = true", "")):
            path = self.write(extra)
            path.write_text(path.read_text(encoding="utf-8").replace("[telegram]\n", f"[telegram]\n{text}\n"), encoding="utf-8")
            if text == "retired = true" and extra:
                self.assertTrue(config_module.load(path).channel_retired)
            else:
                with self.subTest(text=text, extra=extra), self.assertRaises(config_module.ConfigError):
                    config_module.load(path)

    def test_the_real_settings_load(self):
        config = config_module.load(Path(__file__).resolve().parent.parent / "config.toml")
        self.assertEqual(config.bot_weekday, 16 * 60)
        self.assertEqual(config.bot_weekend, 8 * 60)


if __name__ == "__main__":
    unittest.main()
