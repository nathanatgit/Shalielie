"""Experiment: give a Live Photo video every Photographic Style part a native one has.

usage: python mov_style_tracks.py TARGET.MOV NATIVE_TEMPLATE.MOV OUT.MOV

Adds, cloned from the native template's tracks and fitted to the target's own frames:
  - video-map.smart-style-linear-thumbnail: 128x96 10-bit HEVC of the target, every frame
  - video-map.sky / .person / .skin: empty (black) 256x192 mattes, every 2nd frame
  - com.apple.quicktime.smartstyle-info timed metadata: the template's samples, spread over
    the target's frames
  - com.apple.quicktime.texturestyle-info timed metadata, the same way, when the template has
    it (iPhone 18, iOS 27 Texture & Grain)
and the template's moov-level com.apple.quicktime.smartstyle.* / texturestyle.* keys. The target's own boxes
and payloads are untouched; new samples go into a second mdat after moov.
"""
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from mov_linear_thumb import boxes, box, child, full, handler, path, raw, samples, stbl_tables, track_id, tracks  # noqa: E402

PLACEHOLDER = 0xDEADBE00


def stts_entries(data, tabs):
    q, s, h = tabs[b"stts"]
    n = struct.unpack(">I", data[q + h + 4:q + h + 8])[0]
    out = []
    for k in range(n):
        count, delta = struct.unpack(">II", data[q + h + 8 + 8 * k:q + h + 16 + 8 * k])
        out += [delta] * count
    return out


def stts_box(deltas):
    runs = []
    for d in deltas:
        if runs and runs[-1][1] == d:
            runs[-1][0] += 1
        else:
            runs.append([1, d])
    return box(b"stts", full(0, 0), struct.pack(">I", len(runs)), *(struct.pack(">II", *r) for r in runs))


def encode(target_path, vf, pix_fmt, params, frames_expected=None):
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp) / "enc.mp4"
        cmd = ["ffmpeg", "-v", "error", "-y"]
        if isinstance(target_path, str):
            cmd += ["-i", target_path, "-map", "0:v:0", "-an", "-fps_mode", "passthrough"]
        else:
            cmd += target_path
        cmd += ["-vf", vf, "-pix_fmt", pix_fmt, "-c:v", "libx265", "-x265-params", params, "-tag:v", "hvc1", str(out)]
        subprocess.run(cmd, check=True)
        enc = out.read_bytes()
    _, ts = tracks(enc)
    t = ts[0]
    ss = samples(enc, t)
    if frames_expected is not None:
        assert len(ss) == frames_expected, (len(ss), frames_expected)
    p, s, h = t
    sd = path(enc, p + h, p + s, [b"mdia", b"minf", b"stbl", b"stsd"])
    e = sd[0] + sd[2] + 8
    es = struct.unpack(">I", enc[e:e + 4])[0]
    hvcc = raw(enc, child(enc, e + 86, e + es, b"hvcC"))
    tabs = stbl_tables(enc, t)
    stss = raw(enc, tabs[b"stss"]) if b"stss" in tabs else b""
    return ss, hvcc, stss


