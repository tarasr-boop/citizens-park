"""The tests for the Citizens Park alerts.

Nothing a test does may reach the outside: not GitHub, not Telegram, and not
the page of the run that started the tests. Most tests hand the program a
made-up world, but a few run the real command, and that one takes its orders
from the environment. So before any test is loaded, all that would make the
program believe it is the scheduled job, or let it act as one, is taken out of
the environment of the tests and of the programs they start.

Without this, on GitHub the report of a test that runs on sample data landed
on the run's own page, where it read like a real check that had failed
("Council page: not checked", 22 Nov 2026). And with a token within reach, the
same test would have gone to GitHub and closed the watchdog's open issues.
"""

import os


def forget_the_job(environ) -> None:
    """Take out of ``environ`` what GitHub sets for a job, and the tokens a workflow hands to one."""
    for name in [name for name in environ if name.startswith(("GITHUB_", "GH_")) or name == "TELEGRAM_BOT_TOKEN"]:
        del environ[name]


forget_the_job(os.environ)
