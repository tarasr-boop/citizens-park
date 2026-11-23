// The part that connects the second timer, the counter and the bot to
// Cloudflare: which requests are let in, from where, and what the timer does.
// Cloudflare itself is stood in for here. The file runtime.js tries the same
// things in Cloudflare's own runtime.

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import * as everything from "../src/worker.js";
import worker, { Chats, Stats, Timer } from "../src/worker.js";
import { BOT, BOT_TOKEN, CHECK, ENV, GITHUB, TELEGRAM, at, day, memorySql, memoryStorage, pageData, world } from "./standins.js";

const PAGE = "https://citizensbark.example";
const BACKEND = "https://alerts.example";
const TODAY = "2026-11-20";
// Made up for these tests. On Cloudflare the real one is a secret, handed over at deploy time.
const TOKEN = "github_pat_11STANDIN0aBcDeFgHiJkLmNoPqRsTuVwXyZ";
const OFF = { on: false, look: null, check: null, token: null };

let net;
let realFetch;
let realNow;
let now;

beforeEach(() => {
  realFetch = globalThis.fetch;
  realNow = Date.now;
  net = world();
  now = at(TODAY, "10:00");
  globalThis.fetch = net.fetch;
  Date.now = () => now;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  Date.now = realNow;
});

/** Cloudflare's side: one object of each kind, made the first time it is asked for, each with its own storage. */
function cloudflare(env = ENV, storage = memoryStorage()) {
  const state = {
    storage,
    ready: null,
    blockConcurrencyWhile(work) {
      state.ready = work();
    },
  };
  const it = {
    storage,
    object: null,
    asked: [],
    env: {
      ...env,
      TIMER: {
        idFromName: (name) => ({ name }),
        get(id, options) {
          it.asked.push({ id, options });
          return {
            async fetch(address, init) {
              if (!it.object) it.object = new Timer(state, env);
              await state.ready;
              return it.object.fetch(new Request(address, init));
            },
          };
        },
      },
      STATS: {
        idFromName: (name) => ({ name }),
        get(id, options) {
          it.statsAsked.push({ id, options });
          return {
            async fetch(address, init) {
              if (!it.statsObject) it.statsObject = new Stats({ storage: it.statsStorage }, env);
              return it.statsObject.fetch(new Request(address, init));
            },
          };
        },
      },
      CHATS: {
        idFromName: (name) => ({ name }),
        get(id, options) {
          it.chatsAsked.push({ id, options });
          return {
            async fetch(address, init) {
              if (!it.chatsObject) {
                const chatsState = { storage: it.chatsStorage, ready: null, blockConcurrencyWhile: (work) => (chatsState.ready = work()) };
                it.chatsObject = new Chats(chatsState, env);
                await chatsState.ready;
              }
              return it.chatsObject.fetch(new Request(address, init));
            },
          };
        },
      },
    },
    // The bot's chats: an object of its own, with a database of its own.
    chatsStorage: Object.assign(memoryStorage(), { sql: memorySql() }),
    chatsObject: null,
    chatsAsked: [],
    // The counter behind the stats page: an object of its own, with storage of its own.
    statsStorage: memoryStorage(),
    statsObject: null,
    statsAsked: [],
    waits: [],
    ctx: {
      waitUntil(work) {
        it.waits.push(work);
      },
    },
  };
  return it;
}

function ask(cf, method, path, { origin = PAGE, body, headers = {} } = {}) {
  const all = { ...headers };
  if (origin) all.Origin = origin;
  if (body !== undefined && !("Content-Type" in all)) all["Content-Type"] = "application/json";
  const init = { method, headers: all };
  if (body !== undefined) init.body = typeof body === "string" ? body : JSON.stringify(body);
  return worker.fetch(new Request(BACKEND + path, init), cf.env);
}

async function tick(cf) {
  await worker.scheduled({ cron: "*/5 0-11,19-23 * * *", scheduledTime: now }, cf.env, cf.ctx);
  await Promise.all(cf.waits);
}

const status = async (cf) => (await ask(cf, "GET", "/status")).json();

test("the worker's file exports only what Cloudflare can call", () => {
  // Cloudflare refuses a worker whose main file exports anything else, a plain number for example.
  assert.deepEqual(Object.keys(everything).sort(), ["Chats", "Stats", "Timer", "default"]);
  assert.equal(typeof everything.Chats, "function");
  assert.equal(typeof everything.Timer, "function");
  assert.equal(typeof everything.Stats, "function");
  assert.deepEqual(Object.keys(everything.default).sort(), ["fetch", "scheduled"]);
});

