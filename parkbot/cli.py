"""The command that the scheduled job runs: ``python3 -m parkbot run``.

One run does everything, in this order:

1. read the council's page (keeping the last good copy if that fails)
2. get the rain forecast (falling back to the last one that loaded)
3. work out today and the week ahead
4. build the public page, with a picture for each of the Telegram bot's alerts
5. post to Telegram, if a channel is set, it is time and today's post has not gone out yet
   (or, once the channel has moved to the bot, its one last post)
6. save what it learned, and raise or clear watchdog issues

A failing source never stops the run. The post and the page always go out
with the best information available, and they say how sure it is.
"""

from __future__ import annotations

import argparse
import os
import secrets
import traceback
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path

from . import council, fetch, message, picture, site, telegram, watchdog, weather
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
FORECAST_KEEP_EVERY = timedelta(hours=1)
# The weather service has more than one server, and GitHub's runners are sent to
# one or another depending on where they are. One of those servers now and then
# accepts a connection and then says nothing for a minute or two. So a run
# remembers each address that answers (in data/state.json), and when the usual
# route gets no answer it asks another of them directly. If that does not help
# either, it keeps asking patiently: five tries spread over a few minutes.
FORECAST_TIMEOUT = 12  # seconds for each try
FORECAST_TRIES = 5
FORECAST_PAUSE = 10  # seconds after the first failed try, then 20, 30 and 40


@dataclass
class Tools:
    """The outside world, gathered in one place so tests can swap it out."""

    # These two come first: below the next field, "fetch" means that field, not the module.
    fetch_at: Callable[..., str] = fetch.get_at
    lookup: Callable[[str], list[str]] = fetch.addresses_of
    fetch: Callable[..., str] = fetch.get
    send: Callable[..., int] = telegram.send
    sync_issues: Callable[[list[watchdog.Alert]], list[str]] = watchdog.sync
    draw: Callable[..., str] = picture.add
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


def _one_line(text: str, limit: int = 300) -> str:
    """Words about a failure, on one line and not too long.

    They go into the job log, the saved state and a watchdog issue, and part of
    them may come from another service. On one line they stay what they are: a
    description, never a second log line of their own.
    """
    return " ".join(text.split())[:limit]


