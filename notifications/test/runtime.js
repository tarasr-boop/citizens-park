// Tries the backend in Cloudflare's own runtime ("workerd"), on this machine.
//
// The other tests stand in for Cloudflare with a few lines of JavaScript. This
// one runs the real thing: the same program that runs Workers on Cloudflare's
// servers, with a real Durable Object, its real storage and its real wake-up
// calls. Only the outside world is stood in for: the page's data, GitHub, and
// the notification services, where a stand-in phone reads what arrives.
//
// Usage: node test/runtime.js [path to the worker, default src/worker.js]
//
// "npm run runtime" first lets wrangler bundle the code the way a deploy does,
// and runs this against that bundle.

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Miniflare, Response } from "miniflare";

import { localTime } from "../src/rules.js";
import { day, newDevice, pageData, readProof } from "./standins.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.resolve(process.argv[2] || path.join(here, "../src/worker.js"));
const settingsText = await readFile(path.join(here, "../wrangler.jsonc"), "utf8");
const compatibilityDate = /"compatibility_date":\s*"([\d-]+)"/.exec(settingsText)[1];
// The first of the timer's lines, which looks every five minutes through the day.
const cron = /"crons":\s*\["([^"]+)"/.exec(settingsText)[1];

const SITE = "https://citizensbark.example/";
const PAGE = new URL(SITE).origin;
const BACKEND = "https://alerts.example";
const GITHUB = "https://api.github.com/";
// Made up for this test. On Cloudflare the real ones are secrets, handed over at deploy time.
const TOKEN = "github_pat_11STANDIN0aBcDeFgHiJkLmNoPqRsTuVwXyZ";
const BOT_TOKEN = "123456789:STANDIN-aBcDeFgHiJkLmNoPqRsTuVwXyZ01234";
const TELEGRAM = `https://api.telegram.org/bot${BOT_TOKEN}/`;

// The alert only goes out around its time of day at the park, and this test
// has to pass at any hour of any day. So the park is moved, for the test, to
// wherever it is midday right now, and the alert is set for half past eleven
// on weekdays and weekends alike. In these names the sign is the other way
// round: "Etc/GMT-5" is five hours ahead of UTC.
const started = Date.now();
const ahead = 12 - new Date(started).getUTCHours();
const zone = ahead === 0 ? "Etc/GMT" : `Etc/GMT${ahead > 0 ? "-" : "+"}${Math.abs(ahead)}`;
const today = localTime(started, zone).date;
// The second timer looks after a check a quarter of an hour after its set
// time, for an hour. So for this test the check's one set time is twenty
// minutes ago.
const setMinute = localTime(started, zone).minute - 20;
const setTime = `${String(Math.floor(setMinute / 60)).padStart(2, "0")}:${String(setMinute % 60).padStart(2, "0")}`;

const DAYS = [day(today, "Booked 5 PM to 7:30 PM", "Cricket training.")];
/** The page's data, made `ago` milliseconds before this test began. */
const pageMade = (ago) => pageData({ generated: new Date(started - ago).toISOString(), days: DAYS });

const outside = {
  page: pageMade(60000),
  reads: [],
  // The words of the bot's alerts, in telegram.json next to the page, and what was asked of Telegram.
  words: null,
  wordReads: [],
  telegram: [],
  pushes: [],
  answer: () => 201,
  // What was asked of GitHub. It takes every request.
  asks: [],
};

