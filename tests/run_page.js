// Runs the page's script without a browser, for the tests.
//
// Usage: node run_page.js PAGE_JS DATA_JSON [NOW] [CLOCK]
//
// It gives the script a stand-in page with only the parts the script touches,
// then prints what the script drew. NOW pretends it is that time in the park,
// for example 2026-11-20T14:20. CLOCK is the same moment as the script's own
// clock sees it, in milliseconds since 1970: the script asks that clock whether
// its data is out of date, and here it stands still, so that what is drawn does
// not depend on the day the tests are run.
"use strict";

const fs = require("fs");
const vm = require("vm");

const [scriptPath, dataPath, now, clock] = process.argv.slice(2);
const fixedNow = clock ? Number(clock) : NaN;
class FixedDate extends Date {
  constructor(...args) {
    if (args.length || isNaN(fixedNow)) super(...args);
    else super(fixedNow);
  }
  static now() {
    return isNaN(fixedNow) ? Date.now() : fixedNow;
  }
}
const app = { innerHTML: "", addEventListener() {} };
const elements = { app, "park-data": { textContent: fs.readFileSync(dataPath, "utf8") } };
const page = {
  document: { hidden: false, title: "", getElementById: (id) => elements[id] || null, addEventListener() {} },
  window: { location: { search: now ? "?now=" + now : "", href: "https://example.org/park/" } },
  navigator: {},
  Date: FixedDate,
  setInterval() {},
  setTimeout() {},
  clearTimeout() {},
};
vm.runInNewContext(fs.readFileSync(scriptPath, "utf8"), page, { filename: scriptPath });
process.stdout.write(app.innerHTML);
