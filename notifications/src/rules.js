// The small decisions of the alerts backend, kept apart from storage and the
// network so that each can be tried on its own: what time it is at the park,
// whether an address really belongs to a browser's notification service,
// what an alert says, and which check on GitHub the second timer looks after.

import { fromBase64Url, toBase64Url } from "./webpush.js";

const encoder = new TextEncoder();

// The largest request this backend reads. What a browser hands over is well under 1,000 bytes.
export const MOST_BYTES = 4096;

// If no check of the council's page has run by this long after the alert time,
// the alert goes out anyway, with the notice the page already has for today.
export const GRACE_MINUTES = 45;

// The notification services of the browsers people use: Chrome and most
// Android browsers, Firefox, Safari on iPhone and Mac, and Edge on Windows.
// A message is only ever sent to one of these, so the backend cannot be made
// to write to an address somebody made up.
const PUSH_HOSTS = new Set(["fcm.googleapis.com", "jmt17.google.com", "updates.push.services.mozilla.com", "web.push.apple.com"]);
const PUSH_HOST_ENDINGS = [".push.apple.com", ".notify.windows.com", ".push.services.mozilla.com"];

/** A request that is turned down: `status` for the reply, `reason` for the page, and for an unknown service its `host`. */
export class Refusal extends Error {
  constructor(status, reason, host = "") {
    super(reason);
    this.status = status;
    this.reason = reason;
    this.host = host;
  }
}

function minutes(text, what) {
  const found = /^(\d{1,2}):(\d\d)$/.exec(String(text).trim());
  if (!found || Number(found[1]) > 23 || Number(found[2]) > 59) throw new Error(`${what} should look like 14:30, got ${text}`);
  return Number(found[1]) * 60 + Number(found[2]);
}

/** The settings from wrangler.jsonc, checked. Throws with a plain reason if one makes no sense. */
export function settingsFrom(env) {
  let site;
  try {
    site = new URL(String(env.SITE_URL));
  } catch {
    throw new Error("SITE_URL should be the page's address, such as https://example.org/park/");
  }
  if (site.protocol !== "https:") throw new Error("SITE_URL should start with https://");
  const zone = String(env.TIMEZONE || "");
  try {
    new Intl.DateTimeFormat("en-AU", { timeZone: zone });
  } catch {
    throw new Error(`TIMEZONE ${zone} is not a known time zone`);
  }
  const settings = {
    siteUrl: site.href.endsWith("/") ? site.href : site.href + "/",
    origin: site.origin,
    zone,
    from: minutes(env.ALERT_FROM, "ALERT_FROM"),
    until: minutes(env.ALERT_UNTIL, "ALERT_UNTIL"),
    check: checkFrom(env),
  };
  if (settings.from >= settings.until) throw new Error("ALERT_FROM should be earlier than ALERT_UNTIL");
  return settings;
}

/**
 * The check on GitHub that the second timer looks after (see starter.js), as
 * `{ repository, workflow, branch, times }`, with the times as minutes of the
 * day. Null while CHECK_TIMES is empty, which switches the second timer off.
 */
function checkFrom(env) {
  const written = String(env.CHECK_TIMES || "").trim();
  if (!written) return null;
  const times = written.split(/\s+/).map((one) => minutes(one, "Each time in CHECK_TIMES"));
  if (times.length > 24) throw new Error("CHECK_TIMES should name at most 24 times");
  if (times.some((time, index) => index && time <= times[index - 1])) throw new Error("CHECK_TIMES should go from the earliest time to the latest, each time once");
  // These three become part of an address at GitHub, so only plain names are taken.
  const repository = String(env.CHECK_REPOSITORY || "");
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$/.test(repository)) {
    throw new Error("CHECK_REPOSITORY should look like owner/name");
  }
  const workflow = String(env.CHECK_WORKFLOW || "");
  if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}\.ya?ml$/.test(workflow)) throw new Error("CHECK_WORKFLOW should be a file name such as daily.yml");
  const branch = String(env.CHECK_BRANCH || "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(branch) || branch.includes("..") || branch.includes("//")) {
    throw new Error("CHECK_BRANCH should be a branch name such as main");
  }
  return { repository, workflow, branch, times };
}

/** The date and the minute of the day at the park: `{ date: "2026-11-20", minute: 885 }`. */
export function localTime(ms, zone) {
  const parts = {};
  const format = new Intl.DateTimeFormat("en-AU", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  for (const part of format.formatToParts(new Date(ms))) parts[part.type] = part.value;
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minute: (Number(parts.hour) % 24) * 60 + Number(parts.minute) };
}

/** "3 PM", "2:30 PM", "midnight". */
export function clockText(minute) {
  if (minute % 1440 === 0) return "midnight";
  const hour = Math.floor(minute / 60) % 24;
  const past = minute % 60;
  return `${hour % 12 || 12}${past ? ":" + String(past).padStart(2, "0") : ""} ${hour < 12 ? "AM" : "PM"}`;
}

