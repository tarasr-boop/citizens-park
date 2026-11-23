// The second timer: it starts the daily check on GitHub when GitHub's own
// timer has not.
//
// GitHub is asked to run the check at set times of the day. Its timer is often
// late, sometimes by hours, and in a new repository it may not fire at all. So
// a quarter of an hour after each set time, this looks at the page. If the
// page still shows an older check, it asks GitHub to run the check now, the
// same way the "Run workflow" button does. A check that runs once too often
// does no harm: it posts once a day.
//
// For that it needs a token from GitHub that may start workflows in this one
// repository (the README says how to make it). Without the token it does
// nothing. The token is sent to GitHub's API and nowhere else. It is never
// written down, put in the log or shown on the status page. What is kept is
// the number of GitHub's answer about it, and eight letters made from it that
// tell one token from the next.
//
// This file knows nothing about Cloudflare. It is given a place to keep
// things, a way to fetch, a way to read the page's data, and a clock.

import { clockText, localTime } from "./rules.js";

const GITHUB = "https://api.github.com";

// How many minutes after a set time the page may still show the check before it.
export const START_AFTER = 15;
// A check made up to this many minutes before a set time counts for it.
export const EARLY_ENOUGH = 10;
// A check that GitHub took but that brought no newer page is started again
// after this many minutes, up to MOST_TRIES times for one set time. A request
// GitHub did not take is not counted: it is made again at the next look.
export const TRY_AGAIN_AFTER = 10;
export const MOST_TRIES = 3;
// This many minutes after its first try was due, a set time is left alone.
// The next one is never far away.
export const LEAVE_AFTER = 60;
// GitHub's yes to the token holds for the rest of the day. Any other answer
// holds for this many minutes, and then GitHub is asked again.
export const ASK_AGAIN_AFTER = 30;

/**
 * The set time that needs looking after at `minute` of the day: the latest
 * one that is START_AFTER minutes old or more, unless it is so old that it is
 * left alone. Null if there is none.
 */
export function dueTime(times, minute) {
  let due = null;
  for (const time of times) {
    if (time + START_AFTER <= minute) due = time;
  }
  if (due === null || minute >= due + START_AFTER + LEAVE_AFTER) return null;
  return due;
}

/** Was the page's data made today, at the set time `due` or later, or a few minutes before it? */
export function newEnough(data, due, local, zone) {
  const made = Date.parse(data && data.generated);
  if (Number.isNaN(made)) return false;
  const when = localTime(made, zone);
  return when.date === local.date && when.minute >= due - EARLY_ENOUGH;
}

