"""Read the council's Citizens Park page.

The page holds one table per month. Each table has a heading such as
"November 2026", a header row with the weekdays (Monday to Sunday) and one row
per calendar week. A cell holds the day of the month followed by the booked
time, for example ``1 11:00am-5:00pm``, or words such as ``No Bookings`` or
``Maintenance``. Days that belong to the month before or after are written
with their month: ``27 (October)``. A real table from the page is kept in
``tests/fixtures/council_november_2026.html``.

Nothing here trusts the page's exact markup. The reader looks for any table
whose header row names the weekdays, then checks every day number against the
real calendar: the 1st of October 2026 must sit in the Thursday column. If
the table does not fit the calendar, the page is rejected, and the rest of
the program falls back to the usual weekly pattern.
"""

from __future__ import annotations

import calendar
import re
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, tzinfo
from html.parser import HTMLParser

from .timeparse import Slot, find_slots

MONTHS = {name.lower(): number for number, name in enumerate(calendar.month_name) if name}
MONTHS.update({name.lower(): number for number, name in enumerate(calendar.month_abbr) if name})
MONTHS["sept"] = 9

WEEKDAYS = {
    "mon": 0, "monday": 0,
    "tue": 1, "tues": 1, "tuesday": 1,
    "wed": 2, "weds": 2, "wednesday": 2,
    "thu": 3, "thur": 3, "thurs": 3, "thursday": 3,
    "fri": 4, "friday": 4,
    "sat": 5, "saturday": 5,
    "sun": 6, "sunday": 6,
}  # fmt: skip

_MONTH_NAMES = "|".join(sorted(MONTHS, key=len, reverse=True))
_MONTH_RE = re.compile(rf"\b({_MONTH_NAMES})\b\.?(?:\s+(\d{{4}}))?", re.IGNORECASE)

# A day of the month at the start of a cell. "4pm-5pm" and "10:00am" are times, not days.
_DAY_RE = re.compile(
    r"^\s*(\d{1,2})(?:\s?(?:st|nd|rd|th)\b)?(?!\d|[:.]\d|\s*[ap]\.?m\b)[\s.:,\-–—]*",
    re.IGNORECASE,
)

# A month named straight after the day number, as the council writes the days that
# belong to the month before or after: "27 (October)". Without brackets it only
# counts when nothing but a time follows, so "1 May be closed" keeps its words.
_CELL_MONTH_RE = re.compile(
    rf"^\s*(?:[(\[]\s*({_MONTH_NAMES})\.?\s*[)\]]|({_MONTH_NAMES})\b\.?(?=\s*(?:$|\d|[,:;\-–—])))[\s,:;\-–—]*",
    re.IGNORECASE,
)

# Words that mean "nothing is booked", which is good news rather than a label to show.
_NO_BOOKING_RE = re.compile(
    r"^\W*(?:no\s+(?:bookings?|booking\s+today|training|sessions?|hire|events?|sport)|not\s+booked|nothing\s+booked|"
    r"none|nil|unbooked)\W*$",
    re.IGNORECASE,
)

_BLOCK_TAGS = {
    "address", "article", "aside", "blockquote", "caption", "dd", "div", "dl", "dt",
    "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header",
    "hr", "li", "main", "nav", "ol", "p", "pre", "section", "table", "tbody", "td", "tfoot",
    "th", "thead", "tr", "ul",
}  # fmt: skip
_HEADINGS = {"h1", "h2", "h3", "h4", "h5", "h6"}
_SKIP_TAGS = {"script", "style", "noscript", "template", "title", "svg", "select"}


class CouncilPageError(Exception):
    """The page was fetched but no usable booking table was found in it."""


@dataclass(frozen=True)
class DayEntry:
    """What the council lists for one day."""

    slots: tuple[Slot, ...] = ()
    label: str = ""  # words in the cell that are not times, such as "Maintenance"


@dataclass(frozen=True)
class Closure:
    """A period when the council says the oval is closed, from a notice on the page."""

    start: datetime  # local time, no time zone attached
    end: datetime
    text: str


@dataclass
class CouncilPage:
    """Everything read from one fetch of the page."""

    days: dict[date, DayEntry] = field(default_factory=dict)
    months: list[tuple[int, int]] = field(default_factory=list)  # (year, month) of each table
    modified: datetime | None = None  # local time, no time zone attached
    closures: list[Closure] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


# --------------------------------------------------------------------------
# Step 1: pull the tables and the text around them out of the HTML
# --------------------------------------------------------------------------


