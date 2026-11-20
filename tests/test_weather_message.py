import json
import unittest
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from parkbot import message, weather
from parkbot.council import DayEntry
from parkbot.status import plan_day, plan_days
from parkbot.store import CouncilStore
from parkbot.weather import HourRain, WeatherError, outlook

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


class DailyMessageTest(unittest.TestCase):
    def setUp(self):
        self.config = load_config()

    def test_usual_pattern_friday(self):
        plan = plan_day(FRIDAY, october_store(FRIDAY), seasons(), FRIDAY)
        forecast = weather.parse(forecast_json(FRIDAY, 2, chance=lambda day, hour: 40 if hour == 18 else 5))
        text = message.daily(plan, forecast, at(FRIDAY, 14, 45), self.config)
        self.assertEqual(
            text,
            "🐕 <b>Citizens Park oval · Fri 20 Nov</b>\n"
            "\n"
            "🟠 Usually booked 4 to 8 PM\n"
            "🟢 Usually free until 4 PM, then from 8 PM\n"
            "\n"
            "🌦 Slight chance of rain (40% around 6 PM).\n"
            "⚠️ Usual pattern only, not confirmed. The council's page only goes up to 31 October.\n"
            "\n"
            '<a href="https://example.org/park/">The week ahead and rain by the hour</a>',
        )

    def test_confirmed_day(self):
        day = date(2026, 10, 27)  # Tuesday
        plan = plan_day(day, october_store(day), seasons(), day)
        text = message.daily(plan, None, at(day, 14, 45), self.config)
        self.assertIn("🔴 Booked 4:15 to 7:30 PM\n🟢 Free until 4:15 PM, then from 7:30 PM", text)
        self.assertIn("❔ No rain forecast available.", text)
        self.assertIn("✅ From the council's schedule.", text)

    def test_saturday_match_in_progress(self):
        day = date(2026, 10, 24)
        plan = plan_day(day, october_store(day), seasons(), day)
        text = message.daily(plan, None, at(day, 15, 0), self.config)
        self.assertIn("🔴 Booked until 6 PM\n🟢 Free from 6 PM", text)

    def test_late_post_after_the_booking(self):
        day = date(2026, 10, 26)  # Monday, booked 4 to 5 PM
        plan = plan_day(day, october_store(day), seasons(), day)
        text = message.daily(plan, None, at(day, 17, 30), self.config)
        self.assertIn("🟢 Today's bookings have finished. The oval is free for the rest of the day.", text)

    def test_free_day(self):
        store = october_store(date(2026, 10, 27))
        store.days[date(2026, 10, 27)] = DayEntry()
        plan = plan_day(date(2026, 10, 27), store, seasons(), date(2026, 10, 27))
        text = message.daily(plan, None, at(date(2026, 10, 27), 14, 45), self.config)
        self.assertIn("🟢 No bookings today. The oval is free all day.", text)

    def test_closed_day_escapes_the_council_words(self):
        day = date(2026, 9, 20)
        store = october_store(day)
        plan = plan_day(day, store, seasons(), day)
        text = message.daily(plan, None, at(day, 14, 45), self.config)
        self.assertIn("⛔ The oval is closed today.", text)
        self.assertIn("Council notice: Due to turf improvement works", text)
        self.assertIn("✅ From a notice on the council's page.", text)

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
            '<a href="https://example.org/park/">Today and rain by the hour</a>',
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
        self.assertIn("✅ From the council's schedule.", text)
        self.assertNotIn("(usual)", text)


if __name__ == "__main__":
    unittest.main()
