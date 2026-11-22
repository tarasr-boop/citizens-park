// Everything the counter keeps, as one file the owner can download from the
// stats page and hand to Claude or a spreadsheet: totals, each day, and each
// visitor. It is written to be read without this code: plain names, times
// at the park, and a short explanation of every field at the top.
//
// The random number each device keeps is left out: visitors are numbered by
// when they first came instead.

import { localTime } from "./rules.js";
import { label } from "./statspage.js";

// The counter's names for a day's numbers and lists, and the names used in the file.
const NUMBERS = [
  ["visits", "visits", "Visits by people: a page load, or coming back to the page after 30 minutes away. Own and automated visits are not included."],
  ["devices", "differentDevices", "Devices that visited that day (each device once)."],
  ["monthly", "newThisMonth", "Devices whose first visit this calendar month was that day."],
  ["fresh", "firstTimeDevices", "Devices visiting for the first time ever (or after clearing the browser, or in a private window)."],
  ["returning", "returningDevices", "Devices that had been here on an earlier day."],
  ["robots", "automatedVisits", "Visits that look automated (a program that says so, or a data centre network). Kept out of every other number."],
  ["mine", "ownVisits", "Visits from the owner's own browsers (marked with ?me). Kept out of every other number."],
];
const LISTS = [
  ["presses", "presses", "Buttons and links pressed, by name, with how many times."],
  ["hours", "visitsByHour", "Visits by the hour they began, at the park: \"07\" is 7 to 8 AM."],
  ["hoursBack", "returningVisitsByHour", "The same, for visits from devices that had been here before."],
  ["since", "daysSinceLastVisit", "Visits from returning devices, by how long since that device's last visit."],
  ["nth", "visitNumber", "Visits by how many visits the device had made, this one included."],
  ["sources", "foundBy", "Visits by how they reached the page (the site they came from, the QR code, or no link)."],
  ["stays", "timeOnPage", "Looks at the page by how long they lasted. A look ends when the page goes out of sight."],
  ["kinds", "deviceKinds", "Devices by kind (phone, tablet, computer), each device once a day."],
  ["systems", "systems", "Devices by operating system, each device once a day."],
  ["browsers", "browsers", "Devices by browser, each device once a day."],
  ["places", "places", "Devices by rough place, worked out by Cloudflare from the internet address (which is not kept). Often the nearest big city."],
  ["networks", "networks", "Devices by internet provider or network, each device once a day."],
  ["robotWhy", "automatedReasons", "Automated visits by why they look automated."],
  ["robotNets", "automatedNetworks", "Automated visits by network."],
];

const VISITOR_FIELDS = {
  visitor: "A number for this device, in the order devices first came. The same device has the same number in every export.",
  group: "\"person\", \"own device\" (the owner's, marked with ?me) or \"automated\".",
  firstVisit: "When this device first came, at the park.",
  firstCameBy: "How it reached the page that first time.",
  lastVisit: "Its latest visit, at the park.",
  lastCameBy: "How it reached the page on its latest visit.",
  visits: "All its visits (a page load, or coming back after 30 minutes away).",
  daysWithVisits: "How many different days it visited.",
  visitNumberOnDevice: "How many visits the device itself counts, including those before visitors were listed (22 November 2026).",
  visitTimes: "Each visit, oldest first, at the park (the latest 100 are kept).",
  secondsOnPage: "Time on the page in all, in seconds.",
  looks: "How many looks that time is made of.",
  presses: "Buttons and links it pressed, with how many times.",
  kind: "Phone, tablet or computer, from its latest visit.",
  system: "Operating system, from its latest visit.",
  browser: "Browser, from its latest visit.",
  place: "Rough place, from its latest visit.",
  network: "Internet provider or network, from its latest visit.",
};