@dataclass
class _Cell:
    text: str = ""
    span: int = 1


@dataclass
class _Table:
    rows: list[list[_Cell]] = field(default_factory=list)
    caption: str = ""


@dataclass
class _Text:
    tag: str
    words: str


class _Extractor(HTMLParser):
    """Walk the page once, keeping text blocks and tables in the order they appear."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.items: list[_Text | _Table] = []
        self.meta: dict[str, str] = {}
        self._buffer: list[str] = []
        self._heading: str | None = None
        self._skip = 0
        self._table: _Table | None = None
        self._table_depth = 0
        self._row: list[_Cell] | None = None
        self._cell: _Cell | None = None
        self._cell_text: list[str] = []
        self._in_caption = False

    # -- helpers --

    def _flush_text(self) -> None:
        words = " ".join("".join(self._buffer).split())
        self._buffer = []
        if not words:
            return
        if self._in_caption and self._table is not None:
            self._table.caption = (self._table.caption + " " + words).strip()
        else:
            self.items.append(_Text(self._heading or "p", words))

    def _close_cell(self) -> None:
        if self._cell is not None and self._row is not None:
            self._cell.text = " ".join("".join(self._cell_text).split())
            self._row.append(self._cell)
        self._cell = None
        self._cell_text = []

    def _close_row(self) -> None:
        self._close_cell()
        if self._row and self._table is not None:
            self._table.rows.append(self._row)
        self._row = None

    # -- parser callbacks --

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag == "meta":
            found = {key: (value or "") for key, value in attrs}
            name = (found.get("property") or found.get("name") or found.get("itemprop") or "").lower()
            if name and "content" in found:
                self.meta.setdefault(name, found["content"])
            return
        if tag in _SKIP_TAGS:
            self._skip += 1
            return
        if self._skip:
            return

        if tag == "table":
            if self._table is None:
                self._flush_text()
                self._table = _Table()
                self._table_depth = 1
                self.items.append(self._table)
            else:
                self._table_depth += 1  # a table inside a cell: its words join that cell
            return

        if self._table is not None:
            if self._table_depth == 1:
                if tag == "caption":
                    self._in_caption = True
                elif tag == "tr":
                    self._close_row()
                    self._row = []
                elif tag in ("td", "th"):
                    self._close_cell()
                    if self._row is None:
                        self._row = []
                    span = dict(attrs).get("colspan") or "1"
                    self._cell = _Cell(span=min(max(1, int(span)), 7) if span.isdigit() else 1)
            # Any tag inside a cell separates words: "<b>1</b>5:15pm" is day 1, not 15:15pm.
            if self._cell is not None:
                self._cell_text.append(" ")
            return

        if tag in _HEADINGS:
            self._flush_text()
            self._heading = tag
        elif tag == "br" or tag in _BLOCK_TAGS:
            self._flush_text()

    def handle_endtag(self, tag: str) -> None:
        if tag in _SKIP_TAGS:
            self._skip = max(0, self._skip - 1)
            return
        if self._skip:
            return

        if self._table is not None:
            if tag == "table":
                self._table_depth -= 1
                if self._table_depth == 0:
                    self._close_row()
                    self._buffer = []
                    self._in_caption = False
                    self._table = None
                return
            if self._table_depth == 1:
                if tag == "caption":
                    self._flush_text()
                    self._in_caption = False
                elif tag == "tr":
                    self._close_row()
                elif tag in ("td", "th"):
                    self._close_cell()
            if self._cell is not None:
                self._cell_text.append(" ")
            return

        if tag in _HEADINGS:
            self._flush_text()
            self._heading = None
        elif tag in _BLOCK_TAGS:
            self._flush_text()

    def handle_data(self, data: str) -> None:
        if self._skip:
            return
        if self._table is None or self._in_caption:
            self._buffer.append(data)
        elif self._cell is not None:
            self._cell_text.append(data)

    def close(self) -> None:
        super().close()
        if self._table is not None:
            self._close_row()
            self._table = None
            self._in_caption = False
        self._flush_text()


def _expand(row: list[_Cell]) -> list[str]:
    """One text per column, so a cell that spans three columns takes three places."""
    columns: list[str] = []
    for cell in row:
        columns.append(cell.text)
        columns.extend([""] * (cell.span - 1))
    return columns


def _weekday_columns(row: list[str]) -> dict[int, int] | None:
    """Map column number to weekday (0 is Monday) if this row is the weekday header."""
    columns: dict[int, int] = {}
    for index, text in enumerate(row):
        word = re.sub(r"[^a-z]", "", text.lower())
        if word in WEEKDAYS:
            columns[index] = WEEKDAYS[word]
    if len(columns) >= 5 and len(set(columns.values())) == len(columns):
        return columns
    return None


# --------------------------------------------------------------------------
# Step 2: turn one table into dated entries
# --------------------------------------------------------------------------


@dataclass
class _DayCell:
    day: int
    weekday: int
    row: int
    rest: str
    month: int | None = None  # set when the cell names its own month: "27 (October)"


def _day_cells(table: _Table) -> list[_DayCell]:
    """Every cell that starts with a day number, in reading order."""
    columns: dict[int, int] | None = None
    cells: list[_DayCell] = []
    row_number = 0
    for raw_row in table.rows:
        row = _expand(raw_row)
        if columns is None:
            columns = _weekday_columns(row)
            continue
        row_number += 1
        for index, text in enumerate(row):
            if index not in columns or not text:
                continue
            match = _DAY_RE.match(text)
            if not match:
                continue
            day = int(match.group(1))
            if not 1 <= day <= 31:
                continue
            rest = text[match.end() :]
            month = None
            named = _CELL_MONTH_RE.match(rest)
            if named:
                month = MONTHS[(named.group(1) or named.group(2)).lower()]
                rest = rest[named.end() :]
            cells.append(_DayCell(day, columns[index], row_number, rest.strip(), month))
    return cells


def _shift(year: int, month: int, by: int) -> tuple[int, int]:
    index = year * 12 + (month - 1) + by
    return index // 12, index % 12 + 1


def _assign_dates(cells: list[_DayCell], year: int, month: int) -> tuple[list[tuple[date, _DayCell]], int]:
    """Give every cell its date, assuming the table shows ``month``.

    A calendar grid may start with the last days of the month before and end
    with the first days of the month after. A cell only gets a date when its
    weekday column agrees with the calendar. Returns the dated cells and the
    number of cells that did not fit.
    """
    before = _shift(year, month, -1)
    after = _shift(year, month, +1)
    first_one = next((i for i, cell in enumerate(cells) if cell.day == 1), None)
    first_row = cells[0].row if cells else 0

    dated: list[tuple[date, _DayCell]] = []
    misfits = 0
    last_day = 0
    wrapped = False
    for i, cell in enumerate(cells):
        if cell.month is not None:
            # The cell says which month it belongs to, so there is nothing to work out.
            choices = [choice for choice in (before, (year, month), after) if choice[1] == cell.month]
            if choices == [after]:
                wrapped = True
        elif first_one is not None and i < first_one and cell.day >= 20 and cell.row == first_row:
            choices = [before, (year, month)]
        elif wrapped or (last_day and cell.day < last_day):
            wrapped = True
            choices = [after]
        else:
            choices = [(year, month)]

        found = None
        for choice_year, choice_month in choices:
            try:
                candidate = date(choice_year, choice_month, cell.day)
            except ValueError:
                continue
            if candidate.weekday() == cell.weekday:
                found = candidate
                break
        if found is None:
            misfits += 1
            continue
        if (found.year, found.month) == (year, month):
            last_day = cell.day
        dated.append((found, cell))
    return dated, misfits


def _fit(cells: list[_DayCell], year: int, month: int) -> tuple[int, int]:
    """Read the table as ``month``: (cells that did not fit, cells that landed in the month itself)."""
    dated, misfits = _assign_dates(cells, year, month)
    inside = sum(1 for found, _cell in dated if (found.year, found.month) == (year, month))
    return misfits, inside


def _fits_well(cells: list[_DayCell], year: int, month: int) -> bool:
    misfits, inside = _fit(cells, year, month)
    return misfits <= max(1, len(cells) // 10) and inside >= min(7, len(cells))


def _month_hints(table: _Table, texts_before: list[_Text]) -> list[tuple[int, int | None]]:
    """Month names (with a year if given) from the caption and the text above the table, nearest first."""
    hints: list[tuple[int, int | None]] = []
    sources = [table.caption] + [text.words for text in reversed(texts_before[-30:])]
    for words in sources:
        if not words or len(words) > 200:
            continue  # a heading is short; long paragraphs mention months for other reasons
        for match in _MONTH_RE.finditer(words):
            hints.append((MONTHS[match.group(1).lower()], int(match.group(2)) if match.group(2) else None))
    return hints


def _pick_month(cells: list[_DayCell], hints: list[tuple[int, int | None]], today: date) -> tuple[int, int, bool]:
    """Decide which month a table shows. Returns (year, month, came_from_heading)."""

    def distance(year: int, month: int) -> int:
        return abs((year * 12 + month) - (today.year * 12 + today.month))

    # First choice: a month named above the table that also fits the calendar.
    for month, year in hints:
        years = [year] if year else [today.year, today.year - 1, today.year + 1]
        fitting = [(y, month) for y in years if _fits_well(cells, y, month)]
        if fitting:
            best = min(fitting, key=lambda ym: distance(*ym))
            return best[0], best[1], True

    # No heading helped: find the month near today that the grid itself fits best.
    best_key = None
    best_month = None
    for by in range(-13, 4):
        year, month = _shift(today.year, today.month, by)
        if not _fits_well(cells, year, month):
            continue
        misfits, inside = _fit(cells, year, month)
        key = (misfits, -inside, distance(year, month))
        if best_key is None or key < best_key:
            best_key, best_month = key, (year, month)
    if best_month is None:
        raise CouncilPageError("a weekday table was found, but its day numbers fit no nearby month")
    return best_month[0], best_month[1], False


# --------------------------------------------------------------------------
# Step 3: closure notices in the text, such as turf works
# --------------------------------------------------------------------------

_WD = r"(?:(?P<wd{n}>mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,?\s+)?"
_DT = (
    r"(?:(?P<t{n}>\d{{1,2}}(?:[:.]\d{{2}})?\s*[ap]\.?m\.?|noon|midday|midnight)\s+(?:on\s+)?)?"
    + _WD
    + r"(?:the\s+)?(?P<d{n}>\d{{1,2}})(?:st|nd|rd|th)?(?:\s+of)?\s+(?P<mon{n}>"
    + _MONTH_NAMES
    + r")\b\.?,?(?:\s+(?P<y{n}>\d{{4}}))?"
)
_CLOSURE_RE = re.compile(
    r"\bfrom\s+" + _DT.format(n=1) + r"\s*(?:to|until|till|through|-|–|—)\s*" + _DT.format(n=2),
    re.IGNORECASE,
)
_CLOSURE_WORDS = re.compile(r"clos|not be permitted|not permitted|no access|unavailable|out of use", re.IGNORECASE)


def _clock_minutes(text: str | None, default: int) -> int:
    if not text:
        return default
    text = text.lower().strip()
    if text in ("noon", "midday"):
        return 12 * 60
    match = re.match(r"(\d{1,2})(?:[:.](\d{2}))?\s*([ap])", text)
    if not match:
        return default  # "midnight" keeps the default for its end of the range
    hour, minute, half = int(match.group(1)) % 12, int(match.group(2) or 0), match.group(3)
    return (hour + (12 if half == "p" else 0)) * 60 + minute


def _closure_date(day: int, month: int, year: str | None, weekday: str | None, today: date) -> date | None:
    """A date from a notice. Notices leave the year out, so the weekday name helps to find it."""
    years = [int(year)] if year else [today.year, today.year - 1, today.year + 1]
    options: list[date] = []
    for candidate_year in years:
        try:
            candidate = date(candidate_year, month, day)
        except ValueError:
            continue
        if weekday and candidate.weekday() != WEEKDAYS[weekday.lower()[:3]]:
            continue
        options.append(candidate)
    if not options:
        return None
    return min(options, key=lambda candidate: abs((candidate - today).days))


def find_closures(texts: list[str], today: date) -> list[Closure]:
    """Find notices such as "access to the oval will not be permitted from 6am on
    Tuesday 15 September to 6am Thursday 1 October"."""
    closures: list[Closure] = []
    for index, words in enumerate(texts):
        for match in _CLOSURE_RE.finditer(words):
            nearby = " ".join(texts[max(0, index - 1) : index + 1])
            if not _CLOSURE_WORDS.search(nearby):
                continue
            first = _closure_date(
                int(match.group("d1")), MONTHS[match.group("mon1").lower()], match.group("y1"), match.group("wd1"), today
            )
            last = _closure_date(
                int(match.group("d2")), MONTHS[match.group("mon2").lower()], match.group("y2"), match.group("wd2"), today
            )
            if first is None or last is None:
                continue
            if last < first:
                try:
                    last = last.replace(year=last.year + 1)
                except ValueError:
                    continue
            start = datetime(first.year, first.month, first.day) + timedelta(minutes=_clock_minutes(match.group("t1"), 0))
            # "until Thursday 1 October" with no time includes that whole day.
            end = datetime(last.year, last.month, last.day) + timedelta(
                minutes=_clock_minutes(match.group("t2"), 0 if match.group("t2") else 24 * 60)
            )
            if end <= start or (end - start).days > 200:
                continue
            stop = words.rfind(". ", 0, match.start())
            sentence_start = stop + 2 if stop != -1 else 0
            sentence_end = words.find(". ", match.end())
            sentence = words[sentence_start : sentence_end + 1 if sentence_end != -1 else len(words)].strip()
            closures.append(Closure(start, end, sentence[:300]))
    return closures


