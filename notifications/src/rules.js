// The small decisions of the alerts backend, kept apart from storage and the
// network so that each can be tried on its own: what time it is at the park,
// which check on GitHub the second timer looks after, and the Telegram bot's
// settings.

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
  return {
    siteUrl: site.href.endsWith("/") ? site.href : site.href + "/",
    origin: site.origin,
    zone,
    check: checkFrom(env),
    bot: botFrom(env),
  };
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

/** A time on the hour, such as "16:00", as the hour: 16. */
function hourOf(text, what) {
  const minute = minutes(text, what);
  if (minute % 60) throw new Error(`${what} should be a time on the hour, such as 16:00, got ${text}`);
  return minute / 60;
}

/**
 * The Telegram bot's settings (see bot.js), as `{ address, park, link,
 * linkText, first, last, evening, weekday, weekend }`, with the times as hours of the day: people
 * pick an hour from `first` to `last`, a new chat starts with `weekday` and
 * `weekend`, and an alert at `evening` or later is about the next day.
 * `address` is where Telegram brings what people write to the bot, and `park`
 * the name the bot uses for the park. Null while
 * BOT_FIRST is not set, which leaves the bot out.
 */
function botFrom(env) {
  if (env.BOT_FIRST === undefined) return null;
  let address;
  try {
    address = new URL("/telegram", String(env.BACKEND_URL));
  } catch {
    throw new Error("BACKEND_URL should be this backend's own address, such as https://alerts.example.org");
  }
  if (address.protocol !== "https:") throw new Error("BACKEND_URL should start with https://");
  const bot = {
    address: address.href,
    park: String(env.PARK_NAME || "").trim() || "park",
    link: "",
    linkText: String(env.BOT_LINK_TEXT || "").trim(),
    first: hourOf(env.BOT_FIRST, "BOT_FIRST"),
    last: hourOf(env.BOT_LAST, "BOT_LAST"),
    evening: hourOf(env.BOT_EVENING, "BOT_EVENING"),
    weekday: hourOf(env.BOT_WEEKDAY, "BOT_WEEKDAY"),
    weekend: hourOf(env.BOT_WEEKEND, "BOT_WEEKEND"),
  };
  // A button under a person's times that leads elsewhere, such as a consultation with Sofia. Left out while BOT_LINK is empty.
  const link = String(env.BOT_LINK || "").trim();
  if (link) {
    let to;
    try {
      to = new URL(link);
    } catch {
      throw new Error("BOT_LINK should be an address, such as https://example.org/");
    }
    if (to.protocol !== "https:") throw new Error("BOT_LINK should start with https://");
    if (!bot.linkText) throw new Error("BOT_LINK_TEXT should say what the BOT_LINK button leads to");
    bot.link = to.href;
  }
  if (!(bot.first <= Math.min(bot.weekday, bot.weekend) && Math.max(bot.weekday, bot.weekend) <= bot.last)) {
    throw new Error("BOT_WEEKDAY and BOT_WEEKEND should lie between BOT_FIRST and BOT_LAST");
  }
  if (!(bot.first < bot.evening && bot.evening <= bot.last + 1)) throw new Error("BOT_EVENING should be later than BOT_FIRST, and at most an hour after BOT_LAST");
  return bot;
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

/** Bytes as base64url text without padding, the form web addresses take. */
export function toBase64Url(bytes) {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
