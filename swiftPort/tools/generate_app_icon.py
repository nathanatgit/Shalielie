"""Draw the Shalielie app icon: an abstract, layered take on the Photographic Styles pad.

A dark tile, a soft colour wash behind it, a translucent pad layer and its dot grid fading
from one corner, and the bright puck that marks the chosen style. Writes the 1024 px iOS
icon and the About-screen copy. Needs Pillow: python tools/generate_app_icon.py
"""
import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

SIZE = 1024
SS = 2  # supersampling
ROOT = Path(__file__).resolve().parent.parent / "Resources" / "Assets.xcassets"


def lerp(a, b, t):
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


def draw() -> Image.Image:
    n = SIZE * SS
    # Base: deep graphite, a touch lighter at the top.
    base = Image.new("RGB", (n, n))
    px = base.load()
    for y in range(n):
        c = lerp((44, 46, 54), (14, 15, 19), y / (n - 1))
        for x in range(n):
            px[x, y] = c

    # Colour wash: blurred blobs, the hues a style palette sweeps through.
    wash = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(wash)
    for cx, cy, r, col in [
        (0.24, 0.22, 0.42, (255, 170, 90, 120)),   # warm
        (0.80, 0.30, 0.38, (232, 92, 150, 95)),    # rose
        (0.30, 0.86, 0.40, (70, 170, 255, 105)),   # cool
        (0.84, 0.84, 0.34, (110, 230, 200, 80)),   # teal
    ]:
        d.ellipse([(cx - r) * n, (cy - r) * n, (cx + r) * n, (cy + r) * n], fill=col)
    wash = wash.filter(ImageFilter.GaussianBlur(n * 0.11))
    img = Image.alpha_composite(base.convert("RGBA"), wash)

    # Pad layers: a back plate offset down-right, then the glass pad on top.
    def plate(box, fill, outline, blur=0):
        layer = Image.new("RGBA", (n, n), (0, 0, 0, 0))
        ImageDraw.Draw(layer).rounded_rectangle(
            [v * n for v in box], radius=0.075 * n, fill=fill, outline=outline, width=int(0.004 * n))
        return layer.filter(ImageFilter.GaussianBlur(blur)) if blur else layer

    shadow = plate((0.19, 0.21, 0.85, 0.87), (0, 0, 0, 110), None, blur=n * 0.025)
    img = Image.alpha_composite(img, shadow)
    img = Image.alpha_composite(img, plate((0.205, 0.215, 0.835, 0.845), (255, 255, 255, 22),
                                           (255, 255, 255, 40)))
    img = Image.alpha_composite(img, plate((0.165, 0.165, 0.795, 0.795), (22, 24, 30, 228),
                                           (255, 255, 255, 70)))

    # Dot grid on the front pad, brightest towards the top-left, like the pad's falloff.
    dots = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    dd = ImageDraw.Draw(dots)
    grid, x0, x1 = 9, 0.235, 0.725
    step = (x1 - x0) / (grid - 1)
    puck = (5, 3)  # column, row of the chosen position
    for row in range(grid):
        for col in range(grid):
            if (col, row) == puck:
                continue
            t = (col + row) / (2 * (grid - 1))
            dist = math.hypot(col - puck[0], row - puck[1]) / grid
            alpha = int(235 - 175 * t - 40 * min(dist, 1) + 30 * (1 - min(dist * 2, 1)))
            r = n * (0.0105 - 0.004 * t)
            cx, cy = (x0 + col * step) * n, (x0 + row * step) * n
            dd.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(255, 255, 255, max(alpha, 40)))
    img = Image.alpha_composite(img, dots)

    # The puck: a soft glow, a ring and a bright core.
    pcx, pcy = (x0 + puck[0] * step) * n, (x0 + puck[1] * step) * n
    glow = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse([pcx - 0.075 * n, pcy - 0.075 * n, pcx + 0.075 * n, pcy + 0.075 * n],
                                 fill=(255, 236, 200, 150))
    img = Image.alpha_composite(img, glow.filter(ImageFilter.GaussianBlur(n * 0.03)))
    top = ImageDraw.Draw(img)
    ring = 0.043 * n
    top.ellipse([pcx - ring, pcy - ring, pcx + ring, pcy + ring], outline=(255, 255, 255, 230),
                width=int(0.006 * n))
    core = 0.028 * n
    top.ellipse([pcx - core, pcy - core, pcx + core, pcy + core], fill=(255, 255, 255, 255))

    return img.convert("RGB").resize((SIZE, SIZE), Image.LANCZOS)


def main():
    icon = draw()
    targets = [ROOT / "AppIcon.appiconset" / "icon-1024.png", ROOT / "AboutIcon.imageset" / "about-icon.png"]
    for path in targets:
        path.parent.mkdir(parents=True, exist_ok=True)
        icon.save(path, optimize=True)
        print(path)


if __name__ == "__main__":
    main()
