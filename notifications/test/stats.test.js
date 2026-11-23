// The counter behind the stats page, and the page it makes.

import assert from "node:assert/strict";
import { test } from "node:test";

import { Counter, MOST_A_DAY, MOST_NAMES, MOST_NEW_ROWS_A_DAY, MOST_VISITS_KEPT, describeAgent, describePlace, readDay, readHit, readMonth, sourceOf } from "../src/stats.js";
import { label, statsPage } from "../src/statspage.js";
import { SITE, at, clock, memoryStorage, settings } from "./standins.js";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1";
const ANDROID = "Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36";
const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15";
const WINDOWS_EDGE = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0";
const INSTAGRAM = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 350.0.0.0.0";
const HEADLESS = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/142.0.0.0 Safari/537.36";
const GOOGLEBOT = "Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";

// What the backend sees of a phone in Richmond on Telstra, and of a server.
const PHONE = { agent: IPHONE, city: "Richmond", region: "Victoria", regionCode: "VIC", country: "AU", asOrganization: "Telstra Limited" };
const SERVER = { agent: ANDROID, city: "Ashburn", region: "Virginia", regionCode: "VA", country: "US", asOrganization: "Amazon.com, Inc." };

function counter(start = at("2026-11-21", "09:00")) {
  const storage = memoryStorage();
  const time = clock(start);
  return { storage, time, counter: new Counter({ storage, now: time.now, settings }) };
}

const VISIT = { kind: "visit", newToday: true, newThisMonth: true, firstEver: true, since: null, nth: 1, source: "" };
const AGAIN = { kind: "visit", newToday: false, newThisMonth: false, firstEver: false, since: 0, nth: 2, source: "" };
const day = (storage, date = "2026-11-21") => storage.kept.get(`day:${date}`);

test("only a visit, a press with a plain name, or a stay is taken", () => {
  assert.deepEqual(readHit(VISIT), { ...VISIT, again: false, touch: false, mine: false, id: "" });
  const odd = readHit({ kind: "visit", newToday: "yes", since: -1, nth: 0.5, source: "  T.ME\n", id: "NOT-AN-ID" });
  assert.deepEqual(odd, { kind: "visit", newToday: false, newThisMonth: false, firstEver: false, since: null, nth: null, source: "t.me", again: false, touch: false, mine: false, id: "" });
  assert.deepEqual(readHit({ kind: "press", name: "buttons:t.me", id: "a1b2c3d4e5f60718" }), { kind: "press", name: "buttons:t.me", id: "a1b2c3d4e5f60718" });
  assert.deepEqual(readHit({ kind: "stay", seconds: 12.5 }), { kind: "stay", seconds: 12.5, id: "" });
  for (const bad of [null, "visit", {}, { kind: "other" }, { kind: "press" }, { kind: "press", name: "Buttons" }, { kind: "press", name: "<b>" }, { kind: "press", name: "a".repeat(65) }, { kind: "stay", seconds: -1 }, { kind: "stay", seconds: "5" }]) {
    assert.equal(readHit(bad), null, JSON.stringify(bad));
  }
});

test("a month and a day are taken only when they are written as one", () => {
  assert.equal(readMonth("2026-11"), "2026-11");
  for (const bad of ["2026-13", "2026-00", "2026-1", "November", "", null, "2026-11-01"]) assert.equal(readMonth(bad), null);
  assert.equal(readDay("2026-11-21"), "2026-11-21");
  for (const bad of ["2026-11-31", "2026-02-29", "2026-11", "21/11/2026", null]) assert.equal(readDay(bad), null);
});

test("a browser's description of itself gives its kind, system and browser, and a program is told apart", () => {
  assert.deepEqual(describeAgent(IPHONE), { kind: "phone", system: "iPhone", browser: "Safari (or an app's browser)", robot: false });
  assert.deepEqual(describeAgent(ANDROID), { kind: "phone", system: "Android", browser: "Chrome", robot: false });
  assert.deepEqual(describeAgent(MAC), { kind: "computer", system: "Mac", browser: "Safari", robot: false });
  // An iPad describes itself as a Mac. The page says it has a touch screen.
  assert.deepEqual(describeAgent(MAC, true), { kind: "tablet", system: "iPad", browser: "Safari (or an app's browser)", robot: false });
  assert.equal(describeAgent(WINDOWS_EDGE).browser, "Edge");
  assert.equal(describeAgent(INSTAGRAM).browser, "Instagram app");
  for (const program of [HEADLESS, GOOGLEBOT, "curl/8.4.0", "python-requests/2.32", ""]) assert.equal(describeAgent(program).robot, true, program);
});