# --------------------------------------------------------------------------
# The page's own "last updated" time
# --------------------------------------------------------------------------


def _parse_modified(meta: dict[str, str], zone: tzinfo | None) -> datetime | None:
    for key in ("article:modified_time", "og:updated_time", "dcterms.modified", "last-modified", "datemodified"):
        value = meta.get(key, "").strip()
        if not value:
            continue
        try:
            stamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            stamp = None
        if stamp is not None:
            if stamp.tzinfo is not None and zone is not None:
                stamp = stamp.astimezone(zone)
            return stamp.replace(tzinfo=None)
        # The council's site writes "Mon, 12/10/2026 - 3:55pm": day first, as in Australia.
        match = re.search(r"(\d{1,2})/(\d{1,2})/(\d{4})(?:\D+(\d{1,2})[:.](\d{2})\s*([ap])m)?", value, re.IGNORECASE)
        if match:
            day, month, year = int(match.group(1)), int(match.group(2)), int(match.group(3))
            hour = minute = 0
            if match.group(4):
                hour = int(match.group(4)) % 12 + (12 if match.group(6).lower() == "p" else 0)
                minute = int(match.group(5))
            try:
                return datetime(year, month, day, hour, minute)
            except ValueError:
                continue
    return None


# --------------------------------------------------------------------------
# The whole page
# --------------------------------------------------------------------------


