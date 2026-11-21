// The stats page itself: plain HTML, made here from the counter's report.
// It runs no script, so its rules allow none.

// The names the page sends for its buttons and links are "where:what". These
// are the words shown for them. A name not listed here is shown as it is sent.
const LABELS = {
  "alerts:on": "Alerts turned on",
  "alerts:off": "Alerts turned off",
  "buttons:notify": "“Alerts on this phone” button",
  "buttons:t.me": "Telegram button (custom alerts)",
  "buttons:feedback": "Feedback button",
  "share:open": "Opened “Share this page”",
  "share:copy": "“Copy the link” button",
  "how:open": "Opened “How this works”",
  "how:email": "“Please share feedback” button",
  "how:feedback": "Feedback button",
  "how:t.me": "Telegram link in “How this works”",
  "page:to-how": "Link to “How this works”",
  "how:yarracity.vic.gov.au": "Council link in “How this works”",
  "status:to-how": "“usual” label",
  "status:yarracity.vic.gov.au": "Council link at the top",
  "about:instagram.com": "Instagram link in “About me”",
  "footer:yarracity.vic.gov.au": "Council link at the bottom",
  "footer:open-meteo.com": "Open-Meteo link at the bottom",
  "footer:github.com": "“How this page is made” link",
  other: "Other buttons and links",
};

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function esc(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function number(value) {
  return Number(value || 0).toLocaleString("en-AU");
}

/** "November 2026" for "2026-11". */
export function monthText(month) {
  const [year, index] = month.split("-").map(Number);
  return `${MONTH_NAMES[index - 1]} ${year}`;
}

/** "Nov 2026" for "2026-11". */
function shortMonth(month) {
  const [year, index] = month.split("-").map(Number);
  return `${MONTH_NAMES[index - 1].slice(0, 3)} ${year}`;
}

/** "Sat 21" for "2026-11-21". */
function dayText(date) {
  const [year, month, day] = date.split("-").map(Number);
  return `${WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()]} ${day}`;
}

/** The month before or after "2026-11": "2026-10" or "2026-12". */
function shift(month, by) {
  const [year, index] = month.split("-").map(Number);
  const moved = new Date(Date.UTC(year, index - 1 + by, 1));
  return `${moved.getUTCFullYear()}-${String(moved.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function label(name) {
  return Object.hasOwn(LABELS, name) ? LABELS[name] : name;
}

const STYLE = `
:root { color-scheme: light dark; --bg: #f4f2ea; --card: #fffdf8; --ink: #1c2a1e; --muted: #5a665c; --line: #dedbce; --link: #17693a; }
@media (prefers-color-scheme: dark) { :root { --bg: #111612; --card: #1a211c; --ink: #e9efe6; --muted: #a0aca2; --line: #2d382f; --link: #76d99b; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
main { max-width: 42rem; margin: 0 auto; padding: 1.25rem 1rem 3rem; }
h1 { font-size: 1.5rem; margin: 0 0 .25rem; }
h2 { font-size: 1.05rem; margin: 0 0 .5rem; }
a { color: var(--link); }
.muted { color: var(--muted); }
nav { display: flex; justify-content: space-between; align-items: center; gap: .5rem; margin: 1rem 0; }
nav strong { font-size: 1.1rem; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 16px; padding: 1rem; margin: 0 0 1rem; }
.tiles { display: grid; grid-template-columns: repeat(2, 1fr); gap: .75rem; }
.tile b { display: block; font-size: 1.6rem; line-height: 1.2; }
.tile span { color: var(--muted); font-size: .9rem; }
table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; font-size: .95rem; }
table.wide { font-size: .88rem; }
th, td { text-align: right; padding: .3rem .25rem; border-bottom: 1px solid var(--line); }
th:first-child, td:first-child { text-align: left; white-space: nowrap; }
td.wrap { white-space: normal; }
table + table { margin-top: 1rem; }
th { font-weight: 600; color: var(--muted); font-size: .85rem; }
tr:last-child td { border-bottom: 0; }
.small { font-size: .85rem; }
h3 { font-size: .95rem; margin: 1rem 0 .4rem; }
.jump { line-height: 1.9; margin: -.25rem 0 1rem; }
.visitor { border-top: 1px solid var(--line); padding: .5rem 0; }
.visitor summary { cursor: pointer; list-style-position: outside; margin-left: 1rem; }
.visitor-body { margin: .25rem 0 0 1rem; }
.visitor-body p { margin: .25rem 0; }
.times { margin: .25rem 0 0; padding-left: 1.5rem; }
`;

function tile(value, words) {
  return `<div class="tile"><b>${number(value)}</b><span>${esc(words)}</span></div>`;
}

/** "7 AM" for "07". */
function hourText(hour) {
  const number = Number(hour);
  return `${number % 12 || 12} ${number < 12 ? "AM" : "PM"}`;
}

// The lists whose names have an order of their own. Every other list goes from the most to the least.
const ORDERS = {
  since: ["same day", "next day", "2 to 7 days", "8 to 30 days", "over 30 days"],
  nth: ["1st", "2nd", "3rd to 5th", "6th to 10th", "11th or later"],
  stays: ["under 5 seconds", "5 to 30 seconds", "30 seconds to 2 minutes", "2 to 10 minutes", "over 10 minutes"],
  kinds: ["phone", "tablet", "computer", "other"],
};

function rowsOf(list, name) {
  const entries = Object.entries(list || {});
  const order = ORDERS[name];
  if (order) return entries.sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
  return entries.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
}

/** A small table of one list: what, and how many. Empty when the list is. */
function listTable(list, name, heading, unit, words = (key) => key) {
  const rows = rowsOf(list, name);
  if (!rows.length) return "";
  const body = rows.map(([key, count]) => `<tr><td class="wrap">${esc(words(key))}</td><td>${number(count)}</td></tr>`).join("");
  return `<table><thead><tr><th>${esc(heading)}</th><th>${esc(unit)}</th></tr></thead><tbody>${body}</tbody></table>`;
}

function card(title, inside, note = "", id = "") {
  if (!inside.trim()) return "";
  return `<section class="card"${id ? ` id="${id}"` : ""}>\n<h2>${esc(title)}</h2>\n${note ? `<p class="small muted">${note}</p>\n` : ""}${inside}\n</section>`;
}

/** "8:14 AM" for minute 494 of the day. */
function clockText(minute) {
  const hour = Math.floor(minute / 60);
  return `${hour % 12 || 12}:${String(minute % 60).padStart(2, "0")} ${hour < 12 ? "AM" : "PM"}`;
}

/** "Sun 22 Nov, 8:14 AM" for a moment at the park (`{ date, minute }`). */
function momentText(moment) {
  const [, month] = moment.date.split("-").map(Number);
  return `${dayText(moment.date)} ${MONTH_NAMES[month - 1].slice(0, 3)}, ${clockText(moment.minute)}`;
}

/** "45 seconds", "3 minutes", "1 hour 5 minutes". */
function durationText(seconds) {
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${hours} hour${hours === 1 ? "" : "s"}${rest ? ` ${rest} minute${rest === 1 ? "" : "s"}` : ""}`;
}

function plural(count, one, many = one + "s") {
  return `${number(count)} ${count === 1 ? one : many}`;
}

// At most this many visitors are listed in each group.
const MOST_LISTED = 200;

/** One visitor, as a fold: two lines that sum it up, and its visits inside. */
function visitorHtml(visitor, period) {
  const name = `Visitor ${visitor.id.slice(0, 4)}`;
  const what = [visitor.kind === "other" ? "" : visitor.kind, visitor.system, visitor.browser].filter((part) => part && part !== "other" && part !== "program");
  const line1 = `<b>${esc(name)}</b> · ${esc(what.join(", ") || "unknown device")}`;
  const line2 = [visitor.place, visitor.network].filter((part) => part && part !== "unknown").map(esc).join(" · ") || "place unknown";
  const facts = [
    `${plural(visitor.inPeriod.length, "visit")} this ${period}`,
    `${plural(visitor.visits, "visit")} on ${plural(visitor.days, "day")} since ${esc(momentText({ ...visitor.firstSeen }).split(",")[0])}`,
  ];
  if (visitor.nth && visitor.nth > visitor.visits) facts.push(`${plural(visitor.nth, "visit")} by its own count, including some from before visitors were listed`);
  const ways = [`First came by ${esc(visitor.came || "unknown")}`];
  if (visitor.lastCame && visitor.lastCame !== visitor.came) ways.push(`Last came by ${esc(visitor.lastCame)}`);
  if (visitor.seconds) ways.push(`On the page for ${esc(durationText(visitor.seconds))} in all`);
  const pressed = Object.entries(visitor.presses || {}).sort((a, b) => b[1] - a[1]);
  if (pressed.length) ways.push(`Pressed ${pressed.map(([key, count]) => `${esc(label(key))}${count > 1 ? ` ×${count}` : ""}`).join(", ")}`);
  const times = visitor.inPeriod.map((moment) => `<li>${esc(momentText(moment))}</li>`).join("");
  return (
    `<details class="visitor"><summary>${line1}<br><span class="muted">${line2}</span><br><span class="small">Last ${esc(momentText(visitor.inPeriod[0]))} · ${facts[0]}</span></summary>` +
    `<div class="visitor-body"><p class="small">${facts.slice(1).join(". ")}.</p><p class="small">${ways.join(". ")}.</p>` +
    `<p class="small muted">Visits this ${period}, latest first:</p><ol class="times small">${times}</ol></div></details>`
  );
}

/** The visitors of the period, in three groups: people, the owner's own devices, and programs. */
function visitorsHtml(visitors, period, locked) {
  if (!locked) {
    return `<p class="muted">The list of visitors appears here once the stats password is set (see the README). Until then this page is open to anyone and shows totals only.</p>`;
  }
  if (!visitors || !visitors.length) return `<p class="muted">No visitors this ${period} yet. Visitors are listed from 22 November 2026.</p>`;
  const people = visitors.filter((one) => !one.robot && !one.mine);
  const yours = visitors.filter((one) => one.mine);
  const robots = visitors.filter((one) => one.robot && !one.mine);
  const group = (title, list, open) =>
    list.length
      ? `<h3>${esc(title)} <span class="muted">(${number(list.length)})</span></h3>${list.slice(0, MOST_LISTED).map((one) => visitorHtml(one, period)).join("\n")}${list.length > MOST_LISTED ? `<p class="small muted">And ${number(list.length - MOST_LISTED)} more.</p>` : ""}`
      : open
        ? `<p class="muted">No people this ${period} yet.</p>`
        : "";
  return [group("People", people, true), group("Your own devices", yours, false), group("Look automated", robots, false)].filter(Boolean).join("\n");
}

/** The whole page for the counter's report (see Counter.report). */
export function statsPage(report, siteUrl, { locked = false } = {}) {
  const { month, day, thisMonth, first, days, totals, months, total } = report;
  const period = day ? "day" : "month";
  const before = shift(month, -1);
  const after = shift(month, 1);
  let nav;
  if (day) {
    const [year, monthNumber] = day.split("-").map(Number);
    nav = `<a href="?month=${month}">← ${esc(monthText(month))}</a><strong>${esc(dayText(day))} ${esc(MONTH_NAMES[monthNumber - 1])} ${year}</strong><span></span>`;
  } else {
    const older = before >= first ? `<a href="?month=${before}">← ${esc(monthText(before))}</a>` : "<span></span>";
    const newer = month < thisMonth ? `<a href="?month=${after}">${esc(monthText(after))} →</a>` : "<span></span>";
    nav = `${older}<strong>${esc(monthText(month))}</strong>${newer}`;
  }

  const dayRows = days
    .map(
      (one) =>
        `<tr><td><a href="?day=${one.date}">${esc(dayText(one.date))}</a>${one.date === report.today ? " ·" : ""}</td>` +
        `<td>${number(one.visits)}</td><td>${number(one.devices)}</td><td>${number(one.fresh)}</td><td>${number(one.returning)}</td><td>${number(one.robots)}</td></tr>`
    )
    .join("");

  // When people come: each hour with a visit, from the earliest to the latest.
  const hours = Object.keys({ ...totals.hours, ...totals.hoursBack }).sort();
  const hourRows = hours
    .map((hour) => `<tr><td>${esc(hourText(hour))}</td><td>${number(totals.hours[hour])}</td><td>${number(totals.hoursBack[hour])}</td></tr>`)
    .join("");
  const hourTable = hourRows ? `<table><thead><tr><th>Hour it began</th><th>Visits</th><th>From returning devices</th></tr></thead><tbody>${hourRows}</tbody></table>` : "";

  const set = (parts) => parts.filter(Boolean).join("\n");
  const asides = [];
  if (totals.robots) asides.push(`${number(totals.robots)} ${totals.robots === 1 ? "visit that looks" : "visits that look"} automated`);
  if (totals.mine) asides.push(`${number(totals.mine)} from your own devices`);

  const monthRows = months
    .map(
      (one) =>
        `<tr><td>${one.month === month && !day ? `<strong>${esc(shortMonth(one.month))}</strong>` : `<a href="?month=${one.month}">${esc(shortMonth(one.month))}</a>`}</td>` +
        `<td>${number(one.visits)}</td><td>${number(one.devices)}</td><td>${number(one.fresh)}</td><td>${number(one.returning)}</td><td>${number(one.pressed)}</td></tr>`
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="en-AU">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Citizens Bark stats</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>Citizens Bark stats</h1>
<p class="muted">Visits to <a href="${esc(siteUrl)}">${esc(siteUrl.replace(/^https:\/\//, "").replace(/\/$/, ""))}</a> and what visitors do there. Times are Melbourne time.</p>
<nav>${nav}</nav>
<p class="jump small">${[
    ["overview", "Overview"],
    ["visitors", "Visitors"],
    day ? null : ["days", "Each day"],
    ["when", "When"],
    ["back", "Coming back"],
    ["sources", "Found by"],
    ["time", "Time on page"],
    ["devices", "Devices"],
    ["where", "Where"],
    ["buttons", "Buttons"],
    ["bots", "Bots"],
    ["months", "Months"],
  ]
    .filter(Boolean)
    .map(([id, words]) => `<a href="#${id}">${words}</a>`)
    .join(" · ")}</p>
<section class="card" id="overview">
<div class="tiles">
${tile(totals.visits, "visits")}
${tile(totals.devices, "different devices")}
${tile(totals.fresh, "first-time devices")}
${tile(totals.returning, day ? "devices that came back" : "returns (a device back on a later day)")}
</div>
${asides.length ? `<p class="small muted">Not counted above: ${asides.join(", and ")}.</p>` : ""}
</section>
<section class="card" id="visitors">
<h2>Visitors</h2>
${locked ? `<p class="small muted">One row for each device, by the random number it keeps in its browser. Tap one to see its visits. Clearing the browser, or a private window, makes a new one.</p>\n` : ""}${visitorsHtml(report.visitors, period, locked)}
</section>
${day ? "" : card("Each day", days.length ? `<table class="wide"><thead><tr><th>Day</th><th>Visits</th><th>Devices</th><th>New</th><th>Back</th><th>Bots</th></tr></thead><tbody>${dayRows}</tbody></table>` : "", "Tap a day to see it on its own. The dot marks today. <b>New</b>: first visit ever. <b>Back</b>: had been here on an earlier day. <b>Bots</b>: visits that look automated, not counted in the others.", "days")}
${card("When people visit", hourTable, "", "when")}
${card(
  "Coming back",
  set([listTable(totals.since, "since", "Time since the last visit", "Visits"), listTable(totals.nth, "nth", "Which visit it was for that device", "Visits")]),
  "Only devices that had been here before are in the first table.",
  "back"
)}
${card("How they found the page", listTable(totals.sources, "sources", "Came from", "Visits"), "", "sources")}
${card("Time on the page", listTable(totals.stays, "stays", "Each look lasted", "Looks"), "A look ends when the page goes out of sight: another app, another tab, or the screen turning off.", "time")}
${card(
  "Devices",
  set([
    listTable(totals.kinds, "kinds", "Kind", "Devices"),
    listTable(totals.systems, "systems", "System", "Devices"),
    listTable(totals.browsers, "browsers", "Browser", "Devices"),
  ]),
  "Each device once a day.",
  "devices"
)}
${card(
  "Where",
  set([listTable(totals.places, "places", "Rough place", "Devices"), listTable(totals.networks, "networks", "Network", "Devices")]),
  "Worked out from the internet address, which is not kept. It is often the nearest big city, not the suburb, and on iPhones with iCloud Private Relay it can be a city nearby.",
  "where"
)}
${card("Buttons and links", listTable(totals.presses, "presses", "What was pressed", "Times", label) || `<p class="muted">Nothing pressed this ${period} yet.</p>`, "", "buttons")}
${card(
  "Looks automated",
  set([listTable(totals.robotWhy, "robotWhy", "Why", "Visits"), listTable(totals.robotNets, "robotNets", "Network", "Visits")]),
  "Programs that run the page’s script: link checkers, security scanners, search engines. They are left out of every other number on this page. Now and then one is a person on a VPN.",
  "bots"
)}
<section class="card" id="months">
<h2>Every month</h2>
${monthRows ? `<table class="wide"><thead><tr><th>Month</th><th>Visits</th><th>Devices</th><th>New</th><th>Back</th><th>Presses</th></tr></thead><tbody>${monthRows}</tbody></table>` : `<p class="muted">Nothing counted yet.</p>`}
<p class="small muted">Since counting began: ${number(total.visits)} visits from ${number(total.fresh)} first-time devices.</p>
</section>
<p class="small muted">How this is counted: a visit is each time the page is opened, or looked at again after half an hour away. A device (a phone or computer) counts once a day in “Each day” and once a month in the totals. It knows it has been here before only because its browser remembers a random number it made for itself, the date of its last visit and how many visits it has made. No cookies are used and the internet address is not kept. A private window, or a browser whose history was cleared, counts as a new device. Programs that do not run the page’s script, such as link previews in chat apps, are not counted at all. Device, place, source, returns, time on the page and the list of visitors start on 22 November 2026; days before that show only visits, devices and presses.</p>
<p class="small muted">To leave your own phone or computer out of the numbers, open <a href="${esc(siteUrl)}?me">${esc(siteUrl.replace(/^https:\/\//, ""))}?me</a> once in each browser you use. <a href="${esc(siteUrl)}?me=off">?me=off</a> undoes it.</p>
</main>
</body>
</html>
`;
}
