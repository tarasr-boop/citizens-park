"""The command that the scheduled job runs: ``python3 -m parkbot run``.

One run does everything, in this order:

1. read the council's page (keeping the last good copy if that fails)
2. get the rain forecast (falling back to the last one that loaded)
3. work out today and the week ahead
4. build the public page
5. post to Telegram, if a channel is set, it is time and today's post has not gone out yet
6. save what it learned, and raise or clear watchdog issues

A failing source never stops the run. The post and the page always go out
with the best information available, and they say how sure it is.
"""

from __future__ import annotations

import argparse
import os
import traceback
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path

from . import council, fetch, message, site, telegram, watchdog, weather
from .config import ConfigError, load as load_config
from .pattern import ScheduleError, load_seasons
from .status import long_date, plan_days, short_date
from .store import CouncilStore, ForecastCopy, State
from .timeparse import clock

# Today plus the seven days after it: enough for the page and the Sunday week-ahead post.
DAYS_AHEAD = 8

# The last forecast that loaded is kept in data/forecast.json. If the weather service
# does not answer, a copy up to this old stands in, and the post says when it is from.
FORECAST_COPY_MAX_AGE = timedelta(hours=12)
# A fresh forecast replaces the copy only this often, to keep the saved data quiet.
FORECAST_KEEP_EVERY = timedelta(hours=2)


@dataclass
class Tools:
    """The outside world, gathered in one place so tests can swap it out."""

    fetch: Callable[..., str] = fetch.get
    send: Callable[..., int] = telegram.send
    sync_issues: Callable[[list[watchdog.Alert]], list[str]] = watchdog.sync
    environ: Mapping[str, str] = field(default_factory=lambda: os.environ)
    say: Callable[[str], None] = print


def _local_time(text: str, zone) -> datetime:
    try:
        moment = datetime.fromisoformat(text)
    except ValueError as error:
        raise SystemExit(f"--now should look like 2026-11-20T14:45, got {text!r}") from error
    return moment.replace(tzinfo=zone) if moment.tzinfo is None else moment.astimezone(zone)


def _unexpected(error: BaseException) -> str:
    """A short, safe description of an error nobody planned for."""
    words = str(error).strip().splitlines()[0][:200] if str(error).strip() else ""
    return f"{type(error).__name__}: {words}" if words else type(error).__name__


def _append(path: str | None, text: str) -> None:
    if path:
        with open(path, "a", encoding="utf-8") as handle:
            handle.write(text)


