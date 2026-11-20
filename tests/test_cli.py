import argparse
import contextlib
import io
import json
import tempfile
import unittest
from datetime import date
from pathlib import Path
from unittest import mock

from parkbot import cli, fetch, telegram
from parkbot.store import State

from .helpers import CONFIG_FILE, EAST, ROOT, SCHEDULE_FILE, WEST, forecast_json, october_html


class FakeWorld:
    """Stands in for the web, Telegram and GitHub during a run."""

    def __init__(self, folder: Path):
        self.folder = folder
        self.council_html: str | Exception = october_html()
        self.forecast: str | Exception | None = None  # None: build one for the day of the run
        self.fetches: list[tuple[str, dict]] = []
        # Where the weather service's name leads right now.
        self.addresses: list[str] = [WEST]
        # Set to (address, reason) to play a run on which the usual route to the
        # weather service failed for that reason and this other server answered.
        self.detour: tuple[str, str] | None = None
        # What each server says when it is asked directly. Anything not listed sends the forecast.
        self.direct: dict[str, str | Exception] = {}
        self.asked_directly: list[str] = []
        self.send_error: Exception | None = None
        self.sent: list[dict] = []
        self.lines: list[str] = []
        self.alerts: list = []
        self.environ: dict[str, str] = {"TELEGRAM_BOT_TOKEN": "123:test-token"}
        self.first_day = date(2026, 11, 20)

    def fetch(self, url, user_agent, **kwargs):
        self.fetches.append((url, kwargs))
        if "open-meteo" in url:
            source = self.forecast if self.forecast is not None else forecast_json(self.first_day, 8)
        else:
            source = self.council_html
        if isinstance(source, Exception):
            raise source
        if "open-meteo" in url and self.detour:
            kwargs["detour"](*self.detour)
        return source

    def fetch_at(self, url, user_agent, address, **kwargs):
        self.asked_directly.append(address)
        source = self.direct.get(address, forecast_json(self.first_day, 8))
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
        return cli.Tools(
            fetch=self.fetch,
            fetch_at=self.fetch_at,
            send=self.send,
            sync_issues=self.sync_issues,
            lookup=lambda url: list(self.addresses),  # never look anything up on the real network
            environ=self.environ,
            say=self.lines.append,
        )

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
        # The post no longer names its day, so tell Saturday's by its booking.
        self.assertIn("Usually booked until 6 PM", self.world.sent[1]["text"])
        self.assertEqual(self.world.state().last_daily_post, date(2026, 11, 21))

    def test_a_late_run_still_posts(self):
        self.world.run("2026-11-20T16:20")
        self.assertEqual(len(self.world.sent), 1)

    def test_no_post_outside_the_window(self):
        for moment in ("2026-11-20T06:20", "2026-11-20T11:50", "2026-11-20T14:29", "2026-11-20T19:00", "2026-11-20T23:30"):
            with self.subTest(moment=moment):
                self.assertEqual(self.world.run(moment), 0)
                self.assertEqual(self.world.sent, [])
        self.assertIsNone(self.world.state().last_daily_post)

    def test_at_the_weekend_the_post_goes_out_in_the_morning(self):
        # Saturday: the window opens at 7:30 AM, half an hour before the alert's time.
        self.world.run("2026-11-21T06:20")
        self.world.run("2026-11-21T07:29")
        self.assertEqual(self.world.sent, [])
        self.assertIn("outside the posting window (7:30 AM to 7 PM)", self.world.said())
        self.world.run("2026-11-21T07:55")
        self.assertEqual(len(self.world.sent), 1)
        # Written before the booking starts, the post names all of it.
        self.assertIn("Usually booked 10 AM to 6 PM", self.world.sent[0]["text"])
        # The later runs of the day stay quiet, the afternoon's too.
        for later in ("2026-11-21T08:25", "2026-11-21T14:45", "2026-11-21T15:55"):
            self.world.run(later)
        self.assertEqual(len(self.world.sent), 1)

    def test_on_a_weekday_the_morning_runs_do_not_post(self):
        # 8 AM is the weekend's time. On a Friday the post waits for the afternoon.
        for moment in ("2026-11-20T07:30", "2026-11-20T07:55", "2026-11-20T09:00"):
            self.world.run(moment)
        self.assertEqual(self.world.sent, [])
        self.assertIn("outside the posting window (2:30 PM to 7 PM)", self.world.said())
        self.world.run("2026-11-20T14:55")
        self.assertEqual(len(self.world.sent), 1)

    def test_each_day_of_a_week_gets_one_post_at_its_own_time(self):
        # Monday to Sunday, with a run in the morning and one in the afternoon.
        posted = []
        for day in range(23, 30):
            for moment in (f"2026-11-{day}T07:55", f"2026-11-{day}T14:55"):
                before = len(self.world.sent)
                self.world.run(moment)
                # The week-ahead post that follows Sunday's is not counted: it is the quiet one.
                if [post for post in self.world.sent[before:] if not post["silent"]]:
                    posted.append(moment[5:])
        self.assertEqual(posted, ["11-23T14:55", "11-24T14:55", "11-25T14:55", "11-26T14:55", "11-27T14:55", "11-28T07:55", "11-29T07:55"])

    def test_never_and_force(self):
        self.world.run("2026-11-20T14:45", post="never")
        self.assertEqual(self.world.sent, [])
        self.world.run("2026-11-20T09:00", post="force")
        self.assertEqual(len(self.world.sent), 1)
        # A forced post counts as today's post.
        self.world.run("2026-11-20T14:45")
        self.assertEqual(len(self.world.sent), 1)

    def test_sunday_adds_a_quiet_week_ahead_post(self):
        self.world.run("2026-11-22T07:55")
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
        # The copy was read this morning, so the post has nothing to warn about.
        self.assertNotIn("⚠️", self.world.sent[0]["text"])
        self.assertNotIn("council's schedule", self.world.sent[0]["text"])

    def page_data(self) -> dict:
        return json.loads((Path(self._folder.name) / "site" / "data.json").read_text(encoding="utf-8"))

    def test_the_page_says_when_the_council_page_was_last_read(self):
        self.world.run("2026-11-20T13:47")
        council = self.page_data()["council"]
        self.assertEqual(council["lastReadAt"], "2026-11-20T13:47+11:00")
        self.assertEqual(council["lastReadText"], "Fri 20 Nov, 1:47 PM")
        saved = json.loads((Path(self._folder.name) / "data" / "council.json").read_text(encoding="utf-8"))
        self.assertEqual(saved["last_read_at"], "2026-11-20T13:47+11:00")

        # A later run that cannot read the council's page builds a new page, but the
        # page goes on naming the last read that worked.
        self.world.council_html = fetch.FetchError("the server answered 503")
        self.world.run("2026-11-20T15:10")
        data = self.page_data()
        self.assertEqual(data["generated"], "2026-11-20T15:10+11:00")
        self.assertEqual(data["council"]["lastReadAt"], "2026-11-20T13:47+11:00")
        page = (Path(self._folder.name) / "site" / "index.html").read_text(encoding="utf-8")
        self.assertIn('<p class="kicker">Last checked Fri 20 Nov, 1:47 PM</p>', page)

        # A page that loads but cannot be understood is not a check either.
        self.world.council_html = "<html><body><h1>Just a moment...</h1></body></html>"
        self.world.run("2026-11-20T15:45")
        self.assertEqual(self.page_data()["council"]["lastReadAt"], "2026-11-20T13:47+11:00")

        self.world.council_html = october_html()
        self.world.run("2026-11-21T06:17")
        self.assertEqual(self.page_data()["council"]["lastReadAt"], "2026-11-21T06:17+11:00")

    def test_words_from_a_web_page_cannot_give_github_orders_through_the_log(self):
        # On GitHub, a log line that starts with "::" is a command. The raw table is printed
        # on request, and a table could hold such a line.
        self.world.environ["GITHUB_ACTIONS"] = "true"
        self.world.council_html = october_html().replace("</table>", "<tr><td>\n::error::made up\n</td></tr></table>", 1)
        self.assertEqual(self.world.run("2026-11-20T14:45", show_sources=True), 0)
        lines = self.world.said().split("\n")
        at = lines.index("::error::made up")
        stops = [index for index, line in enumerate(lines[:at]) if line.startswith("::stop-commands::")]
        self.assertTrue(stops, "command reading should be paused before the table is printed")
        resume = "::" + lines[stops[-1]].removeprefix("::stop-commands::") + "::"
        self.assertGreaterEqual(len(resume), 20)
        # Reading is switched back on only after the table, by a line the page could not have guessed.
        self.assertNotIn(resume, lines[stops[-1] : at])
        self.assertIn(resume, lines[at:])
        self.assertEqual(lines[lines.index(resume, at) + 1], "::endgroup::")

    def test_unreadable_council_page_counts_as_a_failure(self):
        self.world.council_html = "<html><body><h1>Just a moment...</h1></body></html>"
        self.assertEqual(self.world.run("2026-11-20T14:45"), 0)
        state = self.world.state()
        self.assertEqual(state.council_failures, 1)
        self.assertIn("could not be read", state.council_error)
        # With no council data at all, the hand-written pattern still gives an answer.
        self.assertIn("Usually booked 4 to 8 PM", self.world.sent[0]["text"])
        self.assertIn("The council's page could not be read.", self.world.sent[0]["text"])

    def test_a_surprise_while_fetching_never_stops_the_post(self):
        # Not one of the failures the fetching code knows about: a fault in the code itself.
        self.world.council_html = RuntimeError("no such thing")
        self.world.forecast = ZeroDivisionError("division by zero")
        self.assertEqual(self.world.run("2026-11-20T14:45"), 0)
        text = self.world.sent[0]["text"]
        self.assertIn("Usually booked 4 to 8 PM", text)
        self.assertIn("No rain forecast available.", text)
        state = self.world.state()
        self.assertEqual((state.council_failures, state.weather_failures), (1, 1))
        self.assertEqual(state.council_error, "fetching the page failed unexpectedly (RuntimeError: no such thing)")
        self.assertEqual(state.weather_error, "fetching the forecast failed unexpectedly (ZeroDivisionError: division by zero)")
        self.assertIn("Traceback", self.world.said())
        self.assertEqual(state.last_daily_post, date(2026, 11, 20))

    def test_another_services_words_stay_on_one_line(self):
        # The weather service's reason for refusing is repeated in the log, the saved
        # state and a watchdog issue. It must not be able to start a line of its own.
        self.world.environ["GITHUB_ACTIONS"] = "true"
        self.world.forecast = json.dumps({"error": True, "reason": "too many\n::error::made up\n" + "x" * 900})
        self.assertEqual(self.world.run("2026-11-20T14:45"), 0)
        problem = self.world.state().weather_error
        self.assertTrue(problem.startswith("the forecast service reported a problem: too many ::error::made up x"))
        self.assertNotIn("\n", problem)
        self.assertLessEqual(len(problem), 300)
        self.assertFalse([line for line in self.world.said().split("\n") if line.startswith("::error::made up")])

        self.world.send_error = telegram.TelegramError("Bad Request:\n::error::made up")
        self.world.run("2026-11-21T14:45")
        self.assertEqual(self.world.state().telegram_error, "Bad Request: ::error::made up")
        self.assertFalse([line for line in self.world.said().split("\n") if line.startswith("::error::made up")])

    def test_an_error_trace_cannot_give_github_orders_either(self):
        self.world.environ["GITHUB_ACTIONS"] = "true"
        self.world.council_html = RuntimeError("first line\n::error::made up")
        self.assertEqual(self.world.run("2026-11-20T14:45"), 0)
        lines = self.world.said().split("\n")
        at = lines.index("::error::made up")
        before = [line for line in lines[:at] if line.startswith("::stop-commands::")]
        self.assertTrue(before)
        self.assertIn("::" + before[-1].removeprefix("::stop-commands::") + "::", lines[at:])
        # What the run itself says about the failure stays on one line.
        self.assertIn("::warning::Council page: fetching the page failed unexpectedly (RuntimeError: first line) (1 in a row)", lines)

    def test_a_surprise_from_the_forecast_still_falls_back_to_the_saved_copy(self):
        self.world.forecast = self.wet_evening()
        self.world.run("2026-11-20T11:50")
        self.world.forecast = RuntimeError("no such thing")
        self.assertEqual(self.world.run("2026-11-20T14:45"), 0)
        self.assertIn("(up to 80%, about 3 mm). Forecast from 11:50 AM.", self.world.sent[0]["text"])

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

    def test_the_forecast_copy_is_replaced_at_most_once_an_hour(self):
        self.world.run("2026-11-20T11:50")
        first = self.forecast_copy().read_text(encoding="utf-8")
        self.assertIn('"fetched": "2026-11-20T11:50+11:00"', first)
        self.world.run("2026-11-20T12:30")  # too soon: nothing new to save
        self.assertEqual(self.forecast_copy().read_text(encoding="utf-8"), first)
        self.world.run("2026-11-20T13:50")  # the early-afternoon run, so the post has a recent copy to fall back on
        self.assertIn('"fetched": "2026-11-20T13:50+11:00"', self.forecast_copy().read_text(encoding="utf-8"))
        self.world.run("2026-11-20T14:45")
        self.assertIn('"fetched": "2026-11-20T13:50+11:00"', self.forecast_copy().read_text(encoding="utf-8"))
        self.world.run("2026-11-20T15:15")
        self.world.run("2026-11-20T15:50")
        self.assertIn('"fetched": "2026-11-20T15:15+11:00"', self.forecast_copy().read_text(encoding="utf-8"))

    def test_the_forecast_is_asked_for_patiently(self):
        self.world.run("2026-11-20T14:45")
        (kwargs,) = [kwargs for url, kwargs in self.world.fetches if "open-meteo" in url]
        tries, timeout, pause = kwargs["tries"], kwargs["timeout"], kwargs["pause"]
        # fetch.get waits pause, 2 x pause, 3 x pause ... between its tries.
        longest = tries * timeout + pause * sum(range(1, tries))
        self.assertGreaterEqual(tries, 4)
        self.assertGreaterEqual(longest, 120, "long enough to outlast a one-minute stall")
        # At worst every try also waits in vain for the service's other servers.
        longest += tries * fetch._DETOURS * min(timeout, fetch._DETOUR_TIMEOUT)
        self.assertLessEqual(longest, 240, "short enough that the post still goes out at about the usual time")

    def test_a_forecast_that_will_not_load_notes_the_services_address(self):
        self.world.forecast = fetch.FetchError("could not connect (The handshake operation timed out)")
        self.world.run("2026-11-20T14:45")
        self.assertIn(f"Rain forecast: the weather service's address at the time was {WEST}", self.world.said())
        # It is a note in the log only. A server is remembered when it answers, not when it is silent.
        self.assertEqual(self.world.state().weather_addresses, {})

    def test_remembers_each_server_that_answers(self):
        self.world.run("2026-11-20T11:50")
        self.assertEqual(self.world.state().weather_addresses, {WEST: date(2026, 11, 20)})
        self.world.addresses = [EAST]  # a run on a runner somewhere else is sent to the other server
        self.world.run("2026-11-21T06:20")
        self.assertEqual(self.world.state().weather_addresses, {WEST: date(2026, 11, 20), EAST: date(2026, 11, 21)})

    def test_offers_the_servers_it_knows_as_a_detour(self):
        self.world.run("2026-11-20T11:50")
        self.world.addresses = [EAST]
        self.world.run("2026-11-21T06:20")
        self.world.run("2026-11-21T11:50")
        offered = [kwargs["addresses"] for url, kwargs in self.world.fetches if "open-meteo" in url]
        # The first run knows no server yet. Later ones offer the one seen most recently first.
        self.assertEqual(offered, [[], [WEST], [EAST, WEST]])
        # The council's page has one route only.
        self.assertTrue(all("addresses" not in kwargs for url, kwargs in self.world.fetches if "open-meteo" not in url))

    def test_a_forecast_that_came_by_the_detour_is_as_good_as_any(self):
        self.world.forecast = self.wet_evening()
        self.world.run("2026-11-19T11:50")
        self.world.addresses = [EAST]
        self.world.run("2026-11-19T15:15")  # both servers are known now
        self.world.sent.clear()
        self.world.addresses = [WEST]
        self.world.detour = (EAST, "could not connect (The handshake operation timed out)")
        summary = Path(self._folder.name) / "summary.md"
        self.world.environ["GITHUB_STEP_SUMMARY"] = str(summary)
        self.assertEqual(self.world.run("2026-11-20T14:45"), 0)
        text = self.world.sent[0]["text"]
        self.assertIn("🌧 Rain likely between 5 PM and 8 PM (up to 80%, about 3 mm).", text)
        self.assertNotIn("Forecast from", text)  # it is today's forecast, not a saved copy
        said = self.world.said()
        self.assertIn("Rain forecast: no forecast by the usual route (could not connect (The handshake operation timed out))", said)
        self.assertIn(f"Rain forecast: read from the weather service's other server ({EAST})", said)
        self.assertIn(f"- Rain forecast: read from the weather service's other server ({EAST})", summary.read_text(encoding="utf-8"))
        state = self.world.state()
        self.assertEqual(state.weather_failures, 0)
        # The server that answered was seen today. The one that said nothing was not.
        self.assertEqual(state.weather_addresses, {EAST: date(2026, 11, 20), WEST: date(2026, 11, 19)})
        self.assertIn('"fetched": "2026-11-20T14:45+11:00"', self.forecast_copy().read_text(encoding="utf-8"))

    def test_never_remembers_an_address_that_is_not_public(self):
        self.world.addresses = ["10.0.0.8", "127.0.0.1", "169.254.169.254", "::1"]
        self.world.run("2026-11-20T14:45")
        self.assertEqual(self.world.state().weather_addresses, {})

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
        self.assertEqual(state.weather_addresses, {})

    def test_bad_config_stops_the_run(self):
        bad = Path(self._folder.name) / "config.toml"
        bad.write_text("[park]\nname = 'x'\n")
        self.assertEqual(self.world.run("2026-11-20T14:45", config=str(bad)), 2)
        self.assertEqual(self.world.sent, [])


