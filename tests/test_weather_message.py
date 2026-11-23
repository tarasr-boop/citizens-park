import json
import unittest
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from parkbot import message, weather
from parkbot.council import DayEntry
from parkbot.status import plan_day, plan_days
from parkbot.store import CouncilStore
from parkbot.timeparse import Slot
from parkbot.weather import HourRain, WeatherError, Window, best_window, outlook

from .helpers import forecast_json, load_config, october_store, seasons

ZONE = ZoneInfo("Australia/Melbourne")
FRIDAY = date(2026, 11, 20)


def at(day: date, hour: int, minute: int = 0) -> datetime:
    return datetime(day.year, day.month, day.day, hour, minute, tzinfo=ZONE)


def hours(chances: dict[int, int], mm: dict[int, float] | None = None) -> list[HourRain]:
    mm = mm or {}
    return [HourRain(hour, chances.get(hour, 0), mm.get(hour, 0.0)) for hour in range(24)]


class ForecastParseTest(unittest.TestCase):
    def test_values_are_filed_under_the_hour_they_describe(self):
        text = forecast_json(
            FRIDAY, 2, chance=lambda day, hour: 80 if (day, hour) == (FRIDAY, 17) else 5, mm=lambda day, hour: 2.5 if (day, hour) == (FRIDAY, 17) else 0.0
        )
        forecast = weather.parse(text)
        five_pm = next(hour for hour in forecast.hours[FRIDAY] if hour.hour == 17)
        self.assertEqual((five_pm.chance, five_pm.mm), (80, 2.5))
        four_pm = next(hour for hour in forecast.hours[FRIDAY] if hour.hour == 16)
        self.assertEqual((four_pm.chance, four_pm.mm), (5, 0.0))
        self.assertEqual(set(forecast.hours), {FRIDAY, FRIDAY + timedelta(days=1)})
        self.assertEqual(len(forecast.hours[FRIDAY]), 24)

    def test_daily_values(self):
        forecast = weather.parse(forecast_json(FRIDAY, 3, chance=lambda day, hour: 70 if day == FRIDAY else 10, mm=lambda day, hour: 0.5))
        self.assertEqual(forecast.days[FRIDAY].chance, 70)
        self.assertEqual(forecast.days[FRIDAY].mm, 12.0)
        self.assertEqual(forecast.days[FRIDAY + timedelta(days=2)].chance, 10)

    def test_missing_values_are_tolerated(self):
        payload = json.loads(forecast_json(FRIDAY, 1))
        payload["hourly"]["precipitation_probability"][5] = None
        payload["hourly"]["precipitation"][5] = None
        del payload["daily"]
        forecast = weather.parse(json.dumps(payload))
        self.assertIsNone(forecast.hours[FRIDAY][4].chance)
        self.assertEqual(forecast.days[FRIDAY].chance, 0)

    def test_bad_replies_raise(self):
        for text in ("not json", "[]", '{"error": true, "reason": "bad latitude"}', '{"hourly": {}}', '{"hourly": {"time": []}}'):
            with self.subTest(text=text):
                with self.assertRaises(WeatherError):
                    weather.parse(text)

    def test_url(self):
        address = weather.url(-37.8146, 144.999, "Australia/Melbourne")
        self.assertTrue(address.startswith("https://api.open-meteo.com/v1/forecast?"))
        self.assertIn("latitude=-37.8146", address)
        self.assertIn("timezone=Australia%2FMelbourne", address)
        self.assertIn("hourly=precipitation_probability%2Cprecipitation", address)
        self.assertNotIn("models=", address)


