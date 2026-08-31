#!/usr/bin/env python3
"""Generate the Playgama cover art for Sinkhole.

Three sizes are required by the portal:
    cover-landscape-1920x1080.png
    cover-portrait-1080x1920.png
    cover-square-800x800.png

Everything is drawn from the same palette and the same primitives the game
renders with — a near-black shaft, one warm lamp, cold stone — so the covers
and the first frame of gameplay look like the same object. It is parametric on
purpose: re-run it after any art change rather than hand-editing a PNG, and the
three sizes stay in sync.

Layout adapts per aspect rather than scaling one composition, because a cover
that works at 1920x1080 becomes an unreadable letterbox at 1080x1920.

Usage:  python make_covers.py
"""
import math
import os
import sys

try:
    from PIL import Image, ImageDraw, ImageFilter, ImageFont
except ImportError:
    print("ERROR: Pillow is required.  pip install pillow")
    sys.exit(1)

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(HERE, "store-assets", "playgama-covers")

# Palette lifted directly from style.css so the covers cannot drift from the game.
INK       = (5, 7, 12)
WALL      = (4, 6, 10)
STONE     = (16, 21, 31)
LAMP      = (255, 207, 122)
GOLD      = (255, 208, 94)
GEM       = (111, 216, 232)
TEXT      = (230, 236, 245)
TEXT_DIM  = (139, 151, 171)

FONT_BOLD = r"C:\Windows\Fonts\segoeuib.ttf"   # matches the game's font stack
FONT_REG  = r"C:\Windows\Fonts\segoeui.ttf"


def load_font(path, size):
    try:
        return ImageFont.truetype(path, size)
    except Exception:
        return ImageFont.load_default()


def radial_mask(diameter, falloff=2.2, res=192):
    """A soft circular mask, built small and scaled up (cheap and smooth)."""
    m = Image.new("L", (res, res), 0)
    px = m.load()
    half = res / 2.0
    for y in range(res):
        for x in range(res):
            dx = (x + 0.5 - half) / half
            dy = (y + 0.5 - half) / half
            d = math.hypot(dx, dy)
            v = max(0.0, 1.0 - d)
            px[x, y] = int(255 * (v ** falloff))
    return m.resize((max(1, int(diameter)), max(1, int(diameter))), Image.LANCZOS)


def add_glow(img, cx, cy, radius, color, strength=1.0, falloff=2.2):
    """Composite a soft radial light onto the image."""
    d = int(radius * 2)
    mask = radial_mask(d, falloff)
    if strength != 1.0:
        mask = mask.point(lambda v: int(v * strength))
    layer = Image.new("RGB", (d, d), color)
    img.paste(layer, (int(cx - radius), int(cy - radius)), mask)


def darken_outside(img, cx, cy, radius):
    """The game's darkness pass: everything past the lamp falls away to black."""
    w, h = img.size
    d = int(radius * 2)
    keep = radial_mask(d, falloff=1.5)
    # Full-frame mask that is 0 (transparent) at the lamp and 255 at the edges.
    dark_mask = Image.new("L", (w, h), 255)
    dark_mask.paste(keep.point(lambda v: 255 - v), (int(cx - radius), int(cy - radius)))
    dark_mask = dark_mask.filter(ImageFilter.GaussianBlur(radius * 0.05))
    black = Image.new("RGB", (w, h), (0, 0, 0))
    # 0.78, not 0.92: at full strength the shaft walls disappear completely and
    # the cover becomes a title floating on a black rectangle. The walls are the
    # only thing telling you this is a shaft.
    img.paste(black, (0, 0), dark_mask.point(lambda v: int(v * 0.78)))


def draw_tracked_text(draw, xy, text, font, fill, tracking, anchor_center=True):
    """Letter-spaced text. Returns the total width drawn."""
    widths = [draw.textlength(ch, font=font) for ch in text]
    total = sum(widths) + tracking * (len(text) - 1)
    x, y = xy
    if anchor_center:
        x -= total / 2
    for ch, cw in zip(text, widths):
        draw.text((x, y), ch, font=font, fill=fill)
        x += cw + tracking
    return total


