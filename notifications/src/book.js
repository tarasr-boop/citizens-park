// The book of devices that want the daily alert, and the sending of it.
//
// What is kept for a device is only what its browser handed over for this
// purpose: an address at the browser maker's notification service, and two
// keys for writing to it. No name, no location, nothing else.
//
// This file knows nothing about Cloudflare. It is given a place to keep
// things, a way to fetch, and a clock, so the tests can stand in for all three.

import { authorization, loadSigningKeys, newSigningKeys, send, toBase64Url } from "./webpush.js";
import { GRACE_MINUTES, Refusal, alertFrom, checkSubscription, isFresh, localTime, messageFor, noticeFor, tidyEndpoint, welcome } from "./rules.js";

const encoder = new TextEncoder();

// Entries for devices are filed under "sub:" plus a fingerprint of the address.
const FIRST = "sub:";
const AFTER_LAST = "sub;"; // the text that sorts straight after every "sub:..." name

// How many devices are written to in one go. Cloudflare's free plan allows 50
// outgoing requests each time this code is woken, so the rest wait for the
// next waking, a moment later.
export const BATCH = 40;
// How many messages are on their way at the same moment.
const LANES = 5;
const PAUSE_MS = 1000;
// A push service that asks for patience ("later") is tried again after 2 minutes, then after 10.
const RETRY_AFTER_MS = [2 * 60 * 1000, 10 * 60 * 1000];
const MOST_RETRIES = 2000;
// An address its push service will not take messages for, five days running, is dropped.
const GIVE_UP_AFTER = 5;
// More devices than this are not taken on: the free plan would not carry them comfortably.
export const MOST_DEVICES = 5000;
// At most this many first notifications a minute, so that nobody can use this
// backend to pester the push services.
const MOST_WELCOMES_A_MINUTE = 30;
// The daily alert is about the hours after it. A phone that was off for longer does not need it any more.
const ALERT_TTL = 4 * 3600;
const WELCOME_TTL = 3600;
const MOST_HOSTS_NOTED = 10;
const MOST_NOTED_PER_HOST = 100;
// How many different refusals are remembered for the status page. A new kind
// takes the place of the one not seen for the longest time.
const MOST_REFUSALS_NOTED = 10;

function reply(status, body) {
  return { status, body };
}

/** The push service an entry's address belongs to, such as "https://fcm.googleapis.com". */
function serviceOf(entry) {
  try {
    return new URL(entry.endpoint).origin;
  } catch {
    return "";
  }
}

export class Book {
  /**
   * `storage` is a Durable Object's storage (get, put, delete, list, setAlarm,
   * getAlarm). `fetch` is how to reach the outside. `now` gives the time in
   * milliseconds. `settings` comes from `settingsFrom`. `log` takes one line.
   */
  constructor({ storage, fetch, now, settings, log }) {
    this.storage = storage;
    this.fetch = fetch;
    this.now = now;
    this.settings = settings;
    this.log = log || (() => {});
    this.keys = null;
    this.welcomed = [];
  }

  /** Get the signing keys ready, making them the first time. Call once before anything else. */
  async open() {
    let stored = await this.storage.get("vapid");
    if (!stored) {
      // Made here and never shown to anyone: there is no secret for a person to keep or to leak.
      stored = await newSigningKeys();
      await this.storage.put("vapid", stored);
    }
    this.keys = await loadSigningKeys(stored);
  }

  /** The public half of the signing keys. A browser needs it to make an address for this backend. */
  key() {
    return reply(200, { ok: true, key: this.keys.publicKey });
  }

  async name(endpoint) {
    const digest = await crypto.subtle.digest("SHA-256", encoder.encode(endpoint));
    return FIRST + toBase64Url(digest);
  }

  async count() {
    return (await this.storage.get("count")) || 0;
  }

