// The counter behind the stats page: visits to the page, how many different
// devices they came from, and presses of its buttons and links.
//
// Nothing here can tell one person from another. The page sends only what
// happened ("a visit, the first from this device today", or "the Telegram
// button was pressed"), never an address, a name or a number for the device.
// A device knows that it is new today only because it remembers the date of
// its last visit in its own browser. No cookies are used.
//
// Every day is kept for good, one entry per day, so any month can be looked
// at later. A year is about 365 small entries.
//
// Like book.js, this file knows nothing about Cloudflare. It is given a place
// to keep things and a clock, so the tests can stand in for both.

import { localTime } from "./rules.js";

// Days are filed under "day:" plus the date at the park, such as "day:2026-11-21".
const DAY = "day:";
// The largest request the page sends for the stats. What it sends is well under 200 bytes.
export const MOST_HIT_BYTES = 512;
// At most this many things are counted in one day. Real visitors send a few
// hundred. The limit only matters if somebody sends made-up visits by the
// thousand: they cannot run the free plan out of requests for the alerts.
export const MOST_A_DAY = 20000;
// At most this many different names of buttons and links in one day. Any more go under "other".
export const MOST_NAMES = 60;
// What a button's or link's name may look like: "buttons:t.me", "share:copy".
const NAME = /^[a-z0-9][a-z0-9.:_-]{0,63}$/;

function reply(status, body) {
  return { status, body };
}

function emptyDay() {
  return { visits: 0, devices: 0, monthly: 0, fresh: 0, presses: {}, counted: 0 };
}

/**
 * What the page sent, checked. Returns `{ kind: "visit", newToday, newThisMonth, firstEver }`
 * or `{ kind: "press", name }`, or null if it is neither.
 */
export function readHit(given) {
  if (!given || typeof given !== "object") return null;
  if (given.kind === "visit") {
    return { kind: "visit", newToday: given.newToday === true, newThisMonth: given.newThisMonth === true, firstEver: given.firstEver === true };
  }
  if (given.kind === "press" && typeof given.name === "string" && NAME.test(given.name)) {
    return { kind: "press", name: given.name };
  }
  return null;
}

/** "2026-11" if it is a month written that way, otherwise null. */
export function readMonth(text) {
  const found = /^(\d{4})-(\d\d)$/.exec(String(text || ""));
  if (!found || Number(found[2]) < 1 || Number(found[2]) > 12) return null;
  return found[0];
}

/** Adds the numbers of one day to a running total (for a month, or for all time). */
function add(total, day) {
  total.visits += day.visits || 0;
  total.devices += day.monthly || 0;
  total.fresh += day.fresh || 0;
  for (const [name, count] of Object.entries(day.presses || {})) {
    total.presses[name] = (total.presses[name] || 0) + count;
    total.pressed += count;
  }
  return total;
}

function emptyTotal() {
  return { visits: 0, devices: 0, fresh: 0, pressed: 0, presses: {} };
}

export class Counter {
  /** `storage` is a Durable Object's storage, `now` gives the time in milliseconds, `settings` comes from `settingsFrom`. */
  constructor({ storage, now, settings }) {
    this.storage = storage;
    this.now = now;
    this.settings = settings;
    // The day that reached MOST_A_DAY, so that nothing more is written for it.
    this.fullOn = "";
  }

  today() {
    return localTime(this.now(), this.settings.zone).date;
  }

  /** Counts one thing the page sent. The answer is the same whether or not it was counted. */
  async hit(given) {
    const hit = readHit(given);
    if (!hit) return reply(400, { ok: false, reason: "bad" });
    const date = this.today();
    if (this.fullOn === date) return reply(200, { ok: true });
    const key = DAY + date;
    const day = { ...emptyDay(), ...((await this.storage.get(key)) || {}) };
    if (day.counted >= MOST_A_DAY) {
      this.fullOn = date;
      return reply(200, { ok: true });
    }
    day.counted += 1;
    if (hit.kind === "visit") {
      day.visits += 1;
      if (hit.newToday) day.devices += 1;
      // A device new this month is new today too, whatever it said.
      if (hit.newThisMonth || hit.firstEver) day.monthly += 1;
      if (hit.firstEver) day.fresh += 1;
    } else {
      const known = Object.hasOwn(day.presses, hit.name);
      const name = known || Object.keys(day.presses).length < MOST_NAMES ? hit.name : "other";
      day.presses[name] = (day.presses[name] || 0) + 1;
    }
    await this.storage.put(key, day);
    return reply(200, { ok: true });
  }

  /** Every day kept, as pairs of date and numbers, oldest first. */
  async allDays() {
    const days = [];
    let after = DAY;
    for (;;) {
      const page = await this.storage.list({ startAfter: after, end: "day;", limit: 1000 });
      for (const [key, day] of page) days.push([key.slice(DAY.length), { ...emptyDay(), ...day }]);
      if (page.size < 1000) break;
      after = [...page.keys()].pop();
    }
    return days;
  }

  /**
   * What the stats page shows for `month` ("2026-11"; this month if not given):
   * each day of it so far, its totals, and the totals of every month kept.
   */
  async report(month) {
    const today = this.today();
    const thisMonth = today.slice(0, 7);
    const chosen = readMonth(month) || thisMonth;
    const all = await this.allDays();

    const months = new Map();
    const total = emptyTotal();
    for (const [date, day] of all) {
      const its = date.slice(0, 7);
      if (!months.has(its)) months.set(its, emptyTotal());
      add(months.get(its), day);
      add(total, day);
    }

    // Every day of the chosen month up to today, the quiet ones too, newest first.
    const kept = new Map(all.filter(([date]) => date.startsWith(chosen + "-")));
    const days = [];
    const [year, monthNumber] = chosen.split("-").map(Number);
    const length = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
    for (let number = 1; number <= length; number += 1) {
      const date = `${chosen}-${String(number).padStart(2, "0")}`;
      if (date > today) break;
      const day = kept.get(date) || emptyDay();
      days.unshift({ date, visits: day.visits, devices: day.devices, pressed: Object.values(day.presses).reduce((sum, count) => sum + count, 0) });
    }

    return {
      today,
      month: chosen,
      thisMonth,
      first: all.length ? all[0][0].slice(0, 7) : thisMonth,
      days,
      totals: months.get(chosen) || emptyTotal(),
      months: [...months.entries()].reverse().map(([its, numbers]) => ({ month: its, ...numbers })),
      total,
    };
  }
}
