"""Draw the Shalielie app icon: the Photographic Styles pad as a square of dots on a gradient.

Writes the 1024 px iOS icon and the About-screen copy. Needs Pillow:
python tools/generate_app_icon.py
"""
from pathlib import Path

from PIL import Image, ImageDraw

SIZE = 1024
SS = 4  # supersampling for smooth dots
GRID = 7
ROOT = Path(__file__).resolve().parent.parent / "Resources" / "Assets.xcassets"

# Diagonal gradient, top-left to bottom-right: warm amber through rose to violet blue.
STOPS = [(0.0, (255, 176, 92)), (0.5, (236, 84, 128)), (1.0, (92, 84, 230))]


def gradient(t: float):
    for (t0, c0), (t1, c1) in zip(STOPS, STOPS[1:]):
        if t <= t1:
            f = (t - t0) / (t1 - t0)
            return tuple(round(a + (b - a) * f) for a, b in zip(c0, c1))
    return STOPS[-1][1]


def draw() -> Image.Image:
    # Build the gradient small, then scale up: it is smooth, so nothing is lost.
    small = 256
    base = Image.new("RGB", (small, small))
    px = base.load()
    for y in range(small):
        for x in range(small):
            px[x, y] = gradient((x + y) / (2 * (small - 1)))
    n = SIZE * SS
    img = base.resize((n, n), Image.BICUBIC).convert("RGBA")

    # A square of evenly spaced white dots, centred, filling a bit over half the icon.
    dots = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(dots)
    span = 0.56 * n
    start = (n - span) / 2
    step = span / (GRID - 1)
    radius = 0.028 * n
    for row in range(GRID):
        for col in range(GRID):
            cx, cy = start + col * step, start + row * step
            d.ellipse([cx - radius, cy - radius, cx + radius, cy + radius], fill=(255, 255, 255, 235))
    img = Image.alpha_composite(img, dots)
    return img.convert("RGB").resize((SIZE, SIZE), Image.LANCZOS)


def main():
    icon = draw()
    for path in (ROOT / "AppIcon.appiconset" / "icon-1024.png", ROOT / "AboutIcon.imageset" / "about-icon.png"):
        path.parent.mkdir(parents=True, exist_ok=True)
        icon.save(path, optimize=True)
        print(path)


if __name__ == "__main__":
    main()
