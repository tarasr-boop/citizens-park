# Citizens Park alerts

Is the oval at Citizens Park in Richmond free for dogs today?

The oval is a dog off-lead area, but dogs must stay off it while organised sport or training is on. This project checks the council's booking table and the rain forecast every day and tells people in two places:

- **A Telegram channel.** One post at about 3 PM Melbourne time, plus a quiet "week ahead" post on Sundays.
- **A web page.** Today's booked times, the week ahead, rain by the hour, a QR code and a poster to print: <https://tarasr-boop.github.io/citizens-park/>

It is unofficial. It is run by a local dog owner, not by the council or the sports clubs.

## What a post looks like

```
🐕 Citizens Park oval · Fri 20 Nov

🔴 Booked 4 to 8 PM
🟢 Free until 4 PM, then from 8 PM

🌧 Rain likely between 5 PM and 8 PM (up to 80%, about 3 mm).
✅ From the council's schedule.

The week ahead and rain by the hour
```

Every post says how sure it is:

| Mark | Meaning |
| --- | --- |
| ✅ From the council's schedule | The day is on the council's page. |
| ⚠️ Usual pattern only | The council's page does not cover the day yet, so the usual weekly pattern stands in. |
| ⚠️ Rough guide only | The usual pattern itself is a guess (see `schedule.toml`). |

## How it works

A scheduled job on GitHub (the **Daily check** workflow) runs a few times a day. Each run:

1. reads the booking table on the [council's Citizens Park page](https://www.yarracity.vic.gov.au/things-to-do/parks-reserves-and-playgrounds/citizens-park)
2. gets the rain forecast from [Open-Meteo](https://open-meteo.com/)
3. works out today and the next seven days
4. rebuilds the web page and publishes it with GitHub Pages
5. posts to Telegram, once a day, on the first run after 2:30 PM
6. saves what it learned in the `data/` folder

Nothing needs a server, a database or a paid plan. The code uses only Python's standard library.

It is built to keep going when something fails:

- If the council's page cannot be read, it uses the last good copy, and then the usual weekly pattern, and says so.
- If the forecast does not load, it uses the last one that did (up to 12 hours old) and says when it is from.
- GitHub often starts scheduled jobs late, so there are several runs each afternoon. Only the first one posts.
- If a source keeps failing, it opens an issue in this repository, and GitHub emails you. See [When something goes wrong](#when-something-goes-wrong).

## Everyday changes

You can make all of these on GitHub: open the file, press the pencil icon, edit, then press **Commit changes**. The page rebuilds a minute or two later.

| To change | Edit |
| --- | --- |
| The Telegram channel | `channel` in `config.toml`. Use the link name: the part after `t.me/`. |
| The name shown at the top of the page | `name` under `[site]` in `config.toml` |
| The tip button | `tip_url` in `config.toml`. Paste your Ko-fi link. Leave it empty to hide the button. |
| The usual weekly pattern | `schedule.toml`. It is only used on days the council's page does not cover. |
| The time of the daily post | `post_from` in `config.toml`, and the run times in `.github/workflows/daily.yml` |

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
| The rain forecast cannot be read | Four checks in a row got no forecast. | Usually it fixes itself. Posts go out without the rain line. |
| The Telegram post is not going out | Telegram refused the post. | The issue says why. See the list below. |

If the post did not arrive:

1. Open **Actions** and look at the latest **Daily check** run. Its summary shows what happened.
2. Check that the secret `TELEGRAM_BOT_TOKEN` exists (**Settings**, **Secrets and variables**, **Actions**).
3. Check that the bot is an administrator of the channel and is allowed to post messages.
4. Check that `channel` in `config.toml` matches the channel's link.

If the page does not update, check **Settings**, **Pages**: the source must be **GitHub Actions**.

GitHub switches off scheduled jobs in a public repository after 60 days with no activity. This job saves its data every day, which counts as activity. If the runs ever stop, open **Actions** and press the button to turn the workflow back on.

**The bot token is a password.** Never put it in a file here or in a chat. If it leaks, send `/revoke` to @BotFather, then save the new token in the `TELEGRAM_BOT_TOKEN` secret.

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

The tests fail while the QR code and the address do not match, so a forgotten QR code cannot go unnoticed. Posters that were already printed keep the old address.

## For developers

```
parkbot/
  cli.py        the command the job runs: python3 -m parkbot run
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

Try a run on your own computer without posting anything:

```
python3 -m parkbot run --post never --data /tmp/park/data --site /tmp/park/site
```

Then open `/tmp/park/site/index.html`. Add `--now 2026-11-22T14:45` to pretend it is another time, or `--offline` to skip the web. `python3 -m parkbot run --help` lists every option.

Python 3.11 or newer is needed. The job itself installs nothing.

## Sources and credit

- Booking times: [City of Yarra, Citizens Park](https://www.yarracity.vic.gov.au/things-to-do/parks-reserves-and-playgrounds/citizens-park). The checker reads the public page a few times a day.
- Weather data by [Open-Meteo.com](https://open-meteo.com/).

Bookings can change and matches can run late, so the signs at the park always win.
