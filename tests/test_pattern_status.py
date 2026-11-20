import tempfile
import unittest
from datetime import date, datetime
from pathlib import Path

from parkbot.council import Closure, DayEntry
from parkbot.pattern import ScheduleError, load_seasons, usual_for
from parkbot.status import free_text, free_windows, plan_day, plan_days
from parkbot.store import CouncilStore, State
from parkbot.timeparse import Slot

from .helpers import october_store, seasons


def texts(slots):
    return [slot.to_text() for slot in slots]


class UsualPatternTest(unittest.TestCase):
    def test_learns_each_weekday_from_october(self):
        store = october_store()
        expected = {
            date(2026, 11, 16): ["16:00-17:00"],  # Monday
            date(2026, 11, 17): ["16:15-19:30"],
            date(2026, 11, 18): ["16:15-19:30"],
            date(2026, 11, 19): ["17:15-19:30"],
            date(2026, 11, 20): ["16:00-20:00"],  # Friday
            date(2026, 11, 21): ["10:00-18:00"],
            date(2026, 11, 22): ["11:00-17:00"],
        }
        for day, slots in expected.items():
            with self.subTest(day=day):
                usual = usual_for(day, store.days, seasons())
                self.assertTrue(usual.learned)
                self.assertFalse(usual.rough)
                self.assertEqual(texts(usual.slots), slots)
                self.assertEqual(usual.source, "the council's October 2026 schedule")

    def test_learning_follows_a_change_in_the_newest_month(self):
        store = october_store()
        # Pretend the council published November with later Friday bookings.
        for day in (6, 13, 20, 27):
            store.days[date(2026, 11, day)] = DayEntry((Slot(17 * 60, 21 * 60),))
        for day in range(1, 31):
            store.days.setdefault(date(2026, 11, day), DayEntry())
        usual = usual_for(date(2026, 12, 4), store.days, seasons())
        self.assertEqual(texts(usual.slots), ["17:00-21:00"])
        self.assertEqual(usual.source, "the council's November 2026 schedule")

    def test_one_off_labels_do_not_become_the_pattern(self):
        store = october_store()
        store.days[date(2026, 10, 30)] = DayEntry((), "Maintenance")  # a Friday
        usual = usual_for(date(2026, 11, 20), store.days, seasons())
        self.assertEqual(texts(usual.slots), ["16:00-20:00"])

    def test_another_season_is_not_learned_from(self):
        # October is cricket season, so it says nothing about a day in April.
        usual = usual_for(date(2027, 4, 13), october_store().days, seasons())
        self.assertFalse(usual.learned)
        self.assertTrue(usual.rough)
        self.assertEqual(texts(usual.slots), ["16:00-19:00"])  # Tuesday in schedule.toml

    def test_falls_back_to_the_schedule_file_with_no_council_data(self):
        usual = usual_for(date(2026, 11, 20), {}, seasons())
        self.assertFalse(usual.learned)
        self.assertEqual(texts(usual.slots), ["16:00-20:00"])
        monday_in_winter = usual_for(date(2027, 6, 7), {}, seasons())
        self.assertEqual(monday_in_winter.slots, ())

    def test_nothing_to_go_on(self):
        self.assertIsNone(usual_for(date(2026, 11, 20), {}, []))

    def test_too_old_a_month_is_not_learned_from(self):
        # October 2026 is more than six months before October 2027.
        usual = usual_for(date(2027, 10, 8), october_store().days, seasons())
        self.assertFalse(usual.learned)

    def test_schedule_file_mistakes_are_reported(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "schedule.toml"
            path.write_text('[[season]]\nmonths = [1]\n[season.week]\nfunday = ["10:00-11:00"]\n')
            with self.assertRaises(ScheduleError):
                load_seasons(path)
            path.write_text('[[season]]\nmonths = [1]\n[season.week]\nmon = ["10am-11am"]\n')
            with self.assertRaises(ScheduleError):
                load_seasons(path)
            self.assertEqual(load_seasons(Path(folder) / "missing.toml"), [])


class PlanDayTest(unittest.TestCase):
    def test_a_day_on_the_council_page_is_confirmed(self):
        plan = plan_day(date(2026, 10, 30), october_store(date(2026, 10, 30)), seasons(), date(2026, 10, 30))
        self.assertEqual(plan.basis, "council")
        self.assertEqual(texts(plan.slots), ["16:00-20:00"])
        self.assertEqual(plan.note, "From the council's schedule.")

    def test_a_day_past_the_council_page_uses_the_usual_pattern(self):
        today = date(2026, 11, 20)
        plan = plan_day(today, october_store(today), seasons(), today)
        self.assertEqual(plan.basis, "usual")
        self.assertEqual(texts(plan.slots), ["16:00-20:00"])
        self.assertEqual(plan.note, "Usual pattern only, not confirmed. The council's page only goes up to 31 October.")

    def test_old_council_data_says_when_it_was_read(self):
        store = october_store(date(2026, 10, 20))
        plan = plan_day(date(2026, 10, 30), store, seasons(), date(2026, 10, 30))
        self.assertEqual(plan.note, "From the council's schedule, last read on Tue 20 Oct.")

    def test_rough_season(self):
        plan = plan_day(date(2027, 4, 13), CouncilStore(), seasons(), date(2027, 4, 13))
        self.assertEqual(plan.basis, "rough")
        self.assertIn("Rough guide only", plan.note)
        self.assertIn("could not be read", plan.note)

    def test_nothing_known(self):
        plan = plan_day(date(2026, 11, 20), CouncilStore(), [], date(2026, 11, 20))
        self.assertEqual(plan.basis, "none")
        self.assertFalse(plan.known)

    def test_label_is_carried(self):
        plan = plan_day(date(2026, 9, 30), october_store(date(2026, 9, 30)), seasons(), date(2026, 9, 30))
        # 30 September also sits inside the turf closure, which wins.
        self.assertTrue(plan.closed)
        store = october_store(date(2026, 9, 30))
        store.closures = []
        plan = plan_day(date(2026, 9, 30), store, seasons(), date(2026, 9, 30))
        self.assertEqual((plan.slots, plan.label, plan.basis), ((), "Maintenance", "council"))

    def test_closure_notice_closes_whole_days(self):
        store = october_store(date(2026, 9, 20))
        for day in (date(2026, 9, 15), date(2026, 9, 20), date(2026, 9, 30)):
            with self.subTest(day=day):
                plan = plan_day(day, store, seasons(), date(2026, 9, 20))
                self.assertTrue(plan.closed)
                self.assertIn("turf improvement works", plan.label)
        # The closure ends at 6 AM on 1 October, before the day starts.
        plan = plan_day(date(2026, 10, 1), store, seasons(), date(2026, 9, 20))
        self.assertFalse(plan.closed)
        self.assertEqual(texts(plan.slots), ["17:15-19:30"])
        # It starts at 6 AM on 15 September, so the day before is untouched.
        self.assertFalse(plan_day(date(2026, 9, 14), store, seasons(), date(2026, 9, 20)).closed)

    def test_partial_closure_becomes_a_booked_period(self):
        store = october_store(date(2026, 10, 20))
        store.closures = [Closure(datetime(2026, 10, 20, 9, 0), datetime(2026, 10, 20, 15, 0), "Line marking.")]
        plan = plan_day(date(2026, 10, 20), store, seasons(), date(2026, 10, 20))
        self.assertFalse(plan.closed)
        self.assertEqual(texts(plan.slots), ["09:00-15:00", "16:15-19:30"])
        self.assertEqual(plan.label, "Line marking.")

    def test_plan_days_returns_consecutive_days(self):
        plans = plan_days(date(2026, 10, 29), 8, october_store(date(2026, 10, 29)), seasons())
        self.assertEqual([plan.day for plan in plans][0], date(2026, 10, 29))
        self.assertEqual([plan.basis for plan in plans], ["council"] * 3 + ["usual"] * 5)


class FreeTextTest(unittest.TestCase):
    EVENING = (Slot(16 * 60 + 15, 19 * 60 + 30),)

    def test_before_the_booking(self):
        self.assertEqual(free_text(self.EVENING, 15 * 60, 22 * 60), "until 4:15 PM, then from 7:30 PM")

    def test_during_the_booking(self):
        self.assertEqual(free_text(self.EVENING, 17 * 60, 22 * 60), "from 7:30 PM")

    def test_after_the_booking(self):
        self.assertEqual(free_text(self.EVENING, 20 * 60, 22 * 60), "for the rest of today")

    def test_gap_between_two_bookings(self):
        slots = (Slot(10 * 60, 13 * 60), Slot(16 * 60, 18 * 60))
        self.assertEqual(free_text(slots, 9 * 60, 22 * 60), "until 10 AM, then 1 PM to 4 PM, then from 6 PM")

    def test_booked_until_lights_off(self):
        self.assertEqual(free_text((Slot(15 * 60, 22 * 60),), 15 * 60, 22 * 60), "")

    def test_tiny_gaps_are_not_offered(self):
        slots = (Slot(16 * 60, 17 * 60), Slot(17 * 60 + 10, 18 * 60))
        self.assertEqual(free_windows(slots, 16 * 60, 22 * 60), [(18 * 60, 22 * 60)])


class StoreTest(unittest.TestCase):
    def test_council_store_round_trip(self):
        store = october_store()
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "data" / "council.json"
            store.save(path)
            loaded = CouncilStore.load(path)
        self.assertEqual(loaded.days, store.days)
        self.assertEqual(loaded.closures, store.closures)
        self.assertEqual(loaded.last_read, date(2026, 11, 20))
        self.assertEqual(loaded.page_modified, date(2026, 10, 12))
        self.assertEqual(loaded.latest_day, date(2026, 10, 31))

    def test_a_new_read_replaces_its_own_date_range_only(self):
        store = october_store()
        store.days[date(2026, 10, 5)] = DayEntry((Slot(60, 120),))  # stale booking the council removed
        store.days[date(2026, 8, 3)] = DayEntry((Slot(600, 660),))  # an older month stays
        from .helpers import october_html
        from parkbot.council import parse

        store.update(parse(october_html(), date(2026, 11, 21)), date(2026, 11, 21))
        self.assertEqual(texts(store.days[date(2026, 10, 5)].slots), ["16:00-17:00"])
        self.assertIn(date(2026, 8, 3), store.days)
        self.assertEqual(store.last_read, date(2026, 11, 21))

    def test_unchanged_file_is_not_rewritten(self):
        store = october_store()
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "council.json"
            store.save(path)
            first = path.stat().st_mtime_ns
            store.save(path)
            self.assertEqual(path.stat().st_mtime_ns, first)

    def test_damaged_files_start_fresh(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "state.json"
            path.write_text("{not json")
            self.assertEqual(State.load(path), State())
            self.assertEqual(CouncilStore.load(path).days, {})

    def test_state_round_trip(self):
        state = State(last_daily_post=date(2026, 11, 20), council_failures=2, council_error="the server answered 503")
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "state.json"
            state.save(path)
            self.assertEqual(State.load(path), state)


if __name__ == "__main__":
    unittest.main()
