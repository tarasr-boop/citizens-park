// Stand-ins for the tests: a place to keep things, a clock, and the outside
// world (the page, GitHub and Telegram).

import { DatabaseSync } from "node:sqlite";
import { settingsFrom } from "../src/rules.js";

export const SITE = "https://citizensbark.example/";
export const ENV = { SITE_URL: SITE, TIMEZONE: "Australia/Melbourne" };
export const settings = settingsFrom(ENV);

// The second timer's four settings, with the times of day the real check has.
export const CHECK = { CHECK_REPOSITORY: "someone/park", CHECK_WORKFLOW: "daily.yml", CHECK_BRANCH: "main", CHECK_TIMES: "06:17 11:47 13:47 14:40 15:10 15:45 17:47 19:47" };
export const GITHUB = "https://api.github.com/";
export const TELEGRAM = "https://api.telegram.org/";
// The Telegram bot's settings, as wrangler.jsonc has them.
export const BOT = {
  PARK_NAME: "Citizens Park oval",
  BACKEND_URL: "https://alerts.example",
  BOT_FIRST: "04:00",
  BOT_LAST: "23:00",
  BOT_EVENING: "21:00",
  BOT_WEEKDAY: "16:00",
  BOT_WEEKEND: "08:00",
  BOT_LINK: "https://www.instagram.com/gentle_woof",
  BOT_LINK_TEXT: "Book a consultation with Sofia",
};
// Made up for the tests: the shape of a bot token, and the name Telegram gives the bot.
export const BOT_TOKEN = "123456789:STANDIN-aBcDeFgHiJkLmNoPqRsTuVwXyZ01234";
export const BOT_NAME = "standin_park_bot";
// What GitHub puts in an answer. The backend keeps the number of an answer and none of its words.
export const GITHUB_WORDS = "words from GitHub";

/** JSON with `//` comments, which is how wrangler.jsonc is written. */
export function readJsonc(text) {
  let out = "";
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      out += char;
      if (char === "\\") {
        index += 1;
        out += text[index];
      } else if (char === '"') {
        inString = false;
      }
    } else if (char === '"') {
      inString = true;
      out += char;
    } else if (text.startsWith("//", index)) {
      while (index < text.length && text[index] !== "\n") index += 1;
      out += "\n";
    } else {
      out += char;
    }
  }
  return JSON.parse(out);
}

/** A moment in Melbourne's summer (UTC+11), such as at("2026-11-20", "15:00"). */
export function at(date, time, offset = "+11:00") {
  return Date.parse(`${date}T${time}:00${offset}`);
}

export function clock(start) {
  const it = {
    ms: start,
    now: () => it.ms,
    set(ms) {
      it.ms = ms;
    },
    forward(ms) {
      it.ms += ms;
    },
  };
  return it;
}

/**
 * A Durable Object's SQLite database, for the tests: the real SQLite that
 * comes with Node, behind the one call the bot uses, `exec`.
 */
export function memorySql() {
  const db = new DatabaseSync(":memory:");
  return {
    db,
    exec(query, ...values) {
      const statement = db.prepare(query);
      if (/^\s*SELECT/i.test(query)) {
        const rows = statement.all(...values).map((row) => ({ ...row }));
        return { toArray: () => rows, rowsWritten: 0 };
      }
      const { changes } = statement.run(...values);
      return { toArray: () => [], rowsWritten: Number(changes) };
    },
    /** Every chat, as plain objects in the order of their numbers. */
    chats() {
      return db.prepare("SELECT * FROM chats ORDER BY id").all().map((row) => ({ ...row }));
    },
  };
}

/**
 * Keeps things the way a Durable Object's storage does: by name, in the order
 * of the names, with one wake-up time. What goes in and what comes out are
 * copies, as they are in the real thing.
 */
export function memoryStorage() {
  const kept = new Map();
  const copy = (value) => (value === undefined ? undefined : structuredClone(value));
  const storage = {
    kept,
    alarm: null,
    writes: 0,
    async get(name) {
      if (Array.isArray(name)) {
        if (name.length > 128) throw new Error("at most 128 names at once");
        const found = new Map();
        for (const one of [...name].sort()) if (kept.has(one)) found.set(one, copy(kept.get(one)));
        return found;
      }
      return copy(kept.get(name));
    },
    async put(name, value) {
      storage.writes += 1;
      if (typeof name === "string") {
        kept.set(name, copy(value));
        return;
      }
      if (Object.keys(name).length > 128) throw new Error("at most 128 pairs at once");
      for (const [one, its] of Object.entries(name)) kept.set(one, copy(its));
    },
    async delete(name) {
      storage.writes += 1;
      if (Array.isArray(name)) {
        if (name.length > 128) throw new Error("at most 128 names at once");
        return name.filter((one) => kept.delete(one)).length;
      }
      return kept.delete(name);
    },
    async list({ start, startAfter, end, prefix, limit, reverse } = {}) {
      let names = [...kept.keys()].sort();
      if (prefix !== undefined) names = names.filter((name) => name.startsWith(prefix));
      if (start !== undefined) names = names.filter((name) => name >= start);
      if (startAfter !== undefined) names = names.filter((name) => name > startAfter);
      if (end !== undefined) names = names.filter((name) => name < end);
      if (reverse) names.reverse();
      if (limit !== undefined) names = names.slice(0, limit);
      return new Map(names.map((name) => [name, copy(kept.get(name))]));
    },
    async setAlarm(ms) {
      storage.alarm = Number(ms);
    },
    async getAlarm() {
      return storage.alarm;
    },
    async deleteAlarm() {
      storage.alarm = null;
    },
  };
  return storage;
}

