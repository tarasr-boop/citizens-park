// Runs the page's script without a browser, for the tests.
//
// Usage: node run_page.js PAGE_JS DATA_JSON [NOW]
//
// It gives the script a stand-in page with only the parts the script touches,
// then prints what the script drew. NOW pretends it is that time in the park,
// for example 2026-11-20T14:20.
"use strict";

const fs = require("fs");
const vm = require("vm");

const [scriptPath, dataPath, now] = process.argv.slice(2);
const app = { innerHTML: "", addEventListener() {} };
const elements = { app, "park-data": { textContent: fs.readFileSync(dataPath, "utf8") } };
const page = {
  document: { hidden: false, title: "", getElementById: (id) => elements[id] || null, addEventListener() {} },
  window: { location: { search: now ? "?now=" + now : "", href: "https://example.org/park/" } },
  navigator: {},
  setInterval() {},
  setTimeout() {},
  clearTimeout() {},
};
vm.runInNewContext(fs.readFileSync(scriptPath, "utf8"), page, { filename: scriptPath });
process.stdout.write(app.innerHTML);
