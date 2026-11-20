import base64
import hashlib
import json
import re
import tempfile
import unittest
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from parkbot import site, weather
from parkbot.status import DayPlan, plan_days
from parkbot.store import CouncilStore
from parkbot.timeparse import Slot

from .helpers import ROOT, forecast_json, load_config, october_store, seasons

MELBOURNE = ZoneInfo("Australia/Melbourne")
FRIDAY = date(2026, 11, 20)


def plans_from(first: date, store: CouncilStore | None = None, count: int = 8) -> list[DayPlan]:
    config = load_config()
    return plan_days(first, count, store or october_store(first), seasons(), config.day_start, config.lights_off)


def afternoon(day: date) -> datetime:
    return datetime(day.year, day.month, day.day, 14, 45, tzinfo=MELBOURNE)


class BuildTest(unittest.TestCase):
    def setUp(self):
        self._folder = tempfile.TemporaryDirectory()
        self.addCleanup(self._folder.cleanup)
        self.out = Path(self._folder.name) / "site"

    def build(self, config=None, plans=None, forecast=None, day: date = FRIDAY, store: CouncilStore | None = None) -> str:
        """Build the site and return the text of its main page. The council's page was read at 2:45 PM that day."""
        config = config or load_config()
        plans = plans or plans_from(day)
        store = store or october_store(day, afternoon(day))
        site.build(config, plans, forecast, store, afternoon(day), self.out, ROOT / "assets")
        return (self.out / "index.html").read_text(encoding="utf-8")

    def embedded_data(self, page: str) -> dict:
        found = re.search(r'<script id="park-data" type="application/json">(.*?)</script>', page, re.DOTALL)
        self.assertIsNotNone(found, "the page should carry its data")
        return json.loads(found.group(1))

    def test_writes_every_file_the_page_needs(self):
        self.build()
        names = {item.name for item in self.out.iterdir()}
        for wanted in (
            "index.html",
            "data.json",
            "manifest.webmanifest",
            "qr.svg",
            "favicon.svg",
            "icon-192.png",
            "icon-512.png",
            "icon-maskable-512.png",
            "apple-touch-icon.png",
        ):
            self.assertIn(wanted, names)
        # The note about what the QR code holds is for the repository, not the public.
        self.assertNotIn("qr-url.txt", names)
        self.assertNotIn("poster.html", names)

    def test_no_template_marker_is_left_behind(self):
        with_everything = load_config(
            site_name="Citizens Bark", tip_url="https://ko-fi.com/example", about_text="Hello.", about_link="https://example.org/me"
        )
        for config in (load_config(), load_config(channel="", repo_url=""), with_everything):
            with self.subTest(channel=config.channel, about=config.about_text):
                self.assertNotIn("{{", self.build(config))

    def test_page_reads_sensibly_before_the_script_runs(self):
        page = self.build()
        self.assertIn("<h1>Usually booked 4 to 8 PM today</h1>", page)
        self.assertIn('<p class="kicker">Last checked Fri 20 Nov, 2:45 PM</p>', page)
        self.assertIn("<strong>Sat 21 Nov</strong>: 10 AM to 6 PM", page)

    def test_last_checked_is_the_last_read_of_the_council_page_not_the_build(self):
        # The page is built at 2:45 PM on Friday. What it calls "last checked" is the last
        # time the council's page was actually read, however long ago that was.
        thursday = datetime(2026, 11, 19, 15, 55, tzinfo=MELBOURNE)
        page = self.build(store=october_store(thursday.date(), thursday))
        self.assertIn('<p class="kicker">Last checked Thu 19 Nov, 3:55 PM</p>', page)
        self.assertNotIn("Last checked Fri 20 Nov", page)
        data = self.embedded_data(page)
        self.assertEqual(data["council"]["lastReadAt"], "2026-11-19T15:55+11:00")
        self.assertEqual(data["council"]["lastReadText"], "Thu 19 Nov, 3:55 PM")
        self.assertEqual(data["council"]["lastRead"], "2026-11-19")
        self.assertEqual(data["generated"], "2026-11-20T14:45+11:00")

    def test_last_checked_is_given_in_the_parks_own_time(self):
        # Saved by a machine that keeps another clock: 4:55 AM in London is 3:55 PM in Melbourne.
        london = datetime(2026, 11, 19, 4, 55, tzinfo=ZoneInfo("Europe/London"))
        store = october_store(date(2026, 11, 19), london)
        data = site.page_data(load_config(), plans_from(FRIDAY), None, store, afternoon(FRIDAY))
        self.assertEqual(data["council"]["lastReadAt"], "2026-11-19T15:55+11:00")
        self.assertEqual(data["council"]["lastReadText"], "Thu 19 Nov, 3:55 PM")

    def test_last_checked_without_a_recorded_time_or_without_any_read(self):
        # Read before the time of a read was recorded: only the day is known.
        page = self.build(store=october_store(FRIDAY))
        self.assertIn('<p class="kicker">Last checked Fri 20 Nov</p>', page)
        data = self.embedded_data(page)
        self.assertIsNone(data["council"]["lastReadAt"])
        self.assertEqual(data["council"]["lastReadText"], "Fri 20 Nov")
        # Never read at all: the page does not claim a check that did not happen.
        page = self.build(store=CouncilStore())
        self.assertNotIn('<p class="kicker">Last checked', page)
        self.assertIn('<p class="kicker">Fri 20 Nov</p>', page)
        self.assertIsNone(self.embedded_data(page)["council"]["lastReadText"])

    def test_page_says_it_is_unofficial_and_credits_its_sources(self):
        page = self.build()
        self.assertIn(
            "<strong>Unofficial.</strong> This page is not affiliated with the council or the clubs. "
            "Bookings can change and matches can run late, so check the signs at the park.",
            page,
        )
        self.assertNotIn("run by", page)
        self.assertIn('<a href="https://open-meteo.com/" rel="noopener">Weather data by Open-Meteo.com</a>', page)
        self.assertIn('href="https://council.example/parks/citizens-park"', page)
        self.assertIn('<a href="https://example.org/code" rel="noopener">How this page is made</a>', page)

    def test_embedded_data_matches_the_data_file(self):
        forecast = weather.parse(forecast_json(FRIDAY, 8, chance=lambda day, hour: 40 if hour == 17 else 5))
        page = self.build(forecast=forecast)
        data = self.embedded_data(page)
        self.assertEqual(data, json.loads((self.out / "data.json").read_text(encoding="utf-8")))
        self.assertEqual(data["site"], "https://example.org/park/")
        self.assertEqual(data["zone"], "Australia/Melbourne")
        self.assertEqual((data["dayStart"], data["dayEnd"], data["lightsOff"]), (360, 1320, 1320))
        self.assertEqual(data["generated"], "2026-11-20T14:45+11:00")
        self.assertEqual(data["council"]["latestDay"], "2026-10-31")
        # The badge at the top of the page links to where the times come from.
        self.assertEqual(data["council"]["url"], "https://council.example/parks/citizens-park")

    def test_the_timeline_can_be_shorter_than_the_lit_hours(self):
        config = load_config(day_start=7 * 60, day_end=21 * 60)
        data = site.page_data(config, plans_from(FRIDAY), None, october_store(FRIDAY), afternoon(FRIDAY))
        self.assertEqual((data["dayStart"], data["dayEnd"], data["lightsOff"]), (420, 1260, 1320))

    def test_data_for_each_day(self):
        forecast = weather.parse(forecast_json(FRIDAY, 8, chance=lambda day, hour: 40 if hour == 17 else 5))
        data = site.page_data(load_config(), plans_from(FRIDAY), forecast, october_store(FRIDAY), afternoon(FRIDAY))
        self.assertEqual([day["date"] for day in data["days"]], [(FRIDAY + timedelta(days=n)).isoformat() for n in range(8)])
        today = data["days"][0]
        self.assertEqual(today["name"], "Fri 20 Nov")
        self.assertEqual(today["slots"], [[16 * 60, 20 * 60]])
        self.assertEqual(today["basis"], "usual")
        # Why the day is not confirmed. The page shows it under the badge.
        self.assertEqual(today["why"], "The council's page only goes up to 31 October.")
        self.assertNotIn("note", today)
        self.assertEqual(today["rain"]["chance"], 40)
        # Hour-by-hour rain is only carried for today and tomorrow, to keep the page small.
        self.assertEqual(len(today["hours"]), 24)
        self.assertIn([17, 40, 0.0], today["hours"])
        self.assertIsNotNone(data["days"][1]["hours"])
        self.assertTrue(all(day["hours"] is None for day in data["days"][2:]))
        self.assertTrue(all(day["rain"] is not None for day in data["days"]))

    def test_data_without_a_forecast(self):
        data = site.page_data(load_config(), plans_from(FRIDAY), None, october_store(FRIDAY), afternoon(FRIDAY))
        self.assertTrue(all(day["rain"] is None and day["hours"] is None for day in data["days"]))

    def test_a_closed_day_carries_no_booked_times(self):
        closed = DayPlan(FRIDAY, (Slot(360, 1320),), "council", closed=True, label="Turf works until 1 October.")
        data = site.page_data(load_config(), [closed], None, CouncilStore(), afternoon(FRIDAY))
        self.assertEqual(data["days"][0]["slots"], [])
        self.assertTrue(data["days"][0]["closed"])

    def test_telegram_button_only_with_a_channel(self):
        page = self.build()
        self.assertIn('<a class="button" href="https://t.me/ExampleParkDogs" rel="noopener">Get alerts on Telegram</a>', page)
        self.assertIn("A free alert goes out on Telegram at about 3 PM each day", page)

        page = self.build(load_config(channel=""))
        self.assertNotIn("Telegram", page)
        self.assertNotIn("t.me/", page)
        # With no channel and no tip link there are no buttons, so no empty row is left for them.
        self.assertNotIn("<nav", page)

    def test_tip_button_only_with_a_tip_link(self):
        self.assertNotIn("Leave a tip", self.build())
        page = self.build(load_config(tip_url="https://ko-fi.com/example"))
        self.assertIn('<a class="button" href="https://ko-fi.com/example" rel="noopener">Leave a tip</a>', page)
        self.assertIn("Leave a tip", self.build(load_config(channel="", tip_url="https://ko-fi.com/example")))

    def test_sharing_is_one_block_with_the_qr_code_and_a_copy_button(self):
        page = self.build(load_config(channel=""))
        block = re.search(r'<details class="card fold" id="share">(.*?)</details>', page, re.DOTALL)
        self.assertIsNotNone(block, "the page should have its share block")
        inside = block.group(1)
        self.assertIn("<summary>Share this page</summary>", inside)
        # The button first, and the code under it.
        self.assertLess(inside.index('<button class="button" type="button" id="copy">Copy the link</button>'), inside.index('<img src="qr.svg"'))
        # The address is there too, for a browser that will not copy it. It stays hidden until then.
        self.assertIn('<p class="share-address" id="address" hidden>https://example.org/park/</p>', inside)
        # Nothing else is said: a QR code needs no instructions.
        self.assertEqual(re.findall(r"<p\b[^>]*>", inside), ['<p class="share-address" id="address" hidden>'])
        self.assertNotIn("Scan", page)
        self.assertEqual(page.count("Share this page"), 1)
        self.assertNotIn("poster", page.lower())

    def test_feedback_button_only_with_an_address(self):
        self.assertNotIn("feedback", self.build())
        self.assertNotIn("mailto:", self.build())

        page = self.build(load_config(site_name="Citizens Bark", feedback_email="hello@example.org"))
        button = '<a class="button" href="mailto:hello@example.org?subject=Citizens%20Bark%20feedback">Please share feedback</a>'
        self.assertIn(button, page)
        # It closes "How this works", and it is the only place the address appears.
        how = re.search(r'<details class="card fold" id="how">(.*?)</details>', page, re.DOTALL).group(1)
        self.assertTrue(how.rstrip().endswith(button + "\n    </div>"), how[-200:])
        self.assertEqual(page.count("hello@example.org"), 1)
        # Without a name of its own, the page signs the email with the park's.
        self.assertIn("mailto:hello@example.org?subject=Citizens%20Park%20feedback", self.build(load_config(feedback_email="hello@example.org")))

    def test_how_this_works_speaks_of_an_activity(self):
        page = self.build()
        self.assertIn("dogs must stay off it while an organised activity is on.", page)
        self.assertNotIn("sport or training", page)

    def test_about_block_follows_the_week_ahead_when_it_has_words(self):
        self.assertNotIn('class="card about"', self.build())

        config = load_config(
            about_heading="About me",
            about_text="Hi, I'm Sofia & I train <dogs>.",
            about_link="https://www.instagram.com/example",
            about_link_text="@example on Instagram",
        )
        page = self.build(config)
        self.assertIn("<h2>About me</h2>", page)
        self.assertIn("<p>Hi, I&#x27;m Sofia &amp; I train &lt;dogs&gt;.</p>", page)
        self.assertIn('<p class="about-link"><a href="https://www.instagram.com/example" rel="noopener">@example on Instagram</a></p>', page)
        # After the live view (today and the week ahead), before the buttons and the share block.
        self.assertLess(page.index('<div id="app">'), page.index('class="card about"'))
        self.assertLess(page.index('class="card about"'), page.index('<nav class="actions"'))
        self.assertLess(page.index('<nav class="actions"'), page.index('id="share"'))

        without_link = self.build(load_config(about_text="Hello."))
        self.assertIn("<p>Hello.</p>", without_link)
        self.assertNotIn('<p class="about-link">', without_link)

    def test_only_the_pages_own_script_may_run(self):
        page = self.build(load_config(site_name="Citizens Bark", about_text="Hello."))
        rules = re.search(r'<meta http-equiv="Content-Security-Policy" content="([^"]*)">', page)
        self.assertIsNotNone(rules, "the page should tell the browser what it may run")
        allowed = {part.split(" ", 1)[0]: part.split(" ", 1)[1] for part in rules.group(1).split("; ")}
        self.assertEqual(allowed["default-src"], "&#x27;none&#x27;")
        # The rules come before anything they govern.
        self.assertLess(page.index("Content-Security-Policy"), page.index("<style"))

        # The one script that runs is named by its fingerprint, and the fingerprint is right.
        scripts = re.findall(r"<script>(.*?)</script>", page, re.DOTALL)
        self.assertEqual(len(scripts), 1)
        fingerprint = base64.b64encode(hashlib.sha256(scripts[0].encode("utf-8")).digest()).decode("ascii")
        self.assertEqual(allowed["script-src"], f"&#x27;sha256-{fingerprint}&#x27;")
        self.assertNotIn("unsafe-inline", allowed["script-src"])
        self.assertNotIn("unsafe-eval", rules.group(1))

        # Nothing on the page relies on what those rules forbid.
        self.assertIsNone(re.search(r"<[^>]+\son[a-z]+\s*=", page), "an inline event handler would be blocked")
        self.assertNotIn("javascript:", page)
        # Everything the page loads comes from beside it: no script, style, picture or icon from another site.
        loaded = re.findall(r'<(?:script|img)\b[^>]*\bsrc="([^"]*)"', page)
        loaded += [href for rel, href in re.findall(r'<link rel="([^"]*)" href="([^"]*)"', page) if rel != "canonical"]
        self.assertTrue(loaded)
        for address in loaded:
            self.assertNotRegex(address, r"^(?:[a-z]+:|//)", address)

    def test_the_page_can_have_its_own_name(self):
        plain = self.build()
        self.assertIn("<title>Citizens Park oval: free for dogs right now?</title>", plain)
        self.assertNotIn('class="brand"', plain)
        self.assertIn('<meta name="apple-mobile-web-app-title" content="Citizens Park">', plain)
        manifest = json.loads((self.out / "manifest.webmanifest").read_text(encoding="utf-8"))
        self.assertEqual(manifest["short_name"], "Citizens Park")

        named = self.build(load_config(site_name="Citizens Bark"))
        self.assertIn("<title>Citizens Bark: is the Citizens Park oval free for dogs?</title>", named)
        self.assertIn('<p class="brand"><img src="favicon.svg" width="26" height="26" alt="">Citizens Bark</p>', named)
        self.assertIn('<meta name="apple-mobile-web-app-title" content="Citizens Bark">', named)
        # The park's real name stays on the page, so a stranger knows which oval this is.
        self.assertIn('<p class="eyebrow">Citizens Park oval<span', named)
        manifest = json.loads((self.out / "manifest.webmanifest").read_text(encoding="utf-8"))
        self.assertEqual(manifest["short_name"], "Citizens Bark")
        self.assertEqual(manifest["name"], "Citizens Bark: Citizens Park oval")

    def test_manifest_lets_the_page_be_saved_to_a_home_screen(self):
        self.build()
        manifest = json.loads((self.out / "manifest.webmanifest").read_text(encoding="utf-8"))
        self.assertEqual(manifest["display"], "standalone")
        self.assertEqual(manifest["start_url"], "./")
        for icon in manifest["icons"]:
            self.assertTrue((self.out / icon["src"]).is_file(), icon["src"])

    def test_words_from_outside_cannot_break_the_page(self):
        nasty = '</script><script>alert("x")</script> & <b>bold</b>'
        plans = [
            DayPlan(FRIDAY, (Slot(600, 660),), "council", label=nasty, note=nasty, why=nasty),
            DayPlan(FRIDAY + timedelta(days=1), (), "council", label=nasty, note=nasty, why=nasty),
        ]
        config = load_config(
            park_name='Dogs & <Cats> "Oval"',
            suburb="<i>Richmond</i>",
            site_name="<u>Bark</u>",
            about_heading="<u>Me</u>",
            about_text=nasty,
            about_link="https://example.org/me",
            about_link_text="<u>Me</u>",
        )
        page = self.build(config, plans)
        # Exactly two script blocks: the data and the page's own script.
        self.assertEqual(page.count("<script"), 2)
        self.assertEqual(page.count("</script>"), 2)
        self.assertNotIn("<b>bold</b>", page)
        self.assertNotIn("<i>Richmond</i>", page)
        self.assertNotIn("<u>Bark</u>", page)
        self.assertNotIn("<u>Me</u>", page)
        self.assertIn("Dogs &amp; &lt;Cats&gt; &quot;Oval&quot;", page)
        # The data still arrives whole.
        data = self.embedded_data(page)
        self.assertEqual(data["days"][0]["label"], nasty)
        self.assertEqual(data["days"][0]["why"], nasty)

    def test_building_twice_replaces_the_old_page(self):
        self.build(day=FRIDAY)
        page = self.build(day=FRIDAY + timedelta(days=1))
        self.assertIn("Last checked Sat 21 Nov, 2:45 PM", page)
        self.assertNotIn("Last checked Fri 20 Nov", page)

    def test_missing_assets_folder_does_not_stop_the_build(self):
        site.build(load_config(), plans_from(FRIDAY), None, october_store(FRIDAY), afternoon(FRIDAY), self.out, self.out / "nowhere")
        self.assertTrue((self.out / "index.html").is_file())


