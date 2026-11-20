"""Build the public web page.

The page is one self-contained HTML file. It carries the next few days of
bookings and rain as JSON, and a small script draws the answer for "right
now". The same information is also written into the page as plain text, so
it still reads sensibly with scripts switched off.
"""

from __future__ import annotations

import json
import re
import shutil
from datetime import datetime
from html import escape
from pathlib import Path

from .config import Config
from .status import DayPlan, short_date
from .store import CouncilStore
from .timeparse import clock, spans
from .weather import Forecast

WEB = Path(__file__).parent / "web"

# How many days get hour-by-hour rain in the page's data (today and tomorrow).
_HOURLY_DAYS = 2
# Files in assets/ that are for the repository, not for the public page.
_PRIVATE_ASSETS = {"qr-url.txt"}


def _stamp(now: datetime) -> str:
    """``Fri 20 Nov, 2:41 PM``"""
    return f"{short_date(now.date())}, {clock(now.hour * 60 + now.minute)}"


def page_data(config: Config, plans: list[DayPlan], forecast: Forecast | None, store: CouncilStore, now: datetime) -> dict:
    """Everything the page's script needs."""
    days = []
    for index, plan in enumerate(plans):
        rain = forecast.days.get(plan.day) if forecast else None
        hours = forecast.hours.get(plan.day) if forecast and index < _HOURLY_DAYS else None
        days.append(
            {
                "date": plan.day.isoformat(),
                "name": short_date(plan.day),
                "slots": [] if plan.closed else [[slot.start, slot.end] for slot in plan.slots],
                "basis": plan.basis,
                "closed": plan.closed,
                "label": plan.label,
                "note": plan.note,
                "rain": {"chance": rain.chance, "mm": rain.mm} if rain else None,
                "hours": [[hour.hour, hour.chance, hour.mm] for hour in hours] if hours else None,
            }
        )
    return {
        "generated": now.isoformat(timespec="minutes"),
        "generatedText": _stamp(now),
        "zone": config.timezone_name,
        "site": config.site_url,
        "dayStart": config.day_start,
        "lightsOff": config.lights_off,
        # Set when the weather service did not answer and an earlier forecast stands in.
        "rainFrom": (forecast.saved_at or None) if forecast else None,
        "council": {
            "lastRead": store.last_read.isoformat() if store.last_read else None,
            "pageModified": store.page_modified.isoformat() if store.page_modified else None,
            "latestDay": store.latest_day.isoformat() if store.latest_day else None,
        },
        "days": days,
    }


def _day_words(plan: DayPlan) -> str:
    if plan.closed:
        return "Closed"
    if not plan.known:
        return "No information"
    if plan.slots:
        words = spans(plan.slots)
        return f"{words} ({plan.label})" if plan.label else words
    return plan.label or "No bookings"


def fallback(plans: list[DayPlan], now: datetime) -> str:
    """The plain version of the page, shown until the script has run (or if it cannot)."""
    today = plans[0]
    if today.closed:
        state, title = "closed", "Oval closed today"
    elif not today.known:
        state, title = "unknown", "No booking information today"
    elif today.slots:
        state, title = "unknown", ("Booked " if today.confirmed else "Usually booked ") + spans(today.slots) + " today"
    elif today.label:
        state, title = "unknown", f"{today.label} listed today"
    else:
        state, title = "free", "No bookings today" if today.confirmed else "Usually no bookings today"

    rows = "\n".join(
        f"        <li><strong>{escape(short_date(plan.day))}</strong>: {escape(_day_words(plan))}"
        + ("" if plan.confirmed or not plan.known else ' <span class="tag">usual</span>')
        + "</li>"
        for plan in plans[1:8]
    )
    sub = today.label if today.closed and today.label else today.note
    return (
        f'    <section class="hero" data-state="{state}">\n'
        f'      <p class="kicker">{escape(short_date(today.day))}, as of {escape(clock(now.hour * 60 + now.minute))}</p>\n'
        f"      <h1>{escape(title)}</h1>\n"
        f'      <p class="sub">{escape(sub)}</p>\n'
        f"    </section>\n"
        f'    <section class="card">\n'
        f"      <h2>The week ahead <span>booked times</span></h2>\n"
        f'      <ol class="plain-days">\n{rows}\n      </ol>\n'
        f"    </section>\n"
        f"    <noscript><p class=\"source\">Turn on JavaScript to see the live view and the rain forecast.</p></noscript>"
    )


def _actions(config: Config) -> str:
    lines = []
    if config.channel:
        lines.append(
            f'    <a class="button primary" href="{escape(config.channel_url)}" rel="noopener">'
            f"Get the daily alert on Telegram</a>"
        )
    row = ['      <button class="button" type="button" id="share">Share this page</button>']
    if config.tip_url:
        row.append(f'      <a class="button" href="{escape(config.tip_url)}" rel="noopener">Leave a tip</a>')
    lines.append('    <div class="button-row">\n' + "\n".join(row) + "\n    </div>")
    return "\n".join(lines)


