import json
import subprocess
import unittest
from datetime import date

from parkbot import watchdog
from parkbot.store import CouncilStore, State
from parkbot.watchdog import Alert, alerts, sync

from .helpers import load_config, october_store

TODAY = date(2026, 11, 20)


def titles(found: list[Alert]) -> list[str]:
    return [alert.title for alert in found]


class AlertsTest(unittest.TestCase):
    def setUp(self):
        self.config = load_config()
        self.store = october_store(TODAY)

    def test_all_quiet(self):
        self.assertEqual(alerts(State(), self.store, TODAY, self.config), [])

    def test_one_bad_run_raises_no_alarm(self):
        state = State(council_failures=3, council_error="timed out", weather_failures=3, weather_error="timed out")
        self.assertEqual(alerts(state, self.store, TODAY, self.config), [])

    def test_council_page_failing(self):
        state = State(council_failures=4, council_error="the server answered 403")
        found = alerts(state, self.store, TODAY, self.config)
        self.assertEqual(titles(found), ["The council page cannot be read"])
        self.assertIn("the server answered 403", found[0].body)
        self.assertIn("https://council.example/parks/citizens-park", found[0].body)
        self.assertIn("Last good read: 20 November", found[0].body)
        self.assertIn("closes by itself", found[0].body)

    def test_council_page_never_read(self):
        state = State(council_failures=9, council_error="could not connect")
        found = alerts(state, CouncilStore(), TODAY, self.config)
        self.assertIn("Last good read: never", found[0].body)

    def test_council_page_lagging(self):
        state = State(uncovered_since=date(2026, 11, 14))
        self.assertEqual(alerts(state, self.store, TODAY, self.config), [])  # six days: not yet
        state = State(uncovered_since=date(2026, 11, 13))
        found = alerts(state, self.store, TODAY, self.config)
        self.assertEqual(titles(found), ["The council page is out of date"])
        self.assertIn("since 13 November", found[0].body)
        self.assertIn("only goes up to 31 October", found[0].body)
        self.assertIn("schedule.toml", found[0].body)

    def test_a_page_that_cannot_be_read_is_not_also_called_out_of_date(self):
        state = State(council_failures=5, council_error="x", uncovered_since=date(2026, 10, 1))
        self.assertEqual(titles(alerts(state, self.store, TODAY, self.config)), ["The council page cannot be read"])

    def test_forecast_failing(self):
        state = State(weather_failures=4, weather_error="the server answered 502")
        found = alerts(state, self.store, TODAY, self.config)
        self.assertEqual(titles(found), ["The rain forecast cannot be read"])
        self.assertIn("502", found[0].body)

    def test_telegram_failing_is_raised_straight_away(self):
        state = State(telegram_error="Forbidden: bot is not a member of the channel chat")
        found = alerts(state, self.store, TODAY, self.config)
        self.assertEqual(titles(found), ["The Telegram post is not going out"])
        self.assertIn("bot is not a member", found[0].body)
        self.assertIn("TELEGRAM_BOT_TOKEN", found[0].body)
        self.assertIn("`ExampleParkDogs`", found[0].body)

    def test_several_problems_at_once(self):
        state = State(council_failures=4, weather_failures=6, telegram_error="Unauthorized")
        self.assertEqual(
            titles(alerts(state, self.store, TODAY, self.config)),
            ["The council page cannot be read", "The rain forecast cannot be read", "The Telegram post is not going out"],
        )


class FakeGh:
    """Stands in for the ``gh`` command and remembers what it was asked to do."""

    def __init__(self, open_issues: list[dict] | None = None, fail_on: str | None = None):
        self.open_issues = open_issues or []
        self.fail_on = fail_on
        self.calls: list[list[str]] = []

    def __call__(self, command, **kwargs):
        self.calls.append(command)
        action = command[2]
        if action == self.fail_on:
            return subprocess.CompletedProcess(command, 1, stdout="", stderr="HTTP 403: Resource not accessible by integration")
        output = json.dumps(self.open_issues) if action == "list" else ""
        return subprocess.CompletedProcess(command, 0, stdout=output, stderr="")

    def did(self, action: str) -> list[list[str]]:
        return [call for call in self.calls if call[2] == action]