  /**
   * Write `message` to each of `entries` (pairs of name and entry), a few at a
   * time. Returns triples of name, entry and what happened: "sent", "gone",
   * "refused" or "later". Never throws.
   *
   * Each refusal is noted for the status page (see `noteRefusals`). The push
   * service's own words are kept only with `words`: for addresses that are in
   * the book, which have taken a message before.
   */
  async deliver(entries, message, ttl, words = true) {
    const now = this.now();
    const proofs = new Map(); // one signed proof for each push service, shared by all its addresses
    const results = [];
    const refusals = [];
    let next = 0;
    const lane = async () => {
      while (next < entries.length) {
        const [name, entry] = entries[next];
        next += 1;
        let result;
        let address = null;
        try {
          address = new URL(entry.endpoint);
        } catch {
          result = "refused"; // an entry that is not an address
          refusals.push({ host: "no-address", status: 0, said: "the entry is not an address" });
        }
        if (address) {
          const origin = address.origin;
          try {
            if (!proofs.has(origin)) proofs.set(origin, authorization(origin, this.keys, this.settings.siteUrl, now));
            result = await send(entry, message, {
              authorization: await proofs.get(origin),
              ttl,
              fetch: this.fetch,
              refused: (status, said) => refusals.push({ host: address.hostname, status, said: words || !status ? said : "" }),
            });
          } catch {
            result = "later"; // the proof could not be signed: the trouble is here, not with the address
          }
        }
        results.push([name, entry, result]);
      }
    };
    await Promise.all(Array.from({ length: Math.min(LANES, entries.length) }, lane));
    if (refusals.length) await this.noteRefusals(refusals).catch(() => {});
    return results;
  }

  /**
   * Keep, for the status page, why messages were refused: the push service's
   * name and the number of its answer, with how often, on which day last, and
   * its words. A refusal is the one answer that can mean the fault is on this
   * side, and without this nobody could tell. No address and no key is kept.
   */
  async noteRefusals(found) {
    const noted = (await this.storage.get("refusals")) || {};
    const on = localTime(this.now(), this.settings.zone).date;
    for (const { host, status, said } of found) {
      // Only a plain name is noted: the status page can be read by anyone.
      if (!/^[a-z0-9.-]{1,80}$/.test(host) || !Number.isInteger(status)) continue;
      const kind = `${host} ${status}`;
      const seen = Object.hasOwn(noted, kind) ? noted[kind] : null;
      if (!seen && Object.keys(noted).length >= MOST_REFUSALS_NOTED) {
        const oldest = Object.keys(noted).reduce((a, b) => (noted[b].on < noted[a].on ? b : a));
        delete noted[oldest];
      }
      noted[kind] = { times: Math.min((seen ? seen.times : 0) + 1, MOST_NOTED_PER_HOST), on, said: said || (seen ? seen.said : "") };
    }
    await this.storage.put("refusals", noted);
  }

  async noteHost(host) {
    // Only a plain name is noted: it is shown on the status page, which anyone can read.
    if (!/^[a-z0-9.-]{1,80}$/.test(host)) return;
    const hosts = (await this.storage.get("hosts")) || {};
    const seen = Object.hasOwn(hosts, host) ? hosts[host] : 0;
    // A short list and a count that stops, so that nobody can make this backend write without end.
    if (seen >= MOST_NOTED_PER_HOST || (!seen && Object.keys(hosts).length >= MOST_HOSTS_NOTED)) return;
    await this.storage.put("hosts", { ...hosts, [host]: seen + 1 });
  }

  /**
   * A browser hands over its address. A new address is sent a first
   * notification, which both tells the person that it works and proves that
   * the address is real. Only then is it written into the book.
   *
   * The page also does this once a day for a device that has alerts on. That
   * is how a device finds out that its address has stopped working: the
   * answer "gone" makes the page ask its browser for a fresh one.
   */
  async subscribe(given) {
    let mine;
    try {
      mine = checkSubscription(given && given.subscription);
    } catch (error) {
      if (!(error instanceof Refusal)) throw error;
      // A notification service this backend does not know. Its name is noted, so it can be added if it is a real one.
      if (error.host) await this.noteHost(error.host);
      return reply(error.status, { ok: false, reason: error.reason });
    }
    const name = await this.name(mine.endpoint);
    const known = await this.storage.get(name);
    // An address in the book whose last alert went through needs nothing more.
    if (known && !known.fails) {
      if (known.p256dh !== mine.p256dh || known.auth !== mine.auth) await this.storage.put(name, { ...known, ...mine });
      return reply(200, { ok: true, new: false });
    }
    if (!known && (await this.count()) >= MOST_DEVICES) return reply(503, { ok: false, reason: "full" });

    const now = this.now();
    this.welcomed = this.welcomed.filter((at) => now - at < 60000);
    if (this.welcomed.length >= MOST_WELCOMES_A_MINUTE) return reply(429, { ok: false, reason: "later" });
    this.welcomed.push(now);

    // A new address, or one whose last alert was refused: it is written to now.
    const hello = messageFor(welcome(this.settings), this.settings, "welcome");
    const [[, , result]] = await this.deliver([[name, mine]], hello, WELCOME_TTL, Boolean(known));
    if (result === "later") {
      // No clear answer. An address in the book stays there, a new one is not added.
      return known ? reply(200, { ok: true, new: false }) : reply(503, { ok: false, reason: "later" });
    }
    if (result !== "sent") {
      // "gone" or "refused": the push service does not take messages from us for
      // this address. The page drops it and asks its browser for a fresh one.
      if (await this.storage.delete(name)) await this.storage.put("count", Math.max(0, (await this.count()) - 1));
      return reply(410, { ok: false, reason: "gone" });
    }

    // Looked up again: the same address may have been written in, or taken out, while the notification was on its way.
    const there = await this.storage.get(name);
    if (there) {
      await this.storage.put(name, { ...there, ...mine, fails: 0 });
      return reply(200, { ok: true, new: false });
    }
    await this.storage.put({ [name]: { ...mine, added: now, fails: 0 }, count: (await this.count()) + 1 });
    this.log("a device was added");
    return reply(201, { ok: true, new: true });
  }