def _show_as_it_came(say: Callable[[str], None], text: str, on_github: bool) -> None:
    """Print words that came from outside, such as a web page or an error it caused.

    GitHub reads a log line that starts with "::" as a command to itself. Words
    from outside must never be taken for one, so GitHub is told to stop reading
    commands until a line that only this run knows.
    """
    if not on_github:
        say(text)
        return
    resume = secrets.token_hex(16)
    say(f"::stop-commands::{resume}")
    say(text)
    say(f"::{resume}::")


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

    def trace() -> None:
        """Print where the error being handled came from."""
        _show_as_it_came(say, traceback.format_exc(), on_github)

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
        except Exception as error:  # noqa: BLE001 - a surprise while fetching must not stop today's post
            trace()
            council_problem = f"fetching the page failed unexpectedly ({_unexpected(error)})"

    if html is not None:
        if options.show_sources:
            say(f"Council page: {len(html)} characters")
            for number, source in enumerate(council.table_sources(html), start=1):
                say(f"::group::Council table {number}" if on_github else f"--- Council table {number} ---")
                _show_as_it_came(say, source, on_github)
                say("::endgroup::" if on_github else "--- end ---")
        try:
            page = council.parse(html, today, zone)
            store.update(page, today, now)
        except council.CouncilPageError as error:
            council_problem = f"the page loaded, but its booking table could not be read: {error}"
        except Exception as error:  # noqa: BLE001 - a surprise in the page must not stop today's post
            trace()
            council_problem = f"the page loaded, but reading it failed unexpectedly ({_unexpected(error)})"
        else:
            for warning in page.warnings:
                warn(f"Council page: {warning}")

    council_problem = _one_line(council_problem)
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
    forecast_route = ""  # words for the log when the forecast came by the detour
    live = not options.weather_file and not options.offline
    if options.weather_file:
        forecast_text = Path(options.weather_file).read_text(encoding="utf-8", errors="replace")
    elif live:
        forecast_url = weather.url(config.latitude, config.longitude, config.timezone_name, DAYS_AHEAD)
        detours: list[tuple[str, str]] = []
        try:
            forecast_text = tools.fetch(
                forecast_url,
                config.user_agent,
                accept="application/json",
                timeout=FORECAST_TIMEOUT,
                tries=FORECAST_TRIES,
                pause=FORECAST_PAUSE,
                addresses=state.weather_servers(),
                detour=lambda address, reason: detours.append((address, reason)),
            )
        except fetch.FetchError as error:
            weather_problem = f"the forecast could not be fetched: {error}"
            # Which of the service's servers was it? Worth knowing if this keeps happening.
            addresses = tools.lookup(forecast_url)
            if addresses:
                say(f"Rain forecast: the weather service's address at the time was {', '.join(addresses)}")
        except Exception as error:  # noqa: BLE001 - the post goes out without rain rather than not at all
            trace()
            weather_problem = f"fetching the forecast failed unexpectedly ({_unexpected(error)})"
        else:
            # Remember the server that answered, so that a later run can turn to it.
            if detours:
                address, reason = detours[-1]
                state.saw_weather_servers([address], today)
                say(f"Rain forecast: no forecast by the usual route ({reason})")
                forecast_route = f" from the weather service's other server ({address})"
            else:
                state.saw_weather_servers(tools.lookup(forecast_url), today)
    if forecast_text is not None:
        if options.show_sources:
            say(f"Forecast: {len(forecast_text)} characters, starts {forecast_text[:300]!r}")
        try:
            forecast = weather.parse(forecast_text)
        except weather.WeatherError as error:
            weather_problem = str(error)
        except Exception as error:  # noqa: BLE001 - the post goes out without rain rather than not at all
            trace()
            weather_problem = f"reading the forecast failed unexpectedly ({_unexpected(error)})"

    weather_problem = _one_line(weather_problem)
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
        say(f"Rain forecast: read{forecast_route}")
        summary.append(f"- Rain forecast: read{forecast_route}")

    if live:
        copy = ForecastCopy.load(data_dir / "forecast.json")
        age = now - copy.fetched if copy.fetched else None
        if forecast is not None:
            # Keep this one for a later run that gets no answer. Not on every run, so
            # that the post's backup runs leave nothing new to save.
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
        trace()
        summary.append(f"- Page: **not built**, {error}")
    else:
        say(f"Page: built in {out}/")
        summary.append("- Page: built")
        # The pictures for the Telegram bot's alerts. Without them the alerts go as words alone.
        try:
            drawn = tools.draw(out, tools.environ)
        except Exception as error:  # noqa: BLE001 - the page and the alerts go out without pictures
            if not isinstance(error, picture.PictureError):
                trace()
            warn(f"Alert pictures: not drawn, {error}")
            summary.append(f"- Alert pictures: **not drawn**, {error}")
        else:
            say(f"Alert pictures: {drawn}")
            summary.append(f"- Alert pictures: {drawn}")
        _append(tools.environ.get("GITHUB_OUTPUT"), "page=ready\n")

    # ---- 5. Telegram ----
    text = message.daily(plans[0], forecast, now, config)
    say("")
    say("----- today's post -----")
    say(text)
    say("------------------------")
    say("")

    # The alert has one time from Monday to Friday and another at the weekend.
    opens = config.alert_from(today)
    in_window = opens <= now_minute < config.alert_until
    due = options.post == "force" or (options.post == "auto" and in_window and state.last_daily_post != today)
    token = (tools.environ.get("TELEGRAM_BOT_TOKEN") or "").strip()
    if config.channel and config.channel_retired:
        # The channel has moved to the bot: one last post that says so, then nothing more.
        if state.channel_farewell:
            reason = f"the channel has moved to the bot, and its last post went out on {short_date(state.channel_farewell)}"
            state.telegram_error = ""
            say(f"Telegram: no post, {reason}")
            summary.append(f"- Telegram: no post, {reason}")
        elif options.post == "never":
            say("Telegram: no post, posting is switched off for this run (the channel's last post is still to go)")
            summary.append("- Telegram: no post, posting is switched off for this run (the channel's last post is still to go)")
        elif not token:
            state.telegram_error = "The TELEGRAM_BOT_TOKEN secret is missing."
            warn("Telegram: the channel's last post is due, but the TELEGRAM_BOT_TOKEN secret is missing")
            summary.append("- Telegram: **not posted**, the TELEGRAM_BOT_TOKEN secret is missing")
        else:
            try:
                tools.send(token, config.channel, message.farewell(config))
            except Exception as error:  # noqa: BLE001 - everything after this must still happen
                reason = str(error) if isinstance(error, telegram.TelegramError) else f"unexpected {type(error).__name__}"
                reason = _one_line(reason.replace(token, "[token]"))
                state.telegram_error = reason
                problems.append(f"The channel's last post failed: {reason}")
                summary.append(f"- Telegram: channel's last post **failed**, {reason}")
            else:
                state.channel_farewell = today
                state.telegram_error = ""
                state.save(data_dir / "state.json")  # straight away, so it can never go out twice
                say(f"Telegram: the channel's last post went to @{config.channel}, pointing to the bot")
                summary.append(f"- Telegram: the channel's last post went to @{config.channel}, pointing to the bot")
    elif not due:
        if options.post == "never":
            reason = "posting is switched off for this run"
        elif state.last_daily_post == today:
            reason = "today's post has already gone out"
        else:
            reason = f"outside the posting window ({clock(opens)} to {clock(config.alert_until)})"
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
            reason = _one_line(reason.replace(token, "[token]"))
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
    if token and config.channel and not config.channel_retired and weekly_due and options.post != "never":
        try:
            tools.send(token, config.channel, message.weekly(plans[1:], forecast, config), silent=True)
        except Exception as error:  # noqa: BLE001
            reason = str(error) if isinstance(error, telegram.TelegramError) else f"unexpected {type(error).__name__}"
            reason = _one_line(reason.replace(token, "[token]"))
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


