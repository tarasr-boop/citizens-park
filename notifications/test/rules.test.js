// The small decisions: the time at the park, who may talk to the backend from
// a browser, and the settings.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { clockText, corsHeaders, localTime, settingsFrom, toBase64Url } from "../src/rules.js";
import { BOT, CHECK, ENV, SITE, at, readJsonc, settings } from "./standins.js";

test("the settings are read and tidied", () => {
  assert.deepEqual(settings, { siteUrl: SITE, origin: "https://citizensbark.example", zone: "Australia/Melbourne", check: null, bot: null });
  // An address without its last slash gets one, so that file names can be added to it.
  assert.equal(settingsFrom({ ...ENV, SITE_URL: "https://example.org/park" }).siteUrl, "https://example.org/park/");
  assert.equal(settingsFrom({ ...ENV, SITE_URL: "https://example.org/park" }).origin, "https://example.org");
});

test("settings that make no sense are turned down with a plain reason", () => {
  const wrong = [
    [{ SITE_URL: undefined }, /SITE_URL/],
    [{ SITE_URL: "citizensbark.example" }, /SITE_URL/],
    [{ SITE_URL: "http://citizensbark.example/" }, /https/],
    [{ TIMEZONE: "Australia/Richmond" }, /TIMEZONE/],
    [{ TIMEZONE: undefined }, /TIMEZONE/],
  ];
  for (const [change, reason] of wrong) {
    assert.throws(() => settingsFrom({ ...ENV, ...change }), reason, JSON.stringify(change));
  }
});

test("the second timer's settings name the check on GitHub and its times of day", () => {
  assert.deepEqual(settingsFrom({ ...ENV, ...CHECK }).check, {
    repository: "someone/park",
    workflow: "daily.yml",
    branch: "main",
    times: [377, 707, 827, 880, 910, 945, 1067, 1187],
  });
  assert.deepEqual(settingsFrom({ ...ENV, ...CHECK, CHECK_TIMES: "  6:05   14:40 " }).check.times, [365, 880]);
  assert.equal(settingsFrom({ ...ENV, ...CHECK, CHECK_WORKFLOW: "Daily_check-2.yaml", CHECK_BRANCH: "release/v1.2" }).check.workflow, "Daily_check-2.yaml");
  // Without times of day the second timer is off, whatever else is written.
  for (const empty of ["", "   ", undefined]) {
    assert.equal(settingsFrom({ ...ENV, ...CHECK, CHECK_TIMES: empty }).check, null);
    assert.equal(settingsFrom({ ...ENV, CHECK_TIMES: empty, CHECK_REPOSITORY: "not a repository" }).check, null);
  }
});

test("second timer settings that make no sense are turned down with a plain reason", () => {
  const wrong = [
    [{ CHECK_TIMES: "25:00" }, /CHECK_TIMES/],
    [{ CHECK_TIMES: "2:40 PM" }, /CHECK_TIMES/],
    [{ CHECK_TIMES: "14:40,15:10" }, /CHECK_TIMES/],
    [{ CHECK_TIMES: "14:40 14:40" }, /earliest/],
    [{ CHECK_TIMES: "15:10 14:40" }, /earliest/],
    [{ CHECK_TIMES: Array.from({ length: 25 }, (_, index) => `${String(index % 24).padStart(2, "0")}:${index < 24 ? "00" : "30"}`).join(" ") }, /at most 24/],
    [{ CHECK_REPOSITORY: undefined }, /CHECK_REPOSITORY/],
    [{ CHECK_REPOSITORY: "someone" }, /CHECK_REPOSITORY/],
    [{ CHECK_REPOSITORY: "someone/park/extra" }, /CHECK_REPOSITORY/],
    [{ CHECK_REPOSITORY: "some one/park" }, /CHECK_REPOSITORY/],
    [{ CHECK_REPOSITORY: "someone/.." }, /CHECK_REPOSITORY/],
    [{ CHECK_REPOSITORY: "../park" }, /CHECK_REPOSITORY/],
    [{ CHECK_REPOSITORY: "someone/park?x=1" }, /CHECK_REPOSITORY/],
    [{ CHECK_REPOSITORY: "https://github.com/someone/park" }, /CHECK_REPOSITORY/],
    [{ CHECK_WORKFLOW: undefined }, /CHECK_WORKFLOW/],
    [{ CHECK_WORKFLOW: "daily" }, /CHECK_WORKFLOW/],
    [{ CHECK_WORKFLOW: ".yml" }, /CHECK_WORKFLOW/],
    [{ CHECK_WORKFLOW: "../daily.yml" }, /CHECK_WORKFLOW/],
    [{ CHECK_WORKFLOW: "daily.yml/dispatches" }, /CHECK_WORKFLOW/],
    [{ CHECK_BRANCH: undefined }, /CHECK_BRANCH/],
    [{ CHECK_BRANCH: "main branch" }, /CHECK_BRANCH/],
    [{ CHECK_BRANCH: "../main" }, /CHECK_BRANCH/],
    [{ CHECK_BRANCH: "a..b" }, /CHECK_BRANCH/],
    [{ CHECK_BRANCH: "feature//x" }, /CHECK_BRANCH/],
    [{ CHECK_BRANCH: "-main" }, /CHECK_BRANCH/],
  ];
  for (const [change, reason] of wrong) {
    assert.throws(() => settingsFrom({ ...ENV, ...CHECK, ...change }), reason, JSON.stringify(change));
  }
});

