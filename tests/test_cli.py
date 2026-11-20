import argparse
import contextlib
import io
import json
import tempfile
import unittest
from datetime import date
from pathlib import Path

from parkbot import cli, fetch, telegram
from parkbot.store import State

from .helpers import CONFIG_FILE, ROOT, SCHEDULE_FILE, forecast_json, october_html


class FakeWorld:
    """Stands in for the web, Telegram and GitHub during a run."""

    def __init__(self, folder: Path):
        self.folder = folder
        self.council_html: str | Exception = october_html()
        self.forecast: str | Exception | None = None  # None: build one for the day of the run
        self.send_error: Exception | None = None
        self.sent: list[dict] = []
        self.lines: list[str] = []
        self.alerts: list = []
        self.environ: dict[str, str] = {"TELEGRAM_BOT_TOKEN": "123:test-token"}
        self.first_day = date(2026, 11, 20)

    def fetch(self, url, user_agent, **_kwargs):
        if "open-meteo" in url:
            source = self.forecast if self.forecast is not None else forecast_json(self.first_day, 8)
        else:
            source = self.council_html
        if isinstance(source, Exception):
            raise source
        return source

    def send(self, token, channel, text, silent=False):
        if self.send_error:
            raise self.send_error
        self.sent.append({"token": token, "channel": channel, "text": text, "silent": silent})
        return len(self.sent)

    def sync_issues(self, alerts):
        self.alerts = alerts
        return []

    def tools(self) -> cli.Tools:
        return cli.Tools(fetch=self.fetch, send=self.send, sync_issues=self.sync_issues, environ=self.environ, say=self.lines.append)

    def run(self, now: str, post: str = "auto", **extra) -> int:
        self.first_day = date.fromisoformat(now[:10])
        options = argparse.Namespace(
            post=post,
            config=str(CONFIG_FILE),
            schedule=str(SCHEDULE_FILE),
            data=str(self.folder / "data"),
            site=str(self.folder / "site"),
            assets=str(ROOT / "assets"),
            now=now,
            offline=False,
            council_file=None,
            weather_file=None,
            show_sources=False,
        )
        for key, value in extra.items():
            setattr(options, key, value)
        return cli.run(options, self.tools())

    def state(self) -> State:
        return State.load(self.folder / "data" / "state.json")

    def said(self) -> str:
        return "\n".join(self.lines)


