"""Render the README logo from the app's own C mark (frontend/public/C.png) plus the "lip" wordmark.

The source has a black background, so each pixel's brightness becomes its opacity and the original
colours are kept. Two colourways:
  docs/logo-dark.png   white ring, for dark backgrounds
  docs/logo-light.png  near-black ring, for light backgrounds (the grey crescent is kept)

The result is cropped tight and given equal margins, so it sits centred wherever it is placed.

Run: python scripts/make_logo.py
"""
import os
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
SOURCE = os.path.join(ROOT, "frontend", "public", "C.png")
OUT = os.path.join(ROOT, "docs")
FONT = "C:/Windows/Fonts/segoeuib.ttf"   # bold humanist sans; the app's wordmark is a bold sans too

MARK_HEIGHT = 360        # rendered height of the C mark (source is 192px; upscaled smoothly)
WORD_HEIGHT_RATIO = 0.50 # "lip" ascender height relative to the mark height (≈ three quarters of the C)
GAP_RATIO = 0.16         # space between mark and wordmark, relative to the mark height
MARGIN = 24              # equal padding around the final logo


def mark_with_alpha(ink_for_ring):
    """Turn the black-background C into an RGBA mark. Brightness becomes alpha; grey tones are kept."""
    src = Image.open(SOURCE).convert("RGB")
    src = src.resize((MARK_HEIGHT, MARK_HEIGHT), Image.LANCZOS)
    out = Image.new("RGBA", src.size, (0, 0, 0, 0))
    px, dst = src.load(), out.load()
    for y in range(src.height):
        for x in range(src.width):
            r, g, b = px[x, y]
            alpha = max(r, g, b)
            if alpha == 0:
                continue
            # near-white ring pixels take the requested ink colour; greys (the crescent) stay grey
            if min(r, g, b) > 200:
                color = ink_for_ring
            else:
                color = (r, g, b)
            dst[x, y] = (*color, alpha)
    return out


def compose(variant):
    ring_ink = (255, 255, 255) if variant == "dark" else (17, 17, 17)
    word_ink = ring_ink
    mark = mark_with_alpha(ring_ink)

    font_size = int(MARK_HEIGHT * WORD_HEIGHT_RATIO / 0.72)   # Segoe 'l' ascender is roughly 0.72em
    font = ImageFont.truetype(FONT, font_size)

    probe = ImageDraw.Draw(Image.new("RGBA", (10, 10)))
    bbox = probe.textbbox((0, 0), "lip", font=font)
    text_w, text_h = bbox[2] - bbox[0], bbox[3] - bbox[1]
    word = Image.new("RGBA", (text_w + 4, text_h + 4), (0, 0, 0, 0))
    ImageDraw.Draw(word).text((2 - bbox[0], 2 - bbox[1]), "lip", font=font, fill=word_ink)

    gap = int(MARK_HEIGHT * GAP_RATIO)
    canvas_w = mark.width + gap + word.width
    canvas_h = max(mark.height, word.height)
    canvas = Image.new("RGBA", (canvas_w, canvas_h), (0, 0, 0, 0))
    canvas.alpha_composite(mark, (0, (canvas_h - mark.height) // 2))
    canvas.alpha_composite(word, (mark.width + gap, (canvas_h - word.height) // 2))

    # tight crop to the drawn pixels, then equal margins on every side
    tight = canvas.crop(canvas.getbbox())
    final = Image.new("RGBA", (tight.width + 2 * MARGIN, tight.height + 2 * MARGIN), (0, 0, 0, 0))
    final.alpha_composite(tight, (MARGIN, MARGIN))
    path = os.path.join(OUT, f"logo-{variant}.png")
    final.save(path, optimize=True)
    return path, final.size


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    for v in ("dark", "light"):
        print(compose(v))
