#!/usr/bin/env python3
"""A `heif-convert` stand-in backed by pillow-heif.

`photographic_style_port.py` is stdlib-only by design and shells out to libheif's
`heif-convert` to decode a target's primary image. There is no libheif package on
Windows -- winget, scoop and choco all lack it -- so the dependency is supplied here
instead, using the libheif that pillow-heif already bundles.

Only the one call the porter makes is reproduced:

    heif-convert IN.HEIC OUT.png

Like `heif-convert`, this returns the image in *displayed* orientation (irot/imir
applied), which is what the porter's `decode_target_primary` expects. Bit depth is
preserved where Pillow can write it, so a 10-bit HEIC lands as a 16-bit PNG rather
than being flattened to 8.
"""
from __future__ import annotations

import sys
from pathlib import Path

try:
    import pillow_heif
except ImportError:  # pragma: no cover - environment problem, not a code path
    sys.exit("heif-convert shim: pillow-heif is not installed. Run `uv sync`.")


def convert(src: Path, dst: Path) -> None:
    heif = pillow_heif.open_heif(src, convert_hdr_to_8bit=False)
    image = heif.to_pillow()
    try:
        image.save(dst)
    except (OSError, ValueError):
        # Pillow cannot write every high-depth mode as PNG; 8-bit is the fallback
        # heif-convert itself would have produced.
        image.convert("RGB").save(dst)


def main(argv: list[str]) -> int:
    # The porter passes no flags; ignore any so the CLI stays drop-in compatible.
    args = [a for a in argv if not a.startswith("-")]
    if len(args) != 2:
        print("usage: heif-convert IN.HEIC OUT.png", file=sys.stderr)
        return 2
    src, dst = Path(args[0]), Path(args[1])
    if not src.is_file():
        print(f"heif-convert shim: no such file: {src}", file=sys.stderr)
        return 1
    convert(src, dst)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
