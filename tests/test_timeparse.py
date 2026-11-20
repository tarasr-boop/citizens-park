import unittest

from parkbot.timeparse import Slot, clock, find_slots, merge, parse_hhmm, span, spans


def slots_of(text):
    return [(slot.start, slot.end) for slot in find_slots(text)[0]]


class FindSlotsTest(unittest.TestCase):
    def test_the_council_formats(self):
        self.assertEqual(slots_of("5:15pm-7:30pm"), [(17 * 60 + 15, 19 * 60 + 30)])
        self.assertEqual(slots_of("4pm-8pm"), [(16 * 60, 20 * 60)])
        self.assertEqual(slots_of("10:00am-6:00pm"), [(10 * 60, 18 * 60)])
        self.assertEqual(slots_of("11:00am-5:00pm"), [(11 * 60, 17 * 60)])

    def test_spaces_dashes_and_words(self):
        expected = [(16 * 60 + 15, 19 * 60 + 30)]
        for text in ("4:15pm - 7:30pm", "4:15pm–7:30pm", "4:15 PM to 7:30 PM", "4.15pm until 7.30pm", "4:15 p.m. - 7:30 p.m."):
            with self.subTest(text=text):
                self.assertEqual(slots_of(text), expected)

    def test_missing_am_or_pm_is_inferred(self):
        self.assertEqual(slots_of("4-8pm"), [(16 * 60, 20 * 60)])
        self.assertEqual(slots_of("10-2pm"), [(10 * 60, 14 * 60)])
        self.assertEqual(slots_of("10am-1"), [(10 * 60, 13 * 60)])
        self.assertEqual(slots_of("4-8"), [(16 * 60, 20 * 60)])
        self.assertEqual(slots_of("10-6"), [(10 * 60, 18 * 60)])
        self.assertEqual(slots_of("16:00-20:00"), [(16 * 60, 20 * 60)])

    def test_noon_and_midnight(self):
        self.assertEqual(slots_of("9am-noon"), [(9 * 60, 12 * 60)])
        self.assertEqual(slots_of("noon-4pm"), [(12 * 60, 16 * 60)])
        self.assertEqual(slots_of("12pm-1pm"), [(12 * 60, 13 * 60)])
        self.assertEqual(slots_of("8pm-midnight"), [(20 * 60, 24 * 60)])

    def test_two_ranges_in_one_cell(self):
        self.assertEqual(slots_of("10am-1pm & 2pm-6pm"), [(10 * 60, 13 * 60), (14 * 60, 18 * 60)])
        self.assertEqual(find_slots("10am-1pm and 2pm-6pm")[1], "")

    def test_words_are_kept_as_the_label(self):
        slots, label = find_slots("Maintenance")
        self.assertEqual((slots, label), ([], "Maintenance"))
        slots, label = find_slots("Finals 10am-6pm")
        self.assertEqual(([(s.start, s.end) for s in slots], label), ([(600, 1080)], "Finals"))

    def test_nonsense_is_not_dropped_silently(self):
        slots, label = find_slots("13pm-25pm")
        self.assertEqual(slots, [])
        self.assertEqual(label, "13pm-25pm")
        self.assertEqual(find_slots("8pm-4pm")[0], [])

    def test_empty_text(self):
        self.assertEqual(find_slots(""), ([], ""))


class SlotTest(unittest.TestCase):
    def test_round_trip(self):
        slot = Slot(16 * 60 + 15, 19 * 60 + 30)
        self.assertEqual(slot.to_text(), "16:15-19:30")
        self.assertEqual(Slot.from_text("16:15-19:30"), slot)

    def test_rejects_backwards_periods(self):
        with self.assertRaises(ValueError):
            Slot(600, 600)
        with self.assertRaises(ValueError):
            Slot.from_text("19:00-16:00")
        with self.assertRaises(ValueError):
            Slot.from_text("4pm-8pm")

    def test_merge_joins_touching_and_overlapping(self):
        merged = merge([Slot(600, 720), Slot(720, 780), Slot(900, 960), Slot(930, 1000)])
        self.assertEqual(merged, (Slot(600, 780), Slot(900, 1000)))

    def test_parse_hhmm(self):
        self.assertEqual(parse_hhmm("06:00"), 360)
        self.assertEqual(parse_hhmm("24:00"), 1440)
        with self.assertRaises(ValueError):
            parse_hhmm("25:00")


class WordsTest(unittest.TestCase):
    def test_clock(self):
        self.assertEqual(clock(16 * 60), "4 PM")
        self.assertEqual(clock(16 * 60 + 15), "4:15 PM")
        self.assertEqual(clock(12 * 60), "12 PM")
        self.assertEqual(clock(9 * 60 + 5), "9:05 AM")
        self.assertEqual(clock(24 * 60), "midnight")

    def test_span(self):
        self.assertEqual(span(Slot(16 * 60 + 15, 19 * 60 + 30)), "4:15 to 7:30 PM")
        self.assertEqual(span(Slot(10 * 60, 18 * 60)), "10 AM to 6 PM")
        self.assertEqual(span(Slot(9 * 60, 11 * 60)), "9 to 11 AM")
        self.assertEqual(span(Slot(20 * 60, 24 * 60)), "8 PM to midnight")

    def test_spans(self):
        self.assertEqual(spans([Slot(600, 780), Slot(960, 1080)]), "10 AM to 1 PM and 4 to 6 PM")
        self.assertEqual(spans([]), "")


if __name__ == "__main__":
    unittest.main()
