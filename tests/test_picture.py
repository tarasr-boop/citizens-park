"""The pictures that go with the Telegram bot's alerts (parkbot/picture.py).

Most of these need no browser. The last ones draw real pictures, and are
skipped on a computer without Google Chrome or Chromium. GitHub's runners
have Chrome.
"""

from __future__ import annotations

import json
import os
import shutil
import struct
import tempfile
import unittest
from datetime import date, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from parkbot import bot, picture, site, weather
from parkbot.status import plan_days

from .helpers import forecast_json, load_config, october_store, seasons

ZONE = ZoneInfo("Australia/Melbourne")
FRIDAY = date(2026, 10, 23)  # booked 4 to 8 PM; Saturday the 24th is booked 10 AM to 6 PM
NO_BROWSER = {"CHROME": "/nowhere/chrome", "PATH": ""}


def at(day: date, hour: int, minute: int = 0) -> datetime:
    return datetime(day.year, day.month, day.day, hour, minute, tzinfo=ZONE)


def rain(day: date, hour: int) -> float:
    return {15: 0.4, 16: 2.5, 17: 1.1}.get(hour, 0.0) if day == FRIDAY else 0.0


class SiteTest(unittest.TestCase):
    """Builds the page in a scratch folder, as the daily check does at 2:47 PM on a Friday."""

    def setUp(self):
        self._folder = tempfile.TemporaryDirectory()
        self.addCleanup(self._folder.cleanup)
        self.config = load_config()
        self.plans = plan_days(FRIDAY, 8, october_store(FRIDAY), seasons(), self.config.day_start, self.config.lights_off)
        forecast = weather.parse(forecast_json(FRIDAY, 8, chance=lambda day, hour: 80 if hour in (15, 16, 17) else 5, mm=rain))
        self.site = site.build(self.config, self.plans, forecast, october_store(FRIDAY), at(FRIDAY, 14, 47), Path(self._folder.name) / "site", Path(self._folder.name) / "none")
        self.words = (self.site / bot.FILE).read_text(encoding="utf-8")

    def alerts(self) -> dict:
        return json.loads((self.site / bot.FILE).read_text(encoding="utf-8"))


class MomentTest(unittest.TestCase):
    def test_each_alert_is_drawn_at_the_moment_its_words_are_written_for(self):
        made = datetime(2026, 10, 23, 14, 47, tzinfo=ZONE)
        entry = lambda sent_on, hour, about: {"date": sent_on, "hour": hour, "about": about}  # noqa: E731
        # An hour still to come: that hour.
        self.assertEqual(picture.moment(entry("2026-10-23", 16, "2026-10-23"), made), "?now=2026-10-23T16:00&card=2026-10-23")
        # The hour that has begun: the moment the words were written, as they say "until 8 PM" from then.
        self.assertEqual(picture.moment(entry("2026-10-23", 14, "2026-10-23"), made), "?now=2026-10-23T14:47&card=2026-10-23")
        # The evening before: the next day, whole.
        self.assertEqual(picture.moment(entry("2026-10-23", 21, "2026-10-24"), made), "?now=2026-10-23T21:00&card=2026-10-24")
        # Tomorrow's hours, in case no check runs before them.
        self.assertEqual(picture.moment(entry("2026-10-24", 8, "2026-10-24"), made), "?now=2026-10-24T08:00&card=2026-10-24")

    def test_the_words_and_the_picture_agree_on_that_moment(self):
        made = at(FRIDAY, 14, 47)
        self.assertEqual(bot.written_at(FRIDAY, 14, False, made), made)
        self.assertEqual(bot.written_at(FRIDAY, 16, False, made), at(FRIDAY, 16))
        self.assertEqual(bot.written_at(FRIDAY, 21, True, made), at(FRIDAY, 21))


class CardPageTest(SiteTest):
    def test_the_card_page_is_the_pages_own_style_and_script_with_the_font(self):
        data = json.loads((self.site / "data.json").read_text(encoding="utf-8"))
        data["days"][0]["label"] = "</script><script>alert(1)</script>"
        page = picture.card_page(data)
        self.assertIn((site.WEB / "page.css").read_text(encoding="utf-8"), page)
        self.assertIn((site.WEB / "page.js").read_text(encoding="utf-8"), page)
        self.assertIn("src: url(data:font/woff2;base64,d09GMg", page)  # "wOF2", the start of every woff2 font
        self.assertNotIn("{{", page)
        # Words from outside cannot end the data block early.
        self.assertNotIn("</script><script>alert(1)", page)
        self.assertEqual(page.count("<script"), 2)
        # The picture talks to nothing: no backend for notifications, so nothing is counted either.
        block = page[page.index('<script id="park-data" type="application/json">') :]
        drawn_data = json.loads(block[block.index(">") + 1 : block.index("</script>")])
        self.assertIsNone(drawn_data["push"])
        self.assertEqual(drawn_data["days"], data["days"])

    def test_the_font_comes_with_its_licence(self):
        self.assertTrue((site.WEB / "card-font.woff2").read_bytes().startswith(b"wOF2"))
        licence = (site.WEB / "card-font-licence.txt").read_text(encoding="utf-8")
        self.assertIn("SIL Open Font License, Version 1.1", licence)
        self.assertIn("The Inter Project Authors", licence)


