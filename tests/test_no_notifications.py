"""The page without notifications, and the backend setting it keeps.

Until 23 November 2026 the page could send the daily alert as a notification
in the browser. Now the alert comes only from the Telegram bot. These tests
check that nothing of the notifications is left on the page, that a browser
which kept the old notification script is tidied when the page is next
opened, and the ``[backend]`` setting, whose address the page still uses to
count visits for the stats page.

The page's script runs in a browser. Here it is run with Node against a
stand-in page, see ``run_stats.js``. Where Node is missing, those tests are
skipped.
"""

import html
import json
import re
import shutil
import subprocess
import tempfile
import unittest
from datetime import date, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from parkbot import config as config_module
from parkbot import site
from parkbot.config import ConfigError
from parkbot.council import parse
from parkbot.status import DayPlan, plan_days
from parkbot.store import CouncilStore

from .helpers import CONFIG_FILE, FIXTURES, ROOT, load_config, seasons

MELBOURNE = ZoneInfo("Australia/Melbourne")
FRIDAY = date(2026, 11, 20)
BACKEND = "https://alerts.example"
PAGE = "https://citizensbark.example"
TESTS = Path(__file__).parent


def at(day: date, hour: int, minute: int = 0) -> datetime:
    return datetime(day.year, day.month, day.day, hour, minute, tzinfo=MELBOURNE)


def november_store(read_at: datetime) -> CouncilStore:
    store = CouncilStore()
    text = (FIXTURES / "council_november_2026.html").read_text(encoding="utf-8")
    store.update(parse(text, read_at.date(), MELBOURNE), read_at.date(), read_at)
    return store


def november_plans(built: datetime, config=None) -> list[DayPlan]:
    config = config or load_config()
    return plan_days(built.date(), 8, november_store(built), seasons(), config.day_start, config.lights_off)


class SettingTest(unittest.TestCase):
    def load(self, extra: str, before: str = ""):
        """The test settings with ``extra`` added at the end, or ``before`` put ahead of the first section."""
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "config.toml"
            path.write_text(before + CONFIG_FILE.read_text(encoding="utf-8") + extra, encoding="utf-8")
            return config_module.load(path)

    def test_without_the_section_there_is_no_backend(self):
        self.assertEqual(load_config().backend_url, "")
        self.assertEqual(self.load('\n[backend]\nurl = ""\n').backend_url, "")

    def test_the_backend_address_loses_its_closing_slash(self):
        self.assertEqual(self.load('\n[backend]\nurl = "https://alerts.example/"\n').backend_url, "https://alerts.example")

    def test_the_backend_address_must_be_a_plain_https_address(self):
        for bad in ("http://alerts.example", "alerts.example", "https://alerts.example/<x>"):
            with self.subTest(bad=bad):
                with self.assertRaises(ConfigError) as caught:
                    self.load(f'\n[backend]\nurl = "{bad}"\n')
                self.assertIn("backend.url", str(caught.exception))

    def test_a_section_of_the_wrong_kind_is_reported(self):
        with self.assertRaises(ConfigError) as caught:
            self.load("", before='backend = "yes"\n')
        self.assertIn("[backend]", str(caught.exception))

    def test_the_old_section_for_notifications_is_refused_by_name(self):
        # An old setting is never quietly ignored: it says where the address goes now.
        with self.assertRaises(ConfigError) as caught:
            self.load('\n[notifications]\nurl = "https://alerts.example"\n')
        self.assertIn("[notifications] is no longer used", str(caught.exception))
        self.assertIn("[backend]", str(caught.exception))

    def test_the_real_settings_file_has_the_section(self):
        self.assertEqual(config_module.load(ROOT / "config.toml").backend_url, "https://alerts.citizensbark.com")


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

    def test_the_page_offers_no_notifications(self):
        for config in (load_config(), load_config(backend_url=BACKEND)):
            with self.subTest(backend=config.backend_url):
                page = self.build(config)
                self.assertNotIn('id="notify"', page)
                self.assertNotIn("notify-note", page)
                self.assertNotIn("on this device", page)
                # What a reader sees says nothing of notifications. (The script tidies up after them, and says so in its comments.)
                shown = re.sub(r"<script>.*?</script>", "", page, flags=re.DOTALL)
                self.assertNotIn("notification", shown.lower())
                # Nothing for notifications is published beside the page.
                for name in ("sw.js", "badge.png", "blank.png"):
                    self.assertFalse((self.out / name).exists(), name)
                # No script may run in the background.
                self.assertNotIn("worker-src", self.rules(page))

    def test_the_page_may_send_its_counts_to_the_backend_and_talk_to_nothing_else(self):
        self.assertEqual(self.rules(self.build(load_config()))["connect-src"], "'self'")
        page = self.build(load_config(backend_url=BACKEND + "/v1"))
        rules = self.rules(page)
        self.assertEqual(rules["connect-src"], "'self' https://alerts.example")
        self.assertEqual(rules["default-src"], "'none'")
        self.assertNotIn("unsafe-inline", rules["script-src"])

    def test_the_data_names_the_backend_and_carries_no_notification(self):
        built = at(FRIDAY, 14, 45)
        config = load_config(backend_url=BACKEND)
        data = site.page_data(config, november_plans(built, config), None, november_store(built), built)
        self.assertEqual(data["backend"], BACKEND)
        self.assertNotIn("push", data)
        self.assertNotIn("alert", data)
        for day in data["days"]:
            self.assertNotIn("notice", day)
        self.assertIsNone(site.page_data(load_config(), november_plans(built), None, november_store(built), built)["backend"])

    def test_the_old_notification_files_are_gone_from_the_repository(self):
        self.assertFalse((site.WEB / "sw.js").exists())
        for name in ("badge.png", "blank.png"):
            self.assertFalse((ROOT / "assets" / name).exists(), name)


