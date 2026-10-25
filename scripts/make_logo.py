"""Build Clip's logo as vector SVG.

Mark     : drawn from exact circles and arcs. The geometry was measured off frontend/public/icon-512.png (the highest
           resolution copy of the real C); every edge fits its circle to within 0.3px at 512px:
             O   outer circle                      c=(255.65, 255.6)  r=159.6
             D4  left inner circle                 c=(202.9,  255.6)  r=106.8   tangent to O at the left
             D5  right inner circle (mirror of D4) c=(308.4,  255.6)  r=106.8
             slot, a horizontal cut from the right edge, 55.8 tall, centred on the circles
           white shape = O minus D4 minus the slot;  crescent = D4 minus D5.
           The crescent is white at 30% opacity in the artwork: #4d4d4d on black, #b8b8b8 on white.
Wordmark : "lip" in Inter Bold, converted to outlines, set with the app header's proportions
           (C 35px, text 44px, tracking -0.03em), with the gap tightened a little.

Writes
  docs/logo-dark.svg, docs/logo-light.svg     full logo for dark / light backgrounds
  docs/mark-dark.svg, docs/mark-light.svg     the C alone
  docs/logo-preview.html                      a page to review all of them
  frontend/public/logo.svg                    the dark logo, used by the app header
  frontend/public/favicon.svg                 the mark on a black rounded square

Needs: pip install fonttools brotli
Font : Inter's variable font file (the one the app loads from Google Fonts). Set INTER_FONT to a .woff2/.ttf, or let it
       find the copy HyperFrames caches in ~/.cache/hyperframes/fonts/inter.

Run: python scripts/make_logo.py
"""
import math
import os
import sys

from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.boundsPen import BoundsPen

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, ".."))
DOCS = os.path.join(REPO, "docs")
PUBLIC = os.path.join(REPO, "frontend", "public")

# ── 1. the mark, from exact geometry (units are the 512px icon's pixels) ──────────
CX, CY, R = 255.65, 255.6, 159.6             # outer circle
R_IN = 106.8                                  # both inner circles
D4X = CX - R + R_IN                           # left inner circle: tangent to the outer circle at the left
D5X = 2 * CX - D4X                            # right inner circle: its mirror
SLOT = 27.9                                   # half the slot's height
X0, Y0 = CX - R, CY - R                       # top-left of the mark
MW = MH = 2 * R                               # the mark is a square 319.2 wide


def build(k=1.0, dx=0.0, dy=0.0):
    """Return (white_path, crescent_path), scaled by k and moved so the mark's top-left is at (dx, dy)."""
    tx = lambda x: (x - X0) * k + dx
    ty = lambda y: (y - Y0) * k + dy
    pt = lambda x, y: f"{tx(x):.2f} {ty(y):.2f}"

    def arc(cx, cy, r, p0, p1, cw):
        """SVG arc along circle (cx, cy, r) from p0 to p1, clockwise on screen if cw."""
        a0 = math.atan2(p0[1] - cy, p0[0] - cx)
        a1 = math.atan2(p1[1] - cy, p1[0] - cx)
        if cw:
            while a1 < a0:
                a1 += 2 * math.pi
            span = a1 - a0
        else:
            while a1 > a0:
                a1 -= 2 * math.pi
            span = a0 - a1
        return f"A{r * k:.2f} {r * k:.2f} 0 {1 if span > math.pi else 0} {1 if cw else 0} {pt(*p1)}"

    t = (CX - R, CY)                                              # where the three circles touch, on the left
    ya = CY - SLOT
    a = (CX + math.sqrt(R * R - SLOT * SLOT), ya)                 # outer circle meets the slot's top edge
    b = (D4X + math.sqrt(R_IN * R_IN - SLOT * SLOT), ya)          # left inner circle meets the slot's top edge
    flip = lambda p: (p[0], 2 * CY - p[1])

    top = f"M{pt(*t)} {arc(CX, CY, R, t, a, True)} L{pt(*b)} {arc(D4X, CY, R_IN, b, t, False)} Z"
    a2, b2 = flip(a), flip(b)
    bottom = f"M{pt(*t)} {arc(CX, CY, R, t, a2, False)} L{pt(*b2)} {arc(D4X, CY, R_IN, b2, t, True)} Z"

    hx = (D4X + D5X) / 2                                          # where the two inner circles cross
    hy = math.sqrt(R_IN * R_IN - (hx - D4X) ** 2)
    p1, p2 = (hx, CY - hy), (hx, CY + hy)
    crescent = f"M{pt(*p1)} {arc(D4X, CY, R_IN, p1, p2, False)} {arc(D5X, CY, R_IN, p2, p1, True)} Z"
    return f"{top} {bottom}", crescent


# ── 2. wordmark outlines (Inter Bold) ─────────────────────────────────────────────
def find_font():
    env = os.environ.get("INTER_FONT")
    if env:
        return TTFont(env)
    d = os.path.expanduser("~/.cache/hyperframes/fonts/inter")
    for fn in sorted(os.listdir(d)) if os.path.isdir(d) else []:
        if fn.startswith("700-normal"):
            f = TTFont(os.path.join(d, fn))
            if all(ord(c) in f.getBestCmap() for c in "lip"):
                return f
    sys.exit("Inter not found: set INTER_FONT to Inter's variable font (.woff2 or .ttf)")


