// The book of devices and the daily sending, tried with stand-ins for the
// storage, the clock, the notification services and the page.

import assert from "node:assert/strict";
import { test } from "node:test";

import { BATCH, Book, MOST_DEVICES } from "../src/book.js";
import { SITE, at, clock, day, memoryStorage, newDevice, pageData, readProof, runAlarms, settings, world } from "./standins.js";

const TODAY = "2026-11-20";
const MINUTE = 60 * 1000;

/** The page's data after the check that goes with the alert has run on `date`, a Friday unless told otherwise. */
function checked(date = TODAY, time = "15:02") {
  return pageData({
    generated: `${date}T${time}:00+11:00`,
    days: [day(date, "Booked 5 PM to 7:30 PM", "Cricket training.\nRain likely between 3 PM and 8 PM.")],
  });
}

async function open({ page = null, answer, start = at(TODAY, "14:00"), storage = memoryStorage(), pause } = {}) {
  const time = clock(start);
  const net = world({ page, answer, pause });
  const lines = [];
  const book = new Book({ storage, fetch: net.fetch, now: time.now, settings, log: (line) => lines.push(line) });
  await book.open();
  return { book, storage, time, net, lines };
}

/** Write devices straight into the book, as if they had turned alerts on some days ago. */
async function seed(it, count, host = "fcm.googleapis.com", extra = {}) {
  const devices = [];
  for (let index = 0; index < count; index += 1) {
    const device = newDevice(host);
    const name = await it.book.name(device.endpoint);
    await it.storage.put(name, { endpoint: device.endpoint, ...device.subscription.keys, added: 1, fails: 0, ...extra });
    devices.push(Object.assign(device, { name }));
  }
  await it.storage.put("count", ((await it.storage.get("count")) || 0) + count);
  return devices;
}

/** Let the timer look once and run every round of sending that follows. */
async function lookAt(it, time = "15:05", date = TODAY) {
  it.time.set(at(date, time));
  const said = await it.book.tick();
  const rounds = await runAlarms(it.book, it.storage, it.time);
  return { said: said.body, rounds };
}

const entry = async (it, device) => it.storage.get(device.name || (await it.book.name(device.endpoint)));

test("the signing keys are made once, kept, and never handed out", async () => {
  const first = await open();
  const key = first.book.key();
  assert.equal(key.status, 200);
  assert.equal(key.body.ok, true);
  assert.equal(Buffer.from(key.body.key, "base64url").length, 65);
  assert.equal(first.storage.kept.get("vapid").publicKey, key.body.key);
  assert.equal(JSON.stringify(key.body).includes(first.storage.kept.get("vapid").privateJwk.d), false);

  const again = await open({ storage: first.storage });
  assert.equal(again.book.key().body.key, key.body.key);
  const other = await open();
  assert.notEqual(other.book.key().body.key, key.body.key);
});

test("a new device gets a first notification and is then written into the book", async () => {
  const it = await open({ start: at(TODAY, "10:00") });
  const phone = newDevice("web.push.apple.com");
  const said = await it.book.subscribe({ subscription: phone.subscription });
  assert.deepEqual(said, { status: 201, body: { ok: true, new: true } });

  assert.equal(it.net.calls.length, 1);
  const [push] = it.net.pushesTo(phone);
  assert.equal(push.options.method, "POST");
  assert.equal(push.headers.TTL, "3600");
  assert.equal(push.headers.Topic, "welcome");
  assert.equal(push.headers.Urgency, "high");
  assert.equal(push.headers["Content-Encoding"], "aes128gcm");

  const proof = readProof(push.headers.Authorization);
  assert.equal(proof.valid, true);
  assert.equal(proof.key, it.book.key().body.key);
  assert.deepEqual(proof.claims, { aud: "https://web.push.apple.com", exp: at(TODAY, "10:00") / 1000 + 12 * 3600, sub: SITE });

  assert.deepEqual(phone.words(push.body), {
    web_push: 8030,
    notification: {
      title: "Alerts are on",
      body: "You'll get one notification a day, at about 3 PM on weekdays and 8 AM on weekends, saying when the oval is booked.",
      navigate: SITE,
      tag: "welcome",
      renotify: true,
      lang: "en-AU",
      icon: `${SITE}icon-192.png`,
      badge: `${SITE}badge.png`,
    },
  });

  assert.deepEqual(await entry(it, phone), { endpoint: phone.endpoint, ...phone.subscription.keys, added: at(TODAY, "10:00"), fails: 0 });
  assert.equal(it.storage.kept.get("count"), 1);
  assert.equal((await it.book.status()).body.devices, 1);
  assert.deepEqual(it.lines, ["a device was added"]);
});

test("the same device again changes nothing and gets no second notification", async () => {
  const it = await open();
  const phone = newDevice();
  await it.book.subscribe({ subscription: phone.subscription });
  const said = await it.book.subscribe({ subscription: phone.subscription });
  assert.deepEqual(said, { status: 200, body: { ok: true, new: false } });
  assert.equal(it.net.pushes.length, 1);
  assert.equal(it.storage.kept.get("count"), 1);
  assert.equal(it.storage.devices().length, 1);
});