class OutlookTest(unittest.TestCase):
    def test_dry(self):
        look = outlook(hours({15: 5, 18: 10}), 15 * 60)
        self.assertEqual((look.level, look.text), ("dry", "No rain expected for the rest of today."))

    def test_slight(self):
        look = outlook(hours({18: 40}), 15 * 60)
        self.assertEqual((look.level, look.text), ("slight", "Slight chance of rain (40% around 6 PM)."))

    def test_likely_later(self):
        look = outlook(hours({17: 60, 18: 80, 19: 55}, {17: 1.0, 18: 2.2}), 15 * 60)
        self.assertEqual(look.text, "Rain likely between 5 PM and 8 PM (up to 80%, about 3 mm).")

    def test_likely_now_until(self):
        look = outlook(hours({15: 90, 16: 70}, {15: 0.2}), 15 * 60 + 10)
        self.assertEqual(look.text, "Rain likely until about 5 PM (up to 90%, under 1 mm).")

    def test_likely_from_and_all_evening(self):
        look = outlook(hours({hour: 75 for hour in range(19, 24)}), 15 * 60)
        self.assertEqual(look.text, "Rain likely from about 7 PM (up to 75%).")
        look = outlook(hours({hour: 75 for hour in range(0, 24)}, {hour: 1.0 for hour in range(24)}), 15 * 60)
        self.assertEqual(look.text, "Rain likely for the rest of today (up to 75%, about 7 mm).")

    def test_two_wet_spells(self):
        look = outlook(hours({15: 60, 19: 70}), 15 * 60)
        self.assertEqual(look.text, "Rain likely until about 4 PM (up to 70%). More from about 7 PM.")

    def test_morning_rain_is_not_mentioned_in_the_afternoon(self):
        look = outlook(hours({9: 95}), 15 * 60)
        self.assertEqual(look.level, "dry")

    def test_no_data(self):
        self.assertEqual(outlook(None, 15 * 60).level, "unknown")
        self.assertEqual(outlook(hours({}), 23 * 60).level, "unknown")