font = find_font()
if "fvar" in font:  # pin the variable font to Bold (700), which is what the app header renders
    from fontTools.varLib import instancer

    font = instancer.instantiateVariableFont(font, {"wght": 700})
gs = font.getGlyphSet()
cmap = font.getBestCmap()
upm = font["head"].unitsPerEm
asc = font["hhea"].ascent / upm
desc = -font["hhea"].descent / upm

K = MH / 35.0                    # header px -> logo units (the C is the unit)
FS = 44 * K
GAP = 3.1 * K                    # a little tighter than the header's 5.1px (1.6px gap + 3.5px of box padding)
TRACK = -0.03 * FS
baseline = MH / 2 + FS * (asc - desc) / 2


def word(start_x):
    d, x = [], start_x
    right, top, bottom = -1e9, 1e9, -1e9
    for ch in "lip":
        gl = gs[cmap[ord(ch)]]
        pen = SVGPathPen(gs)
        gl.draw(TransformPen(pen, (FS / upm, 0, 0, -FS / upm, x, baseline)))
        d.append(pen.getCommands())
        bp = BoundsPen(gs)
        gl.draw(bp)
        if bp.bounds:
            a, b, c, e = bp.bounds
            right = max(right, x + c * FS / upm)
            top = min(top, baseline - e * FS / upm)
            bottom = max(bottom, baseline - b * FS / upm)
        x += gl.width * FS / upm + TRACK
    return " ".join(d), right, top, bottom


wd, wright, wtop, wbottom = word(MW + GAP)
vtop, vbottom = min(0, wtop), max(MH, wbottom)
PAD = 0.1 * MH
VB = (-PAD, vtop - PAD, wright + 2 * PAD, (vbottom - vtop) + 2 * PAD)

PAL = {
    "dark": {"ink": "#ffffff", "crescent": "#4d4d4d"},
    "light": {"ink": "#111111", "crescent": "#b8b8b8"},
}
mark_w, mark_g = build()


def svg(variant, with_word=True):
    p = PAL[variant]
    box = VB if with_word else (0, 0, MW, MH)
    word_el = f'\n  <path fill="{p["ink"]}" d="{wd}"/>' if with_word else ""
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{box[0]:.2f} {box[1]:.2f} {box[2]:.2f} {box[3]:.2f}" role="img" aria-label="Clip">\n'
        f"  <title>Clip</title>\n"
        f'  <path fill="{p["ink"]}" d="{mark_w}"/>\n'
        f'  <path fill="{p["crescent"]}" d="{mark_g}"/>{word_el}\n</svg>\n'
    )


def favicon():
    size = 48
    k = (size * 0.625) / MW                   # the icon PNGs fill 62.5% of the square
    off = (size - MW * k) / 2
    w, c = build(k, off, off)
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size} {size}" width="{size}" height="{size}">\n'
        f'  <rect width="{size}" height="{size}" rx="10" fill="#000000"/>\n'
        f'  <path fill="#ffffff" d="{w}"/>\n'
        f'  <path fill="{PAL["dark"]["crescent"]}" d="{c}"/>\n</svg>\n'
    )


def write(p, s):
    with open(p, "w", encoding="utf-8", newline="\n") as f:
        f.write(s)
    print("wrote", os.path.relpath(p, REPO))


def preview():
    img = lambda f, h: f'<img src="{f}" height="{h}" alt="Clip">'
    return f'''<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Clip logo</title>
<style>
  body {{ margin: 0; font-family: system-ui, sans-serif; }}
  .p {{ padding: 40px; display: flex; flex-wrap: wrap; gap: 36px; align-items: center; }}
  .dark {{ background: #08080a; }} .light {{ background: #ffffff; }}
</style></head><body>
<div class="p dark">{img("logo-dark.svg", 150)}{img("logo-dark.svg", 50)}{img("logo-dark.svg", 26)}{img("mark-dark.svg", 110)}{img("mark-dark.svg", 36)}{img("mark-dark.svg", 20)}</div>
<div class="p light">{img("logo-light.svg", 150)}{img("logo-light.svg", 50)}{img("logo-light.svg", 26)}{img("mark-light.svg", 110)}{img("mark-light.svg", 36)}{img("mark-light.svg", 20)}</div>
</body></html>
'''


if __name__ == "__main__":
    for v in ("dark", "light"):
        write(os.path.join(DOCS, f"logo-{v}.svg"), svg(v))
        write(os.path.join(DOCS, f"mark-{v}.svg"), svg(v, with_word=False))
    write(os.path.join(DOCS, "logo-preview.html"), preview())
    write(os.path.join(PUBLIC, "logo.svg"), svg("dark"))
    write(os.path.join(PUBLIC, "favicon.svg"), favicon())