@unittest.skipUnless(shutil.which("node"), "node is needed to run the page's script")
class LeftoversTest(unittest.TestCase):
    """A browser that turned the notifications on before they went still has their script. The page tidies it."""

    def setUp(self):
        self._folder = tempfile.TemporaryDirectory()
        self.addCleanup(self._folder.cleanup)
        built = at(FRIDAY, 14, 45)
        config = load_config(backend_url=BACKEND, site_url=PAGE + "/")
        self.data = site.page_data(config, november_plans(built, config), None, november_store(built), built)

    def open_page(self, **scenario) -> dict:
        folder = Path(self._folder.name)
        (folder / "data.json").write_text(json.dumps(self.data), encoding="utf-8")
        (folder / "scenario.json").write_text(json.dumps({"now": "2026-11-20T04:45:00Z", **scenario}), encoding="utf-8")
        result = subprocess.run(
            ["node", str(TESTS / "run_stats.js"), str(site.WEB / "page.js"), str(folder / "data.json"), str(folder / "scenario.json")],
            capture_output=True,
            text=True,
            timeout=60,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_the_old_script_and_its_address_for_notifications_are_forgotten(self):
        result = self.open_page(oldWorkers=[True], stored={"alertCheck": "1795300000000", "lastVisit": "2026-11-19"})
        self.assertEqual(result["forgotten"], {"unsubscribed": 1, "unregistered": 1})
        # The note of the last check with the backend goes too. What the counting keeps stays.
        self.assertNotIn("alertCheck", result["stored"])
        self.assertEqual(result["stored"]["lastVisit"], "2026-11-20")

    def test_a_script_without_an_address_or_with_a_broken_one_is_still_forgotten(self):
        result = self.open_page(oldWorkers=[False, "broken", True])
        self.assertEqual(result["forgotten"], {"unsubscribed": 1, "unregistered": 3})

    def test_a_browser_with_nothing_kept_or_no_place_for_scripts_is_left_alone(self):
        self.assertEqual(self.open_page()["forgotten"], {"unsubscribed": 0, "unregistered": 0})
        self.assertEqual(self.open_page(noWorkers=True)["forgotten"], {"unsubscribed": 0, "unregistered": 0})
        # Without storage, nothing fails either: the visit is still counted.
        result = self.open_page(noStorage=True, oldWorkers=[True])
        self.assertEqual(result["forgotten"], {"unsubscribed": 1, "unregistered": 1})
        self.assertEqual(result["sent"][0]["body"]["kind"], "visit")

    def test_the_tidy_up_happens_on_a_copy_of_the_page_too_where_nothing_is_counted(self):
        result = self.open_page(origin="https://example.org", oldWorkers=[True])
        self.assertEqual(result["sent"], [])
        self.assertEqual(result["forgotten"], {"unsubscribed": 1, "unregistered": 1})


if __name__ == "__main__":
    unittest.main()
