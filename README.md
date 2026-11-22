# Citizens Park alerts

Is the oval at Citizens Park in Richmond free for dogs today?

The oval is a dog off-lead area, but dogs must stay off it while organised sport or training is on. This project checks the council's booking table and the rain forecast every day and tells people in three places:

- **A web page.** Today's booked times hour by hour, the week ahead, rain by the hour in millimetres, and a QR code to share it: <https://citizensbark.com/>
- **A notification on a phone.** The same alert at the same times, for people who do not use Telegram. The button for it is on the web page.
- **Custom alerts from the Telegram bot.** The same alert in a private chat, at a time each person picks: one for weekdays and one for weekends. See [The Telegram bot](#the-telegram-bot).

There used to be a Telegram channel as well, posting once a day at about 4 PM on weekdays and 8 AM on weekends. On 21 November 2026 it moved to the bot: it got one last post pointing there and posts nothing more.

It is unofficial. It is not affiliated with the council or the sports clubs.

## What a post looks like

```
🐕 Citizens Park oval

🔴 Booked 4 to 8 PM

🌧 Rain likely between 5 PM and 8 PM (up to 80%, about 3 mm).
Based on the hourly forecast, the best window to avoid the rain is 8 to 9 PM.

Press here for the week ahead and rain by the hour
```

The post says when the oval is booked. Dogs can use it at any other time. The [Telegram bot](#the-telegram-bot) sends these words under a picture of the page's answer and timeline.

On a rainy day the post also names the best window to stay out of the rain. It looks between 5 and 9 PM (`advice_from` and `advice_until` in `config.toml`) and only at times when the oval is not booked. When no rain is forecast for those hours it says nothing, because any time outside the bookings is as good as another.

A post with no warning comes straight from the council's page. A post carries a warning only when there is a doubt:

| Warning | Meaning |
| --- | --- |
| ⚠️ Usual pattern only | The council's page does not cover the day yet, so the usual weekly pattern stands in. |
| ⚠️ Rough guide only | The usual pattern itself is a guess (see `schedule.toml`). |
| ⚠️ From the council's schedule, last read on ... | The council's page could not be read for more than a day, so the times come from the last copy. |

## How it works

A scheduled job on GitHub (the **Daily check** workflow) runs about a dozen times a day, from early morning to the evening. Each run:

1. reads the booking table on the [council's Citizens Park page](https://www.yarracity.vic.gov.au/things-to-do/parks-reserves-and-playgrounds/citizens-park)
2. gets the rain forecast from [Open-Meteo](https://open-meteo.com/)
3. works out today and the next seven days
4. rebuilds the web page, with a picture for each of the Telegram bot's alerts, and publishes it with GitHub Pages
5. posts to Telegram, once a day: on the first run from half an hour before the alert's time (4 PM on weekdays, 8 AM on weekends)
6. saves what it learned in the `data/` folder

Nothing needs a server, a database or a paid plan. The code uses only Python's standard library.

The line at the top of the page, "Last checked", is the last time a run read the council's page successfully. If a run cannot read it, the line keeps the time of the last read that worked.

It is built to keep going when something fails:

- If the council's page cannot be read, it uses the last good copy, and then the usual weekly pattern, and says so.
- If the weather service's usual server does not answer, it asks the service's other server straight away. If that fails too, it tries again for a few minutes. Then it uses the last forecast that did load (up to 12 hours old) and says when it is from.
- GitHub often starts scheduled jobs late, sometimes by many hours. So there are three runs around the alert's time, of which only the first posts, and a [second timer](#the-second-timer) on Cloudflare starts a run that GitHub has missed.
- If a source keeps failing, it opens an issue in this repository, and GitHub emails you. See [When something goes wrong](#when-something-goes-wrong).

## Everyday changes

You can make all of these on GitHub: open the file, press the pencil icon, edit, then press **Commit changes**. The page rebuilds a minute or two later.

| To change | Edit |
| --- | --- |
| The Telegram channel | `channel` in `config.toml`. Use the link name: the part after `t.me/`. With `retired = true` under it (as now), the channel gets one last post pointing to the bot and nothing after, and the page leaves it out. Set `retired = false` to bring the daily post back. |
| The name shown at the top of the page | `name` under `[site]` in `config.toml` |
| The "About me" block | `text`, `link` and `link_text` under `[about]` in `config.toml`. Leave `text` empty to hide the block. |
| The hours on the page's timeline | `day_start` and `day_end` under `[park]` in `config.toml` |
| The tip button | `tip_url` in `config.toml`. Paste your Ko-fi link. Leave it empty to hide the button. |
| The feedback button in "How this works" | `feedback_email` under `[site]` in `config.toml`. It opens an email to that address, which anyone can then read on the page. Leave it empty to hide the button. |
| The usual weekly pattern | `schedule.toml`. It is only used on days the council's page does not cover. |
| The times of the daily alert | `weekdays` and `weekends` under `[alerts]` in `config.toml`, the run times in `.github/workflows/daily.yml` (the post run is set for 20 minutes before the alert's time), and `ALERT_WEEKDAYS`, `ALERT_WEEKENDS` and `CHECK_TIMES` in `notifications/wrangler.jsonc`. The tests say so if they no longer agree. |
| The hours searched for the best window on a rainy day | `advice_from` and `advice_until` under `[telegram]` in `config.toml` |
| The hours people can pick in the Telegram bot, and the times a new chat starts with | The `[bot]` section of `config.toml`, and the `BOT_` settings in `notifications/wrangler.jsonc`. The tests say so if they no longer agree. |
| The link button under the times in the Telegram bot (now Sofia's Instagram) | `BOT_LINK` (the address) and `BOT_LINK_TEXT` (the button's words) in `notifications/wrangler.jsonc`. Leave `BOT_LINK` empty to hide the button. |

The **Tests** workflow runs after every change. If you get an email saying it failed, the edit probably has a typing slip, such as a missing quotation mark. Open the failed run to see which file it names.

## Running it by hand

Go to **Actions**, choose **Daily check**, then press **Run workflow**. The `post` box decides what happens on Telegram:

- `auto`: post only if today's post is due and has not gone out yet
- `force`: post now, whatever the time. Use this to test the channel.
- `never`: only rebuild the page

Tick **show_sources** to print the council's raw table in the log. That helps when the booking times look wrong.

## When something goes wrong

The job watches itself. When there is a problem it opens an issue whose title starts with `[watchdog]`, and it closes the issue by itself when the problem has gone.

| Issue | What it means | What to do |
| --- | --- | --- |
| The council page cannot be read | Four checks in a row failed. | Open the council's page in a browser. If it looks normal, the layout of its table may have changed and the reader needs an update. |
| The council page is out of date | The page has not covered today for a week. | Nothing is broken. Posts use the usual pattern. Update `schedule.toml` if the pattern has changed. |
| The rain forecast cannot be read | Four checks in a row got no forecast. | Usually it fixes itself. Posts use the last forecast that loaded for up to 12 hours, then go out without the rain line. |
| The Telegram post is not going out | Telegram refused the post. | The issue says why. See the list below. |

If the post did not arrive:

1. Open **Actions** and look at the latest **Daily check** run. Its summary shows what happened. If there was no run around the alert's time, start one by hand (see [Running it by hand](#running-it-by-hand)), then see [The second timer](#the-second-timer).
2. Check that the secret `TELEGRAM_BOT_TOKEN` exists (**Settings**, **Secrets and variables**, **Actions**).
3. Check that the bot is an administrator of the channel and is allowed to post messages.
4. Check that `channel` in `config.toml` matches the channel's link.

If the page does not update, check **Settings**, **Pages**: the source must be **GitHub Actions**.

GitHub switches off scheduled jobs in a public repository after 60 days with no activity. This job saves its data every day, which counts as activity. If the runs ever stop, open **Actions** and press the button to turn the workflow back on.

**The bot token is a password.** Never put it in a file here or in a chat. If it leaks, send `/revoke` to @BotFather, then save the new token in the `TELEGRAM_BOT_TOKEN` secret.

## Notifications on a phone

The page can also send the daily alert straight to a phone or a computer, as a notification, for people who do not use Telegram. Someone opens the page, presses **Get alerts on this phone** and allows notifications. On an iPhone or iPad the page has to be added to the Home Screen first, and the page says so when the button is pressed.

This part needs one thing the rest does not: a small program that is always there, to keep the list of devices and to send the alert. It is in the `notifications/` folder and runs on Cloudflare's free plan, at <https://alerts.citizensbark.com>. Opening that address shows a few numbers: how many devices there are, and how the last alert went.

How it works:

- A browser gives each device an address for notifications, and the page hands that address to the backend. Nothing else is kept: no name, no email address, no location.
- Every five minutes through the day, the backend looks at the clock. From half an hour before the alert's time (4 PM on weekdays, 8 AM on weekends) it reads the page's `data.json`. As soon as that shows a check from inside that half hour or later, the backend sends that day's words to every device. If no such check has run a quarter of an hour after the alert's time, it sends what the page has for the day, and says so if that is from an earlier day.
- A new device gets one notification straight away, to show that it works.
- A device that turns alerts off is removed at once. An address that has stopped working is removed the next time an alert goes out.
- The words travel encrypted, so only the device can read them. The backend makes its own signing keys the first time it starts and never shows them, so there is no password for a person to keep.

### Switching it on

The backend is put on Cloudflare by the **Alerts backend** workflow. It needs two secrets, and until both exist it only runs the tests.

1. In Cloudflare, open [Workers & Pages](https://dash.cloudflare.com/?to=/:account/workers-and-pages). Under **Account Details**, copy the **Account ID**.
2. Open [Account API tokens](https://dash.cloudflare.com/?to=/:account/api-tokens) and press **Create Token**. Under **Permission policies**, open the **Custom** dropdown and choose **Edit Cloudflare Workers**. Two lines of permissions appear, for your account and for its zones. Leave them as they are and give the token a name. Create the token and copy it. Cloudflare shows it only once.
3. In this repository, open **Settings**, **Secrets and variables**, **Actions**, and save two repository secrets: `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`.
4. Open **Actions**, choose **Alerts backend**, then press **Run workflow**. The run ends by asking the backend how things are. The first time, Cloudflare needs a few minutes to set up the address.
5. Put the backend's address in `config.toml`, as `url` under `[notifications]`. The button appears on the page a minute or two later. While `url` is empty, the page has no button.

**The Cloudflare token is a password.** Never put it in a file here or in a chat. If it leaks, delete it on the Account API tokens page and make a new one.

### When notifications go wrong

- **Nobody got today's alert.** Open <https://alerts.citizensbark.com>. `timer` shows what the backend last did and why, and `last` shows how the last alert went. "waiting for the check before the alert" means the Daily check has not run since half an hour before the alert's time. The alert still goes out a quarter of an hour after its time: at 4:15 PM on weekdays and 8:15 AM on weekends.
- **One phone gets nothing.** On that phone, open the page, turn the alerts off and on again. A first notification should arrive within a few seconds. On an iPhone, the page must be opened from the Home Screen icon.
- **The button is missing.** The browser cannot show notifications, or `url` under `[notifications]` is empty.
- **`unknownServices` is not empty.** A browser uses a notification service that the backend does not know yet. Add its name to the list in `notifications/src/rules.js` if it belongs to a real browser.
- **`last` counts a device as `refused`, or `refusals` is not empty.** A notification service would not take a message. `refusals` says which service, the number of its answer, how often, on which day last, and the service's own words. It names the service (a server of Apple, Google, Mozilla or Microsoft), never a device. One refused device mends itself: the next time its owner opens the page, it is tried again and, if it is still refused, given a fresh address. If one service refuses every device, the fault is more likely in the backend, and the number and the words say where to look.

Limits: the backend takes up to 5,000 devices, and sends to them forty at a time, which the free plan carries comfortably.

## The second timer

GitHub's own timer starts the Daily check late. In this repository's first days it was eight to nine hours late, which is too late for the post. So the backend on Cloudflare keeps a second timer for it. A quarter of an hour after each of the check's set times, it looks at the page. If the page still shows an older check, it asks GitHub to run the check now, the same way the **Run workflow** button does. If the page is no newer ten minutes later, it asks again, up to three times for each set time. A run too many does no harm, because the check posts once a day.

If you see Daily check runs in the middle of the night, those are GitHub's own timer running late. They do no harm either: nothing is posted outside the posting window.

It needs the backend to be on Cloudflare (see [Switching it on](#switching-it-on)) and one more secret: a token from GitHub that lets the backend start this repository's workflows.

1. Open [the form for a new token](https://github.com/settings/personal-access-tokens/new?name=Citizens+Bark+second+timer&description=Lets+the+alerts+backend+start+the+Daily+check&expires_in=none&actions=write) on GitHub. This link fills in the name, no expiry date and the one permission.
2. Under **Repository access**, choose **Only select repositories** and pick this repository.
3. Under **Permissions**, check that **Actions** is there with **Read and write**. If it is not, add it. GitHub adds **Metadata** by itself. Nothing else is needed.
4. Press **Generate token** and copy the token. GitHub shows it only once.
5. In this repository, open **Settings**, **Secrets and variables**, **Actions**, and save it as a repository secret named `DAILY_CHECK_TOKEN`.
6. Open **Actions**, choose **Alerts backend**, then press **Run workflow**. The run hands the token to Cloudflare and checks that the backend then says its second timer is on.

The token lets its holder start, cancel and switch off this repository's workflows. It cannot change a file or read a secret, and it has no rights in any other repository. **It is still a password.** Never put it in a file here or in a chat. If it leaks, delete it under [Fine-grained tokens](https://github.com/settings/personal-access-tokens) and go through the six steps again.

To see what the second timer is doing, open <https://alerts.citizensbark.com> and read `starter`:

- `on` is `true` once the token has been handed over.
- `look` is what it last did, and why.
- `check` is the last set time it looked after: how often it started the check (`tries`), how often GitHub did not take the request (`fails`), the number of GitHub's last answer, and whether the page has shown the check since (`done`). A number from 200 to 299, usually 204, means taken. 403 or 404 means the token may not start this repository's workflows, so make a new one and take care with steps 2 and 3.
- `token` is GitHub's answer to a question the backend asks once a day: is the token still good? 200 means yes. 401 means GitHub does not know the token. The backend then leaves the token alone and asks again every half hour. If the answer stays 401, make a new token.

To switch the second timer off, make `CHECK_TIMES` empty (`""`) in `notifications/wrangler.jsonc`. After that the token is no longer needed, and you can delete it on GitHub.

`CHECK_TIMES` holds the run times of `.github/workflows/daily.yml`. If you change one, change the other. The tests fail until they agree.

## The Telegram bot

The bot, called **Citizens Bark** (link name @CitizensParkDogsBot), sends the daily alert in a private chat, at a time each person picks. It took over from the channel, which it also posted to. Someone opens a chat with the bot (the page's Telegram button leads there) and presses **Start**. From then on they get the alert at 4 PM on weekdays and 8 AM on weekends.

The chat stays tidy. It holds one message with the person's times ("Your alerts"), with buttons under it: **Change times**, **Pause notifications** (which becomes **Resume notifications** while the alerts are paused), and **Book a consultation with Sofia**, which opens her Instagram. **Change times** opens a picker with **Weekdays** and **Weekends**, each with a grid of hours from 4 AM to 11 PM plus **No alert**. Once a time is picked, the picker goes, and a fresh "Your alerts" takes the place of the old one at the bottom of the chat. The bot also takes away what people send it (`/start`, `/pause`, and the like), and yesterday's alert when today's arrives. The bot's menu has the same as commands: `/settings`, `/pause` and `/resume`.

The bot writes its own description, the words shown in an empty chat: "When is the Citizens Park oval booked, and is rain on the way? I'll send you an alert at a time you choose." If you write a different one with @BotFather, the bot leaves yours alone.

The alert is a picture of the top of the page, with the words the channel used to post under it. The picture shows the answer ("Booked until 5 PM") and the day's timeline, with a line at the alert's time and the rain by the hour, as the page looks at that moment, in its dark colours. The words are written for their own time of day. At 8 AM they name every booking of the day, at 4 PM only what is left of it. An alert at 9 PM or later is about the next day, sent the evening before, and its heading says "tomorrow". Its picture is that day's timeline alone, with no answer at the top and no line, as it has no "now" to speak of. Whether a person's weekday or weekend time counts follows the day the alert is about: a 9 PM alert on a Friday is about Saturday, so it goes to people whose weekend time is 9 PM.

How it works:

- Each Daily check writes the alert for every hour people can pick, today and tomorrow, into `telegram.json` next to the page. The bot itself knows nothing about bookings or rain.
- The same check draws each alert's picture with the page's own script and style, in Google Chrome without a window (GitHub's runners have it), and puts it next to the page in `alerts/`. The words in it are set in Inter, a font that comes with the code (`parkbot/web/card-font.woff2`, free to share under the SIL Open Font License), so a picture looks the same wherever it is drawn. The run's log says how many it drew ("Alert pictures: 27 drawn for 33 of 33 alerts"). If they cannot be drawn, the log has a warning and the alerts go out as words alone, as before.
- The words go under the picture as its caption, so they still say everything for someone who cannot see the picture well. Telegram takes up to 1,024 letters there. Longer words go alone, without the picture. If Telegram cannot fetch the picture, the alerts of that hour go as words alone.
- The bot runs on the same backend as the notifications, at <https://alerts.citizensbark.com>. Telegram brings what people write to it there. The backend sets that up by itself, with a password it makes and never shows, so that only Telegram can talk to it.
- In the first minutes of each hour, the backend sends that hour's words to everyone who picked it, about 25 a second.
- For each chat it keeps the chat's number, the two times, whether the alerts are paused, the last day it sent an alert about, and the numbers of the bot's own messages there, so it can take them away. No name, no user name, nothing anyone wrote. Someone who blocks the bot is removed at once.
- It takes up to 5,000 chats.

It needs the bot's token on Cloudflare. The **Alerts backend** workflow hands it over from the `TELEGRAM_BOT_TOKEN` secret, the one the channel already uses, so there is nothing to set up. If you ever change that secret, run **Alerts backend** by hand once.

To see how the bot is doing, open <https://alerts.citizensbark.com> and read `telegram`:

- `on` is `true` once the token has been handed over, and `name` is the bot's link name.
- `hook` says whether Telegram took the address for messages (`ok`), how many messages are waiting (`pending`), and Telegram's last complaint about delivering them (`error`).
- `chats` is how many people have the bot, and `paused` how many of them paused it.
- `look` is what the bot last did, and why. `last` is how the last hour's alerts went: `sent`, `pictured` (how many of those went with the picture), `gone` (people who blocked the bot) and `failed`.

The bot gives itself its name, unless someone gave it a different one with @BotFather. Its link name, @CitizensParkDogsBot, stays as it is.

## Stats

<https://alerts.citizensbark.com/stats> shows, for each day of a month and for every month since counting began:

- visits, different devices, first-time devices and devices that came back on a later day
- when people visit (by the hour), how long after their last visit returning devices come back, and which visit it was for that device
- how they found the page: the QR code, Telegram, a search, or no link at all
- how long each look at the page lasted
- the kind of device, its system and browser, its rough place and its network
- which buttons and links were pressed
- visits that look automated (a program that says so, or a request from a data centre), kept out of all the other numbers
- a list of visitors (once the page has a password, see below): one fold per device, latest first, with when it first came and how, each of its visits in the month or day, how long it stayed in all, what it pressed, and its device, rough place and network

The arrows at the top go to earlier months, and each day in "Each day" opens on its own. Every day is kept for good.

The page counts for itself, through the same backend as the notifications, so it needs no outside service and no cookies. It sends only what happened ("a visit, this device's 3rd, 2 days after its last one", or "the first button was pressed"), never anything about the person. A device knows it has been here before only because its browser remembers the date of its last visit, how many visits it has made, and a random number it picked the first time (16 hexadecimal digits, made on the device and tied to nothing else). That number is what lets the list of visitors put one device's visits together. The backend adds the browser's own description of itself and the rough place and network Cloudflare works out from the internet address; the address itself is never kept. A private window, or a browser whose history was cleared, counts as a new device. Programs that do not run the page's script, such as link previews in chat apps, are not counted at all.

The QR code holds the address with `?qr` after it, so visits through it can be told apart. To leave your own phone or computer out of the numbers, open <https://citizensbark.com/?me> once in each browser you use (`?me=off` undoes it). Both markers are taken out of the address as the page opens.

### The stats password

The list of visitors comes close to a profile of each device, so it is shown only behind a password:

1. In the repository's **Settings**, **Secrets and variables**, **Actions**, add a secret named `STATS_PASSWORD` with a long password of your choosing.
2. Run **Alerts backend** (or merge any change to `notifications/`). The deploy hands the password to Cloudflare.
3. Open <https://alerts.citizensbark.com/stats>. The browser asks for a name and a password: any name will do, the password is the one you chose.

Behind the password, two buttons at the top of the page download everything kept: **Download as Excel** gives an .xlsx workbook (sheets for months, days, visitors, single visits and each day's breakdowns, with an About sheet that explains every column), and **Download for Claude (JSON)** gives the same as one JSON file with an `about` part that explains each field. Either can be uploaded to Claude as it is. Visitors are numbered by when they first came, without the device's random number. The buttons carry a signed key, so the browser is not asked for the password again (some browsers, Safari among them, do not send it with a download); a key works for 12 hours and only for the files, and changing the password ends it.

To change the password, change the secret and run **Alerts backend** again. Without the secret, the page is open to anyone who knows its address and shows totals only, never the list. Devices are listed from 22 November 2026; earlier days have totals only. Each device keeps its row for good, like the daily totals; at most 500 new devices are added a day and 20,000 in all.

## Setting it up from scratch

1. Make the repository public. In **Settings**, **Pages**, set the source to **GitHub Actions**.
2. Create a bot with @BotFather in Telegram (`/newbot`) and copy its token.
3. Save the token as a repository secret named `TELEGRAM_BOT_TOKEN`.
4. Create a public Telegram channel. Add the bot as an administrator with **Post Messages** switched on.
5. Put the channel's link name in `config.toml`.
6. Run **Daily check** by hand with `post` set to `force`. A post should appear in the channel.

Until a channel is set, nothing is posted and the page leaves out its Telegram button.

## If the page's address changes

The QR code holds the page's address. If you rename the repository or move the page to your own domain:

1. Change `url` under `[site]` in `config.toml`.
2. Make the QR code again on a computer with Python:

   ```
   pip install segno
   python3 tools/make_qr.py
   ```

3. Commit the new files in `assets/`.
4. Change `SITE_URL` in `notifications/wrangler.jsonc` to the same address, so that the notifications backend goes on listening to the page.

The tests fail while the QR code or the backend's settings do not match the address, so neither can be forgotten. A QR code that was already printed keeps the old address.

## For developers

```
parkbot/
  cli.py        the command the job runs: python3 -m parkbot run
  fetch.py      fetches a page patiently, and can ask a site's other server when one does not answer
  council.py    reads the council's monthly table from its HTML
  pattern.py    the usual weekly pattern, learned from the council's data or from schedule.toml
  status.py     decides what to say about each day, and how sure it is
  weather.py    reads the Open-Meteo forecast and sums up the rain
  message.py    the words of the Telegram posts
  bot.py        the words of the Telegram bot's alerts, for every hour (telegram.json)
  picture.py    draws the picture that goes with each of those alerts, in a browser without a window
  telegram.py   sends a post through the Bot API
  site.py       builds the web page
  web/          the page's template, styles and script, and the page the pictures are drawn from (card.html)
  watchdog.py   opens and closes the [watchdog] issues
  store.py      what is remembered between runs (the data/ folder)
notifications/  the backend that sends notifications to phones (JavaScript, runs on Cloudflare)
  src/webpush.js   encrypts and sends one notification, the way the web standards describe
  src/rules.js     the small decisions: the time at the park, which addresses are taken, the words, the settings
  src/book.js      the book of devices, and the daily sending
  src/starter.js   the second timer, which starts the Daily check when GitHub's own timer has not
  src/stats.js     the counter behind the stats page: visits, devices, returns, sources and presses, kept by the day
  src/statspage.js the stats page itself
  src/bot.js       the Telegram bot: its chats, their times, and the sending at each hour
  src/botwords.js  what the bot says in a chat, and its buttons
  src/worker.js    connects them to Cloudflare: requests, the timer, the storage
  test/            its tests
  wrangler.jsonc   its settings on Cloudflare
config.toml     settings
schedule.toml   the usual weekly pattern
data/           what the job remembers between runs (the job writes it)
assets/         icons and the QR code
tools/          makes the icons and the QR code (needs requirements-dev.txt)
tests/          unit tests
```

Run the tests:

```
python3 -m unittest discover -s tests -t .
```

The tests that run the page's script need Node, the ones for the detour need `openssl`, and the ones that draw the bot's pictures need Google Chrome or Chromium (`CHROME` can name it). Without them those tests are skipped. GitHub's runners have all three.

Try a run on your own computer without posting anything:

```
python3 -m parkbot run --post never --data /tmp/park/data --site /tmp/park/site
```

Then open `/tmp/park/site/index.html`, and the bot's pictures in `/tmp/park/site/alerts/`. Add `--now 2026-11-22T14:45` to pretend it is another time, or `--offline` to skip the web. `python3 -m parkbot run --help` lists every option.

The weather service has more than one server. A run remembers the address of each one that answers (in `data/state.json`), and when the usual one says nothing it asks another by its address. To try that detour on purpose:

```
python3 -m parkbot routes
```

It asks each known server for the forecast and prints how it went. The **Tests** workflow runs it after every change.

Python 3.11 or newer is needed. The job itself installs nothing.

The notifications backend has its own tests, which need Node 22.12 or newer:

```
cd notifications
npm ci
npm test
npm run runtime
```

`npm test` runs the backend with stand-ins for Cloudflare, the notification services, the page and GitHub. A stand-in phone decrypts every notification, to check that the words arrive. `npm run runtime` bundles the code the way a deploy does and runs it in `workerd`, the program that runs it on Cloudflare's servers. Both run in the **Tests** workflow after every change.

The tools are pinned to exact versions in `notifications/package.json`. To move to a newer `wrangler`, change its version there, set `miniflare` to the version that `wrangler` asks for, and run `npm install` in that folder. The code in `notifications/src/` uses no package at all.

## Sources and credit

- Booking times: [City of Yarra, Citizens Park](https://www.yarracity.vic.gov.au/things-to-do/parks-reserves-and-playgrounds/citizens-park). The checker reads the public page a few times a day.
- Weather data by [Open-Meteo.com](https://open-meteo.com/).

Bookings can change and matches can run late, so the signs at the park always win.