class PageScriptTest(unittest.TestCase):
    """What the page's script and styles must keep doing. The script itself runs in a browser, not here."""

    script = (site.WEB / "page.js").read_text(encoding="utf-8")

    def test_older_data_never_replaces_newer_data(self):
        # A stale data.json from a cache must not undo a newer page.
        self.assertIn("Date.parse(fresh.generated) > Date.parse(data.generated)", self.script)

    def test_the_script_uses_nothing_the_pages_rules_forbid(self):
        for forbidden in ("eval(", "new Function", "document.write", "javascript:"):
            with self.subTest(forbidden=forbidden):
                self.assertNotIn(forbidden, self.script)


class FallbackTest(unittest.TestCase):
    """The plain text version, shown until the page's script has run."""

    def title(self, plan: DayPlan) -> str:
        html = site.fallback([plan])
        return re.search(r"<h1>(.*?)</h1>", html).group(1)

    def state(self, plan: DayPlan) -> str:
        return re.search(r'data-state="(\w+)"', site.fallback([plan])).group(1)

    def test_titles(self):
        booked = (Slot(16 * 60 + 15, 19 * 60 + 30),)
        cases = [
            (DayPlan(FRIDAY, booked, "council"), "Booked 4:15 to 7:30 PM today", "unknown"),
            (DayPlan(FRIDAY, booked, "usual"), "Usually booked 4:15 to 7:30 PM today", "unknown"),
            (DayPlan(FRIDAY, (), "council"), "No bookings today", "free"),
            (DayPlan(FRIDAY, (), "usual"), "Usually no bookings today", "free"),
            (DayPlan(FRIDAY, (), "council", label="Maintenance"), "Maintenance listed today", "unknown"),
            (DayPlan(FRIDAY, (), "none"), "No booking information today", "unknown"),
            (DayPlan(FRIDAY, (Slot(360, 1320),), "council", closed=True, label="Turf works."), "Closed today", "closed"),
        ]
        for plan, title, state in cases:
            with self.subTest(title=title):
                self.assertEqual(self.title(plan), title)
                self.assertEqual(self.state(plan), state)

    def test_a_closed_day_shows_the_council_notice(self):
        plan = DayPlan(FRIDAY, (), "council", closed=True, label="Turf works until 1 October.", note="From a notice on the council's page.")
        self.assertIn('<p class="sub">Turf works until 1 October.</p>', site.fallback([plan]))

    def test_the_line_at_the_top_says_when_the_council_page_was_last_read(self):
        plan = DayPlan(FRIDAY, (), "council")
        self.assertIn('<p class="kicker">Last checked Thu 19 Nov, 3:55 PM</p>', site.fallback([plan], "Thu 19 Nov, 3:55 PM"))
        self.assertIn('<p class="kicker">Fri 20 Nov</p>', site.fallback([plan]))
        self.assertIn("Last checked &lt;b&gt;", site.fallback([plan], "<b>"))

    def test_week_list_marks_unconfirmed_days(self):
        plans = [
            DayPlan(FRIDAY, (), "council"),
            DayPlan(FRIDAY + timedelta(days=1), (Slot(600, 1080),), "council"),
            DayPlan(FRIDAY + timedelta(days=2), (Slot(660, 1020),), "usual"),
            DayPlan(FRIDAY + timedelta(days=3), (), "none"),
            DayPlan(FRIDAY + timedelta(days=4), (), "council", closed=True),
            DayPlan(FRIDAY + timedelta(days=5), (Slot(600, 660),), "council", label="Maintenance"),
        ]
        html = site.fallback(plans)
        self.assertIn("<li><strong>Sat 21 Nov</strong>: 10 AM to 6 PM</li>", html)
        self.assertIn('<li><strong>Sun 22 Nov</strong>: 11 AM to 5 PM <span class="tag">usual</span></li>', html)
        self.assertIn("<li><strong>Mon 23 Nov</strong>: No information</li>", html)
        self.assertIn("<li><strong>Tue 24 Nov</strong>: Closed</li>", html)
        self.assertIn("<li><strong>Wed 25 Nov</strong>: 10 to 11 AM (Maintenance)</li>", html)


