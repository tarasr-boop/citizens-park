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
# The least rain the forecast reports for an hour. An hour with less, and with
# rain not likely either, counts as dry.
TRACE_MM = 0.1
# When no hour is dry, hours within this much of the lightest one are as good as it.
_MUCH_THE_SAME_MM = 0.2
# A stretch shorter than this many minutes is not worth going out for.
_SHORTEST_WINDOW = 30

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


@dataclass(frozen=True)
class Window:
    """A stretch of the day that suits a walk in rainy weather."""

    start: int  # minutes after midnight
    end: int
    dry: bool  # False when rain is expected in it too, only less than at other times


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
        # The service's own words: kept short and on one line, wherever they end up.
        reason = " ".join(str(reason).split())[:200] if reason else ""
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


def is_dry(hour: HourRain) -> bool:
    """No measurable rain is forecast for the hour, and rain is not likely."""
    return (hour.mm or 0.0) < TRACE_MM and (hour.chance or 0) < LIKELY


def best_window(hours: list[HourRain] | None, free: list[tuple[int, int]], first_minute: int, last_minute: int) -> Window | None:
    """The best part of ``free`` for staying out of the rain between two times of the day.

    ``free`` holds the periods to choose from as (start, end) pairs, in minutes
    after midnight and in order. The answer is the longest dry stretch in them.
    If none of them is dry, it is the stretch with the lightest rain.

    Returns None when there is nothing to say: no rain is forecast between the
    two times (then any time is as good as another), the forecast does not
    cover them, or no stretch of ``free`` is long enough.
    """
    if not hours or first_minute >= last_minute:
        return None
    by_hour = {hour.hour: hour for hour in hours}
    covered = [by_hour.get(number) for number in range(first_minute // 60, (last_minute - 1) // 60 + 1)]
    if any(hour is None or (hour.mm is None and hour.chance is None) for hour in covered):
        return None
    if all(is_dry(hour) for hour in covered):
        return None

    # Cut the free time into pieces, one for each hour of the forecast.
    pieces: list[tuple[int, int, HourRain]] = []
    for start, end in free:
        start, end = max(start, first_minute), min(end, last_minute)
        for number in range(start // 60, (end - 1) // 60 + 1) if start < end else ():
            pieces.append((max(start, number * 60), min(end, (number + 1) * 60), by_hour[number]))
    if not pieces:
        return None

    def stretches(good) -> list[tuple[int, int, float]]:
        """Runs of neighbouring pieces that pass ``good``, as (start, end, rain in mm)."""
        found: list[list[tuple[int, int, HourRain]]] = []
        for piece in pieces:
            if not good(piece[2]):
                continue
            if found and found[-1][-1][1] == piece[0]:
                found[-1].append(piece)
            else:
                found.append([piece])
        return [
            (run[0][0], run[-1][1], sum(hour.mm or 0.0 for _, _, hour in run))
            for run in found
            if run[-1][1] - run[0][0] >= _SHORTEST_WINDOW
        ]

    def longest(found: list[tuple[int, int, float]]) -> tuple[int, int, float]:
        # The longest wins. Between equals, the one with less rain, and then the earlier one.
        return max(found, key=lambda stretch: (stretch[1] - stretch[0], -stretch[2], -stretch[0]))

    dry = stretches(is_dry)
    if dry:
        start, end, _ = longest(dry)
        return Window(start, end, True)

    lightest = min(hour.mm or 0.0 for _, _, hour in pieces)
    # The tiny extra keeps the comparison from tripping over how decimals are stored.
    light = stretches(lambda hour: (hour.mm or 0.0) <= lightest + _MUCH_THE_SAME_MM + 1e-9)
    if not light:
        return None
    start, end, _ = longest(light)
    return Window(start, end, False)
