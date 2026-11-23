"""Pictures for the Telegram bot's alerts: the page's answer and timeline.

The alert is easier to take in at a glance with the page's timeline than in
words alone. So after the page is built, each alert in ``telegram.json`` gets
a picture of the top of the page as it looks at the moment the alert is
written for: the answer ("Booked until 5 PM") and the day's timeline with the
rain by the hour. An alert sent the evening before shows the whole of the
next day.

The pictures are drawn by the page's own script and style (``page.js`` with
``card=`` in the address, see "A picture of the day" there), in a browser
without a window. GitHub's runners come with Google Chrome. The words are
set in a font that comes with this code (``card-font.woff2``, see
``card-font-licence.txt``), so a picture looks the same on any computer.

The pictures go next to the page in ``alerts/``, each named after its own
contents, and each alert in ``telegram.json`` names its picture as
``"image"``. The bot sends the picture with the words as its caption.

None of this is needed for the alert to go out. Without a browser, or if
anything goes wrong, no alert gets a picture, and the bot sends the words
alone, as it did before.
"""

from __future__ import annotations

import base64
import fcntl
import hashlib
import json
import os
import select
import shutil
import subprocess
import tempfile
import time
from collections.abc import Mapping
from datetime import date, datetime
from pathlib import Path

from . import bot
from .site import WEB

# The folder next to the page that holds the pictures.
FOLDER = "alerts"
# The width of the picture in the page's own units (CSS pixels): about as wide
# as a phone, so the page's layout for phones is the one photographed. Each of
# those units is drawn as SCALE pixels, so the words stay sharp.
WIDTH = 420
SCALE = 2
# Room around the cards, in the same units.
MARGIN = 14
# Long enough for any card. Only the part with the cards is kept.
TALL = 1600
# The page's colours for a dark screen, as in the screenshots it was asked to look like.
SCHEME = "dark"
# Where to look for the browser. CHROME, if set, names it.
BROWSERS = ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome")
# Seconds the browser may take to answer one request, and all the pictures together.
STEP_SECONDS = 20
ALL_SECONDS = 120


class PictureError(Exception):
    """The pictures could not be drawn. The message says why, in a few words."""


def find_browser(environ: Mapping[str, str]) -> str | None:
    """The browser to draw with, or None if this computer has none."""
    search = environ.get("PATH", os.defpath)
    named = (environ.get("CHROME") or "").strip()
    if named:
        return shutil.which(named, path=search) or (named if os.path.isfile(named) and os.access(named, os.X_OK) else None)
    for name in BROWSERS:
        found = shutil.which(name, path=search)
        if found:
            return found
    return None


def card_page(data: dict) -> str:
    """The page the pictures are taken of: the page's own style and script, the page's data, and the font."""
    # The picture must not talk to anything: no backend, so nothing is counted.
    data = {**data, "backend": None}
    template = (WEB / "card.html").read_text(encoding="utf-8")
    values = {
        "css": (WEB / "page.css").read_text(encoding="utf-8"),
        "font": base64.b64encode((WEB / "card-font.woff2").read_bytes()).decode("ascii"),
        "margin": str(MARGIN),
        # No "<" may appear inside the data block, or words from outside could end it early.
        "data": json.dumps(data, ensure_ascii=False, separators=(",", ":")).replace("<", "\\u003c"),
        "js": (WEB / "page.js").read_text(encoding="utf-8"),
    }
    out = template
    for name, value in values.items():
        out = out.replace("{{" + name + "}}", value)
    return out


def moment(entry: dict, generated: datetime) -> str:
    """The address for one alert's picture: ``?now=2026-11-22T16:00&card=2026-11-22``.

    ``now`` is the moment the alert's words are written for (see
    ``bot.written_at``), and ``card`` the day the alert is about.
    """
    sent_on = date.fromisoformat(entry["date"])
    about = date.fromisoformat(entry["about"])
    written = bot.written_at(sent_on, int(entry["hour"]), about != sent_on, generated)
    return f"?now={sent_on.isoformat()}T{written.hour:02d}:{written.minute:02d}&card={about.isoformat()}"


def _above(fd: int) -> int:
    """The same pipe end under a number above 9, so it cannot clash with the 3 and 4 the browser is given."""
    moved = fcntl.fcntl(fd, fcntl.F_DUPFD_CLOEXEC, 10)
    os.close(fd)
    return moved


