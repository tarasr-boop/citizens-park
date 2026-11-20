// Runs the page's script without a browser, presses some of its buttons and
// links, and prints what it sent to the counter behind the stats page.
//
// Usage: node run_stats.js PAGE_JS DATA_JSON SCENARIO_JSON
//
// The scenario says where the page is opened ("origin"), what this device
// remembers ("stored"), whether storage works ("noStorage"), whether a
// program steers the browser ("webdriver"), whether beacons work ("noBeacon"),
// what is pressed ("presses", each a list of the elements from the pressed one
// outwards, see ELEMENTS) and whether the page is looked at again after a
// while away ("awayMinutes").
"use strict";

const fs = require("fs");
const vm = require("vm");

const [scriptPath, dataPath, scenarioPath] = process.argv.slice(2);
const scenario = JSON.parse(fs.readFileSync(scenarioPath, "utf8"));
const sent = [];

// A stand-in element: its tag, what it carries, and the selectors it answers to.
function element(tag, { id = "", attrs = {}, hostname = "", matches = [], open = false } = {}) {
  return {
    tagName: tag.toUpperCase(),
    id,
    hostname,
    open,
    parentNode: null,
    matchesAny(selectors) {
      return selectors.split(",").some((one) => {
        const selector = one.trim();
        if (matches.includes(selector)) return true;
        if (selector === tag) return true;
        if (selector === `${tag}[href]`) return "href" in attrs;
        if (selector === `#${id}`) return Boolean(id);
        return false;
      });
    },
    closest(selectors) {
      for (let node = this; node; node = node.parentNode) if (node.matchesAny(selectors)) return node;
      return null;
    },
    getAttribute(name) {
      return name in attrs ? attrs[name] : null;
    },
  };
}

// The parts of the page that are pressed in these tests, each with what holds it.
function chain(nodes) {
  for (let index = 0; index < nodes.length - 1; index += 1) nodes[index].parentNode = nodes[index + 1];
  return nodes[0];
}
const ELEMENTS = {
  telegram: () => chain([element("a", { attrs: { href: "https://t.me/CitizensBark" }, hostname: "t.me" }), element("nav", { matches: ["nav.actions"] })]),
  notify: () => chain([element("button", { id: "notify" }), element("nav", { matches: ["nav.actions"] })]),
  label: () => chain([element("span"), element("a", { attrs: { href: "#how" } }), element("div", { id: "app" })]),
  instagram: () => chain([element("a", { attrs: { href: "https://www.instagram.com/gentle_woof" }, hostname: "www.instagram.com" }), element("section", { matches: [".about"] })]),
  shareOpen: () => chain([element("summary"), element("details", { id: "share" })]),
  shareClose: () => chain([element("summary"), element("details", { id: "share", open: true })]),
  copy: () => chain([element("button", { id: "copy" }), element("div"), element("details", { id: "share", open: true })]),
  feedback: () => chain([element("a", { attrs: { href: "mailto:feedback@example.org", "data-stat": "feedback" } }), element("details", { id: "how", open: true })]),
  mail: () => chain([element("a", { attrs: { href: "mailto:feedback@example.org" } }), element("details", { id: "how", open: true })]),
  council: () => chain([element("a", { attrs: { href: "https://www.yarracity.vic.gov.au/park" }, hostname: "www.yarracity.vic.gov.au" }), element("footer")]),
  odd: () => chain([element("button", { id: "Größe!!" }), element("main")]),
  plain: () => chain([element("p"), element("main")]),
};

const listeners = { click: [], visibilitychange: [] };
const app = { innerHTML: "", addEventListener() {} };
const elements = { app, "park-data": { textContent: fs.readFileSync(dataPath, "utf8") } };

const stored = Object.assign({}, scenario.stored || {});
const localStorage = scenario.noStorage
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

let clock = Date.parse(scenario.now || "2026-11-20T04:45:00Z");
class FixedDate extends Date {
  constructor(...args) {
    if (args.length) super(...args);
    else super(clock);
  }
  static now() {
    return clock;
  }
}

const navigator = { userAgent: "Mozilla/5.0 (Linux; Android 16; Pixel 9) Chrome/142.0 Mobile Safari/537.36", webdriver: Boolean(scenario.webdriver) };
if (!scenario.noBeacon) {
  navigator.sendBeacon = (address, text) => {
    sent.push({ how: "beacon", address, body: JSON.parse(text) });
    return true;
  };
}

const document = {
  hidden: false,
  title: "",
  getElementById: (id) => elements[id] || null,
  addEventListener(type, handler, capture) {
    if (type in listeners) listeners[type].push({ handler, capture: Boolean(capture) });
  },
};

const page = {
  document,
  window: { location: { search: "", href: (scenario.origin || "https://citizensbark.example") + "/", origin: scenario.origin || "https://citizensbark.example" }, localStorage },
  navigator,
  URL,
  Date: FixedDate,
  fetch(address, options) {
    sent.push({ how: "fetch", address, body: JSON.parse(options.body), keepalive: options.keepalive, mode: options.mode, credentials: options.credentials });
    return Promise.resolve({});
  },
  setInterval() {},
  setTimeout() {},
  clearTimeout() {},
};

vm.runInNewContext(fs.readFileSync(scriptPath, "utf8"), page, { filename: scriptPath });

for (const name of scenario.presses || []) {
  const target = ELEMENTS[name]();
  for (const { handler } of listeners.click) handler({ target });
}
if (scenario.awayMinutes !== undefined) {
  document.hidden = true;
  for (const { handler } of listeners.visibilitychange) handler();
  clock += scenario.awayMinutes * 60 * 1000;
  document.hidden = false;
  for (const { handler } of listeners.visibilitychange) handler();
}

process.stdout.write(
  JSON.stringify({ sent, stored, clickCaught: listeners.click.filter((one) => one.capture).length })
);
