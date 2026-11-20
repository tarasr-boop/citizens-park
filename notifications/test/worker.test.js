// The part that connects the book to Cloudflare: which requests are let in,
// from where, and what the timer does. Cloudflare itself is stood in for here.
// The file runtime.js tries the same things in Cloudflare's own runtime.

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { MOST_BYTES } from "../src/rules.js";
import * as everything from "../src/worker.js";
import worker, { Subscribers } from "../src/worker.js";
import { ENV, SITE, at, day, memoryStorage, newDevice, pageData, world } from "./standins.js";

const PAGE = "https://citizensbark.example";
const BACKEND = "https://alerts.example";
const TODAY = "2026-11-20";

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
    },
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
  await worker.scheduled({ cron: "*/5 3-8 * * *", scheduledTime: now }, cf.env, cf.ctx);
  await Promise.all(cf.waits);
}

test("the worker's file exports only what Cloudflare can call", () => {
  // Cloudflare refuses a worker whose main file exports anything else, a plain number for example.
  assert.deepEqual(Object.keys(everything).sort(), ["Subscribers", "default"]);
  assert.equal(typeof everything.Subscribers, "function");
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
    assert.deepEqual(await answer.json(), { ok: true, devices: 0, sending: false, last: null, timer: null, unknownServices: {} });
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
  assert.equal((await (await ask(cf, "GET", "/status")).json()).timer.why, "waiting for the afternoon's check");

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
