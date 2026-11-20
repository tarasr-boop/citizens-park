"""Fetch a web page, with a few patient retries. Standard library only."""

from __future__ import annotations

import gzip
import time
import urllib.error
import urllib.request
import zlib


class FetchError(Exception):
    """The page could not be fetched."""


def _decode(body: bytes, content_type: str) -> str:
    charset = "utf-8"
    for part in content_type.split(";"):
        part = part.strip()
        if part.lower().startswith("charset="):
            charset = part.split("=", 1)[1].strip("\"' ") or "utf-8"
    try:
        return body.decode(charset, errors="replace")
    except LookupError:
        return body.decode("utf-8", errors="replace")


def get(url: str, user_agent: str, timeout: float = 25, tries: int = 3, pause: float = 4, accept: str = "*/*") -> str:
    """Return the text at ``url``. Raises :class:`FetchError` with a short reason."""
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": user_agent,
            "Accept": accept,
            "Accept-Encoding": "gzip",
            "Accept-Language": "en-AU,en;q=0.8",
        },
    )
    reason = "unknown problem"
    for attempt in range(1, tries + 1):
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                body = response.read()
                encoding = (response.headers.get("Content-Encoding") or "").lower()
                if encoding == "gzip":
                    body = gzip.decompress(body)
                elif encoding == "deflate":
                    body = zlib.decompress(body)
                return _decode(body, response.headers.get("Content-Type") or "")
        except urllib.error.HTTPError as error:
            reason = f"the server answered {error.code}"
            if error.code in (400, 401, 403, 404, 410):
                break  # asking again will not help
        except urllib.error.URLError as error:
            reason = f"could not connect ({error.reason})"
        except (TimeoutError, OSError, EOFError, zlib.error) as error:
            reason = f"{type(error).__name__}: {error}" if str(error) else type(error).__name__
        if attempt < tries:
            time.sleep(pause * attempt)
    raise FetchError(reason)
