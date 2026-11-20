"""The files around the alerts backend, checked against the rest of the repository.

The backend itself (the notifications/ folder) is written in JavaScript and has
its own tests in that folder. These tests look at what surrounds it: that what
it is told on Cloudflare agrees with config.toml and with the daily check's
own times, that its timer covers the alert window and every one of those times
in summer and in winter, that its tools are pinned, and that the workflows
hand each secret only to the steps that need it.
"""

from __future__ import annotations

import json
import re
import unittest
from datetime import date, datetime, time, timedelta
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo

from parkbot import config as config_module
from tests.helpers import ROOT

BACKEND = ROOT / "notifications"
WORKFLOWS = ROOT / ".github" / "workflows"


def read_jsonc(text: str) -> dict:
    """JSON with ``//`` comments, which is how wrangler's settings file is written."""
    out = []
    in_string = False
    index = 0
    while index < len(text):
        char = text[index]
        if in_string:
            out.append(char)
            if char == "\\":
                out.append(text[index + 1])
                index += 1
            elif char == '"':
                in_string = False
        elif char == '"':
            in_string = True
            out.append(char)
        elif text.startswith("//", index):
            while index < len(text) and text[index] != "\n":
                index += 1
            continue
        else:
            out.append(char)
        index += 1
    return json.loads("".join(out))


def hhmm(minute: int) -> str:
    return f"{minute // 60:02d}:{minute % 60:02d}"


def field(text: str, low: int, high: int) -> set[int]:
    """The values one field of a cron line stands for: ``*``, ``*/5``, ``3-8``, ``3-8/2``, ``1,2`` or a number."""
    values: set[int] = set()
    for part in text.split(","):
        span, _, step = part.partition("/")
        if span == "*":
            first, last = low, high
        elif "-" in span:
            first, last = (int(number) for number in span.split("-"))
        else:
            first = last = int(span)
        if not (low <= first <= last <= high):
            raise ValueError(f"{text!r} does not fit between {low} and {high}")
        values.update(range(first, last + 1, int(step or 1)))
    return values


def secrets_named(text: str) -> list[str]:
    """The repository secrets a piece of a workflow asks for, such as ``["CLOUDFLARE_API_TOKEN"]``."""
    # "steps.secrets.outputs.found" is the answer of a step that is called "secrets", not a secret.
    return re.findall(r"(?<![.\w])secrets\.([A-Za-z_]+)", text)


def utc_minutes(cron: str) -> set[int]:
    """The minutes of a day, in UTC, at which a cron line that runs every day fires."""
    minute, hour, day, month, weekday = cron.split()
    if (day, month, weekday) != ("*", "*", "*"):
        raise ValueError(f"{cron!r} does not run every day")
    return {one_hour * 60 + one_minute for one_hour in field(hour, 0, 23) for one_minute in field(minute, 0, 59)}


class JsoncTest(unittest.TestCase):
    def test_comments_are_left_out_and_addresses_are_not(self):
        text = '// a note\n{\n  "a": "https://example.org/x", // another\n  "b": "say \\"//hi\\"" // and one more\n}\n'
        self.assertEqual(read_jsonc(text), {"a": "https://example.org/x", "b": 'say "//hi"'})


class CronTest(unittest.TestCase):
    def test_the_fields_are_understood(self):
        self.assertEqual(field("*/15", 0, 59), {0, 15, 30, 45})
        self.assertEqual(field("3-8", 0, 23), {3, 4, 5, 6, 7, 8})
        self.assertEqual(field("3-8/2", 0, 23), {3, 5, 7})
        self.assertEqual(field("1,7", 0, 23), {1, 7})
        self.assertEqual(utc_minutes("30 4 * * *"), {270})
        self.assertEqual(len(utc_minutes("*/5 3-8 * * *")), 72)

    def test_what_is_not_understood_is_refused(self):
        for wrong in ("*/5 3-8 * * 1", "*/5 3-8 1 * *", "61 3 * * *", "5 8-3 * * *"):
            with self.subTest(cron=wrong), self.assertRaises(ValueError):
                utc_minutes(wrong)