def _fill(template: str, values: dict[str, str]) -> str:
    """Replace ``{{name}}`` markers in one pass, so text that was put in is never scanned again."""
    return re.sub(r"\{\{(\w+)\}\}", lambda match: values.get(match.group(1), match.group(0)), template)


def _brand(config: Config) -> str:
    """The page's own name above the park's, when it has one."""
    if not config.site_name:
        return ""
    return f'    <p class="brand"><img src="favicon.svg" width="26" height="26" alt="">{escape(config.site_name)}</p>'


def _manifest(config: Config) -> str:
    return json.dumps(
        {
            "name": f"{config.site_name}: {config.park_name}" if config.site_name else f"{config.park_name}: free for dogs?",
            "short_name": config.display_name,
            "description": f"Booked times and rain for the {config.park_name}, {config.suburb}.",
            "start_url": "./",
            "scope": "./",
            "display": "standalone",
            "background_color": "#f4f2ea",
            "theme_color": "#17693a",
            "icons": [
                {"src": "icon-192.png", "sizes": "192x192", "type": "image/png"},
                {"src": "icon-512.png", "sizes": "512x512", "type": "image/png"},
                {"src": "icon-maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable"},
            ],
        },
        indent=1,
    )


def build(
    config: Config,
    plans: list[DayPlan],
    forecast: Forecast | None,
    store: CouncilStore,
    now: datetime,
    out_dir: str | Path = "site",
    assets_dir: str | Path = "assets",
) -> Path:
    """Write the whole site into ``out_dir`` and return that folder."""
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)

    data = page_data(config, plans, forecast, store, now)
    if config.site_name:
        title = f"{config.site_name}: is the {config.park_name} free for dogs?"
    else:
        title = f"{config.park_name}: free for dogs right now?"
    description = (
        f"Is the {config.park_name} in {config.suburb} booked for sport today? "
        "Booked times, the week ahead and the chance of rain, for dog owners."
    )
    post_time = clock(((config.post_from + 30) // 60) * 60)  # "3 PM" for a window that opens at 2:30 PM
    common = {
        "title": escape(title),
        "description": escape(description),
        "site_url": escape(config.site_url),
        "park_name": escape(config.park_name),
        "park_short": escape(config.park_short),
        "short_name": escape(config.display_name),
        "suburb": escape(config.suburb),
        "council_url": escape(config.council_url),
    }

    page = _fill(
        (WEB / "index.html").read_text(encoding="utf-8"),
        {
            **common,
            "lights_off": escape(clock(config.lights_off)),
            "brand": _brand(config),
            "alert_paragraph": (
                f"      <p>A free alert goes out on Telegram at about {escape(post_time)} each day, in the "
                f'<a href="{escape(config.channel_url)}" rel="noopener">{escape(config.channel)}</a> channel.</p>'
                if config.channel
                else ""
            ),
            "repo_link": (
                f' <a href="{escape(config.repo_url)}" rel="noopener">How this page is made</a>.' if config.repo_url else ""
            ),
            "checked": escape(_stamp(now)),
            "actions": _actions(config),
            "fallback": fallback(plans, now),
            "css": (WEB / "page.css").read_text(encoding="utf-8"),
            # No "<" may appear inside the data block, or words from outside could end it early.
            "data": json.dumps(data, ensure_ascii=False, separators=(",", ":")).replace("<", "\\u003c"),
            "js": (WEB / "page.js").read_text(encoding="utf-8"),
        },
    )
    (out / "index.html").write_text(page, encoding="utf-8")
    (out / "data.json").write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")

    poster = _fill(
        (WEB / "poster.html").read_text(encoding="utf-8"),
        {
            **common,
            "site_address": escape(config.site_url.removeprefix("https://").rstrip("/")),
            "alert_point": escape(
                f"A free alert at about {post_time} each day on Telegram" if config.channel else "Free, with no sign-up"
            ),
            "unofficial": escape(
                f"{config.site_name} is an unofficial page run by a local dog owner."
                if config.site_name
                else "Unofficial page run by a local dog owner."
            ),
        },
    )
    (out / "poster.html").write_text(poster, encoding="utf-8")
    (out / "manifest.webmanifest").write_text(_manifest(config) + "\n", encoding="utf-8")
    # Tells GitHub Pages to serve the files as they are.
    (out / ".nojekyll").write_text("", encoding="utf-8")

    assets = Path(assets_dir)
    if assets.is_dir():
        for item in sorted(assets.iterdir()):
            if item.is_file() and item.name not in _PRIVATE_ASSETS:
                shutil.copyfile(item, out / item.name)
    return out

