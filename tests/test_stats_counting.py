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

    def visits(self, result: dict) -> list[dict]:
        return [body for body in self.bodies(result) if body["kind"] == "visit"]

    def test_a_first_visit_is_new_today_this_month_and_ever_and_is_remembered_by_its_date_and_count_only(self):
        result = self.run_page()
        self.assertEqual(
            result["sent"],
            [
                {
                    "how": "beacon",
                    "address": BACKEND + "/hit",
                    "body": {
                        "kind": "visit",
                        "newToday": True,
                        "newThisMonth": True,
                        "firstEver": True,
                        "since": None,
                        "nth": 1,
                        "source": "",
                        "again": False,
                        "touch": False,
                        "mine": False,
                    },
                }
            ],
        )
        self.assertEqual(result["stored"], {"lastVisit": "2026-11-20", "visits": "1"})

    def test_a_device_that_was_here_earlier_today_is_not_new_and_says_which_visit_this_is(self):
        result = self.run_page(stored={"lastVisit": "2026-11-20", "visits": "4"})
        visit = self.visits(result)[0]
        self.assertEqual((visit["newToday"], visit["newThisMonth"], visit["firstEver"], visit["since"], visit["nth"]), (False, False, False, 0, 5))
        self.assertEqual(result["stored"]["visits"], "5")

    def test_a_device_that_was_here_before_says_how_many_days_ago(self):
        visit = self.visits(self.run_page(stored={"lastVisit": "2026-10-31"}))[0]
        self.assertEqual((visit["newToday"], visit["newThisMonth"], visit["firstEver"], visit["since"]), (True, True, False, 20))
        # A device from before visits were numbered starts at 1.
        self.assertEqual(visit["nth"], 1)
        visit = self.visits(self.run_page(stored={"lastVisit": "2026-11-19", "visits": "2"}))[0]
        self.assertEqual((visit["newToday"], visit["newThisMonth"], visit["since"], visit["nth"]), (True, False, 1, 3))

    def test_without_storage_the_device_counts_as_new_and_says_nothing_about_earlier_visits(self):
        visit = self.visits(self.run_page(noStorage=True))[0]
        self.assertEqual((visit["newToday"], visit["firstEver"], visit["since"], visit["nth"]), (True, True, None, None))

    def test_a_date_that_is_not_a_date_is_ignored(self):
        visit = self.visits(self.run_page(stored={"lastVisit": "<b>"}))[0]
        self.assertEqual((visit["firstEver"], visit["since"]), (True, None))

    def test_the_way_in_is_the_site_it_came_from_or_the_qr_code_and_the_marker_leaves_the_address(self):
        self.assertEqual(self.visits(self.run_page(referrer="https://t.me/"))[0]["source"], "t.me")
        self.assertEqual(self.visits(self.run_page(referrer="android-app://org.telegram.messenger/"))[0]["source"], "org.telegram.messenger")
        result = self.run_page(search="?qr", referrer="https://t.me/")
        self.assertEqual(self.visits(result)[0]["source"], "qr")
        self.assertEqual(result["replaced"], ["/"])
        # Other parts of the address stay.
        self.assertEqual(self.run_page(search="?now=2026-11-20T09:00&qr")["replaced"], ["/?now=2026-11-20T09:00"])
        self.assertEqual(self.run_page(search="?now=2026-11-20T09:00")["replaced"], [])

    def test_me_marks_this_browser_as_the_owners_so_it_sends_only_marked_visits_and_me_off_undoes_it(self):
        result = self.run_page(search="?me", presses=["telegram"], leaveAfterSeconds=30)
        self.assertEqual(self.bodies(result), [dict(self.visits(result)[0], mine=True)])
        self.assertTrue(self.visits(result)[0]["mine"])
        self.assertEqual(result["stored"]["statsMine"], "1")
        self.assertEqual(result["replaced"], ["/"])
        later = self.run_page(stored={"statsMine": "1", "lastVisit": "2026-11-20"}, presses=["telegram"])
        self.assertEqual([body["kind"] for body in self.bodies(later)], ["visit"])
        self.assertTrue(self.visits(later)[0]["mine"])
        undone = self.run_page(search="?me=off", stored={"statsMine": "1"}, presses=["telegram"])
        self.assertNotIn("statsMine", undone["stored"])
        self.assertEqual([body["kind"] for body in self.bodies(undone)], ["visit", "press"])
        self.assertFalse(self.visits(undone)[0]["mine"])

    def test_a_touch_screen_is_mentioned_so_an_ipad_can_be_told_from_a_mac(self):
        self.assertTrue(self.visits(self.run_page(touch=True))[0]["touch"])

    def test_how_long_a_look_lasted_is_sent_once_as_the_page_goes_out_of_sight(self):
        result = self.run_page(leaveAfterSeconds=42)
        stays = [body for body in self.bodies(result) if body["kind"] == "stay"]
        self.assertEqual(stays, [{"kind": "stay", "seconds": 42}])

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
        self.assertEqual(len(self.visits(self.run_page(awayMinutes=29))), 1)
        result = self.run_page(awayMinutes=30)
        again = self.visits(result)[1]
        self.assertEqual((again["newToday"], again["firstEver"], again["since"], again["nth"], again["again"], again["source"]), (False, False, 0, 2, True, ""))

    def test_without_beacons_it_sends_a_request_that_outlives_the_page_and_carries_no_cookie(self):
        result = self.run_page(noBeacon=True)
        self.assertEqual(result["sent"][0]["how"], "fetch")
        self.assertEqual((result["sent"][0]["keepalive"], result["sent"][0]["mode"], result["sent"][0]["credentials"]), (True, "no-cors", "omit"))

    def test_nothing_is_counted_on_a_copy_of_the_page_elsewhere_or_by_a_steered_browser_or_without_a_backend(self):
        self.assertEqual(self.run_page(origin="https://example.org", presses=["telegram"])["sent"], [])
        self.assertEqual(self.run_page(webdriver=True, presses=["telegram"])["sent"], [])
        self.assertEqual(self.run_page(dict(self.data, push=None), presses=["telegram"], leaveAfterSeconds=5)["sent"], [])


if __name__ == "__main__":
    unittest.main()