def parse(html: str, today: date, zone: tzinfo | None = None) -> CouncilPage:
    """Read the council page. Raises :class:`CouncilPageError` if no booking table can be trusted."""
    extractor = _Extractor()
    extractor.feed(html)
    extractor.close()

    page = CouncilPage(modified=_parse_modified(extractor.meta, zone))
    texts_before: list[_Text] = []
    all_texts: list[str] = []
    tables_seen = 0
    problems: list[str] = []

    for item in extractor.items:
        if isinstance(item, _Text):
            texts_before.append(item)
            all_texts.append(item.words)
            continue

        cells = _day_cells(item)
        if not cells:
            continue  # some other table on the page
        tables_seen += 1
        hints = _month_hints(item, texts_before)
        texts_before = []  # the next table looks for its own heading
        try:
            year, month, from_heading = _pick_month(cells, hints, today)
        except CouncilPageError as error:
            problems.append(str(error))
            continue
        month_name = f"{calendar.month_name[month]} {year}"
        if not from_heading:
            page.warnings.append(
                f"No month heading matched the table, so {month_name} was worked out from the day numbers."
            )

        dated, misfits = _assign_dates(cells, year, month)
        if misfits:
            page.warnings.append(f"{misfits} cell(s) in the {month_name} table did not fit the calendar and were skipped.")
        page.months.append((year, month))
        for found, cell in dated:
            slots, label = find_slots(cell.rest)
            if _NO_BOOKING_RE.match(label):
                label = ""  # "No Bookings": an empty day, said out loud
            previous = page.days.get(found)
            if previous:  # the same day listed twice: keep everything
                slots = sorted(set(previous.slots) | set(slots))
                label = " ".join(part for part in (previous.label, label) if part)
            page.days[found] = DayEntry(tuple(slots), label)

    if not page.days:
        if tables_seen:
            raise CouncilPageError("; ".join(problems) or "the booking table could not be read")
        raise CouncilPageError("no table with weekday headings was found on the page")

    page.closures = find_closures(all_texts, today)
    return page


def table_sources(html: str, limit: int = 20000) -> list[str]:
    """The raw HTML of every table, with a little of what comes before it.

    Only used for diagnostics: when the reader fails on the live page, this
    shows the real markup in the job log.
    """
    found = []
    for match in re.finditer(r"<table\b.*?</table\s*>", html, re.IGNORECASE | re.DOTALL):
        lead = html[max(0, match.start() - 600) : match.start()]
        found.append((lead + match.group(0))[:limit])
    return found
