"""Render the README logo as vector SVG: the C mark (drawn from circles) plus the "lip" wordmark.

The wordmark is converted to outline paths, so the SVG does not depend on fonts being installed.
Two colourways:
  docs/logo-dark.svg   white ring, for dark backgrounds
  docs/logo-light.svg  near-black ring, for light backgrounds

The C is drawn in the same proportions as frontend/public/C.png: an outer ring with a mouth on the
right, and a grey crescent on the left inside the hole.

Also writes docs/logo-preview.html, a page that shows both logos on both backgrounds for review.

Run: python scripts/make_logo.py
"""
import os
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.boundsPen import BoundsPen

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
OUT = os.path.join(ROOT, "docs")
FONT = "C:/Windows/Fonts/segoeuib.ttf"   # bold humanist sans; the app's wordmark is a bold sans too

# C mark geometry, in the 192-unit space of frontend/public/C.png
CX, CY = 96, 96          # centre
R_OUTER = 60             # outer radius (diameter 120)
R_HOLE = 38              # inner hole radius, sets the ring thickness
MOUTH_Y0, MOUTH_Y1 = 84, 108   # opening on the right
LENS_CX, LENS_R = 84, 40       # grey crescent: a disc on the left...
SHADOW_CX, SHADOW_R = 104, 38  # ...cut by this disc, which leaves the crescent

WORD_HEIGHT = 0.80 * 2 * R_OUTER   # height of the "l" ascender, relative to the mark diameter
GAP = 12                           # space between the mark and the wordmark
PAD = 24                           # equal margin around the whole logo

PALETTES = {
    "dark": {"ring": "#ffffff", "lens": "#3a3d44", "word": "#ffffff"},
    "light": {"ring": "#111111", "lens": "#c9c9c9", "word": "#111111"},
}


def word_paths(text, target_l_height):
    """Return (svg path data for the word, width, top, baseline, bottom), in mark units.

    The word is placed with its 'l' ascender centred on the mark's vertical centre, so the
    whole logo reads as one centred unit.
    """
    font = TTFont(FONT)
    gs = font.getGlyphSet()
    cmap = font.getBestCmap()
    upm = font["head"].unitsPerEm
    # ascender height in font units, from the glyph 'l'
    bp = BoundsPen(gs)
    gs[cmap[ord("l")]].draw(bp)
    l_top_units = bp.bounds[3]
    s = target_l_height / l_top_units           # font units -> mark units

    baseline = CY + target_l_height / 2         # top of 'l' sits at CY - target/2
    x = 0.0
    paths = []
    bottom = baseline
    top = baseline - target_l_height
    for ch in text:
        name = cmap[ord(ch)]
        glyph = gs[name]
        pen = SVGPathPen(gs)
        # flip y (font y goes up, SVG y goes down) and scale; move to the pen position
        tpen = TransformPen(pen, (s, 0, 0, -s, x, baseline))
        glyph.draw(tpen)
        paths.append(pen.getCommands())
        gb = BoundsPen(gs)
        glyph.draw(gb)
        if gb.bounds:
            bottom = max(bottom, baseline - gb.bounds[1] * s)
        x += glyph.width * s
    width = x
    return " ".join(paths), width, top, baseline, bottom


def logo_svg(variant):
    p = PALETTES[variant]
    word, word_w, word_top, _, word_bottom = word_paths("lip", WORD_HEIGHT)

    mark_left = CX - R_OUTER
    mark_right = CX + R_OUTER
    mark_top = CY - R_OUTER
    mark_bottom = CY + R_OUTER

    word_x = mark_right + GAP - 0   # the wordmark's own origin sits GAP to the right of the mark
    content_left = mark_left
    content_right = word_x + word_w
    content_top = min(mark_top, word_top)
    content_bottom = max(mark_bottom, word_bottom)

    vb_x = content_left - PAD
    vb_y = content_top - PAD
    vb_w = (content_right - content_left) + 2 * PAD
    vb_h = (content_bottom - content_top) + 2 * PAD

    # Shift everything so the viewBox starts at 0 for a clean file
    dx = -vb_x
    dy = -vb_y
    mx, my = CX + dx, CY + dy

    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {vb_w:.0f} {vb_h:.0f}" width="{vb_w:.0f}" height="{vb_h:.0f}" role="img" aria-label="Clip">
  <title>Clip</title>
  <defs>
    <mask id="ring-mask">
      <rect width="100%" height="100%" fill="#fff"/>
      <circle cx="{mx}" cy="{my}" r="{R_HOLE}" fill="#000"/>
      <rect x="{mx}" y="{MOUTH_Y0 + dy}" width="{R_OUTER + 10}" height="{MOUTH_Y1 - MOUTH_Y0}" fill="#000"/>
    </mask>
    <mask id="lens-mask">
      <rect width="100%" height="100%" fill="#fff"/>
      <circle cx="{SHADOW_CX + dx}" cy="{CY + dy}" r="{SHADOW_R}" fill="#000"/>
    </mask>
    <clipPath id="outer-clip">
      <circle cx="{mx}" cy="{my}" r="{R_OUTER}"/>
    </clipPath>
  </defs>
  <g fill="{p["ring"]}">
    <circle cx="{mx}" cy="{my}" r="{R_OUTER}" mask="url(#ring-mask)"/>
  </g>
  <g clip-path="url(#outer-clip)" mask="url(#lens-mask)">
    <circle cx="{LENS_CX + dx}" cy="{CY + dy}" r="{LENS_R}" fill="{p["lens"]}"/>
  </g>
  <path fill="{p["word"]}" transform="translate({word_x + dx:.2f} {dy:.2f})" d="{word}"/>
</svg>
'''
    return svg, (vb_w, vb_h)


def preview_html():
    dark = open(os.path.join(OUT, "logo-dark.svg"), encoding="utf-8").read()
    light = open(os.path.join(OUT, "logo-light.svg"), encoding="utf-8").read()
    return f'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Clip logo preview</title>
<style>
  body {{ margin: 0; font-family: system-ui, sans-serif; }}
  .panel {{ display: flex; align-items: center; justify-content: center; min-height: 45vh; padding: 32px; box-sizing: border-box; }}
  .dark {{ background: #0d1117; }}
  .light {{ background: #ffffff; }}
  .panel svg {{ width: min(420px, 80vw); height: auto; }}
  .label {{ position: absolute; left: 12px; bottom: 8px; font: 12px system-ui; opacity: .6; }}
  .dark .label {{ color: #8b949e; }}
  .light .label {{ color: #57606a; }}
  .wrap {{ position: relative; }}
</style>
</head>
<body>
<div class="wrap panel dark">{dark}<span class="label">logo-dark.svg on dark</span></div>
<div class="wrap panel light">{light}<span class="label">logo-light.svg on light</span></div>
</body>
</html>
'''


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    for v in ("dark", "light"):
        svg, size = logo_svg(v)
        path = os.path.join(OUT, f"logo-{v}.svg")
        with open(path, "w", encoding="utf-8") as f:
            f.write(svg)
        print(path, [round(n) for n in size])
    with open(os.path.join(OUT, "logo-preview.html"), "w", encoding="utf-8") as f:
        f.write(preview_html())
    print(os.path.join(OUT, "logo-preview.html"))
