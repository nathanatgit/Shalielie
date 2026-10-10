#!/usr/bin/env python3
"""Rebuild LIVE_VIDEO_TEMPLATE_B85 in photographic_style_port.py from a native Live Photo video.

usage: python tools/build_live_video_template.py NATIVE_IOS27.MOV

NATIVE_IOS27.MOV is a Live Photo video shot on iOS 27 (it must carry the texturestyle-info
track). Kept: the headers and sample descriptions of the six Photographic Style tracks (no
samples, no edit lists), the moov smartstyle.* / texturestyle.* keys, and one smartstyle-info
sample (a tone curve and a few statistics). Dropped: every picture (thumbnail, mattes, main
video) and the texturestyle-info samples, which carry face IDs and angles; the porter writes
its own. Prints the new constant; paste it over the old one.
"""
import base64
import struct
import sys
import zlib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import photographic_style_port as psp  # noqa: E402

TAGS = (psp.LIVE_THUMB_TAG, *psp.LIVE_MATTE_TAGS, *psp.LIVE_INFO_TAGS)
SAMPLE_TABLES = (b"stts", b"stss", b"stsc", b"stsz", b"stco", b"co64", b"sdtp", b"ctts",
                 b"sgpd", b"sbgp", b"cslg")


def skeleton(data: bytes, start: int, end: int) -> bytes:
    out = b""
    for p, s, h, t in psp._mov_boxes(data, start, end):
        if t in (b"edts", b"meta") or t in SAMPLE_TABLES:
            continue
        if t in (b"mdia", b"minf", b"stbl", b"tref", b"dinf"):
            out += psp._mov_box(t, skeleton(data, p + h, p + s))
        else:
            out += data[p:p + s]
    return out


def main(src: str) -> None:
    data = Path(src).read_bytes()
    (mp, ms, mh), tracks = psp._mov_tracks(data)
    traks = []
    for tag in TAGS:
        t = next((t for t in tracks if tag in psp._mov_raw(data, t)), None)
        if t is None:
            sys.exit(f"{src} has no {tag.decode()} track (not an iOS 27 Live Photo video?)")
        traks.append(psp._mov_box(b"trak", skeleton(data, t[0] + t[2], t[0] + t[1])))
    meta = psp._mov_child(data, mp + mh, mp + ms, b"meta")
    keys, items = psp._mov_meta_items(data, meta)
    kept = [(keys[i - 1], body) for i, body in items
            if keys[i - 1][8:].startswith(psp.LIVE_STYLE_KEY_PREFIXES)]
    hdlr = psp._mov_raw(data, psp._mov_child(data, meta[0] + meta[2], meta[0] + meta[1], b"hdlr"))
    new_meta = psp._mov_box(
        b"meta", hdlr,
        psp._mov_box(b"keys", psp._mov_full(0), struct.pack(">I", len(kept)), *(k for k, _ in kept)),
        psp._mov_box(b"ilst", *(struct.pack(">II", 8 + len(b), n) + b for n, (_, b) in enumerate(kept, 1))))
    info = next(t for t in tracks if psp.LIVE_INFO_TAGS[0] in psp._mov_raw(data, t))
    style_samples = psp._mov_samples(data, info)
    packed = (psp._mov_box(b"moov", new_meta, *traks)
              + psp._mov_box(b"smpl", style_samples[len(style_samples) // 2]))
    b85 = base64.b85encode(zlib.compress(packed, 9)).decode("ascii")
    print("LIVE_VIDEO_TEMPLATE_B85 = (")
    for i in range(0, len(b85), 96):
        print(f'    "{b85[i:i + 96]}"')
    print(")")
    print(f"# {len(packed)} bytes, {len(b85)} characters", file=sys.stderr)


if __name__ == "__main__":
    main(sys.argv[1])