test("the place is the city and the state, the network is its owner's name, and a data centre is noticed", () => {
  assert.deepEqual(describePlace(PHONE), { place: "Richmond, Victoria", network: "Telstra Limited", dataCentre: false });
  assert.deepEqual(describePlace(SERVER), { place: "Ashburn, US", network: "Amazon.com, Inc.", dataCentre: true });
  assert.equal(describePlace({ asOrganization: "DigitalOcean, LLC" }).dataCentre, true);
  // iCloud Private Relay goes out through these, and carries real people.
  for (const relay of ["Akamai Technologies, Inc.", "Cloudflare, Inc.", "Fastly, Inc."]) assert.equal(describePlace({ asOrganization: relay }).dataCentre, false);
  assert.deepEqual(describePlace({}), { place: "unknown", network: "unknown", dataCentre: false });
});

test("how a visitor found the page is told in words", () => {
  assert.equal(sourceOf(""), "no link (typed, a bookmark or an app)");
  assert.equal(sourceOf("qr"), "QR code");
  assert.equal(sourceOf("t.me"), "Telegram");
  assert.equal(sourceOf("org.telegram.messenger"), "Telegram");
  assert.equal(sourceOf("l.instagram.com"), "Instagram");
  assert.equal(sourceOf("www.google.com.au"), "Google");
  assert.equal(sourceOf("com.google.android.gm"), "Gmail");
  assert.equal(sourceOf("citizensbark.example", "citizensbark.example"), "this page");
  assert.equal(sourceOf("example.org"), "example.org");
  assert.equal(sourceOf("not a host!"), "other");
});

test("visits are counted by the day at the park, with the devices new that day, that month and ever", async () => {
  const { storage, time, counter: it } = counter(at("2026-11-21", "23:30"));
  await it.hit(VISIT, PHONE);
  await it.hit(AGAIN, PHONE);
  await it.hit({ ...AGAIN, newToday: true, since: 3, nth: 4 }, PHONE);
  // Half past midnight in Melbourne is still the 21st in UTC, but a new day at the park.
  time.forward(3600 * 1000);
  await it.hit({ ...AGAIN, newToday: true, since: 1 }, PHONE);
  const first = day(storage);
  assert.deepEqual(
    [first.visits, first.devices, first.monthly, first.fresh, first.returning, first.counted],
    [3, 2, 1, 1, 1, 3]
  );
  assert.deepEqual(first.hours, { 23: 3 });
  assert.deepEqual(first.hoursBack, { 23: 2 });
  assert.deepEqual(first.since, { "same day": 1, "2 to 7 days": 1 });
  assert.deepEqual(first.nth, { "1st": 1, "2nd": 1, "3rd to 5th": 1 });
  // Kind, place and network: once a day for each device.
  assert.deepEqual(first.kinds, { phone: 2 });
  assert.deepEqual(first.places, { "Richmond, Victoria": 2 });
  assert.deepEqual(first.networks, { "Telstra Limited": 2 });
  assert.deepEqual(first.sources, { "no link (typed, a bookmark or an app)": 3 });
  const second = day(storage, "2026-11-22");
  assert.deepEqual([second.visits, second.returning], [1, 1]);
  assert.deepEqual(second.since, { "next day": 1 });
});

test("a device new ever is new this month too, whatever it said", async () => {
  const { storage, counter: it } = counter();
  await it.hit({ ...VISIT, newThisMonth: false }, PHONE);
  assert.equal(day(storage).monthly, 1);
});

test("a look again at a tab left open is a visit, but not a return or a way in", async () => {
  const { storage, counter: it } = counter();
  await it.hit({ ...AGAIN, again: true, source: "t.me" }, PHONE);
  const today = day(storage);
  assert.equal(today.visits, 1);
  assert.deepEqual(today.since, {});
  assert.deepEqual(today.nth, {});
  assert.deepEqual(today.sources, { "back to a tab left open": 1 });
});