/** The page's data, as the daily check publishes it: only the parts the backend reads. */
export function pageData({ generated, generatedText = "3:01 PM", days }) {
  return { zone: "Australia/Melbourne", generated, generatedText, days };
}

export function day(date, label = "Cricket training") {
  return { date, slots: [[1020, 1170]], label };
}

/**
 * The outside world. `page` is what the page's data.json holds: an object, a
 * status number, "down" for no connection, or text that is not JSON. `words`
 * is the same for telegram.json. `github` decides what GitHub answers: by
 * default it takes every request. `telegram` does the same for Telegram.
 * Every request is written down in `calls`. Any other address is refused,
 * as nothing else should be asked.
 */
export function world({ page = null, words = null, github = (call) => (call.method === "GET" ? 200 : 204), telegram = () => null } = {}) {
  const it = {
    page,
    words,
    github,
    telegram,
    calls: [],
    /** What was asked of GitHub, in order. */
    get asks() {
      return it.calls.filter((call) => call.kind === "github");
    },
    /** The requests to GitHub to run the check. */
    get starts() {
      return it.asks.filter((call) => call.method === "POST");
    },
    get reads() {
      return it.calls.filter((call) => call.kind === "page");
    },
    /** What was asked of Telegram, in order, as `{ method, body }`. */
    get bot() {
      return it.calls.filter((call) => call.kind === "telegram");
    },
    /** The messages the bot sent, as `{ chat_id, text, ... }`. */
    get said() {
      return it.bot.filter((call) => call.method === "sendMessage").map((call) => call.body);
    },
    /** The pictures the bot sent, as `{ chat_id, photo, caption, ... }`. */
    get pictures() {
      return it.bot.filter((call) => call.method === "sendPhoto").map((call) => call.body);
    },
    async fetch(address, options = {}) {
      const url = String(address);
      if (url.startsWith(`${SITE}telegram.json`)) {
        it.calls.push({ kind: "words", url, options });
        if (it.words === "down") throw new TypeError("fetch failed");
        if (typeof it.words === "number") return new Response("no", { status: it.words });
        return new Response(JSON.stringify(it.words), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.startsWith(TELEGRAM)) {
        const found = /^https:\/\/api\.telegram\.org\/bot([^/]+)\/(\w+)$/.exec(url);
        const call = { kind: "telegram", url, token: found && found[1], method: found && found[2], body: JSON.parse(options.body || "{}"), options };
        it.calls.push(call);
        // The test may decide the answer, as `{ status, result, description, retry_after }`, "down", or null for the usual.
        const said = await it.telegram(call);
        if (said === "down") throw new TypeError("fetch failed");
        const usual = {
          getMe: { id: 123456789, is_bot: true, username: BOT_NAME },
          getWebhookInfo: { url: "https://alerts.example/telegram", pending_update_count: 0 },
          getMyDescription: { description: "" },
          getMyShortDescription: { short_description: "" },
          getMyName: { name: "Citizens Park Dogs" },
          // Message numbers of their own, well away from the numbers of the messages people write.
          sendMessage: call.method === "sendMessage" ? { message_id: (call.sent = 1000 + (it.sent = (it.sent || 0) + 1)) } : null,
          // A picture comes back in a few sizes, the largest last, each with Telegram's number for it.
          sendPhoto:
            call.method === "sendPhoto"
              ? { message_id: (call.sent = 1000 + (it.sent = (it.sent || 0) + 1)), photo: [{ file_id: "small-one", width: 320 }, { file_id: "telegram-picture-1", width: 840 }] }
              : null,
        };
        const status = (said && said.status) || 200;
        const body = status === 200
          ? { ok: true, result: said && "result" in said ? said.result : (usual[call.method] ?? true) }
          : { ok: false, error_code: status, description: (said && said.description) || "Bad Request", ...(said && said.retry_after ? { parameters: { retry_after: said.retry_after } } : {}) };
        return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
      }
      if (url.startsWith(SITE)) {
        it.calls.push({ kind: "page", url, options });
        if (it.page === "down") throw new TypeError("fetch failed");
        if (typeof it.page === "number") return new Response("no", { status: it.page });
        if (typeof it.page === "string") return new Response(it.page, { status: 200 });
        return new Response(JSON.stringify(it.page), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.startsWith(GITHUB)) {
        const call = { kind: "github", url, method: options.method || "GET", headers: options.headers || {}, body: options.body, options };
        it.calls.push(call);
        const said = await it.github(call);
        if (said === "down") throw new TypeError("fetch failed");
        return new Response(said === 204 ? null : JSON.stringify({ message: GITHUB_WORDS }), { status: said });
      }
      it.calls.push({ kind: "elsewhere", url, options });
      throw new TypeError(`nothing should be asked of ${url}`);
    },
  };
  return it;
}

/**
 * Run the wake-up calls the way Cloudflare does: when the time comes, the
 * wake-up time is cleared and `alarm` is called, which may set a new one.
 * Returns the moments at which rounds ran.
 */
export async function runAlarms(object, storage, time, most = 1000) {
  const rounds = [];
  while (storage.alarm !== null) {
    if (rounds.length >= most) throw new Error("the wake-up calls never stop");
    if (storage.alarm > time.now()) time.set(storage.alarm);
    storage.alarm = null;
    rounds.push(time.now());
    await object.alarm();
  }
  return rounds;
}
