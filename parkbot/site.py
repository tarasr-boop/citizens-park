"""Build the public web page.

The page is one self-contained HTML file. It carries the next few days of
bookings and rain as JSON, and a small script draws the answer for "right
now". The same information is also written into the page as plain text, so
it still reads sensibly with scripts switched off.
"""

from __future__ import annotations

import base64
import hashlib
import json
import re
import shutil
from datetime import datetime
from html import escape
from pathlib import Path
from urllib.parse import quote, urlsplit

from . import bot, message
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
# The script that shows a notification on a phone. It is a file of its own
# because a browser keeps it running in the background, apart from the page.
_WORKER = "sw.js"


def _stamp(now: datetime) -> str:
    """``Fri 20 Nov, 2:41 PM``"""
    return f"{short_date(now.date())}, {clock(now.hour * 60 + now.minute)}"


def _read_at(config: Config, store: CouncilStore) -> datetime | None:
    """The moment the council's page was last read, in the park's own time."""
    return store.last_read_at.astimezone(config.zone) if store.last_read_at else None


def checked_text(config: Config, store: CouncilStore) -> str:
    """When the council's page was last read, for the page's "Last checked" line.

    ``Fri 20 Nov, 2:41 PM``, or only the day if the time was not recorded. Empty
    if the page has never been read.
    """
    read_at = _read_at(config, store)
    if read_at:
        return _stamp(read_at)
    return short_date(store.last_read) if store.last_read else ""


