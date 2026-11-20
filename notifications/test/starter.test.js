// The second timer, which starts the daily check on GitHub when GitHub's own
// timer has not. Tried with stand-ins for the storage, the clock, the page
// and GitHub.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { Book } from "../src/book.js";
import { settingsFrom } from "../src/rules.js";
import { ASK_AGAIN_AFTER, EARLY_ENOUGH, LEAVE_AFTER, MOST_TRIES, START_AFTER, Starter, TRY_AGAIN_AFTER, dueTime, newEnough } from "../src/starter.js";
import { CHECK, ENV, GITHUB, GITHUB_WORDS, SITE, at, clock, day, memoryStorage, pageData, world } from "./standins.js";

const TODAY = "2026-11-20";
const TOMORROW = "2026-11-21";
// Made up for these tests. It has the look of a real one, so that a leak of it would be seen.
const TOKEN = "github_pat_11STANDIN0aBcDeFgHiJkLmNoPqRsTuVwXyZ";
const WORKFLOW = `${GITHUB}repos/someone/park/actions/workflows/daily.yml`;
const settings = settingsFrom({ ...ENV, ...CHECK });
const minute = (text) => Number(text.slice(0, 2)) * 60 + Number(text.slice(3));

/** The page's data as a check at `time` on `date` leaves it. */
function made(time, date = TODAY, offset = "+11:00") {
  return pageData({ generated: `${date}T${time}:00${offset}`, days: [day(date)] });
}

function open({ page = made("13:50"), github, start = at(TODAY, "06:00"), storage = memoryStorage(), token = TOKEN, env } = {}) {
  const time = clock(start);
  const net = world({ page, github });
  const lines = [];
  const using = env ? settingsFrom(env) : settings;
  const parts = { storage, fetch: net.fetch, now: time.now, settings: using, log: (line) => lines.push(line) };
  // The page is read the way the book reads it.
  const book = new Book(parts);
  const starter = new Starter({ ...parts, page: (now) => book.pageData(now), token });
  return { starter, storage, time, net, lines };
}

/** Let the second timer look once, at `time` on `date`. */
async function look(it, time, date = TODAY, offset = "+11:00") {
  it.time.set(at(date, time, offset));
  return it.starter.look();
}

test("the set time to look after is the latest one that is a quarter of an hour old", () => {
  const times = settings.check.times;
  assert.deepEqual(times, [377, 707, 827, 880, 910, 945, 1067, 1187]);
  const expected = [
    ["00:00", null],
    ["06:17", null],
    ["06:31", null],
    ["06:32", "06:17"],
    ["07:31", "06:17"],
    // An hour and a quarter after its set time, a check is left alone.
    ["07:32", null],
    ["12:01", null],
    ["12:02", "11:47"],
    ["14:02", "13:47"],
    ["14:54", "13:47"],
    ["14:55", "14:40"],
    ["15:24", "14:40"],
    ["15:25", "15:10"],
    ["15:59", "15:10"],
    ["16:00", "15:45"],
    ["16:59", "15:45"],
    ["17:00", null],
    ["18:02", "17:47"],
    ["20:02", "19:47"],
    ["21:01", "19:47"],
    ["21:02", null],
    ["23:59", null],
  ];
  for (const [now, due] of expected) {
    assert.equal(dueTime(times, minute(now)), due === null ? null : minute(due), now);
  }
  assert.equal(dueTime([], 900), null);
  assert.equal(START_AFTER, 15);
  assert.equal(LEAVE_AFTER, 60);
});

test("the page shows a check for a set time if its data was made then, a little before, or later that day", () => {
  const local = { date: TODAY, minute: minute("14:55") };
  const zone = settings.zone;
  const due = minute("14:40");
  assert.equal(EARLY_ENOUGH, 10);
  assert.equal(newEnough(made("14:41"), due, local, zone), true);
  assert.equal(newEnough(made("14:40"), due, local, zone), true);
  assert.equal(newEnough(made("14:30"), due, local, zone), true);
  assert.equal(newEnough(made("14:29"), due, local, zone), false);
  assert.equal(newEnough(made("13:50"), due, local, zone), false);
  // Yesterday's check at the same hour is not today's.
  assert.equal(newEnough(made("14:45", "2026-11-19"), due, local, zone), false);
  // The page writes the time without seconds.
  assert.equal(newEnough(pageData({ generated: "2026-11-20T14:42+11:00", days: [] }), due, local, zone), true);
  assert.equal(newEnough(pageData({ generated: "2026-11-20T14:29+11:00", days: [] }), due, local, zone), false);
  // The time is read as a moment, however it is written.
  assert.equal(newEnough(pageData({ generated: "2026-11-20T03:41:00Z", days: [] }), due, local, zone), true);
  assert.equal(newEnough(pageData({ generated: "2026-11-20T03:29:00Z", days: [] }), due, local, zone), false);
  for (const odd of [null, {}, { generated: "soon" }, { generated: 5 }, "text"]) {
    assert.equal(newEnough(odd, due, local, zone), false, JSON.stringify(odd));
  }
});