test("anyone may ask how things are, and gets numbers only", async () => {
  const cf = cloudflare();
  for (const path of ["/", "/status"]) {
    const answer = await ask(cf, "GET", path, { origin: null });
    assert.equal(answer.status, 200);
    assert.equal(answer.headers.get("Content-Type"), "application/json; charset=utf-8");
    assert.equal(answer.headers.get("Cache-Control"), "no-store");
    assert.equal(answer.headers.get("X-Content-Type-Options"), "nosniff");
    assert.deepEqual(await answer.json(), { ok: true, starter: OFF, telegram: { on: false } });
  }
  // One second timer for everything, kept near the page and the people it serves.
  assert.deepEqual(cf.asked[0], { id: { name: "all" }, options: { locationHint: "oc" } });
});

test("only the page itself may read the answers from inside a browser", async () => {
  const cf = cloudflare();
  const mine = await ask(cf, "GET", "/status", { origin: PAGE });
  assert.equal(mine.headers.get("Access-Control-Allow-Origin"), PAGE);
  assert.equal(mine.headers.get("Vary"), "Origin");
  assert.equal((await mine.json()).ok, true);

  for (const origin of [null, "https://example.org", "http://citizensbark.example", "null"]) {
    const other = await ask(cf, "GET", "/status", { origin });
    assert.equal(other.status, 200);
    assert.equal(other.headers.get("Access-Control-Allow-Origin"), null, String(origin));
    assert.equal(other.headers.get("Vary"), "Origin");
  }
});

test("a browser's question beforehand is answered without waking anything", async () => {
  const cf = cloudflare();
  const answer = await ask(cf, "OPTIONS", "/hit", { headers: { "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" } });
  assert.equal(answer.status, 204);
  assert.equal(answer.headers.get("Access-Control-Allow-Origin"), PAGE);
  assert.equal(answer.headers.get("Access-Control-Allow-Methods"), "GET, POST, OPTIONS");
  assert.equal(answer.headers.get("Access-Control-Allow-Headers"), "Content-Type");
  assert.equal(await answer.text(), "");

  const other = await ask(cf, "OPTIONS", "/hit", { origin: "https://example.org" });
  assert.equal(other.status, 204);
  assert.equal(other.headers.get("Access-Control-Allow-Origin"), null);
  assert.equal(cf.asked.length + cf.statsAsked.length + cf.chatsAsked.length, 0);
});

test("nothing else is answered, and nobody outside can start a look", async () => {
  const cf = cloudflare();
  const unknown = [
    ["POST", "/tick"],
    ["GET", "/tick"],
    ["POST", "/status"],
    ["POST", "/"],
    ["GET", "/favicon.ico"],
    ["GET", "/status/"],
    ["GET", "//status"],
    ["GET", "/alarm"],
    // What the browser notifications used, until they were taken off the page.
    ["GET", "/key"],
    ["POST", "/subscribe"],
    ["POST", "/unsubscribe"],
    ["PUT", "/subscribe"],
    ["DELETE", "/subscribe"],
  ];
  for (const [method, path] of unknown) {
    const answer = await ask(cf, method, path, method === "GET" ? {} : { body: {} });
    assert.equal(answer.status, 404, `${method} ${path}`);
    assert.deepEqual(await answer.json(), { ok: false, reason: "unknown" });
  }
  assert.equal(cf.asked.length, 0);
  assert.equal(net.calls.length, 0);
});

test("settings that make no sense are reported plainly", async () => {
  const cf = cloudflare({ ...ENV, TIMEZONE: "Australia/Richmond" });
  const answer = await ask(cf, "GET", "/status");
  assert.equal(answer.status, 500);
  assert.deepEqual(await answer.json(), { ok: false, reason: "settings", detail: "TIMEZONE Australia/Richmond is not a known time zone" });
  assert.equal(cf.asked.length, 0);
});

test("if the second timer stumbles, the status page says to try again later", async () => {
  const cf = cloudflare();
  cf.env.TIMER.get = () => ({
    fetch: async () => {
      throw new Error("the object was reset");
    },
  });
  const answer = await ask(cf, "GET", "/status");
  assert.equal(answer.status, 503);
  assert.deepEqual(await answer.json(), { ok: false, reason: "later" });
  assert.equal(answer.headers.get("Access-Control-Allow-Origin"), PAGE);

  cf.env.TIMER.get = () => ({ fetch: async () => new Response("<html>an error page</html>", { status: 500 }) });
  const second = await ask(cf, "GET", "/status");
  assert.equal(second.status, 503);
  assert.deepEqual(await second.json(), { ok: false, reason: "later" });
});