test("nothing but the address and its two keys is kept for a device", async () => {
  const it = await open();
  const phone = newDevice();
  await it.book.subscribe({ subscription: { ...phone.subscription, name: "Sam", userAgent: "a browser" }, name: "Sam", location: "Richmond" });
  const [[name, kept]] = it.storage.devices();
  assert.deepEqual(Object.keys(kept).sort(), ["added", "auth", "endpoint", "fails", "p256dh"]);
  // The name it is filed under is a fingerprint of the address, not the address.
  assert.match(name, /^sub:[\w-]{43}$/);
  assert.equal(name.includes(phone.endpoint.slice(-10)), false);
  assert.equal(JSON.stringify([...it.storage.kept]).includes("Sam"), false);
});

test("what is not an address with keys is turned down, and nothing is sent or kept", async () => {
  const it = await open();
  const phone = newDevice();
  const wrong = [null, undefined, "text", {}, { subscription: null }, { subscription: {} }, { subscription: { endpoint: phone.endpoint } }, phone.subscription];
  for (const given of wrong) {
    assert.deepEqual(await it.book.subscribe(given), { status: 400, body: { ok: false, reason: "bad" } }, JSON.stringify(given));
  }
  assert.equal(it.net.calls.length, 0);
  assert.equal(it.storage.devices().length, 0);
});

test("an address at an unknown notification service is turned down, and the service's name is noted", async () => {
  const it = await open();
  const said = await it.book.subscribe({ subscription: newDevice("push.example.org").subscription });
  assert.deepEqual(said, { status: 400, body: { ok: false, reason: "host" } });
  await it.book.subscribe({ subscription: newDevice("push.example.org").subscription });
  assert.deepEqual((await it.book.status()).body.unknownServices, { "push.example.org": 2 });
  assert.equal(it.net.calls.length, 0);
  assert.equal(it.storage.devices().length, 0);
});

test("only a plain host name is noted, because the status page shows it to anyone", async () => {
  const it = await open();
  for (const host of ["a```b.example", "[::1]", "a_b.example", "a".repeat(81) + ".example"]) {
    const device = newDevice("fcm.googleapis.com");
    const endpoint = device.endpoint.replace("fcm.googleapis.com", host);
    const said = await it.book.subscribe({ subscription: { ...device.subscription, endpoint } });
    assert.deepEqual(said, { status: 400, body: { ok: false, reason: "host" } }, host);
  }
  assert.deepEqual((await it.book.status()).body.unknownServices, {});
  assert.equal(it.storage.kept.has("hosts"), false);
});

test("the list of unknown services stays short, and its counts stop", async () => {
  const it = await open();
  for (let index = 0; index < 14; index += 1) {
    await it.book.subscribe({ subscription: newDevice(`push${index}.example.org`).subscription });
  }
  const noted = (await it.book.status()).body.unknownServices;
  assert.equal(Object.keys(noted).length, 10);
  assert.equal(noted["push0.example.org"], 1);
  assert.equal(noted["push13.example.org"], undefined);

  for (let index = 0; index < 150; index += 1) {
    await it.book.subscribe({ subscription: newDevice("push0.example.org").subscription });
  }
  assert.equal((await it.book.status()).body.unknownServices["push0.example.org"], 100);
  // After that, a made-up address makes this backend write nothing at all.
  const writes = it.storage.writes;
  await it.book.subscribe({ subscription: newDevice("push0.example.org").subscription });
  await it.book.subscribe({ subscription: newDevice("another.example.org").subscription });
  assert.equal(it.storage.writes, writes);
  // A name such as "constructor" is noted like any other.
  const fresh = await open();
  await fresh.book.subscribe({ subscription: newDevice("constructor").subscription });
  assert.deepEqual((await fresh.book.status()).body.unknownServices, { constructor: 1 });
});

test("an address the notification service does not take is not written in", async () => {
  for (const status of [404, 410, 400, 401, 403]) {
    const it = await open({ answer: () => status });
    const said = await it.book.subscribe({ subscription: newDevice().subscription });
    assert.deepEqual(said, { status: 410, body: { ok: false, reason: "gone" } }, String(status));
    assert.equal(it.net.pushes.length, 1);
    assert.equal(it.storage.devices().length, 0);
    assert.equal((await it.book.status()).body.devices, 0);
  }
});

test("while a notification service is in trouble, a new device is asked to try again later", async () => {
  for (const trouble of [429, 500, 503, "down"]) {
    const it = await open({ answer: () => trouble });
    const said = await it.book.subscribe({ subscription: newDevice().subscription });
    assert.deepEqual(said, { status: 503, body: { ok: false, reason: "later" } }, String(trouble));
    assert.equal(it.storage.devices().length, 0);
  }
});