test("without a token, or without set times, the second timer asks nobody and writes nothing down", async () => {
  const none = open({ token: "" });
  const empty = open({ token: "   " });
  const missing = open({ token: null });
  const off = open({ env: { ...ENV, ...CHECK, CHECK_TIMES: "" } });
  for (const it of [none, empty, missing, off]) {
    for (const time of ["06:00", "06:32", "14:55", "20:02"]) {
      const said = await look(it, time);
      assert.equal(said.did, "nothing");
    }
    assert.equal(it.net.calls.length, 0);
    assert.equal(it.storage.writes, 0);
    assert.deepEqual(await it.starter.status(), { on: false, look: null, check: null, token: null });
    assert.deepEqual(it.lines, []);
  }
  assert.equal((await look(none, "14:55")).why, "no token");
  assert.equal((await look(off, "14:55")).why, "no set times");
});

test("once a day the token is shown to GitHub, and the answer is kept for the status page", async () => {
  const it = open();
  assert.deepEqual(await look(it, "06:00"), { did: "nothing", why: "no set time to look after" });
  assert.equal(it.net.calls.length, 1);
  const [ask] = it.net.asks;
  assert.equal(ask.method, "GET");
  assert.equal(ask.url, WORKFLOW);
  assert.deepEqual(ask.headers, { Accept: "application/vnd.github+json", Authorization: `Bearer ${TOKEN}`, "User-Agent": "citizens-bark-alerts" });
  assert.equal(ask.body, undefined);
  // If GitHub points elsewhere, the token does not follow.
  assert.equal(ask.options.redirect, "manual");
  assert.ok(ask.options.signal instanceof AbortSignal);
  assert.deepEqual((await it.starter.status()).token, { date: TODAY, at: at(TODAY, "06:00"), answer: 200, ok: true });

  // Not again that day.
  for (const time of ["06:05", "09:00", "21:30"]) await look(it, time);
  assert.equal(it.net.asks.length, 1);

  // Again the next day.
  await look(it, "06:00", TOMORROW);
  assert.equal(it.net.asks.length, 2);
  assert.deepEqual((await it.starter.status()).token, { date: TOMORROW, at: at(TOMORROW, "06:00"), answer: 200, ok: true });
});

