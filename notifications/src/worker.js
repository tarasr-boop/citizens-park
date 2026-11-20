// The alerts backend for the Citizens Bark page, as a Cloudflare Worker.
//
// It does four things:
//   - takes in the address a browser makes when someone turns alerts on
//     (and removes it again when they turn them off)
//   - once a day, in the afternoon, sends today's notice to every address
//   - starts the daily check on GitHub when GitHub's own timer has not
//   - answers "how are things" with a few numbers
//
// The real work is in book.js and starter.js. This file only connects them to
// Cloudflare: the requests that come in, the timer, and the place where
// things are kept.

import { Book } from "./book.js";
import { MOST_BYTES, corsHeaders, settingsFrom } from "./rules.js";
import { Starter } from "./starter.js";

// Cloudflare reads everything this file exports as something it can call: the
// worker below and the class for the book. So nothing else is exported here.

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

    const path = ROUTES[`${request.method} ${new URL(request.url).pathname}`];
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