test("if the proof cannot be signed, the device is asked to try later and the address is not blamed", async () => {
  const it = await open();
  it.book.keys = { ...it.book.keys, privateKey: null };
  const said = await it.book.subscribe({ subscription: newDevice().subscription });
  assert.deepEqual(said, { status: 503, body: { ok: false, reason: "later" } });
  assert.equal(it.net.calls.length, 0);
});

test("the book takes on no more devices than it can carry", async () => {
  const it = await open();
  const known = newDevice();
  await it.book.subscribe({ subscription: known.subscription });
  await it.storage.put("count", MOST_DEVICES);
  const said = await it.book.subscribe({ subscription: newDevice().subscription });
  assert.deepEqual(said, { status: 503, body: { ok: false, reason: "full" } });
  assert.equal(it.net.pushes.length, 1);
  // A device that is already in the book is still answered.
  assert.deepEqual(await it.book.subscribe({ subscription: known.subscription }), { status: 200, body: { ok: true, new: false } });
  assert.equal(MOST_DEVICES, 5000);
});

test("at most thirty first notifications go out in a minute", async () => {
  const it = await open();
  for (let index = 0; index < 30; index += 1) {
    it.time.forward(1000);
    assert.equal((await it.book.subscribe({ subscription: newDevice().subscription })).status, 201);
  }
  it.time.forward(1000);
  const said = await it.book.subscribe({ subscription: newDevice().subscription });
  assert.deepEqual(said, { status: 429, body: { ok: false, reason: "later" } });
  assert.equal(it.net.pushes.length, 30);
  // A minute after the first of them, there is room again.
  it.time.forward(30 * 1000);
  assert.equal((await it.book.subscribe({ subscription: newDevice().subscription })).status, 201);
  assert.equal(it.storage.kept.get("count"), 31);
});

test("a device that turns alerts off is taken out of the book", async () => {
  const it = await open();
  const phone = newDevice();
  const other = newDevice();
  await it.book.subscribe({ subscription: phone.subscription });
  await it.book.subscribe({ subscription: other.subscription });

  // However the address is written, it finds the same entry.
  const said = await it.book.unsubscribe({ endpoint: phone.endpoint.replace("fcm.googleapis.com", "FCM.GoogleAPIs.com") });
  assert.deepEqual(said, { status: 200, body: { ok: true } });
  assert.equal(await entry(it, phone), undefined);
  assert.notEqual(await entry(it, other), undefined);
  assert.equal(it.storage.kept.get("count"), 1);

  // The answer is the same for an address that is not in the book, so nobody can find out whether one is.
  assert.deepEqual(await it.book.unsubscribe({ endpoint: phone.endpoint }), { status: 200, body: { ok: true } });
  assert.deepEqual(await it.book.unsubscribe({ endpoint: newDevice().endpoint }), { status: 200, body: { ok: true } });
  assert.equal(it.storage.kept.get("count"), 1);

  for (const wrong of [null, {}, { endpoint: 5 }, { endpoint: "not an address" }]) {
    assert.deepEqual(await it.book.unsubscribe(wrong), { status: 400, body: { ok: false, reason: "bad" } });
  }
  assert.deepEqual(it.lines, ["a device was added", "a device was added", "a device was removed"]);
});

test("the timer does nothing before the alert time, after the window, or with no device to tell", async () => {
  const it = await open({ page: checked() });
  const nothing = (why) => ({ status: 200, body: { ok: true, did: "nothing", why } });

  it.time.set(at(TODAY, "14:35"));
  assert.deepEqual(await it.book.tick(), nothing("no device to tell"));
  assert.equal(it.net.calls.length, 0);

  await seed(it, 1);
  it.time.set(at(TODAY, "14:29"));
  assert.deepEqual(await it.book.tick(), nothing("too early"));
  it.time.set(at(TODAY, "19:00"));
  assert.deepEqual(await it.book.tick(), nothing("too late"));
  it.time.set(at(TODAY, "23:55"));
  assert.deepEqual(await it.book.tick(), nothing("too late"));
  assert.equal(it.net.calls.length, 0);
  assert.equal(it.storage.alarm, null);

  // What the timer last did is kept for the status page.
  assert.deepEqual((await it.book.status()).body.timer, { at: at(TODAY, "23:55"), did: "nothing", why: "too late" });
});

test("the timer waits for the check before the alert, then starts the alert", async () => {
  const morning = pageData({ generated: `${TODAY}T11:47:00+11:00`, days: [day(TODAY)] });
  const it = await open({ page: morning });
  await seed(it, 3);

  it.time.set(at(TODAY, "14:30"));
  assert.deepEqual((await it.book.tick()).body, { ok: true, did: "nothing", why: "waiting for the check before the alert" });
  it.time.set(at(TODAY, "14:55"));
  assert.deepEqual((await it.book.tick()).body, { ok: true, did: "nothing", why: "waiting for the check before the alert" });
  assert.equal(it.net.pushes.length, 0);
  // One look at the page's data each time, and past any copy kept on the way.
  assert.equal(it.net.reads.length, 2);
  assert.equal(it.net.reads[1].url, `${SITE}data.json?t=${at(TODAY, "14:55")}`);

  it.net.page = checked(TODAY, "14:58");
  it.time.set(at(TODAY, "15:00"));
  assert.deepEqual((await it.book.tick()).body, { ok: true, did: "started", fresh: true });
  assert.equal(it.storage.alarm, at(TODAY, "15:00"));
  assert.deepEqual((await it.book.status()).body.timer, { at: at(TODAY, "15:00"), did: "started", why: "" });
  assert.equal((await it.book.status()).body.sending, true);
  assert.deepEqual(it.lines, ["today's alert started (after a fresh check)"]);
});