async function outbound(request) {
  if (request.url.startsWith(`${SITE}telegram.json`)) {
    outside.wordReads.push(request.url);
    return new Response(JSON.stringify(outside.words), { headers: { "Content-Type": "application/json" } });
  }
  if (request.url.startsWith("https://api.telegram.org/")) {
    const call = { url: request.url, method: request.url.split("/").pop(), body: JSON.parse((await request.text()) || "{}") };
    outside.telegram.push(call);
    const results = { getMe: { id: 123456789, is_bot: true, username: "standin_park_bot" }, getWebhookInfo: { pending_update_count: 0 }, getMyDescription: { description: "" }, getMyShortDescription: { short_description: "" }, getMyName: { name: "Citizens Park Dogs" } };
    if (call.method === "sendMessage") results.sendMessage = { message_id: 1000 + outside.telegram.filter((one) => one.method === "sendMessage").length };
    return new Response(JSON.stringify({ ok: true, result: results[call.method] ?? true }), { headers: { "Content-Type": "application/json" } });
  }
  if (request.url.startsWith(SITE)) {
    outside.reads.push(request.url);
    return new Response(JSON.stringify(outside.page), { headers: { "Content-Type": "application/json" } });
  }
  if (request.url.startsWith(GITHUB)) {
    outside.asks.push({ url: request.url, method: request.method, headers: Object.fromEntries(request.headers), body: await request.text() });
    if (request.method === "POST") return new Response(null, { status: 204 });
    return new Response(JSON.stringify({ state: "active" }), { headers: { "Content-Type": "application/json" } });
  }
  const push = { url: request.url, method: request.method, headers: Object.fromEntries(request.headers), body: new Uint8Array(await request.arrayBuffer()) };
  outside.pushes.push(push);
  // A number, or `{ status, words }` when the service also says why.
  const said = outside.answer(push);
  return typeof said === "object" ? new Response(said.words, { status: said.status }) : new Response(null, { status: said });
}

// The worker's own files, as modules. A bundle made by wrangler is one file.
// The files in src/ are the worker and the eight it imports.
async function modules() {
  const names =
    path.basename(path.dirname(scriptPath)) === "src"
      ? ["worker.js", "book.js", "bot.js", "botwords.js", "rules.js", "starter.js", "stats.js", "statspage.js", "webpush.js"]
      : [path.basename(scriptPath)];
  const found = {};
  for (const name of names) {
    found[name] = { type: "esm", contents: await readFile(path.join(path.dirname(scriptPath), name), "utf8") };
  }
  return { mainModule: path.basename(scriptPath), modules: found };
}

const manifest = await modules();
const text = (value) => ({ type: "text", value });

function start(folder) {
  return new Miniflare({
    // Where the Durable Object keeps its storage, so that a restart can be tried.
    resourcePersistencePath: folder,
    workers: [
      {
        // The same things wrangler.jsonc says, in the words this tool uses.
        config: {
          name: "alerts",
          compatibilityDate,
          manifest,
          env: {
            SITE_URL: text(SITE),
            TIMEZONE: text(zone),
            ALERT_WEEKDAYS: text("11:30"),
            ALERT_WEEKENDS: text("11:30"),
            ALERT_UNTIL: text("13:30"),
            CHECK_REPOSITORY: text("someone/park"),
            CHECK_WORKFLOW: text("daily.yml"),
            CHECK_BRANCH: text("main"),
            CHECK_TIMES: text(setTime),
            DAILY_CHECK_TOKEN: text(TOKEN),
            PARK_NAME: text("Citizens Park oval"),
            BACKEND_URL: text(BACKEND),
            BOT_FIRST: text("04:00"),
            BOT_LAST: text("23:00"),
            BOT_EVENING: text("21:00"),
            BOT_WEEKDAY: text("16:00"),
            BOT_WEEKEND: text("08:00"),
            TELEGRAM_BOT_TOKEN: text(BOT_TOKEN),
            SUBSCRIBERS: { type: "durable-object", worker: "alerts", exportName: "Subscribers" },
            STATS: { type: "durable-object", worker: "alerts", exportName: "Stats" },
            CHATS: { type: "durable-object", worker: "alerts", exportName: "Chats" },
          },
          exports: {
            Subscribers: { type: "durable-object", storage: "sqlite" },
            Stats: { type: "durable-object", storage: "sqlite" },
            Chats: { type: "durable-object", storage: "sqlite" },
          },
          triggers: [{ type: "scheduled", schedule: cron }],
        },
        // Everything the worker asks of the outside world comes here instead.
        dev: { outboundService: { type: "fetcher", handler: outbound } },
      },
    ],
  });
}