class Browser:
    """Google Chrome without a window, steered through two pipes (its "remote debugging pipe").

    Chrome reads requests from its file number 3 and writes answers to its
    number 4, each a piece of JSON ended by a zero byte.
    """

    def __init__(self, path: str, folder: Path):
        self.path = path
        self.folder = folder
        self.process: subprocess.Popen | None = None
        self.next_id = 0
        self.buffer = b""
        self.waiting: list[dict] = []
        self.session = ""

    def __enter__(self) -> Browser:
        to_chrome, to_us = os.pipe(), os.pipe()
        self.to_read, self.to_write = _above(to_chrome[0]), _above(to_chrome[1])
        self.from_read, self.from_write = _above(to_us[0]), _above(to_us[1])
        given = (self.to_read, self.from_write)

        def hand_over() -> None:  # runs in the browser's process, just before it starts
            os.dup2(given[0], 3)
            os.dup2(given[1], 4)

        command = [
            self.path,
            "--headless",
            "--remote-debugging-pipe",
            f"--user-data-dir={self.folder / 'profile'}",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-gpu",
            "--disable-extensions",
            "--disable-background-networking",
            "--disable-component-update",
            "--disable-sync",
            "--mute-audio",
            "--hide-scrollbars",
            "about:blank",
        ]
        if hasattr(os, "geteuid") and os.geteuid() == 0:
            # Chrome will not start its sandbox for the root user (as in some containers). It only ever opens the card page made here.
            command.insert(1, "--no-sandbox")
        self.log = open(self.folder / "browser.log", "wb")  # noqa: SIM115 - closed in __exit__
        try:
            self.process = subprocess.Popen(
                command, stdin=subprocess.DEVNULL, stdout=self.log, stderr=self.log, close_fds=False, preexec_fn=hand_over
            )
        except OSError as error:
            self.__exit__(None, None, None)
            raise PictureError(f"the browser could not be started ({error.strerror or error})") from None
        finally:
            # Only the browser keeps its ends of the pipes.
            os.close(self.to_read)
            os.close(self.from_write)
        try:
            target = self.ask("Target.createTarget", {"url": "about:blank"})["targetId"]
            self.session = self.ask("Target.attachToTarget", {"targetId": target, "flatten": True})["sessionId"]
            self.ask("Page.enable", session=True)
            self.ask(
                "Emulation.setDeviceMetricsOverride",
                {"width": WIDTH, "height": TALL, "deviceScaleFactor": SCALE, "mobile": False},
                session=True,
            )
            self.ask("Emulation.setEmulatedMedia", {"features": [{"name": "prefers-color-scheme", "value": SCHEME}]}, session=True)
        except BaseException:
            self.__exit__(None, None, None)
            raise
        return self

    def __exit__(self, *_exc) -> None:
        if self.process and self.process.poll() is None:
            try:
                self.ask("Browser.close", timeout=3)
            except PictureError:
                pass
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)
        for fd in (self.to_write, self.from_read):
            try:
                os.close(fd)
            except OSError:
                pass
        self.log.close()

    def _said(self) -> str:
        """The browser's last words in its log, for an error message."""
        try:
            lines = (self.folder / "browser.log").read_text(encoding="utf-8", errors="replace").strip().splitlines()
        except OSError:
            return ""
        return f" (the browser said: {lines[-1][:200]})" if lines else ""

    def _receive(self, deadline: float) -> dict:
        """The next message from the browser."""
        while b"\0" not in self.buffer:
            left = deadline - time.monotonic()
            if left <= 0:
                raise PictureError(f"the browser did not answer in time{self._said()}")
            ready, _, _ = select.select([self.from_read], [], [], left)
            if not ready:
                continue
            chunk = os.read(self.from_read, 1 << 20)
            if not chunk:
                raise PictureError(f"the browser stopped{self._said()}")
            self.buffer += chunk
        message, self.buffer = self.buffer.split(b"\0", 1)
        try:
            return json.loads(message)
        except ValueError:
            raise PictureError("the browser's answer could not be read") from None

    def ask(self, method: str, params: dict | None = None, session: bool = False, timeout: float = STEP_SECONDS) -> dict:
        """Send one request and return its answer."""
        self.next_id += 1
        request = {"id": self.next_id, "method": method, "params": params or {}}
        if session:
            request["sessionId"] = self.session
        data = json.dumps(request).encode("utf-8") + b"\0"
        try:
            while data:
                data = data[os.write(self.to_write, data) :]
        except OSError as error:
            raise PictureError(f"the browser could not be reached ({error.strerror}){self._said()}") from None
        deadline = time.monotonic() + timeout
        while True:
            message = self._receive(deadline)
            if message.get("id") == self.next_id:
                if "error" in message:
                    raise PictureError(f"the browser could not do {method}: {str(message['error'].get('message', ''))[:100]}")
                return message.get("result") or {}
            if "method" in message:
                self.waiting.append(message)

    def _loaded(self, deadline: float) -> None:
        """Wait until the page that is opening has loaded."""
        while True:
            for index, message in enumerate(self.waiting):
                if message.get("method") == "Page.loadEventFired" and message.get("sessionId") == self.session:
                    del self.waiting[: index + 1]
                    return
            self.waiting.clear()
            message = self._receive(deadline)
            if "method" in message:
                self.waiting.append(message)

    def shoot(self, address: str) -> bytes:
        """Open the card page at ``address`` and return a PNG of the cards, or b"" if it drew nothing."""
        self.waiting.clear()
        self.ask("Page.navigate", {"url": address}, session=True)
        self._loaded(time.monotonic() + STEP_SECONDS)
        # Once the font is ready: how much the page drew, and how tall it is.
        found = self.ask(
            "Runtime.evaluate",
            {
                "expression": (
                    "document.fonts.ready.then(() => [document.getElementById('app').children.length,"
                    " Math.ceil(document.querySelector('main').getBoundingClientRect().height)])"
                ),
                "awaitPromise": True,
                "returnByValue": True,
            },
            session=True,
        )
        drawn, height = (found.get("result") or {}).get("value") or (0, 0)
        if not drawn or not height:
            return b""
        shot = self.ask(
            "Page.captureScreenshot",
            {"format": "png", "clip": {"x": 0, "y": 0, "width": WIDTH, "height": min(height, TALL), "scale": 1}, "captureBeyondViewport": True},
            session=True,
        )
        return base64.b64decode(shot["data"])


