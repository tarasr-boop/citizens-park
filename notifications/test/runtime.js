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
const cron = /"crons":\s*\["([^"]+)"\]/.exec(settingsText)[1];

const SITE = "https://citizensbark.example/";
const PAGE = new URL(SITE).origin;
const BACKEND = "https://alerts.example";
const GITHUB = "https://api.github.com/";
// Made up for this test. On Cloudflare the real one is a secret, handed over at deploy time.
const TOKEN = "github_pat_11STANDIN0aBcDeFgHiJkLmNoPqRsTuVwXyZ";

// The alert only goes out in the afternoon at the park, and this test has to
// pass at any hour. So the park is moved, for the test, to wherever it is
// midday right now. In these names the sign is the other way round:
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

const DAYS = [day(today, "Booked 5 PM to 7:30 PM", "Cricket training.")];
/** The page's data, made `ago` milliseconds before this test began. */
const pageMade = (ago) => pageData({ generated: new Date(started - ago).toISOString(), days: DAYS });

const outside = {
  page: pageMade(60000),
  reads: [],
  pushes: [],
  answer: () => 201,
  // What was asked of GitHub. It takes every request.
  asks: [],
};

async function outbound(request) {
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
  return new Response(null, { status: outside.answer(push) });
}

// The worker's own files, as modules. A bundle made by wrangler is one file.
// The files in src/ are the worker and the four it imports.
async function modules() {
  const names = path.basename(path.dirname(scriptPath)) === "src" ? ["worker.js", "book.js", "rules.js", "starter.js", "webpush.js"] : [path.basename(scriptPath)];
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
            ALERT_FROM: text("11:00"),
            ALERT_UNTIL: text("13:30"),
            CHECK_REPOSITORY: text("someone/park"),
            CHECK_WORKFLOW: text("daily.yml"),
            CHECK_BRANCH: text("main"),
            CHECK_TIMES: text(setTime),
            DAILY_CHECK_TOKEN: text(TOKEN),
            SUBSCRIBERS: { type: "durable-object", worker: "alerts", exportName: "Subscribers" },
          },
          exports: { Subscribers: { type: "durable-object", storage: "sqlite" } },
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
    assert.deepEqual(status.body, {
      ok: true,
      devices: 0,
      sending: false,
      last: null,
      timer: null,
      unknownServices: {},
      starter: { on: true, look: null, check: null, token: null },
    });
    assert.equal(status.headers.get("Access-Control-Allow-Origin"), null);
    const answer = await ask(mf, "GET", "/key");
    assert.equal(answer.status, 200);
    assert.equal(answer.headers.get("Access-Control-Allow-Origin"), PAGE);
    key = answer.body.key;
    assert.equal(Buffer.from(key, "base64url").length, 65);
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
        icon: `${SITE}icon-192.png`,
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