test("visits that look automated, and the owner's own, are counted apart", async () => {
  const { storage, counter: it } = counter();
  await it.hit(VISIT, SERVER);
  await it.hit(VISIT, { ...PHONE, agent: HEADLESS });
  await it.hit({ ...VISIT, mine: true }, PHONE);
  await it.hit({ kind: "press", name: "buttons:t.me" }, SERVER);
  await it.hit({ kind: "stay", seconds: 1 }, SERVER);
  const today = day(storage);
  assert.deepEqual([today.visits, today.devices, today.fresh, today.robots, today.mine], [0, 0, 0, 2, 1]);
  assert.deepEqual(today.robotWhy, { "comes from a data centre": 1, "says it is a program": 1 });
  assert.deepEqual(today.robotNets, { "Amazon.com, Inc.": 1, "Telstra Limited": 1 });
  assert.deepEqual(today.presses, {});
  assert.deepEqual(today.stays, {});
});

test("presses are counted by name, and a day keeps a limited number of names", async () => {
  const { storage, counter: it } = counter();
  await it.hit({ kind: "press", name: "buttons:t.me" }, PHONE);
  await it.hit({ kind: "press", name: "buttons:t.me" }, PHONE);
  for (let index = 0; index < MOST_NAMES + 5; index += 1) await it.hit({ kind: "press", name: `made-up-${index}` }, PHONE);
  const presses = day(storage).presses;
  assert.equal(presses["buttons:t.me"], 2);
  assert.equal(Object.keys(presses).length, MOST_NAMES + 1);
  assert.equal(presses.other, 6);
  // A name already kept is still counted under its own name.
  await it.hit({ kind: "press", name: "buttons:t.me" }, PHONE);
  assert.equal(day(storage).presses["buttons:t.me"], 3);
});

test("each look at the page is counted by how long it lasted", async () => {
  const { storage, counter: it } = counter();
  for (const seconds of [1, 4.9, 12, 90, 300, 3600]) await it.hit({ kind: "stay", seconds }, PHONE);
  assert.deepEqual(day(storage).stays, {
    "under 5 seconds": 2,
    "5 to 30 seconds": 1,
    "30 seconds to 2 minutes": 1,
    "2 to 10 minutes": 1,
    "over 10 minutes": 1,
  });
});

test("what is not a visit, a press or a stay is turned down and writes nothing", async () => {
  const { storage, counter: it } = counter();
  const answer = await it.hit({ kind: "press", name: "DROP TABLE" }, PHONE);
  assert.equal(answer.status, 400);
  assert.equal(storage.writes, 0);
});

test("a day kept before the lists existed still counts on", async () => {
  const { storage, counter: it } = counter();
  storage.kept.set("day:2026-11-21", { visits: 43, devices: 23, monthly: 23, fresh: 23, presses: { "share:open": 2 }, counted: 55 });
  await it.hit(AGAIN, PHONE);
  const today = day(storage);
  assert.deepEqual([today.visits, today.counted, today.presses["share:open"]], [44, 56, 2]);
  assert.deepEqual(today.hours, { "09": 1 });
  const report = await it.report();
  assert.equal(report.totals.visits, 44);
});

test("after the most a day, nothing more is written that day, and counting starts again the next", async () => {
  const { storage, time, counter: it } = counter();
  storage.kept.set("day:2026-11-21", { visits: MOST_A_DAY - 1, devices: 0, monthly: 0, fresh: 0, presses: {}, counted: MOST_A_DAY - 1 });
  await it.hit(AGAIN, PHONE);
  const writes = storage.writes;
  for (let index = 0; index < 10; index += 1) assert.equal((await it.hit(AGAIN, PHONE)).status, 200);
  assert.equal(storage.writes, writes);
  assert.equal(day(storage).visits, MOST_A_DAY);
  time.forward(24 * 3600 * 1000);
  await it.hit(AGAIN, PHONE);
  assert.equal(day(storage, "2026-11-22").visits, 1);
});

