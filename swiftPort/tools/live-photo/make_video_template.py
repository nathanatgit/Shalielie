"""Build the Live Photo video template the app ships, from a native iPhone 18 Pro video.

usage: python make_video_template.py NATIVE.MOV OUT.mov

Keeps only the style parts of a native video, with no location, dates, device or identifier:
  - the auxv tracks video-map.sky / .person / .skin / .smart-style-linear-thumbnail; the three
    mattes get one black 256x192 HEVC sample each, the thumbnail none (the app fills them in)
  - the com.apple.quicktime.smartstyle-info and texturestyle-info timed metadata tracks, with
    all their samples
  - the moov-level com.apple.quicktime.smartstyle.* / texturestyle.* keys
Creation and modification times are zeroed. Output: ftyp + moov + one mdat.
"""
import struct
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from mov_linear_thumb import boxes, box, child, full, handler, path, raw, samples, stbl_tables, tracks  # noqa: E402
from mov_style_tracks import encode, qt_meta_items  # noqa: E402

PREFIX = (b"com.apple.quicktime.smartstyle.", b"com.apple.quicktime.texturestyle.")
MATTES = (b"sky", b"person", b"skin")
INFO = (b"com.apple.quicktime.smartstyle-info", b"com.apple.quicktime.texturestyle-info")
FORBIDDEN = [b"ISO6709", b"location", b"creationdate", b"content.identifier", b"iPhone 18 Pro",
             b"com.apple.quicktime.make", b"com.apple.quicktime.model",
             b"com.apple.quicktime.software", b"live-photo"]


def zero_times(b, h):
    """A tkhd / mdhd / mvhd box with creation and modification time set to 0."""
    b = bytearray(b)
    n = 8 if b[h] == 1 else 4
    b[h + 4:h + 4 + 2 * n] = bytes(2 * n)
    return bytes(b)


def stsd_with(data, p, h, hvcc):
    """The stsd box at p with its (single) sample entry's hvcC replaced."""
    entry = p + h + 8
    size = struct.unpack(">I", data[entry:entry + 4])[0]
    head = data[entry + 4:entry + 86]
    extras = b"".join(hvcc if t == b"hvcC" else data[q:q + s]
                      for q, s, _, t in boxes(data, entry + 86, entry + size))
    return box(b"stsd", full(0, 0), struct.pack(">I", 1), struct.pack(">I", 4 + len(head) + len(extras)) + head + extras)


def track_box(data, trak, sample_sizes, deltas_box, hvcc, offset):
    """The kept trak, times zeroed, sample tables rebuilt for one chunk of sample_sizes at offset."""
    n = len(sample_sizes)

    def rebuild(start, end):
        out = b""
        for p, s, h, t in boxes(data, start, end):
            if t in (b"trak", b"mdia", b"minf", b"stbl"):
                out += box(t, rebuild(p + h, p + s))
            elif t in (b"tkhd", b"mdhd"):
                out += zero_times(data[p:p + s], h)
            elif t == b"stsd" and hvcc is not None:
                out += stsd_with(data, p, h, hvcc)
            elif t == b"stts":
                out += deltas_box
            elif t == b"stsc":
                out += box(b"stsc", full(0, 0), struct.pack(">I", 1 if n else 0), struct.pack(">III", 1, n, 1) if n else b"")
            elif t == b"stsz":
                out += box(b"stsz", full(0, 0), struct.pack(">II", 0, n), struct.pack(f">{n}I", *sample_sizes))
            elif t in (b"stco", b"co64"):
                out += box(b"stco", full(0, 0), struct.pack(">I", 1 if n else 0), struct.pack(">I", offset) if n else b"")
            elif t in (b"stss", b"sdtp", b"ctts", b"sgpd", b"sbgp", b"cslg"):
                continue
            else:
                out += data[p:p + s]
        return out

    p, s, h = trak
    return box(b"trak", rebuild(p + h, p + s))


