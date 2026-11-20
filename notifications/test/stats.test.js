// The counter behind the stats page, and the page it makes.

import assert from "node:assert/strict";
import { test } from "node:test";

import { Counter, MOST_A_DAY, MOST_NAMES, readHit, readMonth } from "../src/stats.js";
import { label, statsPage } from "../src/statspage.js";
import { SITE, at, clock, memoryStorage, settings } from "./standins.js";

function counter(start = at("2026-11-21", "09:00")) {
  const storage = memoryStorage();
  const time = clock(start);
  return { storage, time, counter: new Counter({ storage, now: time.now, settings }) };
}

const VISIT = { kind: "visit", newToday: true, newThisMonth: true, firstEver: true };
const AGAIN = { kind: "visit", newToday: false, newThisMonth: false, firstEver: false };

test("only a visit or a press with a plain name is taken", () => {
  assert.deepEqual(readHit(VISIT), VISIT);
  assert.deepEqual(readHit({ kind: "visit", newToday: "yes" }), { kind: "visit", newToday: false, newThisMonth: false, firstEver: false });
  assert.deepEqual(readHit({ kind: "press", name: "buttons:t.me" }), { kind: "press", name: "buttons:t.me" });
  for (const bad of [null, "visit", {}, { kind: "other" }, { kind: "press" }, { kind: "press", name: "Buttons" }, { kind: "press", name: "<b>" }, { kind: "press", name: "a".repeat(65) }]) {
    assert.equal(readHit(bad), null, JSON.stringify(bad));
  }
});

test("a month is taken only when it is written as one", () => {
  assert.equal(readMonth("2026-11"), "2026-11");
  for (const bad of ["2026-13", "2026-00", "2026-1", "November", "", null, "2026-11-01"]) assert.equal(readMonth(bad), null);
});

test("visits are counted by the day at the park, with the devices new that day, that month and ever", async () => {
  const { storage, time, counter: it } = counter(at("2026-11-21", "23:30"));
  await it.hit(VISIT);
  await it.hit(AGAIN);
  await it.hit({ kind: "visit", newToday: true, newThisMonth: false, firstEver: false });
  // Half past midnight in Melbourne is still the 21st in UTC, but a new day at the park.
  time.forward(3600 * 1000);
  await it.hit({ kind: "visit", newToday: true, newThisMonth: false, firstEver: false });
  const first = storage.kept.get("day:2026-11-21");
  assert.deepEqual({ ...first, presses: undefined }, { visits: 3, devices: 2, monthly: 1, fresh: 1, presses: undefined, counted: 3 });
  assert.equal(storage.kept.get("day:2026-11-22").visits, 1);
});

test("a device new ever is new this month too, whatever it said", async () => {
  const { storage, counter: it } = counter();
  await it.hit({ kind: "visit", newToday: true, newThisMonth: false, firstEver: true });
  assert.equal(storage.kept.get("day:2026-11-21").monthly, 1);
});

test("presses are counted by name, and a day keeps a limited number of names", async () => {
  const { storage, counter: it } = counter();
  await it.hit({ kind: "press", name: "buttons:t.me" });
  await it.hit({ kind: "press", name: "buttons:t.me" });
  for (let index = 0; index < MOST_NAMES + 5; index += 1) await it.hit({ kind: "press", name: `made-up-${index}` });
  const presses = storage.kept.get("day:2026-11-21").presses;
  assert.equal(presses["buttons:t.me"], 2);
  assert.equal(Object.keys(presses).length, MOST_NAMES + 1);
  assert.equal(presses.other, 6);
  // A name already kept is still counted under its own name.
  await it.hit({ kind: "press", name: "buttons:t.me" });
  assert.equal(storage.kept.get("day:2026-11-21").presses["buttons:t.me"], 3);
});

test("what is not a visit or a press is turned down and writes nothing", async () => {
  const { storage, counter: it } = counter();
  const answer = await it.hit({ kind: "press", name: "DROP TABLE" });
  assert.equal(answer.status, 400);
  assert.equal(storage.writes, 0);
});