test("a failure of the timer's look is only noted", async () => {
  const broken = cloudflare();
  broken.env.TIMER.get = () => ({
    fetch: async () => {
      throw new Error("the object was reset");
    },
  });
  await tick(broken); // does not throw

  const stumbling = cloudflare({ ...ENV, ...CHECK, DAILY_CHECK_TOKEN: TOKEN });
  await status(stumbling); // wakes the object, so that its parts can be reached
  stumbling.object.starter.look = async () => {
    throw new Error("the second timer broke");
  };
  const answer = await stumbling.object.fetch(new Request("https://timer/tick", { method: "POST" }));
  assert.equal(answer.status, 500);
  assert.deepEqual(await answer.json(), { ok: false });
});

test("without a token the second timer stays off, and the timer's look asks nothing of GitHub", async () => {
  // The four settings are there, as in wrangler.jsonc, but no token has been handed over.
  const cf = cloudflare({ ...ENV, ...CHECK });
  net.page = pageData({ generated: `${TODAY}T13:50:00+11:00`, days: [day(TODAY)] });
  now = at(TODAY, "14:55");
  await tick(cf);
  assert.equal(net.asks.length, 0);
  assert.equal(net.reads.length, 0);
  assert.deepEqual((await status(cf)).starter, OFF);
});