function stamp(ms, zone) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return null;
  const { date, minute } = localTime(ms, zone);
  return `${date} ${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

/** Presses with their names as the stats page shows them. */
function named(presses) {
  const out = {};
  for (const [name, count] of Object.entries(presses || {})) {
    const words = label(name);
    out[words] = (out[words] || 0) + count;
  }
  return out;
}

function addTo(total, list) {
  for (const [name, count] of Object.entries(list || {})) total[name] = (total[name] || 0) + count;
}

/** A day's numbers and lists in the file's words. */
function dayOf(date, day) {
  const out = { date };
  for (const [from, to] of NUMBERS) out[to] = day[from] || 0;
  for (const [from, to] of LISTS) out[to] = from === "presses" ? named(day[from]) : { ...(day[from] || {}) };
  return out;
}

function totalOf(days) {
  const out = {};
  for (const [, to] of NUMBERS) out[to] = 0;
  for (const [, to] of LISTS) out[to] = {};
  out.daysWithData = days.length;
  for (const day of days) {
    for (const [, to] of NUMBERS) out[to] += day[to];
    for (const [, to] of LISTS) addTo(out[to], day[to]);
  }
  // Devices add up day by day, so a device that came on three days counts three times.
  out.deviceDays = out.differentDevices;
  delete out.differentDevices;
  return out;
}

/**
 * The file: `days` as the counter keeps them ([date, numbers] pairs, oldest
 * first), `rows` as the counter keeps visitors ({ id, ...row }), the park's
 * time zone, the page's address and the time now.
 */
export function statsExport(days, rows, { zone, siteUrl, now }) {
  const allDays = days.map(([date, day]) => dayOf(date, day));
  const months = new Map();
  for (const day of allDays) {
    const month = day.date.slice(0, 7);
    if (!months.has(month)) months.set(month, []);
    months.get(month).push(day);
  }
  const visitors = [...rows]
    .sort((a, b) => (a.firstAt || 0) - (b.firstAt || 0) || String(a.id).localeCompare(String(b.id)))
    .map((row, index) => ({
      visitor: index + 1,
      group: row.mine ? "own device" : row.robot ? "automated" : "person",
      firstVisit: stamp(row.firstAt, zone),
      firstCameBy: row.came || null,
      lastVisit: stamp(row.lastAt, zone),
      lastCameBy: row.lastCame || row.came || null,
      visits: row.visits || 0,
      daysWithVisits: row.days || 0,
      visitNumberOnDevice: row.nth ?? null,
      visitTimes: (row.times || []).map((at) => stamp(at, zone)),
      secondsOnPage: row.seconds || 0,
      looks: row.looks || 0,
      presses: named(row.presses),
      kind: row.kind || null,
      system: row.system || null,
      browser: row.browser || null,
      place: row.place || null,
      network: row.network || null,
    }));
  // Latest visit first, the way the stats page lists them.
  visitors.sort((a, b) => String(b.lastVisit).localeCompare(String(a.lastVisit)) || a.visitor - b.visitor);

  return {
    about: {
      what: `Visit statistics for ${siteUrl}, a page that says whether Citizens Park in Richmond, Victoria is booked (and so closed to off-lead dogs).`,
      exported: stamp(now, zone),
      timeZone: zone,
      countingSince: allDays.length ? allDays[0].date : null,
      visitorsListedSince: "2026-11-22",
      notes: [
        "Every time in this file is local time at the park, written as YYYY-MM-DD HH:MM.",
        "Counted by the page itself, with no cookies and no outside service. No internet addresses are kept.",
        "A device is recognised by a random number it keeps in its own browser. A private window, another browser on the same phone or a cleared browser looks like a new device, so devices can be more than people.",
        "Own visits (the owner's browsers, marked with ?me) and visits that look automated are kept out of the main numbers and counted on their own.",
        "Lists other than visits, devices and presses (hours, sources, devices, places, time on page) start on 2026-11-22; earlier days have only the main numbers.",
        "Each list keeps at most 60 names a day; the rest are under \"other\".",
      ],
      fields: {
        day: Object.fromEntries([["date", "The day, at the park."], ...NUMBERS.map(([, to, words]) => [to, words]), ...LISTS.map(([, to, words]) => [to, words])]),
        totals: "The same numbers added up over all days (\"deviceDays\" counts a device once for each day it came), plus \"daysWithData\".",
        visitor: VISITOR_FIELDS,
      },
    },
    totals: {
      allTime: totalOf(allDays),
      byMonth: [...months.entries()].map(([month, its]) => ({ month, ...totalOf(its) })),
    },
    days: allDays,
    visitors,
  };
}

// The same file as Excel sheets, for a spreadsheet program: one row per
// month, per day, per visitor and per visit, and the day's lists in one long
// table that a pivot table can sum.
const HEADINGS = {
  visits: "Visits",
  differentDevices: "Different devices",
  newThisMonth: "New this month",
  firstTimeDevices: "First-time devices",
  returningDevices: "Returning devices",
  automatedVisits: "Automated visits",
  ownVisits: "Own visits",
  presses: "Buttons and links pressed",
  visitsByHour: "Visits by hour",
  returningVisitsByHour: "Returning visits by hour",
  daysSinceLastVisit: "Days since last visit",
  visitNumber: "Visit number",
  foundBy: "Found by",
  timeOnPage: "Time on page",
  deviceKinds: "Device kinds",
  systems: "Systems",
  browsers: "Browsers",
  places: "Places",
  networks: "Networks",
  automatedReasons: "Why automated",
  automatedNetworks: "Automated networks",
};
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function sum(list) {
  return Object.values(list || {}).reduce((total, count) => total + count, 0);
}

function pressText(presses) {
  return Object.entries(presses || {})
    .map(([name, count]) => (count > 1 ? `${name} ×${count}` : name))
    .join("; ");
}

/** Sheets for xlsx() from the file statsExport() makes. */
export function statsSheets(file) {
  const numbers = NUMBERS.map(([, to]) => to);
  const lists = LISTS.map(([, to]) => to);
  const about = [
    ["About", "Details"],
    ["What", file.about.what],
    ["Exported", file.about.exported ? { date: file.about.exported } : null],
    ["Time zone", `${file.about.timeZone} (every time in this file is local time at the park)`],
    ["Counting since", file.about.countingSince ? { date: file.about.countingSince } : null],
    ["Visitors listed since", { date: file.about.visitorsListedSince }],
    ...file.about.notes.map((note) => ["Note", note]),
    [null, null],
    ["Sheet", "What it holds"],
    ["Months", "Totals for each month. Device-days counts a device once for each day it came."],
    ["Days", "One row per day."],
    ["Visitors", "One row per device, latest visit first. Visitors are numbered by when they first came."],
    ["Visits", "One row per visit by a listed visitor (the latest 100 per visitor are kept)."],
    ["Breakdowns", "Each day's lists (buttons, hours, how they found the page, devices, places...) as rows of date, list, name and count."],
    [null, null],
    ["Field", "Meaning"],
    ...numbers.map((to) => [HEADINGS[to], file.about.fields.day[to]]),
    ...lists.map((to) => [HEADINGS[to], file.about.fields.day[to]]),
    ...Object.entries(file.about.fields.visitor).map(([name, words]) => [`Visitor: ${name}`, words]),
  ];
  const months = [
    ["Month", "Visits", "Device-days", ...numbers.filter((to) => to !== "visits" && to !== "differentDevices").map((to) => HEADINGS[to]), "Presses", "Days with data"],
    ...file.totals.byMonth.map((one) => [
      one.month,
      one.visits,
      one.deviceDays,
      ...numbers.filter((to) => to !== "visits" && to !== "differentDevices").map((to) => one[to]),
      sum(one.presses),
      one.daysWithData,
    ]),
  ];
  const days = [
    ["Date", "Weekday", ...numbers.map((to) => HEADINGS[to]), "Presses"],
    ...file.days.map((one) => [{ date: one.date }, WEEKDAYS[new Date(`${one.date}T00:00:00Z`).getUTCDay()], ...numbers.map((to) => one[to]), sum(one.presses)]),
  ];
  const visitors = [
    [
      "Visitor",
      "Group",
      "First visit",
      "First came by",
      "Last visit",
      "Last came by",
      "Visits",
      "Days with visits",
      "Visit number on device",
      "Minutes on page",
      "Looks",
      "Presses",
      "What it pressed",
      "Kind",
      "System",
      "Browser",
      "Place",
      "Network",
    ],
    ...file.visitors.map((one) => [
      one.visitor,
      one.group,
      one.firstVisit ? { date: one.firstVisit } : null,
      one.firstCameBy,
      one.lastVisit ? { date: one.lastVisit } : null,
      one.lastCameBy,
      one.visits,
      one.daysWithVisits,
      one.visitNumberOnDevice,
      Math.round((one.secondsOnPage / 60) * 10) / 10,
      one.looks,
      sum(one.presses),
      pressText(one.presses),
      one.kind,
      one.system,
      one.browser,
      one.place,
      one.network,
    ]),
  ];
  const visits = [["Visitor", "Group", "Visit time", "Date", "Weekday", "Hour"]];
  for (const one of [...file.visitors].sort((a, b) => a.visitor - b.visitor)) {
    for (const time of one.visitTimes) {
      if (!time) continue;
      const date = time.slice(0, 10);
      visits.push([one.visitor, one.group, { date: time }, { date }, WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()], Number(time.slice(11, 13))]);
    }
  }
  const breakdowns = [["Date", "List", "Name", "Count"]];
  for (const one of file.days) {
    for (const to of lists) {
      for (const [name, count] of Object.entries(one[to] || {})) breakdowns.push([{ date: one.date }, HEADINGS[to], name, count]);
    }
  }
  return [
    { name: "About", rows: about, widths: [26, 110] },
    { name: "Months", rows: months, widths: [10, 8, 12, 15, 18, 18, 17, 11, 9, 14] },
    { name: "Days", rows: days, widths: [12, 11, 8, 17, 15, 18, 18, 17, 11, 9] },
    { name: "Visitors", rows: visitors, widths: [8, 11, 17, 24, 17, 24, 7, 15, 20, 15, 7, 8, 40, 10, 10, 14, 24, 24] },
    { name: "Visits", rows: visits, widths: [8, 11, 17, 12, 11, 6] },
    { name: "Breakdowns", rows: breakdowns, widths: [12, 24, 40, 7] },
  ];
}