class RoutesTest(unittest.TestCase):
    """``python3 -m parkbot routes``: the detour to the weather service, taken on purpose."""

    def setUp(self):
        self._folder = tempfile.TemporaryDirectory()
        self.addCleanup(self._folder.cleanup)
        self.world = FakeWorld(Path(self._folder.name))

    def routes(self, **extra) -> int:
        options = argparse.Namespace(config=str(CONFIG_FILE), data=str(self.world.folder / "data"))
        for key, value in extra.items():
            setattr(options, key, value)
        return cli.routes(options, self.world.tools())

    def test_asks_the_server_the_name_leads_to_and_the_others_it_knows(self):
        State(weather_addresses={WEST: date(2026, 11, 20), EAST: date(2026, 11, 19)}).save(self.world.folder / "data" / "state.json")
        self.world.addresses = [EAST]
        self.assertEqual(self.routes(), 0)
        self.assertEqual(self.world.asked_directly, [EAST, WEST])
        self.assertEqual(
            self.world.lines,
            [
                "By the usual route: the forecast loaded",
                f"Straight to {EAST} (where the service's name leads right now): the forecast loaded",
                f"Straight to {WEST} (another of its servers): the forecast loaded",
            ],
        )
        # One try by the usual route, with nothing to fall back on: this is a check, not a run.
        ((url, kwargs),) = self.world.fetches
        self.assertEqual((kwargs["tries"], kwargs.get("addresses")), (1, None))

    def test_a_fresh_copy_of_the_code_knows_only_the_current_server(self):
        self.assertEqual(self.routes(), 0)
        self.assertEqual(self.world.asked_directly, [WEST])

    def test_fails_when_the_same_server_answers_by_name_but_not_by_address(self):
        self.world.environ["GITHUB_ACTIONS"] = "true"
        for broken in (
            fetch.FetchError("the server's certificate was not accepted (Hostname mismatch)"),
            fetch.FetchError("the server answered 404"),
            "<html>not a forecast</html>",
        ):
            with self.subTest(broken=str(broken)):
                self.world.lines.clear()
                self.world.direct = {WEST: broken}
                self.assertEqual(self.routes(), 1)
                self.assertIn(f"Straight to {WEST} (where the service's name leads right now): it did not work (", self.world.said())
                self.assertIn("::error::The detour to the weather service is broken", self.world.said())

    def test_a_silent_server_proves_nothing(self):
        # The service's own bad moment must not fail the tests of this code.
        self.world.direct = {WEST: fetch.NoAnswer("TimeoutError: The handshake operation timed out")}
        self.assertEqual(self.routes(), 0)
        self.assertIn(f"Straight to {WEST} (where the service's name leads right now): no forecast this time (TimeoutError", self.world.said())
        # The same goes for a server that is busy, as one shared with many other callers can be.
        self.world.direct = {WEST: fetch.NoAnswer("the server answered 429")}
        self.assertEqual(self.routes(), 0)

    def test_nothing_to_compare_with_when_the_usual_route_fails_too(self):
        self.world.forecast = fetch.FetchError("could not connect (The handshake operation timed out)")
        self.world.direct = {WEST: fetch.FetchError("the server answered 503")}
        self.assertEqual(self.routes(), 0)
        self.assertIn("By the usual route: it did not work (could not connect (The handshake operation timed out))", self.world.said())

    def test_trouble_at_another_server_is_reported_but_is_not_this_codes_fault(self):
        State(weather_addresses={EAST: date(2026, 11, 19)}).save(self.world.folder / "data" / "state.json")
        self.world.direct = {EAST: fetch.FetchError("the server's certificate was not accepted (Hostname mismatch)")}
        self.assertEqual(self.routes(), 0)
        self.assertIn(f"Straight to {EAST} (another of its servers): it did not work (the server's certificate", self.world.said())

    def test_says_so_when_the_address_cannot_be_looked_up(self):
        self.world.addresses = []
        self.assertEqual(self.routes(), 0)
        self.assertEqual(self.world.asked_directly, [])
        self.assertIn("The weather service's address could not be looked up.", self.world.said())

    def test_bad_config_stops_it(self):
        bad = Path(self._folder.name) / "config.toml"
        bad.write_text("[park]\nname = 'x'\n")
        self.assertEqual(self.routes(config=str(bad)), 2)
        self.assertEqual(self.world.asked_directly, [])


class MainTest(unittest.TestCase):
    def test_the_routes_command_reads_the_real_settings_and_data(self):
        with tempfile.TemporaryDirectory() as folder:
            world = FakeWorld(Path(folder))
            State(weather_addresses={EAST: date(2026, 11, 19)}).save(Path(folder) / "state.json")
            with mock.patch.object(cli, "Tools", return_value=world.tools()):
                self.assertEqual(cli.main(["routes", "--config", str(ROOT / "config.toml"), "--data", folder]), 0)
            self.assertEqual(world.asked_directly, [WEST, EAST])
            self.assertIn("api.open-meteo.com", world.fetches[0][0])

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