class BestWindowTest(unittest.TestCase):
    """The best part of the free time for staying out of the rain, between 5 and 9 PM."""

    EVENING = (17 * 60, 21 * 60)
    ALL_FREE = [EVENING]

    def best(self, chances, mm, free=None, first=17 * 60, last=21 * 60):
        return best_window(hours(chances, mm), self.ALL_FREE if free is None else free, first, last)

    def test_nothing_to_say_on_a_dry_evening(self):
        self.assertIsNone(self.best({}, {}))
        # Rain earlier in the day, or after 9 PM, does not count.
        self.assertIsNone(self.best({10: 90, 16: 90, 21: 90}, {10: 3.0, 16: 2.0, 21: 4.0}))
        # A small chance with nothing measurable is still a dry hour.
        self.assertIsNone(self.best({18: 40}, {}))

    def test_the_dry_stretch_after_the_rain(self):
        window = self.best({17: 90, 18: 80}, {17: 2.0, 18: 1.0})
        self.assertEqual(window, Window(19 * 60, 21 * 60, True))

    def test_the_dry_stretch_before_the_rain(self):
        window = self.best({19: 70, 20: 90}, {19: 0.5, 20: 3.0})
        self.assertEqual(window, Window(17 * 60, 19 * 60, True))

    def test_the_longer_of_two_dry_stretches(self):
        window = self.best({18: 90}, {18: 2.0})
        self.assertEqual(window, Window(19 * 60, 21 * 60, True))

    def test_between_equal_dry_stretches_the_earlier_one(self):
        window = self.best({18: 90, 19: 90}, {18: 2.0, 19: 2.0})
        self.assertEqual(window, Window(17 * 60, 18 * 60, True))

    def test_likely_rain_is_not_dry_even_with_nothing_measurable(self):
        window = self.best({17: 60}, {})
        self.assertEqual(window, Window(18 * 60, 21 * 60, True))

    def test_only_free_time_is_offered(self):
        # Booked 4 to 8 PM. The dry hours at 5 and 6 PM are no use to a dog.
        window = self.best({19: 90, 20: 30}, {19: 2.0}, free=[(20 * 60, 21 * 60)])
        self.assertEqual(window, Window(20 * 60, 21 * 60, True))

    def test_free_time_that_starts_on_the_half_hour(self):
        # Booked 4:15 to 7:30 PM, raining until 7.
        window = self.best({17: 90, 18: 90}, {17: 2.0, 18: 2.0}, free=[(19 * 60 + 30, 21 * 60)])
        self.assertEqual(window, Window(19 * 60 + 30, 21 * 60, True))

    def test_with_no_dry_hour_the_lightest_rain(self):
        window = self.best({17: 90, 18: 95, 19: 85, 20: 60}, {17: 0.9, 18: 4.2, 19: 1.2, 20: 0.2})
        self.assertEqual(window, Window(20 * 60, 21 * 60, False))

    def test_hours_much_like_the_lightest_join_it(self):
        window = self.best({17: 90, 18: 90, 19: 90, 20: 90}, {17: 0.3, 18: 0.2, 19: 0.4, 20: 2.0})
        self.assertEqual(window, Window(17 * 60, 20 * 60, False))

    def test_wet_free_time_is_offered_even_when_the_booked_hours_are_dry(self):
        window = self.best({20: 90}, {20: 3.0}, free=[(20 * 60, 21 * 60)])
        self.assertEqual(window, Window(20 * 60, 21 * 60, False))

    def test_nothing_when_nothing_is_free(self):
        self.assertIsNone(self.best({18: 90}, {18: 2.0}, free=[]))
        # A quarter of an hour between two bookings is not a window.
        self.assertIsNone(self.best({18: 90}, {18: 2.0}, free=[(17 * 60, 17 * 60 + 15)]))

    def test_a_late_post_looks_only_at_what_is_left(self):
        window = self.best({19: 90}, {19: 2.0}, free=[(18 * 60 + 20, 21 * 60)], first=18 * 60 + 20)
        self.assertEqual(window, Window(20 * 60, 21 * 60, True))
        self.assertIsNone(self.best({19: 90}, {19: 2.0}, free=[], first=21 * 60 + 5))

    def test_nothing_without_a_forecast_for_the_evening(self):
        self.assertIsNone(best_window(None, self.ALL_FREE, *self.EVENING))
        self.assertIsNone(best_window([], self.ALL_FREE, *self.EVENING))
        partly = [hour for hour in hours({18: 90}, {18: 2.0}) if hour.hour != 20]
        self.assertIsNone(best_window(partly, self.ALL_FREE, *self.EVENING))
        blank = [HourRain(hour, None, None) for hour in range(24)]
        self.assertIsNone(best_window(blank, self.ALL_FREE, *self.EVENING))


