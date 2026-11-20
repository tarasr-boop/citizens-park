// The stats page itself: plain HTML, made here from the counter's report.
// It runs no script, so its rules allow none.

// The names the page sends for its buttons and links are "where:what". These
// are the words shown for them. A name not listed here is shown as it is sent.
const LABELS = {
  "alerts:on": "Alerts turned on",
  "alerts:off": "Alerts turned off",
  "buttons:notify": "“Alerts on this phone” button",
  "buttons:t.me": "Telegram button",
  "buttons:feedback": "Feedback button",
  "share:open": "Opened “Share this page”",
  "share:copy": "“Copy the link” button",
  "how:open": "Opened “How this works”",
  "how:email": "“Please share feedback” button",
  "how:feedback": "Feedback button",
  "how:t.me": "Telegram link in “How this works”",
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
main { max-width: 40rem; margin: 0 auto; padding: 1.25rem 1rem 3rem; }
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
table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
th, td { text-align: right; padding: .3rem .35rem; border-bottom: 1px solid var(--line); }
th:first-child, td:first-child { text-align: left; white-space: nowrap; }
th { font-weight: 600; color: var(--muted); font-size: .85rem; }
tr:last-child td { border-bottom: 0; }
.small { font-size: .85rem; }
`;

function tile(value, words) {
  return `<div class="tile"><b>${number(value)}</b><span>${esc(words)}</span></div>`;
}

/** The whole page for the counter's report (see Counter.report). */
export function statsPage(report, siteUrl) {
  const { month, thisMonth, first, days, totals, months, total } = report;
  const before = shift(month, -1);
  const after = shift(month, 1);
  const older = before >= first ? `<a href="?month=${before}">← ${esc(monthText(before))}</a>` : "<span></span>";
  const newer = month < thisMonth ? `<a href="?month=${after}">${esc(monthText(after))} →</a>` : "<span></span>";

  const dayRows = days
    .map(
      (day) =>
        `<tr><td>${esc(dayText(day.date))}${day.date === report.today ? " <span class=\"muted\">today</span>" : ""}</td>` +
        `<td>${number(day.visits)}</td><td>${number(day.devices)}</td><td>${number(day.pressed)}</td></tr>`
    )
    .join("");

  const presses = Object.entries(totals.presses).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const pressRows = presses.map(([name, count]) => `<tr><td>${esc(label(name))}</td><td>${number(count)}</td></tr>`).join("");

  const monthRows = months
    .map(
      (one) =>
        `<tr><td>${one.month === month ? `<strong>${esc(shortMonth(one.month))}</strong>` : `<a href="?month=${one.month}">${esc(shortMonth(one.month))}</a>`}</td>` +
        `<td>${number(one.visits)}</td><td>${number(one.devices)}</td><td>${number(one.fresh)}</td><td>${number(one.pressed)}</td></tr>`
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
<p class="muted">Visits to <a href="${esc(siteUrl)}">${esc(siteUrl.replace(/^https:\/\//, "").replace(/\/$/, ""))}</a> and presses of its buttons and links. Times are Melbourne time.</p>
<nav>${older}<strong>${esc(monthText(month))}</strong>${newer}</nav>
<section class="card">
<div class="tiles">
${tile(totals.visits, "visits")}
${tile(totals.devices, "different devices")}
${tile(totals.fresh, "first-time devices")}
${tile(totals.pressed, "presses of buttons and links")}
</div>
</section>
<section class="card">
<h2>Each day</h2>
${days.length ? `<table><thead><tr><th>Day</th><th>Visits</th><th>Devices</th><th>Presses</th></tr></thead><tbody>${dayRows}</tbody></table>` : `<p class="muted">No days yet.</p>`}
</section>
<section class="card">
<h2>Buttons and links</h2>
${pressRows ? `<table><thead><tr><th>What was pressed</th><th>Times</th></tr></thead><tbody>${pressRows}</tbody></table>` : `<p class="muted">Nothing pressed this month yet.</p>`}
</section>
<section class="card">
<h2>Every month</h2>
${monthRows ? `<table><thead><tr><th>Month</th><th>Visits</th><th>Devices</th><th>New</th><th>Presses</th></tr></thead><tbody>${monthRows}</tbody></table>` : `<p class="muted">Nothing counted yet.</p>`}
<p class="small muted">Since counting began: ${number(total.visits)} visits from ${number(total.fresh)} first-time devices.</p>
</section>
<p class="small muted">How this is counted: a visit is each time the page is opened, or looked at again after half an hour away. A device (a phone or computer) counts once a day in “Each day” and once a month in the totals. It knows it has been here before only because its browser remembers the date of its last visit. No cookies are used and nothing about the person is sent or kept. A private window, or a browser whose history was cleared, counts as a new device. Visits from programs that do not run the page’s script, such as most search engines, are not counted.</p>
</main>
</body>
</html>
`;
}