def page_data(config: Config, plans: list[DayPlan], forecast: Forecast | None, store: CouncilStore, now: datetime) -> dict:
    """Everything the page's script needs."""
    read_at = _read_at(config, store)
    now_minute = now.hour * 60 + now.minute
    days = []
    for index, plan in enumerate(plans):
        rain = forecast.days.get(plan.day) if forecast else None
        hours = forecast.hours.get(plan.day) if forecast and index < _HOURLY_DAYS else None
        # The notification for this day, in words for the time the alert goes out.
        # Every coming day has one, so that the alert has something true to say
        # even on a day when no check ran before it. For today it never looks back
        # at a time that has already passed.
        today = plan.day == now.date()
        opens = config.alert_from(plan.day)
        written_for = max(now_minute, opens) if today else opens
        saved_at = forecast.saved_at if forecast and today else ""
        days.append(
            {
                "date": plan.day.isoformat(),
                "name": short_date(plan.day),
                "slots": [] if plan.closed else [[slot.start, slot.end] for slot in plan.slots],
                "basis": plan.basis,
                "closed": plan.closed,
                "label": plan.label,
                "why": plan.why,
                "rain": {"chance": rain.chance, "mm": rain.mm} if rain else None,
                "hours": [[hour.hour, hour.chance, hour.mm] for hour in hours] if hours else None,
                "notice": message.notice(plan, forecast, written_for, config, saved_at),
            }
        )
    return {
        "generated": now.isoformat(timespec="minutes"),
        "generatedText": _stamp(now),
        "zone": config.timezone_name,
        "site": config.site_url,
        # When the daily alert goes out, in minutes after midnight: from Monday to
        # Friday, on Saturday and Sunday, and the time after which it is left out.
        "alert": {"weekdays": config.alert_weekdays, "weekends": config.alert_weekends, "until": config.alert_until},
        # The notifications backend. None while there is none, and then the page offers no notifications.
        "push": config.push_url or None,
        # The timeline on the page runs from dayStart to dayEnd.
        "dayStart": config.day_start,
        "dayEnd": config.day_end,
        "lightsOff": config.lights_off,
        # Set when the weather service did not answer and an earlier forecast stands in.
        "rainFrom": (forecast.saved_at or None) if forecast else None,
        "council": {
            "url": config.council_url,
            "lastRead": store.last_read.isoformat() if store.last_read else None,
            # The page shows this as "Last checked": the last time the council's page was
            # actually read, which is not always the time this page was built.
            "lastReadAt": read_at.isoformat(timespec="minutes") if read_at else None,
            "lastReadText": checked_text(config, store) or None,
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


def fallback(plans: list[DayPlan], checked: str = "") -> str:
    """The plain version of the page, shown until the script has run (or if it cannot).

    ``checked`` is when the council's page was last read, such as ``Fri 20 Nov, 2:41 PM``.
    """
    today = plans[0]
    if today.closed:
        state, title = "closed", "Closed today"
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
    kicker = f"Last checked {checked}" if checked else short_date(today.day)
    return (
        f'    <section class="hero" data-state="{state}">\n'
        f'      <p class="kicker">{escape(kicker)}</p>\n'
        f"      <h1>{escape(title)}</h1>\n"
        f'      <p class="sub">{escape(sub)}</p>\n'
        f"    </section>\n"
        f'    <section class="card">\n'
        f"      <h2>The week ahead <span>booked times</span></h2>\n"
        f'      <ol class="plain-days">\n{rows}\n      </ol>\n'
        f"    </section>\n"
        f"    <noscript><p class=\"source\">Turn on JavaScript to see the live view and the rain forecast.</p></noscript>"
    )


def _about(config: Config) -> str:
    """The "About me" block: a few words from whoever runs the page, and one link. Left out while there are no words."""
    if not config.about_text:
        return ""
    lines = [
        '  <section class="card about">',
        f"    <h2>{escape(config.about_heading)}</h2>",
        f"    <p>{escape(config.about_text)}</p>",
    ]
    if config.about_link:
        lines.append(
            f'    <p class="about-link"><a href="{escape(config.about_link)}" rel="noopener">{escape(config.about_link_text)}</a></p>'
        )
    return "\n".join(lines + ["  </section>"])


def _actions(config: Config) -> str:
    """The buttons: notifications, the Telegram channel and the tip link. Each appears only when it is set."""
    buttons = []
    if config.push_url:
        # Hidden until the page's script finds that this browser can show notifications.
        # The line under the button is where the script says what happened.
        buttons.append('    <button class="button primary" type="button" id="notify" hidden>Get alerts on this device</button>')
        buttons.append('    <p class="notify-note" id="notify-note" role="status" hidden></p>')
    if config.bot_name:
        # A chat with the bot, where people pick their own times.
        buttons.append(f'    <a class="button" href="{escape(config.bot_url)}" rel="noopener">Get custom alerts on Telegram</a>')
    elif config.channel:
        buttons.append(f'    <a class="button" href="{escape(config.channel_url)}" rel="noopener">Get alerts on Telegram</a>')
    if config.tip_url:
        buttons.append(f'    <a class="button" href="{escape(config.tip_url)}" rel="noopener">Leave a tip</a>')
    if not buttons:
        return ""
    return '  <nav class="actions" aria-label="Alerts and tips">\n' + "\n".join(buttons) + "\n  </nav>"


def alert_times(config: Config) -> str:
    """When the alert goes out, in words: ``4 PM on weekdays and 8 AM on weekends``, or ``4 PM`` if the two are the same.

    The page's script (page.js) and the alerts backend (rules.js) say it the same way.
    """
    if config.alert_weekdays == config.alert_weekends:
        return clock(config.alert_weekdays)
    return f"{clock(config.alert_weekdays)} on weekdays and {clock(config.alert_weekends)} on weekends"


def _alert_paragraph(config: Config) -> str:
    """The line in "How this works" about the daily alert: when it goes out, and the ways to get it that are set up."""
    ways = []
    if config.push_url:
        ways.append("as a notification from this page")
    if config.channel:
        link = f'<a href="{escape(config.channel_url)}" rel="noopener">{escape(config.channel)}</a>'
        ways.append(f"in the {link} channel on Telegram")
    if not ways:
        return ""
    return f"      <p>A free alert goes out once a day, at about {escape(alert_times(config))}, {' and '.join(ways)}.</p>"


def _feedback(config: Config) -> str:
    """A button at the end of "How this works" that opens an email to whoever runs the page. Left out while no address is set."""
    if not config.feedback_email:
        return ""
    address = f"mailto:{config.feedback_email}?subject={quote(config.display_name + ' feedback')}"
    return f'      <a class="button" href="{escape(address)}">Please share feedback</a>'


def _origin(address: str) -> str:
    """``https://alerts.example.org/anything`` gives ``https://alerts.example.org``."""
    parts = urlsplit(address)
    return f"{parts.scheme}://{parts.netloc}"


def _allowed(script: str, push_url: str = "") -> str:
    """The page's rules for its browser (a Content Security Policy).

    Only the page's own script may run, recognised by its fingerprint. So even if
    words from outside ever slipped past the escaping, they could not run as code.

    With notifications switched on, the page may also talk to their backend and
    start the small script beside it that shows a notification. Nothing else.
    """
    fingerprint = base64.b64encode(hashlib.sha256(script.encode("utf-8")).digest()).decode("ascii")
    rules = [
        "default-src 'none'",
        f"script-src 'sha256-{fingerprint}'",
        "style-src 'unsafe-inline'",
        "img-src 'self'",
        "connect-src 'self'" + (f" {_origin(push_url)}" if push_url else ""),
        "manifest-src 'self'",
    ]
    if push_url:
        rules.append("worker-src 'self'")
    return "; ".join(rules + ["base-uri 'none'", "form-action 'none'"])


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
        "Booked times, the week ahead and the rain forecast, for dog owners."
    )
    template = (WEB / "index.html").read_text(encoding="utf-8")
    # The script as it will sit in the page, between its tags, line breaks included.
    script = (WEB / "page.js").read_text(encoding="utf-8")
    in_page = re.search(r"<script>(\s*)\{\{js\}\}(\s*)</script>", template)
    if in_page is None:
        raise ValueError("index.html has no place for the page's script")

    page = _fill(
        template,
        {
            "title": escape(title),
            "description": escape(description),
            "site_url": escape(config.site_url),
            "park_name": escape(config.park_name),
            "park_short": escape(config.park_short),
            "short_name": escape(config.display_name),
            "suburb": escape(config.suburb),
            "council_url": escape(config.council_url),
            "allowed": escape(_allowed(in_page.group(1) + script + in_page.group(2), config.push_url)),
            "lights_off": escape(clock(config.lights_off)),
            "brand": _brand(config),
            "alert_paragraph": _alert_paragraph(config),
            "repo_link": (
                f' <a href="{escape(config.repo_url)}" rel="noopener">How this page is made</a>.' if config.repo_url else ""
            ),
            "feedback": _feedback(config),
            "about": _about(config),
            "actions": _actions(config),
            "fallback": fallback(plans, checked_text(config, store)),
            "css": (WEB / "page.css").read_text(encoding="utf-8"),
            # No "<" may appear inside the data block, or words from outside could end it early.
            "data": json.dumps(data, ensure_ascii=False, separators=(",", ":")).replace("<", "\\u003c"),
            "js": script,
        },
    )
    (out / "index.html").write_text(page, encoding="utf-8")
    (out / "data.json").write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    # The words of the Telegram bot's custom alerts, for every hour people can pick (see bot.py).
    alerts = bot.alerts(config, plans, forecast, now)
    (out / bot.FILE).write_text(json.dumps(alerts, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    (out / "manifest.webmanifest").write_text(_manifest(config) + "\n", encoding="utf-8")
    # Tells GitHub Pages to serve the files as they are.
    (out / ".nojekyll").write_text("", encoding="utf-8")
    if config.push_url:
        shutil.copyfile(WEB / _WORKER, out / _WORKER)
    else:
        # Without a backend there are no notifications, and nothing is left over from a time there was one.
        (out / _WORKER).unlink(missing_ok=True)

    assets = Path(assets_dir)
    if assets.is_dir():
        for item in sorted(assets.iterdir()):
            if item.is_file() and item.name not in _PRIVATE_ASSETS:
                shutil.copyfile(item, out / item.name)
    return out

