"""The files around the alerts backend, checked against the rest of the repository.

The backend itself (the notifications/ folder) is written in JavaScript and has
its own tests in that folder. These tests look at what surrounds it: that what
it is told on Cloudflare agrees with config.toml, that its timer covers the
alert window in summer and in winter, that its tools are pinned, and that the
workflows hand the Cloudflare secrets to one step only.
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
        self.assertEqual(told["ALERT_FROM"], hhmm(self.config.post_from), hint)
        self.assertEqual(told["ALERT_UNTIL"], hhmm(self.config.post_until), hint)
        self.assertEqual(sorted(told), ["ALERT_FROM", "ALERT_UNTIL", "SITE_URL", "TIMEZONE"])

    def test_the_timer_covers_the_alert_window_in_summer_and_in_winter(self):
        crons = self.settings["triggers"]["crons"]
        # Cloudflare's free plan allows five timers for a whole account.
        self.assertLessEqual(len(crons), 5)
        fires = set().union(*(utc_minutes(cron) for cron in crons))
        zone = ZoneInfo(self.config.timezone_name)
        # A summer day, a winter day, and the two Sundays on which the clocks change.
        for day in (date(2027, 1, 15), date(2027, 7, 15), date(2026, 10, 4), date(2027, 4, 4)):
            with self.subTest(day=day.isoformat()):
                looks = []
                for minute in range(self.config.post_from, self.config.post_until):
                    moment = datetime.combine(day, time(minute // 60, minute % 60), tzinfo=zone)
                    utc = moment.astimezone(ZoneInfo("UTC"))
                    if utc.hour * 60 + utc.minute in fires:
                        looks.append(minute)
                self.assertTrue(looks, "the timer never looks inside the alert window")
                # It looks within five minutes of the window opening, every five
                # minutes after that, and within five minutes of it closing.
                self.assertLessEqual(looks[0], self.config.post_from + 5)
                self.assertGreaterEqual(looks[-1], self.config.post_until - 5)
                gaps = [later - earlier for earlier, later in zip(looks, looks[1:])]
                self.assertLessEqual(max(gaps), 5)

    def test_the_timer_does_not_run_all_day(self):
        # A look every five minutes around the clock would be 288 a day. The
        # afternoon is enough, and leaves the free plan's allowance alone.
        fires = set().union(*(utc_minutes(cron) for cron in self.settings["triggers"]["crons"]))
        self.assertLessEqual(len(fires), 100)

    def test_the_book_is_set_up_the_way_the_free_plan_needs(self):
        self.assertEqual(self.settings["durable_objects"], {"bindings": [{"name": "SUBSCRIBERS", "class_name": "Subscribers"}]})
        # On the free plan a Durable Object must keep its things in SQLite.
        self.assertEqual(self.settings["migrations"], [{"tag": "v1", "new_sqlite_classes": ["Subscribers"]}])
        worker = (BACKEND / self.settings["main"]).read_text(encoding="utf-8")
        self.assertIn("export class Subscribers", worker)
        self.assertIn("env.SUBSCRIBERS", worker)

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

    def test_the_secrets_reach_one_step_only(self):
        self.assertEqual(secrets_named(self.header), [])
        self.assertEqual(secrets_named(self.test_job), [])
        with_secrets = [step for step in self.steps(self.deploy_job) if secrets_named(step)]
        self.assertEqual(len(with_secrets), 2)
        look, deploy = with_secrets
        both = ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]
        # The first only learns whether both secrets exist: "true" or "false" is all it is handed.
        self.assertIn("BOTH_SET: ${{ secrets.CLOUDFLARE_API_TOKEN != '' && secrets.CLOUDFLARE_ACCOUNT_ID != '' }}", look)
        self.assertEqual(secrets_named(look), both)
        # The second is the deploy itself, and it runs nothing but the pinned deploy tool.
        self.assertIn("CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}", deploy)
        self.assertIn("CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}", deploy)
        self.assertEqual(secrets_named(deploy), both)
        self.assertRegex(deploy, r"\n        run: npx --no-install wrangler deploy\n")
        # No other workflow is handed them.
        for other in sorted(WORKFLOWS.glob("*.yml")):
            if other.name != "alerts.yml":
                self.assertNotIn("CLOUDFLARE", other.read_text(encoding="utf-8"), other.name)

    def test_a_step_called_secrets_is_not_mistaken_for_a_secret(self):
        self.assertEqual(secrets_named("if: steps.secrets.outputs.found == 'yes'"), [])
        self.assertEqual(secrets_named("X: ${{ secrets.ONE }}\nY: ${{secrets.TWO != ''}}"), ["ONE", "TWO"])

    def test_without_the_secrets_every_later_step_is_skipped(self):
        steps = self.steps(self.deploy_job)
        names = [re.match(r"      - name: (.*)", step).group(1) for step in steps]
        self.assertEqual(names[:2], ["Get the code", "Look for the Cloudflare secrets"])
        for step in steps[2:]:
            with self.subTest(step=step.splitlines()[0].strip()):
                self.assertIn("\n        if: steps.secrets.outputs.found == 'yes'\n", step)

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
        self.assertGreaterEqual(found, 2)
        self.assertIn("::notice title=Tested but not deployed::", self.deploy_job)

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
        self.assertEqual(given, {"bad", "full", "gone", "host", "later", "origin", "settings", "unknown"})
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
        # The two pictures a notification names are published with the page:
        # everything in assets/ is, apart from the files the build keeps back.
        for picture in ("icon-192.png", "badge.png"):
            with self.subTest(picture=picture):
                self.assertTrue(f'settings.siteUrl + "{picture}"' in self.rules, "the backend no longer names this picture")
                self.assertTrue((ROOT / "assets" / picture).is_file(), "the picture is missing from assets/")

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
