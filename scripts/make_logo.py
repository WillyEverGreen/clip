"""Render the README logo: the Clip "C" mark with the "lip" wordmark, transparent background.

Two colourways so it reads on GitHub's light and dark themes:
  docs/logo-light.png  dark ink, for light backgrounds
  docs/logo-dark.png   white ink, for dark backgrounds

Run: python scripts/make_logo.py
"""
import math
import os
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
OUT = os.path.join(ROOT, "docs")
FONT = "C:/Windows/Fonts/segoeuib.ttf"   # bold humanist sans, present on Windows
SCALE = 3                                 # draw large, downsample for smooth edges
W, H = 760, 260                           # final size is W x H (~2x for retina)

INK = {"light": (17, 17, 17, 255), "dark": (255, 255, 255, 255)}
ACCENT = {"light": (113, 113, 122, 255), "dark": (113, 113, 122, 255)}


def disc(mask, cx, cy, r, value):
    mask_draw = ImageDraw.Draw(mask)
    mask_draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=value)


def c_mark(img, cx, cy, r, thick, ink, accent):
    """The Clip 'C': a ring with an opening on the right, and a crescent inside it.

    Built from masks so the shapes cut cleanly instead of painting over each other.
    """
    size = img.size
    gap = math.radians(40)                    # half-angle of the opening

    # ring = outer disc minus inner disc minus the opening wedge
    ring = Image.new("L", size, 0)
    disc(ring, cx, cy, r, 255)
    disc(ring, cx, cy, r - thick, 0)
    wedge = ImageDraw.Draw(ring)
    far = r * 2
    wedge.polygon([
        (cx, cy),
        (cx + far * math.cos(-gap), cy + far * math.sin(-gap)),
        (cx + far * math.cos(gap), cy + far * math.sin(gap)),
    ], fill=0)
    img.paste(ink, (0, 0), ring)

    # crescent = inner disc minus a copy shifted right, sitting on the left inside the ring
    inner = r - thick * 1.25
    crescent = Image.new("L", size, 0)
    disc(crescent, cx, cy, inner, 255)
    disc(crescent, cx + thick * 0.85, cy, inner * 0.98, 0)
    img.paste(accent, (0, 0), crescent)


def render(variant):
    ink = INK[variant]
    accent = ACCENT[variant]
    img = Image.new("RGBA", (W * SCALE, H * SCALE), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    s = SCALE
    cx, cy, r = 130 * s, 130 * s, 100 * s
    c_mark(img, cx, cy, r, int(44 * s), ink, accent)
    d = ImageDraw.Draw(img)

    font = ImageFont.truetype(FONT, int(170 * s))
    # wordmark: "lip" in the ink colour, positioned to the right of the mark
    text = "lip"
    bbox = d.textbbox((0, 0), text, font=font)
    text_h = bbox[3] - bbox[1]
    x = 262 * s
    y = cy - text_h / 2 - bbox[1]
    d.text((x, y), text, font=font, fill=ink)

    out = img.resize((W, H), Image.LANCZOS)
    path = os.path.join(OUT, f"logo-{variant}.png")
    out.save(path, optimize=True)
    return path


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    for v in ("light", "dark"):
        print(render(v))
