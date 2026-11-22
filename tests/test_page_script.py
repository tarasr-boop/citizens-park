"""The live view: what the page's script draws from the page's data.

The script runs in the reader's browser. Here it is run with Node (which
GitHub's runners have) against a stand-in page, see ``run_page.js``. Where
Node is missing, these tests are skipped.
"""

import json
import re
import shutil
import subprocess
import tempfile
import unittest
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from parkbot import site, weather
from parkbot.council import parse
from parkbot.status import DayPlan, plan_days
from parkbot.store import CouncilStore
from parkbot.timeparse import Slot

from .helpers import FIXTURES, forecast_json, load_config, october_store, seasons

MELBOURNE = ZoneInfo("Australia/Melbourne")
FRIDAY = date(2026, 11, 20)
HARNESS = Path(__file__).parent / "run_page.js"


def at(day: date, hour: int, minute: int = 0) -> datetime:
    return datetime(day.year, day.month, day.day, hour, minute, tzinfo=MELBOURNE)


def november_store(read_at: datetime) -> CouncilStore:
    """A store holding the November 2026 table, as read at ``read_at``."""
    store = CouncilStore()
    html = (FIXTURES / "council_november_2026.html").read_text(encoding="utf-8")
    store.update(parse(html, read_at.date(), MELBOURNE), read_at.date(), read_at)
    return store


def friday_rain(day: date, hour: int) -> float:
    """Millimetres for each hour of the Friday, and a little on the Sunday."""
    if day == FRIDAY:
        return {12: 0.8, 13: 1.7, 15: 0.3, 16: 4.6, 17: 0.9, 18: 4.2, 19: 1.2, 20: 0.2, 22: 3.0}.get(hour, 0.0)
    if day == FRIDAY + timedelta(days=2):
        return 1.5 if 9 <= hour <= 12 else 0.0
    if day == FRIDAY + timedelta(days=3):
        return 0.2 if hour == 9 else 0.0
    return 0.0