test("with a token, the timer's look starts the check on GitHub when the page shows none", async () => {
  const cf = cloudflare({ ...ENV, ...CHECK, DAILY_CHECK_TOKEN: TOKEN });
  net.page = pageData({ generated: `${TODAY}T13:50:00+11:00`, days: [day(TODAY)] });
  now = at(TODAY, "14:55");
  await tick(cf);

  assert.deepEqual(
    net.asks.map((call) => `${call.method} ${call.url}`),
    [`GET ${GITHUB}repos/someone/park/actions/workflows/daily.yml`, `POST ${GITHUB}repos/someone/park/actions/workflows/daily.yml/dispatches`]
  );
  assert.equal(net.starts[0].headers.Authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(JSON.parse(net.starts[0].body), { ref: "main" });
  // The page's data is read fresh, past any copy kept on the way.
  assert.match(net.reads[0].url, /^https:\/\/citizensbark\.example\/data\.json\?t=\d+$/);

  const answer = await ask(cf, "GET", "/status", { origin: null });
  const text = await answer.text();
  // Anyone may read the status, so the token must not be in it.
  assert.equal(text.includes(TOKEN), false);
  assert.equal(text.includes("github_pat"), false);
  // The deploy on GitHub looks for exactly these words to know that the second timer is on.
  assert.ok(text.includes('"starter":{"on":true'), text);
  assert.deepEqual(JSON.parse(text).starter, {
    on: true,
    look: { at: now, did: "started", why: "the page showed no 2:40 PM check" },
    check: { date: TODAY, time: "14:40", tries: 1, fails: 0, at: now, answer: 204, done: false },
    token: { date: TODAY, at: now, answer: 200, ok: true },
  });

  // The check ran. Five minutes later the page is new, and nothing more is asked of GitHub.
  net.page = pageData({ generated: `${TODAY}T14:56:00+11:00`, days: [day(TODAY)] });
  now = at(TODAY, "15:00");
  await tick(cf);
  assert.equal(net.asks.length, 2);
  assert.equal((await status(cf)).starter.check.done, true);
});

/** What the browser notifications left in the object that is now the second timer's. */
function leftOver(storage, devices) {
  for (let index = 0; index < devices; index += 1) {
    storage.kept.set(`sub:device-${String(index).padStart(4, "0")}`, { endpoint: `https://fcm.googleapis.com/send/${index}`, p256dh: "key", auth: "secret", added: 1, fails: 0 });
  }
  storage.kept.set("vapid", { privateJwk: { kty: "EC" }, publicKey: "public" });
  storage.kept.set("count", devices);
  storage.kept.set("last", { date: "2026-11-22", sent: 1 });
  storage.kept.set("tick", { at: 1, did: "nothing", why: "too early" });
  storage.kept.set("hosts", {});
  storage.kept.set("refusals", { "web.push.apple.com 400": { times: 1, on: "2026-11-22", said: "reason BadWebPushTopic" } });
  storage.kept.set("day", { date: "2026-11-22", at: 1 });
  storage.kept.set("job", { date: "2026-11-23" });
  storage.alarm = 1;
}

test("what the browser notifications kept is deleted when the object first wakes, and the second timer's notes stay", async () => {
  const storage = memoryStorage();
  // More devices than one round of deleting takes.
  leftOver(storage, 300);
  storage.kept.set("starter", { date: TODAY, time: 880, tries: 1, fails: 0, at: 1, answer: 204, done: true });
  storage.kept.set("starterLook", { at: 1, did: "nothing", why: "the 2:40 PM check has run" });
  storage.kept.set("starterToken", { date: TODAY, at: 1, answer: 200, ok: true, mark: "abcdef01" });
  const cf = cloudflare({ ...ENV, ...CHECK, DAILY_CHECK_TOKEN: TOKEN }, storage);
  const said = await status(cf);
  assert.deepEqual([...storage.kept.keys()].sort(), ["starter", "starterLook", "starterToken"]);
  // The wake-up call of a round of sending that was under way is gone too.
  assert.equal(storage.alarm, null);
  // The status page no longer speaks of devices.
  assert.deepEqual(Object.keys(said), ["ok", "starter", "telegram"]);
  assert.equal(said.starter.check.done, true);

  // Once it is done, a new wake only looks: nothing is written or deleted.
  const writes = storage.writes;
  const again = cloudflare({ ...ENV, ...CHECK, DAILY_CHECK_TOKEN: TOKEN }, storage);
  await status(again);
  assert.equal(storage.writes, writes);
});

test("a tidy-up that stumbles does not stop the second timer", async () => {
  const storage = memoryStorage();
  leftOver(storage, 3);
  storage.delete = async () => {
    throw new Error("storage is busy");
  };
  const cf = cloudflare({ ...ENV, ...CHECK, DAILY_CHECK_TOKEN: TOKEN }, storage);
  net.page = pageData({ generated: `${TODAY}T13:50:00+11:00`, days: [day(TODAY)] });
  now = at(TODAY, "14:55");
  await tick(cf);
  assert.equal(net.starts.length, 1);
  assert.equal((await status(cf)).starter.look.did, "started");
});

const PHONE_AGENT = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1";

test("the page counts a visit and a press, the way a browser sends them as it leaves", async () => {
  const cf = cloudflare();
  // A beacon is sent as plain text, so the browser asks nothing beforehand.
  const headers = { "Content-Type": "text/plain;charset=UTF-8", "User-Agent": PHONE_AGENT };
  const visit = await ask(cf, "POST", "/hit", { headers, body: JSON.stringify({ kind: "visit", newToday: true, newThisMonth: true, firstEver: true, nth: 1 }) });
  assert.equal(visit.status, 204);
  assert.equal(await visit.text(), "");
  assert.equal(visit.headers.get("Access-Control-Allow-Origin"), PAGE);
  const press = await ask(cf, "POST", "/hit", { headers, body: JSON.stringify({ kind: "press", name: "buttons:t.me" }) });
  assert.equal(press.status, 204);
  const today = cf.statsStorage.kept.get(`day:${TODAY}`);
  assert.deepEqual([today.visits, today.devices, today.fresh, today.robots, today.counted], [1, 1, 1, 0, 2]);
  assert.deepEqual(today.presses, { "buttons:t.me": 1 });
  assert.deepEqual(today.systems, { iPhone: 1 });
  // One counter for everyone, near the people it serves, and the second timer is not woken for it.
  assert.deepEqual(cf.statsAsked[0], { id: { name: "all" }, options: { locationHint: "oc" } });
  assert.equal(cf.asked.length, 0);
});

test("the counter is told the rough place and network Cloudflare found, and never the address", async () => {
  const cf = cloudflare();
  const request = new Request(BACKEND + "/hit", {
    method: "POST",
    headers: { Origin: PAGE, "User-Agent": PHONE_AGENT, "CF-Connecting-IP": "203.0.113.7", "Content-Type": "text/plain" },
    body: JSON.stringify({ kind: "visit", newToday: true, newThisMonth: true, firstEver: true }),
  });
  // What Cloudflare puts on a request it hands to the worker.
  Object.defineProperty(request, "cf", { value: { city: "Richmond", region: "Victoria", regionCode: "VIC", country: "AU", asOrganization: "Telstra Limited", asn: 1221, latitude: "-37.8", postalCode: "3121" } });
  assert.equal((await worker.fetch(request, cf.env)).status, 204);
  const today = cf.statsStorage.kept.get(`day:${TODAY}`);
  assert.deepEqual(today.places, { "Richmond, Victoria": 1 });
  assert.deepEqual(today.networks, { "Telstra Limited": 1 });
  const kept = JSON.stringify([...cf.statsStorage.kept.values()]);
  for (const secret of ["203.0.113.7", "-37.8", "3121", "1221"]) assert.equal(kept.includes(secret), false, secret);
});

test("only the page may count, and only what it sends is counted", async () => {
  const cf = cloudflare();
  const body = { kind: "visit", newToday: true };
  for (const origin of [null, "https://example.org", "null"]) {
    assert.equal((await ask(cf, "POST", "/hit", { origin, body })).status, 403, String(origin));
  }
  assert.equal((await ask(cf, "POST", "/hit", { body: "not json" })).status, 400);
  assert.equal((await ask(cf, "POST", "/hit", { body: { kind: "press", name: "<img>" } })).status, 400);
  assert.equal((await ask(cf, "POST", "/hit", { body: { kind: "press", name: "x".repeat(600) } })).status, 413);
  assert.equal((await ask(cf, "GET", "/hit")).status, 404);
  assert.equal(cf.statsStorage.writes, 0);
});

test("without a password set, anyone may open the stats page, which runs no script and shows counts only", async () => {
  const cf = cloudflare();
  await ask(cf, "POST", "/hit", { body: { kind: "visit", newToday: true, newThisMonth: true, firstEver: true }, headers: { "User-Agent": PHONE_AGENT } });
  const page = await ask(cf, "GET", "/stats", { origin: null });
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("Content-Type"), "text/html; charset=utf-8");
  assert.equal(page.headers.get("Cache-Control"), "no-store");
  assert.match(page.headers.get("Content-Security-Policy"), /^default-src 'none';.*frame-ancestors 'none'/);
  const html = await page.text();
  assert.match(html, /<strong>November 2026<\/strong>/);
  assert.match(html, /Fri 20<\/a> ·<\/td><td>1</);

  const day = await (await ask(cf, "GET", "/stats?day=2026-11-20", { origin: null })).text();
  assert.match(day, /<strong>Fri 20 November 2026<\/strong>/);

  const october = await (await ask(cf, "GET", "/stats?month=2026-10", { origin: null })).text();
  assert.match(october, /<strong>October 2026<\/strong>/);
  const odd = await (await ask(cf, "GET", "/stats?month=%3Cb%3E", { origin: null })).text();
  assert.match(odd, /<strong>November 2026<\/strong>/);
});

