"""What the page's script sends to the counter behind the stats page.

The script runs in the reader's browser. Here it is run with Node against a
stand-in page, see ``run_stats.js``. Where Node is missing, these tests are
skipped. The counter itself has its own tests in ``notifications/``.
"""

import json
import shutil
import subprocess
import tempfile
import unittest
from datetime import date, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from parkbot import site
from parkbot.council import parse
from parkbot.status import plan_days
from parkbot.store import CouncilStore

from .helpers import FIXTURES, load_config, seasons

MELBOURNE = ZoneInfo("Australia/Melbourne")
FRIDAY = date(2026, 11, 20)
BACKEND = "https://alerts.example"
PAGE = "https://citizensbark.example"
TESTS = Path(__file__).parent
# 3:45 PM on Friday 20 November at the park.
NOW = "2026-11-20T04:45:00Z"


def page_data() -> dict:
    built = datetime(2026, 11, 20, 14, 45, tzinfo=MELBOURNE)
    store = CouncilStore()
    html = (FIXTURES / "council_november_2026.html").read_text(encoding="utf-8")
    store.update(parse(html, built.date(), MELBOURNE), built.date(), built)
    config = load_config(push_url=BACKEND, site_url=PAGE + "/")
    plans = plan_days(built.date(), 8, store, seasons(), config.day_start, config.lights_off)
    return site.page_data(config, plans, None, store, built)


@unittest.skipUnless(shutil.which("node"), "node is needed to run the page's script")
class CountingTest(unittest.TestCase):
    def setUp(self):
        self._folder = tempfile.TemporaryDirectory()
        self.addCleanup(self._folder.cleanup)
        self.data = page_data()

    def run_page(self, data: dict | None = None, **scenario) -> dict:
        folder = Path(self._folder.name)
        (folder / "data.json").write_text(json.dumps(data or self.data), encoding="utf-8")
        (folder / "scenario.json").write_text(json.dumps({"now": NOW, **scenario}), encoding="utf-8")
        result = subprocess.run(
            ["node", str(TESTS / "run_stats.js"), str(site.WEB / "page.js"), str(folder / "data.json"), str(folder / "scenario.json")],
            capture_output=True,
            text=True,
            timeout=60,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def bodies(self, result: dict) -> list[dict]:
        return [one["body"] for one in result["sent"]]

    def test_a_first_visit_is_new_today_this_month_and_ever_and_is_remembered_by_its_date_only(self):
        result = self.run_page()
        self.assertEqual(result["sent"], [{"how": "beacon", "address": BACKEND + "/hit", "body": {"kind": "visit", "newToday": True, "newThisMonth": True, "firstEver": True}}])
        self.assertEqual(result["stored"], {"lastVisit": "2026-11-20"})

    def test_a_device_that_was_here_earlier_today_is_not_new(self):
        result = self.run_page(stored={"lastVisit": "2026-11-20"})
        self.assertEqual(self.bodies(result), [{"kind": "visit", "newToday": False, "newThisMonth": False, "firstEver": False}])

    def test_a_device_that_was_here_last_month_is_new_today_and_this_month(self):
        result = self.run_page(stored={"lastVisit": "2026-10-31"})
        self.assertEqual(self.bodies(result), [{"kind": "visit", "newToday": True, "newThisMonth": True, "firstEver": False}])
        result = self.run_page(stored={"lastVisit": "2026-11-19"})
        self.assertEqual(self.bodies(result), [{"kind": "visit", "newToday": True, "newThisMonth": False, "firstEver": False}])

    def test_without_storage_the_device_counts_as_new(self):
        result = self.run_page(noStorage=True)
        self.assertEqual(self.bodies(result), [{"kind": "visit", "newToday": True, "newThisMonth": True, "firstEver": True}])

    def test_presses_are_named_by_where_they_are_and_what_they_are(self):
        presses = ["telegram", "notify", "label", "instagram", "shareOpen", "copy", "feedback", "mail", "council", "odd", "plain"]
        result = self.run_page(stored={"lastVisit": "2026-11-20"}, presses=presses)
        names = [body["name"] for body in self.bodies(result)[1:]]
        self.assertEqual(
            names,
            [
                "buttons:t.me",
                "buttons:notify",
                "status:to-how",
                "about:instagram.com",
                "share:open",
                "share:copy",
                "how:feedback",
                "how:email",
                "footer:yarracity.vic.gov.au",
                "page:gr-e-",
            ],
        )
        # Caught on the way down, so that a press is counted even if something else stops it.
        self.assertEqual(result["clickCaught"], 1)

    def test_closing_a_fold_is_not_counted(self):
        result = self.run_page(stored={"lastVisit": "2026-11-20"}, presses=["shareClose"])
        self.assertEqual(len(result["sent"]), 1)

    def test_looking_again_after_half_an_hour_away_is_another_visit_and_a_short_while_is_not(self):
        self.assertEqual(len(self.run_page(awayMinutes=29)["sent"]), 1)
        result = self.run_page(awayMinutes=30)
        self.assertEqual(self.bodies(result)[1], {"kind": "visit", "newToday": False, "newThisMonth": False, "firstEver": False})

    def test_without_beacons_it_sends_a_request_that_outlives_the_page_and_carries_no_cookie(self):
        result = self.run_page(noBeacon=True)
        self.assertEqual(result["sent"][0]["how"], "fetch")
        self.assertEqual((result["sent"][0]["keepalive"], result["sent"][0]["mode"], result["sent"][0]["credentials"]), (True, "no-cors", "omit"))

    def test_nothing_is_counted_on_a_copy_of_the_page_elsewhere_or_by_a_steered_browser_or_without_a_backend(self):
        self.assertEqual(self.run_page(origin="https://example.org", presses=["telegram"])["sent"], [])
        self.assertEqual(self.run_page(webdriver=True, presses=["telegram"])["sent"], [])
        self.assertEqual(self.run_page(dict(self.data, push=None), presses=["telegram"])["sent"], [])
        self.assertEqual(self.run_page(dict(self.data, push=None))["stored"], {})


if __name__ == "__main__":
    unittest.main()
