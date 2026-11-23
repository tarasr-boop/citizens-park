// Tries the backend in Cloudflare's own runtime ("workerd"), on this machine.
//
// The other tests stand in for Cloudflare with a few lines of JavaScript. This
// one runs the real thing: the same program that runs Workers on Cloudflare's
// servers, with real Durable Objects, their real storage and their real
// wake-up calls. Only the outside world is stood in for: the page's data,
// GitHub and Telegram.
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
import { day, pageData } from "./standins.js";

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

// The bot sends only at the hours people can pick, and this test has to pass
// at any hour of any day. So the park is moved, for the test, to wherever it
// is midday right now. In these names the sign is the other way round:
// "Etc/GMT-5" is five hours ahead of UTC.
const started = Date.now();
const ahead = 12 - new Date(started).getUTCHours();
const zone = ahead === 0 ? "Etc/GMT" : `Etc/GMT${ahead > 0 ? "-" : "+"}${Math.abs(ahead)}`;
const today = localTime(started, zone).date;
// The second timer looks after a check a quarter of an hour after its set
// time, for an hour. So for this test the check's one set time is twenty
// minutes ago.
const setMinute = localTime(started, zone).minute - 20;
const setTime = `${String(Math.floor(setMinute / 60)).padStart(2, "0")}:${String(setMinute % 60).padStart(2, "0")}`;

const DAYS = [day(today)];
/** The page's data, made `ago` milliseconds before this test began. */
const pageMade = (ago) => pageData({ generated: new Date(started - ago).toISOString(), days: DAYS });

const outside = {
  page: pageMade(60000),
  reads: [],
  // The words of the bot's alerts, in telegram.json next to the page, and what was asked of Telegram.
  words: null,
  wordReads: [],
  telegram: [],
  // What was asked of GitHub. It takes every request.
  asks: [],
  // Anything asked of any other address, which should be nothing.
  elsewhere: [],
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
  outside.elsewhere.push(request.url);
  return new Response(null, { status: 502 });
}

// The worker's own files, as modules. A bundle made by wrangler is one file.
// The files in src/ are the worker and the eight it imports.
async function modules() {
  const names =
    path.basename(path.dirname(scriptPath)) === "src"
      ? ["worker.js", "bot.js", "botwords.js", "rules.js", "starter.js", "stats.js", "statsexport.js", "statspage.js", "xlsx.js"]
      : [path.basename(scriptPath)];
  const found = {};
  for (const name of names) {
    found[name] = { type: "esm", contents: await readFile(path.join(path.dirname(scriptPath), name), "utf8") };
  }
  return { mainModule: path.basename(scriptPath), modules: found };
}

const manifest = await modules();
const STATS_PASSWORD = "a stand-in stats password";
const text = (value) => ({ type: "text", value });