test("today's alert goes to every device, forty at a time, and only once", async () => {
  const it = await open({ page: checked(), pause: 1 });
  const devices = [...(await seed(it, 60)), ...(await seed(it, 25, "web.push.apple.com")), ...(await seed(it, 10, "updates.push.services.mozilla.com"))];

  const { said, rounds } = await lookAt(it, "15:05");
  assert.deepEqual(said, { ok: true, did: "started", fresh: true });
  // Three rounds, a second apart: 40, 40 and 15.
  assert.deepEqual(rounds, [at(TODAY, "15:05"), at(TODAY, "15:05") + 1000, at(TODAY, "15:05") + 2000]);
  assert.equal(it.net.pushes.length, 95);
  assert.equal(BATCH, 40);

  for (const device of devices) {
    const pushes = it.net.pushesTo(device);
    assert.equal(pushes.length, 1);
    assert.equal(pushes[0].headers.TTL, "14400");
    assert.equal(pushes[0].headers.Topic, "daily");
    const proof = readProof(pushes[0].headers.Authorization);
    assert.equal(proof.valid, true);
    assert.equal(proof.claims.aud, `https://${device.host}`);
    assert.deepEqual(device.words(pushes[0].body).notification, {
      title: "Booked 5 PM to 7:30 PM",
      body: "Cricket training.\nRain likely between 3 PM and 8 PM.",
      navigate: SITE,
      tag: "daily",
      renotify: true,
      lang: "en-AU",
      icon: `${SITE}icon-192.png`,
      badge: `${SITE}badge.png`,
    });
  }
  // A few at a time, never a crowd.
  assert.ok(it.net.mostFlying > 1, "sends one at a time");
  assert.ok(it.net.mostFlying <= 5, `${it.net.mostFlying} at once`);

  const status = (await it.book.status()).body;
  assert.equal(status.sending, false);
  assert.deepEqual(status.last, {
    date: TODAY,
    how: "finished",
    fresh: true,
    startedAt: at(TODAY, "15:05"),
    finishedAt: at(TODAY, "15:05") + 2000,
    sent: 95,
    gone: 0,
    refused: 0,
    failed: 0,
    devices: 95,
  });
  assert.equal(it.lines.at(-1), "today's alert finished: 95 sent, 0 gone, 0 refused, 0 failed, 95 devices in the book");

  // The timer keeps looking all afternoon, and nothing more goes out.
  for (const time of ["15:10", "15:15", "17:00", "18:55"]) {
    const later = await lookAt(it, time);
    assert.deepEqual(later.said, { ok: true, did: "nothing", why: "today's alert has gone out" });
    assert.deepEqual(later.rounds, []);
  }
  assert.equal(it.net.pushes.length, 95);
  assert.equal(it.net.reads.length, 1);
});

test("no waking makes more outgoing requests than Cloudflare's free plan allows", async () => {
  // Fifty for each waking. Here every device is asked to wait, so that the later rounds are counted too.
  const it = await open({ page: checked(), answer: () => 503 });
  await seed(it, 130);
  it.time.set(at(TODAY, "15:05"));
  let before = it.net.calls.length;
  await it.book.tick();
  assert.equal(it.net.calls.length - before, 1);

  let rounds = 0;
  while (it.storage.alarm !== null) {
    it.time.set(Math.max(it.time.now(), it.storage.alarm));
    it.storage.alarm = null;
    before = it.net.calls.length;
    await it.book.alarm();
    rounds += 1;
    assert.ok(it.net.calls.length - before <= 40, `${it.net.calls.length - before} requests in one round`);
  }
  // 130 devices in rounds of 40, three times over: the first try and two more.
  assert.equal(rounds, 12);
  assert.equal(it.net.pushes.length, 390);
  assert.equal((await it.book.status()).body.last.failed, 130);
});

