import unittest
from datetime import date, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from parkbot.council import CouncilPageError, find_closures, parse, table_sources
from parkbot.timeparse import Slot

FIXTURES = Path(__file__).parent / "fixtures"
TODAY = date(2026, 11, 20)

WEEKDAY_ROW = "<tr><th>Mon</th><th>Tue</th><th>Wed</th><th>Thu</th><th>Fri</th><th>Sat</th><th>Sun</th></tr>"


def october() -> str:
    return (FIXTURES / "council_october_2026.html").read_text(encoding="utf-8")


def grid(rows: list[list[str]], heading: str = "") -> str:
    """A small page with one weekday table."""
    body = "".join("<tr>" + "".join(f"<td>{cell}</td>" for cell in row) + "</tr>" for row in rows)
    return f"<html><body>{heading}<table>{WEEKDAY_ROW}{body}</table></body></html>"


def slots(page, day):
    return [slot.to_text() for slot in page.days[day].slots]


class OctoberPageTest(unittest.TestCase):
    def setUp(self):
        self.page = parse(october(), TODAY)

    def test_finds_october_2026_and_ignores_other_tables(self):
        self.assertEqual(self.page.months, [(2026, 10)])
        self.assertEqual(self.page.warnings, [])

    def test_covers_every_day_of_october_plus_the_leading_day(self):
        expected = {date(2026, 9, 30)} | {date(2026, 10, day) for day in range(1, 32)}
        self.assertEqual(set(self.page.days), expected)

    def test_reads_the_weekday_pattern(self):
        self.assertEqual(slots(self.page, date(2026, 10, 1)), ["17:15-19:30"])  # Thursday
        self.assertEqual(slots(self.page, date(2026, 10, 2)), ["16:00-20:00"])  # Friday
        self.assertEqual(slots(self.page, date(2026, 10, 3)), ["10:00-18:00"])  # Saturday
        self.assertEqual(slots(self.page, date(2026, 10, 4)), ["11:00-17:00"])  # Sunday
        self.assertEqual(slots(self.page, date(2026, 10, 5)), ["16:00-17:00"])  # Monday
        self.assertEqual(slots(self.page, date(2026, 10, 6)), ["16:15-19:30"])  # Tuesday
        self.assertEqual(slots(self.page, date(2026, 10, 7)), ["16:15-19:30"])  # Wednesday
        self.assertEqual(slots(self.page, date(2026, 10, 31)), ["10:00-18:00"])

    def test_the_leading_30_is_september_and_carries_its_label(self):
        entry = self.page.days[date(2026, 9, 30)]
        self.assertEqual(entry.slots, ())
        self.assertEqual(entry.label, "Maintenance")

    def test_reads_the_page_modified_time(self):
        self.assertEqual(self.page.modified, datetime(2026, 10, 12, 15, 55))

    def test_reads_the_closure_notice(self):
        self.assertEqual(len(self.page.closures), 1)
        closure = self.page.closures[0]
        self.assertEqual(closure.start, datetime(2026, 9, 15, 6, 0))
        self.assertEqual(closure.end, datetime(2026, 10, 1, 6, 0))
        self.assertIn("turf improvement works", closure.text)