class RunTest(unittest.TestCase):
    def setUp(self):
        self._folder = tempfile.TemporaryDirectory()
        self.addCleanup(self._folder.cleanup)
        self.world = FakeWorld(Path(self._folder.name))

    def test_posts_once_inside_the_window(self):
        self.assertEqual(self.world.run("2026-11-20T14:45"), 0)
        self.assertEqual(len(self.world.sent), 1)
        post = self.world.sent[0]
        self.assertEqual(post["channel"], "ExampleParkDogs")
        self.assertFalse(post["silent"])
        self.assertIn("Usually booked 4 to 8 PM", post["text"])
        self.assertEqual(self.world.state().last_daily_post, date(2026, 11, 20))

        # The backup runs later the same afternoon must stay quiet.
        self.assertEqual(self.world.run("2026-11-20T15:15"), 0)
        self.assertEqual(self.world.run("2026-11-20T15:50"), 0)
        self.assertEqual(len(self.world.sent), 1)
        self.assertIn("today's post has already gone out", self.world.said())

    def test_posts_again_the_next_day(self):
        self.world.run("2026-11-20T14:45")
        self.world.run("2026-11-21T14:45")
        self.assertEqual(len(self.world.sent), 2)
        self.assertIn("Sat 21 Nov", self.world.sent[1]["text"])

    def test_a_late_run_still_posts(self):
        self.world.run("2026-11-20T16:20")
        self.assertEqual(len(self.world.sent), 1)

    def test_no_post_outside_the_window(self):
        for moment in ("2026-11-20T06:20", "2026-11-20T11:50", "2026-11-20T14:29", "2026-11-20T19:00", "2026-11-20T23:30"):
            with self.subTest(moment=moment):
                self.assertEqual(self.world.run(moment), 0)
                self.assertEqual(self.world.sent, [])
        self.assertIsNone(self.world.state().last_daily_post)

    def test_never_and_force(self):
        self.world.run("2026-11-20T14:45", post="never")
        self.assertEqual(self.world.sent, [])
        self.world.run("2026-11-20T09:00", post="force")
        self.assertEqual(len(self.world.sent), 1)
        # A forced post counts as today's post.
        self.world.run("2026-11-20T14:45")
        self.assertEqual(len(self.world.sent), 1)

    def test_sunday_adds_a_quiet_week_ahead_post(self):
        self.world.run("2026-11-22T14:45")
        self.assertEqual([post["silent"] for post in self.world.sent], [False, True])
        self.assertIn("the week ahead", self.world.sent[1]["text"])
        self.assertIn("Mon 23 Nov", self.world.sent[1]["text"])
        self.assertIn("Sun 29 Nov", self.world.sent[1]["text"])
        self.world.run("2026-11-22T15:15")
        self.assertEqual(len(self.world.sent), 2)
        self.assertEqual(self.world.state().last_weekly_post, date(2026, 11, 22))

    def test_no_week_ahead_post_on_other_days(self):
        self.world.run("2026-11-21T14:45")
        self.assertEqual(len(self.world.sent), 1)

    def test_missing_token_is_reported_but_not_fatal(self):
        self.world.environ = {}
        self.assertEqual(self.world.run("2026-11-20T14:45"), 0)
        self.assertEqual(self.world.sent, [])
        self.assertIn("TELEGRAM_BOT_TOKEN", self.world.state().telegram_error)
        self.assertTrue(any(alert.title == "The Telegram post is not going out" for alert in self.world.alerts))
        self.assertTrue((Path(self._folder.name) / "site" / "index.html").exists())

    def test_telegram_failure_fails_the_run_and_is_retried(self):
        self.world.send_error = telegram.TelegramError("Forbidden: bot is not a member of the channel chat")
        self.assertEqual(self.world.run("2026-11-20T14:45"), 1)
        state = self.world.state()
        self.assertIsNone(state.last_daily_post)
        self.assertIn("not a member", state.telegram_error)

        self.world.send_error = None
        self.assertEqual(self.world.run("2026-11-20T15:15"), 0)
        self.assertEqual(len(self.world.sent), 1)
        self.assertEqual(self.world.state().telegram_error, "")
        self.assertEqual(self.world.alerts, [])

    def test_council_outage_falls_back_and_counts(self):
        self.world.run("2026-11-20T06:20")  # a good read first
        self.world.council_html = fetch.FetchError("the server answered 503")
        self.assertEqual(self.world.run("2026-11-20T14:45"), 0)
        self.assertEqual(len(self.world.sent), 1)
        self.assertIn("Usually booked 4 to 8 PM", self.world.sent[0]["text"])
        state = self.world.state()
        self.assertEqual(state.council_failures, 1)
        self.assertIn("503", state.council_error)

        self.world.council_html = october_html()
        self.world.run("2026-11-20T15:15")
        self.assertEqual(self.world.state().council_failures, 0)

    def test_council_outage_on_a_covered_day_uses_the_saved_copy(self):
        self.world.run("2026-10-27T06:20")
        self.world.council_html = fetch.FetchError("timed out")
        self.world.run("2026-10-27T14:45")
        self.assertIn("🔴 Booked 4:15 to 7:30 PM", self.world.sent[0]["text"])
        self.assertIn("✅ From the council's schedule.", self.world.sent[0]["text"])

    def test_unreadable_council_page_counts_as_a_failure(self):
        self.world.council_html = "<html><body><h1>Just a moment...</h1></body></html>"
        self.assertEqual(self.world.run("2026-11-20T14:45"), 0)
        state = self.world.state()
        self.assertEqual(state.council_failures, 1)
        self.assertIn("could not be read", state.council_error)
        # With no council data at all, the hand-written pattern still gives an answer.
        self.assertIn("Usually booked 4 to 8 PM", self.world.sent[0]["text"])
        self.assertIn("The council's page could not be read.", self.world.sent[0]["text"])

    def test_the_watchdog_hears_about_repeated_failures(self):
        self.world.council_html = fetch.FetchError("the server answered 403")
        for moment in ("06:20", "11:50", "14:45", "15:15"):
            self.world.run(f"2026-11-20T{moment}")
        self.assertEqual([alert.title for alert in self.world.alerts], ["The council page cannot be read"])

    def test_weather_outage(self):
        self.world.forecast = fetch.FetchError("could not connect")
        self.assertEqual(self.world.run("2026-11-20T14:45"), 0)
        self.assertIn("No rain forecast available.", self.world.sent[0]["text"])
        self.assertEqual(self.world.state().weather_failures, 1)
        self.world.forecast = "{broken"
        self.world.run("2026-11-21T14:45")
        self.assertEqual(self.world.state().weather_failures, 2)

    def wet_evening(self) -> str:
        """A forecast for 20 November with rain between 5 and 8 PM."""
        return forecast_json(
            date(2026, 11, 20),
            8,
            chance=lambda day, hour: 80 if 17 <= hour <= 19 else 5,
            mm=lambda day, hour: 1.0 if 17 <= hour <= 19 else 0.0,
        )

    def forecast_copy(self) -> Path:
        return Path(self._folder.name) / "data" / "forecast.json"

    def test_a_forecast_that_will_not_load_falls_back_to_the_last_one(self):
        self.world.forecast = self.wet_evening()
        self.world.run("2026-11-20T11:50")  # a good read at lunchtime
        self.world.forecast = fetch.FetchError("could not connect (The handshake operation timed out)")
        self.assertEqual(self.world.run("2026-11-20T14:45"), 0)
        text = self.world.sent[0]["text"]
        self.assertIn("🌧 Rain likely between 5 PM and 8 PM (up to 80%, about 3 mm). Forecast from 11:50 AM.", text)
        self.assertIn("using the copy saved at 11:50 AM", self.world.said())
        # The failure is still counted, so the watchdog hears about it if it goes on.
        self.assertEqual(self.world.state().weather_failures, 1)
        data = json.loads((Path(self._folder.name) / "site" / "data.json").read_text(encoding="utf-8"))
        self.assertEqual(data["rainFrom"], "11:50 AM")
        self.assertEqual(data["days"][0]["rain"]["chance"], 80)

    def test_a_fresh_forecast_carries_no_such_note(self):
        self.world.forecast = self.wet_evening()
        self.world.run("2026-11-20T14:45")
        self.assertNotIn("Forecast from", self.world.sent[0]["text"])
        data = json.loads((Path(self._folder.name) / "site" / "data.json").read_text(encoding="utf-8"))
        self.assertIsNone(data["rainFrom"])

    def test_a_copy_from_last_night_says_so(self):
        self.world.forecast = forecast_json(date(2026, 11, 20), 8, chance=lambda day, hour: 90, mm=lambda day, hour: 0.5)
        self.world.run("2026-11-20T21:30")
        self.world.forecast = fetch.FetchError("timed out")
        self.world.run("2026-11-21T06:20", post="force")
        self.assertIn("Forecast from 9:30 PM yesterday.", self.world.sent[0]["text"])
        self.assertIn("Rain likely", self.world.sent[0]["text"])

    def test_a_forecast_copy_older_than_half_a_day_is_not_used(self):
        self.world.forecast = self.wet_evening()
        self.world.run("2026-11-20T06:20")
        self.world.forecast = fetch.FetchError("timed out")
        self.world.run("2026-11-20T18:21", post="force")  # twelve hours and one minute later
        self.assertIn("No rain forecast available.", self.world.sent[0]["text"])
        self.assertNotIn("Forecast from", self.world.sent[0]["text"])

    def test_the_forecast_copy_is_replaced_only_every_couple_of_hours(self):
        self.world.run("2026-11-20T11:50")
        first = self.forecast_copy().read_text(encoding="utf-8")
        self.assertIn('"fetched": "2026-11-20T11:50+11:00"', first)
        self.world.run("2026-11-20T12:30")  # too soon: nothing new to save
        self.assertEqual(self.forecast_copy().read_text(encoding="utf-8"), first)
        self.world.run("2026-11-20T14:45")
        self.assertIn('"fetched": "2026-11-20T14:45+11:00"', self.forecast_copy().read_text(encoding="utf-8"))
        self.world.run("2026-11-20T15:15")
        self.world.run("2026-11-20T15:50")
        self.assertIn('"fetched": "2026-11-20T14:45+11:00"', self.forecast_copy().read_text(encoding="utf-8"))

    def test_a_failed_forecast_never_replaces_the_copy(self):
        self.world.run("2026-11-20T06:20")
        first = self.forecast_copy().read_text(encoding="utf-8")
        self.world.forecast = "{broken"
        self.world.run("2026-11-20T11:50")
        self.assertEqual(self.forecast_copy().read_text(encoding="utf-8"), first)
        self.assertIn("using the copy saved at 6:20 AM", self.world.said())

    def test_a_damaged_forecast_copy_is_ignored(self):
        for damaged in ("{not json", '{"fetched": "soon", "reply": "{}"}', '{"fetched": "2026-11-20T11:50+11:00", "reply": "{broken"}'):
            with self.subTest(damaged=damaged):
                self.forecast_copy().parent.mkdir(parents=True, exist_ok=True)
                self.forecast_copy().write_text(damaged, encoding="utf-8")
                self.world.forecast = fetch.FetchError("timed out")
                self.world.sent.clear()
                self.assertEqual(self.world.run("2026-11-20T14:45", post="force"), 0)
                self.assertIn("No rain forecast available.", self.world.sent[0]["text"])

    def test_tracks_how_long_the_council_page_has_lagged(self):
        self.world.run("2026-11-20T14:45")
        self.assertEqual(self.world.state().uncovered_since, date(2026, 11, 20))
        self.world.run("2026-11-21T14:45")
        self.assertEqual(self.world.state().uncovered_since, date(2026, 11, 20))
        self.world.run("2026-11-28T14:45")
        self.assertEqual([alert.title for alert in self.world.alerts], ["The council page is out of date"])

    def test_builds_the_page_and_reports_to_github(self):
        output = Path(self._folder.name) / "github_output"
        summary = Path(self._folder.name) / "summary.md"
        self.world.environ.update({"GITHUB_ACTIONS": "true", "GITHUB_OUTPUT": str(output), "GITHUB_STEP_SUMMARY": str(summary)})
        self.assertEqual(self.world.run("2026-11-20T14:45"), 0)
        site = Path(self._folder.name) / "site"
        self.assertTrue((site / "index.html").exists())
        data = json.loads((site / "data.json").read_text(encoding="utf-8"))
        self.assertEqual(data["days"][0]["date"], "2026-11-20")
        self.assertEqual(len(data["days"]), 8)
        self.assertEqual(output.read_text(), "page=ready\n")
        text = summary.read_text(encoding="utf-8")
        self.assertIn("Telegram: posted to @ExampleParkDogs", text)
        self.assertIn("Council page: read, covers up to 31 October", text)

    def test_the_token_never_reaches_the_log(self):
        self.world.send_error = telegram.TelegramError("Unauthorized")
        self.world.run("2026-11-20T14:45")
        self.assertNotIn("123:test-token", self.world.said())

    def test_offline_run_touches_no_counters(self):
        self.assertEqual(self.world.run("2026-11-20T14:45", post="never", offline=True), 0)
        state = self.world.state()
        self.assertEqual((state.council_failures, state.weather_failures), (0, 0))
        self.assertIn("not checked (offline)", self.world.said())
        self.assertFalse((Path(self._folder.name) / "data" / "forecast.json").exists())

    def test_bad_config_stops_the_run(self):
        bad = Path(self._folder.name) / "config.toml"
        bad.write_text("[park]\nname = 'x'\n")
        self.assertEqual(self.world.run("2026-11-20T14:45", config=str(bad)), 2)
        self.assertEqual(self.world.sent, [])


class MainTest(unittest.TestCase):
    def test_the_command_builds_the_page_from_the_real_settings(self):
        # The same command the scheduled job runs, with the repository's own
        # config.toml and schedule.toml, but offline and without posting.
        with tempfile.TemporaryDirectory() as folder, contextlib.redirect_stdout(io.StringIO()) as printed:
            code = cli.main(
                [
                    "run", "--post", "never", "--offline", "--now", "2026-11-20T14:45",
                    "--config", str(ROOT / "config.toml"), "--schedule", str(ROOT / "schedule.toml"),
                    "--assets", str(ROOT / "assets"), "--data", f"{folder}/data", "--site", f"{folder}/site",
                ]  # fmt: skip
            )
            self.assertEqual(code, 0, printed.getvalue())
            self.assertIn("----- today's post -----", printed.getvalue())
            self.assertTrue(Path(folder, "site", "index.html").exists())
            self.assertTrue(Path(folder, "site", "qr.svg").exists())


if __name__ == "__main__":
    unittest.main()
