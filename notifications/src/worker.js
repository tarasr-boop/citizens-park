// The alerts backend for the Citizens Bark page, as a Cloudflare Worker.
//
// It does four things:
//   - starts the daily check on GitHub when GitHub's own timer has not
//   - runs the Telegram bot, which sends alerts at the times people choose
//   - answers "how are things" with a few numbers
//   - counts visits to the page and presses of its buttons, for the stats page
//
// The real work is in starter.js, bot.js, stats.js and statspage.js. This
// file only connects them to Cloudflare: the requests that come in, the
// timer, and the places where things are kept.

import { Bot } from "./bot.js";
import { corsHeaders, localTime, settingsFrom } from "./rules.js";
import { Starter, pageData } from "./starter.js";
import { Counter, MOST_HIT_BYTES } from "./stats.js";
import { statsPage } from "./statspage.js";
import { statsExport, statsSheets } from "./statsexport.js";
import { xlsx } from "./xlsx.js";

// Cloudflare reads everything this file exports as something it can call: the
// worker below and the classes for the second timer, the counter and the
// bot's chats. So nothing else is exported here.

// What Telegram brings is larger than what a browser hands over, but not by much.
const MOST_UPDATE_BYTES = 65536;
// The header in which Telegram sends the password the bot gave it.
const SECRET_HEADER = "X-Telegram-Bot-Api-Secret-Token";

function json(status, body, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...extra },
  });
}

/** The text of a request, or null if it is longer than `most` bytes. It stops reading as soon as that is clear. */
async function textUpTo(request, most) {
  if (Number(request.headers.get("Content-Length")) > most) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const parts = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > most) {
      await reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  const whole = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    whole.set(part, at);
    at += part.byteLength;
  }
  return new TextDecoder().decode(whole);
}

// What the browser notifications kept, until they were taken off the page on
// 23 November 2026: each device's address at its notification service and the
// two keys for writing to it (filed under "sub:"), the backend's signing keys,
// and notes on the sending. They lived in the object that is now the second
// timer's, under these names.
const OLD_PREFIX = "sub:";
const OLD_NAMES = ["vapid", "count", "last", "tick", "hosts", "refusals", "day", "job"];

/**
 * Delete what the browser notifications kept, if anything is left. It has no
 * use any more, and the devices' addresses should not be kept for nothing.
 * After the first time there is nothing to find, and this only looks.
 */
async function forgetBrowserAlerts(storage) {
  const names = [...(await storage.get(OLD_NAMES)).keys()];
  if (!names.length && !(await storage.list({ prefix: OLD_PREFIX, limit: 1 })).size) return;
  // A round of sending that was under way would have set a wake-up call.
  await storage.deleteAlarm();
  for (;;) {
    const devices = [...(await storage.list({ prefix: OLD_PREFIX, limit: 128 })).keys()];
    if (!devices.length) break;
    await storage.delete(devices);
  }
  if (names.length) await storage.delete(names);
  console.log("what the browser notifications kept has been deleted");
}

/**
 * The second timer. Cloudflare keeps exactly one of these running at a time
 * ("Durable Object"), so two looks can never write over each other.
 */
export class Timer {
  constructor(state, env) {
    const settings = settingsFrom(env);
    const reach = (address, options) => fetch(address, options);
    this.starter = new Starter({
      storage: state.storage,
      fetch: reach,
      page: (now) => pageData(reach, settings.siteUrl, now),
      now: () => Date.now(),
      settings,
      log: (line) => console.log(line),
      token: env.DAILY_CHECK_TOKEN,
    });
    // Trouble here must not stop the second timer: the tidy-up is tried again at the next wake.
    state.blockConcurrencyWhile(() =>
      forgetBrowserAlerts(state.storage).catch((error) => console.log(`the tidy-up stumbled: ${String(error && error.message).slice(0, 200)}`))
    );
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/status") return json(200, { ok: true, starter: await this.starter.status() });
    if (path === "/tick") {
      try {
        return json(200, { ok: true, starter: await this.starter.look() });
      } catch (error) {
        console.log(`the second timer's look stumbled: ${String(error && error.message).slice(0, 200)}`);
        return json(500, { ok: false });
      }
    }
    return json(404, { ok: false, reason: "unknown" });
  }
}

/**
 * The counter behind the stats page, in an object of its own: counting a
 * visit never waits for the second timer or the bot, and the other way round.
 */