ON_GITHUB = {"GITHUB_ACTIONS": "true", "GH_TOKEN": "ghs_example"}


class SyncTest(unittest.TestCase):
    def test_does_nothing_away_from_github(self):
        gh = FakeGh()
        self.assertEqual(sync([Alert("Something", "body")], run=gh, environ={}), [])
        self.assertEqual(sync([Alert("Something", "body")], run=gh, environ={"GITHUB_ACTIONS": "true"}), [])
        self.assertEqual(gh.calls, [])

    def test_opens_an_issue_for_a_new_alert(self):
        gh = FakeGh()
        done = sync([Alert("The council page cannot be read", "Details here.")], run=gh, environ=ON_GITHUB)
        self.assertEqual(done, ["opened issue: [watchdog] The council page cannot be read"])
        created = gh.did("create")
        self.assertEqual(len(created), 1)
        self.assertEqual(created[0][:3], ["gh", "issue", "create"])
        self.assertEqual(created[0][created[0].index("--title") + 1], "[watchdog] The council page cannot be read")
        self.assertEqual(created[0][created[0].index("--body") + 1], "Details here.")
        self.assertEqual(gh.did("close"), [])

    def test_does_not_open_the_same_issue_twice(self):
        gh = FakeGh([{"number": 7, "title": "[watchdog] The council page cannot be read"}])
        done = sync([Alert("The council page cannot be read", "Details here.")], run=gh, environ=ON_GITHUB)
        self.assertEqual(done, [])
        self.assertEqual(gh.did("create"), [])
        self.assertEqual(gh.did("close"), [])

    def test_closes_an_issue_once_the_problem_has_gone(self):
        gh = FakeGh([{"number": 7, "title": "[watchdog] The council page cannot be read"}])
        done = sync([], run=gh, environ=ON_GITHUB)
        self.assertEqual(done, ["closed issue: [watchdog] The council page cannot be read"])
        closed = gh.did("close")
        self.assertEqual(len(closed), 1)
        self.assertEqual(closed[0][3], "7")

    def test_leaves_other_issues_alone(self):
        gh = FakeGh([{"number": 3, "title": "The page looks odd on my phone"}])
        self.assertEqual(sync([], run=gh, environ=ON_GITHUB), [])
        self.assertEqual(gh.did("close"), [])

    def test_swaps_one_alert_for_another(self):
        gh = FakeGh([{"number": 7, "title": "[watchdog] The council page cannot be read"}])
        done = sync([Alert("The council page is out of date", "Details.")], run=gh, environ=ON_GITHUB)
        self.assertEqual(
            done,
            ["opened issue: [watchdog] The council page is out of date", "closed issue: [watchdog] The council page cannot be read"],
        )

    def test_a_failing_gh_command_never_stops_the_run(self):
        for action in ("list", "create"):
            with self.subTest(action=action):
                gh = FakeGh(fail_on=action)
                done = sync([Alert("Something", "body")], run=gh, environ=ON_GITHUB)
                self.assertEqual(len(done), 1)
                self.assertIn("watchdog could not update the issues", done[0])
                self.assertIn("403", done[0])

    def test_a_missing_gh_command_never_stops_the_run(self):
        def missing(command, **kwargs):
            raise FileNotFoundError("gh")

        done = sync([Alert("Something", "body")], run=missing, environ=ON_GITHUB)
        self.assertIn("watchdog could not update the issues", done[0])

    def test_issue_titles_share_one_prefix(self):
        self.assertEqual(watchdog.PREFIX, "[watchdog] ")


if __name__ == "__main__":
    unittest.main()