@unittest.skipUnless(shutil.which("node"), "node is needed to run the page's script")
class LiveViewTest(unittest.TestCase):
    def setUp(self):
        self._folder = tempfile.TemporaryDirectory()
        self.addCleanup(self._folder.cleanup)
        # The page as it is set up for the real park: a timeline from 7 AM to 9 PM.
        self.config = load_config(day_start=7 * 60, day_end=21 * 60)

    def draw(self, data: dict, now: str, more: str = "") -> str:
        """What the script puts on the page for ``data`` when the park's clock says ``now``.

        ``more`` goes after ``now`` in the page's address, such as ``&card=2026-11-20``.
        """
        path = Path(self._folder.name) / "data.json"
        path.write_text(json.dumps(data), encoding="utf-8")
        # The script's own clock stands at the same moment, so that a drawing never depends on the day the tests are run.
        moment = datetime.fromisoformat(now).replace(tzinfo=ZoneInfo(data.get("zone") or "Australia/Melbourne"))
        result = subprocess.run(
            ["node", str(HARNESS), str(site.WEB / "page.js"), str(path), now, str(int(moment.timestamp() * 1000)), more],
            capture_output=True,
            text=True,
            timeout=60,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        # The script ties "4" to "PM" with a non-breaking space. A plain one is easier to read here.
        return result.stdout.replace("\u00a0", " ")

    def data(self, built: datetime, store: CouncilStore | None = None, forecast=None, config=None) -> dict:
        config = config or self.config
        store = store or november_store(built)
        plans = plan_days(built.date(), 8, store, seasons(), config.day_start, config.lights_off)
        return site.page_data(config, plans, forecast, store, built)

    def friday(self, **extra) -> dict:
        forecast = weather.parse(forecast_json(FRIDAY, 8, chance=lambda day, hour: 90 if day == FRIDAY and hour >= 12 else 10, mm=friday_rain))
        return self.data(at(FRIDAY, 13, 47), forecast=forecast, **extra)

    # ---- the answer at the top ----

    def test_the_top_line_says_when_the_council_page_was_last_read(self):
        data = self.friday()
        self.assertIn('<p class="kicker">Last checked today at 1:47 PM</p>', self.draw(data, "2026-11-20T14:20"))
        # It does not move with the clock: hours later it still names the same moment.
        self.assertIn('<p class="kicker">Last checked today at 1:47 PM</p>', self.draw(data, "2026-11-20T20:05"))
        self.assertIn('<p class="kicker">Last checked yesterday at 1:47 PM</p>', self.draw(data, "2026-11-21T08:00"))
        self.assertIn('<p class="kicker">Last checked Fri 20 Nov, 1:47 PM</p>', self.draw(data, "2026-11-23T08:00"))

    def test_a_failed_read_leaves_the_time_of_the_last_good_one(self):
        # Built on Friday morning, but the council's page was last read on Thursday afternoon.
        data = self.data(at(FRIDAY, 9, 15), store=november_store(at(FRIDAY - timedelta(days=1), 15, 55)))
        html = self.draw(data, "2026-11-20T09:20")
        self.assertIn('<p class="kicker">Last checked yesterday at 3:55 PM</p>', html)
        self.assertNotIn("9:15", html)

    def test_a_page_that_has_not_been_built_for_26_hours_says_so(self):
        data = self.data(at(FRIDAY, 9, 15))
        warning = '<p class="stale">This page has not updated since Fri 20 Nov, 9:15 AM. The times may be out of date.</p>'
        # Nothing is said while the page is fresh, nor a day later, when a check may only be running late.
        self.assertNotIn('class="stale"', self.draw(data, "2026-11-20T09:20"))
        self.assertNotIn('class="stale"', self.draw(data, "2026-11-21T11:10"))
        self.assertIn(warning, self.draw(data, "2026-11-21T11:20"))
        self.assertIn(warning, self.draw(data, "2026-11-23T08:00"))

    def test_no_claim_of_a_check_that_never_happened(self):
        html = self.draw(self.data(at(FRIDAY, 9, 15), store=CouncilStore()), "2026-11-20T09:20")
        self.assertNotIn("Last checked", html)
        self.assertIn('<p class="kicker">Fri 20 Nov</p>', html)

    def test_the_source_is_a_quiet_link_and_is_named_once(self):
        html = self.draw(self.friday(), "2026-11-20T14:20")
        # A line of plain words that is a link: no button, and no arrow after it.
        self.assertIn(
            '<p class="source-row" data-sure="yes">'
            '<a href="https://council.example/parks/citizens-park" rel="noopener">From the council’s schedule</a></p>',
            html,
        )
        self.assertNotIn("pill", html)
        self.assertNotIn("›", html)
        self.assertEqual(html.count("From the council"), 1)
        self.assertNotIn('class="why"', html)
        self.assertNotIn('class="source"', html)

    def test_a_day_the_council_has_not_listed_links_to_the_explanation_and_says_why(self):
        # Wednesday 2 December: the council's table stops at 30 November.
        data = self.data(at(date(2026, 12, 2), 15, 12))
        html = self.draw(data, "2026-12-02T15:30")
        self.assertIn('<p class="source-row" data-sure="no"><a href="#how">Usual pattern, not confirmed</a></p>', html)
        self.assertIn('<p class="why">The council&#39;s page only goes up to 30 November.</p>', html)
        self.assertIn("<h1>Probably free until 4:15 PM</h1>", html)

    def test_an_address_that_is_not_https_is_never_made_a_link(self):
        data = self.friday()
        data["council"]["url"] = "javascript:alert(1)"
        html = self.draw(data, "2026-11-20T14:20")
        self.assertNotIn("javascript:", html)
        self.assertIn('<p class="source-row" data-sure="yes">From the council’s schedule</p>', html)

    # ---- the one line that says how things stand ----

    def hero(self, html: str) -> str:
        return html[html.index('<section class="hero"') : html.index("</section>")]

    def one_day(self, plan: DayPlan, now: str) -> str:
        """The answer at the top for a page that knows only ``plan``'s day."""
        built = at(plan.day, 9)
        return self.hero(self.draw(site.page_data(self.config, [plan], None, october_store(plan.day, built), built), now))

    def test_the_answer_is_one_line_that_says_until_when(self):
        data = self.friday()  # the council lists 4 to 8 PM
        free = self.hero(self.draw(data, "2026-11-20T14:20"))
        self.assertIn('data-state="free"', free)
        self.assertIn("<h1>Free until 4 PM</h1>", free)
        booked = self.hero(self.draw(data, "2026-11-20T16:51"))
        self.assertIn('data-state="booked"', booked)
        self.assertIn("<h1>Booked until 8 PM</h1>", booked)
        self.assertIn("<h1>Booked until 8 PM</h1>", self.draw(data, "2026-11-20T16:00"))
        over = self.hero(self.draw(data, "2026-11-20T20:00"))
        self.assertIn('data-state="free"', over)
        self.assertIn("<h1>Free until tomorrow</h1>", over)
        # The times are in the "Today" card right below, so no second line repeats them.
        for hero in (free, booked, over):
            self.assertNotIn('class="sub"', hero)

    def test_the_rule_is_given_only_while_the_oval_is_booked(self):
        data = self.friday()
        booked = self.hero(self.draw(data, "2026-11-20T16:51"))
        self.assertIn('<p class="rule">Dogs must stay off the oval while an activity is on.</p>', booked)
        self.assertNotIn("sport or training", booked)
        self.assertNotIn('class="rule"', self.draw(data, "2026-11-20T14:20"))
        self.assertNotIn('class="rule"', self.draw(data, "2026-11-20T20:00"))

    def test_a_day_without_bookings_is_free_all_day(self):
        monday = date(2026, 11, 2)  # the council lists that day and names no booking
        hero = self.hero(self.draw(self.data(at(monday, 9)), "2026-11-02T09:05"))
        self.assertIn('data-state="free"', hero)
        self.assertIn("<h1>Free all day</h1>", hero)
        self.assertNotIn('class="sub"', hero)

    def test_a_day_the_council_has_not_listed_says_usually_and_probably(self):
        # Wednesday 2 December: the usual pattern is 4:15 to 7:30 PM.
        data = self.data(at(date(2026, 12, 2), 9))
        self.assertIn("<h1>Probably free until 4:15 PM</h1>", self.draw(data, "2026-12-02T09:05"))
        booked = self.hero(self.draw(data, "2026-12-02T17:00"))
        self.assertIn("<h1>Usually booked until 7:30 PM</h1>", booked)
        self.assertIn('class="rule"', booked)
        self.assertIn("<h1>Probably free until tomorrow</h1>", self.draw(data, "2026-12-02T19:30"))
        self.assertIn("<h1>Probably free all day</h1>", self.one_day(DayPlan(FRIDAY, (), "usual"), "2026-11-20T10:00"))

    def test_a_booking_that_runs_to_the_end_of_the_day(self):
        late = DayPlan(FRIDAY, (Slot(18 * 60, 24 * 60),), "council")
        self.assertIn("<h1>Booked until midnight</h1>", self.one_day(late, "2026-11-20T19:00"))

    def test_a_second_line_only_where_the_first_cannot_say_it(self):
        closed = self.one_day(DayPlan(FRIDAY, (Slot(0, 1440),), "council", closed=True, label="Turf works until 1 December."), "2026-11-20T10:00")
        self.assertIn('data-state="closed"', closed)
        self.assertIn("<h1>Closed today</h1>", closed)
        self.assertIn('<p class="sub">Council notice: Turf works until 1 December.</p>', closed)
        self.assertIn('<p class="sub">The council has closed the oval.</p>', self.one_day(DayPlan(FRIDAY, (Slot(0, 1440),), "council", closed=True), "2026-11-20T10:00"))

        listed = self.one_day(DayPlan(FRIDAY, (), "council", label="Maintenance"), "2026-11-20T10:00")
        self.assertIn('data-state="unknown"', listed)
        self.assertIn("<h1>Maintenance listed today</h1>", listed)
        self.assertIn('<p class="sub">The oval may be closed. Check the signs at the park.</p>', listed)

        nothing = self.one_day(DayPlan(FRIDAY, (), "none"), "2026-11-20T10:00")
        self.assertIn("<h1>No booking information today</h1>", nothing)
        self.assertIn('<p class="sub">Check the signs at the park.</p>', nothing)

    # ---- today's timeline ----

    def test_the_timeline_runs_from_seven_to_nine_with_a_mark_for_every_hour(self):
        html = self.draw(self.friday(), "2026-11-20T14:20")
        timeline = html[html.index('<div class="timeline">') : html.index('<ul class="times">')]
        ticks = re.findall(r'<span style="left:([\d.]+)%">(\d+)(?:<small>(am|pm)</small>)?</span>', timeline)
        self.assertEqual([number for _left, number, _half in ticks], ["7", "8", "9", "10", "11", "12", "1", "2", "3", "4", "5", "6", "7", "8", "9"])
        # "am" and "pm" are each written once, where that half of the day begins.
        self.assertEqual([(number, half) for _left, number, half in ticks if half], [("7", "am"), ("12", "pm")])
        self.assertEqual((ticks[0][0], ticks[-1][0]), ("0.00", "100.00"))
        # A line across the bar at every hour between the two ends.
        self.assertEqual(timeline.count("<i style="), 13)
        # Booked 4 to 8 PM: from nine fourteenths of the way along, for four fourteenths.
        self.assertIn('<span class="seg" style="left:64.29%;width:28.57%"></span>', timeline)
        # 2:20 PM is 7 hours 20 minutes into the 14 hours shown.
        self.assertIn('<span class="now-line" style="left:52.38%" title="Now"></span>', timeline)

    def test_no_now_line_outside_the_hours_shown(self):
        data = self.friday()
        self.assertNotIn("now-line", self.draw(data, "2026-11-20T06:30"))
        self.assertNotIn("now-line", self.draw(data, "2026-11-20T21:30"))

    def test_a_very_long_day_is_numbered_at_every_second_mark(self):
        config = load_config(day_start=4 * 60, day_end=23 * 60)
        html = self.draw(self.friday(config=config), "2026-11-20T14:20")
        timeline = html[html.index('<div class="timeline">') : html.index('<ul class="times">')]
        marks = re.findall(r'<span style="left:[\d.]+%">([^<]*)', timeline)
        self.assertEqual(len(marks), 20)
        self.assertEqual(marks[:5], ["4", "", "6", "", "8"])

    # ---- rain ----

    def test_the_rain_chart_shows_millimetres_for_each_hour(self):
        html = self.draw(self.friday(), "2026-11-20T14:20")
        chart = html[html.index('<div class="rain-chart"') : html.index('<p class="rain-caption">')]
        bars = re.findall(r'<span style="left:([\d.]+)%;width:([\d.]+)%;height:([\d.]+)%" title="([^"]*)"( data-past="yes")?><b>([\d.]+)</b></span>', chart)
        self.assertEqual(
            [(title, label, bool(past)) for _left, _width, _height, title, past, label in bars],
            [
                ("12 PM: 0.8 mm, 90% chance", "0.8", True),
                ("1 PM: 1.7 mm, 90% chance", "1.7", True),
                ("3 PM: 0.3 mm, 90% chance", "0.3", False),
                ("4 PM: 4.6 mm, 90% chance", "4.6", False),
                ("5 PM: 0.9 mm, 90% chance", "0.9", False),
                ("6 PM: 4.2 mm, 90% chance", "4.2", False),
                ("7 PM: 1.2 mm, 90% chance", "1.2", False),
                ("8 PM: 0.2 mm, 90% chance", "0.2", False),
            ],
        )
        heights = {label: float(height) for _left, _width, height, _title, _past, label in bars}
        # The height is the amount, on a scale where a full bar is 5 mm in the hour.
        self.assertEqual(heights["4.6"], 92.0)
        self.assertEqual(heights["1.7"], 34.0)
        self.assertEqual(heights["0.2"], 5.0)  # a trace is kept tall enough to see
        # Each bar sits under its own hour on the same marks as the timeline: 4 PM is at 64.29%.
        self.assertIn(("64.29", "7.14"), [(left, width) for left, width, *_rest in bars])
        self.assertIn('aria-label="Rain for each hour in millimetres. Most: 4.6 mm at 4 PM."', chart)
        self.assertIn('<p class="rain-caption">Rain each hour, in millimetres.</p>', html)
        # The hour after the timeline ends (10 PM, 3 mm) is not drawn.
        self.assertNotIn("3.0", [label for *_rest, label in bars])
        self.assertNotIn("Chance of rain by the hour", html)

    def test_a_downpour_sets_the_scale(self):
        heavy = weather.parse(forecast_json(FRIDAY, 8, chance=lambda day, hour: 95, mm=lambda day, hour: {9: 11.8, 10: 14.2, 11: 2.0}.get(hour, 0.0)))
        html = self.draw(self.data(at(FRIDAY, 7, 5), forecast=heavy), "2026-11-20T07:10")
        bars = dict(re.findall(r'height:([\d.]+)%" title="[^"]*"><b>([\d.]+)</b>', html))
        self.assertEqual({label: height for height, label in bars.items()}, {"12": "83.1", "14": "100.0", "2.0": "14.1"})

    def test_a_dry_day_has_a_sentence_and_no_chart(self):
        dry = weather.parse(forecast_json(FRIDAY, 8, chance=lambda day, hour: 5))
        html = self.draw(self.data(at(FRIDAY, 10), forecast=dry), "2026-11-20T10:05")
        self.assertIn('<p class="rain-text">No rain expected for the rest of today.</p>', html)
        self.assertNotIn("rain-chart", html)
        self.assertNotIn("rain-caption", html)

    def test_a_saved_forecast_says_when_it_is_from(self):
        data = self.friday()
        data["rainFrom"] = "12:59 PM"
        html = self.draw(data, "2026-11-20T14:20")
        self.assertIn('<p class="rain-caption">Rain each hour, in millimetres. Forecast from 12:59 PM.</p>', html)
        dry = self.data(at(FRIDAY, 10), forecast=weather.parse(forecast_json(FRIDAY, 8)))
        dry["rainFrom"] = "9 PM yesterday"
        self.assertIn('<p class="rain-caption">Forecast from 9 PM yesterday.</p>', self.draw(dry, "2026-11-20T10:05"))

    def test_no_forecast_no_rain_section_worth_the_name(self):
        html = self.draw(self.data(at(FRIDAY, 10)), "2026-11-20T10:05")
        self.assertNotIn("rain-chart", html)
        self.assertNotIn("mm", html)

    # ---- the week ahead ----

    def test_the_week_ahead_gives_rain_in_millimetres_and_a_plain_legend(self):
        html = self.draw(self.friday(), "2026-11-20T14:20")
        week = html[html.index("The week ahead") :]
        rain = re.findall(r'<div class="day-rain" data-dry="(yes|no)">(.*?)</div>', week)
        self.assertEqual(
            rain[:4],
            [
                ("yes", "Dry"),  # Saturday
                ("no", "<strong>6 mm</strong><small>rain</small>"),  # Sunday: four hours of 1.5 mm
                ("no", "<strong>&lt;1 mm</strong><small>rain</small>"),  # Monday: 0.2 mm
                ("yes", "Dry"),
            ],
        )
        # No percentage is shown to the reader (the only "%" left is in the bars' positions).
        self.assertIsNone(re.search(r">[^<]*%[^<]*<", week))
        self.assertIn('<p class="legend"><span class="key"></span>Free<span class="key booked"></span>Booked</p>', week)
        self.assertNotIn("10 PM", week)
        self.assertNotIn("legend-note", week)

    def test_the_legend_explains_the_usual_mark_only_when_it_is_used(self):
        # Friday 27 November: the council's table ends on the Monday, so the rest of the week is the usual pattern.
        html = self.draw(self.data(at(date(2026, 11, 27), 9)), "2026-11-27T09:05")
        self.assertIn('<p class="legend-note"><span class="tag">usual</span> means the usual pattern, not yet confirmed by the council.</p>', html)
        # Wednesday 2 December: every day shown is the usual pattern, so it is said once.
        html = self.draw(self.data(at(date(2026, 12, 2), 9)), "2026-12-02T09:05")
        self.assertIn('<p class="legend-note">These are the usual times, not yet confirmed by the council.</p>', html)

    # ---- the picture for the Telegram bot ----

    def test_a_picture_of_today_is_the_answer_and_the_timeline_and_nothing_else(self):
        html = self.draw(self.friday(), "2026-11-20T16:51", "&card=2026-11-20")
        self.assertTrue(html.startswith('<section class="hero" data-state="booked"><p class="kicker">Last checked today at 1:47 PM</p>'))
        self.assertIn("<h1>Booked until 8 PM</h1>", html)
        self.assertIn("<h2>Today <span>Fri 20 Nov</span></h2>", html)
        self.assertIn('<span class="now-line" style="left:70.36%" title="Now"></span>', html)
        self.assertNotIn("The week ahead", html)
        self.assertNotIn('class="stale"', html)
        # Nothing in a picture can be pressed, and the reader knows the rule.
        self.assertNotIn("<a ", html)
        self.assertNotIn("From the council", html)
        self.assertNotIn('class="rule"', html)
        # The rain is the chart alone: the alert's words say the rest. Hours gone by
        # are drawn fainter: 12, 1 and 3 PM, but not 4 PM, which is still going.
        self.assertNotIn("rain-text", html)
        self.assertIn('<p class="rain-caption">Rain each hour, in millimetres.</p>', html)
        self.assertEqual(len(re.findall(r'title="(?:12|1|3) PM: [^"]*" data-past="yes"', html)), 3)
        self.assertEqual(html.count('data-past="yes"'), 3)

    def test_a_picture_of_a_day_the_council_has_not_listed_says_so_in_plain_words(self):
        data = self.data(at(date(2026, 12, 2), 9))
        html = self.draw(data, "2026-12-02T16:00", "&card=2026-12-02")
        self.assertIn("<h1>Probably free until 4:15 PM</h1>", html)
        self.assertIn('<p class="source-row" data-sure="no">Usual pattern, not confirmed</p>', html)
        self.assertNotIn("<a ", html)
        self.assertNotIn('class="why"', html)

    def test_a_picture_of_tomorrow_is_the_whole_day_without_a_now(self):
        html = self.draw(self.friday(), "2026-11-20T21:00", "&card=2026-11-21")
        # No answer at the top: it would speak of a "now" the picture does not have.
        self.assertTrue(html.startswith('<section class="card"><h2>Tomorrow <span>Sat 21 Nov</span></h2>'))
        self.assertNotIn("hero", html)
        self.assertNotIn("now-line", html)
        self.assertIn('<ul class="times"><li><span class="key booked"></span>Booked 10 AM to 6 PM</li></ul>', html)
        # Saturday is dry: no rain, and no empty rain section.
        self.assertNotIn("rain", html)

        # Rain the next day is drawn, with no hour of it gone by. (The page has rain
        # by the hour for today and tomorrow, so this page is built on Saturday.)
        forecast = weather.parse(forecast_json(FRIDAY, 8, chance=lambda day, hour: 60, mm=friday_rain))
        sunday = self.draw(self.data(at(FRIDAY + timedelta(days=1), 19, 47), forecast=forecast), "2026-11-21T21:00", "&card=2026-11-22")
        self.assertIn('<p class="rain-caption">Rain each hour, in millimetres.</p>', sunday)
        self.assertEqual(len(re.findall(r"<b>1\.5</b>", sunday)), 4)
        self.assertNotIn("data-past", sunday)

    def test_a_picture_of_a_day_the_page_does_not_have_is_empty(self):
        data = self.friday()
        self.assertEqual(self.draw(data, "2026-11-20T14:00", "&card=2026-12-25"), "")
        # Only today or tomorrow: a day further on has no picture.
        self.assertEqual(self.draw(data, "2026-11-20T21:00", "&card=2026-11-22"), "")
        self.assertEqual(self.draw(data, "2026-11-21T09:00", "&card=2026-11-20"), "")

    def test_a_dry_day_in_a_picture_has_no_rain_section(self):
        dry = weather.parse(forecast_json(FRIDAY, 8, chance=lambda day, hour: 5))
        html = self.draw(self.data(at(FRIDAY, 10), forecast=dry), "2026-11-20T10:05", "&card=2026-11-20")
        self.assertIn("<h2>Today <span>Fri 20 Nov</span></h2>", html)
        self.assertNotIn("rain", html)

    # ---- safety ----

    def test_words_from_outside_are_never_drawn_as_markup(self):
        nasty = '<img src=x onerror="alert(1)"> & </p><script>alert(2)</script>'
        plans = [
            DayPlan(FRIDAY, (Slot(600, 660),), "usual", label=nasty, note=nasty, why=nasty),
            DayPlan(FRIDAY + timedelta(days=1), (), "council", label=nasty, note=nasty, why=nasty),
            DayPlan(FRIDAY + timedelta(days=2), (Slot(0, 1440),), "council", closed=True, label=nasty),
        ]
        data = site.page_data(self.config, plans, None, october_store(FRIDAY, at(FRIDAY, 9)), at(FRIDAY, 9))
        data["rainFrom"] = nasty
        data["generatedText"] = nasty
        data["council"]["lastReadText"] = nasty
        for day in data["days"]:
            day["name"] = "Fri " + nasty
        for now, more in [
            ("2026-11-20T10:30", ""),
            ("2026-11-20T12:00", ""),
            ("2026-11-21T12:00", ""),
            ("2026-11-22T12:00", ""),
            ("2026-12-25T12:00", ""),
            # The pictures for the Telegram bot: today, and tomorrow.
            ("2026-11-20T10:30", "&card=2026-11-20"),
            ("2026-11-20T21:00", "&card=2026-11-21"),
            ("2026-11-21T21:00", "&card=2026-11-22"),
        ]:
            with self.subTest(now=now, more=more):
                html = self.draw(data, now, more)
                self.assertNotIn("<img", html)
                self.assertNotIn("<script", html)
                self.assertNotIn('onerror="', html)
                self.assertIn("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;", html)

    def test_a_page_too_old_to_know_today_says_so(self):
        html = self.draw(self.friday(), "2026-12-25T12:00")
        self.assertIn("<h1>No information for today</h1>", html)
        self.assertIn('<p class="kicker">Last checked Fri 20 Nov, 1:47 PM</p>', html)


if __name__ == "__main__":
    unittest.main()