def routes(options: argparse.Namespace, tools: Tools | None = None) -> int:
    """Ask each of the weather service's known servers for the forecast, one at a time.

    A run takes this detour only when the usual route gets no answer, which is
    rare. This command takes it on purpose, so that a change which breaks the
    detour shows up in the tests and not on the first bad day.
    """
    tools = tools or Tools()
    say = tools.say
    on_github = bool(tools.environ.get("GITHUB_ACTIONS"))
    try:
        config = load_config(options.config)
    except ConfigError as error:
        say(f"::error::{error}" if on_github else f"ERROR: {error}")
        return 2
    url = weather.url(config.latitude, config.longitude, config.timezone_name, DAYS_AHEAD)

    def ask(fetcher: Callable[..., str], *where: str, **extra: int) -> tuple[str, str]:
        """Whether a forecast came back, and why not: "yes", "no", or "silent" when the server was out of reach or busy."""
        try:
            weather.parse(fetcher(url, config.user_agent, *where, accept="application/json", timeout=FORECAST_TIMEOUT, **extra))
        except fetch.NoAnswer as error:
            return "silent", str(error)
        except (fetch.FetchError, weather.WeatherError) as error:
            return "no", str(error)
        return "yes", ""

    words = {"yes": "the forecast loaded", "silent": "no forecast this time", "no": "it did not work"}
    usual, why = ask(tools.fetch, tries=1)
    say("By the usual route: " + ("the forecast loaded" if usual == "yes" else f"it did not work ({why})"))

    current = tools.lookup(url)
    known = State.load(Path(options.data) / "state.json").weather_servers()
    here: list[str] = []  # how it went at the addresses the service's name leads to right now
    for address in current + [other for other in known if other not in current]:
        outcome, why = ask(tools.fetch_at, address)
        where = "where the service's name leads right now" if address in current else "another of its servers"
        say(f"Straight to {address} ({where}): {words[outcome]}" + (f" ({why})" if why else ""))
        if address in current:
            here.append(outcome)
    if not current:
        say("The weather service's address could not be looked up.")

    # Only one result points at this code and not at the weather service: the usual
    # route works, yet the very same server will not serve us when asked by its address.
    # A server that is out of reach or busy ("silent") proves nothing either way.
    if usual == "yes" and "no" in here and "yes" not in here:
        problem = "The detour to the weather service is broken: the usual route works, but asking the same server by its address does not."
        say(f"::error::{problem}" if on_github else f"ERROR: {problem}")
        return 1
    return 0


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

    routes_parser = commands.add_parser(
        "routes", help="ask each of the weather service's known servers for the forecast, to try out the detour"
    )
    routes_parser.add_argument("--config", default="config.toml", help="settings file (default: config.toml)")
    routes_parser.add_argument("--data", default="data", help="folder with the addresses the job has learned (default: data)")
    routes_parser.set_defaults(handler=routes)

    options = parser.parse_args(argv)
    return options.handler(options)
