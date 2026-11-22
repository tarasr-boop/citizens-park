// Stand-ins for the tests: a place to keep things, a clock, a phone with its
// keys, and the outside world (the notification services, the page and GitHub).
//
// The phone here reads a notification with Node's own cryptography, written
// separately from the code under test, so that the two check each other.

import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { settingsFrom } from "../src/rules.js";

export const SITE = "https://citizensbark.example/";
// The alert at 3 PM from Monday to Friday and at 8 AM at the weekend. It may go out half an hour before.
export const ENV = { SITE_URL: SITE, TIMEZONE: "Australia/Melbourne", ALERT_WEEKDAYS: "15:00", ALERT_WEEKENDS: "08:00", ALERT_UNTIL: "19:00" };
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
    /** The devices in the book, as pairs of name and entry. */
    devices() {
      return [...kept.entries()].filter(([name]) => name.startsWith("sub:")).sort(([a], [b]) => (a < b ? -1 : 1));
    },
  };
  return storage;
}

const b64 = (bytes) => Buffer.from(bytes).toString("base64url");

/** A phone: an address at a notification service, and the keys only it holds. */
export function newDevice(host = "fcm.googleapis.com") {
  const pair = crypto.createECDH("prime256v1");
  pair.generateKeys();
  const auth = crypto.randomBytes(16);
  const endpoint = `https://${host}/send/${crypto.randomBytes(12).toString("hex")}`;
  return {
    endpoint,
    host,
    /** What the browser hands to the page: the address and the public halves of the keys. */
    subscription: { endpoint, expirationTime: null, keys: { p256dh: b64(pair.getPublicKey()), auth: b64(auth) } },
    /** Read a notification as the phone would (RFC 8291 and RFC 8188). Throws if it was not written for this phone. */
    read(body) {
      const bytes = Buffer.from(body);
      const salt = bytes.subarray(0, 16);
      const recordSize = bytes.readUInt32BE(16);
      const keyLength = bytes[20];
      const theirs = bytes.subarray(21, 21 + keyLength);
      const sealed = bytes.subarray(21 + keyLength);
      if (sealed.length > recordSize) throw new Error("more than one record");
      const shared = pair.computeSecret(theirs);
      const info = Buffer.concat([Buffer.from("WebPush: info\0"), pair.getPublicKey(), theirs]);
      const mixed = Buffer.from(crypto.hkdfSync("sha256", shared, auth, info, 32));
      const key = Buffer.from(crypto.hkdfSync("sha256", mixed, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
      const nonce = Buffer.from(crypto.hkdfSync("sha256", mixed, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
      const opener = crypto.createDecipheriv("aes-128-gcm", key, nonce);
      opener.setAuthTag(sealed.subarray(sealed.length - 16));
      const padded = Buffer.concat([opener.update(sealed.subarray(0, sealed.length - 16)), opener.final()]);
      let last = padded.length - 1;
      while (last >= 0 && padded[last] === 0) last -= 1;
      if (padded[last] !== 2) throw new Error("the last record is not marked as the last");
      return padded.subarray(0, last);
    },
    /** The same, as the words of the notification. */
    words(body) {
      return JSON.parse(this.read(body).toString("utf8"));
    },
  };
}

/** Take apart the proof of who is sending (RFC 8292) and check its signature. */
export function readProof(header) {
  const found = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(header);
  if (!found) throw new Error(`not a proof: ${header}`);
  const [, head, claims, signature, key] = found;
  const point = Buffer.from(key, "base64url");
  const publicKey = crypto.createPublicKey({
    key: { kty: "EC", crv: "P-256", x: b64(point.subarray(1, 33)), y: b64(point.subarray(33)) },
    format: "jwk",
  });
  return {
    valid: crypto.verify("sha256", Buffer.from(`${head}.${claims}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url")),
    head: JSON.parse(Buffer.from(head, "base64url").toString("utf8")),
    claims: JSON.parse(Buffer.from(claims, "base64url").toString("utf8")),
    key,
    point,
  };
}

/** The page's data, as the daily check publishes it: only the parts the backend reads. */
export function pageData({ generated, generatedText = "3:01 PM", days }) {
  return { zone: "Australia/Melbourne", generated, generatedText, alert: { weekdays: 900, weekends: 480, until: 1140 }, days };
}

export function day(date, title = "Booked 5 PM to 7:30 PM", body = "Cricket training.") {
  return { date, notice: { title, body } };
}

/**
 * The outside world. `page` is what the page's data.json holds: an object, a
 * status number, "down" for no connection, or text that is not JSON. `answer`
 * decides what a notification service says to a message: a status number,
 * `{ status, words }`, or "down". `github` decides the same for GitHub: by default it takes every
 * request. Every request is written down in `calls`.
 */
export function world({ page = null, words = null, answer = () => 201, pause = 0, github = (call) => (call.method === "GET" ? 200 : 204), telegram = () => null } = {}) {
  const it = {
    page,
    words,
    answer,
    github,
    telegram,
    calls: [],
    flying: 0,
    mostFlying: 0,
    /** What was asked of GitHub, in order. */
    get asks() {
      return it.calls.filter((call) => call.kind === "github");
    },
    /** The requests to GitHub to run the check. */
    get starts() {
      return it.asks.filter((call) => call.method === "POST");
    },
    /** The messages sent to notification services, in the order they went out. */
    get pushes() {
      return it.calls.filter((call) => call.kind === "push");
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
    pushesTo(device) {
      return it.pushes.filter((call) => call.url === device.endpoint);
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
      const call = { kind: "push", url, options, headers: options.headers || {}, body: options.body };
      it.calls.push(call);
      it.flying += 1;
      it.mostFlying = Math.max(it.mostFlying, it.flying);
      try {
        // Let the others take off, as they would on a real network.
        await new Promise((resolve) => setTimeout(resolve, pause));
        const said = await it.answer(url, call);
        if (said === "down") throw new TypeError("fetch failed");
        // A number, or `{ status, words }` when the service also says why.
        const status = typeof said === "object" ? said.status : said;
        return new Response(status === 204 ? null : (said && said.words) || "", { status });
      } finally {
        it.flying -= 1;
      }
    },
  };
  return it;
}

/**
 * Run the wake-up calls the way Cloudflare does: when the time comes, the
 * wake-up time is cleared and `alarm` is called, which may set a new one.
 * Returns the moments at which rounds ran.
 */
export async function runAlarms(book, storage, time, most = 1000) {
  const rounds = [];
  while (storage.alarm !== null) {
    if (rounds.length >= most) throw new Error("the wake-up calls never stop");
    if (storage.alarm > time.now()) time.set(storage.alarm);
    storage.alarm = null;
    rounds.push(time.now());
    await book.alarm();
  }
  return rounds;
}
