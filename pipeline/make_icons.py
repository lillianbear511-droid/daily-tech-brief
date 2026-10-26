#!/usr/bin/env python3
"""Generate app icons without any image library (pure zlib PNG writer)."""
import struct
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "app" / "icons"
INK = (22, 22, 26)
ACCENT = (255, 90, 54)
BAR_W, GAP = 0.086, 0.066          # fractions of canvas
HEIGHTS = (0.30, 0.52, 0.68, 0.38)


def capsule(x, y, cx, top, bottom, half_w, rad):
    if not (cx - half_w <= x <= cx + half_w):
        return False
    if top + rad <= y <= bottom - rad:
        return True
    cy = top + rad if y < top + rad else bottom - rad
    return (x - cx) ** 2 + (y - cy) ** 2 <= rad ** 2


def make(size: int):
    bw = BAR_W * size
    gap = GAP * size
    total = 4 * bw + 3 * gap
    x0 = (size - total) / 2
    bars = []
    for i, h in enumerate(HEIGHTS):
        cx = x0 + i * (bw + gap) + bw / 2
        bar_h = h * size
        top = (size - bar_h) / 2
        bars.append((cx, top, top + bar_h))

    rows = []
    for y in range(size):
        row = bytearray([0])
        for x in range(size):
            hit = any(capsule(x, y, cx, top, bottom, bw / 2, bw / 2) for cx, top, bottom in bars)
            row += bytes(ACCENT if hit else INK) + b"\xff"
        rows.append(bytes(row))
    raw = b"".join(rows)

    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data +
                struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    return (b"\x89PNG\r\n\x1a\n" +
            chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)) +
            chunk(b"IDAT", zlib.compress(raw, 9)) +
            chunk(b"IEND", b""))


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    for s in (180, 192, 512):
        p = OUT / f"icon-{s}.png"
        p.write_bytes(make(s))
        print(f"{p.name}  {p.stat().st_size / 1024:.0f} KB")
