"""Draw the Shalielie app icon: the Photographic Styles pad as a square of dots on a gradient.

Writes the 1024 px iOS icon and the About-screen copy. Needs Pillow:
python tools/generate_app_icon.py
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

SIZE = 1024
SS = 4  # supersampling for smooth dots
GRID = 5
ROOT = Path(__file__).resolve().parent.parent / "Resources" / "Assets.xcassets"

# Diagonal gradient, top-left to bottom-right: sky blue through system blue to deep indigo.
STOPS = [(0.0, (100, 210, 255)), (0.5, (10, 122, 255)), (1.0, (40, 40, 170))]


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

    # A square of evenly spaced white dots, centred, each with a soft white glow.
    span = 0.52 * n
    start = (n - span) / 2
    step = span / (GRID - 1)
    centres = [(start + col * step, start + row * step) for row in range(GRID) for col in range(GRID)]

    def layer(radius, alpha):
        out = Image.new("RGBA", (n, n), (0, 0, 0, 0))
        d = ImageDraw.Draw(out)
        for cx, cy in centres:
            d.ellipse([cx - radius, cy - radius, cx + radius, cy + radius], fill=(255, 255, 255, alpha))
        return out

    glow = layer(0.055 * n, 150).filter(ImageFilter.GaussianBlur(0.03 * n))
    img = Image.alpha_composite(img, glow)
    img = Image.alpha_composite(img, layer(0.036 * n, 255))
    return img.convert("RGB").resize((SIZE, SIZE), Image.LANCZOS)


def main():
    icon = draw()
    for path in (ROOT / "AppIcon.appiconset" / "icon-1024.png", ROOT / "AboutIcon.imageset" / "about-icon.png"):
        path.parent.mkdir(parents=True, exist_ok=True)
        icon.save(path, optimize=True)
        print(path)


if __name__ == "__main__":
    main()
