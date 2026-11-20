"""What the checker remembers between runs.

Three small JSON files in ``data/``, saved back to the repository by the
scheduled job:

* ``council.json``: every day read from the council's page so far. If the
  page cannot be read on some run, the last good copy is still there.
* ``state.json``: when the last posts went out, how many times in a row each
  source has failed, and the addresses of the weather service's servers.
* ``forecast.json``: the last rain forecast that loaded, for a run on which
  the weather service does not answer.

The repository is public, so nothing private may ever be written here.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from pathlib import Path

from .council import Closure, CouncilPage, DayEntry
from .fetch import is_public
from .timeparse import Slot

# Days older than this are dropped from council.json to keep it small.
_KEEP_DAYS = 400
# An address of the weather service is forgotten when it has not answered for this
# many days, and no more than this many are kept.
_ADDRESS_DAYS = 30
_ADDRESS_LIMIT = 6


def _read_json(path: Path) -> dict:
    try:
        with open(path, encoding="utf-8") as handle:
            data = json.load(handle)
    except (FileNotFoundError, json.JSONDecodeError, UnicodeDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def _write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(data, indent=1, sort_keys=True, ensure_ascii=False) + "\n"
    if path.exists() and path.read_text(encoding="utf-8") == text:
        return  # leave the file alone so the job has nothing to commit
    path.write_text(text, encoding="utf-8")


def _date(value: object) -> date | None:
    try:
        return date.fromisoformat(str(value))
    except ValueError:
        return None


@dataclass
class CouncilStore:
    """Every day the council's page has shown us."""

    days: dict[date, DayEntry] = field(default_factory=dict)
    closures: list[Closure] = field(default_factory=list)
    last_read: date | None = None  # the last day the page was read successfully
    # The moment of that read, in local time with its time zone. The public page shows it
    # as "Last checked". None if the page was last read before this was recorded.
    last_read_at: datetime | None = None
    page_modified: date | None = None  # the page's own "last updated" date

    @classmethod
    def load(cls, path: str | Path) -> CouncilStore:
        raw = _read_json(Path(path))
        store = cls(last_read=_date(raw.get("last_read")), page_modified=_date(raw.get("page_modified")))
        try:
            read_at = datetime.fromisoformat(str(raw.get("last_read_at")))
        except ValueError:
            read_at = None
        # Only a time that names its zone, and that agrees with the day beside it, is believed.
        if read_at is not None and read_at.tzinfo is not None and read_at.date() == store.last_read:
            store.last_read_at = read_at
        for key, value in (raw.get("days") or {}).items():
            day = _date(key)
            if day is None or not isinstance(value, dict):
                continue
            try:
                slots = tuple(Slot.from_text(text) for text in value.get("slots", []))
            except (ValueError, TypeError):
                continue
            store.days[day] = DayEntry(slots, str(value.get("label", "")))
        for value in raw.get("closures") or []:
            try:
                store.closures.append(
                    Closure(
                        datetime.fromisoformat(value["start"]),
                        datetime.fromisoformat(value["end"]),
                        str(value.get("text", "")),
                    )
                )
            except (KeyError, TypeError, ValueError):
                continue
        return store

    def save(self, path: str | Path) -> None:
        days = {}
        for day in sorted(self.days):
            entry = self.days[day]
            item: dict[str, object] = {}
            if entry.slots:
                item["slots"] = [slot.to_text() for slot in entry.slots]
            if entry.label:
                item["label"] = entry.label
            days[day.isoformat()] = item
        _write_json(
            Path(path),
            {
                "about": "Bookings read from the council's Citizens Park page. Written by the daily job; do not edit.",
                "last_read": self.last_read.isoformat() if self.last_read else None,
                "last_read_at": self.last_read_at.isoformat(timespec="minutes") if self.last_read_at else None,
                "page_modified": self.page_modified.isoformat() if self.page_modified else None,
                "closures": [
                    {"start": closure.start.isoformat(), "end": closure.end.isoformat(), "text": closure.text}
                    for closure in self.closures
                ],
                "days": days,
            },
        )

    def update(self, page: CouncilPage, today: date, at: datetime | None = None) -> None:
        """Take in a fresh read of the page, made on ``today`` (at the moment ``at``, if known)."""
        if page.days:
            first, last = min(page.days), max(page.days)
            # Whatever the page now shows for its date range replaces what we held,
            # so a booking the council removed disappears here too.
            self.days = {day: entry for day, entry in self.days.items() if not first <= day <= last}
            self.days.update(page.days)
        cutoff = today - timedelta(days=_KEEP_DAYS)
        self.days = {day: entry for day, entry in self.days.items() if day >= cutoff}
        self.closures = list(page.closures)
        self.last_read = today
        self.last_read_at = at
        self.page_modified = page.modified.date() if page.modified else self.page_modified

    @property
    def latest_day(self) -> date | None:
        return max(self.days) if self.days else None


