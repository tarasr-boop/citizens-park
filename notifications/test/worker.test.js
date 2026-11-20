// The part that connects the book to Cloudflare: which requests are let in,
// from where, and what the timer does. Cloudflare itself is stood in for here.
// The file runtime.js tries the same things in Cloudflare's own runtime.

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { MOST_BYTES } from "../src/rules.js";
import * as everything from "../src/worker.js";
import worker, { Chats, Stats, Subscribers } from "../src/worker.js";
import { BOT, BOT_TOKEN, CHECK, ENV, GITHUB, SITE, TELEGRAM, at, day, memorySql, memoryStorage, newDevice, pageData, world } from "./standins.js";

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

/** Cloudflare's side: one object, made the first time it is asked for, with its own storage. */
function cloudflare(env = ENV) {
  const storage = memoryStorage();
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
      SUBSCRIBERS: {
        idFromName: (name) => ({ name }),
        get(id, options) {
          it.asked.push({ id, options });
          return {
            async fetch(address, init) {
              if (!it.object) it.object = new Subscribers(state, env);
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
  assert.deepEqual(Object.keys(everything).sort(), ["Chats", "Stats", "Subscribers", "default"]);
  assert.equal(typeof everything.Chats, "function");
  assert.equal(typeof everything.Subscribers, "function");
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
    assert.deepEqual(await answer.json(), { ok: true, devices: 0, sending: false, last: null, timer: null, unknownServices: {}, refusals: {}, starter: OFF, telegram: { on: false } });
  }
  // One book for everyone, kept near the people it serves.
  assert.deepEqual(cf.asked[0], { id: { name: "all" }, options: { locationHint: "oc" } });
});

test("only the page itself may read the answers from inside a browser", async () => {
  const cf = cloudflare();
  const mine = await ask(cf, "GET", "/key", { origin: PAGE });
  assert.equal(mine.headers.get("Access-Control-Allow-Origin"), PAGE);
  assert.equal(mine.headers.get("Vary"), "Origin");
  const body = await mine.json();
  assert.equal(body.ok, true);
  assert.equal(Buffer.from(body.key, "base64url").length, 65);

  for (const origin of [null, "https://example.org", "http://citizensbark.example", "null"]) {
    const other = await ask(cf, "GET", "/key", { origin });
    assert.equal(other.status, 200);
    assert.equal(other.headers.get("Access-Control-Allow-Origin"), null, String(origin));
    assert.equal(other.headers.get("Vary"), "Origin");
  }
});

test("a browser's question beforehand is answered without waking the book", async () => {
  const cf = cloudflare();
  const answer = await ask(cf, "OPTIONS", "/subscribe", { headers: { "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" } });
  assert.equal(answer.status, 204);
  assert.equal(answer.headers.get("Access-Control-Allow-Origin"), PAGE);
  assert.equal(answer.headers.get("Access-Control-Allow-Methods"), "GET, POST, OPTIONS");
  assert.equal(answer.headers.get("Access-Control-Allow-Headers"), "Content-Type");
  assert.equal(await answer.text(), "");

  const other = await ask(cf, "OPTIONS", "/subscribe", { origin: "https://example.org" });
  assert.equal(other.status, 204);
  assert.equal(other.headers.get("Access-Control-Allow-Origin"), null);
  assert.equal(cf.asked.length, 0);
});

test("a device turns alerts on and off through the page", async () => {
  const cf = cloudflare();
  const phone = newDevice();
  const on = await ask(cf, "POST", "/subscribe", { body: { subscription: phone.subscription } });
  assert.equal(on.status, 201);
  assert.equal(on.headers.get("Access-Control-Allow-Origin"), PAGE);
  assert.deepEqual(await on.json(), { ok: true, new: true });
  assert.equal(net.pushesTo(phone).length, 1);
  assert.equal(phone.words(net.pushesTo(phone)[0].body).notification.title, "Alerts are on");
  assert.equal((await (await ask(cf, "GET", "/status")).json()).devices, 1);

  const again = await ask(cf, "POST", "/subscribe", { body: { subscription: phone.subscription } });
  assert.equal(again.status, 200);
  assert.deepEqual(await again.json(), { ok: true, new: false });

  const off = await ask(cf, "POST", "/unsubscribe", { body: { endpoint: phone.endpoint } });
  assert.equal(off.status, 200);
  assert.deepEqual(await off.json(), { ok: true });
  assert.equal((await (await ask(cf, "GET", "/status")).json()).devices, 0);
});

test("a request to add or remove a device from anywhere but the page is turned away", async () => {
  const cf = cloudflare();
  const phone = newDevice();
  for (const origin of [null, "https://example.org", "http://citizensbark.example", "https://citizensbark.example.evil.example", "null"]) {
    for (const [path, body] of [
      ["/subscribe", { subscription: phone.subscription }],
      ["/unsubscribe", { endpoint: phone.endpoint }],
    ]) {
      const answer = await ask(cf, "POST", path, { origin, body });
      assert.equal(answer.status, 403, `${origin} ${path}`);
      assert.deepEqual(await answer.json(), { ok: false, reason: "origin" });
      assert.equal(answer.headers.get("Access-Control-Allow-Origin"), null);
    }
  }
  assert.equal(cf.asked.length, 0);
  assert.equal(net.calls.length, 0);
});

test("a request that is too long is not read to its end", async () => {
  const cf = cloudflare();
  const long = JSON.stringify({ subscription: { endpoint: "https://fcm.googleapis.com/send/abc", padding: "x".repeat(MOST_BYTES) } });

  // One that says how long it is.
  const declared = await ask(cf, "POST", "/subscribe", { body: long, headers: { "Content-Length": String(long.length) } });
  assert.equal(declared.status, 413);
  assert.deepEqual(await declared.json(), { ok: false, reason: "bad" });
  assert.equal(declared.headers.get("Access-Control-Allow-Origin"), PAGE);

  // One that does not say, and arrives in pieces.
  let pieces = 0;
  const stream = new ReadableStream({
    pull(controller) {
      pieces += 1;
      controller.enqueue(new Uint8Array(1024).fill(120));
    },
  });
  const request = new Request(`${BACKEND}/subscribe`, { method: "POST", headers: { Origin: PAGE }, body: stream, duplex: "half" });
  const endless = await worker.fetch(request, cf.env);
  assert.equal(endless.status, 413);
  assert.ok(pieces < 10, `${pieces} pieces were read`);

  assert.equal(cf.asked.length, 0);
  assert.equal(MOST_BYTES, 4096);
});

test("a request of exactly the largest size is still read", async () => {
  const cf = cloudflare();
  const start = '{"subscription":{"endpoint":"https://fcm.googleapis.com/send/abc","padding":"';
  const body = `${start}${"x".repeat(MOST_BYTES - start.length - 3)}"}}`;
  assert.equal(body.length, MOST_BYTES);
  const answer = await ask(cf, "POST", "/subscribe", { body });
  assert.equal(answer.status, 400);
  assert.deepEqual(await answer.json(), { ok: false, reason: "bad" });
  assert.equal(cf.asked.length, 1);
});

test("what is not JSON is turned down", async () => {
  const cf = cloudflare();
  for (const body of ["", "not json", "{", "<xml/>"]) {
    const answer = await ask(cf, "POST", "/subscribe", { body });
    assert.equal(answer.status, 400, body);
    assert.deepEqual(await answer.json(), { ok: false, reason: "bad" });
  }
  for (const body of ["null", "5", '"text"', "[]", "{}"]) {
    const answer = await ask(cf, "POST", "/unsubscribe", { body });
    assert.equal(answer.status, 400, body);
  }
  assert.equal(net.calls.length, 0);
});

test("nothing else is answered, and nobody outside can start a send", async () => {
  const cf = cloudflare();
  const unknown = [
    ["POST", "/tick"],
    ["GET", "/tick"],
    ["GET", "/subscribe"],
    ["GET", "/unsubscribe"],
    ["POST", "/status"],
    ["POST", "/key"],
    ["POST", "/"],
    ["PUT", "/subscribe"],
    ["DELETE", "/subscribe"],
    ["GET", "/favicon.ico"],
    ["GET", "/status/"],
    ["GET", "//status"],
    ["GET", "/alarm"],
  ];
  for (const [method, path] of unknown) {
    const answer = await ask(cf, method, path, method === "GET" ? {} : { body: {} });
    assert.equal(answer.status, 404, `${method} ${path}`);
    assert.deepEqual(await answer.json(), { ok: false, reason: "unknown" });
  }
  assert.equal(cf.asked.length, 0);
});

test("settings that make no sense are reported plainly", async () => {
  const cf = cloudflare({ ...ENV, TIMEZONE: "Australia/Richmond" });
  const answer = await ask(cf, "GET", "/status");
  assert.equal(answer.status, 500);
  assert.deepEqual(await answer.json(), { ok: false, reason: "settings", detail: "TIMEZONE Australia/Richmond is not a known time zone" });
  assert.equal(cf.asked.length, 0);
});

test("if the book stumbles, the page is asked to try again later", async () => {
  const cf = cloudflare();
  cf.env.SUBSCRIBERS.get = () => ({
    fetch: async () => {
      throw new Error("the object was reset");
    },
  });
  const answer = await ask(cf, "GET", "/key");
  assert.equal(answer.status, 503);
  assert.deepEqual(await answer.json(), { ok: false, reason: "later" });
  assert.equal(answer.headers.get("Access-Control-Allow-Origin"), PAGE);

  cf.env.SUBSCRIBERS.get = () => ({ fetch: async () => new Response("<html>an error page</html>", { status: 500 }) });
  const second = await ask(cf, "POST", "/subscribe", { body: { subscription: newDevice().subscription } });
  assert.equal(second.status, 503);
  assert.deepEqual(await second.json(), { ok: false, reason: "later" });
});

test("the timer's look is passed on to the book, and a failure of it is only noted", async () => {
  const cf = cloudflare();
  now = at(TODAY, "14:00");
  await tick(cf);
  assert.deepEqual((await (await ask(cf, "GET", "/status")).json()).timer, { at: now, did: "nothing", why: "too early" });

  const broken = cloudflare();
  broken.env.SUBSCRIBERS.get = () => ({
    fetch: async () => {
      throw new Error("the object was reset");
    },
  });
  await tick(broken); // does not throw
});

test("without a token the second timer stays off, and the timer's look asks nothing of GitHub", async () => {
  // The four settings are there, as in wrangler.jsonc, but no token has been handed over.
  const cf = cloudflare({ ...ENV, ...CHECK });
  net.page = pageData({ generated: `${TODAY}T13:50:00+11:00`, days: [day(TODAY)] });
  now = at(TODAY, "14:55");
  await tick(cf);
  assert.equal(net.asks.length, 0);
  const said = await status(cf);
  assert.deepEqual(said.starter, OFF);
  assert.deepEqual(said.timer, { at: now, did: "nothing", why: "no device to tell" });
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

  const answer = await ask(cf, "GET", "/status", { origin: null });
  const text = await answer.text();
  // Anyone may read the status, so the token must not be in it.
  assert.equal(text.includes(TOKEN), false);
  assert.equal(text.includes("github_pat"), false);
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

test("the timer's look has two jobs, and trouble with one does not stop the other", async () => {
  const cf = cloudflare({ ...ENV, ...CHECK, DAILY_CHECK_TOKEN: TOKEN });
  net.page = pageData({ generated: `${TODAY}T13:50:00+11:00`, days: [day(TODAY)] });
  now = at(TODAY, "14:55");
  await status(cf); // wakes the object, so that its parts can be reached

  // The alert's look stumbles: the second timer still starts the check.
  const alertsLook = cf.object.book.tick;
  cf.object.book.tick = async () => {
    throw new Error("the alert's look broke");
  };
  await tick(cf);
  assert.equal(net.starts.length, 1);
  assert.equal((await status(cf)).timer, null);

  // The second timer stumbles: the alert's look still happens.
  cf.object.book.tick = alertsLook;
  cf.object.starter.look = async () => {
    throw new Error("the second timer broke");
  };
  now = at(TODAY, "15:00");
  await tick(cf);
  assert.deepEqual((await status(cf)).timer, { at: now, did: "nothing", why: "no device to tell" });
});

test("from the tap on the page to the afternoon's notification", async () => {
  const cf = cloudflare();
  const phones = [newDevice(), newDevice("web.push.apple.com"), newDevice("updates.push.services.mozilla.com")];
  for (const phone of phones) {
    assert.equal((await ask(cf, "POST", "/subscribe", { body: { subscription: phone.subscription } })).status, 201);
  }

  // The afternoon's check has not run yet: the timer waits.
  net.page = pageData({ generated: `${TODAY}T11:47:00+11:00`, days: [day(TODAY)] });
  now = at(TODAY, "14:35");
  await tick(cf);
  assert.equal((await (await ask(cf, "GET", "/status")).json()).timer.why, "waiting for the check before the alert");

  // It has run: the alert starts, and Cloudflare's wake-up call sends it.
  net.page = pageData({ generated: `${TODAY}T14:42:00+11:00`, days: [day(TODAY, "Booked 5 PM to 7:30 PM", "Cricket training.")] });
  now = at(TODAY, "14:45");
  await tick(cf);
  assert.equal(cf.storage.alarm, now);
  cf.storage.alarm = null;
  await cf.object.alarm();

  for (const phone of phones) {
    const pushes = net.pushesTo(phone);
    assert.equal(pushes.length, 2);
    assert.deepEqual(phone.words(pushes[1].body).notification, {
      title: "Booked 5 PM to 7:30 PM",
      body: "Cricket training.",
      navigate: SITE,
      tag: "daily",
      renotify: true,
      lang: "en-AU",
      icon: `${SITE}icon-192.png`,
      badge: `${SITE}badge.png`,
    });
  }
  const status = await (await ask(cf, "GET", "/status")).json();
  assert.equal(status.sending, false);
  assert.equal(status.last.sent, 3);
  assert.equal(status.devices, 3);

  // Five minutes later the timer looks again, and nothing more goes out.
  now = at(TODAY, "14:50");
  await tick(cf);
  assert.equal(net.pushes.length, 6);
});

test("the page counts a visit and a press, the way a browser sends them as it leaves", async () => {
  const cf = cloudflare();
  // A beacon is sent as plain text, so the browser asks nothing beforehand.
  const headers = { "Content-Type": "text/plain;charset=UTF-8" };
  const visit = await ask(cf, "POST", "/hit", { headers, body: JSON.stringify({ kind: "visit", newToday: true, newThisMonth: true, firstEver: true }) });
  assert.equal(visit.status, 204);
  assert.equal(await visit.text(), "");
  assert.equal(visit.headers.get("Access-Control-Allow-Origin"), PAGE);
  const press = await ask(cf, "POST", "/hit", { headers, body: JSON.stringify({ kind: "press", name: "buttons:t.me" }) });
  assert.equal(press.status, 204);
  assert.deepEqual(cf.statsStorage.kept.get(`day:${TODAY}`), { visits: 1, devices: 1, monthly: 1, fresh: 1, presses: { "buttons:t.me": 1 }, counted: 2 });
  // One counter for everyone, near the people it serves, and the book of devices is not woken for it.
  assert.deepEqual(cf.statsAsked[0], { id: { name: "all" }, options: { locationHint: "oc" } });
  assert.equal(cf.asked.length, 0);
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

test("anyone may open the stats page, which runs no script and shows counts only", async () => {
  const cf = cloudflare();
  await ask(cf, "POST", "/hit", { body: { kind: "visit", newToday: true, newThisMonth: true, firstEver: true } });
  const page = await ask(cf, "GET", "/stats", { origin: null });
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("Content-Type"), "text/html; charset=utf-8");
  assert.equal(page.headers.get("Cache-Control"), "no-store");
  assert.match(page.headers.get("Content-Security-Policy"), /^default-src 'none';.*frame-ancestors 'none'/);
  const html = await page.text();
  assert.match(html, /<strong>November 2026<\/strong>/);
  assert.match(html, /Fri 20 <span class="muted">today<\/span><\/td><td>1</);

  const october = await (await ask(cf, "GET", "/stats?month=2026-10", { origin: null })).text();
  assert.match(october, /<strong>October 2026<\/strong>/);
  const odd = await (await ask(cf, "GET", "/stats?month=%3Cb%3E", { origin: null })).text();
  assert.match(odd, /<strong>November 2026<\/strong>/);
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
  // The bot's chats are kept apart from the book, near the people they serve.
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

test("the timer's look also reaches the bot, and the bot's trouble does not stop the book", async () => {
  const cf = cloudflare(WITH_BOT);
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
  assert.equal((await status(cf)).timer.at, now);
});