/** The hour people are told to expect the alert: "3 PM" when it goes out from 2:30 PM. */
export function alertHour(settings) {
  return clockText(Math.floor((settings.from + 30) / 60) * 60);
}

function knownPushService(host) {
  return PUSH_HOSTS.has(host) || PUSH_HOST_ENDINGS.some((ending) => host.endsWith(ending));
}

/**
 * Check what a browser handed over: an address at a known notification
 * service, and the two keys for writing to it. Returns them tidied, as
 * `{ endpoint, p256dh, auth }`. Throws a Refusal otherwise.
 */
export function checkSubscription(given) {
  if (!given || typeof given !== "object" || typeof given.endpoint !== "string" || given.endpoint.length > 2000) {
    throw new Refusal(400, "bad");
  }
  const keys = given.keys;
  if (!keys || typeof keys !== "object") throw new Refusal(400, "bad");
  let address;
  try {
    address = new URL(given.endpoint);
  } catch {
    throw new Refusal(400, "bad");
  }
  if (address.protocol !== "https:" || address.username || address.password || address.port) throw new Refusal(400, "bad");
  if (!knownPushService(address.hostname)) throw new Refusal(400, "host", address.hostname);
  let p256dh;
  let auth;
  try {
    p256dh = fromBase64Url(keys.p256dh);
    auth = fromBase64Url(keys.auth);
  } catch {
    throw new Refusal(400, "bad");
  }
  // A public key on the P-256 curve, written out in full, and a secret of 16 bytes.
  if (p256dh.length !== 65 || p256dh[0] !== 4 || auth.length !== 16) throw new Refusal(400, "bad");
  return { endpoint: address.href, p256dh: toBase64Url(p256dh), auth: toBase64Url(auth) };
}

/** An address as it is filed, so that the same address always finds the same entry. Throws a Refusal if it is not one. */
export function tidyEndpoint(endpoint) {
  if (typeof endpoint !== "string" || endpoint.length > 2000) throw new Refusal(400, "bad");
  try {
    return new URL(endpoint).href;
  } catch {
    throw new Refusal(400, "bad");
  }
}

function cut(text, most) {
  const letters = Array.from(String(text));
  return letters.length > most ? letters.slice(0, most - 1).join("") + "…" : letters.join("");
}

/**
 * Was the page's data made today, at or after the alert time? Then the day's
 * check has run, and what it found is as fresh as it gets.
 */
export function isFresh(data, local, settings) {
  const made = Date.parse(data && data.generated);
  if (Number.isNaN(made)) return false;
  const when = localTime(made, settings.zone);
  return when.date === local.date && when.minute >= settings.from;
}

/**
 * Today's notice from the page's data, as `{ title, body }`, or null if the
 * data has none for today. If the data was not made today, the notice says so.
 */
export function noticeFor(data, local, settings) {
  const days = data && Array.isArray(data.days) ? data.days : [];
  const today = days.find((day) => day && day.date === local.date && day.notice && typeof day.notice.title === "string" && day.notice.title.trim());
  if (!today) return null;
  let body = typeof today.notice.body === "string" ? today.notice.body : "";
  const made = Date.parse(data.generated);
  const madeToday = !Number.isNaN(made) && localTime(made, settings.zone).date === local.date;
  if (!madeToday) {
    const since = typeof data.generatedText === "string" && data.generatedText ? ` since ${cut(data.generatedText, 40)}` : " today";
    body += `${body ? "\n" : ""}⚠️ The page has not been updated${since}, so this may be out of date.`;
  }
  return { title: cut(today.notice.title.trim(), 120), body: cut(body, 600) };
}

/**
 * The bytes of one notification. The shape is the one newer iPhones show by
 * themselves ("declarative web push"). Every other browser hands the same
 * words to the page's own script, sw.js, which shows them.
 */
export function messageFor(notice, settings, tag) {
  return encoder.encode(
    JSON.stringify({
      web_push: 8030,
      notification: {
        title: notice.title,
        body: notice.body,
        // Where a tap on the notification leads.
        navigate: settings.siteUrl,
        // One notification at a time: a new one takes the place of the last, and still makes itself heard.
        tag,
        renotify: true,
        lang: "en-AU",
        icon: settings.siteUrl + "icon-192.png",
        badge: settings.siteUrl + "badge.png",
      },
    })
  );
}

/** The first notification a device gets, straight after its alerts are turned on. */
export function welcome(settings) {
  return {
    title: "Alerts are on",
    body: `You'll get one notification a day, at about ${alertHour(settings)}, saying when the oval is booked.`,
  };
}

/** The headers that let the page, and only the page, talk to this backend from a browser. */
export function corsHeaders(origin, settings) {
  const headers = { Vary: "Origin" };
  if (origin && origin === settings.origin) {
    headers["Access-Control-Allow-Origin"] = settings.origin;
    headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
    headers["Access-Control-Allow-Headers"] = "Content-Type";
    headers["Access-Control-Max-Age"] = "86400";
  }
  return headers;
}