export class Stats {
  constructor(state, env) {
    const settings = settingsFrom(env);
    this.counter = new Counter({ storage: state.storage, now: () => Date.now(), settings });
    this.siteUrl = settings.siteUrl;
    this.zone = settings.zone;
  }

  async fetch(request) {
    const address = new URL(request.url);
    if (request.method === "POST" && address.pathname === "/hit") {
      let given;
      try {
        given = JSON.parse(await request.text());
      } catch {
        return json(400, { ok: false, reason: "bad" });
      }
      const answer = await this.counter.hit(given && given.hit, given && given.seen);
      return json(answer.status, answer.body);
    }
    if (request.method === "GET" && address.pathname === "/page") {
      // "visitors" is set by the worker only after the password was given.
      const visitors = address.searchParams.get("visitors");
      const report = await this.counter.report(address.searchParams.get("month"), address.searchParams.get("day"), { visitors: visitors === "1" });
      // The worker's signed part of the download links (see downloadLink).
      const download = /^until=\d{13}&key=[0-9a-f]{64}$/.test(address.searchParams.get("download") || "") ? address.searchParams.get("download") : "";
      return new Response(statsPage(report, this.siteUrl, { locked: visitors !== "off", download }), { headers: PAGE_HEADERS });
    }
    if (request.method === "GET" && address.pathname === "/export") {
      // Asked for by the worker only after the password, or a link made with it, was given.
      const [days, rows] = await Promise.all([this.counter.allDays(), this.counter.allRows()]);
      const now = Date.now();
      const file = statsExport(days, rows, { zone: this.zone, siteUrl: this.siteUrl, now });
      const name = `citizens-bark-stats-${localTime(now, this.zone).date}`;
      const excel = address.searchParams.get("format") === "xlsx";
      return new Response(excel ? xlsx(statsSheets(file)) : JSON.stringify(file, null, 1), {
        headers: {
          "Content-Type": excel ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : "application/json; charset=utf-8",
          "Content-Disposition": `attachment; filename="${name}.${excel ? "xlsx" : "json"}"`,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "no-referrer",
        },
      });
    }
    return json(404, { ok: false, reason: "unknown" });
  }
}

// The stats page runs no script and may not be shown inside another page.
const PAGE_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

/**
 * What the backend itself sees of a request to count: the browser's own
 * description of itself, and the rough place and network Cloudflare worked
 * out from the address. The address itself is not passed on.
 */
function seenOf(request) {
  const cf = request.cf || {};
  const pick = (value) => (typeof value === "string" ? value.slice(0, 100) : "");
  return {
    agent: (request.headers.get("User-Agent") || "").slice(0, 400),
    city: pick(cf.city),
    region: pick(cf.region),
    regionCode: pick(cf.regionCode),
    country: pick(cf.country),
    asOrganization: pick(cf.asOrganization),
  };
}

/**
 * Whether the request carries the stats password, the way a browser sends it
 * after asking (HTTP "Basic" sign-in; any name will do). The two are compared
 * as fingerprints of equal length, in a time that does not depend on how much
 * of the guess was right.
 */
async function rightPassword(request, password) {
  const found = /^Basic\s+([A-Za-z0-9+/=]{1,1000})$/.exec(request.headers.get("Authorization") || "");
  if (!found) return false;
  let given;
  try {
    const decoded = atob(found[1]);
    given = new TextDecoder().decode(Uint8Array.from(decoded, (char) => char.charCodeAt(0)));
  } catch {
    return false;
  }
  const colon = given.indexOf(":");
  if (colon < 0) return false;
  const encoder = new TextEncoder();
  const [mine, theirs] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(String(password))),
    crypto.subtle.digest("SHA-256", encoder.encode(given.slice(colon + 1))),
  ]);
  const a = new Uint8Array(mine);
  const b = new Uint8Array(theirs);
  if (crypto.subtle.timingSafeEqual) return crypto.subtle.timingSafeEqual(a, b);
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index];
  return difference === 0;
}

// How long a download link from the stats page keeps working.
const DOWNLOAD_HOURS = 12;

/** The key for a download link that works until `until` (milliseconds), made with the stats password. */
async function downloadKey(password, until) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(String(password)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signed = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(`stats download until ${until}`)));
  return [...signed].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The part of a download address that lets the signed-in page's buttons work
 * without the browser asking for the password again: some browsers (Safari
 * among them) do not send the password with a download. It works for
 * DOWNLOAD_HOURS and only for the files, and changing the password ends it.
 */
