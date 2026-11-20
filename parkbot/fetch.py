"""Fetch a web page, with a few patient retries. Standard library only.

A site can have several servers, and its name leads to one of them. When that
one says nothing, :func:`get` can ask another one directly, by its address.
"""

from __future__ import annotations

import errno
import gzip
import http.client
import ipaddress
import socket
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request
import zlib
from collections.abc import Callable, Sequence

# After a try by the usual route gets no answer, at most this many other addresses
# are asked, and none of them is waited on for longer than this many seconds. A
# server that is well answers in under a second.
_DETOURS = 2
_DETOUR_TIMEOUT = 8


class FetchError(Exception):
    """The page could not be fetched."""


class NoAnswer(FetchError):
    """The server could not be reached, or said nothing in time."""


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


def _text(body: bytes, headers) -> str:
    """The words of a reply: unpacked if the server compressed them, then decoded."""
    encoding = (headers.get("Content-Encoding") or "").lower()
    if encoding == "gzip":
        body = gzip.decompress(body)
    elif encoding == "deflate":
        body = zlib.decompress(body)
    return _decode(body, headers.get("Content-Type") or "")


def _headers(user_agent: str, accept: str) -> dict[str, str]:
    return {
        "User-Agent": user_agent,
        "Accept": accept,
        "Accept-Encoding": "gzip",
        "Accept-Language": "en-AU,en;q=0.8",
    }


def _words(error: BaseException) -> str:
    return f"{type(error).__name__}: {error}" if str(error) else type(error).__name__


def is_public(address: object) -> bool:
    """True for an address on the open internet. False for a private or local one, and for anything else."""
    if not isinstance(address, str) or "%" in address:
        return False
    try:
        ip = ipaddress.ip_address(address)
    except ValueError:
        return False
    if ip.version == 6 and ip.ipv4_mapped is not None:
        return False  # an IPv4 address in IPv6 dress: only its plain form counts
    return ip.is_global and not ip.is_multicast and not ip.is_reserved


def addresses_of(url: str) -> list[str]:
    """The addresses that a site's name leads to right now. Empty if they cannot be found."""
    try:
        parts = urllib.parse.urlsplit(url)
        if not parts.hostname:
            return []
        found = {info[4][0] for info in socket.getaddrinfo(parts.hostname, parts.port or 443, proto=socket.IPPROTO_TCP)}
    except Exception:  # noqa: BLE001 - not knowing is an answer too
        return []
    return sorted(str(address) for address in found)


def _tls() -> ssl.SSLContext:
    """The checks of an ordinary https request: a trusted certificate that names the site."""
    context = ssl.create_default_context()
    context.set_alpn_protocols(["http/1.1"])
    return context


class _ConnectionAt(http.client.HTTPSConnection):
    """An https connection to a site's server at one given address.

    Only the address is ours. The server must still show a certificate for
    the site's name, so a wrong address cannot pass itself off as the site.
    """

    def __init__(self, host: str, port: int | None, address: str, timeout: float, context: ssl.SSLContext):
        super().__init__(host, port, timeout=timeout, context=context)
        self._address = address
        self._tls = context

    def connect(self) -> None:
        sock = socket.create_connection((self._address, self.port), self.timeout)
        try:
            self.sock = self._tls.wrap_socket(sock, server_hostname=self.host)
        except BaseException:
            sock.close()
            raise


def get_at(url: str, user_agent: str, address: str, timeout: float = 25, accept: str = "*/*") -> str:
    """Return the text at ``url``, asking the server at ``address`` instead of the one the site's name leads to.

    One try. Raises :class:`NoAnswer` if the server cannot be reached or says
    nothing in time, and :class:`FetchError` for anything else that goes wrong.
    """
    connection = None
    try:
        parts = urllib.parse.urlsplit(url)
        if parts.scheme != "https" or not parts.hostname:
            raise FetchError("only an https address can be fetched this way")
        context = _tls()
        if not context.check_hostname or context.verify_mode != ssl.CERT_REQUIRED:
            raise FetchError("the server's certificate would not be checked")
        connection = _ConnectionAt(parts.hostname, parts.port, address, timeout, context)
        path = (parts.path or "/") + (f"?{parts.query}" if parts.query else "")
        connection.request("GET", path, headers={**_headers(user_agent, accept), "Connection": "close"})
        reply = connection.getresponse()
        if reply.status != 200:
            raise FetchError(f"the server answered {reply.status}")
        return _text(reply.read(), reply.headers)
    except FetchError:
        raise
    except ssl.SSLCertVerificationError as error:
        raise FetchError(f"the server's certificate was not accepted ({error.verify_message})") from None
    except OSError as error:
        unreached = isinstance(error, (TimeoutError, ConnectionError)) or error.errno in (errno.ENETUNREACH, errno.EHOSTUNREACH)
        raise (NoAnswer if unreached else FetchError)(_words(error)) from None
    except (EOFError, ValueError, zlib.error, http.client.HTTPException) as error:
        raise FetchError(_words(error)) from None
    finally:
        if connection is not None:
            connection.close()


def get(
    url: str,
    user_agent: str,
    timeout: float = 25,
    tries: int = 3,
    pause: float = 4,
    accept: str = "*/*",
    addresses: Sequence[str] = (),
    detour: Callable[[str, str], None] | None = None,
) -> str:
    """Return the text at ``url``. Raises :class:`FetchError` with a short reason.

    ``addresses`` are addresses the site's servers have answered from before.
    Each time the usual route gets no answer, the site's other servers are asked
    directly at those addresses, before the pause and the next try. If one of
    them answers, ``detour`` is called with its address and with what went wrong
    on the usual route.
    """
    request = urllib.request.Request(url, headers=_headers(user_agent, accept))
    reason = "unknown problem"
    others: list[str] = []
    for attempt in range(1, tries + 1):
        others = []
        elsewhere = True  # might another of the site's servers do better?
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return _text(response.read(), response.headers)
        except urllib.error.HTTPError as error:
            reason = f"the server answered {error.code}"
            if error.code in (400, 401, 403, 404, 410):
                break  # asking again will not help
            elsewhere = error.code >= 500
        except urllib.error.URLError as error:
            reason = f"could not connect ({error.reason})"
        except (TimeoutError, OSError, EOFError, zlib.error, http.client.HTTPException) as error:
            reason = _words(error)
        if elsewhere and addresses:
            # The address the site's name leads to is the one that was just tried. If the
            # name leads to several, there is no telling which of them it was, so those
            # stay on the list, behind the addresses the name does not lead to.
            current = addresses_of(url)
            tried = current if len(current) == 1 else []
            others = [address for address in addresses if address not in tried and is_public(address)]
            others = sorted(others, key=lambda address: address in current)[:_DETOURS]
            for address in others:
                try:
                    text = get_at(url, user_agent, address, timeout=min(timeout, _DETOUR_TIMEOUT), accept=accept)
                except FetchError:
                    continue
                if detour:
                    detour(address, reason)
                return text
        if attempt < tries:
            time.sleep(pause * attempt)
    if others:
        reason += f"; the site's other {'server' if len(others) == 1 else 'servers'} did not work either"
    raise FetchError(reason)