@dataclass
class State:
    """Small facts carried from one run to the next."""

    last_daily_post: date | None = None
    last_weekly_post: date | None = None
    council_failures: int = 0  # runs in a row that could not read the council page
    council_error: str = ""
    weather_failures: int = 0
    weather_error: str = ""
    telegram_error: str = ""
    uncovered_since: date | None = None  # first day in the current run of days the council page did not cover
    # The addresses the weather service has answered from, and the day each one last
    # did. The service has more than one server. When the one its name leads to says
    # nothing, the forecast is asked for at another of these (see fetch.get).
    weather_addresses: dict[str, date] = field(default_factory=dict)

    @classmethod
    def load(cls, path: str | Path) -> State:
        raw = _read_json(Path(path))

        def count(key: str) -> int:
            try:
                return max(0, int(raw.get(key, 0)))
            except (TypeError, ValueError):
                return 0

        addresses: dict[str, date] = {}
        listed = raw.get("weather_addresses")
        for address, value in listed.items() if isinstance(listed, dict) else ():
            seen = _date(value)
            if seen and is_public(address):
                addresses[address] = seen
        return cls(
            last_daily_post=_date(raw.get("last_daily_post")),
            last_weekly_post=_date(raw.get("last_weekly_post")),
            council_failures=count("council_failures"),
            council_error=str(raw.get("council_error") or ""),
            weather_failures=count("weather_failures"),
            weather_error=str(raw.get("weather_error") or ""),
            telegram_error=str(raw.get("telegram_error") or ""),
            uncovered_since=_date(raw.get("uncovered_since")),
            weather_addresses=addresses,
        )

    def save(self, path: str | Path) -> None:
        def iso(value: date | None) -> str | None:
            return value.isoformat() if value else None

        _write_json(
            Path(path),
            {
                "about": "Written by the daily job; do not edit.",
                "last_daily_post": iso(self.last_daily_post),
                "last_weekly_post": iso(self.last_weekly_post),
                "council_failures": self.council_failures,
                "council_error": self.council_error,
                "weather_failures": self.weather_failures,
                "weather_error": self.weather_error,
                "telegram_error": self.telegram_error,
                "uncovered_since": iso(self.uncovered_since),
                "weather_addresses": {address: seen.isoformat() for address, seen in self.weather_addresses.items()},
            },
        )

    def weather_servers(self) -> list[str]:
        """The weather service's known addresses, the one seen most recently first."""
        return sorted(self.weather_addresses, key=lambda address: (-self.weather_addresses[address].toordinal(), address))

    def saw_weather_servers(self, addresses: list[str], today: date) -> None:
        """Note that the weather service answered from these addresses today, and forget the stale ones."""
        for address in addresses:
            if is_public(address):
                self.weather_addresses[address] = today
        cutoff = today - timedelta(days=_ADDRESS_DAYS)
        keep = [address for address in self.weather_servers() if self.weather_addresses[address] >= cutoff]
        self.weather_addresses = {address: self.weather_addresses[address] for address in keep[:_ADDRESS_LIMIT]}


@dataclass
class ForecastCopy:
    """The last forecast that arrived, kept for a run when the weather service does not answer."""

    fetched: datetime | None = None  # local time, with its time zone
    reply: str = ""  # the weather service's reply, exactly as it came

    @classmethod
    def load(cls, path: str | Path) -> ForecastCopy:
        raw = _read_json(Path(path))
        try:
            fetched = datetime.fromisoformat(str(raw.get("fetched")))
        except ValueError:
            return cls()
        reply = raw.get("reply")
        if fetched.tzinfo is None or not isinstance(reply, str) or not reply:
            return cls()
        return cls(fetched, reply)

    def save(self, path: str | Path) -> None:
        _write_json(
            Path(path),
            {
                "about": "The last rain forecast that loaded, as Open-Meteo sent it. Written by the daily job; do not edit.",
                "fetched": self.fetched.isoformat(timespec="minutes") if self.fetched else None,
                "reply": self.reply,
            },
        )
