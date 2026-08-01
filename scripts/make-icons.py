"""Generates the app icon: assets/screen-buddy.ico plus the tray-icon data URL.

Pure standard library — no Pillow. Shapes are drawn as stroked paths using
distance functions with 4x supersampling for anti-aliasing, then packed into a
PNG-compressed .ico (which Vista and later accept directly).

    python scripts/make-icons.py

Writes assets/screen-buddy.ico and prints the base64 for src/main/tray-icon.js.
"""

import base64
import math
import os
import struct
import zlib

BRASS = (200, 160, 90)
BRASS_LIGHT = (226, 197, 150)
STEAM = (141, 124, 104)

SS = 4  # supersampling factor per axis


# ── geometry helpers, all in 0..1 normalized space ──────────────────────────

def dist_to_segment(px, py, x1, y1, x2, y2):
    dx, dy = x2 - x1, y2 - y1
    if dx == 0 and dy == 0:
        return math.hypot(px - x1, py - y1)
    t = max(0.0, min(1.0, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))


def dist_to_arc(px, py, cx, cy, r, a0, a1):
    """Distance to a circular arc spanning [a0, a1] degrees (0 deg = +x axis)."""
    ang = math.degrees(math.atan2(py - cy, px - cx)) % 360
    lo, hi = a0 % 360, a1 % 360
    inside = (lo <= ang <= hi) if lo <= hi else (ang >= lo or ang <= hi)
    if inside:
        return abs(math.hypot(px - cx, py - cy) - r)
    # Outside the sweep: nearest endpoint.
    return min(
        math.hypot(px - (cx + r * math.cos(math.radians(a))),
                   py - (cy + r * math.sin(math.radians(a))))
        for a in (a0, a1)
    )


# The cup: a tapered body, a handle ring on the right, a saucer, and steam.
CUP_BODY = [
    (0.16, 0.38), (0.60, 0.38),          # rim
    (0.60, 0.58),                         # right wall
    (0.52, 0.70), (0.24, 0.70),           # bottom
    (0.16, 0.58),                         # left wall
    (0.16, 0.38),                         # close
]

SAUCER = (0.09, 0.82, 0.67, 0.82)
HANDLE = (0.655, 0.475, 0.105, -68, 68)
# Steam wisps. Each is an S: a lower half-circle bulging right stacked on an
# upper one bulging left. Angles are screen-space, so +y points down and -90 is
# straight up.
STEAM_ARCS = [
    (0.27, 0.28, 0.048, -90, 90),
    (0.27, 0.184, 0.048, 90, 270),
    (0.46, 0.28, 0.048, -90, 90),
    (0.46, 0.184, 0.048, 90, 270),
]


def coverage(px, py):
    """Returns (r, g, b, alpha 0..1) for a sample point, or None for empty."""
    body = min(
        dist_to_segment(px, py, *CUP_BODY[i], *CUP_BODY[i + 1])
        for i in range(len(CUP_BODY) - 1)
    )
    saucer = dist_to_segment(px, py, *SAUCER)
    handle = dist_to_arc(px, py, *HANDLE)
    steam = min(dist_to_arc(px, py, *a) for a in STEAM_ARCS)

    half = 0.028  # stroke half-width
    if min(body, saucer, handle) <= half:
        # Rim and saucer get the lighter brass so the form reads at 16px.
        light = (py < 0.40) or (py > 0.79)
        return (*(BRASS_LIGHT if light else BRASS), 1.0)
    if steam <= 0.020:
        return (*STEAM, 1.0)
    return None


def render(size):
    """Renders one square RGBA frame at `size` px."""
    px = [[(0, 0, 0, 0)] * size for _ in range(size)]
    inv = 1.0 / (size * SS)
    for y in range(size):
        row = []
        for x in range(size):
            acc_r = acc_g = acc_b = acc_a = 0.0
            for sy in range(SS):
                for sx in range(SS):
                    u = (x * SS + sx + 0.5) * inv
                    v = (y * SS + sy + 0.5) * inv
                    hit = coverage(u, v)
                    if hit:
                        acc_r += hit[0]
                        acc_g += hit[1]
                        acc_b += hit[2]
                        acc_a += hit[3]
            n = SS * SS
            if acc_a > 0:
                row.append((
                    int(round(acc_r / acc_a)),
                    int(round(acc_g / acc_a)),
                    int(round(acc_b / acc_a)),
                    int(round(255 * acc_a / n)),
                ))
            else:
                row.append((0, 0, 0, 0))
        px[y] = row
    return px


def to_png(px):
    size = len(px)
    raw = b"".join(
        b"\x00" + b"".join(struct.pack("BBBB", *px[y][x]) for x in range(size))
        for y in range(size)
    )

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def to_ico(frames):
    """Packs PNG frames into an .ico (PNG-in-ICO, supported since Vista)."""
    count = len(frames)
    header = struct.pack("<HHH", 0, 1, count)
    offset = 6 + 16 * count
    entries, blobs = b"", b""
    for size, png in frames:
        entries += struct.pack(
            "<BBBBHHII",
            0 if size >= 256 else size,   # 0 means 256
            0 if size >= 256 else size,
            0, 0, 1, 32, len(png), offset,
        )
        blobs += png
        offset += len(png)
    return header + entries + blobs


def main():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    assets = os.path.join(root, "assets")
    os.makedirs(assets, exist_ok=True)

    frames = []
    for size in (16, 24, 32, 48, 64, 128, 256):
        frames.append((size, to_png(render(size))))
        print(f"  rendered {size}x{size}")

    ico_path = os.path.join(assets, "screen-buddy.ico")
    with open(ico_path, "wb") as fh:
        fh.write(to_ico(frames))
    print(f"wrote {ico_path}")

    tray = dict(frames)[32]
    print("\nTray icon data URL body (paste into src/main/tray-icon.js):\n")
    print(base64.b64encode(tray).decode())


if __name__ == "__main__":
    main()