def add(site_dir: str | Path, environ: Mapping[str, str] = os.environ) -> str:
    """Draw a picture for each alert in the built page's ``telegram.json``, and name it there.

    Returns what was done, in a few words. Raises PictureError if the pictures
    could not be drawn; ``telegram.json`` is then left as it was, without any.
    """
    site = Path(site_dir)
    alerts = json.loads((site / bot.FILE).read_text(encoding="utf-8"))
    data = json.loads((site / "data.json").read_text(encoding="utf-8"))
    entries = alerts.get("alerts") or []
    folder = site / FOLDER
    # Pictures from an earlier build in the same folder are no longer true.
    if folder.is_dir():
        for old in folder.glob("*.png"):
            old.unlink()
    if not entries:
        return "no alerts to draw"
    path = find_browser(environ)
    if not path:
        return "none drawn, there is no browser on this computer (the bot sends the words alone)"

    generated = datetime.fromisoformat(alerts["generated"])
    addresses = [moment(entry, generated) for entry in entries]
    started = time.monotonic()
    pictures: dict[str, bytes] = {}
    with tempfile.TemporaryDirectory(prefix="parkbot-pictures-") as scratch:
        work = Path(scratch)
        page = work / "card.html"
        page.write_text(card_page(data), encoding="utf-8")
        with Browser(path, work) as browser:
            for address in dict.fromkeys(addresses):
                if time.monotonic() - started > ALL_SECONDS:
                    raise PictureError(f"drawing took longer than {ALL_SECONDS} seconds")
                pictures[address] = browser.shoot(page.as_uri() + address)

    folder.mkdir(exist_ok=True)
    names: dict[bytes, str] = {}
    for entry, address in zip(entries, addresses):
        png = pictures.get(address)
        if not png:
            continue
        if png not in names:
            names[png] = f"{hashlib.sha256(png).hexdigest()[:16]}.png"
            (folder / names[png]).write_bytes(png)
        entry["image"] = f"{FOLDER}/{names[png]}"
    (site / bot.FILE).write_text(json.dumps(alerts, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    pictured = sum(1 for entry in entries if entry.get("image"))
    return f"{len(names)} drawn for {pictured} of {len(entries)} alerts"
