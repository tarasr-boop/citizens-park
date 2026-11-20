// The Telegram bot: what it says in a chat, the times people choose, and the
// sending of the alerts at those times. Tried with stand-ins for the
// database, the storage, the clock, the page and Telegram.

import assert from "node:assert/strict";
import { test } from "node:test";

import { BATCH, Bot, MOST_CHATS, STALE_HOURS } from "../src/bot.js";
import { BUTTONS, FULL, buttonOf, intentOf } from "../src/botwords.js";
import { settingsFrom } from "../src/rules.js";
import { BOT, BOT_NAME, BOT_TOKEN, ENV, TELEGRAM, at, clock, memorySql, memoryStorage, runAlarms, world } from "./standins.js";

const settings = settingsFrom({ ...ENV, ...BOT });
const MONDAY = "2026-11-23";
const FRIDAY = "2026-11-27";
const SATURDAY = "2026-11-28";

/** The words the daily check publishes in telegram.json, made at `made` on `date`. */
function alertWords(date, made = "06:17", entries = null) {
  const hours = entries || Array.from({ length: 20 }, (_, index) => index + 4).map((hour) => ({ hour }));
  const weekend = (about) => [0, 6].includes(new Date(`${about}T12:00:00Z`).getUTCDay());
  const next = (day) => new Date(Date.parse(`${day}T12:00:00Z`) + 86400000).toISOString().slice(0, 10);
  return {
    generated: `${date}T${made}+11:00`,
    generatedText: `${date} ${made}`,
    alerts: hours.map(({ hour, about = hour >= 21 ? next(date) : date, text = `🐕 <b>Citizens Park oval</b>\n\nThe words for ${hour}:00 about ${about}` }) => ({
      date,
      hour,
      about,
      weekend: weekend(about),
      text,
    })),
  };
}

function open({ start = at(MONDAY, "09:00"), words = alertWords(MONDAY), telegram, token = BOT_TOKEN, env = { ...ENV, ...BOT } } = {}) {
  const time = clock(start);
  const net = world({ words, telegram });
  const sql = memorySql();
  const storage = memoryStorage();
  const lines = [];
  const bot = new Bot({ sql, storage, fetch: net.fetch, now: time.now, settings: settingsFrom(env), log: (line) => lines.push(line), token });
  bot.open();
  return { bot, sql, storage, time, net, lines };
}

/** Set the bot up, as the timer's first look does, and forget what that asked of Telegram. Returns the password. */
async function ready(it) {
  await it.bot.hook();
  it.net.calls.length = 0;
  return (await it.storage.get("hook")).secret;
}

let updates = 0;
const message = (id, text, type = "private") => ({ update_id: (updates += 1), message: { message_id: updates, from: { id, is_bot: false, first_name: "Someone" }, chat: { id, type }, date: 0, text } });
const press = (id, data, messageId = 77) => ({ update_id: (updates += 1), callback_query: { id: `q${updates}`, from: { id }, message: { message_id: messageId, chat: { id, type: "private" } }, data } });

async function say(it, secret, update) {
  return it.bot.update(update, secret);
}

/** Put chats straight into the database: `[id, weekday, weekend, paused]`. */
function chats(it, rows) {
  for (const [id, weekday, weekend, paused = 0] of rows) {
    it.sql.exec("INSERT INTO chats (id, weekday, weekend, paused, added) VALUES (?, ?, ?, ?, 0)", id, weekday, weekend, paused);
  }
}

const sentTo = (it) => it.net.said.map((one) => one.chat_id);

// ---------------------------------------------------------------------------
// The words and buttons
// ---------------------------------------------------------------------------