test("the report shows each day of the month so far, the month's totals and every month kept", async () => {
  const { storage, time, counter: it } = counter(at("2026-10-30", "12:00"));
  await it.hit(VISIT, PHONE);
  await it.hit({ kind: "press", name: "share:open" }, PHONE);
  time.set(at("2026-11-02", "12:00"));
  await it.hit({ ...VISIT, firstEver: false, since: 3, nth: 2 }, PHONE);
  await it.hit(VISIT, { ...PHONE, agent: ANDROID });
  await it.hit(AGAIN, PHONE);
  await it.hit({ kind: "press", name: "buttons:t.me" }, PHONE);
  await it.hit(VISIT, SERVER);
  time.set(at("2026-11-03", "08:00"));
  await it.hit({ ...VISIT, newThisMonth: false, firstEver: false, since: 1, nth: 3 }, PHONE);
  assert.ok(storage.kept.size >= 3);

  const now = await it.report();
  assert.equal(now.month, "2026-11");
  assert.equal(now.day, null);
  assert.equal(now.first, "2026-10");
  assert.deepEqual(now.days, [
    { date: "2026-11-03", visits: 1, devices: 1, fresh: 0, returning: 1, robots: 0, pressed: 0 },
    { date: "2026-11-02", visits: 3, devices: 2, fresh: 1, returning: 1, robots: 1, pressed: 1 },
    { date: "2026-11-01", visits: 0, devices: 0, fresh: 0, returning: 0, robots: 0, pressed: 0 },
  ]);
  const totals = now.totals;
  assert.deepEqual([totals.visits, totals.devices, totals.fresh, totals.returning, totals.robots, totals.pressed], [4, 2, 1, 2, 1, 1]);
  assert.deepEqual(totals.systems, { iPhone: 2, Android: 1 });
  assert.deepEqual(totals.hours, { "08": 1, 12: 3 });
  assert.deepEqual(
    now.months.map((one) => [one.month, one.visits, one.devices]),
    [
      ["2026-11", 4, 2],
      ["2026-10", 1, 1],
    ]
  );
  assert.equal(now.total.visits, 5);
  assert.equal(now.total.fresh, 2);

  // One day on its own: its own devices, not the month's.
  const second = await it.report(null, "2026-11-02");
  assert.equal(second.day, "2026-11-02");
  assert.equal(second.month, "2026-11");
  assert.deepEqual([second.totals.visits, second.totals.devices, second.totals.robots], [3, 2, 1]);
  // A day still to come, or one that is not a day, shows the month.
  assert.equal((await it.report(null, "2026-11-30")).day, null);
  assert.equal((await it.report(null, "nonsense")).day, null);

  // An earlier month shows every one of its days, the quiet ones too.
  const october = await it.report("2026-10");
  assert.equal(october.days.length, 31);
  assert.equal(october.days[0].date, "2026-10-31");
  assert.equal(october.days.find((one) => one.date === "2026-10-30").visits, 1);
  assert.deepEqual(october.totals.presses, { "share:open": 1 });

  // A month that is not written as one shows this month.
  assert.equal((await it.report("<script>")).month, "2026-11");
});

test("a year later, any month can still be looked at", async () => {
  const { time, counter: it } = counter(at("2026-11-21", "12:00"));
  await it.hit(VISIT, PHONE);
  time.set(at("2027-03-10", "12:00", "+11:00"));
  await it.hit(VISIT, PHONE);
  const november = await it.report("2026-11");
  assert.equal(november.totals.visits, 1);
  assert.equal(november.days.length, 30);
});