test("after the most a day, nothing more is written that day, and counting starts again the next", async () => {
  const { storage, time, counter: it } = counter();
  storage.kept.set("day:2026-11-21", { visits: MOST_A_DAY - 1, devices: 0, monthly: 0, fresh: 0, presses: {}, counted: MOST_A_DAY - 1 });
  await it.hit(AGAIN);
  const writes = storage.writes;
  for (let index = 0; index < 10; index += 1) assert.equal((await it.hit(AGAIN)).status, 200);
  assert.equal(storage.writes, writes);
  assert.equal(storage.kept.get("day:2026-11-21").visits, MOST_A_DAY);
  time.forward(24 * 3600 * 1000);
  await it.hit(AGAIN);
  assert.equal(storage.kept.get("day:2026-11-22").visits, 1);
});

test("the report shows each day of the month so far, the month's totals and every month kept", async () => {
  const { storage, time, counter: it } = counter(at("2026-10-30", "12:00"));
  await it.hit(VISIT);
  await it.hit({ kind: "press", name: "share:open" });
  time.set(at("2026-11-02", "12:00"));
  await it.hit({ kind: "visit", newToday: true, newThisMonth: true, firstEver: false });
  await it.hit(VISIT);
  await it.hit(AGAIN);
  await it.hit({ kind: "press", name: "buttons:t.me" });
  time.set(at("2026-11-03", "08:00"));
  await it.hit({ kind: "visit", newToday: true, newThisMonth: false, firstEver: false });
  assert.ok(storage.kept.size >= 3);

  const now = await it.report();
  assert.equal(now.month, "2026-11");
  assert.equal(now.first, "2026-10");
  assert.deepEqual(now.days, [
    { date: "2026-11-03", visits: 1, devices: 1, pressed: 0 },
    { date: "2026-11-02", visits: 3, devices: 2, pressed: 1 },
    { date: "2026-11-01", visits: 0, devices: 0, pressed: 0 },
  ]);
  assert.deepEqual(now.totals, { visits: 4, devices: 2, fresh: 1, pressed: 1, presses: { "buttons:t.me": 1 } });
  assert.deepEqual(
    now.months.map((one) => [one.month, one.visits, one.devices]),
    [
      ["2026-11", 4, 2],
      ["2026-10", 1, 1],
    ]
  );
  assert.equal(now.total.visits, 5);
  assert.equal(now.total.fresh, 2);

  // An earlier month shows every one of its days, the quiet ones too.
  const october = await it.report("2026-10");
  assert.equal(october.days.length, 31);
  assert.equal(october.days[0].date, "2026-10-31");
  assert.equal(october.days.find((day) => day.date === "2026-10-30").visits, 1);
  assert.deepEqual(october.totals.presses, { "share:open": 1 });

  // A month that is not written as one shows this month.
  assert.equal((await it.report("<script>")).month, "2026-11");
});

test("a year later, any month can still be looked at", async () => {
  const { time, counter: it } = counter(at("2026-11-21", "12:00"));
  await it.hit(VISIT);
  time.set(at("2027-03-10", "12:00", "+11:00"));
  await it.hit(VISIT);
  const november = await it.report("2026-11");
  assert.equal(november.totals.visits, 1);
  assert.equal(november.days.length, 30);
});

test("the page shows the numbers, names the presses in words and escapes what it shows", async () => {
  const { time, counter: it } = counter(at("2026-11-21", "12:00"));
  await it.hit(VISIT);
  await it.hit({ kind: "press", name: "buttons:t.me" });
  await it.hit({ kind: "press", name: "how:example.org" });
  time.set(at("2026-12-01", "12:00"));
  const html = statsPage(await it.report("2026-11"), SITE);
  assert.match(html, /<title>Citizens Bark stats<\/title>/);
  assert.match(html, /<strong>November 2026<\/strong>/);
  assert.match(html, /href="\?month=2026-12">December 2026 →/);
  assert.doesNotMatch(html, /October 2026/); // nothing was counted before November
  assert.match(html, /Telegram button<\/td><td>1</);
  assert.match(html, /how:example\.org<\/td><td>1</);
  assert.match(html, /Sat 21<\/td><td>1<\/td><td>1<\/td><td>2</);
  assert.equal(label("how:feedback"), "Feedback button");
  assert.doesNotMatch(html, /<script/i);
});

test("the page for a month with nothing in it says so", async () => {
  const { counter: it } = counter(at("2026-11-21", "12:00"));
  const html = statsPage(await it.report(), SITE);
  assert.match(html, /Nothing pressed this month yet/);
  assert.match(html, /Nothing counted yet/);
});
