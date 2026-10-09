"""Experiment: give a Live Photo video the smart-style linear-thumbnail auxiliary track.

usage: python mov_linear_thumb.py TARGET.MOV NATIVE_TEMPLATE.MOV OUT.MOV

Encodes the target's main video at 128x96, 10-bit HEVC (Main 10), one sample per main-video
frame, and adds it as an `auxv` track cloned from the native template's
`com.apple.quicktime.video-map.smart-style-linear-thumbnail` track: same handler, sample
entry extras (colr, logs), `tref vmap` to the main video and `udta tagc` name, with the
target's own timing. Everything else in the target is left byte for byte; the new samples
go into a second mdat after moov.
"""
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

TAG = b"com.apple.quicktime.video-map.smart-style-linear-thumbnail"


def boxes(data, start, end):
    p = start
    while p + 8 <= end:
        size, typ = struct.unpack(">I4s", data[p:p + 8])
        hdr = 8
        if size == 1:
            size = struct.unpack(">Q", data[p + 8:p + 16])[0]
            hdr = 16
        elif size == 0:
            size = end - p
        if size < hdr or p + size > end:
            raise ValueError(f"bad box {typ!r} at {p}")
        yield p, size, hdr, typ
        p += size


def child(data, start, end, typ):
    for p, s, h, t in boxes(data, start, end):
        if t == typ:
            return p, s, h
    return None


def path(data, start, end, types):
    for t in types:
        found = child(data, start, end, t)
        if not found:
            return None
        p, s, h = found
        start, end = p + h, p + s
    return p, s, h


def box(typ, *parts):
    body = b"".join(parts)
    return struct.pack(">I4s", 8 + len(body), typ) + body


def full(version, flags):
    return bytes([version]) + flags.to_bytes(3, "big")


def raw(data, found):
    p, s, _ = found
    return data[p:p + s]


def tracks(data):
    mp, ms, mh = child(data, 0, len(data), b"moov")
    out = []
    for p, s, h, t in boxes(data, mp + mh, mp + ms):
        if t == b"trak":
            out.append((p, s, h))
    return (mp, ms, mh), out


def handler(data, trak):
    p, s, h = trak
    hd = path(data, p + h, p + s, [b"mdia", b"hdlr"])
    return data[hd[0] + hd[2] + 8:hd[0] + hd[2] + 12]


def track_id(data, trak):
    p, s, h = trak
    tk = child(data, p + h, p + s, b"tkhd")
    version = data[tk[0] + tk[2]]
    off = tk[0] + tk[2] + 4 + (16 if version == 1 else 8)
    return struct.unpack(">I", data[off:off + 4])[0]


def stbl_tables(data, trak):
    p, s, h = trak
    st = path(data, p + h, p + s, [b"mdia", b"minf", b"stbl"])
    return {t: (q, sz, hh) for q, sz, hh, t in boxes(data, st[0] + st[2], st[0] + st[1])}


def samples(data, trak):
    """Every sample's bytes, in decode order, from stsz/stsc/stco(co64)."""
    tabs = stbl_tables(data, trak)
    q, s, h = tabs[b"stsz"]
    fixed, count = struct.unpack(">II", data[q + h + 4:q + h + 12])
    sizes = [fixed] * count if fixed else list(struct.unpack(f">{count}I", data[q + h + 12:q + h + 12 + 4 * count]))
    q, s, h = tabs[b"stsc"]
    n = struct.unpack(">I", data[q + h + 4:q + h + 8])[0]
    stsc = [struct.unpack(">III", data[q + h + 8 + 12 * i:q + h + 20 + 12 * i]) for i in range(n)]
    if b"stco" in tabs:
        q, s, h = tabs[b"stco"]
        n = struct.unpack(">I", data[q + h + 4:q + h + 8])[0]
        offsets = list(struct.unpack(f">{n}I", data[q + h + 8:q + h + 8 + 4 * n]))
    else:
        q, s, h = tabs[b"co64"]
        n = struct.unpack(">I", data[q + h + 4:q + h + 8])[0]
        offsets = list(struct.unpack(f">{n}Q", data[q + h + 8:q + h + 8 + 8 * n]))
    out, k = [], 0
    for chunk_index, offset in enumerate(offsets, 1):
        per = next(spc for first, spc, _ in reversed(stsc) if first <= chunk_index)
        for _ in range(per):
            out.append(data[offset:offset + sizes[k]])
            offset += sizes[k]
            k += 1
    assert k == count
    return out