test("the page shows the numbers and the lists, names the presses in words and escapes what it shows", async () => {
  const { time, counter: it } = counter(at("2026-11-21", "12:00"));
  await it.hit({ ...VISIT, source: "qr" }, PHONE);
  await it.hit({ ...AGAIN, since: 2, nth: 3 }, PHONE);
  await it.hit({ kind: "press", name: "buttons:t.me" }, PHONE);
  await it.hit({ kind: "press", name: "how:example.org" }, PHONE);
  await it.hit({ kind: "stay", seconds: 40 }, PHONE);
  await it.hit(VISIT, { ...SERVER, asOrganization: "<b>Evil</b> Hosting (Amazon)" });
  await it.hit({ ...VISIT, mine: true }, PHONE);
  time.set(at("2026-12-01", "12:00"));
  const html = statsPage(await it.report("2026-11"), SITE);
  assert.match(html, /<title>Citizens Bark stats<\/title>/);
  assert.match(html, /<strong>November 2026<\/strong>/);
  assert.match(html, /href="\?month=2026-12">December 2026 →/);
  assert.doesNotMatch(html, /October 2026/); // nothing was counted before November
  assert.match(html, /Not counted above: 1 visit that looks automated, and 1 from your own devices\./);
  assert.match(html, /<a href="\?day=2026-11-21">Sat 21<\/a><\/td><td>2<\/td><td>1<\/td><td>1<\/td><td>0<\/td><td>1</);
  assert.match(html, /<td>12 PM<\/td><td>2<\/td><td>1<\/td>/);
  assert.match(html, /QR code<\/td><td>1</);
  assert.match(html, /2 to 7 days<\/td><td>1</);
  assert.match(html, /30 seconds to 2 minutes<\/td><td>1</);
  assert.match(html, /Richmond, Victoria<\/td><td>1</);
  assert.match(html, /Telegram button<\/td><td>1</);
  assert.match(html, /how:example\.org<\/td><td>1</);
  assert.match(html, /&lt;b&gt;Evil&lt;\/b&gt; Hosting \(Amazon\)<\/td><td>1</);
  assert.doesNotMatch(html, /<b>Evil/);
  assert.equal(label("how:feedback"), "Feedback button");
  assert.doesNotMatch(html, /<script/i);

  const one = statsPage(await it.report(null, "2026-11-21"), SITE);
  assert.match(one, /<strong>Sat 21 November 2026<\/strong>/);
  assert.match(one, /href="\?month=2026-11">← November 2026/);
  assert.doesNotMatch(one, /<h2>Each day<\/h2>/);
});

test("the page for a month with nothing in it says so", async () => {
  const { counter: it } = counter(at("2026-11-21", "12:00"));
  const html = statsPage(await it.report(), SITE);
  assert.match(html, /Nothing pressed this month yet/);
  assert.match(html, /Nothing counted yet/);
  assert.doesNotMatch(html, /When people visit/);
});

// ---------------------------------------------------------------------------
// One row per visitor
// ---------------------------------------------------------------------------

const ID = "a1b2c3d4e5f60718";
const OTHER = "9f8e7d6c5b4a3921";

test("each device with a number gets a row: what it is, where, how it came, when, how often, how long and what it pressed", async () => {
  const { storage, time, counter: it } = counter(at("2026-11-21", "09:00"));
  await it.hit({ ...VISIT, id: ID, source: "qr" }, PHONE);
  await it.hit({ kind: "stay", seconds: 40.4, id: ID }, PHONE);
  await it.hit({ kind: "press", name: "buttons:t.me", id: ID }, PHONE);
  await it.hit({ kind: "press", name: "buttons:t.me", id: ID }, PHONE);
  time.set(at("2026-11-21", "18:00"));
  await it.hit({ ...AGAIN, id: ID, source: "t.me" }, PHONE);
  time.set(at("2026-11-23", "08:00"));
  await it.hit({ ...AGAIN, newToday: true, since: 2, nth: 3, id: ID }, { ...PHONE, city: "Melbourne" });
  const row = storage.kept.get(`dev:${ID}`);
  assert.deepEqual(
    { ...row, times: row.times.length },
    {
      firstAt: at("2026-11-21", "09:00"),
      came: "QR code",
      lastCame: "no link (typed, a bookmark or an app)",
      visits: 3,
      days: 2,
      lastDate: "2026-11-23",
      lastAt: at("2026-11-23", "08:00"),
      times: 3,
      nth: 3,
      seconds: 40,
      looks: 1,
      presses: { "buttons:t.me": 2 },
      kind: "phone",
      system: "iPhone",
      browser: "Safari (or an app's browser)",
      place: "Melbourne, Victoria",
      network: "Telstra Limited",
      robot: false,
      mine: false,
    }
  );
  assert.equal(storage.kept.get("rows"), 1);
});

test("a press or a stay alone does not start a row, and nothing without a number does", async () => {
  const { storage, counter: it } = counter();
  await it.hit({ kind: "press", name: "buttons:t.me", id: ID }, PHONE);
  await it.hit({ kind: "stay", seconds: 3, id: ID }, PHONE);
  await it.hit(VISIT, PHONE);
  assert.equal([...storage.kept.keys()].some((key) => key.startsWith("dev:")), false);
});