test("what people write is understood: commands, the buttons at the bottom, and plain words", () => {
  const expected = [
    ["/start", "start"],
    ["/start page", "start"],
    ["/START", "start"],
    ["/settings", "settings"],
    ["/settings@standin_park_bot", "settings"],
    [BUTTONS.change, "settings"],
    [BUTTONS.pause, "pause"],
    [BUTTONS.resume, "resume"],
    ["/pause", "pause"],
    ["/stop", "pause"],
    ["pause", "pause"],
    ["Stop", "pause"],
    ["resume", "resume"],
    ["/resume", "resume"],
    ["hello", "other"],
    ["", "other"],
    [undefined, "other"],
  ];
  for (const [text, intent] of expected) assert.equal(intentOf(text), intent, String(text));
});

test("only the bot's own buttons, with hours people may choose, are taken", () => {
  const bot = settings.bot;
  assert.deepEqual(buttonOf("menu", bot), { action: "menu" });
  assert.deepEqual(buttonOf("pick:weekend", bot), { action: "pick", kind: "weekend" });
  assert.deepEqual(buttonOf("set:weekday:7", bot), { action: "set", kind: "weekday", hour: 7 });
  assert.deepEqual(buttonOf("set:weekend:none", bot), { action: "set", kind: "weekend", hour: null });
  for (const bad of ["set:weekday:3", "set:weekday:24", "set:weekday:", "set:monday:7", "pick:", "set:weekday:7; DROP TABLE chats", "", null]) {
    assert.equal(buttonOf(bad, bot), null, String(bad));
  }
});

// ---------------------------------------------------------------------------
// Setting the bot up
// ---------------------------------------------------------------------------

test("without its token or its settings, the bot does nothing at all", async () => {
  for (const it of [open({ token: "" }), open({ env: ENV })]) {
    assert.equal(it.bot.on, false);
    assert.equal((await it.bot.tick()).did, "nothing");
    assert.deepEqual(await it.bot.status(), { on: false });
    assert.equal((await say(it, "anything", message(5, "/start"))).status, 403);
    assert.equal(it.net.calls.length, 0);
  }
});

