"""Rain outlook from Open-Meteo (https://open-meteo.com), which needs no key.

Open-Meteo's terms allow free use by non-commercial projects and ask for a
visible credit, "Weather data by Open-Meteo.com", next to the data.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from urllib.parse import urlencode

from .timeparse import clock

API = "https://api.open-meteo.com/v1/forecast"

# An hour counts as "rain likely" from this chance upwards.
LIKELY = 50
# Below this chance the hour is treated as dry.
SLIGHT = 20
# The outlook looks ahead until this hour of the evening (9 PM, so through 9:59 PM).
LAST_HOUR = 21

_ONE_HOUR = timedelta(hours=1)


class WeatherError(Exception):
    """The forecast could not be understood."""


@dataclass(frozen=True)
class HourRain:
    hour: int  # the hour this covers, 0 to 23: 15 means 3:00 to 3:59 PM
    chance: int | None  # percent
    mm: float | None


@dataclass(frozen=True)
class DayRain:
    chance: int | None  # the day's highest hourly chance, percent
    mm: float | None  # the day's total


@dataclass
class Forecast:
    hours: dict[date, list[HourRain]] = field(default_factory=dict)
    days: dict[date, DayRain] = field(default_factory=dict)
    # Set when this is an earlier forecast standing in for one that would not load:
    # the words to show people, such as "11:50 AM" or "9 PM yesterday".
    saved_at: str = ""


@dataclass(frozen=True)
class Outlook:
    """Rain for the rest of one day, in a sentence."""

    level: str  # "dry", "slight", "likely" or "unknown"
    text: str
    chance: int | None = None
    mm: float | None = None


def url(latitude: float, longitude: float, timezone_name: str, days: int = 8) -> str:
    query = urlencode(
        {
            "latitude": f"{latitude:.4f}",
            "longitude": f"{longitude:.4f}",
            "hourly": "precipitation_probability,precipitation",
            "daily": "precipitation_probability_max,precipitation_sum",
            "timezone": timezone_name,
            "forecast_days": days,
        }
    )
    return f"{API}?{query}"


def _number(value: object) -> float | None:
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def parse(text: str) -> Forecast:
    """Read Open-Meteo's JSON reply."""
    try:
        payload = json.loads(text)
    except json.JSONDecodeError as error:
        raise WeatherError(f"the forecast is not valid JSON: {error}") from error
    if not isinstance(payload, dict) or payload.get("error"):
        reason = payload.get("reason") if isinstance(payload, dict) else None
        raise WeatherError(f"the forecast service reported a problem: {reason or 'no reason given'}")

    hourly = payload.get("hourly")
    if not isinstance(hourly, dict) or not isinstance(hourly.get("time"), list):
        raise WeatherError("the forecast has no hourly data")
    times = hourly["time"]
    chances = hourly.get("precipitation_probability") or [None] * len(times)
    amounts = hourly.get("precipitation") or [None] * len(times)
    if not (len(times) == len(chances) == len(amounts)):
        raise WeatherError("the forecast's hourly lists differ in length")

    # Open-Meteo stamps each value with the END of its hour: the value at 16:00
    # is the rain that fell between 15:00 and 16:00. So the value stamped 16:00
    # describes the hour that people call "3 PM".
    stamped: dict[datetime, tuple[float | None, float | None]] = {}
    for stamp, chance, amount in zip(times, chances, amounts, strict=True):
        try:
            moment = datetime.fromisoformat(str(stamp))
        except ValueError as error:
            raise WeatherError(f"unexpected time in the forecast: {stamp!r}") from error
        stamped[moment] = (_number(chance), _number(amount))

    forecast = Forecast()
    for moment in sorted(stamped):
        chance, amount = stamped[moment]
        begins = moment.replace(minute=0) - _ONE_HOUR
        hour = HourRain(begins.hour, None if chance is None else round(chance), amount)
        forecast.hours.setdefault(begins.date(), []).append(hour)
    # The first stamp (midnight) describes the last hour of the day before: drop that stray day.
    if times:
        first_day = datetime.fromisoformat(str(times[0])).date()
        for day in [day for day in forecast.hours if day < first_day]:
            del forecast.hours[day]

    daily = payload.get("daily")
    if isinstance(daily, dict) and isinstance(daily.get("time"), list):
        day_chances = daily.get("precipitation_probability_max") or []
        day_amounts = daily.get("precipitation_sum") or []
        for index, stamp in enumerate(daily["time"]):
            try:
                day = date.fromisoformat(str(stamp))
            except ValueError:
                continue
            chance = _number(day_chances[index]) if index < len(day_chances) else None
            amount = _number(day_amounts[index]) if index < len(day_amounts) else None
            forecast.days[day] = DayRain(None if chance is None else round(chance), amount)

    # Fill in any day the daily list missed from the hourly values.
    for day, hours in forecast.hours.items():
        if day not in forecast.days:
            forecast.days[day] = summarise_day(hours)
    if not forecast.hours:
        raise WeatherError("the forecast has no hourly data")
    return forecast


