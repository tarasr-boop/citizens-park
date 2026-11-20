"""Draw the page's icons: a white paw print on park green.

Run this only if you want to change the icon:

    pip install pillow
    python3 tools/make_icons.py

It writes the icon files into assets/. The daily job only copies them.
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
GREEN = (23, 105, 58, 255)
CREAM = (255, 253, 248, 255)
WHITE = (255, 255, 255, 255)

# The paw on a 512 by 512 canvas: (centre x, centre y, radius x, radius y, tilt in degrees).
PAD = (256, 322, 96, 78, 0)
TOES = [(146, 236, 38, 50, -24), (214, 158, 40, 54, -8), (298, 158, 40, 54, 8), (366, 236, 38, 50, 24)]


def _ellipse(canvas: Image.Image, shape: tuple[int, int, int, int, int], scale: float, shift: float, fill=CREAM) -> None:
    cx, cy, rx, ry, tilt = shape
    size = int(max(rx, ry) * 2 * scale) + 8
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    half = size / 2
    draw.ellipse((half - rx * scale, half - ry * scale, half + rx * scale, half + ry * scale), fill=fill)
    layer = layer.rotate(-tilt, resample=Image.BICUBIC)
    x = int(shift + cx * scale - half)
    y = int(shift + cy * scale - half)
    canvas.alpha_composite(layer, (x, y))


def icon(size: int, rounded: bool, paw: float) -> Image.Image:
    """One icon. ``paw`` is the paw's size as a share of the canvas (1.0 fills it)."""
    big = size * 4  # draw large, then shrink for smooth edges
    canvas = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    draw = ImageDraw.Draw(canvas)
    if rounded:
        draw.rounded_rectangle((0, 0, big - 1, big - 1), radius=int(big * 0.22), fill=GREEN)
    else:
        draw.rectangle((0, 0, big, big), fill=GREEN)
    scale = big / 512 * paw
    shift = big * (1 - paw) / 2
    for shape in [PAD, *TOES]:
        _ellipse(canvas, shape, scale, shift)
    return canvas.resize((size, size), Image.LANCZOS)


def badge(size: int, paw: float = 1.45) -> Image.Image:
    """The small mark an Android phone puts in its status bar for a notification.

    The phone uses only the shape, so this is the paw alone, in white on nothing.
    """
    big = size * 4
    canvas = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    scale = big / 512 * paw
    shift = big * (1 - paw) / 2
    for shape in [PAD, *TOES]:
        _ellipse(canvas, shape, scale, shift, fill=WHITE)
    return canvas.resize((size, size), Image.LANCZOS)


def blank(size: int) -> Image.Image:
    """A picture with nothing on it. A notification names it on Android phones, which would otherwise draw a picture of their own."""
    return Image.new("RGBA", (size, size), (0, 0, 0, 0))


def favicon_svg() -> str:
    shapes = "".join(
        f'<ellipse cx="{cx}" cy="{cy}" rx="{rx}" ry="{ry}"' + (f' transform="rotate({tilt} {cx} {cy})"' if tilt else "") + "/>"
        for cx, cy, rx, ry, tilt in [PAD, *TOES]
    )
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">'
        '<rect width="512" height="512" rx="112" fill="#17693a"/>'
        f'<g fill="#fffdf8" transform="translate(256 256) scale(1.12) translate(-256 -256)">{shapes}</g>'
        "</svg>\n"
    )


if __name__ == "__main__":
    assets = ROOT / "assets"
    assets.mkdir(exist_ok=True)
    icon(192, rounded=True, paw=1.12).save(assets / "icon-192.png", optimize=True)
    icon(512, rounded=True, paw=1.12).save(assets / "icon-512.png", optimize=True)
    # A "maskable" icon is cropped to a circle or squircle by the phone, so the paw stays well inside.
    icon(512, rounded=False, paw=0.88).save(assets / "icon-maskable-512.png", optimize=True)
    # iPhones round the corners themselves and do not like transparency.
    icon(180, rounded=False, paw=1.02).convert("RGB").save(assets / "apple-touch-icon.png", optimize=True)
    badge(96).save(assets / "badge.png", optimize=True)
    blank(192).save(assets / "blank.png", optimize=True)
    (assets / "favicon.svg").write_text(favicon_svg(), encoding="utf-8")
    print("Icons written to assets/")
