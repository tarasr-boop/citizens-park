// The counter behind the stats page: visits to the page, how many different
// devices they came from, how often those devices come back, what kind of
// devices they are, roughly where they are, how they found the page, how long
// they stay, and which buttons and links they press.
//
// Nothing here can tell one person from another. The page sends only what
// happened ("a visit, this device's 3rd, 2 days after its last one", or "the
// Telegram button was pressed"), never a name or a number for the device. A
// device knows those things only because it remembers, in its own browser,
// the date of its last visit and how many visits it has made. No cookies.
//
// The backend adds what it can see of the request itself: the kind of browser
// (from the browser's own description of itself), and the rough place and the
// network it came from (Cloudflare works these out from the address). The
// address itself is never kept. Each of these is counted on its own, as a
// total for the day, so the counts cannot be put back together into a
// description of one visitor.
//
// Visits that look automated (a program that says so, or a request from a
// data centre rather than a home or a phone network) and visits from the
// owner's own devices are counted apart, so that the main numbers are people.
//
// Every day is kept for good, one entry per day, so any month can be looked
// at later. A year is about 365 small entries.
//
// Like book.js, this file knows nothing about Cloudflare. It is given a place
// to keep things and a clock, so the tests can stand in for both.

import { localTime } from "./rules.js";

// Days are filed under "day:" plus the date at the park, such as "day:2026-11-21".
const DAY = "day:";
// The largest request the page sends for the stats. What it sends is well under 300 bytes.
export const MOST_HIT_BYTES = 512;
// At most this many things are counted in one day. Real visitors send a few
// hundred. The limit only matters if somebody sends made-up visits by the
// thousand: they cannot run the free plan out of requests for the alerts.
export const MOST_A_DAY = 20000;
// At most this many different names in one list for one day (buttons, places,
// networks and so on). Any more go under "other".
export const MOST_NAMES = 60;
// What a button's or link's name may look like: "buttons:t.me", "share:copy".
const NAME = /^[a-z0-9][a-z0-9.:_-]{0,63}$/;

// The lists kept for each day, each a count by name.
export const LISTS = [
  "presses", // buttons and links pressed
  "hours", // visits by the hour they began, "07" for 7 to 8 AM
  "hoursBack", // the same, for visits from devices that had been here before
  "since", // visits from returning devices, by how long since their last visit
  "nth", // visits by how many visits the device has made, this one included
  "kinds", // devices by kind: phone, tablet, computer
  "systems", // devices by system: iPhone, Android, Mac, Windows...
  "browsers", // devices by browser: Safari, Chrome, Instagram's own...
  "places", // devices by rough place: "Richmond, Victoria"
  "networks", // devices by network: "Telstra Limited"
  "sources", // visits by how they found the page: QR code, Telegram, a search...
  "stays", // looks at the page by how long they lasted
  "robotNets", // automated visits by network
  "robotWhy", // automated visits by why they look automated
];

function reply(status, body) {
  return { status, body };
}

function emptyDay() {
  const day = { visits: 0, devices: 0, monthly: 0, fresh: 0, returning: 0, robots: 0, mine: 0, counted: 0 };
  for (const list of LISTS) day[list] = {};
  return day;
}

function plainText(value, most) {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, most) : "";
}

function whole(value, low, high) {
  return Number.isInteger(value) && value >= low && value <= high ? value : null;
}

/**
 * What the page sent, checked. Returns one of
 * `{ kind: "visit", newToday, newThisMonth, firstEver, since, nth, source, again, touch }`,
 * `{ kind: "press", name }` or `{ kind: "stay", seconds }`, or null.
 */
export function readHit(given) {
  if (!given || typeof given !== "object") return null;
  if (given.kind === "visit") {
    return {
      kind: "visit",
      newToday: given.newToday === true,
      newThisMonth: given.newThisMonth === true,
      firstEver: given.firstEver === true,
      // Days since this device's last visit, or null for a first visit (or a page that does not say).
      since: whole(given.since, 0, 36500),
      // This device's visits so far, this one included.
      nth: whole(given.nth, 1, 1000000),
      // Where the visitor came from: the name of the site, or "qr", or "" for nowhere.
      source: plainText(given.source, 100).toLowerCase(),
      // Looked at again in a tab that was open already.
      again: given.again === true,
      touch: given.touch === true,
      mine: given.mine === true,
    };
  }
  if (given.kind === "press" && typeof given.name === "string" && NAME.test(given.name)) {
    return { kind: "press", name: given.name };
  }
  if (given.kind === "stay" && typeof given.seconds === "number" && given.seconds >= 0 && given.seconds <= 86400) {
    return { kind: "stay", seconds: given.seconds };
  }
  return null;
}