def filtered_meta(data, meta):
    """The moov meta box reduced to the smartstyle / texturestyle keys, items renumbered 1..n."""
    keys, items = qt_meta_items(data, meta)
    kept = [(keys[i - 1], body) for i, body in items if keys[i - 1][8:].startswith(PREFIX)]
    p, s, h = meta
    parts = []
    for q, s2, h2, t in boxes(data, p + h, p + s):
        if t == b"keys":
            parts.append(box(b"keys", full(0, 0), struct.pack(">I", len(kept)), *(k for k, _ in kept)))
        elif t == b"ilst":
            parts.append(box(b"ilst", *(struct.pack(">II", 8 + len(b), i) + b for i, (_, b) in enumerate(kept, 1))))
        else:
            parts.append(data[q:q + s2])
    return box(b"meta", *parts), [k[8:].decode() for k, _ in kept]


def main(native_path, out_path):
    native = Path(native_path).read_bytes()
    (mp, ms, mh), ntracks = tracks(native)
    ftyp = raw(native, child(native, 0, len(native), b"ftyp"))

    # The one black matte sample, as the app's matte tracks carry.
    black = ["-f", "lavfi", "-i", "color=c=black:s=256x192:r=30:d=0.0334", "-frames:v", "1"]
    matte_samples, matte_hvcc, _ = encode(black, "format=gray", "gray",
                                          "keyint=1:min-keyint=1:bframes=0:log-level=error", 1)
    matte = matte_samples[0]

    # Kept tracks in original order: (trak, sample list, hvcc, name).
    kept = []
    for t in ntracks:
        r = raw(native, t)
        if handler(native, t) == b"auxv":
            for name in MATTES + (b"smart-style-linear-thumbnail",):
                if b"com.apple.quicktime.video-map." + name in r:
                    kept.append((t, [matte] if name in MATTES else [], matte_hvcc if name in MATTES else None,
                                 "video-map." + name.decode()))
        elif handler(native, t) == b"meta":
            for tag in INFO:
                if tag in r:
                    kept.append((t, samples(native, t), None, tag.decode()))
    assert len(kept) == 6, [k[3] for k in kept]

    mvhd = child(native, mp + mh, mp + ms, b"mvhd")
    meta, meta_keys = filtered_meta(native, child(native, mp + mh, mp + ms, b"meta"))
    head_mvhd = zero_times(raw(native, mvhd), mvhd[2])

    def build_moov(offsets):
        traks = []
        for (t, ss, hvcc, _), off in zip(kept, offsets):
            stts = raw(native, stbl_tables(native, t)[b"stts"]) if ss and hvcc is None \
                else box(b"stts", full(0, 0), struct.pack(">I", 1 if ss else 0), struct.pack(">II", 1, 1) if ss else b"")
            traks.append(track_box(native, t, [len(x) for x in ss], stts, hvcc, off))
        return box(b"moov", head_mvhd, *traks, meta)

    # Build moov twice: its size does not depend on the offsets.
    moov = build_moov([0] * len(kept))
    cursor = len(ftyp) + len(moov) + 8
    offsets, blob = [], b""
    for _, ss, _, _ in kept:
        offsets.append(cursor + len(blob))
        blob += b"".join(ss)
    moov2 = build_moov(offsets)
    assert len(moov2) == len(moov)
    out = ftyp + moov2 + box(b"mdat", blob)
    Path(out_path).write_bytes(out)

    # Self-check: re-read the output.
    for needle in FORBIDDEN:
        assert needle not in out, needle
    assert [t for _, _, _, t in boxes(out, 0, len(out))] == [b"ftyp", b"moov", b"mdat"]
    _, otracks = tracks(out)
    assert len(otracks) == len(kept)
    video_n = 0
    for (nt, ss, hvcc, name), ot in zip(kept, otracks):
        got = samples(out, ot)
        if hvcc is None and ss:
            assert got == samples(native, nt), name
            assert got == ss, name
        else:
            assert got == ss, name
        if handler(out, ot) == b"auxv":
            if got:
                subprocess.run(["ffmpeg", "-v", "error", "-i", out_path, "-map", f"0:v:{video_n}", "-f", "null", "-"],
                               check=True)
            video_n += 1
    for name in INFO:
        assert sum(name in raw(out, t) for t in otracks) == 1, name

    for (nt, ss, hvcc, name) in kept:
        print(f"{handler(native, nt).decode()} {name}: {len(ss)} samples")
    print("moov keys:", ", ".join(meta_keys))
    print(f"{len(out)} bytes -> {out_path}")


if __name__ == "__main__":
    main(*sys.argv[1:3])