async function ask(mf, method, route, { origin = PAGE, body } = {}) {
  const headers = {};
  if (origin) headers.Origin = origin;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const answer = await mf.dispatchFetch(BACKEND + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await answer.text();
  return { status: answer.status, headers: answer.headers, body: text ? JSON.parse(text) : null };
}

async function until(what, isTrue, patience = 15000) {
  const deadline = Date.now() + patience;
  while (!(await isTrue())) {
    if (Date.now() > deadline) throw new Error(`waited ${patience / 1000} seconds for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

let passed = 0;
async function check(what, work) {
  await work();
  passed += 1;
  console.log(`ok  ${what}`);
}

const folder = await mkdtemp(path.join(os.tmpdir(), "alerts-runtime-"));
let mf = start(folder);
try {
  console.log(`Trying ${path.relative(process.cwd(), scriptPath)} in workerd, with the park's clock set to ${zone} (${today}).`);

  let key;
  await check("the backend starts, makes its signing keys and says how things are", async () => {
    const status = await ask(mf, "GET", "/status", { origin: null });
    assert.equal(status.status, 200);
    const { telegram, ...rest } = status.body;
    // Asked how things are, the bot sets itself up with Telegram first.
    assert.equal(telegram.on, true);
    assert.equal(telegram.name, "standin_park_bot");
    assert.equal(telegram.hook.ok, true);
    assert.equal(telegram.chats, 0);
    assert.deepEqual(rest, {
      ok: true,
      devices: 0,
      sending: false,
      last: null,
      timer: null,
      unknownServices: {},
      refusals: {},
      starter: { on: true, look: null, check: null, token: null },
    });
    assert.equal(status.headers.get("Access-Control-Allow-Origin"), null);
    const answer = await ask(mf, "GET", "/key");
    assert.equal(answer.status, 200);
    assert.equal(answer.headers.get("Access-Control-Allow-Origin"), PAGE);
    key = answer.body.key;
    assert.equal(Buffer.from(key, "base64url").length, 65);
  });

  const hourNow = Math.floor(localTime(started, zone).minute / 60);
  const weekend = [0, 6].includes(new Date(`${today}T12:00:00Z`).getUTCDay());
  await check("the bot listens to Telegram only with the password it gave it, and keeps a chat in its own database", async () => {
    const hook = outside.telegram.find((one) => one.method === "setWebhook");
    assert.equal(hook.body.url, `${BACKEND}/telegram`);
    assert.ok(outside.telegram.every((one) => one.url.startsWith(TELEGRAM)));
    const send = (body, secret = hook.body.secret_token) =>
      mf.dispatchFetch(`${BACKEND}/telegram`, { method: "POST", headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": secret }, body: JSON.stringify(body) });
    const start = { update_id: 1, message: { message_id: 1, from: { id: 5, is_bot: false }, chat: { id: 5, type: "private" }, text: "/start" } };
    const refused = await send(start, "wrong");
    assert.equal(refused.status, 403);
    await refused.arrayBuffer();
    const taken = await send(start);
    assert.equal(taken.status, 200);
    assert.deepEqual(await taken.json(), { ok: true });
    const said = outside.telegram.filter((one) => one.method === "sendMessage");
    assert.equal(said.length, 1);
    assert.match(said[0].body.text, /^Your alerts:/);
    // The "/start" is taken away, so the chat keeps only the times.
    assert.ok(outside.telegram.some((one) => one.method === "deleteMessage" && one.body.message_id === 1));
    // The person picks this very hour, for today's kind of day.
    const press = { update_id: 2, callback_query: { id: "q1", from: { id: 5 }, message: { message_id: 9, chat: { id: 5, type: "private" } }, data: `set:${weekend ? "weekend" : "weekday"}:${hourNow}` } };
    const pressed = await send(press);
    assert.equal(pressed.status, 200);
    await pressed.arrayBuffer();
    const times = outside.telegram.filter((one) => one.method === "sendMessage").at(-1);
    assert.match(times.body.text, new RegExp(`${weekend ? "Weekends" : "Weekdays"}: ${hourNow % 12 || 12} ${hourNow < 12 ? "AM" : "PM"}`));
    assert.equal((await ask(mf, "GET", "/status")).body.telegram.chats, 1);
  });

  await check("the second timer asks GitHub to run the check when the page shows none, and is content once the page is new", async () => {
    // The page still shows a check from three hours ago.
    outside.page = pageMade(3 * 3600 * 1000);
    const worker = await mf.getWorker();
    assert.equal((await worker.scheduled({ cron })).outcome, "ok");
    await until("the second timer to look", async () => (await ask(mf, "GET", "/status")).body.starter.look !== null);

    const workflow = `${GITHUB}repos/someone/park/actions/workflows/daily.yml`;
    assert.deepEqual(
      outside.asks.map((one) => `${one.method} ${one.url}`),
      [`GET ${workflow}`, `POST ${workflow}/dispatches`]
    );
    for (const one of outside.asks) {
      assert.equal(one.headers.authorization, `Bearer ${TOKEN}`);
      assert.equal(one.headers.accept, "application/vnd.github+json");
      assert.equal(one.headers["user-agent"], "citizens-bark-alerts");
      assert.equal(one.headers["x-github-api-version"], undefined);
    }
    assert.equal(outside.asks[0].body, "");
    assert.equal(outside.asks[1].headers["content-type"], "application/json");
    assert.deepEqual(JSON.parse(outside.asks[1].body), { ref: "main" });

    const answer = await mf.dispatchFetch(`${BACKEND}/status`);
    const said = await answer.text();
    assert.equal(said.includes("github_pat"), false);
    // The deploy on GitHub looks for exactly these words to know that the second timer is on.
    assert.ok(said.includes('"starter":{"on":true'), said);
    const status = JSON.parse(said);
    assert.equal(status.timer.why, "no device to tell");
    assert.equal(status.starter.on, true);
    assert.equal(status.starter.look.did, "started");
    assert.deepEqual(status.starter.token, { date: today, at: status.starter.token.at, answer: 200, ok: true });
    assert.deepEqual(status.starter.check, { date: today, time: setTime, tries: 1, fails: 0, at: status.starter.check.at, answer: 204, done: false });
    assert.equal(outside.reads.length, 1);

    // The check has run and the page is new: the next look notes that, and asks nothing more of GitHub.
    outside.page = pageMade(60000);
    await worker.scheduled({ cron });
    await until("the second timer to see the new page", async () => (await ask(mf, "GET", "/status")).body.starter.check.done);
    assert.equal(outside.asks.length, 2);
    outside.reads.length = 0;
  });

  await check("at the hour the person picked, the timer's look sends the bot's alert", async () => {
    // The look above was the bot's first in this hour, and telegram.json had no words yet.
    assert.equal((await ask(mf, "GET", "/status")).body.telegram.look.why, `telegram.json could not be read (telegram.json is not what was expected)`);
    outside.words = {
      generated: new Date(started).toISOString(),
      generatedText: "now",
      alerts: [{ date: today, hour: hourNow, about: today, weekend, text: "🐕 <b>Citizens Park oval</b>\n\n🔴 Booked until 8 PM" }],
    };
    const worker = await mf.getWorker();
    await worker.scheduled({ cron });
    await until("the bot's alert to be sent", async () => (await ask(mf, "GET", "/status")).body.telegram.last !== null);
    const last = outside.telegram.at(-1);
    assert.equal(last.method, "sendMessage");
    assert.deepEqual(last.body, { chat_id: 5, text: "🐕 <b>Citizens Park oval</b>\n\n🔴 Booked until 8 PM", parse_mode: "HTML", link_preview_options: { is_disabled: true } });
    const status = (await ask(mf, "GET", "/status")).body.telegram;
    assert.deepEqual([status.last.sent, status.last.gone, status.last.failed, status.last.kind], [1, 0, 0, weekend ? "weekend" : "weekday"]);
    assert.equal(JSON.stringify(status).includes(BOT_TOKEN), false);
    // The next look sends nothing more.
    await worker.scheduled({ cron });
    await until("the bot's next look", async () => (await ask(mf, "GET", "/status")).body.telegram.look.why.includes("have gone out"));
    assert.equal(outside.telegram.filter((one) => one.method === "sendMessage").length, 3);
  });

  await check("a browser's question beforehand is answered", async () => {
    const answer = await mf.dispatchFetch(`${BACKEND}/subscribe`, {
      method: "OPTIONS",
      headers: { Origin: PAGE, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" },
    });
    assert.equal(answer.status, 204);
    assert.equal(answer.headers.get("Access-Control-Allow-Origin"), PAGE);
    assert.equal(answer.headers.get("Access-Control-Allow-Headers"), "Content-Type");
    await answer.arrayBuffer();
  });

  const phones = [newDevice("fcm.googleapis.com"), newDevice("web.push.apple.com"), newDevice("updates.push.services.mozilla.com")];
  await check("three phones turn alerts on, and each can read its first notification", async () => {
    for (const phone of phones) {
      const answer = await ask(mf, "POST", "/subscribe", { body: { subscription: phone.subscription } });
      assert.equal(answer.status, 201);
      assert.deepEqual(answer.body, { ok: true, new: true });
      const [push] = outside.pushes.filter((one) => one.url === phone.endpoint);
      assert.equal(push.method, "POST");
      assert.equal(push.headers["content-encoding"], "aes128gcm");
      assert.equal(push.headers.ttl, "3600");
      assert.equal(push.headers.topic, "welcome");
      assert.equal(push.headers.urgency, "high");
      const proof = readProof(push.headers.authorization);
      assert.equal(proof.valid, true);
      assert.equal(proof.key, key);
      assert.equal(proof.claims.aud, `https://${phone.host}`);
      assert.equal(proof.claims.sub, SITE);
      assert.ok(proof.claims.exp > Date.now() / 1000 && proof.claims.exp < Date.now() / 1000 + 24 * 3600);
      const words = phone.words(push.body);
      assert.equal(words.web_push, 8030);
      assert.equal(words.notification.title, "Alerts are on");
      assert.equal(words.notification.navigate, SITE);
    }
    assert.equal(outside.pushes.length, 3);
    assert.equal((await ask(mf, "GET", "/status")).body.devices, 3);
  });

  await check("the same phone again changes nothing, and other callers are turned away", async () => {
    assert.deepEqual((await ask(mf, "POST", "/subscribe", { body: { subscription: phones[0].subscription } })).body, { ok: true, new: false });
    assert.equal((await ask(mf, "POST", "/subscribe", { origin: "https://example.org", body: { subscription: newDevice().subscription } })).status, 403);
    assert.equal((await ask(mf, "POST", "/subscribe", { origin: null, body: { subscription: newDevice().subscription } })).status, 403);
    assert.deepEqual((await ask(mf, "POST", "/subscribe", { body: { subscription: newDevice("push.example.org").subscription } })).body, { ok: false, reason: "host" });
    assert.equal((await ask(mf, "POST", "/subscribe", { body: { subscription: { endpoint: "x" } } })).status, 400);
    assert.equal((await ask(mf, "POST", "/tick", { body: {} })).status, 404);
    const long = await mf.dispatchFetch(`${BACKEND}/subscribe`, { method: "POST", headers: { Origin: PAGE }, body: "x".repeat(5000) });
    assert.equal(long.status, 413);
    await long.arrayBuffer();
    assert.equal(outside.pushes.length, 3);
    assert.equal((await ask(mf, "GET", "/status")).body.devices, 3);
  });

  await check("at most thirty first notifications go out in a minute", async () => {
    for (let index = 0; index < 27; index += 1) {
      const phone = newDevice();
      assert.equal((await ask(mf, "POST", "/subscribe", { body: { subscription: phone.subscription } })).status, 201);
      phones.push(phone);
    }
    const answer = await ask(mf, "POST", "/subscribe", { body: { subscription: newDevice().subscription } });
    assert.equal(answer.status, 429);
    assert.deepEqual(answer.body, { ok: false, reason: "later" });
    assert.equal(outside.pushes.length, 30);
  });

  await check("the signing keys and the book are still there after a restart", async () => {
    await mf.dispose();
    mf = start(folder);
    assert.equal((await ask(mf, "GET", "/key")).body.key, key);
    assert.equal((await ask(mf, "GET", "/status")).body.devices, 30);
    // The count of first notifications is kept in memory only, so after a
    // restart there is room for more phones: enough for a second round of sending.
    for (let index = 0; index < 15; index += 1) {
      const phone = newDevice(index % 2 ? "web.push.apple.com" : "fcm.googleapis.com");
      assert.equal((await ask(mf, "POST", "/subscribe", { body: { subscription: phone.subscription } })).status, 201);
      phones.push(phone);
    }
    assert.equal((await ask(mf, "GET", "/status")).body.devices, 45);
  });

  await check("a phone whose address is gone is told so, and is not written in", async () => {
    outside.answer = () => 410;
    const answer = await ask(mf, "POST", "/subscribe", { body: { subscription: newDevice().subscription } });
    assert.equal(answer.status, 410);
    assert.deepEqual(answer.body, { ok: false, reason: "gone" });
    outside.answer = () => 201;
    assert.equal((await ask(mf, "GET", "/status")).body.devices, 45);
    outside.pushes.length = 0;
  });

  await check("a refusal is noted on the status page with the service's answer, and nothing of the phone", async () => {
    outside.answer = () => ({ status: 403, words: '{"reason":"BadJwtToken"}' });
    const phone = newDevice("web.push.apple.com");
    const answer = await ask(mf, "POST", "/subscribe", { body: { subscription: phone.subscription } });
    assert.equal(answer.status, 410);
    assert.deepEqual(answer.body, { ok: false, reason: "gone" });
    outside.answer = () => 201;
    const status = (await ask(mf, "GET", "/status")).body;
    // This address was never in the book, so the answer's number is kept and its words are not.
    assert.deepEqual(Object.keys(status.refusals), ["web.push.apple.com 403"]);
    assert.equal(status.refusals["web.push.apple.com 403"].times, 1);
    assert.equal(status.refusals["web.push.apple.com 403"].said, "");
    assert.match(status.refusals["web.push.apple.com 403"].on, /^\d{4}-\d\d-\d\d$/);
    assert.equal(JSON.stringify(status).includes(phone.endpoint.split("/").pop()), false);
    assert.equal(status.devices, 45);
    outside.pushes.length = 0;
  });

  await check("the timer starts today's alert, and Cloudflare's wake-up calls send it to every phone in two rounds", async () => {
    const worker = await mf.getWorker();
    const result = await worker.scheduled({ cron });
    assert.equal(result.outcome, "ok");
    await until("the alert to be sent", async () => (await ask(mf, "GET", "/status")).body.last !== null);
    const status = (await ask(mf, "GET", "/status")).body;
    assert.equal(status.sending, false);
    assert.equal(status.timer.did, "started");
    assert.equal(status.last.date, today);
    assert.equal(status.last.how, "finished");
    assert.equal(status.last.fresh, true);
    assert.equal(status.last.sent, 45);
    assert.equal(status.last.failed + status.last.refused + status.last.gone, 0);
    assert.equal(status.last.devices, 45);
    // Forty in the first round, and the rest a second later, after a wake-up call set by the first.
    assert.ok(status.last.finishedAt - status.last.startedAt >= 900, `finished after ${status.last.finishedAt - status.last.startedAt} ms`);
    assert.equal(outside.pushes.length, 45);
    assert.equal(outside.reads.length, 1);
    assert.match(outside.reads[0], /^https:\/\/citizensbark\.example\/data\.json\?t=\d+$/);
    for (const phone of phones) {
      const pushes = outside.pushes.filter((one) => one.url === phone.endpoint);
      assert.equal(pushes.length, 1);
      assert.equal(pushes[0].headers.ttl, "14400");
      assert.equal(pushes[0].headers.topic, "daily");
      assert.equal(readProof(pushes[0].headers.authorization).valid, true);
      assert.deepEqual(phone.words(pushes[0].body).notification, {
        title: "Booked 5 PM to 7:30 PM",
        body: "Cricket training.",
        navigate: SITE,
        tag: "daily",
        renotify: true,
        lang: "en-AU",
        badge: `${SITE}badge.png`,
      });
    }
  });

  await check("the timer's next look sends nothing more", async () => {
    const worker = await mf.getWorker();
    await worker.scheduled({ cron });
    const status = (await ask(mf, "GET", "/status")).body;
    assert.equal(status.timer.did, "nothing");
    assert.equal(status.timer.why, "today's alert has gone out");
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(outside.pushes.length, 45);
  });

  await check("a phone turns alerts off and is taken out of the book", async () => {
    const answer = await ask(mf, "POST", "/unsubscribe", { body: { endpoint: phones[1].endpoint } });
    assert.deepEqual(answer.body, { ok: true });
    assert.equal((await ask(mf, "GET", "/status")).body.devices, 44);
  });

  await check("the page's visits and presses are counted, kept through a restart and shown on the stats page", async () => {
    const send = (body) =>
      mf.dispatchFetch(`${BACKEND}/hit`, { method: "POST", headers: { Origin: PAGE, "Content-Type": "text/plain;charset=UTF-8" }, body: JSON.stringify(body) });
    assert.equal((await send({ kind: "visit", newToday: true, newThisMonth: true, firstEver: true })).status, 204);
    assert.equal((await send({ kind: "visit", newToday: false, newThisMonth: false, firstEver: false })).status, 204);
    assert.equal((await send({ kind: "press", name: "buttons:t.me" })).status, 204);
    assert.equal((await mf.dispatchFetch(`${BACKEND}/hit`, { method: "POST", headers: { Origin: "https://example.org" }, body: "{}" })).status, 403);
    await mf.dispose();
    mf = start(folder);
    const page = await mf.dispatchFetch(`${BACKEND}/stats`);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("content-type"), "text/html; charset=utf-8");
    const html = await page.text();
    assert.match(html, /today<\/span><\/td><td>2<\/td><td>1<\/td><td>1</);
    assert.match(html, /Telegram button<\/td><td>1</);
  });

  await check("the bot's chats are still there after a restart", async () => {
    const status = (await ask(mf, "GET", "/status")).body.telegram;
    assert.equal(status.chats, 1);
    assert.equal(status.last.sent, 1);
  });

  await check("through all of that, GitHub was asked nothing more", async () => {
    assert.equal(outside.asks.length, 2);
    assert.equal((await ask(mf, "GET", "/status")).body.starter.check.tries, 1);
  });

  console.log(`All ${passed} checks passed in Cloudflare's runtime.`);
} catch (error) {
  console.error(`FAILED after ${passed} checks:`);
  console.error(error);
  process.exitCode = 1;
} finally {
  await mf.dispose().catch(() => {});
  await rm(folder, { recursive: true, force: true }).catch(() => {});
}