test("a row keeps only its latest visits, and new rows stop at the day's limit", async () => {
  const { storage, time, counter: it } = counter();
  for (let index = 0; index < MOST_VISITS_KEPT + 5; index += 1) {
    await it.hit({ ...AGAIN, id: ID }, PHONE);
    time.forward(60000);
  }
  const row = storage.kept.get(`dev:${ID}`);
  assert.equal(row.visits, MOST_VISITS_KEPT + 5);
  assert.equal(row.times.length, MOST_VISITS_KEPT);
  storage.kept.set("day:2026-11-21", { ...storage.kept.get("day:2026-11-21"), newRows: MOST_NEW_ROWS_A_DAY });
  await it.hit({ ...VISIT, id: OTHER }, PHONE);
  assert.equal(storage.kept.has(`dev:${OTHER}`), false);
  // A row that exists is still kept up to date.
  await it.hit({ ...AGAIN, id: ID }, PHONE);
  assert.equal(storage.kept.get(`dev:${ID}`).visits, MOST_VISITS_KEPT + 6);
});

test("the visitors of a month or a day are listed, the latest first, with their visits in that period", async () => {
  const { time, counter: it } = counter(at("2026-11-21", "09:00"));
  await it.hit({ ...VISIT, id: ID }, PHONE);
  time.set(at("2026-11-22", "10:00"));
  await it.hit({ ...VISIT, id: OTHER }, SERVER);
  time.set(at("2026-11-22", "11:00"));
  await it.hit({ ...AGAIN, newToday: true, since: 1, id: ID }, PHONE);
  // Without being asked for, there is no list.
  assert.equal((await it.report()).visitors, null);
  const month = (await it.report(null, null, { visitors: true })).visitors;
  assert.deepEqual(
    month.map((one) => [one.id, one.inPeriod.length, one.robot]),
    [
      [ID, 2, false],
      [OTHER, 1, true],
    ]
  );
  assert.deepEqual(month[0].firstSeen, { date: "2026-11-21", minute: 540 });
  assert.deepEqual(month[0].inPeriod.map((one) => one.minute), [660, 540]);
  const first = (await it.report(null, "2026-11-21", { visitors: true })).visitors;
  assert.deepEqual(first.map((one) => [one.id, one.inPeriod.length]), [[ID, 1]]);
});

test("the page lists people, the owner's devices and programs apart, but only when it is locked", async () => {
  const { counter: it } = counter(at("2026-11-21", "09:00"));
  await it.hit({ ...VISIT, id: ID, source: "qr" }, PHONE);
  await it.hit({ kind: "stay", seconds: 200, id: ID }, PHONE);
  await it.hit({ kind: "press", name: "buttons:t.me", id: ID }, PHONE);
  await it.hit({ ...VISIT, id: OTHER }, { ...SERVER, asOrganization: "<i>Amazon</i>" });
  await it.hit({ ...VISIT, id: "0011223344556677", mine: true }, PHONE);
  const report = await it.report(null, null, { visitors: true });
  const html = statsPage(report, SITE, { locked: true });
  assert.match(html, /<h3>People <span class="muted">\(1\)<\/span><\/h3>/);
  assert.match(html, /<h3>Your own devices <span class="muted">\(1\)<\/span><\/h3>/);
  assert.match(html, /<h3>Look automated <span class="muted">\(1\)<\/span><\/h3>/);
  assert.match(html, /<b>Visitor a1b2<\/b> · phone, iPhone, Safari \(or an app&#39;s browser\)/);
  assert.match(html, /Richmond, Victoria · Telstra Limited/);
  assert.match(html, /Last Sat 21 Nov, 9:00 AM · 1 visit this month/);
  assert.match(html, /First came by QR code\. On the page for 3 minutes in all\. Pressed Telegram button\./);
  assert.match(html, /&lt;i&gt;Amazon&lt;\/i&gt;/);
  assert.doesNotMatch(html, /<i>Amazon/);
  // Open, the page never lists anyone, even if it was handed the list.
  const open = statsPage(report, SITE, { locked: false });
  assert.doesNotMatch(open, /Visitor a1b2/);
  assert.match(open, /The list of visitors appears here once the stats password is set/);
});
