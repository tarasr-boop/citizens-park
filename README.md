# Citizens Park alerts

Is the oval at Citizens Park in Richmond free for dogs today?

The oval is a dog off-lead area, but dogs must stay off it while organised sport or training is on. This project checks the council's booking table and the rain forecast every day and tells people in three places:

- **A Telegram channel.** One post at about 3 PM Melbourne time, plus a quiet "week ahead" post on Sundays.
- **A web page.** Today's booked times hour by hour, the week ahead, rain by the hour in millimetres, and a QR code to share it: <https://citizensbark.com/>
- **A notification on a phone.** The same alert at about 3 PM, for people who do not use Telegram. The button for it is on the web page.

It is unofficial. It is not affiliated with the council or the sports clubs.

## What a post looks like

```
🐕 Citizens Park oval

🔴 Booked 4 to 8 PM

🌧 Rain likely between 5 PM and 8 PM (up to 80%, about 3 mm).
Based on the hourly forecast, the best window to avoid the rain is 8 to 9 PM.

Press here for the week ahead and rain by the hour
```

The post says when the oval is booked. Dogs can use it at any other time.

On a rainy day the post also names the best window to stay out of the rain. It looks between 5 and 9 PM (`advice_from` and `advice_until` in `config.toml`) and only at times when the oval is not booked. When no rain is forecast for those hours it says nothing, because any time outside the bookings is as good as another.

A post with no warning comes straight from the council's page. A post carries a warning only when there is a doubt:

| Warning | Meaning |
| --- | --- |
| ⚠️ Usual pattern only | The council's page does not cover the day yet, so the usual weekly pattern stands in. |
| ⚠️ Rough guide only | The usual pattern itself is a guess (see `schedule.toml`). |
| ⚠️ From the council's schedule, last read on ... | The council's page could not be read for more than a day, so the times come from the last copy. |

## How it works

A scheduled job on GitHub (the **Daily check** workflow) runs about nine times a day, from early morning to the evening. Each run:

