// What the Telegram bot says in a chat, and the buttons it shows. The words
// of the alerts themselves come from the page (telegram.json); these are only
// the words around them: the welcome, the times, pause and resume.
//
// Everything here is plain text: none of it is sent as HTML, so nothing needs
// escaping. Like rules.js, this file has no storage and no network, so each
// piece can be tried on its own.

import { clockText } from "./rules.js";

// The two buttons that stay at the bottom of the chat. What they send back is
// their own words, so those words are how they are recognised.
export const BUTTONS = { change: "🕓 Change times", pause: "⏸ Pause notifications", resume: "▶️ Resume notifications" };

export const KINDS = ["weekday", "weekend"];
const NAMES = { weekday: "Weekdays", weekend: "Weekends" };
const DAYS = { weekday: "Monday to Friday", weekend: "Saturday and Sunday" };

// The commands in the bot's menu (Telegram's "Menu" button).
export const COMMANDS = [
  { command: "settings", description: "Change your alert times" },
  { command: "pause", description: "Pause notifications" },
  { command: "resume", description: "Resume notifications" },
];

/** "4 PM" */
export function hourText(hour) {
  return clockText(hour * 60);
}

/** When an alert comes, in a sentence: "4 PM", "10 PM the evening before", or "no alert". */
function whenText(hour, bot) {
  if (hour === null) return "no alert";
  return hour >= bot.evening ? `${hourText(hour)} the evening before` : hourText(hour);
}

/**
 * What someone wrote, as one of: "start", "settings", "pause", "resume" or
 * "other". Commands ("/pause"), the buttons at the bottom of the chat, and the
 * plain words "pause", "stop" and "resume" are all understood.
 */
export function intentOf(text) {
  const written = String(text || "").trim();
  const command = /^\/([A-Za-z]+)(?:@\w+)?(?:\s|$)/.exec(written);
  const word = command ? command[1].toLowerCase() : written.replace(/[^A-Za-z ]/g, "").trim().toLowerCase();
  if (word === "start") return "start";
  if (["settings", "change times", "times", "help"].includes(word)) return "settings";
  if (["pause", "pause notifications", "stop"].includes(word)) return "pause";
  if (["resume", "resume notifications"].includes(word)) return "resume";
  return "other";
}

/**
 * What a button under a message means, as `{ action, kind, hour }`, or null
 * if it is not one of this bot's buttons. The actions are "menu" (back to the
 * times), "pick" (show the hours for `kind`) and "set" (set `kind` to `hour`,
 * a whole hour or null for no alert).
 */
export function buttonOf(data, bot) {
  const text = String(data || "");
  if (text === "menu") return { action: "menu" };
  let found = /^pick:(weekday|weekend)$/.exec(text);
  if (found) return { action: "pick", kind: found[1] };
  found = /^set:(weekday|weekend):(none|\d{1,2})$/.exec(text);
  if (!found) return null;
  if (found[2] === "none") return { action: "set", kind: found[1], hour: null };
  const hour = Number(found[2]);
  if (hour < bot.first || hour > bot.last) return null;
  return { action: "set", kind: found[1], hour };
}

/** The two buttons at the bottom of the chat. */
export function bottomButtons(chat) {
  return {
    keyboard: [[{ text: BUTTONS.change }, { text: chat.paused ? BUTTONS.resume : BUTTONS.pause }]],
    resize_keyboard: true,
    is_persistent: true,
  };
}

/** The message with a person's times, and a button for each. `first` is a line to put above them. */
export function timesMessage(chat, bot, first = "") {
  const lines = [];
  if (first) lines.push(first, "");
  if (chat.paused) lines.push(`⏸ Notifications are paused. Your times are kept for when you press "${BUTTONS.resume}".`, "");
  lines.push("Your alerts:", `• Weekdays: ${whenText(chat.weekday, bot)}`, `• Weekends: ${whenText(chat.weekend, bot)}`);
  lines.push("", chat.weekday === null && chat.weekend === null ? "You have no alerts set. Press a button to choose a time." : "Press a button to change a time.");
  const short = (hour) => (hour === null ? "no alert" : hourText(hour));
  return {
    text: lines.join("\n"),
    reply_markup: {
      inline_keyboard: [KINDS.map((kind) => ({ text: `${NAMES[kind]}: ${short(chat[kind])}`, callback_data: `pick:${kind}` }))],
    },
  };
}

/** The first message, when someone presses Start. Their times follow in a message of their own. */
export function welcomeMessage(chat, park) {
  return {
    text: `🐕 Hi! I'll tell you when the ${park} is booked, and if rain is coming.\n\nThe buttons at the bottom of the chat change your times or pause the alerts.`,
    reply_markup: bottomButtons(chat),
  };
}

/** The hours to choose from for `kind`, four to a row, the one chosen now ticked. */
export function hoursMessage(chat, kind, bot) {
  const mark = (yes, text) => (yes ? `✓ ${text}` : text);
  const rows = [];
  for (let hour = bot.first; hour <= bot.last; hour += 1) {
    if ((hour - bot.first) % 4 === 0) rows.push([]);
    rows[rows.length - 1].push({ text: mark(chat[kind] === hour, hourText(hour)), callback_data: `set:${kind}:${hour}` });
  }
  rows.push([
    { text: mark(chat[kind] === null, "No alert"), callback_data: `set:${kind}:none` },
    { text: "« Back", callback_data: "menu" },
  ]);
  const lines = [`When should the ${kind} alert come? (${DAYS[kind]})`];
  if (bot.evening <= bot.last) lines.push("", `An alert at ${hourText(bot.evening)} or later comes the evening before, about the next day.`);
  return { text: lines.join("\n"), reply_markup: { inline_keyboard: rows } };
}

/** The line above the times once one has been chosen. */
export function chosenLine(kind, hour, bot) {
  if (hour === null) return `✅ No ${kind} alerts.`;
  return `✅ ${NAMES[kind]}: the alert comes at ${whenText(hour, bot)}.`;
}

export function pausedMessage(chat) {
  return {
    text: `⏸ Notifications are paused. Your times are kept.\n\nPress "${BUTTONS.resume}" at the bottom to turn them back on.`,
    reply_markup: bottomButtons(chat),
  };
}

export function resumedMessage(chat, bot) {
  return { ...timesMessage(chat, bot, "▶️ Notifications are back on."), reply_markup: bottomButtons(chat) };
}

export const FULL = "Sorry, the bot has as many people as it can take at the moment. The channel and the page have the same news.";

/** The bot's description, shown in an empty chat before someone presses Start. */
export function description(park, bot) {
  return (
    `When is the ${park} booked? I send you an alert at a time you choose: one for weekdays and one for weekends. ` +
    `Press Start to begin with ${hourText(bot.weekday)} on weekdays and ${hourText(bot.weekend)} on weekends.`
  );
}

/** The short one, on the bot's profile. At most 120 letters. */
export function shortDescription(park) {
  return `Alerts when the ${park} is booked, at a time you choose.`.slice(0, 120);
}