test("the alert goes out again the next day", async () => {
  const it = await open({ page: checked() });
  const devices = await seed(it, 2);
  await lookAt(it, "15:05");
  assert.equal(it.net.pushes.length, 2);

  // Early the next morning, with yesterday's data still on the page: nothing.
  assert.deepEqual((await lookAt(it, "07:00", "2026-11-21")).said, { ok: true, did: "nothing", why: "too early" });

  // The next day is a Saturday, and its alert is a morning one.
  it.net.page = pageData({ generated: "2026-11-21T07:56:00+11:00", days: [day("2026-11-20", "Yesterday's"), day("2026-11-21", "No bookings today", "")] });
  const next = await lookAt(it, "08:00", "2026-11-21");
  assert.deepEqual(next.said, { ok: true, did: "started", fresh: true });
  assert.equal(it.net.pushes.length, 4);
  assert.equal(devices[0].words(it.net.pushesTo(devices[0])[1].body).notification.title, "No bookings today");
  assert.equal((await it.book.status()).body.last.date, "2026-11-21");
  // The afternoon's checks on that Saturday change nothing: one alert a day.
  it.net.page = checked("2026-11-21", "15:56");
  assert.deepEqual((await lookAt(it, "16:00", "2026-11-21")).said, { ok: true, did: "nothing", why: "today's alert has gone out" });
  assert.equal(it.net.pushes.length, 4);
});

test("each day of the week gets its alert at its own time: the afternoon on weekdays, the morning at the weekend", async () => {
  const it = await open({ page: checked() });
  await seed(it, 1);
  const sent = [];
  // Friday 20 to Monday 23 November 2026. The check that goes with the alert runs a few minutes before each look.
  const looks = [
    ["2026-11-20", "07:55", "08:00", "too early"], // 8 AM is the weekend's time
    ["2026-11-20", "14:56", "15:00", "started"],
    ["2026-11-21", "06:35", "07:25", "too early"],
    ["2026-11-21", "07:56", "08:00", "started"],
    ["2026-11-21", "14:56", "15:00", "today's alert has gone out"],
    ["2026-11-22", "07:56", "08:00", "started"],
    ["2026-11-23", "07:56", "08:00", "too early"],
    ["2026-11-23", "14:56", "15:00", "started"],
  ];
  for (const [date, madeAt, time, expected] of looks) {
    it.net.page = checked(date, madeAt);
    const { said } = await lookAt(it, time, date);
    assert.equal(said.did === "started" ? "started" : said.why, expected, `${date} ${time}`);
    if (said.did === "started") {
      assert.equal(said.fresh, true, `${date} ${time}`);
      sent.push(`${date} ${time}`);
    }
  }
  assert.deepEqual(sent, ["2026-11-20 15:00", "2026-11-21 08:00", "2026-11-22 08:00", "2026-11-23 15:00"]);
  assert.equal(it.net.pushes.length, 4);
});

test("if no check has run 45 minutes after the alert time, the alert goes out with what the page has", async () => {
  const morning = pageData({ generated: `${TODAY}T11:47:00+11:00`, generatedText: "11:47 AM", days: [day(TODAY, "Booked 5 PM to 7:30 PM", "Cricket training.")] });
  const it = await open({ page: morning });
  const [phone] = await seed(it, 1);

  assert.equal((await lookAt(it, "15:14")).said.why, "waiting for the check before the alert");
  const late = await lookAt(it, "15:15");
  assert.deepEqual(late.said, { ok: true, did: "started", fresh: false });
  // Made this morning, so it is today's notice as it stands.
  assert.deepEqual(phone.words(it.net.pushesTo(phone)[0].body).notification.body, "Cricket training.");
  assert.equal((await it.book.status()).body.last.fresh, false);
  assert.equal(it.lines[0], "today's alert started (without a fresh check)");
});

test("at the weekend the same wait ends a quarter of an hour after 8 AM", async () => {
  const saturday = "2026-11-21";
  // Only the 6:17 AM check has run. It wrote today's notice for the morning alert.
  const early = pageData({ generated: `${saturday}T06:35:00+11:00`, generatedText: "6:35 AM", days: [day(saturday, "Booked 10 AM to 6 PM", "No rain expected for the rest of today.")] });
  const it = await open({ page: early, start: at(saturday, "06:40") });
  const [phone] = await seed(it, 1);

  assert.equal((await lookAt(it, "07:25", saturday)).said.why, "too early");
  assert.equal((await lookAt(it, "07:30", saturday)).said.why, "waiting for the check before the alert");
  assert.equal((await lookAt(it, "08:10", saturday)).said.why, "waiting for the check before the alert");
  assert.deepEqual((await lookAt(it, "08:15", saturday)).said, { ok: true, did: "started", fresh: false });
  const { notification } = phone.words(it.net.pushesTo(phone)[0].body);
  assert.deepEqual([notification.title, notification.body], ["Booked 10 AM to 6 PM", "No rain expected for the rest of today."]);
});

test("an alert that could not go out by the evening is left out for the day, at the weekend too", async () => {
  for (const date of ["2026-11-20", "2026-11-21"]) {
    const it = await open({ page: "down", start: at(date, "06:00") });
    await seed(it, 1);
    assert.match((await lookAt(it, "18:55", date)).said.why, /could not be read/);
    it.net.page = checked(date, "18:58");
    assert.deepEqual((await lookAt(it, "19:00", date)).said, { ok: true, did: "nothing", why: "too late" });
    assert.equal(it.net.pushes.length, 0);
  }
});