function hhmm(minute) {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

const took = (answer) => answer >= 200 && answer < 300;

/** The page's data.json, read fresh with `fetch` from the page at `siteUrl`. Throws if it cannot be read. */
export async function pageData(fetch, siteUrl, now) {
  const response = await fetch(`${siteUrl}data.json?t=${now}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`the page's data answered ${response.status}`);
  const data = await response.json();
  if (!data || typeof data !== "object") throw new Error("the page's data is not what was expected");
  return data;
}

/**
 * Eight letters made from the token, to tell one token from the next. They
 * are kept with GitHub's answer about the token, so that a new token is not
 * judged by what GitHub said about the old one. The token cannot be worked
 * out from them.
 */
async function markOf(token) {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  return Array.from(hash.slice(0, 4), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class Starter {
  /**
   * `storage` is a Durable Object's storage (get and put). `fetch` is how to
   * reach the outside. `now` gives the time in milliseconds. `settings` comes
   * from `settingsFrom`. `log` takes one line. `page` reads the page's data,
   * given the time. `token` is the token from GitHub, or "" while there is none.
   */
  constructor({ storage, fetch, page, now, settings, log, token }) {
    this.storage = storage;
    this.fetch = fetch;
    this.page = page;
    this.now = now;
    this.settings = settings;
    this.log = log || (() => {});
    this.token = typeof token === "string" ? token.trim() : "";
  }

  /** Is there anything for the second timer to do? Only with set times and a token. */
  get on() {
    return Boolean(this.settings.check && this.token);
  }

  /**
   * Ask GitHub something, with the token. Returns the number of its answer
   * (204, 401 and so on), or 0 if no answer came. Never throws.
   */
  async github(method, path, body) {
    try {
      const headers = {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        // GitHub turns away a request that does not say what is asking.
        "User-Agent": "citizens-bark-alerts",
      };
      if (body) headers["Content-Type"] = "application/json";
      // No version of GitHub's API is named here on purpose. A named version
      // is switched off one day, and this is meant to run for years untouched.
      const answer = await this.fetch(GITHUB + path, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        // The token goes to this one address. If the answer points elsewhere, nothing follows it there.
        redirect: "manual",
        signal: AbortSignal.timeout(10000),
      });
      // What the answer says is not needed. Only its number is kept.
      if (answer.body) await answer.body.cancel().catch(() => {});
      return answer.status;
    } catch {
      return 0;
    }
  }

  /** The token's mark, worked out once. */
  async marked() {
    if (!this.mark) this.mark = await markOf(this.token);
    return this.mark;
  }

  /** What GitHub last said about this very token, or null if it has said nothing about it. */
  async proof() {
    const proof = (await this.storage.get("starterToken")) || null;
    return proof && proof.mark === (await this.marked()) ? proof : null;
  }

  /** Write down what GitHub said about the token: the number of its answer and the token's mark, never the token. */
  async noteToken(local, now, answer) {
    const proof = { date: local.date, at: now, answer, ok: took(answer), mark: await this.marked() };
    await this.storage.put("starterToken", proof);
    if (!proof.ok) this.log(`the second timer: GitHub did not take the token (answer ${answer})`);
    return proof;
  }

  /**
   * Once a day, ask GitHub about the check, with the token. The status page
   * then shows whether the token is still taken, before the day it is needed.
   * It also keeps the token in use: GitHub removes a token that has not been
   * used for a year.
   *
   * Returns GitHub's answer as it was written down, or null while there is
   * none that still holds.
   */
  async proveToken(local, now) {
    const proof = await this.proof();
    // A yes holds for the day. A no may be a bad hour at GitHub, so it holds for half an hour.
    if (proof && (proof.ok ? proof.date === local.date : now - proof.at < ASK_AGAIN_AFTER * 60000)) return proof;
    const { repository, workflow } = this.settings.check;
    const answer = await this.github("GET", `/repos/${repository}/actions/workflows/${workflow}`);
    // No answer, or trouble on GitHub's side, says nothing about the token. The next look asks again.
    if (answer === 0 || answer >= 500) return null;
    return this.noteToken(local, now, answer);
  }

  /** Called at every look of the timer. Returns what was done and why, as `{ did, why }`. */
  async look() {
    // Switched off: nothing is asked of anyone, and nothing is written down.
    if (!this.settings.check) return { did: "nothing", why: "no set times" };
    if (!this.token) return { did: "nothing", why: "no token" };
    const said = await this.consider();
    // Kept for the status page: the last thing the second timer did, and why.
    await this.storage.put("starterLook", { at: this.now(), did: said.did, why: said.why });
    return said;
  }

  async consider() {
    const nothing = (why) => ({ did: "nothing", why });
    const check = this.settings.check;
    const now = this.now();
    const local = localTime(now, this.settings.zone);
    const proof = await this.proveToken(local, now);
    // A token GitHub does not know is not tried again and again. It is asked about once more in half an hour.
    if (proof && proof.answer === 401) return nothing("GitHub does not take the token");

    const due = dueTime(check.times, local.minute);
    if (due === null) return nothing("no set time to look after");
    const name = clockText(due);

    // The notes on this set time: how often the check was started for it
    // (`tries`, the last time at `at`), how often GitHub did not take the
    // request (`fails`), GitHub's last answer, and whether the page has shown
    // the check since (`done`).
    let job = await this.storage.get("starter");
    if (!job || job.date !== local.date || job.time !== due) job = { date: local.date, time: due, tries: 0, fails: 0, at: 0, answer: 0, done: false };
    if (job.done) return nothing(`the ${name} check has run`);

    // Has the check run? The page tells: its data carries the time it was made.
    let data = null;
    try {
      data = await this.page(now);
    } catch {
      // The page cannot be read, so nothing says that the check has run.
      // It is started: once too often does no harm, once too few does.
    }
    if (data && newEnough(data, due, local, this.settings.zone)) {
      await this.storage.put("starter", { ...job, done: true });
      return nothing(`the ${name} check has run`);
    }
    if (job.tries >= MOST_TRIES) return nothing(`the ${name} check was started ${MOST_TRIES} times and the page is no newer`);
    if (job.tries && now - job.at < TRY_AGAIN_AFTER * 60000) return nothing(`waiting for the ${name} check that was started`);

    const answer = await this.github("POST", `/repos/${check.repository}/actions/workflows/${check.workflow}/dispatches`, { ref: check.branch });
    if (took(answer)) {
      job = { ...job, tries: job.tries + 1, at: now, answer };
      await this.storage.put("starter", job);
      this.log(`the second timer started the ${name} check (time ${job.tries} of ${MOST_TRIES})`);
      return { did: "started", why: `the page showed no ${name} check` };
    }
    await this.storage.put("starter", { ...job, fails: job.fails + 1, answer });
    this.log(`the second timer could not start the ${name} check (GitHub answered ${answer || "nothing"})`);
    if (answer === 401) await this.noteToken(local, now, answer);
    return { did: "failed", why: answer ? `GitHub answered ${answer}` : "GitHub did not answer" };
  }

  /** For the status page: numbers and words from this file only, nothing GitHub said. */
  async status() {
    if (!this.on) return { on: false, look: null, check: null, token: null };
    const job = await this.storage.get("starter");
    // What GitHub said about an earlier token is not shown as if it were about this one.
    const proof = await this.proof();
    return {
      on: true,
      look: (await this.storage.get("starterLook")) || null,
      check: job ? { date: job.date, time: hhmm(job.time), tries: job.tries, fails: job.fails, at: job.at || null, answer: job.answer, done: job.done } : null,
      token: proof ? { date: proof.date, at: proof.at, answer: proof.answer, ok: proof.ok } : null,
    };
  }
}
