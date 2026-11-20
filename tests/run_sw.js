// Runs sw.js (the script that shows a notification) without a browser, for the tests.
//
// Usage: node run_sw.js SW_JS SCENARIO_JSON
//
// The scenario names one event to hand to the script ("push", "notificationclick"
// or "pushsubscriptionchange") and what the pretend browser and the pretend
// page have to offer. The script prints, as JSON, what was shown and asked.
"use strict";

const fs = require("fs");
const vm = require("vm");

const [scriptPath, scenarioPath] = process.argv.slice(2);
const scenario = JSON.parse(fs.readFileSync(scenarioPath, "utf8"));

const SCOPE = "https://example.org/park/";
const log = { shown: [], opened: [], focused: [], requests: [], subscribed: [], closed: 0, skippedWaiting: 0, claimed: 0 };
const listeners = {};

function fetch(address, options) {
  const entry = { address: String(address).replace(/\?t=\d+$/, "?t=…"), method: (options && options.method) || "GET" };
  if (options && options.body) entry.body = JSON.parse(options.body);
  if (options && options.cache) entry.cache = options.cache;
  log.requests.push(entry);
  if (String(address).indexOf("data.json") === 0) {
    if (scenario.data === "slow") return new Promise(() => {});
    if (scenario.data === "down") return Promise.reject(new TypeError("Failed to fetch"));
    if (scenario.data === "missing") return Promise.resolve({ ok: false, status: 404, json: () => Promise.reject(new Error("no")) });
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(scenario.data) });
  }
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
}

function subscriptionFrom(given) {
  return Object.assign({}, given, {
    toJSON: () => ({ endpoint: given.endpoint, expirationTime: null, keys: { p256dh: "device-key", auth: "device-secret" } }),
  });
}

const self = {
  addEventListener(type, handler) {
    listeners[type] = handler;
  },
  skipWaiting() {
    log.skippedWaiting += 1;
  },
  registration: {
    scope: SCOPE,
    showNotification(title, options) {
      log.shown.push({ title, options });
      return Promise.resolve();
    },
    pushManager: {
      subscribe(options) {
        log.subscribed.push(options);
        return Promise.resolve(subscriptionFrom({ endpoint: "https://push.example/renewed" }));
      },
    },
  },
  clients: {
    claim() {
      log.claimed += 1;
      return Promise.resolve();
    },
    matchAll() {
      return Promise.resolve(
        (scenario.windows || []).map((address) => ({
          url: address,
          focus() {
            log.focused.push(address);
            return Promise.resolve();
          },
        }))
      );
    },
    openWindow(address) {
      log.opened.push(address);
      return Promise.resolve();
    },
  },
};

const fixedNow = Date.parse(scenario.now || "2026-11-20T04:45:00Z");
class FixedDate extends Date {
  constructor(...args) {
    if (args.length) super(...args);
    else super(fixedNow);
  }
  static now() {
    return fixedNow;
  }
}

const context = {
  self,
  fetch,
  Date: FixedDate,
  // The script waits a while for the page's data. Here the wait is over at once.
  setTimeout: (callback) => setImmediate(callback),
};

function eventFor(kind) {
  const waits = [];
  const event = { waitUntil: (promise) => waits.push(promise) };
  if (kind === "push") {
    const payload = scenario.payload;
    if (payload === undefined || payload === null) event.data = null;
    else if (payload === "garbage") event.data = { json: () => JSON.parse("{not json") };
    else event.data = { json: () => payload };
  }
  if (kind === "notificationclick") {
    event.notification = {
      data: scenario.notificationData,
      close() {
        log.closed += 1;
      },
    };
  }
  if (kind === "pushsubscriptionchange") {
    event.oldSubscription = scenario.old ? subscriptionFrom(scenario.old) : null;
    event.newSubscription = scenario.renewed ? subscriptionFrom(scenario.renewed) : null;
  }
  return { event, waits };
}

(async () => {
  vm.runInNewContext(fs.readFileSync(scriptPath, "utf8"), context, { filename: scriptPath });
  const kinds = Object.keys(listeners).sort();
  for (const kind of [].concat(scenario.event || [])) {
    const { event, waits } = eventFor(kind);
    listeners[kind](event);
    await Promise.all(waits);
  }
  process.stdout.write(JSON.stringify({ log, kinds }));
})().catch((error) => {
  process.stderr.write(String(error && error.stack ? error.stack : error));
  process.exit(1);
});