def clone_track(template, ttrack, target, main_video, new_id, sample_list, deltas, hvcc=None, stss=b""):
    """The template track, rebuilt around new samples and timing."""
    main_id = track_id(target, main_video)
    mp_, ms_, mh_ = main_video

    def rebuild(start, end):
        out = b""
        for p, s, h, t in boxes(template, start, end):
            if t in (b"trak", b"mdia", b"minf", b"stbl", b"tref", b"dinf"):
                out += box(t, rebuild(p + h, p + s))
            elif t == b"edts":
                e = child(target, mp_ + mh_, mp_ + ms_, b"edts")
                out += raw(target, e) if e else b""
            elif t in (b"vmap", b"cdsc", b"cdep"):
                n = (s - h) // 4
                out += box(t, struct.pack(f">{n}I", *([main_id] * n)))
            elif t == b"tkhd":
                b = bytearray(template[p:p + s])
                v = b[h]
                tk = child(target, mp_ + mh_, mp_ + ms_, b"tkhd")
                mv = target[tk[0] + tk[2]]
                id_off = h + 4 + (16 if v == 1 else 8)
                mdur_off = tk[2] + 4 + (16 if mv == 1 else 8) + 8
                main_dur = int.from_bytes(target[tk[0] + mdur_off:tk[0] + mdur_off + (8 if mv == 1 else 4)], "big")
                b[id_off:id_off + 4] = new_id.to_bytes(4, "big")
                b[id_off + 8:id_off + 8 + (8 if v == 1 else 4)] = main_dur.to_bytes(8 if v == 1 else 4, "big")
                out += bytes(b)
            elif t == b"mdhd":
                out += raw(target, path(target, mp_ + mh_, mp_ + ms_, [b"mdia", b"mdhd"]))
            elif t == b"stsd" and hvcc is not None:
                entry = p + h + 8
                size = struct.unpack(">I", template[entry:entry + 4])[0]
                head = template[entry + 4:entry + 86]
                extras = b"".join(hvcc if t2 == b"hvcC" else template[q:q + s2]
                                  for q, s2, _, t2 in boxes(template, entry + 86, entry + size))
                out += box(b"stsd", full(0, 0), struct.pack(">I", 1),
                           struct.pack(">I", 4 + len(head) + len(extras)) + head + extras)
            elif t == b"stts":
                out += stts_box(deltas)
            elif t == b"stss":
                out += stss
            elif t == b"stsc":
                out += box(b"stsc", full(0, 0), struct.pack(">IIII", 1, 1, len(sample_list), 1))
            elif t == b"stsz":
                out += box(b"stsz", full(0, 0), struct.pack(">II", 0, len(sample_list)),
                           struct.pack(f">{len(sample_list)}I", *map(len, sample_list)))
            elif t in (b"stco", b"co64"):
                out += box(b"stco", full(0, 0), struct.pack(">II", 1, PLACEHOLDER + new_id))
            elif t in (b"sdtp", b"ctts", b"sgpd", b"sbgp", b"cslg"):
                continue
            else:
                out += template[p:p + s]
        return out

    tp, ts, th = ttrack
    return box(b"trak", rebuild(tp + th, tp + ts))


def qt_meta_items(data, meta):
    """(key, raw item box) pairs of a QuickTime mdta meta box."""
    p, s, h = meta
    keys, items = [], []
    for q, s2, h2, t in boxes(data, p + h, p + s):
        if t == b"keys":
            n = struct.unpack(">I", data[q + h2 + 4:q + h2 + 8])[0]
            r = q + h2 + 8
            for _ in range(n):
                ks = struct.unpack(">I", data[r:r + 4])[0]
                keys.append(data[r:r + ks])
                r += ks
        elif t == b"ilst":
            for q2, s3, h3, t2 in boxes(data, q + h2, q + s2):
                items.append((struct.unpack(">I", t2)[0], data[q2 + h3:q2 + s3]))
    return keys, items


def merged_meta(target, tmeta, template, nmeta,
                prefix=(b"com.apple.quicktime.smartstyle.", b"com.apple.quicktime.texturestyle.")):
    keys, items = qt_meta_items(target, tmeta)
    nkeys, nitems = qt_meta_items(template, nmeta)
    have = {k[8:] for k in keys}
    for idx, body in nitems:
        k = nkeys[idx - 1]
        if k[8:].startswith(prefix) and k[8:] not in have:
            keys.append(k)
            items.append((len(keys), body))
    p, s, h = tmeta
    parts = []
    for q, s2, h2, t in boxes(target, p + h, p + s):
        if t == b"keys":
            parts.append(box(b"keys", full(0, 0), struct.pack(">I", len(keys)), *keys))
        elif t == b"ilst":
            parts.append(box(b"ilst", *(struct.pack(">II", 8 + len(b), i) + b for i, b in items)))
        else:
            parts.append(target[q:q + s2])
    return box(b"meta", *parts)