async function downloadLink(password, now) {
  const until = now + DOWNLOAD_HOURS * 60 * 60 * 1000;
  return `until=${until}&key=${await downloadKey(password, until)}`;
}

async function rightLink(address, password, now) {
  const until = address.searchParams.get("until") || "";
  const key = address.searchParams.get("key") || "";
  if (!/^\d{13}$/.test(until) || !/^[0-9a-f]{64}$/.test(key)) return false;
  if (Number(until) <= now || Number(until) > now + DOWNLOAD_HOURS * 60 * 60 * 1000) return false;
  const encoder = new TextEncoder();
  const a = encoder.encode(await downloadKey(password, Number(until)));
  const b = encoder.encode(key);
  if (crypto.subtle.timingSafeEqual) return crypto.subtle.timingSafeEqual(a, b);
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index];
  return difference === 0;
}

const DOWNLOADS = { "/stats/export": "json", "/stats/export.json": "json", "/stats/export.xlsx": "xlsx" };

function counter(env) {
  return env.STATS.get(env.STATS.idFromName("all"), { locationHint: "oc" });
}

/**
 * The two ways in to the counter. POST /hit is what the page sends: one visit,
 * one press or how long one look lasted. It answers with nothing, as the page
 * never reads the answer. GET /stats is the stats page (?month=2026-11 for a
 * month, ?day=2026-11-21 for a day). With the secret STATS_PASSWORD set, it
 * asks for that password and also lists the visitors. Without it, it is open
 * to anyone, like /status, and shows counts only. GET /stats/export.xlsx and
 * /stats/export.json are everything kept, as one file to download, only
 * behind the password or a download link from the signed-in page.
 */
function signIn() {
  return new Response("This page needs the stats password.\n", {
    status: 401,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "WWW-Authenticate": 'Basic realm="Citizens Bark stats", charset="UTF-8"' },
  });
}

