// What the Telegram bot says in a chat, and the buttons it shows. The words
// of the alerts themselves come from the page (telegram.json); these are only
// the words around them: a person's times, the picker, pause and resume.
//
// A chat holds one message with the person's times ("Your alerts"), with
// buttons under it to change the times or pause the alerts. Changing a time
// opens a picker of its own, which goes away once a time is chosen.
//
// Everything here is plain text: none of it is sent as HTML, so nothing needs
// escaping. Like rules.js, this file has no storage and no network, so each
// piece can be tried on its own.

import { clockText } from "./rules.js";

// The words of the buttons people press, and of the bottom buttons an earlier
// version of the bot showed. What a bottom button sends back is its own words,
// so those words are still understood.
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
 * "other". Commands ("/pause"), the old bottom buttons, and the plain words
 * "pause", "stop" and "resume" are all understood.
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
 * if it is not one of this bot's buttons. The actions are "change" (open the
 * picker), "pick" (show the hours for `kind`), "set" (set `kind` to `hour`, a
 * whole hour or null for no alert), "back" (from the hours to the picker),
 * "close" (close the picker), "pause" and "resume".
 */
export function buttonOf(data, bot) {
  const text = String(data || "");
  if (["change", "back", "close", "pause", "resume"].includes(text)) return { action: text };
  // An earlier version's "back to the times" button.
  if (text === "menu") return { action: "back" };
  let found = /^pick:(weekday|weekend)$/.exec(text);
  if (found) return { action: "pick", kind: found[1] };
  found = /^set:(weekday|weekend):(none|\d{1,2})$/.exec(text);
  if (!found) return null;
  if (found[2] === "none") return { action: "set", kind: found[1], hour: null };
  const hour = Number(found[2]);
  if (hour < bot.first || hour > bot.last) return null;
  return { action: "set", kind: found[1], hour };
}

/**
 * The message with a person's times, which stays in the chat. Under it: a
 * button to change the times, one to pause or resume, and the link the
 * settings name (a consultation with Sofia), if there is one.
 */
export function summaryMessage(chat, bot) {
  const lines = [];
  if (chat.paused) lines.push("⏸ Notifications are paused. Your times are kept for when you resume them.", "");
  lines.push("Your alerts:", `• Weekdays: ${whenText(chat.weekday, bot)}`, `• Weekends: ${whenText(chat.weekend, bot)}`);
  if (chat.weekday === null && chat.weekend === null) lines.push("", `You have no alerts set. Press "${BUTTONS.change}" to choose a time.`);
  const rows = [
    [
      { text: BUTTONS.change, callback_data: "change" },
      chat.paused ? { text: BUTTONS.resume, callback_data: "resume" } : { text: BUTTONS.pause, callback_data: "pause" },
    ],
  ];
  if (bot.link) rows.push([{ text: bot.linkText, url: bot.link }]);
  return { text: lines.join("\n"), reply_markup: { inline_keyboard: rows } };
}

/** The picker: which of the two times to change. */
export function pickerMessage() {
  return {
    text: "Which alerts do you want to change?",
    reply_markup: {
      inline_keyboard: [
        KINDS.map((kind) => ({ text: NAMES[kind], callback_data: `pick:${kind}` })),
        [{ text: "✕ Close", callback_data: "close" }],
      ],
    },
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
    { text: "« Back", callback_data: "back" },
  ]);
  const lines = [`When should the ${kind} alert come? (${DAYS[kind]})`];
  if (bot.evening <= bot.last) lines.push("", `An alert at ${hourText(bot.evening)} or later comes the evening before, about the next day.`);
  return { text: lines.join("\n"), reply_markup: { inline_keyboard: rows } };
}

/** What an old message of the bot's says once Telegram no longer lets the bot take it away (after two days). */
export const LEFTOVER = { summary: "Your alerts have changed. The latest are further down.", picker: "Closed." };

export const FULL = "Sorry, the bot has as many people as it can take at the moment. The channel and the page have the same news.";

/** The bot's name, as chats show it. The Telegram channel moved here, so the bot has its name. */
export const NAME = "Citizens Bark";
/** The names the bot had before. One of these is replaced; a name a person gave it is left alone. */
export const EARLIER_NAMES = ["Citizens Park Dogs"];

/** The bot's description, shown in an empty chat before someone presses Start, and on its profile. */
export function description(park) {
  return `When is the ${park} booked, and is rain on the way? I'll send you an alert at a time you choose.`;
}

/** The descriptions earlier versions of the bot wrote. One of these is replaced by today's; anything else was written by a person and is left alone. */
export function earlierDescriptions(park, bot) {
  return [
    `When is the ${park} booked? I send you an alert at a time you choose: one for weekdays and one for weekends. ` +
      `Press Start to begin with ${hourText(bot.weekday)} on weekdays and ${hourText(bot.weekend)} on weekends.`,
    `Alerts when the ${park} is booked, at a time you choose.`,
  ];
}