def main(target_path, template_path, out_path):
    target = Path(target_path).read_bytes()
    template = Path(template_path).read_bytes()
    assert [t for _, _, _, t in boxes(target, 0, len(target))][-1] == b"moov"
    (mp, ms, mh), ttracks = tracks(target)
    main_video = next(t for t in ttracks if handler(target, t) == b"vide")
    main_tabs = stbl_tables(target, main_video)
    deltas = stts_entries(target, main_tabs)
    frames = len(deltas)
    (nmp, nms, nmh), ntracks = tracks(template)

    def native(tag):
        return next(t for t in ntracks if tag in raw(template, t))

    mvhd = child(target, mp + mh, mp + ms, b"mvhd")
    next_id = struct.unpack(">I", target[mvhd[0] + mvhd[1] - 4:mvhd[0] + mvhd[1]])[0]
    new_traks, payloads = [], {}

    def add(tag, sample_list, track_deltas, hvcc=None, stss=b""):
        nonlocal next_id
        new_traks.append(clone_track(template, native(tag), target, main_video, next_id,
                                     sample_list, track_deltas, hvcc, stss))
        payloads[next_id] = b"".join(sample_list)
        next_id += 1

    # Linear thumbnail: every frame.
    ss, hvcc, stss = encode(target_path, "scale=128:96:flags=area", "yuv420p10le",
                            "bframes=0:keyint=30:min-keyint=1:log-level=error", frames)
    add(b"video-map.smart-style-linear-thumbnail", ss, deltas, hvcc, stss)

    # Empty mattes: every 2nd frame, each sample spanning two main frames.
    pair_deltas = [sum(deltas[i:i + 2]) for i in range(0, frames, 2)]
    black = ["-f", "lavfi", "-i", f"color=c=black:s=256x192:r=30:d={len(pair_deltas) / 30:.4f}",
             "-frames:v", str(len(pair_deltas))]
    ms_, mhvcc, mstss = encode(black, "format=gray", "gray",
                               "bframes=0:keyint=30:min-keyint=1:log-level=error", len(pair_deltas))
    for tag in (b"video-map.sky", b"video-map.person", b"video-map.skin"):
        add(tag, ms_, pair_deltas, mhvcc, mstss)

    # smartstyle-info: the template's per-frame samples, spread over the target's frames.
    info = native(b"com.apple.quicktime.smartstyle-info")
    nss = samples(template, info)
    add(b"com.apple.quicktime.smartstyle-info",
        [nss[min(len(nss) - 1, i * len(nss) // frames)] for i in range(frames)], deltas)

    # texturestyle-info (iPhone 18 templates, iOS 27 Texture & Grain): spread the same way.
    texture_info = b"com.apple.quicktime.texturestyle-info"
    if any(texture_info in raw(template, t) for t in ntracks):
        tss = samples(template, native(texture_info))
        add(texture_info, [tss[min(len(tss) - 1, i * len(tss) // frames)] for i in range(frames)], deltas)
    metadata_tracks = 2 if any(texture_info in raw(template, t) for t in ntracks) else 1

    # New moov: auxv tracks after the main video, the metadata tracks last, smartstyle and
    # texturestyle keys merged into moov/meta, next_track_ID bumped.
    parts = []
    nmeta = child(template, nmp + nmh, nmp + nms, b"meta")
    for p, s, h, t in boxes(target, mp + mh, mp + ms):
        chunk = target[p:p + s]
        if t == b"mvhd":
            chunk = chunk[:-4] + next_id.to_bytes(4, "big")
        elif t == b"meta" and nmeta:
            chunk = merged_meta(target, (p, s, h), template, nmeta)
        parts.append(chunk)
        if (p, s, h) == main_video:
            parts += new_traks[:-metadata_tracks]
    parts += new_traks[-metadata_tracks:]
    moov = box(b"moov", *parts)
    head = target[:mp]
    cursor = len(head) + len(moov) + 8
    blob = b""
    for tid, payload in payloads.items():
        marker = struct.pack(">I", PLACEHOLDER + tid)
        assert moov.count(marker) == 1, tid
        moov = moov.replace(marker, struct.pack(">I", cursor + len(blob)))
        blob += payload
    Path(out_path).write_bytes(head + moov + box(b"mdat", blob))
    print(f"added {len(new_traks)} tracks, {len(blob)} bytes of samples -> {out_path}")


if __name__ == "__main__":
    main(*sys.argv[1:4])