test("an alert made from another day's data says that it may be out of date", async () => {
  const stale = pageData({
    generated: "2026-11-19T19:47:00+11:00",
    generatedText: "Thu 19 Nov, 7:47 PM",
    days: [day("2026-11-19", "Yesterday's"), day(TODAY, "Booked 5 PM to 7:30 PM", "Cricket training.")],
  });
  const it = await open({ page: stale });
  const [phone] = await seed(it, 1);
  await lookAt(it, "15:20");
  const { notification } = phone.words(it.net.pushesTo(phone)[0].body);
  assert.equal(notification.title, "Booked 5 PM to 7:30 PM");
  assert.equal(notification.body, "Cricket training.\n⚠️ The page has not been updated since Thu 19 Nov, 7:47 PM, so this may be out of date.");
});

test("when the page's data cannot be read, the timer tries again at its next look", async () => {
  const it = await open({ page: "down" });
  const [phone] = await seed(it, 1);
  assert.match((await lookAt(it, "15:05")).said.why, /^the page's data could not be read \(fetch failed\)$/);
  it.net.page = 404;
  assert.match((await lookAt(it, "15:10")).said.why, /could not be read \(the page's data answered 404\)/);
  it.net.page = "<html>not the data</html>";
  assert.match((await lookAt(it, "15:15")).said.why, /could not be read/);
  it.net.page = "[1, 2]";
  assert.equal((await lookAt(it, "15:17")).said.why, "the page has no notice for today");
  it.net.page = "null";
  assert.match((await lookAt(it, "15:18")).said.why, /could not be read \(the page's data is not what was expected\)/);
  assert.equal(it.net.pushes.length, 0);
  assert.equal((await it.book.status()).body.last, null);

  // The day is not used up: once the page is back, the alert goes out.
  it.net.page = checked(TODAY, "15:19");
  assert.equal((await lookAt(it, "15:20")).said.did, "started");
  assert.equal(it.net.pushesTo(phone).length, 1);
});

test("a page with no notice for today sends nothing, and the day is not used up", async () => {
  const it = await open({ page: pageData({ generated: `${TODAY}T15:02:00+11:00`, days: [day("2026-11-21")] }) });
  await seed(it, 1);
  assert.equal((await lookAt(it, "15:05")).said.why, "the page has no notice for today");
  it.net.page = checked(TODAY, "15:06");
  assert.equal((await lookAt(it, "15:10")).said.did, "started");
  assert.equal(it.net.pushes.length, 1);
});

test("a device whose address is gone is taken out of the book", async () => {
  const gone = new Set();
  const it = await open({ page: checked(), answer: (url) => (gone.has(url) ? 410 : 201) });
  const devices = await seed(it, 5);
  gone.add(devices[1].endpoint);
  gone.add(devices[3].endpoint);
  await lookAt(it);

  const { last, devices: count } = (await it.book.status()).body;
  assert.equal(last.sent, 3);
  assert.equal(last.gone, 2);
  assert.equal(last.devices, 3);
  assert.equal(count, 3);
  assert.equal(await entry(it, devices[1]), undefined);
  assert.equal(await entry(it, devices[3]), undefined);
  assert.notEqual(await entry(it, devices[0]), undefined);
});

/** Run the alert on `count` days in a row, starting on 20 November. */
async function days(it, count, first = 0) {
  for (let index = first; index < first + count; index += 1) {
    const date = `2026-11-${20 + index}`;
    it.net.page = checked(date);
    assert.equal((await lookAt(it, "15:05", date)).said.did, "started", date);
  }
}

test("an address that is refused five days running is dropped, while its service takes messages for others", async () => {
  const refused = new Set();
  const it = await open({ answer: (url) => (refused.has(url) ? 403 : 201) });
  const devices = await seed(it, 3);
  refused.add(devices[0].endpoint);

  await days(it, 4);
  assert.equal((await entry(it, devices[0])).fails, 4);
  assert.equal((await entry(it, devices[1])).fails, 0);
  assert.equal((await it.book.status()).body.last.refused, 1);
  assert.equal((await it.book.status()).body.devices, 3);

  await days(it, 1, 4);
  assert.equal(await entry(it, devices[0]), undefined);
  assert.equal((await it.book.status()).body.devices, 2);
});

test("an address that gets through again starts with a clean sheet", async () => {
  const refused = new Set();
  const it = await open({ answer: (url) => (refused.has(url) ? 400 : 201) });
  const devices = await seed(it, 2);
  refused.add(devices[0].endpoint);
  await days(it, 4);
  assert.equal((await entry(it, devices[0])).fails, 4);
  refused.clear();
  await days(it, 1, 4);
  assert.equal((await entry(it, devices[0])).fails, 0);
  refused.add(devices[0].endpoint);
  await days(it, 4, 5);
  assert.equal((await entry(it, devices[0])).fails, 4);
});

test("if a notification service refuses every message, nobody is dropped", async () => {
  // That looks like a fault on this side, and the book must not empty itself because of it.
  let broken = true;
  const it = await open({ answer: (url) => (broken && url.includes("apple") ? 403 : 201) });
  const apples = await seed(it, 3, "web.push.apple.com");
  const others = await seed(it, 2);

  await days(it, 7);
  for (const device of apples) assert.equal((await entry(it, device)).fails, 5);
  for (const device of others) assert.equal((await entry(it, device)).fails, 0);
  assert.equal((await it.book.status()).body.devices, 5);
  assert.equal((await it.book.status()).body.last.refused, 3);

  // Mended: everyone gets through again and starts with a clean sheet.
  broken = false;
  await days(it, 1, 7);
  for (const device of apples) assert.equal((await entry(it, device)).fails, 0);
  assert.equal((await it.book.status()).body.last.sent, 5);
});

test("a lone device is never dropped for being refused", async () => {
  const it = await open({ answer: () => 403 });
  const [phone] = await seed(it, 1);
  await days(it, 8);
  assert.equal((await entry(it, phone)).fails, 5);
  assert.equal((await it.book.status()).body.devices, 1);
});

test("a device whose last alert was refused is tried again when it checks in", async () => {
  let answer = 403;
  const it = await open({ answer: () => answer });
  const [phone] = await seed(it, 1, "fcm.googleapis.com", { fails: 2 });

  // Still refused: it is taken out, and the page is told to get a fresh address.
  assert.deepEqual(await it.book.subscribe({ subscription: phone.subscription }), { status: 410, body: { ok: false, reason: "gone" } });
  assert.equal(await entry(it, phone), undefined);
  assert.equal(it.storage.kept.get("count"), 0);

  // Getting through again: it stays, with a clean sheet.
  const [second] = await seed(it, 1, "fcm.googleapis.com", { fails: 5 });
  answer = 201;
  assert.deepEqual(await it.book.subscribe({ subscription: second.subscription }), { status: 200, body: { ok: true, new: false } });
  assert.equal((await entry(it, second)).fails, 0);
  assert.equal((await entry(it, second)).added, 1);
  assert.equal(it.storage.kept.get("count"), 1);
  assert.equal(second.words(it.net.pushesTo(second)[0].body).notification.title, "Alerts are on");

  // No clear answer: it stays as it is.
  const [third] = await seed(it, 1, "fcm.googleapis.com", { fails: 3 });
  answer = 503;
  assert.deepEqual(await it.book.subscribe({ subscription: third.subscription }), { status: 200, body: { ok: true, new: false } });
  assert.equal((await entry(it, third)).fails, 3);
  assert.equal(it.storage.kept.get("count"), 2);
});

test("a notification service that asks for patience is tried again after two minutes, then after ten", async () => {
  const tries = new Map();
  const patience = new Map();
  const it = await open({
    page: checked(),
    answer: (url) => {
      tries.set(url, (tries.get(url) || 0) + 1);
      return tries.get(url) <= (patience.get(url) || 0) ? 503 : 201;
    },
  });
  const devices = await seed(it, 4);
  patience.set(devices[0].endpoint, 1); // gets through on the second try
  patience.set(devices[1].endpoint, 2); // on the third
  patience.set(devices[2].endpoint, 9); // never

  const start = at(TODAY, "15:05");
  it.time.set(start);
  await it.book.tick();
  // While the later tries are waiting, the timer leaves the alert alone.
  it.storage.alarm = null;
  await it.book.alarm();
  assert.equal(it.storage.alarm, start + 2 * MINUTE);
  it.time.set(start + MINUTE);
  assert.equal((await it.book.tick()).body.why, "today's alert is being sent");
  assert.equal(it.storage.alarm, start + 2 * MINUTE);

  const rounds = await runAlarms(it.book, it.storage, it.time);
  assert.deepEqual(rounds, [start + 2 * MINUTE, start + 12 * MINUTE]);
  assert.deepEqual(
    devices.map((device) => tries.get(device.endpoint)),
    [2, 3, 3, 1]
  );
  const { last } = (await it.book.status()).body;
  assert.equal(last.sent, 3);
  assert.equal(last.failed, 1);
  assert.equal(last.finishedAt, start + 12 * MINUTE);
  // Being asked to wait is not held against a device.
  assert.equal((await entry(it, devices[2])).fails, 0);
  assert.equal(last.devices, 4);
});

test("no connection to a notification service is treated like a request for patience", async () => {
  let down = true;
  const it = await open({ page: checked(), answer: () => (down ? "down" : 201) });
  await seed(it, 3);
  it.time.set(at(TODAY, "15:05"));
  await it.book.tick();
  it.storage.alarm = null;
  await it.book.alarm();
  down = false;
  await runAlarms(it.book, it.storage, it.time);
  assert.equal((await it.book.status()).body.last.sent, 3);
  assert.equal((await it.book.status()).body.last.failed, 0);
});

test("a lost wake-up call is set again by the timer", async () => {
  const it = await open({ page: checked() });
  await seed(it, 50);
  it.time.set(at(TODAY, "15:05"));
  await it.book.tick();
  it.storage.alarm = null;
  await it.book.alarm(); // the first round runs, and its wake-up call for the second is lost
  it.storage.alarm = null;
  assert.equal(it.net.pushes.length, 40);

  it.time.set(at(TODAY, "15:10"));
  assert.equal((await it.book.tick()).body.why, "today's alert is being sent");
  assert.equal(it.storage.alarm, at(TODAY, "15:10"));
  await runAlarms(it.book, it.storage, it.time);
  assert.equal(it.net.pushes.length, 50);
  assert.equal((await it.book.status()).body.last.sent, 50);
});

test("a wake-up call with nothing to send does nothing", async () => {
  const it = await open({ page: checked() });
  await seed(it, 2);
  await it.book.alarm();
  assert.equal(it.net.calls.length, 0);
  assert.equal(it.storage.alarm, null);
});

test("a send left over from yesterday is closed before today is looked at", async () => {
  const it = await open({ page: checked() });
  const devices = await seed(it, 50);
  it.time.set(at(TODAY, "18:55"));
  await it.book.tick();
  it.storage.alarm = null;
  await it.book.alarm(); // one round, then nothing more until the next day
  it.storage.alarm = null;

  it.time.set(at("2026-11-21", "07:00"));
  assert.equal((await it.book.tick()).body.why, "too early");
  const { last, sending } = (await it.book.status()).body;
  assert.equal(sending, false);
  assert.equal(last.how, "abandoned");
  assert.equal(last.date, TODAY);
  assert.equal(last.sent, 40);

  // Today's alert then goes out to everyone as usual.
  it.net.page = checked("2026-11-21");
  assert.equal((await lookAt(it, "15:05", "2026-11-21")).said.did, "started");
  assert.equal(it.net.pushes.length, 40 + 50);
  for (const device of devices) assert.ok(it.net.pushesTo(device).length >= 1);
  assert.equal((await it.book.status()).body.last.sent, 50);
});

test("the number of devices is counted afresh after every alert", async () => {
  const it = await open({ page: checked() });
  await seed(it, 7);
  await it.storage.put("count", 3); // drifted
  await lookAt(it);
  assert.equal((await it.book.status()).body.devices, 7);
  assert.equal((await it.book.status()).body.last.sent, 7);
});

test("a device that joins or leaves while the alert is going out does no harm", async () => {
  const it = await open({ page: checked() });
  const devices = await seed(it, 90);
  it.time.set(at(TODAY, "15:05"));
  await it.book.tick();
  it.storage.alarm = null;
  await it.book.alarm();

  const late = newDevice();
  assert.equal((await it.book.subscribe({ subscription: late.subscription })).status, 201);
  await it.book.unsubscribe({ endpoint: devices[0].endpoint });
  await it.book.unsubscribe({ endpoint: devices[1].endpoint });
  await runAlarms(it.book, it.storage, it.time);

  const { last, devices: count } = (await it.book.status()).body;
  assert.equal(count, 89);
  assert.equal(last.devices, 89);
  assert.equal(last.failed, 0);
  // Nobody is written to twice.
  for (const device of devices) assert.ok(it.net.pushesTo(device).length <= 1);
});

test("an entry in the book that is not an address is counted as refused and sends nothing", async () => {
  const it = await open({ page: checked() });
  await seed(it, 1);
  await it.storage.put("sub:broken", { endpoint: "not an address", p256dh: "x", auth: "y", added: 1, fails: 0 });
  await lookAt(it);
  const { last } = (await it.book.status()).body;
  assert.equal(last.sent, 1);
  assert.equal(last.refused, 1);
  assert.equal(it.net.pushes.length, 1);
});

test("the list of devices to try again never outgrows what one entry of the storage may hold", async () => {
  // Every device is asked to wait, far more of them than are ever tried again.
  const it = await open({ page: checked(), answer: () => 503 });
  await seed(it, 2100);
  it.time.set(at(TODAY, "15:05"));
  await it.book.tick();
  let largest = 0;
  // The first pass only: 53 rounds of forty.
  for (let round = 0; round < 53; round += 1) {
    it.storage.alarm = null;
    await it.book.alarm();
    largest = Math.max(largest, JSON.stringify(it.storage.kept.get("job")).length);
  }
  const job = it.storage.kept.get("job");
  assert.equal(job.pass, 1);
  assert.equal(job.queue.length, 2000);
  assert.equal(job.failed, 100);
  assert.ok(largest < 128 * 1024, `${largest} bytes`);
});

test("what the status shows names no device", async () => {
  const it = await open({ page: checked() });
  const phone = newDevice();
  await it.book.subscribe({ subscription: phone.subscription });
  await lookAt(it);
  const status = await it.book.status();
  assert.equal(status.status, 200);
  assert.deepEqual(Object.keys(status.body).sort(), ["devices", "last", "ok", "sending", "timer", "unknownServices"]);
  const text = JSON.stringify(status.body);
  for (const secret of [phone.endpoint, phone.host, phone.subscription.keys.p256dh, phone.subscription.keys.auth, "sub:"]) {
    assert.equal(text.includes(secret), false, secret);
  }
  // Nor do the lines written to the log.
  for (const line of it.lines) assert.equal(line.includes(phone.host), false, line);
});
