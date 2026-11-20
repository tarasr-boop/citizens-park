// The alerts backend for the Citizens Bark page, as a Cloudflare Worker.
//
// It does four things:
//   - takes in the address a browser makes when someone turns alerts on
//     (and removes it again when they turn them off)
//   - once a day, in the afternoon, sends today's notice to every address
//   - starts the daily check on GitHub when GitHub's own timer has not
//   - answers "how are things" with a few numbers
//   - counts visits to the page and presses of its buttons, for the stats page
//
// The real work is in book.js, starter.js, stats.js and statspage.js. This
// file only connects them to Cloudflare: the requests that come in, the
// timer, and the place where things are kept.

import { Book } from "./book.js";
import { MOST_BYTES, corsHeaders, settingsFrom } from "./rules.js";
import { Starter } from "./starter.js";
import { Counter, MOST_HIT_BYTES } from "./stats.js";
import { statsPage } from "./statspage.js";

// Cloudflare reads everything this file exports as something it can call: the
// worker below and the classes for the book and the counter. So nothing else is exported here.

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

/**
 * The book itself. Cloudflare keeps exactly one of these running at a time
 * ("Durable Object"), so two requests can never write over each other.
 */
export class Subscribers {
  constructor(state, env) {
    const parts = {
      storage: state.storage,
      fetch: (address, options) => fetch(address, options),
      now: () => Date.now(),
      settings: settingsFrom(env),
      log: (line) => console.log(line),
    };
    this.book = new Book(parts);
    // The second timer keeps its few notes in the same place, under names of its own.
    this.starter = new Starter({ ...parts, page: (now) => this.book.pageData(now), token: env.DAILY_CHECK_TOKEN });
    // Nothing is handled until the signing keys are ready.
    state.blockConcurrencyWhile(() => this.book.open());
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    let given = null;
    if (request.method === "POST" && path !== "/tick") {
      try {
        given = JSON.parse(await request.text());
      } catch {
        return json(400, { ok: false, reason: "bad" });
      }
    }
    let answer;
    if (path === "/key") answer = this.book.key();
    else if (path === "/status") answer = await this.status();
    else if (path === "/subscribe") answer = await this.book.subscribe(given);
    else if (path === "/unsubscribe") answer = await this.book.unsubscribe(given);
    else if (path === "/tick") answer = await this.tick();
    else answer = { status: 404, body: { ok: false, reason: "unknown" } };
    return json(answer.status, answer.body);
  }

  async status() {
    const answer = await this.book.status();
    return { status: answer.status, body: { ...answer.body, starter: await this.starter.status() } };
  }

  /** One look of the timer. It has two jobs, and trouble with one must not stop the other. */
  async tick() {
    const stumbled = (what) => (error) => {
      console.log(`${what} stumbled: ${String(error && error.message).slice(0, 200)}`);
      return null;
    };
    const alert = await this.book.tick().catch(stumbled("the alert's look"));
    const starter = await this.starter.look().catch(stumbled("the second timer's look"));
    return { status: alert && starter ? 200 : 500, body: { ok: Boolean(alert && starter), alert: alert && alert.body, starter } };
  }

  async alarm() {
    await this.book.alarm();
  }
}

/**
 * The counter behind the stats page, in an object of its own: counting a
 * visit never waits for an alert being sent, and the other way round.
 */
export class Stats {
  constructor(state, env) {
    const settings = settingsFrom(env);
    this.counter = new Counter({ storage: state.storage, now: () => Date.now(), settings });
    this.siteUrl = settings.siteUrl;
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
      const answer = await this.counter.hit(given);
      return json(answer.status, answer.body);
    }
    if (request.method === "GET" && address.pathname === "/page") {
      const report = await this.counter.report(address.searchParams.get("month"));
      return new Response(statsPage(report, this.siteUrl), { headers: PAGE_HEADERS });
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

function counter(env) {
  return env.STATS.get(env.STATS.idFromName("all"), { locationHint: "oc" });
}

/**
 * The two ways in to the counter. POST /hit is what the page sends: one visit
 * or one press. It answers with nothing, as the page never reads the answer.
 * GET /stats is the stats page, open to anyone, like /status: it shows counts only.
 */
async function stats(request, env, settings, origin, cors) {
  const address = new URL(request.url);
  try {
    if (request.method === "GET") {
      const month = address.searchParams.get("month");
      const answer = await counter(env).fetch(`https://stats/page${month ? `?month=${encodeURIComponent(month)}` : ""}`);
      return new Response(answer.body, { status: answer.status, headers: answer.headers });
    }
    // Only the page itself may count.
    if (origin !== settings.origin) return json(403, { ok: false, reason: "origin" }, cors);
    const body = await textUpTo(request, MOST_HIT_BYTES).catch(() => null);
    if (body === null) return json(413, { ok: false, reason: "bad" }, cors);
    const answer = await counter(env).fetch("https://stats/hit", { method: "POST", body });
    await answer.body?.cancel();
    return new Response(null, { status: answer.ok ? 204 : answer.status, headers: { ...cors, "Cache-Control": "no-store" } });
  } catch (error) {
    console.log(`the counter did not answer: ${String(error && error.message).slice(0, 200)}`);
    return json(503, { ok: false, reason: "later" }, cors);
  }
}

function book(env) {
  // One book for everyone, kept in Oceania, near the people it serves.
  return env.SUBSCRIBERS.get(env.SUBSCRIBERS.idFromName("all"), { locationHint: "oc" });
}

// What the outside may ask for, and where in the book it leads. The timer's
// own path, /tick, is not here: nobody outside can start a send.
const ROUTES = { "GET /": "/status", "GET /status": "/status", "GET /key": "/key", "POST /subscribe": "/subscribe", "POST /unsubscribe": "/unsubscribe" };

export default {
  async fetch(request, env) {
    let settings;
    try {
      settings = settingsFrom(env);
    } catch (error) {
      return json(500, { ok: false, reason: "settings", detail: String(error.message) });
    }
    const origin = request.headers.get("Origin");
    const cors = corsHeaders(origin, settings);
    // A browser asks first whether the page may talk to this backend.
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const asked = `${request.method} ${new URL(request.url).pathname}`;
    if (asked === "POST /hit" || asked === "GET /stats") return stats(request, env, settings, origin, cors);
    const path = ROUTES[asked];
    if (!path) return json(404, { ok: false, reason: "unknown" }, cors);

    let body;
    if (request.method === "POST") {
      // Only the page itself may add or remove a device.
      if (origin !== settings.origin) return json(403, { ok: false, reason: "origin" }, cors);
      body = await textUpTo(request, MOST_BYTES).catch(() => null);
      if (body === null) return json(413, { ok: false, reason: "bad" }, cors);
    }
    try {
      const answer = await book(env).fetch(`https://book${path}`, { method: request.method, body });
      return json(answer.status, await answer.json(), cors);
    } catch (error) {
      // The book could not be reached or stumbled. The page asks again later.
      console.log(`the book did not answer: ${String(error && error.message).slice(0, 200)}`);
      return json(503, { ok: false, reason: "later" }, cors);
    }
  },

  // Runs every five minutes through the day (see "crons" in wrangler.jsonc).
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(
      book(env)
        .fetch("https://book/tick", { method: "POST" })
        .then((answer) => answer.text())
        .then(
          (text) => console.log(`tick: ${text}`),
          (error) => console.log(`tick failed: ${String(error && error.message).slice(0, 200)}`)
        )
    );
  },
};