test("the first look tells Telegram where to bring messages, with a password it makes, and gives the bot its menu", async () => {
  const it = open();
  await it.bot.tick();
  const methods = it.net.bot.map((call) => call.method);
  assert.deepEqual(methods.slice(0, 2), ["getMe", "setWebhook"]);
  const hook = it.net.bot[1].body;
  assert.equal(hook.url, "https://alerts.example/telegram");
  assert.deepEqual(hook.allowed_updates, ["message", "callback_query", "my_chat_member"]);
  assert.match(hook.secret_token, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(methods.includes("setMyCommands"));
  // The bot had no description, so it gets one.
  const description = it.net.bot.find((call) => call.method === "setMyDescription").body.description;
  assert.match(description, /4 PM on weekdays and 8 AM on weekends/);
  assert.ok(it.net.bot.find((call) => call.method === "setMyShortDescription").body.short_description.length <= 120);
  // Every request went to Telegram's API with the token, and nowhere else.
  for (const call of it.net.bot) assert.equal(call.token, BOT_TOKEN);
  const status = await it.bot.status();
  assert.equal(status.name, BOT_NAME);
  assert.equal(status.hook.ok, true);
  assert.equal(JSON.stringify(status).includes(hook.secret_token), false);
  assert.equal(JSON.stringify(status).includes(BOT_TOKEN), false);
});

test("a description someone wrote is left alone, and the set-up is told again once a day", async () => {
  const it = open({ telegram: (call) => (call.method === "getMyDescription" ? { result: { description: "Mine." } } : null) });
  await it.bot.tick();
  assert.equal(it.net.bot.some((call) => call.method === "setMyDescription"), false);
  const secret = (await it.storage.get("hook")).secret;
  it.net.calls.length = 0;
  it.time.forward(3600 * 1000);
  await it.bot.tick();
  assert.equal(it.net.bot.length, 0);
  it.time.forward(24 * 3600 * 1000);
  await it.bot.tick();
  assert.deepEqual(it.net.bot.map((call) => call.method), ["getMe", "setWebhook", "getWebhookInfo"]);
  // The same password as before.
  assert.equal(it.net.bot[1].body.secret_token, secret);
});

test("a token Telegram does not know stops the bot, and is asked about again in half an hour", async () => {
  const it = open({ telegram: (call) => (call.method === "getMe" ? { status: 401, description: "Unauthorized" } : null) });
  assert.deepEqual(await it.bot.tick(), { did: "nothing", why: "Telegram does not take the token" });
  assert.deepEqual(it.net.bot.map((call) => call.method), ["getMe"]);
  assert.equal((await it.bot.status()).hook.ok, false);
  it.time.forward(10 * 60000);
  await it.bot.tick();
  assert.equal(it.net.bot.length, 1);
  it.time.forward(25 * 60000);
  await it.bot.tick();
  assert.equal(it.net.bot.length, 2);
  assert.ok(it.lines.some((line) => line.includes("answer 401")));
  assert.equal(it.lines.join("\n").includes(BOT_TOKEN), false);
});

// ---------------------------------------------------------------------------
// The chat
// ---------------------------------------------------------------------------

test("only Telegram, with the password, is listened to", async () => {
  const it = open();
  const secret = await ready(it);
  assert.equal((await say(it, "wrong", message(5, "/start"))).status, 403);
  assert.equal((await say(it, "", message(5, "/start"))).status, 403);
  assert.equal((await say(it, secret.slice(0, -1), message(5, "/start"))).status, 403);
  assert.equal(it.net.calls.length, 0);
  assert.deepEqual(await say(it, secret, message(5, "/start")), { status: 200, body: { ok: true } });
});

test("Start turns the alerts on at the usual times, and says so", async () => {
  const it = open();
  const secret = await ready(it);
  await say(it, secret, message(5, "/start"));
  assert.deepEqual(it.sql.chats(), [{ id: 5, weekday: 16, weekend: 8, paused: 0, added: at(MONDAY, "09:00"), last: null }]);
  const [welcome, times] = it.net.said;
  assert.equal(welcome.chat_id, 5);
  assert.match(welcome.text, /when the Citizens Park oval is booked/);
  // The two buttons that stay at the bottom of the chat.
  assert.deepEqual(welcome.reply_markup.keyboard, [[{ text: BUTTONS.change }, { text: BUTTONS.pause }]]);
  assert.equal(welcome.reply_markup.is_persistent, true);
  assert.match(times.text, /Weekdays: 4 PM\n• Weekends: 8 AM/);
  assert.deepEqual(times.reply_markup.inline_keyboard, [
    [
      { text: "Weekdays: 4 PM", callback_data: "pick:weekday" },
      { text: "Weekends: 8 AM", callback_data: "pick:weekend" },
    ],
  ]);
  // Nothing about the person is kept: not their name, not what they wrote.
  assert.equal(JSON.stringify(it.sql.chats()).includes("Someone"), false);
  assert.ok(it.lines.includes("a chat started"));
  // Pressing Start again changes nothing, and shows the same.
  await say(it, secret, message(5, "/start"));
  assert.equal(it.sql.chats().length, 1);
  assert.equal(it.net.said.length, 4);
});

test("a time is chosen from a grid of hours, from 4 AM to 11 PM, or none", async () => {
  const it = open();
  const secret = await ready(it);
  await say(it, secret, message(5, "/start"));
  it.net.calls.length = 0;

  await say(it, secret, press(5, "pick:weekday"));
  assert.deepEqual(it.net.bot.map((call) => call.method), ["answerCallbackQuery", "editMessageText"]);
  const grid = it.net.bot[1].body;
  assert.equal(grid.chat_id, 5);
  assert.equal(grid.message_id, 77);
  assert.match(grid.text, /When should the weekday alert come\? \(Monday to Friday\)/);
  assert.match(grid.text, /at 9 PM or later comes the evening before/);
  const rows = grid.reply_markup.inline_keyboard;
  assert.equal(rows.length, 6);
  assert.deepEqual(rows[0].map((one) => one.text), ["4 AM", "5 AM", "6 AM", "7 AM"]);
  assert.deepEqual(rows[3].map((one) => one.text), ["4 PM", "5 PM", "6 PM", "7 PM"].map((text, index) => (index === 0 ? `✓ ${text}` : text)));
  assert.deepEqual(rows[4].map((one) => one.text), ["8 PM", "9 PM", "10 PM", "11 PM"]);
  assert.deepEqual(rows[5], [
    { text: "No alert", callback_data: "set:weekday:none" },
    { text: "« Back", callback_data: "menu" },
  ]);

  it.net.calls.length = 0;
  await say(it, secret, press(5, "set:weekday:7"));
  assert.equal(it.sql.chats()[0].weekday, 7);
  const done = it.net.bot[1].body;
  assert.match(done.text, /^✅ Weekdays: the alert comes at 7 AM\.\n\nYour alerts:\n• Weekdays: 7 AM\n• Weekends: 8 AM/);
  assert.equal(done.reply_markup.inline_keyboard[0][0].text, "Weekdays: 7 AM");

  await say(it, secret, press(5, "set:weekend:22"));
  assert.equal(it.sql.chats()[0].weekend, 22);
  assert.match(it.net.bot.at(-1).body.text, /Weekends: the alert comes at 10 PM the evening before\./);

  await say(it, secret, press(5, "set:weekend:none"));
  assert.equal(it.sql.chats()[0].weekend, null);
  assert.match(it.net.bot.at(-1).body.text, /^✅ No weekend alerts\./);
  assert.match(it.net.bot.at(-1).body.text, /• Weekends: no alert/);

  await say(it, secret, press(5, "set:weekday:none"));
  assert.match(it.net.bot.at(-1).body.text, /You have no alerts set\./);

  await say(it, secret, press(5, "menu"));
  assert.match(it.net.bot.at(-1).body.text, /^Your alerts:/);
});

test("a button that is not the bot's own is answered and does nothing more", async () => {
  const it = open();
  const secret = await ready(it);
  await say(it, secret, message(5, "/start"));
  it.net.calls.length = 0;
  for (const data of ["set:weekday:2", "set:weekday:7; DROP TABLE chats", "other"]) await say(it, secret, press(5, data));
  assert.deepEqual(it.net.bot.map((call) => call.method), ["answerCallbackQuery", "answerCallbackQuery", "answerCallbackQuery"]);
  assert.equal(it.sql.chats()[0].weekday, 16);
});

test("notifications can be paused and resumed, and the times are kept", async () => {
  const it = open();
  const secret = await ready(it);
  await say(it, secret, message(5, "/start"));
  await say(it, secret, press(5, "set:weekday:7"));
  it.net.calls.length = 0;

  await say(it, secret, message(5, BUTTONS.pause));
  assert.equal(it.sql.chats()[0].paused, 1);
  const paused = it.net.said[0];
  assert.match(paused.text, /Notifications are paused\. Your times are kept\./);
  assert.deepEqual(paused.reply_markup.keyboard, [[{ text: BUTTONS.change }, { text: BUTTONS.resume }]]);

  // While paused, the times say so.
  await say(it, secret, message(5, BUTTONS.change));
  assert.match(it.net.said[1].text, /^⏸ Notifications are paused\./);

  await say(it, secret, message(5, "/resume"));
  assert.deepEqual([it.sql.chats()[0].paused, it.sql.chats()[0].weekday], [0, 7]);
  const resumed = it.net.said[2];
  assert.match(resumed.text, /^▶️ Notifications are back on\.\n\nYour alerts:\n• Weekdays: 7 AM/);
  assert.deepEqual(resumed.reply_markup.keyboard, [[{ text: BUTTONS.change }, { text: BUTTONS.pause }]]);

  await say(it, secret, message(5, "stop"));
  assert.equal(it.sql.chats()[0].paused, 1);
});

test("someone who blocks the bot is taken off the list", async () => {
  const it = open();
  const secret = await ready(it);
  await say(it, secret, message(5, "/start"));
  await say(it, secret, { update_id: 9, my_chat_member: { chat: { id: 5, type: "private" }, new_chat_member: { status: "kicked" } } });
  assert.deepEqual(it.sql.chats(), []);
  assert.ok(it.lines.includes("a chat was removed (the bot was blocked)"));
});

test("groups, channels and other bots are not answered", async () => {
  const it = open();
  const secret = await ready(it);
  await say(it, secret, message(-100123, "/start", "supergroup"));
  await say(it, secret, message(-100124, "/start", "channel"));
  await say(it, secret, { update_id: 1, message: { message_id: 1, from: { id: 6, is_bot: true }, chat: { id: 6, type: "private" }, text: "/start" } });
  await say(it, secret, { update_id: 2, edited_message: { chat: { id: 7, type: "private" }, text: "/start" } });
  await say(it, secret, "not an update");
  assert.deepEqual(it.sql.chats(), []);
  assert.equal(it.net.calls.length, 0);
});

test("when the list is full, a new chat is told so and is not added", async () => {
  const it = open();
  const secret = await ready(it);
  chats(it, Array.from({ length: MOST_CHATS }, (_, index) => [index + 1000, 16, 8]));
  await say(it, secret, message(5, "/start"));
  assert.deepEqual(it.net.said, [{ chat_id: 5, text: FULL }]);
  assert.equal(it.sql.chats().length, MOST_CHATS);
});

test("trouble with one message does not make Telegram bring it again and again", async () => {
  const it = open({ telegram: (call) => (call.method === "sendMessage" ? "down" : null) });
  const secret = await ready(it);
  assert.equal((await say(it, secret, message(5, "/start"))).status, 200);
  assert.equal(it.sql.chats().length, 1);
});

// ---------------------------------------------------------------------------
// Sending the alerts
// ---------------------------------------------------------------------------

test("at each hour, everyone who chose it gets the words written for that hour", async () => {
  const it = open({ start: at(MONDAY, "15:55") });
  await ready(it);
  // A weekday at 4 PM, a weekend at 4 PM, a weekday at 4 PM but paused, a weekday at 7 AM, and no weekday alert.
  chats(it, [
    [11, 16, 8],
    [12, 7, 16],
    [13, 16, 8, 1],
    [14, 7, 8],
    [15, null, 16],
    [16, 16, null],
  ]);
  // At 3:55 PM nobody has chosen 3 PM.
  assert.deepEqual(await it.bot.tick(), { did: "nothing", why: "nobody wants an alert at 3 PM" });
  it.time.set(at(MONDAY, "16:00"));
  assert.deepEqual(await it.bot.tick(), { did: "started", why: "4 chats have 4 PM as a time" });
  await runAlarms(it.bot, it.storage, it.time);
  assert.deepEqual(sentTo(it), [11, 16]);
  const one = it.net.said[0];
  assert.equal(one.text, `🐕 <b>Citizens Park oval</b>\n\nThe words for 16:00 about ${MONDAY}`);
  assert.equal(one.parse_mode, "HTML");
  assert.deepEqual(one.link_preview_options, { is_disabled: true });
  assert.equal(it.sql.chats().find((chat) => chat.id === 11).last, MONDAY);
  const status = await it.bot.status();
  assert.deepEqual(
    { ...status.last, startedAt: 0, finishedAt: 0 },
    { date: MONDAY, hour: 16, about: MONDAY, kind: "weekday", how: "finished", startedAt: 0, finishedAt: 0, sent: 2, gone: 0, failed: 0 }
  );
  assert.equal(status.chats, 6);
  assert.equal(status.paused, 1);

  // Later in the hour, nothing more goes out.
  it.time.set(at(MONDAY, "16:05"));
  assert.deepEqual(await it.bot.tick(), { did: "nothing", why: "the 4 PM alerts have gone out" });
  it.time.set(at(MONDAY, "16:55"));
  assert.equal((await it.bot.tick()).why, "the 4 PM alerts have gone out");
  assert.equal(it.net.said.length, 2);
});

test("on a weekend day the weekend times count, and a late alert follows the day it is about", async () => {
  const it = open({ start: at(SATURDAY, "08:00"), words: alertWords(SATURDAY) });
  await ready(it);
  chats(it, [
    [21, 16, 8],
    [22, 8, 9],
  ]);
  await it.bot.tick();
  await runAlarms(it.bot, it.storage, it.time);
  assert.deepEqual(sentTo(it), [21]);

  // On Friday at 9 PM, the alert is about Saturday: weekend times decide.
  const friday = open({ start: at(FRIDAY, "21:00"), words: alertWords(FRIDAY) });
  await ready(friday);
  chats(friday, [
    [31, 21, 8],
    [32, 16, 21],
  ]);
  await friday.bot.tick();
  await runAlarms(friday.bot, friday.storage, friday.time);
  assert.deepEqual(sentTo(friday), [32]);
  assert.match(friday.net.said[0].text, new RegExp(`about ${SATURDAY}`));
  assert.equal((await friday.bot.status()).last.kind, "weekend");
});

test("nobody gets two alerts about the same day, even after changing their time", async () => {
  const it = open({ start: at(MONDAY, "07:00") });
  const secret = await ready(it);
  chats(it, [[11, 7, 8]]);
  await it.bot.tick();
  await runAlarms(it.bot, it.storage, it.time);
  await say(it, secret, press(11, "set:weekday:9"));
  it.time.set(at(MONDAY, "09:00"));
  await it.bot.tick();
  await runAlarms(it.bot, it.storage, it.time);
  assert.equal(it.net.said.length, 1);
  // The next day it comes at the new time.
  it.time.set(at("2026-11-24", "09:00"));
  it.net.words = alertWords("2026-11-24");
  await it.bot.tick();
  await runAlarms(it.bot, it.storage, it.time);
  assert.equal(it.net.said.length, 2);
});

test("an hour nobody chose does not even read the page", async () => {
  const it = open({ start: at(MONDAY, "05:00") });
  await ready(it);
  chats(it, [[11, 16, 8]]);
  assert.deepEqual(await it.bot.tick(), { did: "nothing", why: "nobody wants an alert at 5 AM" });
  assert.equal(it.net.calls.length, 0);
  it.time.set(at(MONDAY, "05:05"));
  assert.equal((await it.bot.tick()).why, "the 5 AM alerts have gone out");
});

test("outside the bot's hours there is nothing to do", async () => {
  const it = open({ start: at(MONDAY, "03:00") });
  await ready(it);
  chats(it, [[11, 4, 4]]);
  assert.equal((await it.bot.tick()).why, "no alerts at this hour");
  it.time.set(at(MONDAY, "04:00"));
  assert.equal((await it.bot.tick()).did, "started");
});

test("they go out in rounds, and Telegram's request to slow down is followed", async () => {
  let slowed = 0;
  const it = open({
    start: at(MONDAY, "16:00"),
    telegram: (call) => {
      if (call.method !== "sendMessage") return null;
      if (call.body.chat_id === 1030 && slowed === 0) {
        slowed += 1;
        return { status: 429, description: "Too Many Requests: retry after 7", retry_after: 7 };
      }
      if (call.body.chat_id === 1040) return { status: 403, description: "Forbidden: bot was blocked by the user" };
      if (call.body.chat_id === 1041) return { status: 400, description: "Bad Request: chat not found" };
      if (call.body.chat_id === 1042) return { status: 500, description: "Internal Server Error" };
      return null;
    },
  });
  await ready(it);
  chats(it, Array.from({ length: 2 * BATCH + 10 }, (_, index) => [1000 + index, 16, 8]));
  await it.bot.tick();
  const rounds = await runAlarms(it.bot, it.storage, it.time);
  // Everyone once, in the order of their numbers, the one that was slowed down tried again.
  const sent = sentTo(it);
  assert.equal(sent.filter((id) => id === 1030).length, 2);
  assert.deepEqual([...new Set(sent)], Array.from({ length: 2 * BATCH + 10 }, (_, index) => 1000 + index));
  assert.equal(rounds[2] - rounds[1], 7000);
  const last = (await it.bot.status()).last;
  assert.deepEqual([last.sent, last.gone, last.failed], [2 * BATCH + 10 - 3, 2, 1]);
  // Those who blocked the bot, or whose account is gone, are taken off the list.
  const left = it.sql.chats().map((chat) => chat.id);
  assert.equal(left.includes(1040) || left.includes(1041), false);
  assert.ok(left.includes(1042));
  // No round sends more than one batch.
  assert.ok(rounds.length >= 3);
});

test("words that are old say so, and missing words send nothing", async () => {
  const old = open({ start: at(MONDAY, "16:00"), words: { ...alertWords(MONDAY, "06:17"), generated: "2026-11-22T19:47+11:00", generatedText: "Sun 22 Nov, <7:47 PM>" } });
  await ready(old);
  chats(old, [[11, 16, 8]]);
  await old.bot.tick();
  await runAlarms(old.bot, old.storage, old.time);
  assert.match(old.net.said[0].text, /\n\n⚠️ The page has not been updated since Sun 22 Nov, &lt;7:47 PM&gt;, so this may be out of date\.$/);
  assert.ok(STALE_HOURS < 24);

  const none = open({ start: at(MONDAY, "16:00"), words: alertWords(MONDAY, "06:17", [{ hour: 15 }]) });
  await ready(none);
  chats(none, [[11, 16, 8]]);
  assert.deepEqual(await none.bot.tick(), { did: "nothing", why: "telegram.json has no words for 4 PM today" });
  none.net.words = 404;
  none.time.set(at(MONDAY, "16:05"));
  assert.deepEqual(await none.bot.tick(), { did: "nothing", why: "telegram.json could not be read (telegram.json answered 404)" });
  // Once the words are there, they go out, at any look within the hour.
  none.net.words = alertWords(MONDAY);
  none.time.set(at(MONDAY, "16:50"));
  assert.equal((await none.bot.tick()).did, "started");
  await runAlarms(none.bot, none.storage, none.time);
  assert.equal(none.net.said.length, 1);
});

test("a sending that never finishes is given up, and the next hour goes ahead", async () => {
  const it = open({ start: at(MONDAY, "16:00") });
  await ready(it);
  chats(it, [
    [11, 16, 17],
    [12, 17, 8],
  ]);
  await it.bot.tick();
  // The wake-up call is lost.
  it.storage.alarm = null;
  it.time.set(at(MONDAY, "16:10"));
  assert.equal((await it.bot.tick()).why, "the 4 PM alerts are being sent");
  assert.notEqual(it.storage.alarm, null);
  it.storage.alarm = null;
  it.time.set(at(MONDAY, "17:00"));
  assert.equal((await it.bot.tick()).did, "started");
  assert.equal((await it.bot.status()).last.how, "abandoned");
});

test("the token goes to Telegram's API and nowhere else, and is never written down", async () => {
  const it = open({ start: at(MONDAY, "16:00") });
  const secret = await ready(it);
  chats(it, [[11, 16, 8]]);
  await say(it, secret, message(5, "/start"));
  await it.bot.tick();
  await runAlarms(it.bot, it.storage, it.time);
  for (const call of it.net.calls) {
    if (call.url.includes(BOT_TOKEN)) assert.ok(call.url.startsWith(`${TELEGRAM}bot${BOT_TOKEN}/`), call.url);
    else assert.notEqual(call.kind, "telegram");
  }
  assert.equal(JSON.stringify([...it.storage.kept]).includes(BOT_TOKEN), false);
  assert.equal(JSON.stringify(it.sql.chats()).includes(BOT_TOKEN), false);
  assert.equal(it.lines.join("\n").includes(BOT_TOKEN), false);
});