def run(options: argparse.Namespace, tools: Tools | None = None) -> int:
    tools = tools or Tools()
    say = tools.say
    on_github = bool(tools.environ.get("GITHUB_ACTIONS"))

    def warn(text: str) -> None:
        say(f"::warning::{text}" if on_github else f"WARNING: {text}")

    try:
        config = load_config(options.config)
        seasons = load_seasons(options.schedule)
    except (ConfigError, ScheduleError) as error:
        say(f"::error::{error}" if on_github else f"ERROR: {error}")
        return 2

    zone = config.zone
    now = _local_time(options.now, zone) if options.now else datetime.now(zone)
    today = now.date()
    now_minute = now.hour * 60 + now.minute
    data_dir = Path(options.data)
    store = CouncilStore.load(data_dir / "council.json")
    state = State.load(data_dir / "state.json")
    problems: list[str] = []
    summary: list[str] = [f"### {config.park_short} check, {short_date(today)}, {clock(now_minute)}", ""]

    say(f"{config.park_short} check for {short_date(today)} at {clock(now_minute)} ({config.timezone_name})")

    # ---- 1. The council's page ----
    html: str | None = None
    council_problem = ""
    if options.council_file:
        html = Path(options.council_file).read_text(encoding="utf-8", errors="replace")
    elif not options.offline:
        try:
            html = tools.fetch(config.council_url, config.user_agent, accept="text/html,application/xhtml+xml")
        except fetch.FetchError as error:
            council_problem = f"the page could not be fetched: {error}"

    if html is not None:
        if options.show_sources:
            say(f"Council page: {len(html)} characters")
            for number, source in enumerate(council.table_sources(html), start=1):
                say(f"::group::Council table {number}" if on_github else f"--- Council table {number} ---")
                say(source)
                say("::endgroup::" if on_github else "--- end ---")
        try:
            page = council.parse(html, today, zone)
            store.update(page, today)
        except council.CouncilPageError as error:
            council_problem = f"the page loaded, but its booking table could not be read: {error}"
        except Exception as error:  # noqa: BLE001 - a surprise in the page must not stop today's post
            say(traceback.format_exc())
            council_problem = f"the page loaded, but reading it failed unexpectedly ({_unexpected(error)})"
        else:
            for warning in page.warnings:
                warn(f"Council page: {warning}")

    if html is None and not council_problem:
        say("Council page: not checked (offline)")
        summary.append("- Council page: not checked")
    elif council_problem:
        state.council_failures += 1
        state.council_error = council_problem
        warn(f"Council page: {council_problem} ({state.council_failures} in a row)")
        summary.append(f"- Council page: **not read**, {council_problem}")
    else:
        state.council_failures = 0
        state.council_error = ""
        latest = store.latest_day
        covers = f"covers up to {long_date(latest)}" if latest else "no days found"
        updated = f", page updated {long_date(store.page_modified)}" if store.page_modified else ""
        say(f"Council page: read, {covers}{updated}")
        summary.append(f"- Council page: read, {covers}{updated}")

    # ---- 2. The rain forecast ----
    forecast: weather.Forecast | None = None
    weather_problem = ""
    forecast_text: str | None = None
    live = not options.weather_file and not options.offline
    if options.weather_file:
        forecast_text = Path(options.weather_file).read_text(encoding="utf-8", errors="replace")
    elif live:
        try:
            forecast_text = tools.fetch(
                weather.url(config.latitude, config.longitude, config.timezone_name, DAYS_AHEAD),
                config.user_agent,
                accept="application/json",
                timeout=15,
            )
        except fetch.FetchError as error:
            weather_problem = f"the forecast could not be fetched: {error}"
    if forecast_text is not None:
        if options.show_sources:
            say(f"Forecast: {len(forecast_text)} characters, starts {forecast_text[:300]!r}")
        try:
            forecast = weather.parse(forecast_text)
        except weather.WeatherError as error:
            weather_problem = str(error)
        except Exception as error:  # noqa: BLE001 - the post goes out without rain rather than not at all
            say(traceback.format_exc())
            weather_problem = f"reading the forecast failed unexpectedly ({_unexpected(error)})"

    if forecast_text is None and not weather_problem:
        say("Rain forecast: not checked (offline)")
        summary.append("- Rain forecast: not checked")
    elif weather_problem:
        state.weather_failures += 1
        state.weather_error = weather_problem
        warn(f"Rain forecast: {weather_problem} ({state.weather_failures} in a row)")
        summary.append(f"- Rain forecast: **not read**, {weather_problem}")
    else:
        state.weather_failures = 0
        state.weather_error = ""
        say("Rain forecast: read")
        summary.append("- Rain forecast: read")

    if live:
        copy = ForecastCopy.load(data_dir / "forecast.json")
        age = now - copy.fetched if copy.fetched else None
        if forecast is not None:
            # Keep this one for a later run that gets no answer. Not on every run, so
            # that the afternoon's backup runs leave nothing new to save.
            if age is None or age < timedelta(0) or age >= FORECAST_KEEP_EVERY:
                ForecastCopy(now, forecast_text or "").save(data_dir / "forecast.json")
        elif age is not None and timedelta(0) <= age <= FORECAST_COPY_MAX_AGE:
            try:
                forecast = weather.parse(copy.reply)
            except Exception:  # noqa: BLE001 - a bad copy is the same as no copy
                forecast = None
            else:
                taken = copy.fetched.astimezone(zone)
                forecast.saved_at = clock(taken.hour * 60 + taken.minute) + ("" if taken.date() == today else " yesterday")
                say(f"Rain forecast: using the copy saved at {forecast.saved_at}")
                summary.append(f"- Rain forecast: using the copy saved at {forecast.saved_at}")

    # ---- 3. Today and the week ahead ----
    plans = plan_days(today, DAYS_AHEAD, store, seasons, config.day_start, config.lights_off)
    if plans[0].confirmed:
        state.uncovered_since = None
    elif state.uncovered_since is None:
        state.uncovered_since = today

    # ---- 4. The public page ----
    try:
        out = site.build(config, plans, forecast, store, now, options.site, options.assets)
    except Exception as error:  # noqa: BLE001 - the Telegram post must still go out
        problems.append(f"The page could not be built: {error}")
        say(traceback.format_exc())
        summary.append(f"- Page: **not built**, {error}")
    else:
        say(f"Page: built in {out}/")
        summary.append("- Page: built")
        _append(tools.environ.get("GITHUB_OUTPUT"), "page=ready\n")

    # ---- 5. Telegram ----
    text = message.daily(plans[0], forecast, now, config)
    say("")
    say("----- today's post -----")
    say(text)
    say("------------------------")
    say("")

    in_window = config.post_from <= now_minute < config.post_until
    due = options.post == "force" or (options.post == "auto" and in_window and state.last_daily_post != today)
    token = (tools.environ.get("TELEGRAM_BOT_TOKEN") or "").strip()
    if not due:
        if options.post == "never":
            reason = "posting is switched off for this run"
        elif state.last_daily_post == today:
            reason = "today's post has already gone out"
        else:
            reason = f"outside the posting window ({clock(config.post_from)} to {clock(config.post_until)})"
        say(f"Telegram: no post, {reason}")
        summary.append(f"- Telegram: no post, {reason}")
    elif not config.channel:
        # Not a fault: the page works on its own until a channel is named.
        state.telegram_error = ""
        say("Telegram: no post, no channel is set in config.toml")
        summary.append("- Telegram: no post, no channel is set in config.toml")
    elif not token:
        state.telegram_error = "The TELEGRAM_BOT_TOKEN secret is missing."
        warn("Telegram: the post is due, but the TELEGRAM_BOT_TOKEN secret is missing")
        summary.append("- Telegram: **not posted**, the TELEGRAM_BOT_TOKEN secret is missing")
    else:
        try:
            tools.send(token, config.channel, text)
        except Exception as error:  # noqa: BLE001 - everything after this must still happen
            # Only a TelegramError's own words are safe to repeat. state.json is public,
            # so anything else is reduced to its type, and the token is blanked regardless.
            reason = str(error) if isinstance(error, telegram.TelegramError) else f"unexpected {type(error).__name__}"
            reason = reason.replace(token, "[token]")
            state.telegram_error = reason
            problems.append(f"The Telegram post failed: {reason}")
            summary.append(f"- Telegram: **failed**, {reason}")
        else:
            state.last_daily_post = today
            state.telegram_error = ""
            state.save(data_dir / "state.json")  # straight away, so a later hiccup cannot cause a second post
            say(f"Telegram: posted to @{config.channel}")
            summary.append(f"- Telegram: posted to @{config.channel}")

    # The week ahead follows the Sunday post, quietly, so phones buzz only once.
    weekly_due = state.last_daily_post == today and today.weekday() == 6 and state.last_weekly_post != today
    if token and config.channel and weekly_due and options.post != "never":
        try:
            tools.send(token, config.channel, message.weekly(plans[1:], forecast, config), silent=True)
        except Exception as error:  # noqa: BLE001
            reason = str(error) if isinstance(error, telegram.TelegramError) else f"unexpected {type(error).__name__}"
            reason = reason.replace(token, "[token]")
            problems.append(f"The week-ahead post failed: {reason}")
            summary.append(f"- Week-ahead post: **failed**, {reason}")
        else:
            state.last_weekly_post = today
            say("Telegram: week-ahead post sent")
            summary.append("- Week-ahead post: sent")

    # ---- 6. Remember, and raise the alarm if needed ----
    store.save(data_dir / "council.json")
    state.save(data_dir / "state.json")

    for line in tools.sync_issues(watchdog.alerts(state, store, today, config)):
        say(f"Watchdog: {line}")
        summary.append(f"- Watchdog: {line}")

    summary += ["", "Today's post:", "", "```", text, "```", ""]
    _append(tools.environ.get("GITHUB_STEP_SUMMARY"), "\n".join(summary) + "\n")

    for problem in problems:
        say(f"::error::{problem}" if on_github else f"ERROR: {problem}")
    return 1 if problems else 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="parkbot", description="Citizens Park alerts: daily check, web page and Telegram post.")
    commands = parser.add_subparsers(dest="command", required=True)

    run_parser = commands.add_parser("run", help="check the sources, build the page and post if it is time")
    run_parser.add_argument(
        "--post",
        choices=["auto", "force", "never"],
        default="auto",
        help="auto: post once a day inside the posting window (default). force: post now. never: only build the page.",
    )
    run_parser.add_argument("--config", default="config.toml", help="settings file (default: config.toml)")
    run_parser.add_argument("--schedule", default="schedule.toml", help="usual weekly pattern (default: schedule.toml)")
    run_parser.add_argument("--data", default="data", help="folder for what is remembered between runs (default: data)")
    run_parser.add_argument("--site", default="site", help="folder to build the page into (default: site)")
    run_parser.add_argument("--assets", default="assets", help="folder with the icons and QR code (default: assets)")
    run_parser.add_argument("--now", help="pretend it is this local time, for example 2026-11-20T14:45")
    run_parser.add_argument("--offline", action="store_true", help="do not fetch anything from the web")
    run_parser.add_argument("--council-file", help="read the council page from this HTML file instead of the web")
    run_parser.add_argument("--weather-file", help="read the forecast from this JSON file instead of the web")
    run_parser.add_argument("--show-sources", action="store_true", help="print the raw council tables and forecast, to diagnose a failed read")
    run_parser.set_defaults(handler=run)

    options = parser.parse_args(argv)
    return options.handler(options)