  /** A browser takes its address back. The answer is the same whether or not it was in the book. */
  async unsubscribe(given) {
    let endpoint;
    try {
      endpoint = tidyEndpoint(given && given.endpoint);
    } catch (error) {
      if (!(error instanceof Refusal)) throw error;
      return reply(error.status, { ok: false, reason: error.reason });
    }
    if (await this.storage.delete(await this.name(endpoint))) {
      await this.storage.put("count", Math.max(0, (await this.count()) - 1));
      this.log("a device was removed");
    }
    return reply(200, { ok: true });
  }

  /** How things stand, in numbers only. Open to anyone: it names no device. */
  async status() {
    const job = await this.storage.get("job");
    return reply(200, {
      ok: true,
      devices: await this.count(),
      sending: Boolean(job),
      last: (await this.storage.get("last")) || null,
      timer: (await this.storage.get("tick")) || null,
      unknownServices: (await this.storage.get("hosts")) || {},
      // Why messages were refused, if any were: the service, its answer, how often, when last, and its words.
      refusals: (await this.storage.get("refusals")) || {},
    });
  }

  async pageData(now) {
    const response = await this.fetch(`${this.settings.siteUrl}data.json?t=${now}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(`the page's data answered ${response.status}`);
    const data = await response.json();
    if (!data || typeof data !== "object") throw new Error("the page's data is not what was expected");
    return data;
  }

  /**
   * Called every few minutes through the day. Starts today's alert once: as
   * soon as the page's data shows that the check that goes with the alert has
   * run, or GRACE_MINUTES after the alert could first go out if no check has
   * run by then. The alert has one time from Monday to Friday and another on
   * Saturday and Sunday.
   */
  async tick() {
    const answer = await this.consider();
    // Kept for the status page: the last thing the timer did, and why.
    await this.storage.put("tick", { at: this.now(), did: answer.body.did, why: answer.body.why || "" });
    return answer;
  }

  async consider() {
    const now = this.now();
    const { until, zone } = this.settings;
    const local = localTime(now, zone);
    const from = alertFrom(this.settings, local.date);
    const nothing = (why) => reply(200, { ok: true, did: "nothing", why });

    const job = await this.storage.get("job");
    if (job && job.date === local.date) {
      // Still sending. If its wake-up call was lost, set a new one.
      if ((await this.storage.getAlarm()) === null) await this.storage.setAlarm(now);
      return nothing("today's alert is being sent");
    }
    if (job) await this.finish(job, now, "abandoned"); // left over from another day

    const day = await this.storage.get("day");
    if (day && day.date === local.date) return nothing("today's alert has gone out");
    if (local.minute < from) return nothing("too early");
    if (local.minute >= until) return nothing("too late");
    if (!(await this.count())) return nothing("no device to tell");

    let data;
    try {
      data = await this.pageData(now);
    } catch (error) {
      return nothing(`the page's data could not be read (${String(error && error.message).slice(0, 100)})`);
    }
    const fresh = isFresh(data, local, this.settings);
    if (!fresh && local.minute < from + GRACE_MINUTES) return nothing("waiting for the check before the alert");
    const notice = noticeFor(data, local, this.settings);
    if (!notice) return nothing("the page has no notice for today");

    const message = new TextDecoder().decode(messageFor(notice, this.settings, "daily"));
    await this.storage.put({
      day: { date: local.date, at: now },
      job: { date: local.date, message, fresh, cursor: FIRST, pass: 0, queue: [], again: [], working: [], sent: 0, gone: 0, refused: 0, failed: 0, startedAt: now },
    });
    await this.storage.setAlarm(now);
    this.log(`today's alert started (${fresh ? "after a fresh check" : "without a fresh check"})`);
    return reply(200, { ok: true, did: "started", fresh });
  }

  async finish(job, now, how = "finished") {
    // Count the book afresh, so that the number can never drift for long.
    let devices = 0;
    let after = FIRST;
    for (;;) {
      const page = await this.storage.list({ startAfter: after, end: AFTER_LAST, limit: 1000 });
      if (!page.size) break;
      devices += page.size;
      after = [...page.keys()].pop();
      if (page.size < 1000) break;
    }
    const failed = job.failed + job.queue.length + job.again.length;
    const last = { date: job.date, how, fresh: job.fresh, startedAt: job.startedAt, finishedAt: now, sent: job.sent, gone: job.gone, refused: job.refused, failed, devices };
    await this.storage.put({ last, count: devices });
    await this.storage.delete("job");
    this.log(`today's alert ${how}: ${job.sent} sent, ${job.gone} gone, ${job.refused} refused, ${failed} failed, ${devices} devices in the book`);
  }

  /** One round of sending. Cloudflare calls this when the wake-up time set by `tick` or by the last round comes. */
  async alarm() {
    const job = await this.storage.get("job");
    if (!job) return;
    const firstPass = job.pass === 0;

    let entries;
    if (firstPass) {
      entries = [...(await this.storage.list({ startAfter: job.cursor, end: AFTER_LAST, limit: BATCH }))];
    } else {
      // A later pass: the devices whose push service asked for patience.
      const names = job.queue.splice(0, BATCH);
      entries = names.length ? [...(await this.storage.get(names))] : [];
    }

    const results = entries.length ? await this.deliver(entries, encoder.encode(job.message), ALERT_TTL) : [];
    // The push services that have taken a message from us in this run.
    const working = new Set(job.working);
    for (const [, entry, result] of results) {
      if (result === "sent") working.add(serviceOf(entry));
    }
    job.working = [...working];

    const changed = {};
    const dropped = [];
    for (const [name, entry, result] of results) {
      if (result === "sent") {
        job.sent += 1;
        if (entry.fails) changed[name] = { ...entry, fails: 0 };
      } else if (result === "gone") {
        job.gone += 1;
        dropped.push(name);
      } else if (result === "refused") {
        job.refused += 1;
        const fails = (entry.fails || 0) + 1;
        // Dropped only while its push service takes messages for others. If a
        // service refuses everything, the fault is more likely ours, and the
        // book must not empty itself because of it.
        if (fails >= GIVE_UP_AFTER && working.has(serviceOf(entry))) dropped.push(name);
        else changed[name] = { ...entry, fails: Math.min(fails, GIVE_UP_AFTER) };
      } else if (job.pass < RETRY_AFTER_MS.length && job.again.length < MOST_RETRIES) {
        job.again.push(name);
      } else {
        job.failed += 1;
      }
    }
    if (dropped.length) {
      const removed = await this.storage.delete(dropped);
      if (removed) await this.storage.put("count", Math.max(0, (await this.count()) - removed));
    }
    if (Object.keys(changed).length) await this.storage.put(changed);

    let passDone;
    if (firstPass) {
      if (entries.length) job.cursor = entries[entries.length - 1][0];
      passDone = entries.length < BATCH;
    } else {
      passDone = job.queue.length === 0;
    }

    // The time is read again here: the sending above took a while, and the
    // pause is meant to come after it.
    if (!passDone) {
      await this.storage.put("job", job);
      await this.storage.setAlarm(this.now() + PAUSE_MS);
    } else if (job.again.length && job.pass < RETRY_AFTER_MS.length) {
      const wait = RETRY_AFTER_MS[job.pass];
      job.pass += 1;
      job.queue = job.again;
      job.again = [];
      await this.storage.put("job", job);
      await this.storage.setAlarm(this.now() + wait);
    } else {
      await this.finish(job, this.now());
    }
  }
}