test("a quarter of an hour after a set time, a page that shows no check for it gets the check started", async () => {
  const it = open();
  await look(it, "06:00");
  // Ten minutes after the set time it is too soon to say.
  assert.deepEqual(await look(it, "14:50"), { did: "nothing", why: "the 1:47 PM check has run" });
  assert.equal(it.net.starts.length, 0);

  assert.deepEqual(await look(it, "14:55"), { did: "started", why: "the page showed no 2:40 PM check" });
  assert.equal(it.net.starts.length, 1);
  const [start] = it.net.starts;
  assert.equal(start.url, `${WORKFLOW}/dispatches`);
  assert.equal(start.method, "POST");
  assert.deepEqual(start.headers, {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${TOKEN}`,
    "User-Agent": "citizens-bark-alerts",
    "Content-Type": "application/json",
  });
  // The same request the "Run workflow" button makes, with nothing chosen: the check decides by itself whether to post.
  assert.deepEqual(JSON.parse(start.body), { ref: "main" });
  assert.equal(start.options.redirect, "manual");

  const status = await it.starter.status();
  assert.equal(status.on, true);
  assert.deepEqual(status.look, { at: at(TODAY, "14:55"), did: "started", why: "the page showed no 2:40 PM check" });
  assert.deepEqual(status.check, { date: TODAY, time: "14:40", tries: 1, fails: 0, at: at(TODAY, "14:55"), answer: 204, done: false });
  assert.deepEqual(it.lines, ["the second timer started the 2:40 PM check (time 1 of 3)"]);
});

test("once the page shows the check, nothing more is started and the page is left in peace", async () => {
  const it = open();
  await look(it, "14:55");
  assert.equal(it.net.starts.length, 1);

  // The check has run and the page is new.
  it.net.page = made("14:56");
  assert.deepEqual(await look(it, "15:00"), { did: "nothing", why: "the 2:40 PM check has run" });
  assert.deepEqual((await it.starter.status()).check, { date: TODAY, time: "14:40", tries: 1, fails: 0, at: at(TODAY, "14:55"), answer: 204, done: true });

  const reads = it.net.reads.length;
  for (const time of ["15:05", "15:10", "15:15", "15:20"]) {
    assert.deepEqual(await look(it, time), { did: "nothing", why: "the 2:40 PM check has run" });
  }
  assert.equal(it.net.reads.length, reads);
  assert.equal(it.net.starts.length, 1);
});

test("a check that GitHub's own timer started in time is left alone", async () => {
  // GitHub's timer was a few minutes late, as it often is.
  const it = open({ page: made("14:49") });
  assert.deepEqual(await look(it, "14:55"), { did: "nothing", why: "the 2:40 PM check has run" });
  assert.equal(it.net.starts.length, 0);
  assert.deepEqual((await it.starter.status()).check, { date: TODAY, time: "14:40", tries: 0, fails: 0, at: null, answer: 0, done: true });

  // A check that ran a few minutes before the set time counts for it too. One from earlier does not.
  const early = open({ page: made("14:31") });
  assert.equal((await look(early, "14:55")).did, "nothing");
  assert.equal(early.net.starts.length, 0);
  const tooEarly = open({ page: made("14:29") });
  assert.equal((await look(tooEarly, "14:55")).did, "started");
});

test("every set time of the day is looked after, each a quarter of an hour late", async () => {
  // GitHub's timer never fires. Each check the second timer starts renews the page a minute later.
  const it = open({ page: made("19:48", "2026-11-19") });
  const startedAt = [];
  for (let now = 0; now < 1440; now += 5) {
    const time = `${String(Math.floor(now / 60)).padStart(2, "0")}:${String(now % 60).padStart(2, "0")}`;
    const said = await look(it, time);
    if (said.did === "started") {
      startedAt.push(time);
      it.net.page = made(`${time.slice(0, 3)}${String((now % 60) + 1).padStart(2, "0")}`);
    }
  }
  // 6:17, 11:47, 1:47, 2:40, 3:10, 3:45, 5:47 and 7:47, at the first look a quarter of an hour after each.
  assert.deepEqual(startedAt, ["06:35", "12:05", "14:05", "14:55", "15:25", "16:00", "18:05", "20:05"]);
  assert.equal(it.net.starts.length, 8);
  // One question about the token, and nothing else asked of GitHub.
  assert.equal(it.net.asks.length, 9);
});

test("a check that brings no newer page is started again after ten minutes, three times in all", async () => {
  const it = open();
  const said = {};
  for (const time of ["14:55", "15:00", "15:05", "15:10", "15:15", "15:20"]) said[time] = await look(it, time);
  assert.equal(TRY_AGAIN_AFTER, 10);
  assert.equal(MOST_TRIES, 3);
  assert.equal(said["14:55"].did, "started");
  assert.deepEqual(said["15:00"], { did: "nothing", why: "waiting for the 2:40 PM check that was started" });
  assert.equal(said["15:05"].did, "started");
  assert.equal(said["15:10"].did, "nothing");
  assert.equal(said["15:15"].did, "started");
  assert.deepEqual(said["15:20"], { did: "nothing", why: "the 2:40 PM check was started 3 times and the page is no newer" });
  assert.equal(it.net.starts.length, 3);
  assert.deepEqual((await it.starter.status()).check, { date: TODAY, time: "14:40", tries: 3, fails: 0, at: at(TODAY, "15:15"), answer: 204, done: false });

  // The next set time gets its own three.
  assert.deepEqual(await look(it, "15:25"), { did: "started", why: "the page showed no 3:10 PM check" });
  assert.equal((await it.starter.status()).check.time, "15:10");
  assert.equal((await it.starter.status()).check.tries, 1);
});

test("a request GitHub does not take is made again at the next look, and its number is shown", async () => {
  const answers = [500, "down", 403, 204];
  const it = open({ github: (call) => (call.method === "GET" ? 200 : answers.shift()) });
  assert.deepEqual(await look(it, "14:55"), { did: "failed", why: "GitHub answered 500" });
  assert.deepEqual((await it.starter.status()).check, { date: TODAY, time: "14:40", tries: 0, fails: 1, at: null, answer: 500, done: false });
  assert.deepEqual(await look(it, "15:00"), { did: "failed", why: "GitHub did not answer" });
  assert.deepEqual(await look(it, "15:05"), { did: "failed", why: "GitHub answered 403" });
  assert.deepEqual(await look(it, "15:10"), { did: "started", why: "the page showed no 2:40 PM check" });
  assert.deepEqual((await it.starter.status()).check, { date: TODAY, time: "14:40", tries: 1, fails: 3, at: at(TODAY, "15:10"), answer: 204, done: false });
  assert.deepEqual(it.lines, [
    "the second timer could not start the 2:40 PM check (GitHub answered 500)",
    "the second timer could not start the 2:40 PM check (GitHub answered nothing)",
    "the second timer could not start the 2:40 PM check (GitHub answered 403)",
    "the second timer started the 2:40 PM check (time 1 of 3)",
  ]);
});

test("an answer that points elsewhere is not followed, and counts as not taken", async () => {
  const it = open({ github: (call) => (call.method === "GET" ? 200 : 307) });
  assert.deepEqual(await look(it, "14:55"), { did: "failed", why: "GitHub answered 307" });
  assert.equal(it.net.calls.every((call) => call.kind !== "github" || call.url.startsWith(GITHUB)), true);
});

test("a token GitHub does not know is not used, and is asked about again every half hour", async () => {
  const it = open({ github: () => 401 });
  assert.equal(ASK_AGAIN_AFTER, 30);
  assert.deepEqual(await look(it, "06:00"), { did: "nothing", why: "GitHub does not take the token" });
  for (const time of ["06:05", "06:25"]) {
    assert.deepEqual(await look(it, time), { did: "nothing", why: "GitHub does not take the token" });
  }
  assert.equal(it.net.asks.length, 1);
  assert.deepEqual((await it.starter.status()).token, { date: TODAY, at: at(TODAY, "06:00"), answer: 401, ok: false });
  assert.deepEqual(it.lines, ["the second timer: GitHub did not take the token (answer 401)"]);

  // Through the rest of the day: one question every half hour, never a start, never a look at the page.
  for (let now = 390; now < 1320; now += 5) {
    const time = `${String(Math.floor(now / 60)).padStart(2, "0")}:${String(now % 60).padStart(2, "0")}`;
    assert.deepEqual(await look(it, time), { did: "nothing", why: "GitHub does not take the token" }, time);
  }
  assert.equal(it.net.asks.length, 32);
  assert.equal(it.net.asks.every((call) => call.method === "GET"), true);
  assert.equal(it.net.starts.length, 0);
  assert.equal(it.net.reads.length, 0);
  assert.deepEqual((await it.starter.status()).token, { date: TODAY, at: at(TODAY, "21:30"), answer: 401, ok: false });
});

test("a bad half hour at GitHub does not cost the day", async () => {
  // GitHub turns the token away once, by mistake, just when the afternoon's check is due.
  const it = open({ github: () => 401 });
  assert.deepEqual(await look(it, "14:55"), { did: "nothing", why: "GitHub does not take the token" });
  it.net.github = (call) => (call.method === "GET" ? 200 : 204);
  for (const time of ["15:00", "15:10", "15:20"]) {
    assert.deepEqual(await look(it, time), { did: "nothing", why: "GitHub does not take the token" });
  }
  assert.equal(it.net.asks.length, 1);
  // Half an hour later it is asked again, takes the token, and the check is started.
  assert.deepEqual(await look(it, "15:25"), { did: "started", why: "the page showed no 3:10 PM check" });
  assert.deepEqual((await it.starter.status()).token, { date: TODAY, at: at(TODAY, "15:25"), answer: 200, ok: true });
});

test("a token that stops working in the middle of the day is left alone for half an hour at a time", async () => {
  const it = open({ github: (call) => (call.method === "GET" ? 200 : 401) });
  await look(it, "06:00");
  assert.equal((await it.starter.status()).token.ok, true);
  assert.deepEqual(await look(it, "14:55"), { did: "failed", why: "GitHub answered 401" });
  assert.deepEqual((await it.starter.status()).token, { date: TODAY, at: at(TODAY, "14:55"), answer: 401, ok: false });
  it.net.github = () => 401;
  for (const time of ["15:00", "15:10", "15:20"]) {
    assert.deepEqual(await look(it, time), { did: "nothing", why: "GitHub does not take the token" });
  }
  assert.equal(it.net.asks.length, 2);
  assert.deepEqual(await look(it, "15:25"), { did: "nothing", why: "GitHub does not take the token" });
  assert.equal(it.net.asks.length, 3);
  assert.equal(it.net.starts.length, 1);
  assert.deepEqual(it.lines, [
    "the second timer could not start the 2:40 PM check (GitHub answered 401)",
    "the second timer: GitHub did not take the token (answer 401)",
    "the second timer: GitHub did not take the token (answer 401)",
  ]);
});

test("a new token is not judged by what GitHub said about the old one", async () => {
  const storage = memoryStorage();
  const old = open({ storage, github: () => 401 });
  await look(old, "14:55");
  assert.equal((await old.starter.status()).token.answer, 401);

  // A new token is handed over, and the backend starts again with it. Its notes are still there.
  const NEW = "github_pat_11STANDIN1zYxWvUtSrQpOnMlKjIhGfEdCbA";
  const fresh = open({ storage, token: NEW });
  assert.equal((await fresh.starter.status()).token, null);
  assert.deepEqual(await look(fresh, "15:00"), { did: "started", why: "the page showed no 2:40 PM check" });
  assert.equal(fresh.net.asks.every((call) => call.headers.Authorization === `Bearer ${NEW}`), true);
  assert.deepEqual((await fresh.starter.status()).token, { date: TODAY, at: at(TODAY, "15:00"), answer: 200, ok: true });

  // The same holds the other way round: the old token is not taken for good because the new one is.
  const back = open({ storage, github: () => 401 });
  assert.equal((await back.starter.status()).token, null);
  assert.deepEqual(await look(back, "15:05"), { did: "nothing", why: "GitHub does not take the token" });
});

test("no answer about the token says nothing about it, and the next look asks again", async () => {
  const answers = ["down", 503, 200];
  const it = open({ github: (call) => (call.method === "GET" ? answers.shift() : 204) });
  await look(it, "06:00");
  assert.equal((await it.starter.status()).token, null);
  await look(it, "06:05");
  assert.equal((await it.starter.status()).token, null);
  await look(it, "06:10");
  assert.deepEqual((await it.starter.status()).token, { date: TODAY, at: at(TODAY, "06:10"), answer: 200, ok: true });
  assert.equal(it.net.asks.length, 3);

  // While that question is open, a check is still started when it is due.
  const quiet = open({ github: (call) => (call.method === "GET" ? "down" : 204) });
  assert.equal((await look(quiet, "14:55")).did, "started");
});

test("a workflow GitHub cannot find is shown as such, and the check is still tried", async () => {
  const it = open({ github: () => 404 });
  await look(it, "06:00");
  assert.deepEqual((await it.starter.status()).token, { date: TODAY, at: at(TODAY, "06:00"), answer: 404, ok: false });
  assert.deepEqual(await look(it, "14:55"), { did: "failed", why: "GitHub answered 404" });
});

test("when the page cannot be read, the check is started, because once too often does no harm", async () => {
  for (const page of ["down", 500, "<html>not the data</html>"]) {
    const it = open({ page });
    assert.equal((await look(it, "14:55")).did, "started", String(page));
    assert.equal(it.net.starts.length, 1);
  }
});

test("a set time is left alone an hour and a quarter after it, and the night is quiet", async () => {
  const it = open({ page: made("17:50") });
  await look(it, "06:00");
  assert.equal((await look(it, "21:00")).did, "started");
  assert.deepEqual(await look(it, "21:05"), { did: "nothing", why: "no set time to look after" });
  const calls = it.net.calls.length;
  for (const time of ["21:30", "22:55", "23:55"]) {
    assert.deepEqual(await look(it, time), { did: "nothing", why: "no set time to look after" });
  }
  assert.equal(it.net.calls.length, calls);
});

test("yesterday's notes do not count for today", async () => {
  const it = open({ page: made("06:20") });
  await look(it, "06:35");
  assert.equal((await it.starter.status()).check.done, true);
  // The next morning the page still shows yesterday's last check.
  it.net.page = made("19:50");
  assert.equal((await look(it, "06:35", TOMORROW)).did, "started");
  assert.deepEqual((await it.starter.status()).check, { date: TOMORROW, time: "06:17", tries: 1, fails: 0, at: at(TOMORROW, "06:35"), answer: 204, done: false });
});

test("the set times are met in winter and on the days the clocks change", async () => {
  // A winter day (ten hours ahead of UTC), then the two Sundays on which the clocks change.
  const days = [
    ["2026-07-15", "+10:00"],
    ["2026-10-04", "+11:00"],
    ["2027-04-04", "+10:00"],
  ];
  for (const [date, offset] of days) {
    const it = open({ page: made("19:50", "2026-01-01"), start: at(date, "06:00", offset) });
    assert.equal((await look(it, "06:30", date, offset)).did, "nothing", date);
    assert.deepEqual(await look(it, "06:35", date, offset), { did: "started", why: "the page showed no 6:17 AM check" }, date);
    it.net.page = made("06:36", date, offset);
    assert.deepEqual(await look(it, "06:40", date, offset), { did: "nothing", why: "the 6:17 AM check has run" }, date);
    assert.equal((await it.starter.status()).check.date, date);
  }
});

test("the token goes to GitHub and nowhere else, and is never written down", async () => {
  const answers = [204, 500, "down", 401];
  const it = open({ page: made("19:50", "2026-11-19"), github: (call) => (call.method === "GET" ? 200 : answers.shift()) });
  for (const time of ["06:00", "06:35", "06:45", "06:50", "06:55", "07:00"]) await look(it, time);

  for (const call of it.net.calls) {
    if (call.kind === "github") {
      assert.ok(call.url === WORKFLOW || call.url === `${WORKFLOW}/dispatches`, call.url);
      assert.equal(call.headers.Authorization, `Bearer ${TOKEN}`);
    } else {
      // The page is asked for its data without it.
      assert.ok(call.url.startsWith(`${SITE}data.json?t=`), call.url);
      assert.equal(JSON.stringify(call.options).includes(TOKEN), false);
    }
  }
  assert.equal(it.net.starts.length, 4);

  const written = [JSON.stringify(await it.starter.status()), JSON.stringify([...it.storage.kept.entries()]), it.lines.join("\n")];
  for (const text of written) {
    assert.equal(text.includes(TOKEN), false);
    assert.equal(text.includes("github_pat"), false);
    // Nor anything GitHub said in its answers.
    assert.equal(text.includes(GITHUB_WORDS), false);
  }

  // What is kept of the token is its mark: eight letters that tell it from another token and give nothing of it away.
  const { mark } = it.storage.kept.get("starterToken");
  assert.match(mark, /^[0-9a-f]{8}$/);
  assert.equal(mark, createHash("sha256").update(TOKEN).digest("hex").slice(0, 8));
  assert.equal(TOKEN.includes(mark), false);
  // The mark stays in the notes. The status page and the log do not show it.
  assert.equal(written[0].includes(mark), false);
  assert.equal(written[2].includes(mark), false);
});

test("what the status shows is numbers, times and this file's own words", async () => {
  const it = open();
  await look(it, "14:55");
  const status = await it.starter.status();
  assert.deepEqual(Object.keys(status), ["on", "look", "check", "token"]);
  assert.deepEqual(Object.keys(status.look), ["at", "did", "why"]);
  assert.deepEqual(Object.keys(status.check), ["date", "time", "tries", "fails", "at", "answer", "done"]);
  assert.deepEqual(Object.keys(status.token), ["date", "at", "answer", "ok"]);
  // It names the repository nowhere: that is in the settings, for anyone to read.
  assert.equal(JSON.stringify(status).includes("someone/park"), false);
});

test("the second timer's notes are kept under names of their own, away from the book's", async () => {
  const it = open();
  await look(it, "14:55");
  assert.deepEqual([...it.storage.kept.keys()].sort(), ["starter", "starterLook", "starterToken"]);
});