class DailyMessageTest(unittest.TestCase):
    def setUp(self):
        self.config = load_config()

    def rainy(self, day, mm_by_hour, chance=90):
        """A forecast with rain in the given hours of ``day`` and none in the others."""
        return weather.parse(
            forecast_json(
                day,
                1,
                chance=lambda d, hour: chance if hour in mm_by_hour else 5,
                mm=lambda d, hour: mm_by_hour.get(hour, 0.0),
            )
        )

    def test_a_rainy_evening_names_the_best_window(self):
        # Friday 30 October is booked 4 to 8 PM. Rain from 3 to 8 PM, then dry.
        day = date(2026, 10, 30)
        plan = plan_day(day, october_store(day), seasons(), day)
        forecast = self.rainy(day, {15: 0.3, 16: 4.6, 17: 0.9, 18: 4.2, 19: 1.2})
        text = message.daily(plan, forecast, at(day, 14, 44), self.config)
        self.assertEqual(
            text,
            "🐕 <b>Citizens Park oval</b>\n"
            "\n"
            "🔴 Booked 4 to 8 PM\n"
            "\n"
            "🌧 Rain likely between 3 PM and 8 PM (up to 90%, about 11 mm).\n"
            "Heavy rain can cancel training, so the oval may free up early.\n"
            "Based on the hourly forecast, the best window to avoid the rain is 8 to 9 PM.\n"
            "\n"
            '<a href="https://example.org/park/">Press here for the week ahead and rain by the hour</a>',
        )

    def test_when_the_best_window_is_wet_too_the_post_says_so(self):
        day = date(2026, 10, 30)
        plan = plan_day(day, october_store(day), seasons(), day)
        forecast = self.rainy(day, {16: 4.6, 17: 0.9, 18: 4.2, 19: 1.2, 20: 0.2})
        text = message.daily(plan, forecast, at(day, 14, 44), self.config)
        self.assertIn("\nBased on the hourly forecast, the best window to avoid the rain is 8 to 9 PM, though it may still rain then.\n", text)

    def test_the_window_is_chosen_from_the_time_that_is_not_booked(self):
        # Tuesday 27 October is booked 4:15 to 7:30 PM. It is dry at 5 PM, but the oval is taken then.
        day = date(2026, 10, 27)
        plan = plan_day(day, october_store(day), seasons(), day)
        text = message.daily(plan, self.rainy(day, {18: 2.0, 19: 1.0}), at(day, 14, 45), self.config)
        self.assertIn("the best window to avoid the rain is 8 to 9 PM.", text)

    def test_no_window_on_a_dry_evening(self):
        day = date(2026, 10, 27)
        plan = plan_day(day, october_store(day), seasons(), day)
        for forecast in (self.rainy(day, {}), self.rainy(day, {9: 3.0, 15: 2.0}), None):
            with self.subTest(forecast=forecast):
                self.assertNotIn("best window", message.daily(plan, forecast, at(day, 14, 45), self.config))

    def test_no_window_when_the_oval_is_booked_all_evening_or_closed(self):
        day = date(2026, 10, 27)
        store = october_store(day)
        store.days[day] = DayEntry((Slot(16 * 60, 21 * 60),))
        plan = plan_day(day, store, seasons(), day)
        self.assertNotIn("best window", message.daily(plan, self.rainy(day, {18: 2.0}), at(day, 14, 45), self.config))
        closed = date(2026, 9, 20)
        plan = plan_day(closed, october_store(closed), seasons(), closed)
        self.assertNotIn("best window", message.daily(plan, self.rainy(closed, {18: 2.0}), at(closed, 14, 45), self.config))

    def test_a_day_with_no_bookings_gets_the_window_too(self):
        day = date(2026, 10, 27)
        store = october_store(day)
        store.days[day] = DayEntry()
        plan = plan_day(day, store, seasons(), day)
        text = message.daily(plan, self.rainy(day, {17: 2.0, 18: 1.0}), at(day, 14, 45), self.config)
        self.assertIn("🟢 No bookings today.\n", text)
        self.assertIn("the best window to avoid the rain is 7 to 9 PM.", text)

    def test_a_late_post_counts_the_window_from_now(self):
        day = date(2026, 10, 26)  # Monday, booked 4 to 5 PM
        plan = plan_day(day, october_store(day), seasons(), day)
        text = message.daily(plan, self.rainy(day, {19: 2.0, 20: 2.0}), at(day, 17, 40), self.config)
        self.assertIn("the best window to avoid the rain is from now until 7 PM.", text)

    def test_the_hours_for_the_window_are_settings(self):
        day = date(2026, 10, 27)
        store = october_store(day)
        store.days[day] = DayEntry()
        plan = plan_day(day, store, seasons(), day)
        early = load_config(advice_from=15 * 60, advice_until=18 * 60)
        text = message.daily(plan, self.rainy(day, {15: 2.0, 20: 5.0}), at(day, 14, 45), early)
        self.assertIn("the best window to avoid the rain is 4 to 6 PM.", text)

    def test_usual_pattern_friday(self):
        plan = plan_day(FRIDAY, october_store(FRIDAY), seasons(), FRIDAY)
        forecast = weather.parse(forecast_json(FRIDAY, 2, chance=lambda day, hour: 40 if hour == 18 else 5))
        text = message.daily(plan, forecast, at(FRIDAY, 14, 45), self.config)
        self.assertEqual(
            text,
            "🐕 <b>Citizens Park oval</b>\n"
            "\n"
            "🟠 Usually booked 4 to 8 PM\n"
            "\n"
            "🌦 Slight chance of rain (40% around 6 PM).\n"
            "⚠️ Usual pattern only, not confirmed. The council's page only goes up to 31 October.\n"
            "\n"
            '<a href="https://example.org/park/">Press here for the week ahead and rain by the hour</a>',
        )

    def test_confirmed_day(self):
        day = date(2026, 10, 27)  # Tuesday
        plan = plan_day(day, october_store(day), seasons(), day)
        text = message.daily(plan, None, at(day, 14, 45), self.config)
        self.assertEqual(
            text,
            "🐕 <b>Citizens Park oval</b>\n"
            "\n"
            "🔴 Booked 4:15 to 7:30 PM\n"
            "\n"
            "❔ No rain forecast available.\n"
            "\n"
            '<a href="https://example.org/park/">Press here for the week ahead and rain by the hour</a>',
        )

    def test_the_post_says_what_is_booked_and_leaves_the_rest_unsaid(self):
        day = date(2026, 10, 27)
        plan = plan_day(day, october_store(day), seasons(), day)
        text = message.daily(plan, None, at(day, 14, 45), self.config)
        self.assertNotIn("Free", text)  # the free times follow from the booked ones
        self.assertNotIn("council's schedule", text)  # only a doubt is worth a line
        self.assertNotIn("✅", text)
        self.assertNotIn("27 Oct", text)  # Telegram shows the date itself
        self.assertNotIn("Tue", text)

    def test_old_council_times_carry_a_warning(self):
        day = date(2026, 10, 27)
        plan = plan_day(day, october_store(date(2026, 10, 24)), seasons(), day)
        text = message.daily(plan, None, at(day, 14, 45), self.config)
        self.assertIn("🔴 Booked 4:15 to 7:30 PM\n", text)
        self.assertIn("\n⚠️ From the council's schedule, last read on Sat 24 Oct.\n", text)

    def test_saturday_match_in_progress(self):
        day = date(2026, 10, 24)
        plan = plan_day(day, october_store(day), seasons(), day)
        text = message.daily(plan, None, at(day, 15, 0), self.config)
        self.assertIn("🔴 Booked until 6 PM\n\n", text)
        self.assertNotIn("Free", text)

    def test_late_post_after_the_booking(self):
        day = date(2026, 10, 26)  # Monday, booked 4 to 5 PM
        plan = plan_day(day, october_store(day), seasons(), day)
        text = message.daily(plan, None, at(day, 17, 30), self.config)
        self.assertIn("🟢 Today's bookings have finished.\n", text)
        self.assertNotIn("free", text)

    def test_free_day(self):
        store = october_store(date(2026, 10, 27))
        store.days[date(2026, 10, 27)] = DayEntry()
        plan = plan_day(date(2026, 10, 27), store, seasons(), date(2026, 10, 27))
        text = message.daily(plan, None, at(date(2026, 10, 27), 14, 45), self.config)
        self.assertIn("🟢 No bookings today.\n", text)
        self.assertNotIn("free", text)

    def test_closed_day_escapes_the_council_words(self):
        day = date(2026, 9, 20)
        store = october_store(day)
        plan = plan_day(day, store, seasons(), day)
        text = message.daily(plan, None, at(day, 14, 45), self.config)
        self.assertIn("⛔ The oval is closed today.", text)
        self.assertIn("Council notice: Due to turf improvement works", text)
        self.assertNotIn("From a notice", text)  # the notice itself is already quoted
        self.assertNotIn("✅", text)

    def test_label_with_markup_is_escaped(self):
        store = CouncilStore()
        store.days[FRIDAY] = DayEntry((), "<b>Maintenance</b> & mowing")
        store.last_read = FRIDAY
        plan = plan_day(FRIDAY, store, seasons(), FRIDAY)
        text = message.daily(plan, None, at(FRIDAY, 14, 45), self.config)
        self.assertIn("⚠️ Listed for today: &lt;b&gt;Maintenance&lt;/b&gt; &amp; mowing. The oval may be closed.", text)

    def test_nothing_known(self):
        plan = plan_day(FRIDAY, CouncilStore(), [], FRIDAY)
        text = message.daily(plan, None, at(FRIDAY, 14, 45), self.config)
        self.assertIn("❔ No booking information for today. Check the signs at the park.", text)
        self.assertNotIn("✅", text)
        self.assertNotIn("⚠️", text)

    def test_the_line_under_the_bots_picture_names_the_park_and_only_what_is_booked(self):
        def line(day, store, hour, minute=0, ahead=False, pattern=None):
            plan = plan_day(day, store, seasons() if pattern is None else pattern, day)
            text = message.caption(plan, at(day, hour, minute), self.config, ahead=ahead)
            head, link = text.split("\n")
            self.assertEqual(link, '<a href="https://example.org/park/">Press here for the week ahead and rain by the hour</a>')
            self.assertTrue(head.startswith("<b>") and head.endswith("</b>"), head)
            return head[3:-4]

        tuesday = date(2026, 10, 27)  # booked 4:15 to 7:30 PM
        self.assertEqual(line(tuesday, october_store(tuesday), 10), "🔴 Citizens Park oval booked 4:15 to 7:30 PM")
        self.assertEqual(line(tuesday, october_store(tuesday), 17, 5), "🔴 Citizens Park oval booked until 7:30 PM")
        self.assertEqual(line(tuesday, october_store(tuesday), 21, ahead=True), "🔴 Citizens Park oval booked 4:15 to 7:30 PM tomorrow")
        self.assertEqual(line(tuesday, october_store(tuesday), 19, 45), "🟢 Today's bookings at Citizens Park oval have finished")
        self.assertEqual(line(FRIDAY, october_store(FRIDAY), 10), "🟠 Citizens Park oval usually booked 4 to 8 PM")
        self.assertEqual(line(FRIDAY, october_store(FRIDAY), 20, 30), "🟢 The usual booking time at Citizens Park oval has passed")

        free = october_store(tuesday)
        free.days[tuesday] = DayEntry()
        self.assertEqual(line(tuesday, free, 10), "🟢 No bookings at Citizens Park oval today")
        self.assertEqual(line(tuesday, free, 21, ahead=True), "🟢 No bookings at Citizens Park oval tomorrow")
        closed = date(2026, 9, 20)
        self.assertEqual(line(closed, october_store(closed), 10), "⛔ Citizens Park oval closed today")
        self.assertEqual(line(FRIDAY, CouncilStore(), 10, pattern=[]), "❔ No booking information for Citizens Park oval today")
        listed = CouncilStore()
        listed.days[FRIDAY] = DayEntry((), "<b>Maintenance</b> & mowing")
        listed.last_read = FRIDAY
        self.assertEqual(line(FRIDAY, listed, 10), "⚠️ Citizens Park oval may be closed today (&lt;b&gt;Maintenance&lt;/b&gt; &amp; mowing)")

    def test_heavy_rain_hint(self):
        plan = plan_day(FRIDAY, october_store(FRIDAY), seasons(), FRIDAY)
        forecast = weather.parse(forecast_json(FRIDAY, 1, chance=lambda day, hour: 90, mm=lambda day, hour: 2.0))
        text = message.daily(plan, forecast, at(FRIDAY, 14, 45), self.config)
        self.assertIn("🌧 Rain likely for the rest of today (up to 90%, about 16 mm).", text)
        self.assertIn("Heavy rain can cancel training, so the oval may free up early.", text)

    def test_weekend_overrun_hint(self):
        day = date(2026, 10, 24)  # Saturday, booked until 6 PM
        plan = plan_day(day, october_store(day), seasons(), day)
        forecast = weather.parse(forecast_json(day, 1, chance=lambda d, hour: 60 if hour in (15, 16) else 0, mm=lambda d, hour: 0.4 if hour in (15, 16) else 0.0))
        text = message.daily(plan, forecast, at(day, 15, 0), self.config)
        self.assertIn("After rain delays, weekend matches can run until 7:30 PM.", text)

    def test_no_hints_on_a_dry_day(self):
        plan = plan_day(FRIDAY, october_store(FRIDAY), seasons(), FRIDAY)
        forecast = weather.parse(forecast_json(FRIDAY, 1))
        text = message.daily(plan, forecast, at(FRIDAY, 14, 45), self.config)
        self.assertNotIn("Heavy rain", text)
        self.assertNotIn("rain delays", text)

    def test_message_fits_telegram(self):
        plan = plan_day(FRIDAY, october_store(FRIDAY), seasons(), FRIDAY)
        self.assertLess(len(message.daily(plan, None, at(FRIDAY, 14, 45), self.config)), 4096)