const WITH_PASSWORD = { ...ENV, STATS_PASSWORD: "correct horse battery" };
const signIn = (password, name = "taras") => ({ Authorization: `Basic ${btoa(`${name}:${password}`)}` });

test("with a password set, the stats page asks for it and only then lists the visitors", async () => {
  const cf = cloudflare(WITH_PASSWORD);
  const id = "a1b2c3d4e5f60718";
  await ask(cf, "POST", "/hit", { body: { kind: "visit", newToday: true, newThisMonth: true, firstEver: true, nth: 1, id }, headers: { "User-Agent": PHONE_AGENT } });

  // Without it, or with a wrong one, the browser is asked for it and sees nothing else.
  for (const headers of [{}, signIn("wrong"), signIn(""), { Authorization: "Basic !!!" }, { Authorization: "Bearer correct horse battery" }, { Authorization: `Basic ${btoa("no colon")}` }]) {
    const refused = await ask(cf, "GET", "/stats", { origin: null, headers });
    assert.equal(refused.status, 401, JSON.stringify(headers));
    assert.equal(refused.headers.get("WWW-Authenticate"), 'Basic realm="Citizens Bark stats", charset="UTF-8"');
    assert.equal(refused.headers.get("Cache-Control"), "no-store");
    const text = await refused.text();
    assert.equal(text.includes("Visitors"), false);
    assert.equal(text.includes("iPhone"), false);
  }
  // The counter is not even asked.
  assert.equal(cf.statsAsked.length, 1);

  // With it (any name will do), the visitors are listed.
  for (const name of ["taras", ""]) {
    const page = await ask(cf, "GET", "/stats", { origin: null, headers: signIn("correct horse battery", name) });
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /<details class="visitor">/);
    assert.match(html, /iPhone/);
    // The device's own id stays in the counter.
    assert.equal(html.includes(id), false);
  }
  // A day view lists that day's visitors, and the address cannot unlock the list by itself.
  const day = await (await ask(cf, "GET", "/stats?day=2026-11-20", { origin: null, headers: signIn("correct horse battery") })).text();
  assert.match(day, /<details class="visitor">/);
  assert.equal((await ask(cf, "GET", "/stats?visitors=1", { origin: null })).status, 401);
});