1. reads the booking table on the [council's Citizens Park page](https://www.yarracity.vic.gov.au/things-to-do/parks-reserves-and-playgrounds/citizens-park)
2. gets the rain forecast from [Open-Meteo](https://open-meteo.com/)
3. works out today and the next seven days
4. rebuilds the web page and publishes it with GitHub Pages
5. posts to Telegram, once a day, on the first run after 2:30 PM
6. saves what it learned in the `data/` folder

Nothing needs a server, a database or a paid plan. The code uses only Python's standard library.

The line at the top of the page, "Last checked", is the last time a run read the council's page successfully. If a run cannot read it, the line keeps the time of the last read that worked.

It is built to keep going when something fails:

- If the council's page cannot be read, it uses the last good copy, and then the usual weekly pattern, and says so.
- If the weather service's usual server does not answer, it asks the service's other server straight away. If that fails too, it tries again for a few minutes. Then it uses the last forecast that did load (up to 12 hours old) and says when it is from.
- GitHub often starts scheduled jobs late, so there are several runs each afternoon. Only the first one posts.
- If a source keeps failing, it opens an issue in this repository, and GitHub emails you. See [When something goes wrong](#when-something-goes-wrong).

## Everyday changes

You can make all of these on GitHub: open the file, press the pencil icon, edit, then press **Commit changes**. The page rebuilds a minute or two later.

| To change | Edit |
| --- | --- |
| The Telegram channel | `channel` in `config.toml`. Use the link name: the part after `t.me/`. |
| The name shown at the top of the page | `name` under `[site]` in `config.toml` |
| The "About me" block | `text`, `link` and `link_text` under `[about]` in `config.toml`. Leave `text` empty to hide the block. |
| The hours on the page's timeline | `day_start` and `day_end` under `[park]` in `config.toml` |
| The tip button | `tip_url` in `config.toml`. Paste your Ko-fi link. Leave it empty to hide the button. |
| The usual weekly pattern | `schedule.toml`. It is only used on days the council's page does not cover. |
| The time of the daily post | `post_from` in `config.toml`, the run times in `.github/workflows/daily.yml`, and `ALERT_FROM` in `notifications/wrangler.jsonc`. The tests say so if they no longer agree. |
| The hours searched for the best window on a rainy day | `advice_from` and `advice_until` under `[telegram]` in `config.toml` |

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

1. Open **Actions** and look at the latest **Daily check** run. Its summary shows what happened.
2. Check that the secret `TELEGRAM_BOT_TOKEN` exists (**Settings**, **Secrets and variables**, **Actions**).
3. Check that the bot is an administrator of the channel and is allowed to post messages.
4. Check that `channel` in `config.toml` matches the channel's link.

If the page does not update, check **Settings**, **Pages**: the source must be **GitHub Actions**.

GitHub switches off scheduled jobs in a public repository after 60 days with no activity. This job saves its data every day, which counts as activity. If the runs ever stop, open **Actions** and press the button to turn the workflow back on.

**The bot token is a password.** Never put it in a file here or in a chat. If it leaks, send `/revoke` to @BotFather, then save the new token in the `TELEGRAM_BOT_TOKEN` secret.

## Notifications on a phone

The page can also send the daily alert straight to a phone or a computer, as a notification, for people who do not use Telegram. Someone opens the page, presses **Get the daily alert on this phone** and allows notifications. On an iPhone or iPad the page has to be added to the Home Screen first, and the page says so when the button is pressed.

This part needs one thing the rest does not: a small program that is always there, to keep the list of devices and to send the alert. It is in the `notifications/` folder and runs on Cloudflare's free plan, at <https://alerts.citizensbark.com>. Opening that address shows a few numbers: how many devices there are, and how the last alert went.

How it works:

- A browser gives each device an address for notifications, and the page hands that address to the backend. Nothing else is kept: no name, no email address, no location.
- Every five minutes through the afternoon, the backend looks at the page's `data.json`. As soon as it shows that the afternoon's check has run, the backend sends that day's words to every device. If no check has run by 3:15 PM, it sends what the page has for the day, and says so if that is from an earlier day.
- A new device gets one notification straight away, to show that it works.
- A device that turns alerts off is removed at once. An address that has stopped working is removed the next time an alert goes out.
- The words travel encrypted, so only the device can read them. The backend makes its own signing keys the first time it starts and never shows them, so there is no password for a person to keep.

### Switching it on

The backend is put on Cloudflare by the **Alerts backend** workflow. It needs two secrets, and until both exist it only runs the tests.

1. In Cloudflare, open [Workers & Pages](https://dash.cloudflare.com/?to=/:account/workers-and-pages). Under **Account Details**, copy the **Account ID**.
2. Open [Account API tokens](https://dash.cloudflare.com/?to=/:account/api-tokens) and press **Create Token**. Under **Permission policies**, open the **Custom** dropdown and choose **Edit Cloudflare Workers**. Give the token a name. For the resources it may reach, choose your account and the zone `citizensbark.com`. Create the token and copy it. Cloudflare shows it only once.
3. In this repository, open **Settings**, **Secrets and variables**, **Actions**, and save two repository secrets: `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`.
4. Open **Actions**, choose **Alerts backend**, then press **Run workflow**. The run ends by asking the backend how things are. The first time, Cloudflare needs a few minutes to set up the address.
5. Put the backend's address in `config.toml`, as `url` under `[notifications]`. The button appears on the page a minute or two later. While `url` is empty, the page has no button.

**The Cloudflare token is a password.** Never put it in a file here or in a chat. If it leaks, delete it on the Account API tokens page and make a new one.

### When notifications go wrong

- **Nobody got today's alert.** Open <https://alerts.citizensbark.com>. `timer` shows what the backend last did and why, and `last` shows how the last alert went. "waiting for the afternoon's check" means the Daily check has not run since 2:30 PM. The alert still goes out at 3:15 PM.
- **One phone gets nothing.** On that phone, open the page, turn the alerts off and on again. A first notification should arrive within a few seconds. On an iPhone, the page must be opened from the Home Screen icon.
- **The button is missing.** The browser cannot show notifications, or `url` under `[notifications]` is empty.
- **`unknownServices` is not empty.** A browser uses a notification service that the backend does not know yet. Add its name to the list in `notifications/src/rules.js` if it belongs to a real browser.

Limits: the backend takes up to 5,000 devices, and sends to them forty at a time, which the free plan carries comfortably.

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
  telegram.py   sends a post through the Bot API
  site.py       builds the web page
  web/          the page's template, styles and script
  watchdog.py   opens and closes the [watchdog] issues
  store.py      what is remembered between runs (the data/ folder)
notifications/  the backend that sends notifications to phones (JavaScript, runs on Cloudflare)
  src/webpush.js   encrypts and sends one notification, the way the web standards describe
  src/rules.js     the small decisions: the time at the park, which addresses are taken, the words
  src/book.js      the book of devices, and the daily sending
  src/worker.js    connects the book to Cloudflare: requests, the timer, the storage
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

The tests that run the page's script need Node, and the ones for the detour need `openssl`. Without them those tests are skipped. GitHub's runners have both.

Try a run on your own computer without posting anything:

```
python3 -m parkbot run --post never --data /tmp/park/data --site /tmp/park/site
```

Then open `/tmp/park/site/index.html`. Add `--now 2026-11-22T14:45` to pretend it is another time, or `--offline` to skip the web. `python3 -m parkbot run --help` lists every option.

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

`npm test` runs the backend with stand-ins for Cloudflare, the notification services and the page. A stand-in phone decrypts every notification, to check that the words arrive. `npm run runtime` bundles the code the way a deploy does and runs it in `workerd`, the program that runs it on Cloudflare's servers. Both run in the **Tests** workflow after every change.

The tools are pinned to exact versions in `notifications/package.json`. To move to a newer `wrangler`, change its version there, set `miniflare` to the version that `wrangler` asks for, and run `npm install` in that folder. The code in `notifications/src/` uses no package at all.

## Sources and credit

- Booking times: [City of Yarra, Citizens Park](https://www.yarracity.vic.gov.au/things-to-do/parks-reserves-and-playgrounds/citizens-park). The checker reads the public page a few times a day.
- Weather data by [Open-Meteo.com](https://open-meteo.com/).

Bookings can change and matches can run late, so the signs at the park always win.