test("the settings in wrangler.jsonc are ones the backend takes", () => {
  const file = readJsonc(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
  const real = settingsFrom(file.vars);
  assert.equal(real.siteUrl.startsWith("https://"), true);
  // The second timer has a handful of times of day there. Without any, it is switched off on purpose.
  if (real.check) assert.ok(real.check.times.length >= 3 && real.check.times.length <= 24);
  assert.equal(settingsFrom({ ...file.vars, CHECK_TIMES: "" }).check, null);
  // The times of the browser notifications went with them (23 November 2026).
  assert.deepEqual(Object.keys(file.vars).sort(), [
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
  ]);
  // The bot's hours make sense, and Telegram is told to bring messages to this backend's own address.
  assert.ok(real.bot);
  assert.equal(real.bot.address, `https://${file.routes[0].pattern}/telegram`);
  // No token is ever written in this file: they are secrets, handed over at deploy time.
  assert.equal(JSON.stringify(file).includes("DAILY_CHECK_TOKEN"), false);
  assert.equal(JSON.stringify(file).includes("TELEGRAM_BOT_TOKEN"), false);
});

test("the bot's settings are read as hours, and ones that make no sense are turned down", () => {
  const bot = settingsFrom({ ...ENV, ...BOT }).bot;
  assert.deepEqual(bot, {
    address: "https://alerts.example/telegram",
    park: "Citizens Park oval",
    link: "https://www.instagram.com/gentle_woof",
    linkText: "Book a consultation with Sofia",
    first: 4,
    last: 23,
    evening: 21,
    weekday: 16,
    weekend: 8,
  });
  // The link is optional, and without it there is no button for it.
  assert.deepEqual([settingsFrom({ ...ENV, ...BOT, BOT_LINK: "" }).bot.link, settingsFrom({ ...ENV, ...BOT, BOT_LINK: undefined, BOT_LINK_TEXT: undefined }).bot.link], ["", ""]);
  // Without them there is no bot.
  assert.equal(settingsFrom(ENV).bot, null);
  const wrong = [
    [{ BOT_WEEKDAY: "16:30" }, /on the hour/],
    [{ BOT_FIRST: "09:00" }, /BOT_WEEKEND/],
    [{ BOT_EVENING: "03:00" }, /BOT_EVENING/],
    [{ BOT_LAST: undefined }, /BOT_LAST/],
    [{ BACKEND_URL: "alerts.example" }, /BACKEND_URL/],
    [{ BACKEND_URL: "http://alerts.example" }, /https/],
    [{ BOT_LINK: "http://www.instagram.com/gentle_woof" }, /BOT_LINK/],
    [{ BOT_LINK: "not a link" }, /BOT_LINK/],
    [{ BOT_LINK_TEXT: "" }, /BOT_LINK_TEXT/],
  ];
  for (const [change, reason] of wrong) {
    assert.throws(() => settingsFrom({ ...ENV, ...BOT, ...change }), reason, JSON.stringify(change));
  }
});

test("the comments in a settings file are left out, and addresses are not", () => {
  const text = '// a note\n{\n  "a": "https://example.org/x", // another\n  "b": "say \\"//hi\\"" // and one more\n}\n';
  assert.deepEqual(readJsonc(text), { a: "https://example.org/x", b: 'say "//hi"' });
});

test("the time at the park, in summer and in winter", () => {
  // Summer time: Melbourne is 11 hours ahead of UTC.
  assert.deepEqual(localTime(Date.parse("2026-11-20T03:30:00Z"), "Australia/Melbourne"), { date: "2026-11-20", minute: 870 });
  // Winter: 10 hours ahead.
  assert.deepEqual(localTime(Date.parse("2026-07-15T04:30:00Z"), "Australia/Melbourne"), { date: "2026-07-15", minute: 870 });
  // Late in the evening in UTC it is already tomorrow at the park.
  assert.deepEqual(localTime(Date.parse("2026-11-20T13:05:00Z"), "Australia/Melbourne"), { date: "2026-11-21", minute: 5 });
  // Midnight is minute 0, not minute 1440.
  assert.deepEqual(localTime(Date.parse("2026-11-20T13:00:00Z"), "Australia/Melbourne"), { date: "2026-11-21", minute: 0 });
  assert.deepEqual(localTime(Date.parse("2026-11-20T12:59:00Z"), "Australia/Melbourne"), { date: "2026-11-20", minute: 1439 });
});

test("the time at the park on the days the clocks change", () => {
  // Sunday 4 October 2026: 2 AM becomes 3 AM.
  assert.deepEqual(localTime(Date.parse("2026-10-03T15:59:00Z"), "Australia/Melbourne"), { date: "2026-10-04", minute: 119 });
  assert.deepEqual(localTime(Date.parse("2026-10-03T16:00:00Z"), "Australia/Melbourne"), { date: "2026-10-04", minute: 180 });
  assert.deepEqual(localTime(Date.parse("2026-10-04T03:30:00Z"), "Australia/Melbourne"), { date: "2026-10-04", minute: 870 });
  // Sunday 5 April 2026: 3 AM becomes 2 AM.
  assert.deepEqual(localTime(Date.parse("2026-04-04T15:59:00Z"), "Australia/Melbourne"), { date: "2026-04-05", minute: 179 });
  assert.deepEqual(localTime(Date.parse("2026-04-04T16:00:00Z"), "Australia/Melbourne"), { date: "2026-04-05", minute: 120 });
  assert.deepEqual(localTime(Date.parse("2026-04-05T04:30:00Z"), "Australia/Melbourne"), { date: "2026-04-05", minute: 870 });
});

test("times are written the way the page writes them", () => {
  assert.equal(clockText(0), "midnight");
  assert.equal(clockText(1440), "midnight");
  assert.equal(clockText(5), "12:05 AM");
  assert.equal(clockText(9 * 60), "9 AM");
  assert.equal(clockText(12 * 60), "12 PM");
  assert.equal(clockText(14 * 60 + 30), "2:30 PM");
  assert.equal(clockText(15 * 60), "3 PM");
  assert.equal(clockText(23 * 60 + 59), "11:59 PM");
});

test("only the page itself is allowed to talk to the backend from a browser", () => {
  assert.deepEqual(corsHeaders("https://citizensbark.example", settings), {
    Vary: "Origin",
    "Access-Control-Allow-Origin": "https://citizensbark.example",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  });
  for (const other of [null, "", "https://example.org", "http://citizensbark.example", "https://citizensbark.example.evil.example", "null"]) {
    assert.deepEqual(corsHeaders(other, settings), { Vary: "Origin" }, String(other));
  }
});

test("the moments used in these tests are what they say", () => {
  assert.deepEqual(localTime(at("2026-11-20", "15:00"), "Australia/Melbourne"), { date: "2026-11-20", minute: 900 });
});

test("bytes are written as base64url, without padding", () => {
  assert.equal(toBase64Url(new Uint8Array([])), "");
  assert.equal(toBase64Url(new Uint8Array([251, 255, 191])), "-_-_");
  assert.equal(toBase64Url(new Uint8Array([104, 105]).buffer), "aGk");
});