def glow_text(img, xy, text, font, fill, tracking, blur, glow_strength=0.55):
    """Crisp text over a blurred copy of itself — the game's title treatment.

    The glow is built on an L-mode mask rather than an RGB layer so the blurred
    halo is composited as light on top of the shaft instead of as a grey box.
    """
    w, h = img.size
    mask = Image.new("L", (w, h), 0)
    draw_tracked_text(ImageDraw.Draw(mask), xy, text, font, 255, tracking)
    glow = mask.filter(ImageFilter.GaussianBlur(blur))
    glow = glow.point(lambda v: int(v * glow_strength))
    img.paste(Image.new("RGB", (w, h), fill), (0, 0), glow)
    draw_tracked_text(ImageDraw.Draw(img), xy, text, font, fill, tracking)


def make_cover(w, h, path):
    img = Image.new("RGB", (w, h), INK)
    draw = ImageDraw.Draw(img)

    cx = w / 2.0
    # Shaft width: a proportion of the frame, but never so wide on landscape
    # that the walls leave the canvas and the "shaft" reads as open space.
    shaft_w = min(w * 0.52, h * 0.62)

    # --- background: vertical gradient, warmer toward the lamp -------------
    for y in range(h):
        t = y / float(h)
        r = int(INK[0] + (STONE[0] - INK[0]) * (1 - abs(t - 0.5) * 2) * 0.9)
        g = int(INK[1] + (STONE[1] - INK[1]) * (1 - abs(t - 0.5) * 2) * 0.9)
        b = int(INK[2] + (STONE[2] - INK[2]) * (1 - abs(t - 0.5) * 2) * 0.9)
        draw.line([(0, y), (w, y)], fill=(r, g, b))

    # --- shaft walls -------------------------------------------------------
    wall_pts_l, wall_pts_r = [], []
    for y in range(0, h + 8, 4):
        wob = (math.sin(y * 0.0042 + 1.3) * shaft_w * 0.11 +
               math.sin(y * 0.0131 + 0.4) * shaft_w * 0.045)
        lx = cx - shaft_w / 2 + wob
        rx = cx + shaft_w / 2 + wob
        wall_pts_l.append((lx, y))
        wall_pts_r.append((rx, y))
        draw.line([(0, y), (lx, y)], fill=WALL, width=5)
        draw.line([(rx, y), (w, y)], fill=WALL, width=5)

    # Rim light on the wall edges — brighter than in-game because the cover is
    # viewed as a static thumbnail with no motion to imply the shaft.
    rim_w = max(3, w // 640)
    draw.line(wall_pts_l, fill=(74, 86, 108), width=rim_w)
    draw.line(wall_pts_r, fill=(74, 86, 108), width=rim_w)

    # --- the diver, placed low-centre so the title has the upper third -----
    diver_y = h * (0.60 if h >= w else 0.62)
    wob_at = lambda y: (math.sin(y * 0.0042 + 1.3) * shaft_w * 0.11 +
                        math.sin(y * 0.0131 + 0.4) * shaft_w * 0.045)
    diver_x = cx + wob_at(diver_y) * 0.6

    lamp_r = min(w, h) * 0.34
    add_glow(img, diver_x, diver_y, lamp_r * 1.35, (46, 34, 18), 1.0, 2.6)
    darken_outside(img, diver_x, diver_y, lamp_r * 1.9)

    # treasure inside the lit pocket
    scale = min(w, h) / 1080.0
    spec = [(-0.30, -0.20, GOLD, 15), (0.26, -0.30, GEM, 13), (0.34, 0.16, GOLD, 12),
            (-0.22, 0.26, GOLD, 11), (0.06, -0.42, GEM, 10), (-0.40, 0.05, GOLD, 9)]
    for fx, fy, col, rad in spec:
        tx = diver_x + fx * lamp_r * 1.5
        ty = diver_y + fy * lamp_r * 1.5
        rr = rad * scale
        add_glow(img, tx, ty, rr * 5, tuple(int(c * 0.16) for c in col), 1.0, 2.4)
        draw.ellipse([tx - rr, ty - rr, tx + rr, ty + rr], fill=col)
        draw.ellipse([tx - rr * 0.42 - rr * 0.28, ty - rr * 0.45 - rr * 0.28,
                      tx - rr * 0.42 + rr * 0.28, ty - rr * 0.45 + rr * 0.28],
                     fill=(255, 255, 255))

    # --- rope + diver ------------------------------------------------------
    # Order matters: the lamp's own bloom goes down FIRST, then the rope, then
    # the body on top. Painting the bloom last (the obvious order) composites a
    # warm wash straight over the diver and turns the focal point of the whole
    # cover into a dark smudge.
    add_glow(img, diver_x, diver_y, lamp_r * 0.62, (86, 62, 30), 1.0, 2.0)

    rope_w = max(3, int(5 * scale))
    draw.line([(cx + wob_at(0) * 0.6, -10), (diver_x, diver_y - 26 * scale)],
              fill=(129, 117, 98), width=rope_w)

    # Sized for legibility at gallery-thumbnail scale, not for realism — at the
    # in-game 15x34 the diver simply vanishes once the cover is scaled down.
    dw, dh = 38 * scale, 84 * scale
    draw.rounded_rectangle([diver_x - dw / 2, diver_y - dh / 2,
                            diver_x + dw / 2, diver_y + dh / 2],
                           radius=dw / 2, fill=(222, 228, 238))
    draw.rounded_rectangle([diver_x - dw / 2, diver_y - dh / 2,
                            diver_x + dw / 2, diver_y + dh / 2],
                           radius=dw / 2, outline=(120, 128, 142),
                           width=max(1, int(2 * scale)))

    lr = 13 * scale
    ly = diver_y + dh * 0.06
    add_glow(img, diver_x, ly, lr * 7, (120, 88, 42), 1.0, 2.4)
    draw.ellipse([diver_x - lr, ly - lr, diver_x + lr, ly + lr], fill=LAMP)
    draw.ellipse([diver_x - lr * 0.45, ly - lr * 0.45,
                  diver_x + lr * 0.45, ly + lr * 0.45], fill=(255, 246, 224))

    # --- title -------------------------------------------------------------
    # Sized so the tracked word fills a target fraction of the frame width.
    target = w * (0.80 if w >= h else 0.86)
    size = int(min(w, h) * 0.16)
    tracking_ratio = 0.18
    for _ in range(40):
        f = load_font(FONT_BOLD, size)
        wdt = sum(draw.textlength(c, font=f) for c in "SINKHOLE") + \
              size * tracking_ratio * 7
        if wdt > target:
            size = int(size * 0.94)
        else:
            break
    font = load_font(FONT_BOLD, size)
    title_y = h * (0.14 if w >= h else 0.13)
    glow_text(img, (cx, title_y), "SINKHOLE", font, LAMP, size * tracking_ratio,
              blur=size * 0.30)

    # --- tagline -----------------------------------------------------------
    tag_size = max(14, int(size * 0.19))
    tag_font = load_font(FONT_REG, tag_size)
    d = ImageDraw.Draw(img)
    draw_tracked_text(d, (cx, title_y + size * 1.30),
                      "HOLD TO FALL.  LET GO TO CLIMB.", tag_font, TEXT_DIM,
                      tag_size * 0.16)

    img.save(path, "PNG", optimize=True)
    return os.path.getsize(path)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    targets = [
        (1920, 1080, "cover-landscape-1920x1080.png"),
        (1080, 1920, "cover-portrait-1080x1920.png"),
        (800, 800, "cover-square-800x800.png"),
    ]
    for w, h, name in targets:
        p = os.path.join(OUT_DIR, name)
        size = make_cover(w, h, p)
        print("  %-34s %4dx%-4d  %6.1f KB" % (name, w, h, size / 1024))
    print("\nwrote %d covers to %s" % (len(targets), os.path.relpath(OUT_DIR, HERE)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