class WeeklyMessageTest(unittest.TestCase):
    def setUp(self):
        self.config = load_config()

    def test_all_usual(self):
        sunday = date(2026, 11, 22)
        plans = plan_days(sunday, 8, october_store(sunday), seasons())[1:]
        forecast = weather.parse(forecast_json(sunday, 8, chance=lambda day, hour: 70 if day == date(2026, 11, 24) else 10))
        text = message.weekly(plans, forecast, self.config)
        self.assertEqual(
            text,
            "📅 <b>Citizens Park oval · the week ahead</b>\n"
            "\n"
            "Booked times:\n"
            "Mon 23 Nov: 4 to 5 PM\n"
            "Tue 24 Nov: 4:15 to 7:30 PM · 🌧 70%\n"
            "Wed 25 Nov: 4:15 to 7:30 PM\n"
            "Thu 26 Nov: 5:15 to 7:30 PM\n"
            "Fri 27 Nov: 4 to 8 PM\n"
            "Sat 28 Nov: 10 AM to 6 PM\n"
            "Sun 29 Nov: 11 AM to 5 PM\n"
            "\n"
            "⚠️ Usual pattern only, not confirmed. The council's page only goes up to 31 October.\n"
            "Dogs can use the oval outside these times.\n"
            "\n"
            '<a href="https://example.org/park/">Press here for today and rain by the hour</a>',
        )

    def test_mixed_week_marks_the_unconfirmed_days(self):
        sunday = date(2026, 10, 25)
        plans = plan_days(sunday, 8, october_store(sunday), seasons())[1:]
        text = message.weekly(plans, None, self.config)
        self.assertIn("Sat 31 Oct: 10 AM to 6 PM\n", text)
        self.assertIn("Sun 1 Nov: 11 AM to 5 PM (usual)\n", text)
        self.assertIn("Days marked (usual) follow the usual pattern", text)

    def test_confirmed_week(self):
        sunday = date(2026, 10, 18)
        plans = plan_days(sunday, 8, october_store(sunday), seasons())[1:]
        text = message.weekly(plans, None, self.config)
        self.assertNotIn("council's schedule", text)
        self.assertNotIn("✅", text)
        self.assertNotIn("⚠️", text)
        self.assertNotIn("(usual)", text)
        self.assertIn("Sun 25 Oct: 11 AM to 5 PM\n\nDogs can use the oval outside these times.\n", text)

    def test_a_week_from_an_old_copy_carries_a_warning(self):
        sunday = date(2026, 10, 18)
        plans = plan_days(sunday, 8, october_store(date(2026, 10, 15)), seasons())[1:]
        text = message.weekly(plans, None, self.config)
        self.assertIn("\n\n⚠️ From the council's schedule, last read on Thu 15 Oct.\nDogs can use the oval outside these times.\n", text)


if __name__ == "__main__":
    unittest.main()