class MarkupVariationsTest(unittest.TestCase):
    def test_day_number_in_bold_with_line_break(self):
        html = grid(
            [
                ["", "", "", "<strong>1</strong><br>5:15pm-7:30pm", "<strong>2</strong><br>4pm-8pm", "<b>3</b>", "<b>4</b>"],
                ["<b>5</b>4pm-5pm", "<b>6</b>", "<b>7</b>", "<b>8</b>", "<b>9</b>", "<b>10</b>", "<b>11</b>"],
            ],
            "<h3>October 2026</h3>",
        )
        page = parse(html, TODAY)
        self.assertEqual(slots(page, date(2026, 10, 1)), ["17:15-19:30"])
        self.assertEqual(slots(page, date(2026, 10, 5)), ["16:00-17:00"])  # "<b>5</b>4pm-5pm" has no space
        self.assertEqual(page.days[date(2026, 10, 3)].slots, ())

    def test_heading_without_a_year(self):
        rows = [["", "", "", "1 5:15pm-7:30pm", "2", "3", "4"], ["5", "6", "7", "8", "9", "10", "11"]]
        page = parse(grid(rows, "<h2>Bookings for October</h2>"), TODAY)
        self.assertEqual(page.months, [(2026, 10)])

    def test_no_heading_at_all_uses_the_day_numbers(self):
        rows = [
            ["", "", "", "1", "2", "3", "4"],
            ["5", "6", "7", "8", "9", "10", "11"],
            ["12", "13", "14", "15", "16", "17", "18"],
            ["19", "20", "21", "22", "23", "24", "25"],
            ["26", "27", "28", "29", "30", "31", ""],
        ]
        page = parse(grid(rows), TODAY)
        self.assertEqual(page.months, [(2026, 10)])
        self.assertTrue(any("worked out from the day numbers" in warning for warning in page.warnings))

    def test_a_wrong_heading_is_overruled_by_the_calendar(self):
        rows = [
            ["", "", "", "1", "2", "3", "4"],
            ["5", "6", "7", "8", "9", "10", "11"],
            ["12", "13", "14", "15", "16", "17", "18"],
            ["19", "20", "21", "22", "23", "24", "25"],
            ["26", "27", "28", "29", "30", "31", ""],
        ]
        page = parse(grid(rows, "<h2>November 2026</h2>"), TODAY)
        self.assertEqual(page.months, [(2026, 10)])

    def test_trailing_days_belong_to_the_next_month(self):
        # November 2026 starts on a Sunday and ends on a Monday.
        rows = [
            ["26", "27", "28", "29", "30", "31", "1 11am-5pm"],
            ["2", "3", "4", "5", "6", "7", "8"],
            ["9", "10", "11", "12", "13", "14", "15"],
            ["16", "17", "18", "19", "20 4pm-8pm", "21", "22"],
            ["23", "24", "25", "26", "27", "28", "29"],
            ["30", "1 4:15pm-7:30pm", "2", "3", "4", "5", "6"],
        ]
        page = parse(grid(rows, "<h2>November 2026</h2>"), TODAY)
        self.assertEqual(page.months, [(2026, 11)])
        self.assertIn(date(2026, 10, 26), page.days)
        self.assertEqual(slots(page, date(2026, 11, 1)), ["11:00-17:00"])
        self.assertEqual(slots(page, date(2026, 11, 20)), ["16:00-20:00"])
        self.assertEqual(slots(page, date(2026, 12, 1)), ["16:15-19:30"])
        self.assertEqual(len(page.days), 42)
        self.assertEqual(page.warnings, [])

    def test_february_into_march_keeps_the_months_apart(self):
        # February 2027 has 28 days, so 1 March falls on the same weekday as 1 February.
        rows = [
            ["1 4pm-5pm", "2", "3", "4", "5", "6", "7"],
            ["8", "9", "10", "11", "12", "13", "14"],
            ["15", "16", "17", "18", "19", "20", "21"],
            ["22", "23", "24", "25", "26", "27", "28"],
            ["1 6pm-7pm", "2", "3", "4", "5", "6", "7"],
        ]
        page = parse(grid(rows, "<h2>February 2027</h2>"), date(2027, 2, 10))
        self.assertEqual(slots(page, date(2027, 2, 1)), ["16:00-17:00"])
        self.assertEqual(slots(page, date(2027, 3, 1)), ["18:00-19:00"])

    def test_two_months_on_one_page(self):
        october_rows = [["", "", "", "1 5:15pm-7:30pm", "2", "3", "4"], ["5", "6", "7", "8", "9", "10", "11"]]
        november_rows = [["", "", "", "", "", "", "1 11am-5pm"], ["2 4pm-5pm", "3", "4", "5", "6", "7", "8"]]

        def table(rows):
            return "<table>" + WEEKDAY_ROW + "".join("<tr>" + "".join(f"<td>{c}</td>" for c in row) + "</tr>" for row in rows) + "</table>"

        html = f"<h2>October 2026</h2>{table(october_rows)}<h2>November 2026</h2>{table(november_rows)}"
        page = parse(html, TODAY)
        self.assertEqual(page.months, [(2026, 10), (2026, 11)])
        self.assertEqual(slots(page, date(2026, 10, 1)), ["17:15-19:30"])
        self.assertEqual(slots(page, date(2026, 11, 2)), ["16:00-17:00"])

    def test_caption_names_the_month(self):
        html = (
            "<table><caption>December 2026</caption>" + WEEKDAY_ROW + "<tr><td></td><td>1 4pm-5pm</td><td>2</td><td>3</td><td>4</td><td>5</td><td>6</td></tr>"
            "<tr><td>7</td><td>8</td><td>9</td><td>10</td><td>11</td><td>12</td><td>13</td></tr></table>"
        )
        page = parse(html, TODAY)
        self.assertEqual(page.months, [(2026, 12)])
        self.assertEqual(slots(page, date(2026, 12, 1)), ["16:00-17:00"])

    def test_iso_modified_time_is_converted_to_local_time(self):
        html = '<meta property="article:modified_time" content="2026-10-12T04:55:00+00:00">' + grid(
            [["", "", "", "1", "2", "3", "4"], ["5", "6", "7", "8", "9", "10", "11"]], "<h2>October 2026</h2>"
        )
        page = parse(html, TODAY, ZoneInfo("Australia/Melbourne"))
        self.assertEqual(page.modified, datetime(2026, 10, 12, 15, 55))


