"""Make the QR code that points to the public page.

Run this once, and again whenever ``site.url`` in config.toml changes:

    pip install segno
    python3 tools/make_qr.py

It writes assets/qr.svg (for the page), assets/qr.png (handy
for sharing in a chat) and assets/qr-url.txt (the address the code holds, so
the tests can tell when the code is out of date). The daily job only copies
these files; it never needs segno.
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import segno  # noqa: E402

from parkbot import config as config_module  # noqa: E402


def make(url: str, assets: Path) -> None:
    # Level Q survives a scuffed or rain-spotted print better than the default.
    code = segno.make(url, error="q", micro=False)
    assets.mkdir(parents=True, exist_ok=True)
    code.save(str(assets / "qr.svg"), scale=10, border=4, dark="#000000", light="#ffffff", xmldecl=False, svgclass=None, lineclass=None, omitsize=True, nl=True)
    code.save(str(assets / "qr.png"), scale=20, border=4, dark="#000000", light="#ffffff")
    (assets / "qr-url.txt").write_text(url + "\n", encoding="utf-8")


if __name__ == "__main__":
    address = config_module.load(ROOT / "config.toml").site_url
    make(address, ROOT / "assets")
    print(f"QR code written for {address}")