def summarise_day(hours: list[HourRain]) -> DayRain:
    chances = [hour.chance for hour in hours if hour.chance is not None]
    amounts = [hour.mm for hour in hours if hour.mm is not None]
    return DayRain(max(chances) if chances else None, round(sum(amounts), 1) if amounts else None)


def amount_text(mm: float | None) -> str:
    """``about 3 mm`` or ``under 1 mm``. Empty when unknown or nothing."""
    if mm is None or mm < 0.05:
        return ""
    if mm < 0.75:
        return "under 1 mm"
    return f"about {round(mm)} mm"


def total_mm(hours: list[HourRain], first_hour: int = 0, last_hour: int = 23) -> float:
    return sum(hour.mm or 0.0 for hour in hours if first_hour <= hour.hour <= last_hour)


def outlook(hours: list[HourRain] | None, now_minute: int, last_hour: int = LAST_HOUR) -> Outlook:
    """Rain from now until the evening, as one sentence."""
    now_hour = now_minute // 60
    ahead = [hour for hour in (hours or []) if now_hour <= hour.hour <= last_hour and hour.chance is not None]
    if not ahead:
        return Outlook("unknown", "No rain forecast available.")

    peak = max(ahead, key=lambda hour: (hour.chance, -hour.hour))
    chance = peak.chance or 0
    mm = round(sum(hour.mm or 0.0 for hour in ahead), 1)
    amount = amount_text(mm)

    if chance < SLIGHT:
        return Outlook("dry", "No rain expected for the rest of today.", chance, mm)
    if chance < LIKELY:
        return Outlook("slight", f"Slight chance of rain ({chance}% around {clock(peak.hour * 60)}).", chance, mm)

    # Group the likely hours into runs and describe the first one.
    runs: list[list[int]] = []
    for hour in ahead:
        if (hour.chance or 0) >= LIKELY:
            if runs and runs[-1][-1] == hour.hour - 1:
                runs[-1].append(hour.hour)
            else:
                runs.append([hour.hour])
    first, last = runs[0][0], runs[0][-1]
    starts_now = first <= now_hour
    runs_out = last >= ahead[-1].hour
    if starts_now and runs_out:
        when = "for the rest of today"
    elif starts_now:
        when = f"until about {clock((last + 1) * 60)}"
    elif runs_out:
        when = f"from about {clock(first * 60)}"
    else:
        when = f"between {clock(first * 60)} and {clock((last + 1) * 60)}"
    detail = f"up to {chance}%" + (f", {amount}" if amount else "")
    text = f"Rain likely {when} ({detail})."
    if len(runs) > 1:
        text += f" More from about {clock(runs[1][0] * 60)}."
    return Outlook("likely", text, chance, mm)