class SettingsTest(unittest.TestCase):
    """notifications/wrangler.jsonc: what the backend is told on Cloudflare."""

    def setUp(self):
        self.config = config_module.load(ROOT / "config.toml")
        self.settings = read_jsonc((BACKEND / "wrangler.jsonc").read_text(encoding="utf-8"))

    def test_the_backend_is_told_the_same_as_config_toml(self):
        told = self.settings["vars"]
        hint = "notifications/wrangler.jsonc and config.toml no longer agree"
        self.assertEqual(told["SITE_URL"], self.config.site_url, hint)
        self.assertEqual(told["TIMEZONE"], self.config.timezone_name, hint)
        self.assertEqual(told["ALERT_WEEKDAYS"], hhmm(self.config.alert_weekdays), hint)
        self.assertEqual(told["ALERT_WEEKENDS"], hhmm(self.config.alert_weekends), hint)
        self.assertEqual(told["ALERT_UNTIL"], hhmm(self.config.alert_until), hint)
        # The Telegram bot's hours, and its name for the park.
        self.assertEqual(told["BOT_FIRST"], hhmm(self.config.bot_first), hint)
        self.assertEqual(told["BOT_LAST"], hhmm(self.config.bot_last), hint)
        self.assertEqual(told["BOT_EVENING"], hhmm(self.config.bot_evening), hint)
        self.assertEqual(told["BOT_WEEKDAY"], hhmm(self.config.bot_weekday), hint)
        self.assertEqual(told["BOT_WEEKEND"], hhmm(self.config.bot_weekend), hint)
        self.assertEqual(told["PARK_NAME"], self.config.park_name, hint)
        # Telegram is told to bring messages to the backend's own address, the one the page uses.
        self.assertEqual(told["BACKEND_URL"], self.config.push_url, hint)
        self.assertEqual(told["BACKEND_URL"], "https://" + self.settings["routes"][0]["pattern"])
        self.assertEqual(
            sorted(told),
            [
                "ALERT_UNTIL",
                "ALERT_WEEKDAYS",
                "ALERT_WEEKENDS",
                "BACKEND_URL",
                "BOT_EVENING",
                "BOT_FIRST",
                "BOT_LAST",
                "BOT_LINK",
                "BOT_LINK_TEXT",
                "BOT_WEEKDAY",
                "BOT_WEEKEND",
                "CHECK_BRANCH",
                "CHECK_REPOSITORY",
                "CHECK_TIMES",
                "CHECK_WORKFLOW",
                "PARK_NAME",
                "SITE_URL",
                "TIMEZONE",
            ],
        )

    def test_the_backend_and_the_daily_check_open_the_alerts_window_at_the_same_time(self):
        # Both let the alert go out a little before its stated time, and by the same number of minutes.
        rules = (BACKEND / "src" / "rules.js").read_text(encoding="utf-8")
        lead = int(re.search(r"^export const ALERT_LEAD = (\d+);$", rules, flags=re.MULTILINE).group(1))
        self.assertEqual(lead, config_module.ALERT_LEAD, "ALERT_LEAD in notifications/src/rules.js and in parkbot/config.py no longer agree")

    def test_the_timer_covers_the_alert_window_in_summer_and_in_winter(self):
        crons = self.settings["triggers"]["crons"]
        # Cloudflare's free plan allows five timers for a whole account.
        self.assertLessEqual(len(crons), 5)
        fires = set().union(*(utc_minutes(cron) for cron in crons))
        zone = ZoneInfo(self.config.timezone_name)
        # A Friday and a Saturday in summer, the same in winter, and the two Sundays on which the clocks change.
        days = (date(2027, 1, 15), date(2027, 1, 16), date(2027, 7, 16), date(2027, 7, 17), date(2026, 10, 4), date(2027, 4, 4))
        self.assertEqual([day.weekday() for day in days], [4, 5, 4, 5, 6, 6])
        for day in days:
            with self.subTest(day=day.isoformat()):
                opens, closes = self.config.alert_from(day), self.config.alert_until
                looks = []
                for minute in range(opens, closes):
                    moment = datetime.combine(day, time(minute // 60, minute % 60), tzinfo=zone)
                    utc = moment.astimezone(ZoneInfo("UTC"))
                    if utc.hour * 60 + utc.minute in fires:
                        looks.append(minute)
                self.assertTrue(looks, "the timer never looks inside the alert window")
                # It looks within five minutes of the window opening, every five
                # minutes after that, and within five minutes of it closing.
                self.assertLessEqual(looks[0], opens + 5)
                self.assertGreaterEqual(looks[-1], closes - 5)
                gaps = [later - earlier for earlier, later in zip(looks, looks[1:])]
                self.assertLessEqual(max(gaps), 5)

    def test_the_timer_looks_early_in_every_hour_the_bot_sends_in_summer_and_in_winter(self):
        fires = set().union(*(utc_minutes(cron) for cron in self.settings["triggers"]["crons"]))
        zone = ZoneInfo(self.config.timezone_name)
        for day in (date(2027, 1, 15), date(2027, 7, 15), date(2026, 10, 4), date(2027, 4, 4)):
            for hour in range(self.config.bot_first // 60, self.config.bot_last // 60 + 1):
                with self.subTest(day=day.isoformat(), hour=hour):
                    looks = []
                    for minute in range(0, 30):
                        moment = datetime.combine(day, time(hour, minute), tzinfo=zone).astimezone(ZoneInfo("UTC"))
                        if moment.hour * 60 + moment.minute in fires:
                            looks.append(minute)
                    # Within five minutes of the hour, and more than once, in case one look is lost.
                    self.assertTrue(looks, "the timer never looks in the first half hour")
                    self.assertLessEqual(looks[0], 5)
                    self.assertGreaterEqual(len(looks), 3)

    def test_the_timer_rests_at_night(self):
        # A look every five minutes around the clock would be 288 a day. Nothing
        # needs looking after between 1 and 3 AM, in summer or in winter.
        fires = set().union(*(utc_minutes(cron) for cron in self.settings["triggers"]["crons"]))
        self.assertLessEqual(len(fires), 17 * 12 + 4 * 6)
        zone = ZoneInfo(self.config.timezone_name)
        for day in (date(2027, 1, 15), date(2027, 7, 15)):
            for minute in range(1 * 60, 3 * 60):
                moment = datetime.combine(day, time(minute // 60, minute % 60), tzinfo=zone).astimezone(ZoneInfo("UTC"))
                self.assertNotIn(moment.hour * 60 + moment.minute, fires, f"{day} {hhmm(minute)}")

    def test_the_book_and_the_counter_are_set_up_the_way_the_free_plan_needs(self):
        self.assertEqual(
            self.settings["durable_objects"],
            {
                "bindings": [
                    {"name": "SUBSCRIBERS", "class_name": "Subscribers"},
                    {"name": "STATS", "class_name": "Stats"},
                    {"name": "CHATS", "class_name": "Chats"},
                ]
            },
        )
        # On the free plan a Durable Object must keep its things in SQLite. A
        # migration that has been deployed is never changed: a new class gets a new one.
        self.assertEqual(
            self.settings["migrations"],
            [
                {"tag": "v1", "new_sqlite_classes": ["Subscribers"]},
                {"tag": "v2", "new_sqlite_classes": ["Stats"]},
                {"tag": "v3", "new_sqlite_classes": ["Chats"]},
            ],
        )
        worker = (BACKEND / self.settings["main"]).read_text(encoding="utf-8")
        for name, binding in (("Subscribers", "SUBSCRIBERS"), ("Stats", "STATS"), ("Chats", "CHATS")):
            self.assertIn(f"export class {name}", worker)
            self.assertIn(f"env.{binding}", worker)

    def test_the_backend_lives_under_the_pages_own_domain(self):
        self.assertEqual(len(self.settings["routes"]), 1)
        route = self.settings["routes"][0]
        self.assertIs(route["custom_domain"], True)
        self.assertRegex(route["pattern"], r"^[a-z0-9-]+(\.[a-z0-9-]+)+$")
        page_host = urlsplit(self.config.site_url).hostname
        self.assertTrue(route["pattern"].endswith("." + page_host), f"{route['pattern']} is not under {page_host}")
        # A deploy from GitHub takes the name over without asking, so it must
        # not be a name the page itself answers to.
        self.assertNotIn(route["pattern"], (page_host, "www." + page_host))
        # An address at workers.dev would show the name of the Cloudflare account.
        self.assertIs(self.settings["workers_dev"], False)
        self.assertIs(self.settings["preview_urls"], False)

    def test_the_page_points_at_the_backend_or_at_nothing(self):
        # Empty until the backend is live. After that, it must be the backend's address.
        if self.config.push_url:
            self.assertEqual(self.config.push_url, "https://" + self.settings["routes"][0]["pattern"])

    def test_the_date_of_the_runtime_rules_is_a_real_date_in_the_past(self):
        chosen = date.fromisoformat(self.settings["compatibility_date"])
        self.assertLess(chosen, date.today() + timedelta(days=1))
        self.assertGreater(chosen, date(2026, 1, 1))


class SecondTimerTest(unittest.TestCase):
    """The second timer starts the daily check when GitHub's own timer has not. What it is told has to fit that check."""

    def setUp(self):
        self.config = config_module.load(ROOT / "config.toml")
        self.settings = read_jsonc((BACKEND / "wrangler.jsonc").read_text(encoding="utf-8"))
        self.told = self.settings["vars"]
        self.daily = (WORKFLOWS / "daily.yml").read_text(encoding="utf-8")
        self.starter = (BACKEND / "src" / "starter.js").read_text(encoding="utf-8")

    def number(self, name: str) -> int:
        """A number the second timer's code is written with, such as START_AFTER."""
        return int(re.search(rf"^export const {name} = (\d+);$", self.starter, flags=re.MULTILINE).group(1))

    def set_times(self) -> list[int]:
        """The set times as minutes of the day. None at all means that the second timer is switched off."""
        return [int(text[:2]) * 60 + int(text[3:]) for text in self.told["CHECK_TIMES"].split()]

    def test_it_looks_after_this_repositorys_daily_check(self):
        self.assertEqual("https://github.com/" + self.told["CHECK_REPOSITORY"], self.config.repo_url)
        self.assertEqual(self.told["CHECK_WORKFLOW"], "daily.yml")
        self.assertTrue((WORKFLOWS / self.told["CHECK_WORKFLOW"]).is_file())
        # The check is published from this branch, and the timed runs use it too.
        self.assertIn(f"\n  push:\n    branches: [{self.told['CHECK_BRANCH']}]\n", self.daily)

    def test_the_check_can_be_started_from_outside_and_then_decides_by_itself_whether_to_post(self):
        # The second timer asks for a run the way the "Run workflow" button does, and chooses nothing.
        self.assertIn("\n  workflow_dispatch:\n", self.daily)
        self.assertIn("POST_MODE: ${{ inputs.post || 'auto' }}", self.daily)
        self.assertRegex(self.daily, r"\n      post:\n(?:        .*\n)*?        default: auto\n")
        self.assertIn('body: body ? JSON.stringify(body) : undefined', self.starter)
        self.assertIn("{ ref: check.branch }", self.starter)
        # One run at a time, so a run it starts can never post beside a run GitHub started.
        self.assertRegex(self.daily, r"\nconcurrency:\n  group: daily-check\n  cancel-in-progress: false\n")

    def test_its_times_are_the_times_github_is_asked_to_run_the_check(self):
        lines = re.findall(r'- cron: "(\d+) (\d+) \* \* \*"\n\s+timezone: "([^"]+)"', self.daily)
        self.assertGreaterEqual(len(lines), 3)
        self.assertEqual({zone for _, _, zone in lines}, {self.config.timezone_name})
        self.assertEqual(self.told["TIMEZONE"], self.config.timezone_name)
        if not self.set_times():
            return  # switched off on purpose, as the README describes
        asked = sorted(f"{int(hour):02d}:{int(minute):02d}" for minute, hour, _ in lines)
        self.assertEqual(
            self.told["CHECK_TIMES"].split(),
            asked,
            "CHECK_TIMES in notifications/wrangler.jsonc and the run times in .github/workflows/daily.yml no longer agree",
        )

    def test_the_timer_looks_after_every_set_time_in_summer_and_in_winter(self):
        fires = set().union(*(utc_minutes(cron) for cron in self.settings["triggers"]["crons"]))
        zone = ZoneInfo(self.config.timezone_name)
        start_after, leave_after = self.number("START_AFTER"), self.number("LEAVE_AFTER")
        self.assertEqual((start_after, leave_after), (15, 60))
        for day in (date(2027, 1, 15), date(2027, 7, 15), date(2026, 10, 4), date(2027, 4, 4)):
            for set_time in self.set_times():
                with self.subTest(day=day.isoformat(), set_time=hhmm(set_time)):
                    first, last = set_time + start_after, set_time + start_after + leave_after
                    self.assertLess(last, 24 * 60, "a set time this late would be looked after past midnight")
                    looks = []
                    for minute in range(first, last):
                        moment = datetime.combine(day, time(minute // 60, minute % 60), tzinfo=zone).astimezone(ZoneInfo("UTC"))
                        if moment.hour * 60 + moment.minute in fires:
                            looks.append(minute)
                    # A look within five minutes of the moment the check is due, then every five minutes for the hour.
                    self.assertTrue(looks, "the timer never looks while this set time is looked after")
                    self.assertLess(looks[0], first + 5)
                    self.assertGreaterEqual(looks[-1], last - 5)
                    self.assertLessEqual(max(later - earlier for earlier, later in zip(looks, looks[1:])), 5)

    def test_one_set_time_falls_due_early_in_the_posting_window(self):
        # If only the second timer works, the post still goes out near its
        # usual time: some check falls due after the window opens and before
        # the alert stops waiting for a fresh check. That holds for a weekday
        # and for a weekend day, which have different alert times.
        rules = (BACKEND / "src" / "rules.js").read_text(encoding="utf-8")
        grace = int(re.search(r"^export const GRACE_MINUTES = (\d+);$", rules, flags=re.MULTILINE).group(1))
        early_enough = self.number("EARLY_ENOUGH")
        if not self.set_times():
            return  # switched off on purpose
        due = [set_time + self.number("START_AFTER") for set_time in self.set_times()]
        for name, day in (("weekdays", date(2026, 11, 20)), ("weekends", date(2026, 11, 21))):
            with self.subTest(name):
                opens = self.config.alert_from(day)
                in_time = [minute for minute in due if opens <= minute < opens + grace]
                self.assertTrue(in_time, "no set time falls due between the window opening and the alert going out without a fresh check")
                # A run from just before the window opened would not post, so it must not count for that set time.
                for set_time in self.set_times():
                    if opens <= set_time + self.number("START_AFTER") < opens + grace:
                        self.assertGreaterEqual(set_time - early_enough, opens)

    def test_the_post_run_is_started_just_before_the_alerts_time(self):
        # People are told a time on the hour. Started by the second timer in the
        # ten minutes before it, the check has posted and published the page by
        # then, and the backend sends the notification at its next look.
        if not self.set_times():
            return  # switched off on purpose
        due = [set_time + self.number("START_AFTER") for set_time in self.set_times()]
        for name, day in (("weekdays", date(2026, 11, 20)), ("weekends", date(2026, 11, 21))):
            with self.subTest(name):
                at = self.config.alert_at(day)
                self.assertTrue([minute for minute in due if at - 10 <= minute < at], f"no set time falls due in the ten minutes before the alert's time on {name}")

    def test_set_times_are_far_enough_apart_for_one_check_to_finish(self):
        # A check is started a quarter of an hour after its set time. The one
        # before it should be over by then, so that runs do not pile up.
        times = self.set_times()
        self.assertEqual(times, sorted(set(times)))
        if len(times) > 1:
            self.assertGreaterEqual(min(later - earlier for earlier, later in zip(times, times[1:])), 20)

    def test_the_second_timer_may_be_switched_off(self):
        # The README says how: make CHECK_TIMES empty. The checks above must
        # then stay quiet, or the change could not be deployed.
        self.told = {**self.told, "CHECK_TIMES": ""}
        self.assertEqual(self.set_times(), [])
        self.test_its_times_are_the_times_github_is_asked_to_run_the_check()
        self.test_the_timer_looks_after_every_set_time_in_summer_and_in_winter()
        self.test_one_set_time_falls_due_early_in_the_posting_window()
        self.test_the_post_run_is_started_just_before_the_alerts_time()
        self.test_set_times_are_far_enough_apart_for_one_check_to_finish()
        readme = (ROOT / "README.md").read_text(encoding="utf-8")
        self.assertIn("To switch the second timer off, make `CHECK_TIMES` empty", readme)
        # And while it is on, there are set times to look after.
        self.told = self.settings["vars"]
        if self.set_times():
            self.assertGreaterEqual(len(self.set_times()), 3)

    def test_the_token_is_a_secret_and_is_written_nowhere(self):
        # In the settings file it is named in a comment only: the value comes from a secret at deploy time.
        for path in (BACKEND / "wrangler.jsonc", BACKEND / "package.json", ROOT / "config.toml"):
            self.assertNotRegex(path.read_text(encoding="utf-8"), r"github_pat_|ghp_[A-Za-z0-9]", path.name)
        self.assertNotIn("DAILY_CHECK_TOKEN", json.dumps(self.settings))
        worker = (BACKEND / "src" / "worker.js").read_text(encoding="utf-8")
        self.assertEqual(worker.count("DAILY_CHECK_TOKEN"), 1)
        self.assertIn("token: env.DAILY_CHECK_TOKEN", worker)
        # The code that holds the token never writes it to the log, and sends it to GitHub's API only.
        # It is used in five places: kept, asked whether it is there (twice), put in the request to GitHub,
        # and turned into its mark, the eight letters that tell one token from the next.
        self.assertEqual(self.starter.count("this.token"), 5)
        self.assertEqual(self.starter.count("${this.token}"), 1)
        self.assertIn("Authorization: `Bearer ${this.token}`,", self.starter)
        self.assertIn("this.mark = await markOf(this.token);", self.starter)
        # The mark is a piece of the token's SHA-256, from which the token cannot be worked out.
        self.assertIn('crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))', self.starter)
        self.assertIn("hash.slice(0, 4)", self.starter)
        self.assertIn('const GITHUB = "https://api.github.com";', self.starter)
        self.assertIn("await this.fetch(GITHUB + path, {", self.starter)
        self.assertEqual(self.starter.count("this.fetch("), 1)
        self.assertIn('redirect: "manual"', self.starter)


class ToolsTest(unittest.TestCase):
    """notifications/package.json and its lockfile: the tools the backend is tested and deployed with."""

    def setUp(self):
        self.package = json.loads((BACKEND / "package.json").read_text(encoding="utf-8"))
        self.lock = json.loads((BACKEND / "package-lock.json").read_text(encoding="utf-8"))

    def test_every_tool_is_pinned_to_one_exact_version(self):
        wanted = {**self.package["dependencies"], **self.package["devDependencies"]}
        self.assertEqual(sorted(wanted), ["miniflare", "wrangler"])
        for name, version in wanted.items():
            with self.subTest(tool=name):
                self.assertRegex(version, r"^\d+\.\d+\.\d+(-[a-z0-9.]+)?$", "a range such as ^1.2.3 would let the tool change by itself")
                self.assertEqual(self.lock["packages"][f"node_modules/{name}"]["version"], version)

    def test_the_lockfile_belongs_to_this_package_file(self):
        root = self.lock["packages"][""]
        self.assertEqual(root["dependencies"], self.package["dependencies"])
        self.assertEqual(root["devDependencies"], self.package["devDependencies"])

    def test_only_the_deploy_tool_is_needed_to_deploy(self):
        self.assertEqual(list(self.package["dependencies"]), ["wrangler"])

    def test_the_runtime_the_tests_use_is_the_one_the_deploy_tool_brings(self):
        # One copy of Cloudflare's runtime, not two that could drift apart.
        wrangler = self.lock["packages"]["node_modules/wrangler"]
        self.assertEqual(wrangler["dependencies"]["miniflare"], self.package["devDependencies"]["miniflare"])
        self.assertNotIn("node_modules/wrangler/node_modules/miniflare", self.lock["packages"])

    def test_every_package_comes_from_the_npm_registry_with_a_checksum(self):
        packages = {name: entry for name, entry in self.lock["packages"].items() if name}
        self.assertGreater(len(packages), 20)
        for name, entry in packages.items():
            with self.subTest(package=name):
                self.assertTrue(entry["resolved"].startswith("https://registry.npmjs.org/"), entry["resolved"])
                self.assertRegex(entry["integrity"], r"^sha512-[A-Za-z0-9+/=]+$")

    def test_the_backend_code_itself_needs_no_package(self):
        # Everything in src/ uses only what the runtime provides, so nothing from npm ends up on Cloudflare.
        for path in sorted((BACKEND / "src").glob("*.js")):
            with self.subTest(file=path.name):
                imports = re.findall(r'^import .* from "([^"]+)";$', path.read_text(encoding="utf-8"), flags=re.MULTILINE)
                self.assertTrue(all(name.startswith("./") for name in imports), imports)

    def test_what_is_installed_is_not_committed(self):
        ignored = (ROOT / ".gitignore").read_text(encoding="utf-8").splitlines()
        self.assertIn("notifications/node_modules/", ignored)
        self.assertIn("notifications/.wrangler/", ignored)


class WorkflowTest(unittest.TestCase):
    """.github/workflows/alerts.yml: testing and deploying the backend."""

    def setUp(self):
        self.text = (WORKFLOWS / "alerts.yml").read_text(encoding="utf-8")
        before_jobs, jobs = self.text.split("\njobs:\n")
        self.header = before_jobs
        self.test_job, self.deploy_job = jobs.split("\n  deploy:\n")

    def steps(self, job: str) -> list[str]:
        return ["      - name:" + step for step in job.split("      - name:")[1:]]

    def test_it_runs_for_the_backends_files_on_main_and_by_hand_only(self):
        self.assertRegex(
            self.header,
            r'\non:\n  push:\n    branches: \[main\]\n    paths:\n      - "notifications/\*\*"\n      - "\.github/workflows/alerts\.yml"\n  workflow_dispatch:\n',
        )
        for event in ("pull_request", "schedule", "workflow_run", "repository_dispatch"):
            self.assertNotIn(f"\n  {event}", self.header)

    def test_each_job_can_only_read_the_code(self):
        self.assertRegex(self.header, r"\npermissions: \{\}\n")
        for job in (self.test_job, self.deploy_job):
            self.assertRegex(job, r"\n    permissions:\n      contents: read\n    defaults:")
            self.assertIn("persist-credentials: false", job)

    def test_one_deployment_at_a_time(self):
        self.assertRegex(self.header, r"\nconcurrency:\n  group: alerts-backend\n  cancel-in-progress: false\n")

    def test_nothing_is_deployed_before_the_tests_pass(self):
        self.assertRegex(self.deploy_job, r"^    name: Deploy\n    needs: test\n")
        self.assertIn("run: npm test", self.test_job)
        self.assertIn("run: npm run runtime", self.test_job)

    def test_the_secrets_reach_only_the_steps_that_need_them(self):
        self.assertEqual(secrets_named(self.header), [])
        self.assertEqual(secrets_named(self.test_job), [])
        with_secrets = [step for step in self.steps(self.deploy_job) if secrets_named(step)]
        self.assertEqual(len(with_secrets), 4)
        look, deploy, hand_over, hand_bot = with_secrets
        both = ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]
        # The first only learns which secrets exist: "true" or "false" is all it is handed.
        self.assertIn("BOTH_SET: ${{ secrets.CLOUDFLARE_API_TOKEN != '' && secrets.CLOUDFLARE_ACCOUNT_ID != '' }}", look)
        self.assertIn("TIMER_SET: ${{ secrets.DAILY_CHECK_TOKEN != '' }}", look)
        self.assertIn("BOT_SET: ${{ secrets.TELEGRAM_BOT_TOKEN != '' }}", look)
        self.assertEqual(secrets_named(look), [*both, "DAILY_CHECK_TOKEN", "TELEGRAM_BOT_TOKEN"])
        self.assertEqual(len(re.findall(r"\$\{\{ secrets\.", look)), 3)
        # The second is the deploy itself, and it runs nothing but the pinned deploy tool.
        self.assertIn("CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}", deploy)
        self.assertIn("CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}", deploy)
        self.assertEqual(secrets_named(deploy), both)
        self.assertRegex(deploy, r"\n        run: npx --no-install wrangler deploy\n")
        # The third hands the second timer its token, with the same tool and nothing else.
        self.assertEqual(secrets_named(hand_over), [*both, "DAILY_CHECK_TOKEN"])
        self.assertTrue(hand_over.startswith("      - name: Hand the second timer its token\n"))
        # The fourth hands the bot its token, the same way.
        self.assertEqual(secrets_named(hand_bot), [*both, "TELEGRAM_BOT_TOKEN"])
        self.assertTrue(hand_bot.startswith("      - name: Hand the bot its token\n"))
        # No other workflow is handed any of them.
        for other in sorted(WORKFLOWS.glob("*.yml")):
            if other.name != "alerts.yml":
                text = other.read_text(encoding="utf-8")
                self.assertNotIn("CLOUDFLARE", text, other.name)
                self.assertNotIn("DAILY_CHECK_TOKEN", text, other.name)

    def test_the_second_timers_token_goes_straight_into_the_deploy_tool(self):
        hand_over = [step for step in self.steps(self.deploy_job) if step.startswith("      - name: Hand the second timer its token\n")][0]
        # Only when there is a token to hand over, and after the deploy.
        self.assertIn("\n        if: steps.secrets.outputs.found == 'yes' && steps.secrets.outputs.timer == 'yes'\n", hand_over)
        names = [re.match(r"      - name: (.*)", step).group(1) for step in self.steps(self.deploy_job)]
        self.assertEqual(names.index("Hand the second timer its token"), names.index("Deploy to Cloudflare") + 1)
        # One command: the token is piped into the pinned tool. No file, no echo, nothing that prints commands.
        runs = re.findall(r"\n        run: (.*)\n", hand_over)
        self.assertEqual(runs, ["""printf '%s' "$DAILY_CHECK_TOKEN" | npx --no-install wrangler secret put DAILY_CHECK_TOKEN"""])
        self.assertNotIn("run: |", hand_over)
        # The name it is kept under on Cloudflare is the name the backend reads.
        self.assertIn("token: env.DAILY_CHECK_TOKEN", (BACKEND / "src" / "worker.js").read_text(encoding="utf-8"))
        # Nothing else in the workflow ever sees the token's value.
        self.assertEqual(self.text.count("${{ secrets.DAILY_CHECK_TOKEN }}"), 1)
        self.assertEqual(self.text.count('"$DAILY_CHECK_TOKEN"'), 1)

    def test_the_bots_token_goes_straight_into_the_deploy_tool(self):
        hand_over = [step for step in self.steps(self.deploy_job) if step.startswith("      - name: Hand the bot its token\n")][0]
        self.assertIn("\n        if: steps.secrets.outputs.found == 'yes' && steps.secrets.outputs.bot == 'yes'\n", hand_over)
        names = [re.match(r"      - name: (.*)", step).group(1) for step in self.steps(self.deploy_job)]
        self.assertEqual(names.index("Hand the bot its token"), names.index("Hand the second timer its token") + 1)
        runs = re.findall(r"\n        run: (.*)\n", hand_over)
        self.assertEqual(runs, ["""printf '%s' "$TELEGRAM_BOT_TOKEN" | npx --no-install wrangler secret put TELEGRAM_BOT_TOKEN"""])
        self.assertNotIn("run: |", hand_over)
        worker = (BACKEND / "src" / "worker.js").read_text(encoding="utf-8")
        self.assertEqual(worker.count("TELEGRAM_BOT_TOKEN"), 1)
        self.assertIn("token: env.TELEGRAM_BOT_TOKEN", worker)
        self.assertEqual(self.text.count("${{ secrets.TELEGRAM_BOT_TOKEN }}"), 1)
        self.assertEqual(self.text.count('"$TELEGRAM_BOT_TOKEN"'), 1)
        # The bot sends the token to Telegram's API and nowhere else.
        bot = (BACKEND / "src" / "bot.js").read_text(encoding="utf-8")
        self.assertIn('const TELEGRAM = "https://api.telegram.org";', bot)
        self.assertEqual(bot.count("${this.token}"), 1)
        self.assertIn("await this.fetch(`${TELEGRAM}/bot${this.token}/${method}`, {", bot)
        self.assertEqual(bot.count("this.fetch("), 2)  # Telegram, and the page's telegram.json
        self.assertIn('redirect: "manual"', bot)

    def test_the_run_checks_that_the_second_timer_switched_on(self):
        ask = [step for step in self.steps(self.deploy_job) if step.startswith("      - name: Ask the backend how things are")][0]
        self.assertIn("TIMER: ${{ steps.secrets.outputs.timer }}", ask)
        # What it looks for is what the backend really says.
        self.assertIn("""grep -q '"starter":{"on":true'""", ask)
        # And that the bot did, when it was handed its token.
        self.assertIn("BOT: ${{ steps.secrets.outputs.bot }}", ask)
        self.assertIn("""grep -q '"telegram":{"on":true'""", ask)
        self.assertRegex((BACKEND / "src" / "bot.js").read_text(encoding="utf-8"), r"return \{\n      on: true,\n")
        worker = (BACKEND / "src" / "worker.js").read_text(encoding="utf-8")
        self.assertIn("{ ...answer.body, starter: await this.starter.status() }", worker)
        starter = (BACKEND / "src" / "starter.js").read_text(encoding="utf-8")
        self.assertRegex(starter, r"return \{\n      on: true,\n")
        # Switched off on purpose is not a fault.
        self.assertIn("""grep -q '"CHECK_TIMES": *""' wrangler.jsonc""", ask)

    def test_a_step_called_secrets_is_not_mistaken_for_a_secret(self):
        self.assertEqual(secrets_named("if: steps.secrets.outputs.found == 'yes'"), [])
        self.assertEqual(secrets_named("X: ${{ secrets.ONE }}\nY: ${{secrets.TWO != ''}}"), ["ONE", "TWO"])

    def test_without_the_secrets_every_later_step_is_skipped(self):
        steps = self.steps(self.deploy_job)
        names = [re.match(r"      - name: (.*)", step).group(1) for step in steps]
        self.assertEqual(names[:2], ["Get the code", "Look for the secrets"])
        for step in steps[2:]:
            with self.subTest(step=step.splitlines()[0].strip()):
                self.assertRegex(step, r"\n        if: steps\.secrets\.outputs\.found == 'yes'( && steps\.secrets\.outputs\.(timer|bot) == 'yes')?\n")
        # Without the Cloudflare secrets the step that looks for them says nothing about the second timer.
        look = steps[1]
        self.assertLess(look.index('echo "found=no"'), look.index("exit 0"))
        self.assertLess(look.index("exit 0"), look.index('echo "found=yes"'))
        self.assertLess(look.index('echo "found=yes"'), look.index('echo "timer=yes"'))
        self.assertLess(look.index('echo "found=yes"'), look.index('echo "bot=yes"'))

    def test_tools_are_installed_as_the_lockfile_says_and_run_no_scripts(self):
        self.assertIn("run: npm ci --ignore-scripts\n", self.test_job)
        self.assertIn("run: npm ci --omit=dev --ignore-scripts\n", self.deploy_job)
        for text in (self.text, (WORKFLOWS / "tests.yml").read_text(encoding="utf-8")):
            self.assertNotIn("npm install", text)
            self.assertNotRegex(text, r"npm ci(?! (--omit=dev )?--ignore-scripts)")
            # No copy of the tools kept between runs: every run installs what the lockfile says.
            self.assertEqual(text.count("package-manager-cache: false"), text.count("actions/setup-node@"))

    def test_the_backends_answer_is_never_written_where_text_is_formatted(self):
        ask = [step for step in self.steps(self.deploy_job) if step.startswith("      - name: Ask the backend how things are")][0]
        # Its lines are indented in the log, so none of them can act as a command to GitHub.
        self.assertIn("""printf '%s\\n' "$answer" | head -c 2000 | tr -d '\\r' | sed 's/^/  /'""", ask)
        self.assertNotRegex(ask, r'\$answer[^\n]*GITHUB_STEP_SUMMARY')
        self.assertNotRegex(ask, r'echo[^\n]*\$answer')

    def test_a_heading_in_the_runs_summary_is_shown_whole(self):
        # GitHub cuts the heading of a notice at the first comma, and ends it at the first colon.
        found = 0
        for path in sorted(WORKFLOWS.glob("*.yml")):
            for title in re.findall(r"::(?:notice|warning|error) title=(.*?)::", path.read_text(encoding="utf-8")):
                found += 1
                with self.subTest(workflow=path.name, title=title):
                    self.assertRegex(title, r"^[A-Za-z][A-Za-z ]+$")
        self.assertGreaterEqual(found, 4)
        self.assertIn("::notice title=Tested but not deployed::", self.deploy_job)
        self.assertIn("::notice title=Second timer is off::", self.deploy_job)

    def test_the_address_asked_is_the_one_in_the_settings(self):
        settings = read_jsonc((BACKEND / "wrangler.jsonc").read_text(encoding="utf-8"))
        found = re.search(r'"pattern": *"([a-z0-9.-]*)"', (BACKEND / "wrangler.jsonc").read_text(encoding="utf-8"))
        self.assertEqual(found.group(1), settings["routes"][0]["pattern"])
        self.assertIn("""sed -n 's/.*"pattern": *"\\([a-z0-9.-]*\\)".*/\\1/p' wrangler.jsonc""", self.text)

    def test_the_tests_workflow_tries_the_backend_too(self):
        tests = (WORKFLOWS / "tests.yml").read_text(encoding="utf-8")
        self.assertIn("\n  alerts:\n    name: Alerts backend\n", tests)
        self.assertIn("run: npm test", tests)
        self.assertIn("run: npm run runtime", tests)
        self.assertIn("node --check parkbot/web/sw.js", tests)
        self.assertEqual(secrets_named(tests), [])
        self.assertNotIn("wrangler deploy\n", tests)


class TogetherTest(unittest.TestCase):
    """The page, its script and the backend have to use the same words with each other."""

    def setUp(self):
        self.page = (ROOT / "parkbot" / "web" / "page.js").read_text(encoding="utf-8")
        self.shower = (ROOT / "parkbot" / "web" / "sw.js").read_text(encoding="utf-8")
        self.worker = (BACKEND / "src" / "worker.js").read_text(encoding="utf-8")
        self.book = (BACKEND / "src" / "book.js").read_text(encoding="utf-8")
        self.rules = (BACKEND / "src" / "rules.js").read_text(encoding="utf-8")

    def test_the_page_asks_for_paths_the_backend_answers(self):
        routes = re.search(r"const ROUTES = \{(.*?)\};", self.worker).group(1)
        self.assertEqual(sorted(re.findall(r'"([A-Z]+ /[a-z]*)"', routes)), ["GET /", "GET /key", "GET /status", "POST /subscribe", "POST /unsubscribe"])
        self.assertIn('ask("/key")', self.page)
        self.assertIn('ask("/subscribe", { subscription: mine.toJSON() })', self.page)
        self.assertIn('ask("/unsubscribe", { endpoint: endpoint })', self.page)
        self.assertIn('tell(backend, "/subscribe", { subscription: subscription.toJSON() })', self.shower)
        self.assertIn('tell(backend, "/unsubscribe", { endpoint: old.endpoint })', self.shower)
        self.assertIn("checkSubscription(given && given.subscription)", self.book)
        self.assertIn("tidyEndpoint(given && given.endpoint)", self.book)

    def test_the_page_knows_every_reason_the_backend_gives(self):
        given = set(re.findall(r'reason: "([a-z]+)"', self.worker + self.book)) | set(re.findall(r'new Refusal\(\d+, "([a-z]+)"', self.rules))
        # "secret" is only ever said to Telegram, which brings messages to the bot. The page never hears it.
        self.assertEqual(given, {"bad", "full", "gone", "host", "later", "origin", "secret", "settings", "unknown"})
        # These three get words of their own on the page. Every other one means "try again later".
        for reason in ("full", "gone", "host"):
            self.assertIn(f'reply.reason === "{reason}"', self.page)

    def test_the_notification_is_written_the_way_the_pages_script_reads_it(self):
        for name in ("title", "body", "navigate", "tag"):
            with self.subTest(part=name):
                self.assertRegex(self.rules, rf"\n        {name}[,:]")
                self.assertIn(f"notice.{name}", self.shower)
        self.assertIn("sent && sent.notification", self.shower)
        self.assertIn("web_push: 8030", self.rules)
        # The one picture a notification names, the small mark for the status bar,
        # is published with the page: everything in assets/ is, apart from the
        # files the build keeps back. The page's icon is not named any more.
        self.assertIn('settings.siteUrl + "badge.png"', self.rules)
        self.assertTrue((ROOT / "assets" / "badge.png").is_file(), "the picture is missing from assets/")
        self.assertNotIn("icon", self.rules.split("export function messageFor", 1)[1].split("\n}\n", 1)[0].replace("notification", ""))
        # The script beside the page names one more on Android phones, a picture with nothing on it.
        self.assertIn('"blank.png"', self.shower)
        self.assertTrue((ROOT / "assets" / "blank.png").is_file(), "the picture is missing from assets/")

    def test_the_backend_reads_the_data_the_page_publishes(self):
        site = (ROOT / "parkbot" / "site.py").read_text(encoding="utf-8")
        self.assertIn("${this.settings.siteUrl}data.json", self.book)
        for name in ("generated", "generatedText", "days"):
            with self.subTest(part=name):
                self.assertTrue(f'"{name}"' in site, "the page's data no longer has this part")
                self.assertTrue(re.search(rf"data\.{name}\b", self.rules), "the backend no longer reads this part")
        self.assertTrue('"notice": message.notice(' in site)
        self.assertTrue("day.notice" in self.rules)


if __name__ == "__main__":
    unittest.main()