/** "2026-11" if it is a month written that way, otherwise null. */
export function readMonth(text) {
  const found = /^(\d{4})-(\d\d)$/.exec(String(text || ""));
  if (!found || Number(found[2]) < 1 || Number(found[2]) > 12) return null;
  return found[0];
}

/** "2026-11-21" if it is a real day written that way, otherwise null. */
export function readDay(text) {
  const found = /^(\d{4})-(\d\d)-(\d\d)$/.exec(String(text || ""));
  if (!found) return null;
  const date = new Date(Date.UTC(Number(found[1]), Number(found[2]) - 1, Number(found[3])));
  return date.toISOString().slice(0, 10) === found[0] ? found[0] : null;
}

// Programs that say what they are. Real browsers never say these words.
const ROBOT_WORDS = /bot\b|bot\/|crawl|spider|slurp|headless|lighthouse|pagespeed|preview|scanner|python|curl|wget|go-http|okhttp|axios|node-fetch|undici|phantom|puppeteer|playwright|selenium|httpclient|java\//i;

/**
 * What a browser's own description of itself (its User-Agent) says about it:
 * `{ kind, system, browser, robot }`. `touch` is what the page found: a Mac
 * with a touch screen is an iPad, which describes itself as a Mac.
 */
export function describeAgent(agent, touch = false) {
  const text = String(agent || "");
  if (!text || ROBOT_WORDS.test(text)) return { kind: "program", system: "program", browser: "program", robot: true };

  let system = "other";
  if (/iPhone|iPod/.test(text)) system = "iPhone";
  else if (/iPad/.test(text)) system = "iPad";
  else if (/Android/.test(text)) system = "Android";
  else if (/Macintosh|Mac OS X/.test(text)) system = touch ? "iPad" : "Mac";
  else if (/Windows/.test(text)) system = "Windows";
  else if (/CrOS/.test(text)) system = "ChromeOS";
  else if (/Linux/.test(text)) system = "Linux";

  let kind = "computer";
  if (system === "iPhone" || (system === "Android" && /Mobile/.test(text))) kind = "phone";
  else if (system === "iPad" || system === "Android") kind = "tablet";
  else if (system === "other") kind = "other";

  // The apps that open links in a browser of their own come first, as they also name the browser underneath.
  let browser = "other";
  if (/Instagram/.test(text)) browser = "Instagram app";
  else if (/FBAN|FBAV|FB_IAB|FBIOS/.test(text)) browser = "Facebook app";
  else if (/Telegram/i.test(text)) browser = "Telegram app";
  else if (/WhatsApp/i.test(text)) browser = "WhatsApp app";
  else if (/Line\//.test(text)) browser = "LINE app";
  else if (/GSA\//.test(text)) browser = "Google app";
  else if (/SamsungBrowser/.test(text)) browser = "Samsung Internet";
  else if (/EdgA|EdgiOS|Edg\//.test(text)) browser = "Edge";
  else if (/OPR\/|Opera/.test(text)) browser = "Opera";
  else if (/Firefox|FxiOS/.test(text)) browser = "Firefox";
  else if (/DuckDuckGo/.test(text)) browser = "DuckDuckGo";
  else if (/; wv\)/.test(text)) browser = "an app's own browser";
  else if (/CriOS|Chrome\//.test(text)) browser = "Chrome";
  else if (/Safari\//.test(text)) browser = system === "iPhone" || system === "iPad" ? "Safari (or an app's browser)" : "Safari";
  return { kind, system, browser, robot: false };
}

// Networks that belong to data centres. A visit from one comes from a server,
// not from a home or a phone: a program, a link checker, or now and then a VPN.
// Apple's iCloud Private Relay goes out through Akamai, Cloudflare and Fastly,
// so those are not on this list: they carry real people.
const DATA_CENTRES = /amazon|aws|google llc|google cloud|microsoft|azure|digitalocean|ovh|hetzner|linode|oracle|alibaba|tencent|huawei cloud|contabo|vultr|choopa|scaleway|m247|datacamp|leaseweb|hostinger|ionos|zscaler|censys|shodan|internet measurement|clouvider|g-core|gcore|psychz|quadranet|colocrossing|servers\.com|hostpapa|godaddy|rackspace|equinix|tzulo|cdn77|hivelocity|fdcservers|sharktech|frantech|buyvm|stark industries|aeza|pfcloud|ipxo|bluehost|netcup|kamatera|upcloud|latitude\.sh|packet host|cherry servers|interserver|wholesale internet|nocix/i;

const REGIONS = { VIC: "Victoria", NSW: "New South Wales", QLD: "Queensland", SA: "South Australia", WA: "Western Australia", TAS: "Tasmania", ACT: "Canberra", NT: "Northern Territory" };

/**
 * What Cloudflare worked out about where a request came from: `{ place, network, dataCentre }`.
 * `seen` holds Cloudflare's own fields: city, region, regionCode, country, asOrganization.
 */
export function describePlace(seen) {
  const city = plainText(seen && seen.city, 40);
  const country = plainText(seen && seen.country, 2).toUpperCase();
  let area;
  if (country === "AU") area = REGIONS[plainText(seen && seen.regionCode, 3).toUpperCase()] || plainText(seen && seen.region, 40) || "Australia";
  else area = country || "";
  const place = [city, area].filter(Boolean).join(", ") || "unknown";
  const network = plainText(seen && seen.asOrganization, 60) || "unknown";
  return { place, network, dataCentre: DATA_CENTRES.test(network) };
}

/** How a visitor found the page, from what the page sent: "QR code", "Telegram", "Google search"... */
export function sourceOf(source, siteHost = "") {
  const host = String(source || "").replace(/^www\./, "");
  if (!host) return "no link (typed, a bookmark or an app)";
  if (host === "qr") return "QR code";
  if (host === "again") return "back to a tab left open";
  if (siteHost && host === siteHost.replace(/^www\./, "")) return "this page";
  if (/telegram|^t\.me$/.test(host)) return "Telegram";
  if (/instagram/.test(host)) return "Instagram";
  if (/facebook|^fb\.|messenger/.test(host)) return "Facebook";
  if (/whatsapp/.test(host)) return "WhatsApp";
  if (/(^|\.)google\.|googlequicksearchbox|android\.gm$/.test(host)) return /android\.gm$/.test(host) ? "Gmail" : "Google";
  if (/(^|\.)bing\.com$/.test(host)) return "Bing";
  if (/duckduckgo/.test(host)) return "DuckDuckGo";
  if (/yarracity/.test(host)) return "the council's site";
  if (/github/.test(host)) return "GitHub";
  return /^[a-z0-9.-]{1,60}$/.test(host) ? host : "other";
}

function sinceText(days) {
  if (days === 0) return "same day";
  if (days === 1) return "next day";
  if (days <= 7) return "2 to 7 days";
  if (days <= 30) return "8 to 30 days";
  return "over 30 days";
}

function nthText(nth) {
  if (nth === 1) return "1st";
  if (nth === 2) return "2nd";
  if (nth <= 5) return "3rd to 5th";
  if (nth <= 10) return "6th to 10th";
  return "11th or later";
}

function stayText(seconds) {
  if (seconds < 5) return "under 5 seconds";
  if (seconds < 30) return "5 to 30 seconds";
  if (seconds < 120) return "30 seconds to 2 minutes";
  if (seconds < 600) return "2 to 10 minutes";
  return "over 10 minutes";
}

/** Add one to `name` in `list`, keeping at most MOST_NAMES names. */
function bump(list, name) {
  const key = Object.hasOwn(list, name) || Object.keys(list).length < MOST_NAMES ? name : "other";
  list[key] = (list[key] || 0) + 1;
}

/** Adds the numbers of one day to a running total (for a month, a day, or all time). */
function add(total, day) {
  total.visits += day.visits || 0;
  total.devices += day.monthly || 0;
  total.fresh += day.fresh || 0;
  total.returning += day.returning || 0;
  total.robots += day.robots || 0;
  total.mine += day.mine || 0;
  for (const list of LISTS) {
    for (const [name, count] of Object.entries(day[list] || {})) total[list][name] = (total[list][name] || 0) + count;
  }
  total.pressed += Object.values(day.presses || {}).reduce((sum, count) => sum + count, 0);
  return total;
}

function emptyTotal() {
  const total = { visits: 0, devices: 0, fresh: 0, returning: 0, robots: 0, mine: 0, pressed: 0 };
  for (const list of LISTS) total[list] = {};
  return total;
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
    return localTime(this.now(), this.settings.zone);
  }

  /**
   * Counts one thing the page sent. `seen` is what the backend saw of the
   * request: `agent` (the User-Agent) and Cloudflare's place fields. The
   * answer is the same whether or not it was counted.
   */
  async hit(given, seen = {}) {
    const hit = readHit(given);
    if (!hit) return reply(400, { ok: false, reason: "bad" });
    const local = this.today();
    const date = local.date;
    if (this.fullOn === date) return reply(200, { ok: true });
    const key = DAY + date;
    const stored = (await this.storage.get(key)) || {};
    const day = { ...emptyDay(), ...stored };
    for (const list of LISTS) day[list] = { ...(stored[list] || {}) };
    if (day.counted >= MOST_A_DAY) {
      this.fullOn = date;
      return reply(200, { ok: true });
    }
    day.counted += 1;

    const agent = describeAgent(seen.agent, hit.kind === "visit" && hit.touch);
    const where = describePlace(seen);
    const robot = agent.robot || where.dataCentre;

    if (hit.kind === "visit") {
      if (hit.mine) {
        day.mine += 1;
      } else if (robot) {
        day.robots += 1;
        bump(day.robotNets, where.network);
        bump(day.robotWhy, agent.robot ? "says it is a program" : "comes from a data centre");
      } else {
        const back = !hit.firstEver && hit.since !== null;
        day.visits += 1;
        if (hit.newToday) day.devices += 1;
        // A device new this month is new today too, whatever it said.
        if (hit.newThisMonth || hit.firstEver) day.monthly += 1;
        if (hit.firstEver) day.fresh += 1;
        if (hit.newToday && back) day.returning += 1;
        const hour = String(Math.floor(local.minute / 60)).padStart(2, "0");
        bump(day.hours, hour);
        if (back) {
          bump(day.hoursBack, hour);
          // A look again in a tab left open is not a return.
          if (!hit.again) bump(day.since, sinceText(hit.since));
        }
        if (hit.nth !== null && !hit.again) bump(day.nth, nthText(hit.nth));
        bump(day.sources, sourceOf(hit.again ? "again" : hit.source, new URL(this.settings.siteUrl).hostname));
        // What kind of device, and where: once a day for each device.
        if (hit.newToday) {
          bump(day.kinds, agent.kind);
          bump(day.systems, agent.system);
          bump(day.browsers, agent.browser);
          bump(day.places, where.place);
          bump(day.networks, where.network);
        }
      }
    } else if (!robot) {
      if (hit.kind === "press") bump(day.presses, hit.name);
      else bump(day.stays, stayText(hit.seconds));
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
   * What the stats page shows: for `month` ("2026-11"; this month if not
   * given) each day of it so far, or for one `day` ("2026-11-21") that day
   * alone, with the totals and lists for the month or the day, and the totals
   * of every month kept.
   */
  async report(month, day) {
    const today = this.today().date;
    const thisMonth = today.slice(0, 7);
    const chosenDay = readDay(day) && readDay(day) <= today ? readDay(day) : null;
    const chosen = chosenDay ? chosenDay.slice(0, 7) : readMonth(month) || thisMonth;
    const all = await this.allDays();

    const months = new Map();
    const total = emptyTotal();
    for (const [date, its] of all) {
      const which = date.slice(0, 7);
      if (!months.has(which)) months.set(which, emptyTotal());
      add(months.get(which), its);
      add(total, its);
    }

    // Every day of the chosen month up to today, the quiet ones too, newest first.
    const kept = new Map(all.filter(([date]) => date.startsWith(chosen + "-")));
    const days = [];
    const [year, monthNumber] = chosen.split("-").map(Number);
    const length = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
    for (let number = 1; number <= length; number += 1) {
      const date = `${chosen}-${String(number).padStart(2, "0")}`;
      if (date > today) break;
      const its = kept.get(date) || emptyDay();
      days.unshift({
        date,
        visits: its.visits,
        devices: its.devices,
        fresh: its.fresh,
        returning: its.returning || 0,
        robots: its.robots || 0,
        pressed: Object.values(its.presses || {}).reduce((sum, count) => sum + count, 0),
      });
    }

    let totals = months.get(chosen) || emptyTotal();
    if (chosenDay) {
      totals = add(emptyTotal(), kept.get(chosenDay) || emptyDay());
      // On a single day, the devices are that day's devices.
      totals.devices = (kept.get(chosenDay) || emptyDay()).devices;
    }

    return {
      today,
      month: chosen,
      day: chosenDay,
      thisMonth,
      first: all.length ? all[0][0].slice(0, 7) : thisMonth,
      days,
      totals,
      months: [...months.entries()].reverse().map(([which, numbers]) => ({ month: which, ...numbers })),
      total,
    };
  }
}
