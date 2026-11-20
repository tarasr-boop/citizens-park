import re
import tempfile
import unittest
from pathlib import Path

from parkbot import config as config_module
from parkbot.config import ConfigError
from parkbot.pattern import ScheduleError, load_seasons

from .helpers import CONFIG_FILE, ROOT

GOOD = CONFIG_FILE.read_text(encoding="utf-8")


class ConfigTest(unittest.TestCase):
    def setUp(self):
        self._folder = tempfile.TemporaryDirectory()
        self.addCleanup(self._folder.cleanup)
        self.path = Path(self._folder.name) / "config.toml"

    def load(self, text: str):
        self.path.write_text(text, encoding="utf-8")
        return config_module.load(self.path)

    def changed(self, old: str, new: str):
        self.assertIn(old, GOOD)
        return self.load(GOOD.replace(old, new))

    def test_reads_the_settings(self):
        config = self.load(GOOD)
        self.assertEqual(config.park_name, "Citizens Park oval")
        self.assertEqual(config.park_short, "Citizens Park")
        self.assertEqual((config.day_start, config.lights_off), (6 * 60, 22 * 60))
        self.assertEqual((config.post_from, config.post_until), (14 * 60 + 30, 19 * 60))
        self.assertEqual(config.channel, "ExampleParkDogs")
        self.assertEqual(config.channel_url, "https://t.me/ExampleParkDogs")
        self.assertEqual(config.site_url, "https://example.org/park/")
        self.assertEqual(str(config.zone), "Australia/Melbourne")

    def test_channel_can_be_written_several_ways(self):
        for written in ("ExampleParkDogs", "@ExampleParkDogs", "t.me/ExampleParkDogs", "https://t.me/ExampleParkDogs", "https://t.me/ExampleParkDogs/"):
            with self.subTest(written=written):
                config = self.changed('channel = "ExampleParkDogs"', f'channel = "{written}"')
                self.assertEqual(config.channel, "ExampleParkDogs")

    def test_an_empty_channel_means_no_telegram(self):
        config = self.changed('channel = "ExampleParkDogs"', 'channel = ""')
        self.assertEqual(config.channel, "")
        self.assertEqual(config.channel_url, "")

    def test_a_channel_title_is_not_a_link_name(self):
        for written in ("Citizens Park Dogs", "Собаки_парку", "t.me/s/ExampleParkDogs"):
            with self.subTest(written=written), self.assertRaisesRegex(ConfigError, "link name"):
                self.changed('channel = "ExampleParkDogs"', f'channel = "{written}"')

    def test_an_invite_link_to_a_private_channel_is_explained(self):
        for written in ("https://t.me/+AbCdEf-123_xyz", "t.me/joinchat/AbCdEf123"):
            with self.subTest(written=written), self.assertRaisesRegex(ConfigError, "private channel"):
                self.changed('channel = "ExampleParkDogs"', f'channel = "{written}"')

    def test_a_section_of_the_wrong_kind_is_reported_not_crashed_on(self):
        with self.assertRaisesRegex(ConfigError, r"telegram should be a section that starts with a \[telegram\] line"):
            self.load("telegram = 5\n" + GOOD.replace("[telegram]", "[telegram_old]"))

    def test_the_page_address_gets_its_closing_slash(self):
        config = self.changed('url = "https://example.org/park/"', 'url = "https://example.org/park"')
        self.assertEqual(config.site_url, "https://example.org/park/")

    def test_addresses_must_be_https(self):
        with self.assertRaisesRegex(ConfigError, "site.url must be an https:// address"):
            self.changed('url = "https://example.org/park/"', 'url = "http://example.org/park/"')
        with self.assertRaisesRegex(ConfigError, "site.tip_url must be an https:// address"):
            self.changed('tip_url = ""', 'tip_url = "ko-fi.com/example"')
        with self.assertRaisesRegex(ConfigError, "site.url is empty"):
            self.changed('url = "https://example.org/park/"', 'url = ""')

    def test_an_address_cannot_carry_markup(self):
        with self.assertRaises(ConfigError):
            self.changed('tip_url = ""', "tip_url = 'https://ko-fi.com/x\"><script>'")

    def test_the_page_name_is_optional(self):
        self.assertEqual(self.load(GOOD).display_name, "Citizens Park")
        named = self.changed('name = ""', 'name = " Citizens Bark "')
        self.assertEqual(named.site_name, "Citizens Bark")
        self.assertEqual(named.display_name, "Citizens Bark")
        without = self.load(GOOD.replace('name = ""\n', ""))
        self.assertEqual(without.site_name, "")

    def test_who_runs_the_page_is_optional(self):
        self.assertEqual(self.load(GOOD).run_by, "a local dog owner")
        named = self.changed('name = ""', 'name = ""\nrun_by = " a local dog trainer "')
        self.assertEqual(named.run_by, "a local dog trainer")
        self.assertEqual(self.changed('name = ""', 'name = ""\nrun_by = ""').run_by, "a local dog owner")

    def test_times_must_make_sense(self):
        with self.assertRaisesRegex(ConfigError, "post_from must be earlier than telegram.post_until"):
            self.changed('post_from = "14:30"', 'post_from = "19:30"')
        with self.assertRaisesRegex(ConfigError, "day_start must be earlier than park.lights_off"):
            self.changed('day_start = "06:00"', 'day_start = "23:00"')
        with self.assertRaises(ConfigError):
            self.changed('post_from = "14:30"', 'post_from = "half past two"')

    def test_an_unknown_time_zone(self):
        with self.assertRaisesRegex(ConfigError, "not a known time zone"):
            self.changed('timezone = "Australia/Melbourne"', 'timezone = "Australia/Richmond"')

    def test_a_missing_setting_is_named(self):
        with self.assertRaisesRegex(ConfigError, "latitude"):
            self.changed("latitude = -37.8146\n", "")
        with self.assertRaisesRegex(ConfigError, "council"):
            self.load(GOOD.split("[council]")[0])

    def test_a_typing_slip_is_reported_not_crashed_on(self):
        with self.assertRaisesRegex(ConfigError, "not valid TOML"):
            self.load(GOOD.replace('suburb = "Richmond"', 'suburb = "Richmond'))
        with self.assertRaisesRegex(ConfigError, "not found"):
            config_module.load(Path(self._folder.name) / "nowhere.toml")