class RejectionTest(unittest.TestCase):
    def test_page_without_a_weekday_table(self):
        with self.assertRaises(CouncilPageError):
            parse("<html><body><h1>Citizens Park</h1><p>Nothing here.</p></body></html>", TODAY)

    def test_error_page(self):
        with self.assertRaises(CouncilPageError):
            parse("<html><body><h1>Access denied</h1></body></html>", TODAY)

    def test_grid_that_fits_no_month(self):
        rows = [["1", "5", "9", "13", "17", "21", "25"], ["2", "6", "10", "14", "18", "22", "26"]]
        with self.assertRaises(CouncilPageError):
            parse(grid(rows, "<h2>October 2026</h2>"), TODAY)

    def test_empty_text(self):
        with self.assertRaises(CouncilPageError):
            parse("", TODAY)


class ClosureTest(unittest.TestCase):
    def test_no_time_means_the_whole_last_day(self):
        found = find_closures(["The oval is closed from Monday 4 January to Friday 8 January 2027 for resurfacing."], date(2026, 12, 20))
        self.assertEqual(len(found), 1)
        self.assertEqual(found[0].start, datetime(2027, 1, 4))
        self.assertEqual(found[0].end, datetime(2027, 1, 9))

    def test_a_date_range_that_is_not_a_closure_is_ignored(self):
        texts = ["Summer hours run from 1 October to 31 March."]
        self.assertEqual(find_closures(texts, TODAY), [])

    def test_closure_words_in_the_heading_before_count(self):
        texts = ["Oval closure", "Works will run from 3 May to 14 May."]
        found = find_closures(texts, date(2027, 4, 20))
        self.assertEqual(len(found), 1)
        self.assertEqual((found[0].start, found[0].end), (datetime(2027, 5, 3), datetime(2027, 5, 15)))

    def test_a_range_across_new_year(self):
        found = find_closures(["Closed from 20 December to 10 January."], date(2026, 12, 1))
        self.assertEqual((found[0].start, found[0].end), (datetime(2026, 12, 20), datetime(2027, 1, 11)))


class DiagnosticsTest(unittest.TestCase):
    def test_table_sources_returns_the_raw_markup(self):
        sources = table_sources(october())
        self.assertEqual(len(sources), 3)  # one of them sits inside a script
        self.assertTrue(any("5:15pm-7:30pm" in source for source in sources))


if __name__ == "__main__":
    unittest.main()