test("behind the password, the page offers every day and every visitor as Excel or JSON, and its buttons need no second sign-in", async () => {
  const cf = cloudflare(WITH_PASSWORD);
  const id = "a1b2c3d4e5f60718";
  const headers = { "User-Agent": PHONE_AGENT };
  await ask(cf, "POST", "/hit", { body: { kind: "visit", newToday: true, newThisMonth: true, firstEver: true, nth: 1, source: "qr", id }, headers });
  await ask(cf, "POST", "/hit", { body: { kind: "press", name: "buttons:t.me", id }, headers });
  await ask(cf, "POST", "/hit", { body: { kind: "stay", seconds: 42, id }, headers });
  now += 3 * 60 * 60 * 1000;
  await ask(cf, "POST", "/hit", { body: { kind: "visit", newToday: false, newThisMonth: false, firstEver: false, since: 0, nth: 2, id }, headers });
  await ask(cf, "POST", "/hit", { body: { kind: "visit", newToday: true, newThisMonth: true, firstEver: true, mine: true, id: "9f8e7d6c5b4a3921" }, headers });

  const page = await (await ask(cf, "GET", "/stats", { origin: null, headers: signIn("correct horse battery") })).text();
  const links = [...page.matchAll(/<a class="button" href="(\/stats\/export\.(xlsx|json)\?until=(\d{13})&amp;key=([0-9a-f]{64}))">/g)];
  assert.deepEqual(links.map((one) => one[2]), ["xlsx", "json"]);
  assert.match(page, />Download as Excel</);
  // A link works for 12 hours.
  assert.equal(Number(links[0][3]), now + 12 * 60 * 60 * 1000);
  const [excelLink, jsonLink] = links.map((one) => one[1].replace(/&amp;/g, "&"));

  // The page's buttons download without the browser being asked again.
  const excel = await ask(cf, "GET", excelLink, { origin: null });
  assert.equal(excel.status, 200);
  assert.equal(excel.headers.get("Content-Type"), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  assert.equal(excel.headers.get("Content-Disposition"), `attachment; filename="citizens-bark-stats-${TODAY}.xlsx"`);
  assert.equal(excel.headers.get("Cache-Control"), "no-store");
  const bytes = new Uint8Array(await excel.arrayBuffer());
  assert.deepEqual([...bytes.slice(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
  const inside = new TextDecoder().decode(bytes);
  for (const sheet of ["About", "Months", "Days", "Visitors", "Visits", "Breakdowns"]) assert.match(inside, new RegExp(`<sheet name="${sheet}"`));
  assert.match(inside, /Telegram button/);
  assert.equal(inside.includes(id), false);
  assert.equal((await ask(cf, "GET", jsonLink, { origin: null })).headers.get("Content-Type"), "application/json; charset=utf-8");

  // A changed key, a link for longer than 12 hours, or one that has run out does not.
  const [, , until, key] = links[0];
  const wrongKey = `/stats/export.xlsx?until=${until}&key=${key.slice(0, -1)}${key.endsWith("0") ? "1" : "0"}`;
  const longer = `/stats/export.xlsx?until=${Number(until) + 1}&key=${key}`;
  for (const path of [wrongKey, longer, "/stats/export.xlsx?until=&key=", "/stats/export.xlsx?until=9999999999999&key=" + "0".repeat(64)]) {
    assert.equal((await ask(cf, "GET", path, { origin: null })).status, 401, path);
  }
  // It opens the files only, never the page.
  assert.equal((await ask(cf, "GET", `/stats?until=${until}&key=${key}`, { origin: null })).status, 401);
  const before = now;
  now += 12 * 60 * 60 * 1000;
  assert.equal((await ask(cf, "GET", excelLink, { origin: null })).status, 401);
  now = before;
  // A new password ends the old links.
  const renamed = cloudflare({ ...WITH_PASSWORD, STATS_PASSWORD: "a different one" });
  assert.equal((await ask(renamed, "GET", excelLink, { origin: null })).status, 401);

  // With the password itself, the files download too.
  assert.equal((await ask(cf, "GET", "/stats/export", { origin: null })).status, 401);
  assert.equal((await ask(cf, "GET", "/stats/export", { origin: null, headers: signIn("wrong") })).status, 401);
  const answer = await ask(cf, "GET", "/stats/export", { origin: null, headers: signIn("correct horse battery") });
  assert.equal(answer.status, 200);
  assert.equal(answer.headers.get("Content-Type"), "application/json; charset=utf-8");
  assert.equal(answer.headers.get("Content-Disposition"), `attachment; filename="citizens-bark-stats-${TODAY}.json"`);
  assert.equal(answer.headers.get("Cache-Control"), "no-store");
  const text = await answer.text();
  // The devices' own numbers stay in the counter.
  assert.equal(text.includes(id), false);
  const file = JSON.parse(text);

  assert.equal(file.about.timeZone, "Australia/Melbourne");
  assert.equal(file.about.exported, `${TODAY} 13:00`);
  assert.equal(file.about.countingSince, TODAY);
  assert.ok(file.about.fields.visitor.visitTimes);
  assert.ok(file.about.fields.day.firstTimeDevices);

  assert.equal(file.days.length, 1);
  const [day] = file.days;
  assert.deepEqual(
    [day.date, day.visits, day.differentDevices, day.firstTimeDevices, day.returningDevices, day.automatedVisits, day.ownVisits],
    [TODAY, 2, 1, 1, 0, 0, 1]
  );
  assert.deepEqual(day.presses, { "Telegram button": 1 });
  assert.deepEqual(day.foundBy, { "QR code": 1, "no link (typed, a bookmark or an app)": 1 });
  assert.deepEqual(day.timeOnPage, { "30 seconds to 2 minutes": 1 });
  assert.deepEqual(day.systems, { iPhone: 1 });
  assert.equal("counted" in day, false);

  assert.deepEqual([file.totals.allTime.visits, file.totals.allTime.deviceDays, file.totals.allTime.daysWithData], [2, 1, 1]);
  assert.deepEqual(file.totals.byMonth.map((one) => [one.month, one.visits]), [["2026-11", 2]]);

  // Latest visit first; numbered by when each first came.
  assert.deepEqual(
    file.visitors.map((one) => [one.visitor, one.group, one.visits]),
    [
      [1, "person", 2],
      [2, "own device", 1],
    ]
  );
  const [person] = file.visitors;
  assert.deepEqual(person, {
    visitor: 1,
    group: "person",
    firstVisit: `${TODAY} 10:00`,
    firstCameBy: "QR code",
    lastVisit: `${TODAY} 13:00`,
    lastCameBy: "no link (typed, a bookmark or an app)",
    visits: 2,
    daysWithVisits: 1,
    visitNumberOnDevice: 2,
    visitTimes: [`${TODAY} 10:00`, `${TODAY} 13:00`],
    secondsOnPage: 42,
    looks: 1,
    presses: { "Telegram button": 1 },
    kind: person.kind,
    system: "iPhone",
    browser: person.browser,
    place: person.place,
    network: person.network,
  });
  assert.ok(person.kind);
});

test("without a password set, there is no file to download and no button for it", async () => {
  const cf = cloudflare();
  await ask(cf, "POST", "/hit", { body: { kind: "visit", newToday: true, newThisMonth: true, firstEver: true, id: "a1b2c3d4e5f60718" } });
  const refused = await ask(cf, "GET", "/stats/export", { origin: null, headers: signIn("anything") });
  assert.equal(refused.status, 403);
  assert.equal((await refused.text()).includes("a1b2c3d4e5f60718"), false);
  assert.equal((await (await ask(cf, "GET", "/stats", { origin: null })).text()).includes("/stats/export"), false);
  for (const path of ["/stats/export.xlsx", "/stats/export.json"]) assert.equal((await ask(cf, "GET", path, { origin: null })).status, 403);
  assert.equal((await ask(cf, "POST", "/stats/export", { body: {} })).status, 404);
});

test("without a password set, the visitors are never listed, whatever the address says", async () => {
  const cf = cloudflare();
  await ask(cf, "POST", "/hit", { body: { kind: "visit", newToday: true, newThisMonth: true, firstEver: true, nth: 1, id: "a1b2c3d4e5f60718" }, headers: { "User-Agent": PHONE_AGENT } });
  for (const path of ["/stats", "/stats?visitors=1", "/stats?day=2026-11-20&visitors=1"]) {
    const html = await (await ask(cf, "GET", path, { origin: null, headers: signIn("anything") })).text();
    assert.equal(html.includes('class="visitor"'), false, path);
    assert.match(html, /once the stats password is set/);
  }
  // Each device is still kept as a row, ready for when the password is set.
  assert.equal(cf.statsStorage.kept.has("dev:a1b2c3d4e5f60718"), true);
});

// ---------------------------------------------------------------------------
// The Telegram bot
// ---------------------------------------------------------------------------

const WITH_BOT = { ...ENV, ...BOT, TELEGRAM_BOT_TOKEN: BOT_TOKEN };

function update(cf, body, secret, extra = {}) {
  const headers = secret === undefined ? {} : { "X-Telegram-Bot-Api-Secret-Token": secret };
  return ask(cf, "POST", "/telegram", { origin: null, body, headers: { ...headers, ...extra } });
}

test("the bot sets itself up when the status page is first asked, and shows numbers only", async () => {
  const cf = cloudflare(WITH_BOT);
  const said = await status(cf);
  assert.equal(said.telegram.on, true);
  assert.equal(said.telegram.chats, 0);
  assert.equal(said.telegram.hook.ok, true);
  const hook = net.calls.find((call) => call.method === "setWebhook");
  assert.equal(hook.body.url, "https://alerts.example/telegram");
  assert.equal(JSON.stringify(said).includes(hook.body.secret_token), false);
  assert.equal(JSON.stringify(said).includes(BOT_TOKEN), false);
  // The bot's chats are kept apart from the second timer, near the people they serve.
  assert.deepEqual(cf.chatsAsked[0], { id: { name: "all" }, options: { locationHint: "oc" } });
});

test("Telegram, and only Telegram with the password, reaches the bot", async () => {
  const cf = cloudflare(WITH_BOT);
  await status(cf);
  const secret = net.calls.find((call) => call.method === "setWebhook").body.secret_token;
  const start = { update_id: 1, message: { message_id: 1, from: { id: 5, is_bot: false }, chat: { id: 5, type: "private" }, text: "/start" } };

  // Without the password, or with a wrong one, nothing happens. Where it comes from does not matter: Telegram sends no Origin.
  assert.equal((await update(cf, start)).status, 403);
  assert.equal((await update(cf, start, "wrong")).status, 403);
  assert.equal((await update(cf, start, "wrong", { Origin: PAGE })).status, 403);
  assert.equal(cf.chatsStorage.sql.chats().length, 0);

  const answer = await update(cf, start, secret);
  assert.equal(answer.status, 200);
  assert.deepEqual(await answer.json(), { ok: true });
  assert.deepEqual(cf.chatsStorage.sql.chats().map((chat) => [chat.id, chat.weekday, chat.weekend]), [[5, 16, 8]]);
  assert.equal(net.said.length, 1);
  assert.equal((await status(cf)).telegram.chats, 1);

  // Only POST, and nothing too long or that is not JSON.
  assert.equal((await ask(cf, "GET", "/telegram", { origin: null })).status, 404);
  assert.equal((await update(cf, "x".repeat(70000), secret)).status, 413);
  assert.equal((await update(cf, "not json", secret)).status, 400);
});

test("the timer's look also reaches the bot, and the bot's trouble does not stop the second timer", async () => {
  const cf = cloudflare({ ...WITH_BOT, ...CHECK, DAILY_CHECK_TOKEN: TOKEN });
  now = at("2026-11-23", "16:00");
  net.words = { generated: "2026-11-23T15:45+11:00", generatedText: "Mon 23 Nov, 3:45 PM", alerts: [{ date: "2026-11-23", hour: 16, about: "2026-11-23", weekend: false, text: "The words for 4 PM" }] };
  await status(cf);
  const secret = net.calls.find((call) => call.method === "setWebhook").body.secret_token;
  await update(cf, { update_id: 1, message: { message_id: 1, from: { id: 5 }, chat: { id: 5, type: "private" }, text: "/start" } }, secret);
  await tick(cf);
  assert.equal((await status(cf)).telegram.look.did, "started");
  // Cloudflare then wakes the bot's object to send.
  await cf.chatsObject.alarm();
  assert.deepEqual(net.said.at(-1), { chat_id: 5, text: "The words for 4 PM", parse_mode: "HTML", link_preview_options: { is_disabled: true } });
  assert.ok(net.calls.filter((call) => call.kind === "telegram").every((call) => call.url.startsWith(`${TELEGRAM}bot${BOT_TOKEN}/`)));

  cf.chatsObject.bot.tick = async () => {
    throw new Error("the bot broke");
  };
  now = at("2026-11-23", "16:05");
  await tick(cf);
  assert.equal((await status(cf)).starter.look.at, now);
});