class ScheduleFileTest(unittest.TestCase):
    def setUp(self):
        self._folder = tempfile.TemporaryDirectory()
        self.addCleanup(self._folder.cleanup)
        self.path = Path(self._folder.name) / "schedule.toml"

    def load(self, text: str):
        self.path.write_text(text, encoding="utf-8")
        return load_seasons(self.path)

    def test_reads_a_season(self):
        seasons = self.load('[[season]]\nname = "summer"\nmonths = [12, 1, 2]\n[season.week]\nmon = ["16:00-17:00", "18:00-19:00"]\n')
        self.assertEqual(len(seasons), 1)
        self.assertEqual(seasons[0].months, frozenset({12, 1, 2}))
        self.assertEqual([slot.to_text() for slot in seasons[0].week[0]], ["16:00-17:00", "18:00-19:00"])
        self.assertEqual(seasons[0].week[1], ())
        self.assertFalse(seasons[0].rough)

    def test_a_missing_file_means_no_usual_pattern(self):
        self.assertEqual(load_seasons(Path(self._folder.name) / "nowhere.toml"), [])

    def test_mistakes_are_explained(self):
        with self.assertRaisesRegex(ScheduleError, "unknown weekday 'monday'"):
            self.load('[[season]]\nmonths = [1]\n[season.week]\nmonday = ["16:00-17:00"]\n')
        with self.assertRaisesRegex(ScheduleError, "months must be numbers from 1 to 12"):
            self.load("[[season]]\nmonths = [13]\n")
        with self.assertRaisesRegex(ScheduleError, "not valid TOML"):
            self.load("[[season]\nmonths = [1]\n")
        with self.assertRaises(ScheduleError):
            self.load('[[season]]\nmonths = [1]\n[season.week]\nmon = ["4pm till late"]\n')


class RealFilesTest(unittest.TestCase):
    """The files this repository actually runs with. These tests fail when an edit breaks one."""

    def test_config_toml_loads(self):
        config = config_module.load(ROOT / "config.toml")
        self.assertTrue(config.site_url.startswith("https://"))
        self.assertTrue(config.council_url.startswith("https://"))
        self.assertLess(config.post_from, config.post_until)

    def test_schedule_toml_loads_and_no_month_is_claimed_twice(self):
        seasons = load_seasons(ROOT / "schedule.toml")
        self.assertTrue(seasons, "schedule.toml should describe at least one season")
        months = [month for season in seasons for month in season.months]
        self.assertEqual(len(months), len(set(months)), "a month appears in two seasons")

    def test_the_qr_code_points_at_the_page(self):
        config = config_module.load(ROOT / "config.toml")
        held = (ROOT / "assets" / "qr-url.txt").read_text(encoding="utf-8").strip()
        self.assertEqual(
            held,
            config.site_url,
            "The QR code still points at the old address. Make it again: see 'If the page's address changes' in the README.",
        )

    def test_the_icons_and_qr_code_are_in_place(self):
        for name in ("qr.svg", "qr.png", "favicon.svg", "icon-192.png", "icon-512.png", "icon-maskable-512.png", "apple-touch-icon.png"):
            with self.subTest(name=name):
                self.assertGreater((ROOT / "assets" / name).stat().st_size, 100)
        self.assertIn("<svg", (ROOT / "assets" / "qr.svg").read_text(encoding="utf-8"))
        self.assertEqual((ROOT / "assets" / "qr.png").read_bytes()[:8], b"\x89PNG\r\n\x1a\n")

    def test_the_scheduled_job_posts_inside_the_posting_window(self):
        # The post goes out on the first run inside the window, so at least two runs
        # must be planned for after it opens: one to post and one as a backup.
        config = config_module.load(ROOT / "config.toml")
        workflow = (ROOT / ".github" / "workflows" / "daily.yml").read_text(encoding="utf-8")
        local_runs = re.findall(r'cron: "(\d+) (\d+) \* \* \*"\n\s+timezone: "Australia/Melbourne"', workflow)
        self.assertGreaterEqual(len(local_runs), 3)
        inside = [int(hour) * 60 + int(minute) for minute, hour in local_runs if config.post_from <= int(hour) * 60 + int(minute) < config.post_until]
        self.assertGreaterEqual(len(inside), 2, "config.toml's posting window and the run times in daily.yml no longer line up")


if __name__ == "__main__":
    unittest.main()