class WithoutABrowserTest(SiteTest):
    def test_the_browser_is_found_by_name_or_where_chrome_says(self):
        self.assertIsNone(picture.find_browser(NO_BROWSER))
        self.assertIsNone(picture.find_browser({"PATH": ""}))
        here = shutil.which("python3")
        self.assertEqual(picture.find_browser({"CHROME": here, "PATH": ""}), here)

    def test_without_a_browser_the_alerts_go_without_pictures(self):
        # A picture left over from an earlier build in the same folder goes.
        (self.site / picture.FOLDER).mkdir()
        (self.site / picture.FOLDER / "0123456789abcdef.png").write_bytes(b"old")
        said = picture.add(self.site, NO_BROWSER)
        self.assertEqual(said, "none drawn, there is no browser on this computer (the bot sends the words alone)")
        self.assertEqual((self.site / bot.FILE).read_text(encoding="utf-8"), self.words)
        self.assertEqual(list((self.site / picture.FOLDER).iterdir()), [])

    def test_a_browser_that_fails_leaves_the_alerts_as_they_were(self):
        script = Path(self._folder.name) / "broken-chrome"
        script.write_text("#!/bin/sh\necho 'cannot open display' >&2\nexit 1\n", encoding="utf-8")
        script.chmod(0o755)
        with self.assertRaises(picture.PictureError) as caught:
            picture.add(self.site, {"CHROME": str(script), "PATH": ""})
        self.assertRegex(str(caught.exception), r"^the browser (stopped|could not be reached)")
        self.assertIn("cannot open display", str(caught.exception))
        self.assertEqual((self.site / bot.FILE).read_text(encoding="utf-8"), self.words)
        self.assertNotIn("image", self.words)

    def test_no_alerts_nothing_to_draw(self):
        empty = self.alerts()
        empty["alerts"] = []
        (self.site / bot.FILE).write_text(json.dumps(empty), encoding="utf-8")
        self.assertEqual(picture.add(self.site, NO_BROWSER), "no alerts to draw")


def png_size(path: Path) -> tuple[int, int]:
    head = path.read_bytes()[:24]
    assert head[:8] == b"\x89PNG\r\n\x1a\n", "not a PNG"
    return struct.unpack(">II", head[16:24])


@unittest.skipUnless(picture.find_browser(os.environ), "Google Chrome or Chromium is needed to draw the pictures")
class DrawingTest(SiteTest):
    def test_every_alert_gets_a_picture_next_to_the_page(self):
        said = picture.add(self.site)
        made = self.alerts()
        entries = made["alerts"]
        files = sorted((self.site / picture.FOLDER).glob("*.png"))
        self.assertEqual(said, f"{len(files)} drawn for {len(entries)} of {len(entries)} alerts")
        for entry in entries:
            self.assertRegex(entry["image"], r"^alerts/[0-9a-f]{16}\.png$")
            self.assertTrue((self.site / entry["image"]).is_file(), entry["image"])
        # Nothing else in the file has changed.
        before = json.loads(self.words)
        self.assertEqual([{key: value for key, value in entry.items() if key != "image"} for entry in entries], before["alerts"])
        self.assertEqual(made["generated"], before["generated"])

        by_hour = {(entry["date"], entry["hour"]): self.site / entry["image"] for entry in entries}
        width, height = png_size(by_hour[("2026-10-23", 16)])
        self.assertEqual(width, picture.WIDTH * picture.SCALE)
        self.assertTrue(height * 0.6 < width < height * 1.5, (width, height))
        # Each hour of the day has the "now" line in a place of its own.
        self.assertNotEqual(by_hour[("2026-10-23", 16)].read_bytes(), by_hour[("2026-10-23", 17)].read_bytes())
        # The three evening alerts are about the whole of Saturday: the same picture, kept once.
        evening = {by_hour[("2026-10-23", hour)] for hour in (21, 22, 23)}
        self.assertEqual(len(evening), 1)
        self.assertLess(len(files), len(entries))
        # Saturday's picture has no answer at the top, so it is less tall than Friday's.
        self.assertLess(png_size(evening.pop())[1], height)

    def test_drawing_again_replaces_the_pictures(self):
        picture.add(self.site)
        first = sorted(path.name for path in (self.site / picture.FOLDER).iterdir())
        (self.site / picture.FOLDER / "0000000000000000.png").write_bytes(b"old")
        # The site is built again, as the next check does, and drawn again.
        (self.site / bot.FILE).write_text(self.words, encoding="utf-8")
        picture.add(self.site)
        self.assertEqual(sorted(path.name for path in (self.site / picture.FOLDER).iterdir()), first)


if __name__ == "__main__":
    unittest.main()