class FillTest(unittest.TestCase):
    def test_fills_markers_in_one_pass(self):
        # Text that was put in is never scanned again, so it cannot smuggle in a marker.
        self.assertEqual(site._fill("{{a}} and {{b}}", {"a": "{{b}}", "b": "two"}), "{{b}} and two")

    def test_unknown_markers_are_left_alone(self):
        self.assertEqual(site._fill("{{known}} {{unknown}}", {"known": "yes"}), "yes {{unknown}}")


class TextSizesTest(unittest.TestCase):
    """Taras asked for at most four sizes of text on the page. The styles name them once and use no other."""

    SIZES = ("answer", "text", "small", "tiny")

    def setUp(self):
        self.css = (site.WEB / "page.css").read_text(encoding="utf-8")

    def test_four_sizes_are_named_from_the_biggest_to_the_smallest(self):
        named = re.findall(r"^  --([a-z]+): ([^;]+); /\*", self.css, flags=re.MULTILINE)
        sizes = [(name, value) for name, value in named if "rem" in value]
        self.assertEqual([name for name, _ in sizes], list(self.SIZES))
        # The answer grows with the phone's width, between two fixed sizes. The other three are fixed.
        answer = re.fullmatch(r"clamp\(([\d.]+)rem, [\d.]+vw, ([\d.]+)rem\)", sizes[0][1])
        self.assertIsNotNone(answer, sizes[0][1])
        fixed = [float(re.fullmatch(r"([\d.]+)rem", value).group(1)) for _, value in sizes[1:]]
        self.assertGreater(float(answer.group(1)), fixed[0])
        self.assertEqual(fixed, sorted(fixed, reverse=True))
        self.assertEqual(len(set(fixed)), 3)

    def test_no_rule_sets_a_size_of_its_own(self):
        used = [value.strip() for value in re.findall(r"font-size:([^;}]+)", self.css)]
        self.assertGreater(len(used), 10)
        allowed = {"var(--answer)", "var(--small)", "var(--tiny)", "inherit"}
        self.assertEqual(set(used) - allowed, set(), "a rule in page.css sets a size of text that is not one of the four")
        self.assertEqual({"var(--answer)", "var(--small)", "var(--tiny)"} - set(used), set())
        # The short way of writing a font sets a size too. It is used twice: for the
        # page's ordinary text, and for buttons, which take the size around them.
        whole = [value.strip() for value in re.findall(r"(?<![\w-])font:([^;}]+)", self.css)]
        self.assertEqual(len(whole), 2)
        self.assertTrue(whole[0].startswith("var(--text)/"), whole[0])
        self.assertEqual(whole[1], "inherit")

    def test_nothing_else_brings_a_size_along(self):
        # A browser gives some kinds of element a size of its own. The two the page uses are told not to.
        self.assertIn("h2, small { font-size: inherit; }", self.css)
        self.assertRegex(self.css, r"\.hero h1 \{[^}]*font-size: var\(--answer\);")
        script = (site.WEB / "page.js").read_text(encoding="utf-8")
        python = (ROOT / "parkbot" / "site.py").read_text(encoding="utf-8")
        template = (site.WEB / "index.html").read_text(encoding="utf-8")
        for name, written in (("page.js", script), ("site.py", python), ("index.html", template)):
            with self.subTest(file=name):
                self.assertNotRegex(written, r"<(h[3-6]|big|sub|sup|code|pre|kbd|samp|table|input|select|textarea)\b")
                # Every button is the kind the styles know.
                for button in re.findall(r"<button\b[^>]*>", written):
                    self.assertIn('class="button', button)
                self.assertNotRegex(written, r"font-size|style=\\?\"[^\"]*font")


if __name__ == "__main__":
    unittest.main()
