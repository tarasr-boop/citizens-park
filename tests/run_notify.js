// Runs the page's script without a browser and presses its notifications
// button, for the tests.
//
// Usage: node run_notify.js PAGE_JS DATA_JSON SCENARIO_JSON
//
// The scenario says what kind of browser to pretend to be and how the backend
// answers. The script prints, as JSON, what the button and the line under it
// say afterwards, and everything that was asked of the browser and the backend.
"use strict";

const fs = require("fs");
const vm = require("vm");

const [scriptPath, dataPath, scenarioPath] = process.argv.slice(2);
const scenario = JSON.parse(fs.readFileSync(scenarioPath, "utf8"));

const log = { requests: [], registered: [], subscribed: [], unsubscribed: 0, asked: 0 };
const listeners = {};

function element(extra) {
  return Object.assign({ hidden: true, textContent: "", disabled: false, addEventListener() {} }, extra);
}
const button = element({
  textContent: "Get the daily alert on this device",
  addEventListener(type, handler) {
    listeners[type] = handler;
  },
});
const note = element({});
const app = element({ innerHTML: "" });
const elements = { app, notify: button, "notify-note": note, "park-data": { textContent: fs.readFileSync(dataPath, "utf8") } };

// ---- the pretend browser ----

let permission = scenario.permission || "default";
let current = scenario.subscribed ? makeSubscription(scenario.subscribed) : null;

function makeSubscription(endpoint) {
  return {
    endpoint,
    toJSON() {
      return { endpoint, expirationTime: null, keys: { p256dh: "device-key", auth: "device-secret" } };
    },
    unsubscribe() {
      log.unsubscribed += 1;
      current = null;
      return Promise.resolve(true);
    },
  };
}

const registration = {
  pushManager: {
    getSubscription: () => Promise.resolve(current),
    subscribe(options) {
      if (scenario.subscribeFails) return Promise.reject(new Error("push service error"));
      log.subscribed.push({ userVisibleOnly: options.userVisibleOnly, keyBytes: Array.from(options.applicationServerKey) });
      current = makeSubscription("https://push.example/new-" + log.subscribed.length);
      return Promise.resolve(current);
    },
  },
};
let registered = Boolean(scenario.subscribed);

const able = scenario.able !== false;
const navigator = {
  userAgent: scenario.agent || "Mozilla/5.0 (Linux; Android 16; Pixel 9) Chrome/142.0 Mobile Safari/537.36",
  platform: scenario.platform || "",
  maxTouchPoints: scenario.maxTouchPoints || 0,
  standalone: scenario.standalone,
};
if (able) {
  navigator.serviceWorker = {
    getRegistration: () => Promise.resolve(registered ? registration : undefined),
    register(path) {
      if (scenario.registerFails) return Promise.reject(new Error("not allowed"));
      log.registered.push(path);
      registered = true;
      return Promise.resolve(registration);
    },
    ready: Promise.resolve(registration),
  };
}

const Notification = {
  get permission() {
    return permission;
  },
  requestPermission() {
    log.asked += 1;
    permission = scenario.answer || "granted";
    return Promise.resolve(permission);
  },
};

// The backend's answers: for each path one answer, or a list that is used up in turn.
function fetch(address, options) {
  const path = address.replace("https://alerts.example", "");
  const entry = { path, method: (options && options.method) || "GET" };
  if (options && options.body) entry.body = JSON.parse(options.body);
  if (options && options.headers) entry.type = options.headers["Content-Type"];
  log.requests.push(entry);
  const answers = scenario.backend || {};
  let answer = answers[path];
  if (Array.isArray(answer)) answer = answer.length > 1 ? answer.shift() : answer[0];
  if (answers === "down" || answer === "down" || !answer) return Promise.reject(new TypeError("Failed to fetch"));
  return Promise.resolve({
    status: answer.status || 200,
    ok: (answer.status || 200) < 300,
    json: () => (answer.body === "garbage" ? Promise.reject(new SyntaxError("not JSON")) : Promise.resolve(answer.body)),
  });
}

const stored = Object.assign({}, scenario.stored || {});
const storage = scenario.noStorage
  ? {
      getItem() {
        throw new Error("storage is switched off");
      },
      setItem() {
        throw new Error("storage is switched off");
      },
    }
  : {
      getItem: (key) => (key in stored ? stored[key] : null),
      setItem(key, value) {
        stored[key] = String(value);
      },
    };

const window = {
  location: { search: "", href: "https://example.org/park/" },
  atob: (text) => Buffer.from(text, "base64").toString("binary"),
  localStorage: storage,
  matchMedia: () => ({ matches: Boolean(scenario.displayStandalone) }),
};
if (able) {
  window.PushManager = function PushManager() {};
  window.Notification = Notification;
}

// A clock the test controls, so "once a day" can be tried.
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

const page = {
  document: { hidden: false, title: "", getElementById: (id) => elements[id] || null, addEventListener() {} },
  window,
  navigator,
  fetch,
  Date: FixedDate,
  setInterval() {},
  setTimeout() {},
  clearTimeout() {},
};
if (able) page.Notification = Notification;

async function settle() {
  for (let turn = 0; turn < 60; turn += 1) await new Promise((resolve) => setImmediate(resolve));
}

(async () => {
  vm.runInNewContext(fs.readFileSync(scriptPath, "utf8"), page, { filename: scriptPath });
  await settle();
  const states = [];
  const snapshot = () => ({ hidden: button.hidden, label: button.textContent, disabled: button.disabled, note: note.hidden ? "" : note.textContent });
  states.push(snapshot());
  for (let click = 0; click < (scenario.clicks === undefined ? 1 : scenario.clicks); click += 1) {
    if (listeners.click) listeners.click();
    await settle();
    states.push(snapshot());
  }
  process.stdout.write(JSON.stringify({ states, log, stored, wired: Boolean(listeners.click), nowSubscribed: current ? current.endpoint : null }));
})().catch((error) => {
  process.stderr.write(String(error && error.stack ? error.stack : error));
  process.exit(1);
});