def main(target_path, template_path, out_path):
    target = Path(target_path).read_bytes()
    template = Path(template_path).read_bytes()

    top = [t for _, _, _, t in boxes(target, 0, len(target))]
    assert top[-1] == b"moov", f"expected moov last, got {top}"
    (mp, ms, mh), ttracks = tracks(target)
    main_video = next(t for t in ttracks if handler(target, t) == b"vide")
    main_id = track_id(target, main_video)
    main_tabs = stbl_tables(target, main_video)
    frames = struct.unpack(">I", target[main_tabs[b"stsz"][0] + main_tabs[b"stsz"][2] + 8:][:4])[0]
    # Like native files, the aux track takes the main video's decode timing (stts) and has no
    # ctts, even when the main video reorders frames.

    _, ntracks = tracks(template)
    native = next(t for t in ntracks if TAG in raw(template, t))
    np_, ns, nh = native

    # 1. Encode 128x96 10-bit HEVC, one frame per main-video frame, no B-frames.
    with tempfile.TemporaryDirectory() as tmp:
        enc = Path(tmp) / "lt.mp4"
        subprocess.run([
            "ffmpeg", "-v", "error", "-y", "-i", target_path, "-map", "0:v:0", "-an",
            "-vf", "scale=128:96:flags=area,format=yuv420p10le", "-fps_mode", "passthrough",
            "-c:v", "libx265", "-preset", "medium", "-x265-params",
            "bframes=0:keyint=30:min-keyint=1:log-level=error:repeat-headers=0",
            "-tag:v", "hvc1", str(enc),
        ], check=True)
        encoded = enc.read_bytes()
    _, etracks = tracks(encoded)
    etrack = etracks[0]
    new_samples = samples(encoded, etrack)
    assert len(new_samples) == frames, f"{len(new_samples)} encoded frames vs {frames} in main video"
    etabs = stbl_tables(encoded, etrack)
    ep, es, eh = etrack
    esd = path(encoded, ep + eh, ep + es, [b"mdia", b"minf", b"stbl", b"stsd"])
    eentry = esd[0] + esd[2] + 8
    eentry_size = struct.unpack(">I", encoded[eentry:eentry + 4])[0]
    hvcc = raw(encoded, child(encoded, eentry + 86, eentry + eentry_size, b"hvcC"))

    # 2. Rebuild the native track around the new samples and the target's timing.
    def rebuild(start, end, kind):
        out = b""
        for p, s, h, t in boxes(template, start, end):
            if t in (b"trak", b"mdia", b"minf", b"stbl", b"tref", b"dinf") or t == b"edts":
                if t == b"edts":
                    edts = child(target, main_video[0] + main_video[2], main_video[0] + main_video[1], b"edts")
                    out += raw(target, edts) if edts else b""
                    continue
                out += box(t, rebuild(p + h, p + s, t))
            elif t == b"vmap":
                n = (s - h) // 4
                out += box(b"vmap", struct.pack(f">{n}I", *([main_id] * n)))
            elif t == b"tkhd":
                b = bytearray(template[p:p + s])
                v = b[h]
                main_tk = child(target, main_video[0] + main_video[2], main_video[0] + main_video[1], b"tkhd")
                mv = target[main_tk[0] + main_tk[2]]
                id_off = h + 4 + (16 if v == 1 else 8)
                dur_off = id_off + 8
                mdur_off = main_tk[2] + 4 + (16 if mv == 1 else 8) + 8
                main_dur = int.from_bytes(target[main_tk[0] + mdur_off:main_tk[0] + mdur_off + (8 if mv == 1 else 4)], "big")
                b[id_off:id_off + 4] = new_id.to_bytes(4, "big")
                b[dur_off:dur_off + (8 if v == 1 else 4)] = main_dur.to_bytes(8 if v == 1 else 4, "big")
                out += bytes(b)
            elif t == b"mdhd":
                out += raw(target, path(target, main_video[0] + main_video[2], main_video[0] + main_video[1], [b"mdia", b"mdhd"]))
            elif t == b"stsd":
                entry = p + h + 8
                size = struct.unpack(">I", template[entry:entry + 4])[0]
                head = template[entry + 4:entry + 86]
                extras = b"".join(
                    hvcc if t2 == b"hvcC" else template[q:q + s2]
                    for q, s2, _, t2 in boxes(template, entry + 86, entry + size))
                sample_entry = struct.pack(">I", 4 + len(head) + len(extras)) + head + extras
                out += box(b"stsd", full(0, 0), struct.pack(">I", 1), sample_entry)
            elif t == b"stts":
                out += raw(target, main_tabs[b"stts"])
            elif t == b"stss":
                out += raw(encoded, etabs[b"stss"]) if b"stss" in etabs else b""
            elif t == b"stsc":
                out += box(b"stsc", full(0, 0), struct.pack(">IIII", 1, 1, len(new_samples), 1))
            elif t == b"stsz":
                out += box(b"stsz", full(0, 0), struct.pack(">II", 0, len(new_samples)),
                           struct.pack(f">{len(new_samples)}I", *map(len, new_samples)))
            elif t in (b"stco", b"co64"):
                out += box(b"stco", full(0, 0), struct.pack(">II", 1, 0xDEADBEEF))  # patched below
            elif t in (b"sdtp", b"ctts", b"sgpd", b"sbgp", b"cslg"):
                continue  # per-sample tables of the template's own samples
            else:
                out += template[p:p + s]
        return out

    mvhd = child(target, mp + mh, mp + ms, b"mvhd")
    mv = target[mvhd[0] + mvhd[2]]
    next_off = mvhd[0] + mvhd[1] - 4
    new_id = struct.unpack(">I", target[next_off:next_off + 4])[0]
    new_trak = box(b"trak", rebuild(np_ + nh, np_ + ns, b"trak"))

    # 3. New moov: the auxv track right after the main video, next_track_ID bumped.
    parts = []
    for p, s, h, t in boxes(target, mp + mh, mp + ms):
        chunk = bytearray(target[p:p + s])
        if t == b"mvhd":
            chunk[-4:] = (new_id + 1).to_bytes(4, "big")
        parts.append(bytes(chunk))
        if (p, s, h) == main_video:
            parts.append(new_trak)
    moov = box(b"moov", *parts)
    head = target[:mp]
    mdat_payload = b"".join(new_samples)
    first_sample = len(head) + len(moov) + 8
    marker = struct.pack(">I", 0xDEADBEEF)
    assert moov.count(marker) == 1
    moov = moov.replace(marker, struct.pack(">I", first_sample))
    Path(out_path).write_bytes(head + moov + box(b"mdat", mdat_payload))
    print(f"added track {new_id} ({len(new_samples)} samples, {len(mdat_payload)} bytes) "
          f"-> {out_path}")


if __name__ == "__main__":
    main(*sys.argv[1:4])
