import zlib, struct, base64, math

S = 32
px = [[(0, 0, 0, 0) for _ in range(S)] for _ in range(S)]

cx = cy = (S - 1) / 2.0
CYAN = (34, 231, 255)
MAGENTA = (255, 60, 180)

# Anti-aliased ring, with the lower-right arc shifting toward magenta so the
# icon reads as the same gauge motif the HUD uses.
R_OUT, R_IN = 14.0, 9.5
for y in range(S):
    for x in range(S):
        d = math.hypot(x - cx, y - cy)
        # coverage of the annulus, smoothed over ~1px at each edge
        a_out = max(0.0, min(1.0, (R_OUT - d) + 0.5))
        a_in = max(0.0, min(1.0, (d - R_IN) + 0.5))
        a = a_out * a_in
        if a <= 0.003:
            continue
        ang = (math.degrees(math.atan2(y - cy, x - cx)) + 360) % 360
        t = max(0.0, min(1.0, (ang - 20) / 180.0))
        col = tuple(int(round(CYAN[i] + (MAGENTA[i] - CYAN[i]) * t)) for i in range(3))
        px[y][x] = (col[0], col[1], col[2], int(round(255 * a)))

# Gauge needle: a short bar from centre toward the upper right.
for r in range(0, 8):
    ang = math.radians(-52)
    x = int(round(cx + math.cos(ang) * r))
    y = int(round(cy + math.sin(ang) * r))
    for dy in (-1, 0):
        for dx in (0, 1):
            xx, yy = x + dx, y + dy
            if 0 <= xx < S and 0 <= yy < S:
                px[yy][xx] = (180, 245, 255, 255)

raw = b"".join(
    b"\x00" + b"".join(struct.pack("BBBB", *px[y][x]) for x in range(S))
    for y in range(S)
)

def chunk(tag, data):
    c = struct.pack(">I", len(data)) + tag + data
    return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

png = (
    b"\x89PNG\r\n\x1a\n"
    + chunk(b"IHDR", struct.pack(">IIBBBBB", S, S, 8, 6, 0, 0, 0))
    + chunk(b"IDAT", zlib.compress(raw, 9))
    + chunk(b"IEND", b"")
)

print(base64.b64encode(png).decode())
