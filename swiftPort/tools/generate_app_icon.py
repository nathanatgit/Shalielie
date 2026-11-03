"""Generate the flattened icons (light, dark, tinted) and editable Icon Composer layers.

Requires Pillow, Node.js and sharp; without sharp the last rendered background PNG is reused.
`--variants-only` regenerates just the dark and tinted variants.
"""
from pathlib import Path
import json
import sys
from PIL import Image, ImageDraw, ImageFilter

SIZE = 1024
SS = 4
GRID = 5
ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "Resources" / "Assets.xcassets"
SOURCE = ROOT / "IconSources" / "Palettify.icon"
ACCENT = (1, 3)  # second row, fourth column; keep its original size
DOT_RADIUS = 0.022
ACCENT_RADIUS = 0.036
# The editable SVG is the only background source. Do not duplicate its gradient in code.

def background():
    import subprocess
    source = ROOT / "IconSources" / "Palettify-aurora-background-editable.svg"
    rendered = source.with_suffix(".png")
    try:
        subprocess.run(["node", str(ROOT / "tools" / "render_icon_background.cjs"),
                        str(source), str(rendered)], check=True)
    except (OSError, subprocess.CalledProcessError):
        if not rendered.exists():
            raise
        print(f"Could not render {source.name}; reusing {rendered.name}")
    with Image.open(rendered) as image:
        return image.convert("RGB")


def centers():
    for row in range(GRID):
        for col in range(GRID):
            yield row, col, SIZE * (0.24 + col * 0.13), SIZE * (0.24 + row * 0.13)


def svg(accent):
    circles = []
    for row, col, x, y in centers():
        if ((row, col) == ACCENT) == accent:
            radius = SIZE * (ACCENT_RADIUS if accent else DOT_RADIUS)
            circles.append(f'<circle id="dot-r{row+1}-c{col+1}" cx="{x:.3f}" cy="{y:.3f}" r="{radius:.3f}" fill="white"/>')
    return '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">' + ''.join(circles) + '</svg>\n'


def layers():
    n = SIZE * SS
    ordinary = Image.new("RGBA", (n, n))
    accent = Image.new("RGBA", (n, n))
    glow = Image.new("RGBA", (n, n))
    for row, col, x, y in centers():
        selected = (row, col) == ACCENT
        radius = n * (ACCENT_RADIUS if selected else DOT_RADIUS)
        cx, cy = x * SS, y * SS
        ImageDraw.Draw(accent if selected else ordinary).ellipse((cx-radius, cy-radius, cx+radius, cy+radius), fill="white")
        if selected:
            r = n * 0.044
            ImageDraw.Draw(glow).ellipse((cx-r, cy-r, cx+r, cy+r), fill=(255,255,255,90))
    mask = glow.getchannel("A").filter(ImageFilter.GaussianBlur(n * 0.017))
    glow = Image.new("RGBA", (n, n), (255, 255, 255, 0))
    glow.putalpha(mask)
    return [layer.resize((SIZE,SIZE), Image.Resampling.LANCZOS) for layer in (glow, ordinary, accent)]


def flatten(base, layers):
    composite = base.convert("RGBA")
    for layer in layers:
        composite = Image.alpha_composite(composite, layer)
    return composite.convert("RGB")


# iOS 18+ dark and tinted Home Screen icons. Dark: the same aurora at night, the dots kept bright.
# Tinted: grayscale on black, which iOS colours with the person's tint.
DARK_BACKGROUND = 0.30   # how much of the aurora's brightness survives at night
DARK_DOTS = 0.94         # dots a touch below pure white, so they don't glare on a dark screen


def dark_variant(base, glow, ordinary, accent):
    night = Image.blend(Image.new("RGB", base.size, (6, 10, 14)), base, DARK_BACKGROUND)
    def dim(layer):
        r, g, b, a = layer.split()
        return Image.merge("RGBA", (r, g, b, a.point(lambda v: round(v * DARK_DOTS))))
    return flatten(night, (glow, dim(ordinary), accent))


def tinted_variant(glow, ordinary, accent):
    return flatten(Image.new("RGB", (SIZE, SIZE), "black"), (glow, ordinary, accent)).convert("L")


def write_variants(base, glow, ordinary, accent):
    dark = dark_variant(base, glow, ordinary, accent)
    tinted = tinted_variant(glow, ordinary, accent)
    outputs = {
        ASSETS / "AppIcon.appiconset/icon-1024-dark.png": dark,
        ASSETS / "AppIcon.appiconset/icon-1024-tinted.png": tinted,
        ASSETS / "AboutIcon.imageset/about-icon-dark.png": dark,
    }
    for path, image in outputs.items():
        image.save(path, optimize=True)
        print(path)


def main():
    if "--variants-only" in sys.argv:
        rendered = ROOT / "IconSources" / "Palettify-aurora-background-editable.png"
        with Image.open(rendered) as image:
            write_variants(image.convert("RGB"), *layers())
        return
    source_assets = SOURCE / "Assets"
    source_assets.mkdir(parents=True, exist_ok=True)
    base = background()
    glow, ordinary, accent = layers()
    base.save(source_assets / "01-aurora-background.png", optimize=True)
    glow.save(source_assets / "02-accent-white-glow.png", optimize=True)
    (source_assets / "03-small-dots.svg").write_text(svg(False), encoding="utf-8")
    (source_assets / "04-accent-dot.svg").write_text(svg(True), encoding="utf-8")
    composite = flatten(base, (glow, ordinary, accent))
    for path in (ASSETS / "AppIcon.appiconset/icon-1024.png", ASSETS / "AboutIcon.imageset/about-icon.png"):
        composite.save(path, optimize=True)
        print(path)
    write_variants(base, glow, ordinary, accent)
    groups = []
    for name, filename in [("Aurora background", "01-aurora-background.png"), ("Accent glow", "02-accent-white-glow.png"), ("Small dots", "03-small-dots.svg"), ("Accent dot", "04-accent-dot.svg")]:
        groups.append({"name": name, "specular": False, "shadow": {"kind": "neutral", "opacity": 0}, "layers": [{"name": name, "image-name": filename, "glass": False, "position": {"scale": 1, "translation-in-points": [0,0]}}]})
    manifest = {"color-space-for-untagged-svg-colors":"srgb", "fill":{"solid":"srgb:0.09412,0.19216,0.19216,1.00000"}, "groups":groups, "supported-platforms":{"squares":"shared"}}
    (SOURCE / "icon.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

if __name__ == "__main__":
    main()
