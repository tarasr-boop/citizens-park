// The Telegram bot: custom alerts, at a time each person chooses.
//
// Someone opens a chat with the bot and presses Start. From then on they get
// the day's alert at 4 PM on weekdays and 8 AM on weekends. One message in the
// chat shows their times ("Your alerts"), with buttons under it to change
// them or to pause the alerts; their times are kept while paused.
//
// The chat is kept tidy: a message that is no longer true goes away. A new
// "Your alerts" takes the place of the last one, the picker for a time goes
// once a time is chosen, a tap on a command is removed, and a new alert takes
// the place of yesterday's.
//
// What is kept for a chat is only what the bot needs to write to it: the
// chat's number, the two hours, whether it is paused, the last day it was
// sent an alert for, and the numbers of the bot's own messages that are still
// there. No name, no user name, nothing they wrote.
//
// The alert itself is written by the daily check, which publishes the words
// for every hour in telegram.json next to the page, each with a picture of the
// day's timeline and rain. At each hour this sends the picture to everyone who
// chose it, with its "caption" under it: one line on the bookings and a link
// to the page, as the picture says the rest. Without a picture, or if Telegram
// cannot take it, the words written for that hour go alone.
//
// Telegram brings what people write to the bot to this backend ("webhook").
// The bot sets that up by itself once it has its token, with a password it
// makes for the purpose, so that only Telegram can talk to it. The token
// itself is a secret of the backend on Cloudflare: it is sent to Telegram's
// API and nowhere else, and never written down or put in the log.
//
// Like book.js, this file knows nothing about Cloudflare. It is given a
// SQLite database, a place to keep a few notes, a way to fetch, and a clock.

import { localTime } from "./rules.js";
import { toBase64Url } from "./webpush.js";
import * as words from "./botwords.js";

const TELEGRAM = "https://api.telegram.org";

// More chats than this are not taken on.
export const MOST_CHATS = 5000;
// How many alerts go out in one round. Each takes two requests to Telegram
// (the alert, and taking away the last one), plus one in a round where the
// picture fails and the words go alone. Telegram takes about 30 messages a
// second from a bot, and Cloudflare's free plan allows 50 outgoing requests
// each time this code is woken.
export const BATCH = 20;
const PAUSE_MS = 1000;
// Words written longer ago than this carry a warning that they may be out of date.
export const STALE_HOURS = 18;
// Telegram takes at most this many letters under a picture, counted without the
// markup. If what would go under it is longer, the words go alone, without the picture.
export const CAPTION_MOST = 1024;
// What Telegram says when a person has blocked the bot or their account is gone.
const GONE = /chat not found|deactivated/i;
// A sending that has not finished after this long is given up.
const GIVE_UP_MS = 50 * 60 * 1000;
// Telegram is told where to bring messages once a day, and after a no, every half hour.
const HOOK_AGAIN_MS = 24 * 3600 * 1000;
const HOOK_RETRY_MS = 30 * 60 * 1000;
// What Telegram brings: messages, presses of the buttons under a message, and
// a person blocking the bot.
const UPDATES = ["message", "callback_query", "my_chat_member"];
// The two columns a person's hours are kept in. Only these names ever go into a query.
const COLUMN = { weekday: "weekday", weekend: "weekend" };
// The columns that hold the numbers of the bot's messages that are still in a
// chat: its times, the picker, and the last alert. And whether the chat still
// has the bottom buttons an earlier version of the bot showed (1 once they are gone).
const MESSAGES = { summary: "summary", picker: "picker", alert: "alert" };
const ADDED_COLUMNS = ["summary INTEGER", "picker INTEGER", "alert INTEGER", "tidy INTEGER NOT NULL DEFAULT 0"];

function reply(status, body) {
  return { status, body };
}

function cut(text, most) {
  const letters = Array.from(String(text || ""));
  return letters.length > most ? letters.slice(0, most - 1).join("") + "…" : letters.join("");
}

