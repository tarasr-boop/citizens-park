"""Post a message to the Telegram channel through the Bot API.

The bot token is a password. It is read from the ``TELEGRAM_BOT_TOKEN``
environment variable (a GitHub repository secret) and never written to a
file, a log line or an error message.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request


class TelegramError(Exception):
    """Telegram refused the message, or could not be reached."""


def _explain(description: str) -> str:
    """Turn Telegram's short error into advice for the person running this."""
    lowered = description.lower()
    if "unauthorized" in lowered:
        return f"{description}. The bot token is wrong or was revoked: update the TELEGRAM_BOT_TOKEN secret."
    if "chat not found" in lowered:
        return f"{description}. Check the channel name in config.toml and that the channel is public."
    if "not enough rights" in lowered or "need administrator rights" in lowered or "bot is not a member" in lowered:
        return f"{description}. Add the bot to the channel as an administrator with Post Messages switched on."
    return description


def send(token: str, channel: str, text: str, silent: bool = False, timeout: float = 25, tries: int = 3) -> int:
    """Send ``text`` (Telegram HTML) to ``@channel``. Returns the new message's id."""
    if not token:
        raise TelegramError("no bot token: add the TELEGRAM_BOT_TOKEN secret")
    if not channel:
        raise TelegramError("no channel: set telegram.channel in config.toml")

    payload = json.dumps(
        {
            "chat_id": f"@{channel}",
            "text": text,
            "parse_mode": "HTML",
            "link_preview_options": {"is_disabled": True},
            "disable_notification": silent,
        }
    ).encode("utf-8")
    request = urllib.request.Request(
        f"https://api.telegram.org/bot{token}/sendMessage",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    problem = "unknown problem"
    for attempt in range(1, tries + 1):
        wait = 3.0 * attempt
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                reply = json.loads(response.read().decode("utf-8"))
            if reply.get("ok"):
                return int(reply["result"]["message_id"])
            raise TelegramError(_explain(str(reply.get("description") or "Telegram said no")))
        except urllib.error.HTTPError as error:
            try:
                reply = json.loads(error.read().decode("utf-8"))
            except (ValueError, OSError):
                reply = {}
            description = str(reply.get("description") or f"HTTP {error.code}")
            if error.code == 429:
                retry_after = (reply.get("parameters") or {}).get("retry_after")
                wait = min(float(retry_after), 30.0) if isinstance(retry_after, (int, float)) else wait
                problem = description
            elif error.code >= 500:
                problem = description
            else:
                raise TelegramError(_explain(description)) from None
        except urllib.error.URLError as error:
            # Never include the request address here: it holds the token.
            problem = f"could not reach Telegram ({type(error.reason).__name__})"
        except TimeoutError:
            # The message may or may not have gone out. Do not send it again now,
            # or the channel could get it twice; the next scheduled run decides.
            raise TelegramError("Telegram did not answer in time") from None
        except (ValueError, KeyError, TypeError):
            raise TelegramError("Telegram sent a reply that could not be understood") from None
        if attempt < tries:
            time.sleep(wait)
    raise TelegramError(problem)