async function stats(request, env, settings, origin, cors) {
  const address = new URL(request.url);
  try {
    if (request.method === "GET") {
      const password = env.STATS_PASSWORD;
      const format = DOWNLOADS[address.pathname];
      if (format) {
        // The files hold every visitor, so they are there only behind the
        // password: given to the browser, or in a link the signed-in page made.
        if (!password) return new Response("The download needs the stats password to be set (see the README).\n", { status: 403, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
        if (!(await rightLink(address, password, Date.now())) && !(await rightPassword(request, password))) return signIn();
        const file = await counter(env).fetch(`https://stats/export?format=${format}`);
        return new Response(file.body, { status: file.status, headers: file.headers });
      }
      // With a password set, the whole page asks for it. Without one, it
      // shows counts only, and never the list of visitors.
      let visitors = "off";
      let download = "";
      if (password) {
        if (!(await rightPassword(request, password))) return signIn();
        visitors = "1";
        download = await downloadLink(password, Date.now());
      }
      const asked = new URLSearchParams({ visitors });
      if (download) asked.set("download", download);
      for (const name of ["month", "day"]) {
        const value = address.searchParams.get(name);
        if (value) asked.set(name, value.slice(0, 20));
      }
      const answer = await counter(env).fetch(`https://stats/page?${asked}`);
      return new Response(answer.body, { status: answer.status, headers: answer.headers });
    }
    // Only the page itself may count.
    if (origin !== settings.origin) return json(403, { ok: false, reason: "origin" }, cors);
    const body = await textUpTo(request, MOST_HIT_BYTES).catch(() => null);
    if (body === null) return json(413, { ok: false, reason: "bad" }, cors);
    let hit;
    try {
      hit = JSON.parse(body);
    } catch {
      return json(400, { ok: false, reason: "bad" }, cors);
    }
    const answer = await counter(env).fetch("https://stats/hit", { method: "POST", body: JSON.stringify({ hit, seen: seenOf(request) }) });
    await answer.body?.cancel();
    return new Response(null, { status: answer.ok ? 204 : answer.status, headers: { ...cors, "Cache-Control": "no-store" } });
  } catch (error) {
    console.log(`the counter did not answer: ${String(error && error.message).slice(0, 200)}`);
    return json(503, { ok: false, reason: "later" }, cors);
  }
}

/**
 * The Telegram bot's list of chats. Kept apart from the second timer, with
 * its own small database and its own wake-up calls, so that the two never
 * wait for each other.
 */
export class Chats {
  constructor(state, env) {
    this.bot = new Bot({
      sql: state.storage.sql,
      storage: state.storage,
      fetch: (address, options) => fetch(address, options),
      now: () => Date.now(),
      settings: settingsFrom(env),
      log: (line) => console.log(line),
      token: env.TELEGRAM_BOT_TOKEN,
    });
    state.blockConcurrencyWhile(async () => this.bot.open());
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    let answer;
    if (path === "/status") answer = { status: 200, body: await this.bot.status() };
    else if (path === "/tick") answer = { status: 200, body: await this.bot.tick() };
    else if (path === "/telegram") {
      let given;
      try {
        given = JSON.parse(await request.text());
      } catch {
        return json(400, { ok: false, reason: "bad" });
      }
      answer = await this.bot.update(given, request.headers.get(SECRET_HEADER) || "");
    } else answer = { status: 404, body: { ok: false, reason: "unknown" } };
    return json(answer.status, answer.body);
  }

  async alarm() {
    await this.bot.alarm();
  }
}

function timer(env) {
  // One for everything, kept in Oceania, near the page and the people it serves.
  return env.TIMER.get(env.TIMER.idFromName("all"), { locationHint: "oc" });
}

function chats(env) {
  return env.CHATS.get(env.CHATS.idFromName("all"), { locationHint: "oc" });
}

/** What the bot says about itself on the status page, or null if it cannot be reached. */
async function botStatus(env) {
  try {
    const answer = await chats(env).fetch("https://chats/status");
    return answer.ok ? await answer.json() : null;
  } catch {
    return null;
  }
}

/** Telegram brings something people wrote to the bot. Only Telegram knows the password that comes with it. */
async function telegramUpdate(request, env) {
  const secret = request.headers.get(SECRET_HEADER) || "";
  if (!secret) return json(403, { ok: false, reason: "secret" });
  const body = await textUpTo(request, MOST_UPDATE_BYTES).catch(() => null);
  if (body === null) return json(413, { ok: false, reason: "bad" });
  try {
    const answer = await chats(env).fetch("https://chats/telegram", { method: "POST", body, headers: { [SECRET_HEADER]: secret } });
    return json(answer.status, await answer.json());
  } catch (error) {
    // Telegram brings it again a little later.
    console.log(`the bot did not answer: ${String(error && error.message).slice(0, 200)}`);
    return json(503, { ok: false, reason: "later" });
  }
}

export default {
  async fetch(request, env) {
    let settings;
    try {
      settings = settingsFrom(env);
    } catch (error) {
      return json(500, { ok: false, reason: "settings", detail: String(error.message) });
    }
    // Telegram's own requests come from its servers, not from the page.
    if (request.method === "POST" && new URL(request.url).pathname === "/telegram") return telegramUpdate(request, env);
    const origin = request.headers.get("Origin");
    const cors = corsHeaders(origin, settings);
    // A browser asks first whether the page may talk to this backend.
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const asked = `${request.method} ${new URL(request.url).pathname}`;
    if (asked === "POST /hit" || asked === "GET /stats" || (asked.startsWith("GET ") && asked.slice(4) in DOWNLOADS)) return stats(request, env, settings, origin, cors);
    // The status page: how the second timer and the bot are doing, in numbers
    // and words only. The timer's own path, /tick, cannot be reached from outside.
    if (asked !== "GET /" && asked !== "GET /status") return json(404, { ok: false, reason: "unknown" }, cors);
    try {
      const answer = await timer(env).fetch("https://timer/status");
      const said = await answer.json();
      if (env.CHATS) said.telegram = await botStatus(env);
      return json(answer.status, said, cors);
    } catch (error) {
      console.log(`the second timer did not answer: ${String(error && error.message).slice(0, 200)}`);
      return json(503, { ok: false, reason: "later" }, cors);
    }
  },

  // Runs every five minutes through the day (see "crons" in wrangler.jsonc).
  // The second timer and the bot each take their own look, and trouble with
  // one does not stop the other.
  async scheduled(controller, env, ctx) {
    const look = (what, place, address) =>
      place
        .fetch(address, { method: "POST" })
        .then((answer) => answer.text())
        .then(
          (text) => console.log(`${what}: ${text}`),
          (error) => console.log(`${what} failed: ${String(error && error.message).slice(0, 200)}`)
        );
    ctx.waitUntil(look("tick", timer(env), "https://timer/tick"));
    if (env.CHATS) ctx.waitUntil(look("bot", chats(env), "https://chats/tick"));
  },
};