function start(folder) {
  return new Miniflare({
    // Where the Durable Object keeps its storage, so that a restart can be tried.
    resourcePersistencePath: folder,
    // What Cloudflare would say about where a request came from: a phone in
    // Richmond. Without this, Miniflare asks Cloudflare about the machine the
    // test runs on, which on GitHub is a data centre, so every visit would
    // look automated.
    cf: { city: "Richmond", region: "Victoria", regionCode: "VIC", country: "AU", asOrganization: "Telstra Limited", asn: 1221, colo: "MEL" },
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
            STATS_PASSWORD: text(STATS_PASSWORD),
            TIMER: { type: "durable-object", worker: "alerts", exportName: "Timer" },
            STATS: { type: "durable-object", worker: "alerts", exportName: "Stats" },
            CHATS: { type: "durable-object", worker: "alerts", exportName: "Chats" },
          },
          exports: {
            Timer: { type: "durable-object", storage: "sqlite" },
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

  await check("the backend starts and says how things are", async () => {
    const status = await ask(mf, "GET", "/status", { origin: null });
    assert.equal(status.status, 200);
    const { telegram, ...rest } = status.body;
    // Asked how things are, the bot sets itself up with Telegram first.
    assert.equal(telegram.on, true);
    assert.equal(telegram.name, "standin_park_bot");
    assert.equal(telegram.hook.ok, true);
    assert.equal(telegram.chats, 0);
    assert.deepEqual(rest, { ok: true, starter: { on: true, look: null, check: null, token: null } });
    assert.equal(status.headers.get("Access-Control-Allow-Origin"), null);
    assert.equal((await ask(mf, "GET", "/status")).headers.get("Access-Control-Allow-Origin"), PAGE);
    // What the browser notifications used is gone, and nobody outside can start a look.
    for (const [method, route] of [["GET", "/key"], ["POST", "/subscribe"], ["POST", "/unsubscribe"], ["POST", "/tick"]]) {
      assert.equal((await ask(mf, method, route, method === "POST" ? { body: {} } : {})).status, 404, `${method} ${route}`);
    }
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
    const answer = await mf.dispatchFetch(`${BACKEND}/hit`, {
      method: "OPTIONS",
      headers: { Origin: PAGE, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" },
    });
    assert.equal(answer.status, 204);
    assert.equal(answer.headers.get("Access-Control-Allow-Origin"), PAGE);
    assert.equal(answer.headers.get("Access-Control-Allow-Headers"), "Content-Type");
    await answer.arrayBuffer();
  });

  await check("the second timer's notes are still there after a restart", async () => {
    await mf.dispose();
    mf = start(folder);
    const status = (await ask(mf, "GET", "/status")).body;
    assert.equal(status.starter.check.done, true);
    assert.equal(status.starter.token.ok, true);
  });

  await check("the page's visits, presses and stays are counted, kept through a restart and shown on the stats page", async () => {
    const phone = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1";
    const send = (body, agent = phone) =>
      mf.dispatchFetch(`${BACKEND}/hit`, { method: "POST", headers: { Origin: PAGE, "Content-Type": "text/plain;charset=UTF-8", "User-Agent": agent }, body: JSON.stringify(body) });
    assert.equal((await send({ kind: "visit", newToday: true, newThisMonth: true, firstEver: true, nth: 1, source: "qr", id: "a1b2c3d4e5f60718" })).status, 204);
    assert.equal((await send({ kind: "visit", newToday: false, newThisMonth: false, firstEver: false, since: 0, nth: 2, id: "a1b2c3d4e5f60718" })).status, 204);
    assert.equal((await send({ kind: "press", name: "buttons:t.me", id: "a1b2c3d4e5f60718" })).status, 204);
    assert.equal((await send({ kind: "stay", seconds: 45, id: "a1b2c3d4e5f60718" })).status, 204);
    // A program that says so is counted apart.
    assert.equal((await send({ kind: "visit", newToday: true, newThisMonth: true, firstEver: true }, "Mozilla/5.0 HeadlessChrome/142.0")).status, 204);
    assert.equal((await mf.dispatchFetch(`${BACKEND}/hit`, { method: "POST", headers: { Origin: "https://example.org" }, body: "{}" })).status, 403);
    await mf.dispose();
    mf = start(folder);
    // The page asks for its password, and opens with it.
    const refused = await mf.dispatchFetch(`${BACKEND}/stats`);
    assert.equal(refused.status, 401);
    assert.match(refused.headers.get("www-authenticate"), /^Basic realm=/);
    assert.equal((await mf.dispatchFetch(`${BACKEND}/stats`, { headers: { Authorization: `Basic ${btoa("me:wrong")}` } })).status, 401);
    const page = await mf.dispatchFetch(`${BACKEND}/stats`, { headers: { Authorization: `Basic ${btoa(`me:${STATS_PASSWORD}`)}` } });
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("content-type"), "text/html; charset=utf-8");
    const html = await page.text();
    assert.match(html, /·<\/td><td>2<\/td><td>1<\/td><td>1<\/td><td>0<\/td><td>1</);
    assert.match(html, /Telegram button<\/td><td>1</);
    assert.match(html, /QR code<\/td><td>1</);
    assert.match(html, /30 seconds to 2 minutes<\/td><td>1</);
    assert.match(html, /says it is a program<\/td><td>1</);
    assert.match(html, /Richmond, Victoria<\/td><td>1</);
    // The phone has a row of its own: two visits, one press, 45 seconds.
    assert.equal((html.match(/<details class="visitor">/g) || []).length, 1);
    assert.match(html, /2 visits/);
    // And everything comes as one file to download, from the page's own
    // buttons without signing in again.
    assert.equal((await mf.dispatchFetch(`${BACKEND}/stats/export.json`)).status, 401);
    const [excelLink, jsonLink] = [...html.matchAll(/<a class="button" href="([^"]+)">/g)].map((one) => one[1].replace(/&amp;/g, "&"));
    assert.match(excelLink, /^\/stats\/export\.xlsx\?until=\d{13}&key=[0-9a-f]{64}$/);
    const excel = await mf.dispatchFetch(`${BACKEND}${excelLink}`);
    assert.equal(excel.status, 200);
    assert.deepEqual([...new Uint8Array(await excel.arrayBuffer()).slice(0, 2)], [0x50, 0x4b]);
    const file = await mf.dispatchFetch(`${BACKEND}${jsonLink}`);
    assert.equal(file.status, 200);
    assert.match(file.headers.get("content-disposition"), /^attachment; filename="citizens-bark-stats-\d{4}-\d{2}-\d{2}\.json"$/);
    const all = await file.json();
    assert.equal(all.days.length, 1);
    assert.equal(all.days[0].visits, 2);
    assert.deepEqual(all.days[0].places, { "Richmond, Victoria": 1 });
    assert.deepEqual(all.visitors.map((one) => [one.group, one.visits, one.secondsOnPage]), [["person", 2, 45]]);
  });

  await check("the bot's chats are still there after a restart", async () => {
    const status = (await ask(mf, "GET", "/status")).body.telegram;
    assert.equal(status.chats, 1);
    assert.equal(status.last.sent, 1);
  });

  await check("through all of that, GitHub was asked nothing more, and nothing else was asked of anyone", async () => {
    assert.equal(outside.asks.length, 2);
    assert.equal((await ask(mf, "GET", "/status")).body.starter.check.tries, 1);
    assert.deepEqual(outside.elsewhere, []);
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
