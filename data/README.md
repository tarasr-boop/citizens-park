# What the daily job remembers

The **Daily check** job writes the files in this folder and saves them after each run. There is normally no reason to edit them by hand.

| File | What it holds |
| --- | --- |
| `council.json` | The booked times read from the council's page. They are kept so that a day still has an answer when the page cannot be read, and so that the usual weekly pattern can be learned. |
| `state.json` | The day of the last post, and how many times in a row each source has failed. Also the addresses of the weather service's servers and the day each one last answered, so that another server can be asked when the usual one does not answer. |
| `forecast.json` | The last rain forecast that loaded. It stands in for up to 12 hours when the weather service does not answer. |

The files appear after the first run. If one is deleted, the next run makes it again. Deleting `state.json` on a day when the post has already gone out makes the job post a second time.