/** The words as Telegram counts them under a picture: without the markup, each "&amp;" and the like as one letter. */
function shownLength(html) {
  return String(html).replace(/<[^>]*>/g, "").replace(/&(?:amp|lt|gt|quot);/g, "&").length;
}

/**
 * The picture that goes with an alert, next to the page: the day's timeline
 * and rain, drawn by the daily check (parkbot/picture.py). Only a name of the
 * kind the check makes is taken. Null when there is none.
 */
function pictureOf(entry, siteUrl) {
  return typeof entry.image === "string" && /^alerts\/[0-9a-f]{16}\.png$/.test(entry.image) ? `${siteUrl}${entry.image}` : null;
}

function escapeHtml(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Eight letters made from the token, to tell one token from the next. The token cannot be worked out from them. */
async function markOf(token) {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  return Array.from(hash.slice(0, 4), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Do two texts match? It takes as long whatever the answer, so a guess cannot be told by its timing. */
function same(given, kept) {
  const a = new TextEncoder().encode(String(given));
  const b = new TextEncoder().encode(String(kept));
  let differ = a.length ^ b.length;
  for (let index = 0; index < b.length; index += 1) differ |= (a[index] || 0) ^ b[index];
  return differ === 0 && b.length > 0;
}

/** A chat as it is kept, in the shape the words want: `{ id, weekday, weekend, paused }`. */
function chatFrom(row) {
  return {
    id: row.id,
    weekday: row.weekday ?? null,
    weekend: row.weekend ?? null,
    paused: Boolean(row.paused),
    summary: row.summary ?? null,
    picker: row.picker ?? null,
    tidy: Boolean(row.tidy),
  };
}

export class Bot {
  /**
   * `sql` is a Durable Object's SQLite database (exec), `storage` its other
   * storage (get, put, delete, setAlarm, getAlarm). `fetch`, `now`,
   * `settings` and `log` are what a Book is given. `token` is the bot's
   * token from Telegram, or "" while there is none.
   */
  constructor({ sql, storage, fetch, now, settings, log, token }) {
    this.sql = sql;
    this.storage = storage;
    this.fetch = fetch;
    this.now = now;
    this.settings = settings;
    this.log = log || (() => {});
    this.token = typeof token === "string" ? token.trim() : "";
  }

  /** Is there a bot to run? Only with its settings and its token. */
  get on() {
    return Boolean(this.settings.bot && this.token);
  }

  /** Set up the table of chats. Call once before anything else. */
  open() {
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS chats (id INTEGER PRIMARY KEY, weekday INTEGER, weekend INTEGER, paused INTEGER NOT NULL DEFAULT 0, added INTEGER NOT NULL, last TEXT)"
    );
    // Columns added after the first version. A table made by that version gets them now.
    const have = new Set(this.rows("SELECT name FROM pragma_table_info('chats')").map((row) => row.name));
    for (const column of ADDED_COLUMNS) {
      if (!have.has(column.split(" ")[0])) this.sql.exec(`ALTER TABLE chats ADD COLUMN ${column}`);
    }
  }

  rows(query, ...values) {
    return this.sql.exec(query, ...values).toArray();
  }

  chat(id) {
    const [row] = this.rows("SELECT id, weekday, weekend, paused, summary, picker, tidy FROM chats WHERE id = ?", id);
    return row ? chatFrom(row) : null;
  }

  count() {
    return this.rows("SELECT COUNT(*) AS n FROM chats")[0].n;
  }

  /**
   * Ask Telegram something, with the token. Returns `{ ok, status, result,
   * retryAfter, description }`, where `status` is 0 if no answer came. Never
   * throws, and never puts the address in an error: it holds the token.
   */
  async telegram(method, body = {}) {
    try {
      const answer = await this.fetch(`${TELEGRAM}/bot${this.token}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        // The token goes to this one address. If the answer points elsewhere, nothing follows it there.
        redirect: "manual",
        signal: AbortSignal.timeout(10000),
      });
      let said = null;
      try {
        said = await answer.json();
      } catch {
        // Not JSON: only the number of the answer is known.
      }
      const parameters = said && typeof said.parameters === "object" && said.parameters ? said.parameters : {};
      return {
        ok: Boolean(said && said.ok === true),
        status: answer.status,
        result: said ? said.result : undefined,
        retryAfter: Number(parameters.retry_after) || 0,
        description: said && typeof said.description === "string" ? cut(said.description, 100) : "",
      };
    } catch {
      return { ok: false, status: 0, result: undefined, retryAfter: 0, description: "" };
    }
  }

  async send(id, message) {
    return this.telegram("sendMessage", { chat_id: id, ...message });
  }

  /**
   * Tell Telegram where to bring what people write to the bot, with a
   * password only Telegram and this backend know. Done when the token is new,
   * then once a day. The first time with a token, the bot also gets its menu
   * of commands, and a description if it has none. Returns the notes on it.
   */
  async hook() {
    if (!this.on) return null;
    const now = this.now();
    const bot = this.settings.bot;
    let hook = (await this.storage.get("hook")) || {};
    if (!hook.secret) {
      // Made here and never shown: there is no password for a person to keep.
      hook = { secret: toBase64Url(crypto.getRandomValues(new Uint8Array(32))) };
    }
    const wanted = `${await markOf(this.token)} ${bot.address}`;
    // What the bot shows of itself: its name and its description. A change to either is made at the next look.
    const described = `${words.NAME}\n${words.description(bot.park)}`;
    const fresh = now - hook.at < (hook.ok ? HOOK_AGAIN_MS : HOOK_RETRY_MS);
    if (hook.wanted === wanted && fresh && (!hook.ok || hook.described === described)) return hook;

    const me = await this.telegram("getMe");
    if (!me.ok) {
      // 401 means that Telegram does not know the token.
      hook = { ...hook, wanted, at: now, ok: false, answer: me.status, error: me.description };
      await this.storage.put("hook", hook);
      this.log(`the bot: Telegram did not take the token (answer ${me.status})`);
      return hook;
    }
    const set = await this.telegram("setWebhook", { url: bot.address, secret_token: hook.secret, allowed_updates: UPDATES, max_connections: 10 });
    if (set.ok && hook.wanted !== wanted) {
      await this.telegram("setMyCommands", { commands: words.COMMANDS });
      this.log("the bot is set up");
    }
    if (set.ok && (hook.wanted !== wanted || hook.described !== described)) {
      await this.rename(words.NAME);
      await this.describe(words.description(bot.park));
    }
    // How Telegram's deliveries to this backend have gone, for the status page.
    const info = set.ok ? await this.telegram("getWebhookInfo") : null;
    const about = info && info.ok && info.result && typeof info.result === "object" ? info.result : {};
    hook = {
      secret: hook.secret,
      wanted,
      at: now,
      ok: set.ok,
      answer: set.status,
      described: set.ok ? described : hook.described || "",
      name: me.result && typeof me.result.username === "string" ? cut(me.result.username, 64) : "",
      pending: Number.isInteger(about.pending_update_count) ? about.pending_update_count : null,
      error: typeof about.last_error_message === "string" ? cut(about.last_error_message, 100) : set.ok ? "" : set.description,
      errorAt: Number(about.last_error_date) ? Number(about.last_error_date) * 1000 : null,
    };
    await this.storage.put("hook", hook);
    if (!set.ok) this.log(`the bot: Telegram did not take the address for messages (answer ${set.status})`);
    return hook;
  }

  /**
   * Give the bot its description: the words in an empty chat before someone
   * presses Start, and the shorter one on its profile. A description someone
   * wrote with @BotFather is left as it is; only an empty one, or one an
   * earlier version of the bot wrote, is replaced.
   */
  /** Give the bot its name, unless someone gave it a name of their own in @BotFather. */
  async rename(name) {
    const now = await this.telegram("getMyName");
    const there = now.ok && now.result && typeof now.result.name === "string" ? now.result.name : null;
    if (there !== null && there !== name && ["", ...words.EARLIER_NAMES].includes(there)) await this.telegram("setMyName", { name });
  }

  async describe(text) {
    const bot = this.settings.bot;
    const ours = new Set(["", text, ...words.earlierDescriptions(bot.park, bot)]);
    for (const [get, set, field] of [
      ["getMyDescription", "setMyDescription", "description"],
      ["getMyShortDescription", "setMyShortDescription", "short_description"],
    ]) {
      const now = await this.telegram(get);
      const there = now.ok && now.result && typeof now.result[field] === "string" ? now.result[field] : null;
      if (there !== null && there !== text && ours.has(there)) await this.telegram(set, { [field]: text });
    }
  }

  /**
   * Something Telegram brought: a message, a press of a button, or a person
   * blocking the bot. `secret` is the password Telegram sends with it.
   */
  async update(given, secret) {
    const hook = await this.storage.get("hook");
    if (!this.on || !hook || !hook.secret || !same(secret, hook.secret)) return reply(403, { ok: false, reason: "secret" });
    try {
      await this.handle(given);
    } catch (error) {
      // Telegram is still told that it arrived. Otherwise it would bring the same thing again and again.
      this.log(`the bot stumbled: ${cut(error && error.message, 200)}`);
    }
    return reply(200, { ok: true });
  }

  async handle(update) {
    if (!update || typeof update !== "object") return;
    if (update.my_chat_member) await this.memberChanged(update.my_chat_member);
    else if (update.callback_query) await this.pressed(update.callback_query);
    else if (update.message) await this.wrote(update.message);
  }

  /** A private chat with the bot, from what Telegram brought, or null for a group, a channel or anything else. */
  privateChat(chat) {
    return chat && chat.type === "private" && Number.isSafeInteger(chat.id) && chat.id > 0 ? chat.id : null;
  }

  /** Someone blocked the bot: they are taken off the list. */
  async memberChanged(change) {
    const id = this.privateChat(change.chat);
    const status = change.new_chat_member && change.new_chat_member.status;
    if (id && status === "kicked" && this.sql.exec("DELETE FROM chats WHERE id = ?", id).rowsWritten) this.log("a chat was removed (the bot was blocked)");
  }

  /** A new chat, with the times a new chat starts with. Null if the list is full. */
  start(id) {
    if (this.count() >= MOST_CHATS) return null;
    const bot = this.settings.bot;
    this.sql.exec(
      "INSERT INTO chats (id, weekday, weekend, paused, added, tidy) VALUES (?, ?, ?, 0, ?, 1) ON CONFLICT (id) DO NOTHING",
      id,
      bot.weekday,
      bot.weekend,
      this.now()
    );
    this.log("a chat started");
    return this.chat(id);
  }

  /** Take one message out of a chat. A message that is already gone, or too old for Telegram to take away, is left. */
  async remove(id, messageId, leftover = null) {
    if (!Number.isSafeInteger(messageId)) return;
    const said = await this.telegram("deleteMessage", { chat_id: id, message_id: messageId });
    // Telegram lets a bot take a message away only in its first two days. An older one is
    // emptied instead, when there are words to put in its place, so its buttons go.
    if (!said.ok && leftover) await this.telegram("editMessageText", { chat_id: id, message_id: messageId, text: leftover, reply_markup: { inline_keyboard: [] } });
  }

  /** Write down the number of one of the bot's messages that is now in the chat, or null once it is gone. */
  keep(id, which, messageId) {
    this.sql.exec(`UPDATE chats SET ${MESSAGES[which]} = ? WHERE id = ?`, Number.isSafeInteger(messageId) ? messageId : null, id);
  }

  /** The number of the message Telegram says it sent, or null. */
  static sentId(said) {
    return said.ok && said.result && Number.isSafeInteger(said.result.message_id) ? said.result.message_id : null;
  }

  /**
   * A chat from an earlier version of the bot still has its two bottom
   * buttons. A message that takes them away is sent, and taken away itself.
   */
  async tidy(chat) {
    if (chat.tidy) return;
    const said = await this.send(chat.id, { text: "🐕", reply_markup: { remove_keyboard: true } });
    await this.remove(chat.id, Bot.sentId(said));
    this.sql.exec("UPDATE chats SET tidy = 1 WHERE id = ?", chat.id);
  }

  /** Show a person's times in a new message at the bottom of the chat, and take away the one before. */
  async showSummary(id) {
    const chat = this.chat(id);
    await this.tidy(chat);
    const said = await this.send(id, words.summaryMessage(chat, this.settings.bot));
    await this.remove(id, chat.summary, words.LEFTOVER.summary);
    this.keep(id, "summary", Bot.sentId(said));
  }

  /** Open the picker for a time, in a new message, and take away a picker left open before. */
  async showPicker(id) {
    const chat = this.chat(id);
    await this.tidy(chat);
    const said = await this.send(id, words.pickerMessage());
    await this.remove(id, chat.picker, words.LEFTOVER.picker);
    this.keep(id, "picker", Bot.sentId(said));
  }

  async wrote(message) {
    const id = this.privateChat(message.chat);
    if (!id || (message.from && message.from.is_bot)) return;
    const intent = words.intentOf(message.text);
    let chat = this.chat(id);
    if (!chat) {
      chat = this.start(id);
      if (!chat) {
        await this.send(id, { text: words.FULL });
        return;
      }
    }
    // A command, or a tap on an old bottom button, has done its job once it is understood.
    if (intent !== "other") await this.remove(id, message.message_id);
    if (intent === "settings") {
      await this.showPicker(id);
      return;
    }
    if (intent === "pause" || intent === "resume") this.sql.exec("UPDATE chats SET paused = ? WHERE id = ?", intent === "pause" ? 1 : 0, id);
    await this.showSummary(id);
  }

  /** A button under one of the bot's messages was pressed. */
  async pressed(query) {
    const where = query.message || {};
    const id = this.privateChat(where.chat);
    // Telegram waits for every press to be answered, even one that leads nowhere.
    await this.telegram("answerCallbackQuery", { callback_query_id: String(query.id || "") });
    const bot = this.settings.bot;
    const button = words.buttonOf(query.data, bot);
    if (!id || !button || !Number.isSafeInteger(where.message_id)) return;
    let chat = this.chat(id) || this.start(id);
    if (!chat) return;
    const edit = (message) => this.telegram("editMessageText", { chat_id: id, message_id: where.message_id, ...message });
    if (button.action === "change") {
      await this.showPicker(id);
    } else if (button.action === "pick") {
      await edit(words.hoursMessage(chat, button.kind, bot));
      // The message pressed is the picker now, wherever it came from.
      if (chat.picker !== where.message_id) {
        await this.remove(id, chat.picker, words.LEFTOVER.picker);
        this.keep(id, "picker", where.message_id);
      }
    } else if (button.action === "back") {
      await edit(words.pickerMessage());
    } else if (button.action === "close") {
      await this.remove(id, where.message_id, words.LEFTOVER.picker);
      if (chat.picker === where.message_id) this.keep(id, "picker", null);
    } else {
      if (button.action === "set") this.sql.exec(`UPDATE chats SET ${COLUMN[button.kind]} = ? WHERE id = ?`, button.hour, id);
      else this.sql.exec("UPDATE chats SET paused = ? WHERE id = ?", button.action === "pause" ? 1 : 0, id);
      if (button.action === "set") {
        // A time is chosen: the picker has done its job.
        await this.remove(id, where.message_id, words.LEFTOVER.picker);
        if (chat.picker === where.message_id) this.keep(id, "picker", null);
      } else if (chat.summary !== where.message_id) {
        // Pause or resume pressed under an older "Your alerts": that one goes too.
        await this.remove(id, where.message_id, words.LEFTOVER.summary);
      }
      await this.showSummary(id);
    }
  }

  /** The page's words for the alerts, published by the daily check. */
  async alertWords(now) {
    const response = await this.fetch(`${this.settings.siteUrl}telegram.json?t=${now}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(`telegram.json answered ${response.status}`);
    const data = await response.json();
    if (!data || typeof data !== "object" || !Array.isArray(data.alerts)) throw new Error("telegram.json is not what was expected");
    return data;
  }

  /** Called at every look of the timer. Returns what was done and why, as `{ did, why }`. */
  async tick() {
    if (!this.on) return { did: "nothing", why: this.settings.bot ? "no token" : "no bot" };
    const hook = await this.hook();
    if (hook && hook.answer === 401) return this.note({ did: "nothing", why: "Telegram does not take the token" });
    return this.note(await this.consider());
  }

  async note(said) {
    // Kept for the status page: the last thing the bot's timer did, and why.
    await this.storage.put("look", { at: this.now(), did: said.did, why: said.why });
    return said;
  }

  async consider() {
    const nothing = (why) => ({ did: "nothing", why });
    const now = this.now();
    const bot = this.settings.bot;
    const local = localTime(now, this.settings.zone);
    const hour = Math.floor(local.minute / 60);
    const name = words.hourText(hour);

    const job = await this.storage.get("job");
    if (job) {
      if (now - job.startedAt < GIVE_UP_MS) {
        // Still sending. If its wake-up call was lost, set a new one.
        if ((await this.storage.getAlarm()) === null) await this.storage.setAlarm(now);
        return nothing(`the ${words.hourText(job.hour)} alerts are being sent`);
      }
      await this.finish(job, now, "abandoned");
    }
    if (hour < bot.first || hour > bot.last) return nothing("no alerts at this hour");
    const key = `${local.date} ${hour}`;
    if ((await this.storage.get("started")) === key) return nothing(`the ${name} alerts have gone out`);
    const [{ n: due }] = this.rows("SELECT COUNT(*) AS n FROM chats WHERE paused = 0 AND (weekday = ? OR weekend = ?)", hour, hour);
    if (!due) {
      await this.storage.put("started", key);
      return nothing(`nobody wants an alert at ${name}`);
    }

    let data;
    try {
      data = await this.alertWords(now);
    } catch (error) {
      return nothing(`telegram.json could not be read (${cut(error && error.message, 100)})`);
    }
    const entry = data.alerts.find(
      (one) => one && one.date === local.date && one.hour === hour && typeof one.text === "string" && one.text && /^\d{4}-\d\d-\d\d$/.test(String(one.about))
    );
    if (!entry) return nothing(`telegram.json has no words for ${name} today`);
    let warning = "";
    const made = Date.parse(data.generated);
    if (Number.isNaN(made) || now - made > STALE_HOURS * 3600 * 1000) {
      const since = typeof data.generatedText === "string" && data.generatedText ? ` since ${cut(data.generatedText, 40)}` : "";
      warning = `\n\n⚠️ The page has not been updated${escapeHtml(since)}, so this may be out of date.`;
    }
    const text = entry.text + warning;
    if (Array.from(text).length > 4000) return nothing(`the words for ${name} are too long for Telegram`);
    // The picture, with its caption under it. A telegram.json made before there
    // were captions has the words go under the picture instead.
    const caption = (typeof entry.caption === "string" && entry.caption ? entry.caption : entry.text) + warning;
    const photo = shownLength(caption) <= CAPTION_MOST ? pictureOf(entry, this.settings.siteUrl) : null;

    const kind = entry.weekend === true ? "weekend" : "weekday";
    await this.storage.put({
      started: key,
      job: { date: local.date, hour, about: entry.about, kind, text, caption, photo, after: 0, sent: 0, pictured: 0, gone: 0, failed: 0, startedAt: now },
    });
    await this.storage.setAlarm(now);
    this.log(`the ${name} alerts started`);
    return { did: "started", why: `${due} ${due === 1 ? "chat has" : "chats have"} ${name} as a time` };
  }

  /** One round of sending. Cloudflare calls this when the wake-up time set by `tick` or by the last round comes. */
  async alarm() {
    const job = await this.storage.get("job");
    if (!job) return;
    // Everyone whose time for this kind of day is this hour, who is not paused,
    // and who has not had an alert about that day yet, in turn.
    const chats = this.rows(
      `SELECT id, alert FROM chats WHERE paused = 0 AND ${COLUMN[job.kind]} = ? AND id > ? AND (last IS NULL OR last <> ?) ORDER BY id LIMIT ?`,
      job.hour,
      job.after,
      job.about,
      BATCH
    );
    let wait = PAUSE_MS;
    let slowed = false;
    for (const { id, alert } of chats) {
      let said = job.photo ? await this.sendPicture(id, job) : null;
      if (said && !said.ok && said.status === 400 && !GONE.test(said.description)) {
        // Telegram could not take the picture. The words go alone, to this chat and the rest.
        this.log(`the picture for the ${words.hourText(job.hour)} alerts could not be sent (${said.description || "no reason given"}), so they go without it`);
        job.photo = null;
        job.photoId = null;
        said = null;
      }
      if (!said) said = await this.send(id, { text: job.text, parse_mode: "HTML", link_preview_options: { is_disabled: true } });
      if (said.status === 429) {
        // Too many at once: this chat is tried again after the wait Telegram asks for.
        wait = Math.min(Math.max(said.retryAfter * 1000, PAUSE_MS), 60000);
        slowed = true;
        break;
      }
      if (said.ok) {
        job.sent += 1;
        this.sql.exec("UPDATE chats SET last = ?, alert = ? WHERE id = ?", job.about, Bot.sentId(said), id);
        // The alert before this one is no longer true.
        await this.remove(id, alert);
      } else if (said.status === 403 || (said.status === 400 && GONE.test(said.description))) {
        // The person blocked the bot, or their account is gone.
        job.gone += 1;
        this.sql.exec("DELETE FROM chats WHERE id = ?", id);
      } else {
        job.failed += 1;
      }
      job.after = id;
    }
    if (slowed || chats.length === BATCH) {
      await this.storage.put("job", job);
      await this.storage.setAlarm(this.now() + wait);
    } else {
      await this.finish(job, this.now());
    }
  }

  /**
   * Send the alert as its picture, with its caption under it. The first chat
   * gets the picture from the page. Telegram then has it, and gives it a
   * number of its own, so the other chats get it by that number, without
   * Telegram fetching it again.
   */
  async sendPicture(id, job) {
    const said = await this.telegram("sendPhoto", { chat_id: id, photo: job.photoId || job.photo, caption: job.caption || job.text, parse_mode: "HTML" });
    const sizes = said.ok && said.result && Array.isArray(said.result.photo) ? said.result.photo : [];
    const largest = sizes[sizes.length - 1];
    if (!job.photoId && largest && typeof largest.file_id === "string") job.photoId = largest.file_id;
    if (said.ok) job.pictured += 1;
    return said;
  }

  async finish(job, now, how = "finished") {
    const pictured = job.pictured || 0;
    const last = {
      date: job.date,
      hour: job.hour,
      about: job.about,
      kind: job.kind,
      how,
      startedAt: job.startedAt,
      finishedAt: now,
      sent: job.sent,
      pictured,
      gone: job.gone,
      failed: job.failed,
    };
    await this.storage.put("last", last);
    await this.storage.delete("job");
    this.log(`the ${words.hourText(job.hour)} alerts ${how}: ${job.sent} sent (${pictured} with the picture), ${job.gone} gone, ${job.failed} failed`);
  }

  /** For the status page: numbers only. No chat is named, and the password is never shown. */
  async status() {
    if (!this.on) return { on: false };
    const hook = await this.hook();
    const [counts] = this.rows("SELECT COUNT(*) AS chats, COALESCE(SUM(paused), 0) AS paused FROM chats");
    return {
      on: true,
      name: (hook && hook.name) || null,
      hook: hook ? { ok: Boolean(hook.ok), at: hook.at || null, answer: hook.answer || 0, pending: hook.pending ?? null, error: hook.error || "", errorAt: hook.errorAt || null } : null,
      chats: counts.chats,
      paused: counts.paused,
      sending: Boolean(await this.storage.get("job")),
      look: (await this.storage.get("look")) || null,
      last: (await this.storage.get("last")) || null,
    };
  }
}
