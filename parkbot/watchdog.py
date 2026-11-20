"""Tell the owner when something needs attention.

The channel should never go quiet or wrong without anybody knowing. When a
source keeps failing, this opens an issue in the GitHub repository (GitHub
emails the owner about new issues) and closes it again once the problem has
gone. It uses the ``gh`` command, which is present on GitHub's runners.
Outside GitHub Actions it does nothing.
"""

from __future__ import annotations

import json
import os
import subprocess
from dataclasses import dataclass
from datetime import date

from .config import Config
from .status import long_date
from .store import CouncilStore, State

PREFIX = "[watchdog] "

# Runs in a row a source must fail before an issue is opened. With about seven
# runs a day this is a little over half a day, so one bad hour raises no alarm.
FAILED_RUNS = 4
# Days the council's page may lag behind before an issue points it out.
LAG_DAYS = 7


@dataclass(frozen=True)
class Alert:
    title: str
    body: str


def alerts(state: State, store: CouncilStore, today: date, config: Config) -> list[Alert]:
    """Everything that currently deserves the owner's attention."""
    found: list[Alert] = []

    if state.council_failures >= FAILED_RUNS:
        found.append(
            Alert(
                "The council page cannot be read",
                f"The last {state.council_failures} checks could not read the council's page.\n\n"
                f"- Problem: {state.council_error or 'unknown'}\n"
                f"- Page: {config.council_url}\n"
                f"- Last good read: {long_date(store.last_read) if store.last_read else 'never'}\n\n"
                "The alerts keep going with the last good copy and the usual pattern, and they say so.\n\n"
                "What to do: open the page in a browser. If it loads and still shows a table with the "
                "weekdays across the top, the council's site may be blocking the checker, or the table's "
                "layout has changed and the reader in `parkbot/council.py` needs a small update.\n\n"
                "This issue closes by itself when the page can be read again.",
            )
        )
    elif state.uncovered_since and (today - state.uncovered_since).days >= LAG_DAYS:
        latest = store.latest_day
        found.append(
            Alert(
                "The council page is out of date",
                f"The council's page has not covered today's date since {long_date(state.uncovered_since)}. "
                + (f"Its table only goes up to {long_date(latest)}.\n\n" if latest else "\n\n")
                + "The alerts are using the usual weekly pattern and are marked \"not confirmed\".\n\n"
                "What to do: nothing is broken. If the usual pattern has changed, edit `schedule.toml`. "
                "It may also help to ask the council to update the page.\n\n"
                f"Page: {config.council_url}\n\n"
                "This issue closes by itself when the council's page covers today again.",
            )
        )

    if state.weather_failures >= FAILED_RUNS:
        found.append(
            Alert(
                "The rain forecast cannot be read",
                f"The last {state.weather_failures} checks could not get the forecast from Open-Meteo.\n\n"
                f"- Problem: {state.weather_error or 'unknown'}\n\n"
                "The alerts keep going without the rain line.\n\n"
                "This issue closes by itself when the forecast is back.",
            )
        )

    if state.telegram_error:
        found.append(
            Alert(
                "The Telegram post is not going out",
                f"The daily post could not be sent to the channel.\n\n- Problem: {state.telegram_error}\n\n"
                "What to check:\n"
                "1. The repository secret `TELEGRAM_BOT_TOKEN` holds the token from @BotFather "
                "(Settings, Secrets and variables, Actions).\n"
                f"2. `telegram.channel` in `config.toml` is the channel's link name (now `{config.channel or 'empty'}`).\n"
                "3. The bot is an administrator of the channel with Post Messages switched on.\n\n"
                "This issue closes by itself after the next post that works.",
            )
        )
    return found


def _gh(arguments: list[str], run=subprocess.run) -> str:
    result = run(["gh", *arguments], capture_output=True, text=True, timeout=60)
    if result.returncode != 0:
        raise RuntimeError((result.stderr or result.stdout or "gh failed").strip()[:300])
    return result.stdout


def sync(current: list[Alert], run=subprocess.run, environ: dict[str, str] | None = None) -> list[str]:
    """Open an issue for each new alert and close the ones that no longer apply.

    Returns a line for each thing it did. Never raises: a watchdog that breaks
    the run it is watching would be worse than none.
    """
    environ = os.environ if environ is None else environ
    if not (environ.get("GITHUB_ACTIONS") and environ.get("GH_TOKEN")):
        return []
    done: list[str] = []
    try:
        listed = json.loads(_gh(["issue", "list", "--state", "open", "--limit", "100", "--json", "number,title"], run))
        open_issues = {item["title"]: item["number"] for item in listed if str(item.get("title", "")).startswith(PREFIX)}
        wanted = {PREFIX + alert.title: alert for alert in current}
        for title, alert in wanted.items():
            if title not in open_issues:
                _gh(["issue", "create", "--title", title, "--body", alert.body], run)
                done.append(f"opened issue: {title}")
        for title, number in open_issues.items():
            if title not in wanted:
                _gh(["issue", "close", str(number), "--comment", "This has cleared up, so the checker is closing the issue."], run)
                done.append(f"closed issue: {title}")
    except Exception as error:  # noqa: BLE001 - see the docstring
        done.append(f"watchdog could not update the issues: {error}")
    return done
