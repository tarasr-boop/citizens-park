// The small decisions: the time at the park, which addresses are taken, what
// a notification says, and the settings.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  GRACE_MINUTES,
  Refusal,
  alertHour,
  checkSubscription,
  clockText,
  corsHeaders,
  isFresh,
  localTime,
  messageFor,
  noticeFor,
  settingsFrom,
  tidyEndpoint,
  welcome,
} from "../src/rules.js";
import { LARGEST_MESSAGE } from "../src/webpush.js";
import { BOT, CHECK, ENV, SITE, at, day, newDevice, pageData, readJsonc, settings } from "./standins.js";

test("the settings are read and tidied", () => {
  assert.deepEqual(settings, { siteUrl: SITE, origin: "https://citizensbark.example", zone: "Australia/Melbourne", from: 870, until: 1140, check: null, bot: null });
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
    [{ ALERT_FROM: "2:30 PM" }, /ALERT_FROM/],
    [{ ALERT_FROM: "24:00" }, /ALERT_FROM/],
    [{ ALERT_UNTIL: "19:60" }, /ALERT_UNTIL/],
    [{ ALERT_UNTIL: undefined }, /ALERT_UNTIL/],
    [{ ALERT_FROM: "19:00", ALERT_UNTIL: "14:30" }, /earlier/],
    [{ ALERT_FROM: "14:30", ALERT_UNTIL: "14:30" }, /earlier/],
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
  assert.equal(real.from < real.until, true);
  // The second timer has a handful of times of day there. Without any, it is switched off on purpose.
  if (real.check) assert.ok(real.check.times.length >= 3 && real.check.times.length <= 24);
  assert.equal(settingsFrom({ ...file.vars, CHECK_TIMES: "" }).check, null);
  assert.deepEqual(Object.keys(file.vars).sort(), [
    "ALERT_FROM",
    "ALERT_UNTIL",
    "BACKEND_URL",
    "BOT_EVENING",
    "BOT_FIRST",
    "BOT_LAST",
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
  assert.deepEqual(bot, { address: "https://alerts.example/telegram", park: "Citizens Park oval", first: 4, last: 23, evening: 21, weekday: 16, weekend: 8 });
  // Without them there is no bot.
  assert.equal(settingsFrom(ENV).bot, null);
  const wrong = [
    [{ BOT_WEEKDAY: "16:30" }, /on the hour/],
    [{ BOT_FIRST: "09:00" }, /BOT_WEEKEND/],
    [{ BOT_EVENING: "03:00" }, /BOT_EVENING/],
    [{ BOT_LAST: undefined }, /BOT_LAST/],
    [{ BACKEND_URL: "alerts.example" }, /BACKEND_URL/],
    [{ BACKEND_URL: "http://alerts.example" }, /https/],
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

test("people are told the nearest hour to expect the alert", () => {
  assert.equal(alertHour(settings), "3 PM");
  assert.equal(alertHour({ ...settings, from: 15 * 60 }), "3 PM");
  assert.equal(alertHour({ ...settings, from: 15 * 60 + 29 }), "3 PM");
  assert.equal(alertHour({ ...settings, from: 15 * 60 + 30 }), "4 PM");
  assert.equal(GRACE_MINUTES, 45);
});

test("an address at one of the browsers' notification services is taken", () => {
  const hosts = [
    "fcm.googleapis.com",
    "jmt17.google.com",
    "updates.push.services.mozilla.com",
    "web.push.apple.com",
    "api.push.apple.com",
    "wns2-sg2p.notify.windows.com",
    "db5p.notify.windows.com",
    "autopush.stage.push.services.mozilla.com",
  ];
  for (const host of hosts) {
    const phone = newDevice(host);
    assert.deepEqual(checkSubscription(phone.subscription), { endpoint: phone.endpoint, ...phone.subscription.keys }, host);
  }
});

test("keys in plain base64 are taken and filed as base64url", () => {
  const phone = newDevice();
  const plain = (text) => Buffer.from(text, "base64url").toString("base64");
  const tidied = checkSubscription({ endpoint: phone.endpoint, keys: { p256dh: plain(phone.subscription.keys.p256dh), auth: plain(phone.subscription.keys.auth) } });
  assert.deepEqual(tidied, { endpoint: phone.endpoint, ...phone.subscription.keys });
});

test("an address anywhere else is turned down, and its host is named", () => {
  const hosts = [
    "example.org",
    "fcm.googleapis.com.example.org",
    "evilfcm.googleapis.com",
    "notfcm.googleapis.com",
    "push.apple.com",
    "evilpush.apple.com",
    "notify.windows.com",
    "evilnotify.windows.com",
    "localhost",
    "127.0.0.1",
    "169.254.169.254",
    "citizensbark.example",
  ];
  for (const host of hosts) {
    const phone = newDevice(host);
    assert.throws(
      () => checkSubscription(phone.subscription),
      (error) => error instanceof Refusal && error.status === 400 && error.reason === "host" && error.host === host,
      host
    );
  }
});

test("an address that is not a plain https address is turned down", () => {
  const phone = newDevice();
  const keys = phone.subscription.keys;
  const wrong = [
    "http://fcm.googleapis.com/send/abc",
    "https://fcm.googleapis.com:8443/send/abc",
    "https://someone@fcm.googleapis.com/send/abc",
    "https://someone:secret@fcm.googleapis.com/send/abc",
    "ftp://fcm.googleapis.com/send/abc",
    "fcm.googleapis.com/send/abc",
    "",
    `https://fcm.googleapis.com/send/${"a".repeat(2000)}`,
  ];
  for (const endpoint of wrong) {
    assert.throws(
      () => checkSubscription({ endpoint, keys }),
      (error) => error instanceof Refusal && error.status === 400 && error.reason === "bad" && error.host === "",
      endpoint.slice(0, 60)
    );
  }
});

test("what is not an address with two keys is turned down", () => {
  const phone = newDevice();
  const { endpoint, keys } = phone.subscription;
  const short = Buffer.alloc(15).toString("base64url");
  const compressed = Buffer.concat([Buffer.of(2), Buffer.alloc(32, 1)]).toString("base64url");
  const notStartingWith4 = Buffer.concat([Buffer.of(5), Buffer.alloc(64, 1)]).toString("base64url");
  const wrong = [
    null,
    undefined,
    "text",
    42,
    [],
    {},
    { endpoint },
    { endpoint, keys: null },
    { endpoint, keys: "keys" },
    { endpoint: 42, keys },
    { endpoint, keys: { p256dh: keys.p256dh } },
    { endpoint, keys: { auth: keys.auth } },
    { endpoint, keys: { p256dh: keys.p256dh, auth: short } },
    { endpoint, keys: { p256dh: compressed, auth: keys.auth } },
    { endpoint, keys: { p256dh: notStartingWith4, auth: keys.auth } },
    { endpoint, keys: { p256dh: "not base64!", auth: keys.auth } },
    { endpoint, keys: { p256dh: 5, auth: keys.auth } },
  ];
  for (const given of wrong) {
    assert.throws(
      () => checkSubscription(given),
      (error) => error instanceof Refusal && error.status === 400 && error.reason === "bad",
      JSON.stringify(given)
    );
  }
});

test("an address is filed the same way however it was written", () => {
  assert.equal(tidyEndpoint("https://FCM.googleapis.com/send/abc"), "https://fcm.googleapis.com/send/abc");
  const phone = newDevice();
  assert.equal(tidyEndpoint(phone.endpoint), checkSubscription(phone.subscription).endpoint);
  for (const wrong of [null, undefined, 42, {}, "not an address", "a".repeat(2001)]) {
    assert.throws(() => tidyEndpoint(wrong), (error) => error instanceof Refusal && error.reason === "bad");
  }
});

test("the page's data is fresh once a check has run today at or after the alert time", () => {
  const local = { date: "2026-11-20", minute: 905 };
  const fresh = (generated) => isFresh({ generated }, local, settings);
  assert.equal(fresh("2026-11-20T14:30:00+11:00"), true);
  assert.equal(fresh("2026-11-20T15:04:10+11:00"), true);
  assert.equal(fresh("2026-11-20T03:30:00Z"), true);
  // The morning's check does not count, nor does yesterday's afternoon check.
  assert.equal(fresh("2026-11-20T14:29:59+11:00"), false);
  assert.equal(fresh("2026-11-20T11:47:00+11:00"), false);
  assert.equal(fresh("2026-11-19T15:00:00+11:00"), false);
  assert.equal(fresh("not a time"), false);
  assert.equal(fresh(undefined), false);
  assert.equal(isFresh(null, local, settings), false);
  assert.equal(isFresh("text", local, settings), false);
});

test("today's notice is taken from the page's data", () => {
  const local = { date: "2026-11-20", minute: 905 };
  const data = pageData({
    generated: "2026-11-20T15:01:00+11:00",
    days: [day("2026-11-19", "Yesterday"), day("2026-11-20", "  Booked 5 PM to 7:30 PM  ", "Cricket training.\nRain likely between 3 PM and 8 PM."), day("2026-11-21", "Tomorrow")],
  });
  assert.deepEqual(noticeFor(data, local, settings), { title: "Booked 5 PM to 7:30 PM", body: "Cricket training.\nRain likely between 3 PM and 8 PM." });
});

test("data made earlier today is used as it is, and data from another day says that it may be out of date", () => {
  const local = { date: "2026-11-20", minute: 915 };
  const days = [day("2026-11-20", "No bookings today", "")];
  const morning = pageData({ generated: "2026-11-20T11:47:00+11:00", generatedText: "11:47 AM", days });
  assert.deepEqual(noticeFor(morning, local, settings), { title: "No bookings today", body: "" });

  const yesterday = pageData({ generated: "2026-11-19T19:47:00+11:00", generatedText: "Thu 19 Nov, 7:47 PM", days });
  assert.deepEqual(noticeFor(yesterday, local, settings), {
    title: "No bookings today",
    body: "⚠️ The page has not been updated since Thu 19 Nov, 7:47 PM, so this may be out of date.",
  });

  const withWords = pageData({ generated: "2026-11-19T19:47:00+11:00", generatedText: "", days: [day("2026-11-20", "Booked 5 PM to 7 PM", "Cricket.")] });
  assert.equal(noticeFor(withWords, local, settings).body, "Cricket.\n⚠️ The page has not been updated today, so this may be out of date.");

  const noTime = { days: [day("2026-11-20", "Booked 5 PM to 7 PM", "Cricket.")] };
  assert.match(noticeFor(noTime, local, settings).body, /has not been updated today/);
});

test("data without a notice for today gives none", () => {
  const local = { date: "2026-11-20", minute: 915 };
  const generated = "2026-11-20T15:01:00+11:00";
  assert.equal(noticeFor(pageData({ generated, days: [day("2026-11-19"), day("2026-11-21")] }), local, settings), null);
  assert.equal(noticeFor(pageData({ generated, days: [] }), local, settings), null);
  assert.equal(noticeFor(pageData({ generated, days: [{ date: "2026-11-20" }] }), local, settings), null);
  assert.equal(noticeFor(pageData({ generated, days: [{ date: "2026-11-20", notice: { title: "   ", body: "words" } }] }), local, settings), null);
  assert.equal(noticeFor(pageData({ generated, days: [{ date: "2026-11-20", notice: { title: 5 } }] }), local, settings), null);
  assert.equal(noticeFor(pageData({ generated, days: [null, "text", 5] }), local, settings), null);
  assert.equal(noticeFor({ days: "none" }, local, settings), null);
  assert.equal(noticeFor(null, local, settings), null);
});

test("a notice that is far too long is cut, and still fits in one notification", () => {
  const local = { date: "2026-11-20", minute: 915 };
  const data = pageData({ generated: "2026-11-20T15:01:00+11:00", days: [day("2026-11-20", "🐕".repeat(500), "⚠️".repeat(3000))] });
  const notice = noticeFor(data, local, settings);
  assert.equal(Array.from(notice.title).length, 120);
  assert.equal(Array.from(notice.body).length, 600);
  assert.ok(notice.title.endsWith("…"));
  assert.ok(notice.body.endsWith("…"));
  // Cut between characters, never through the middle of one.
  assert.equal(notice.title, "🐕".repeat(119) + "…");
  assert.ok(messageFor(notice, settings, "daily").length <= LARGEST_MESSAGE);
});

test("a notification is written in the shape that iPhones show by themselves", () => {
  const bytes = messageFor({ title: "Booked 5 PM to 7:30 PM", body: "Cricket training." }, settings, "daily");
  assert.ok(bytes instanceof Uint8Array);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(bytes)), {
    web_push: 8030,
    notification: {
      title: "Booked 5 PM to 7:30 PM",
      body: "Cricket training.",
      navigate: SITE,
      tag: "daily",
      renotify: true,
      lang: "en-AU",
      icon: `${SITE}icon-192.png`,
      badge: `${SITE}badge.png`,
    },
  });
});

test("the first notification says when to expect the alert", () => {
  assert.deepEqual(welcome(settings), { title: "Alerts are on", body: "You'll get one notification a day, at about 3 PM, saying when the oval is booked." });
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
