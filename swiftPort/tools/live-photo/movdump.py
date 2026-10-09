"""Summarize a QuickTime/MOV file: tracks (handler, sample format, size), metadata keys."""
import struct
import sys

CONTAINERS = {b"moov", b"trak", b"mdia", b"minf", b"stbl", b"udta", b"edts", b"dinf", b"tref", b"gmhd"}


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
            break
        yield p, size, hdr, typ
        p += size


def find(data, start, end, path):
    for p, size, hdr, typ in boxes(data, start, end):
        if typ == path[0]:
            if len(path) == 1:
                yield p, size, hdr
            else:
                yield from find(data, p + hdr, p + size, path[1:])


def meta_keys(data, p, size, hdr):
    """mdta keys + values of a QuickTime 'meta' box (no version/flags in QT meta)."""
    out = []
    start = p + hdr
    keys = []
    for q, s, h, t in boxes(data, start, p + size):
        if t == b"keys":
            n = struct.unpack(">I", data[q + h + 4:q + h + 8])[0]
            r = q + h + 8
            for _ in range(n):
                ks = struct.unpack(">I", data[r:r + 4])[0]
                keys.append(data[r + 8:r + ks].decode("utf-8", "replace"))
                r += ks
    for q, s, h, t in boxes(data, start, p + size):
        if t == b"ilst":
            for q2, s2, h2, t2 in boxes(data, q + h, q + s):
                idx = struct.unpack(">I", t2)[0]
                val = b""
                for q3, s3, h3, t3 in boxes(data, q2 + h2, q2 + s2):
                    if t3 == b"data":
                        val = data[q3 + h3 + 8:q3 + s3]
                name = keys[idx - 1] if 0 < idx <= len(keys) else f"#{idx}"
                shown = val.decode("utf-8") if val and all(32 <= b < 127 for b in val[:64]) else f"<{len(val)} bytes>"
                out.append((name, shown[:90]))
    return out


def main(path):
    data = open(path, "rb").read()
    print("==", path.replace("\\", "/").split("/")[-1], len(data), "bytes")
    top = [(t.decode("latin1"), s) for _, s, _, t in boxes(data, 0, len(data))]
    print("top:", top)
    for mp, ms, mh in find(data, 0, len(data), [b"moov"]):
        for p, s, h in find(data, mp + mh, mp + ms, [b"meta"]):
            for k, v in meta_keys(data, p, s, h):
                print("  moov.meta", k, "=", v)
        for i, (tp, ts, th) in enumerate(find(data, mp + mh, mp + ms, [b"trak"])):
            hd = next(find(data, tp + th, tp + ts, [b"mdia", b"hdlr"]), None)
            handler = data[hd[0] + hd[2] + 8:hd[0] + hd[2] + 12].decode("latin1") if hd else "?"
            sd = next(find(data, tp + th, tp + ts, [b"mdia", b"minf", b"stbl", b"stsd"]), None)
            fmt = "?"
            if sd:
                entry = sd[0] + sd[2] + 8
                fmt = data[entry + 4:entry + 8].decode("latin1")
            tk = next(find(data, tp + th, tp + ts, [b"tkhd"]), None)
            dims = ""
            if tk:
                w, hgt = struct.unpack(">II", data[tk[0] + tk[1] - 8:tk[0] + tk[1]])
                dims = f"{w >> 16}x{hgt >> 16}"
            sz = next(find(data, tp + th, tp + ts, [b"mdia", b"minf", b"stbl", b"stsz"]), None)
            count = struct.unpack(">I", data[sz[0] + sz[2] + 8:sz[0] + sz[2] + 12])[0] if sz else "?"
            tref = [(t.decode("latin1")) for _, _, _, t in boxes(data, *(lambda r: (r[0] + r[2], r[0] + r[1]))(next(find(data, tp + th, tp + ts, [b"tref"]))))] if next(find(data, tp + th, tp + ts, [b"tref"]), None) else []
            print(f"  trak{i}: handler={handler} format={fmt} dims={dims} samples={count} tref={tref}")
            for p, s, h in find(data, tp + th, tp + ts, [b"meta"]):
                for k, v in meta_keys(data, p, s, h):
                    print(f"    trak{i}.meta", k, "=", v)
            # timed-metadata key declarations live in the mebx sample entry
            if fmt == "mebx" and sd:
                entry = sd[0] + sd[2] + 8
                esize = struct.unpack(">I", data[entry:entry + 4])[0]
                blob = data[entry:entry + esize]
                import re
                for m in re.findall(rb"(?:com\.apple|mdta)[\x20-\x7e]{4,80}", blob):
                    print(f"    trak{i}.mebx key", m.decode())


for f in sys.argv[1:]:
    main(f)
