#!/usr/bin/env python3
"""Dump the Photographic Style-relevant structure of HEIC files as JSON, for diffing.

Investigation aid for new-generation style features (e.g. iOS 27 Texture/Grain):
item graph with aux URNs, EXIF identity, the Apple MakerNote tag inventory and a
schema of the styles plist (key -> type/length, scalars inline). Reuses the parsers
in photographic_style_port.py.

    python tools/style_dump.py 18series/*.HEIC Smartstyle/IMG_5096.HEIC --out dump/
"""
import argparse
import hashlib
import json
import plistlib
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import photographic_style_port as p  # noqa: E402

EXIF_IDENTITY = {0x010F: "Make", 0x0110: "Model", 0x0131: "Software",
                 0x9003: "DateTimeOriginal", 0xA434: "LensModel"}


def _ifd_entries(tiff, off, endian):
    n = p._tiff_u(tiff, off, 2, endian)
    for i in range(n):
        e = off + 2 + i * 12
        yield (p._tiff_u(tiff, e, 2, endian), p._tiff_u(tiff, e + 2, 2, endian),
               p._tiff_u(tiff, e + 4, 4, endian), e)


def _ascii(tiff, typ, cnt, e, endian):
    if typ != 2:
        return None
    raw = tiff[e + 8:e + 8 + cnt] if cnt <= 4 else tiff[p._tiff_u(tiff, e + 8, 4, endian):][:cnt]
    return bytes(raw).split(b"\0")[0].decode("utf-8", "replace")


def exif_identity(exif_payload):
    tiff_rel = int.from_bytes(exif_payload[:4], "big")
    tiff = exif_payload[4 + tiff_rel:]
    endian = "big" if tiff[:2] == b"MM" else "little"
    out, exif_ifd = {}, None
    for tag, typ, cnt, e in _ifd_entries(tiff, p._tiff_u(tiff, 4, 4, endian), endian):
        if tag in EXIF_IDENTITY:
            out[EXIF_IDENTITY[tag]] = _ascii(tiff, typ, cnt, e, endian)
        if tag == 0x8769:
            exif_ifd = p._tiff_u(tiff, e + 8, 4, endian)
    if exif_ifd is not None:
        for tag, typ, cnt, e in _ifd_entries(tiff, exif_ifd, endian):
            if tag in EXIF_IDENTITY:
                out[EXIF_IDENTITY[tag]] = _ascii(tiff, typ, cnt, e, endian)
    return out


def makernote_inventory(exif_payload):
    mn = p._get_makernote_blob(exif_payload)
    endian = "big" if mn[12:14] == b"MM" else "little"
    tags = {}
    for i in range(p._tiff_u(mn, 14, 2, endian)):
        e = 16 + i * 12
        tag, typ, cnt = (p._tiff_u(mn, e, 2, endian), p._tiff_u(mn, e + 2, 2, endian),
                         p._tiff_u(mn, e + 4, 4, endian))
        total = p.TIFF_TYPE_SIZES.get(typ, 1) * cnt
        raw = mn[e + 8:e + 8 + total] if total <= 4 else \
            mn[p._tiff_u(mn, e + 8, 4, endian):][:total]
        entry = {"type": typ, "count": cnt, "sha256_12": hashlib.sha256(raw).hexdigest()[:12]}
        if typ in (3, 4, 8, 9) and total <= 16:
            unit = p.TIFF_TYPE_SIZES[typ]
            entry["value"] = [int.from_bytes(raw[k:k + unit], endian, signed=typ in (8, 9))
                              for k in range(0, total, unit)]
        elif typ in (5, 10) and cnt == 1:
            num = int.from_bytes(raw[:4], endian, signed=typ == 10)
            den = int.from_bytes(raw[4:8], endian, signed=typ == 10)
            entry["value"] = num / den if den else None
        elif typ == 2:
            entry["value"] = bytes(raw).split(b"\0")[0].decode("utf-8", "replace")
        elif raw[:6] == b"bplist":
            try:
                entry["bplist"] = _schema(plistlib.loads(bytes(raw)))
            except Exception as ex:  # keep going; the tag list is the point
                entry["bplist_error"] = str(ex)
        tags[f"0x{tag:04x}"] = entry
    return tags


def _schema(v):
    if isinstance(v, dict):
        return {str(k): _schema(x) for k, x in v.items()}
    if isinstance(v, list):
        return [_schema(x) for x in v[:8]] + ([f"... {len(v)} items"] if len(v) > 8 else [])
    if isinstance(v, (bytes, bytearray)):
        return f"<data {len(v)}B sha {hashlib.sha256(v).hexdigest()[:12]}>"
    return v


def dump(path: Path):
    data = path.read_bytes()
    d = p.discover_heic(data) if True else None
    infos, props, iloc = d["infos"], d["props"], d["iloc"]
    items = {}
    for iid, info in sorted(infos.items()):
        rec = {"type": info.get("type")}
        for k in ("uri", "content_type", "name"):
            if info.get(k):
                rec[k] = info[k]
        uri = p.aux_uri_for_item(props, iid)
        if uri:
            rec["auxC"] = uri
        try:
            rec["bytes"] = len(p.extract_item(data, iloc, iid))
        except Exception:
            pass
        items[iid] = rec
    # Collapse tiles: report grids and non-hvc1 items fully, count hvc1 tiles per parent.
    tile_ids = set(d["primary_tiles"]) | set(d["hdr_tiles"]) | set(d["delta_tiles"])
    for r in d["refs"]:
        if r["type"] == "dimg":
            tile_ids |= set(r["to"])
    out = {
        "file": path.name,
        "sha256": hashlib.sha256(data).hexdigest(),
        "ftyp": p.top_box(data, "ftyp") and data[8:32].hex(),
        "primary": d["primary"],
        "items": {k: v for k, v in items.items() if k not in tile_ids},
        "tile_count": len(tile_ids),
        "refs": [r for r in d["refs"] if r["type"] != "dimg"] +
                [{"type": "dimg", "from": r["from"], "n_to": len(r["to"])}
                 for r in d["refs"] if r["type"] == "dimg"],
        "aux_uris": sorted({v["auxC"] for v in items.values() if "auxC" in v}),
    }
    if d["exif_item"] is not None:
        exif = p.extract_item(data, iloc, d["exif_item"])
        out["exif"] = exif_identity(exif)
        try:
            out["makernote"] = makernote_inventory(exif)
        except p.PortError as ex:
            out["makernote_error"] = str(ex)
    if d["styles_item"] is not None:
        out["styles"] = _schema(plistlib.loads(p.extract_item(data, iloc, d["styles_item"])))
    # Any other uri/mime metadata items (possible new-generation style payloads).
    extra = {}
    for iid, info in infos.items():
        if info.get("type") in ("uri ", "mime") and iid != d["styles_item"] and iid != d["exif_item"]:
            blob = p.extract_item(data, iloc, iid)
            key = f"{iid}:{info.get('uri') or info.get('content_type')}"
            try:
                extra[key] = _schema(plistlib.loads(blob))
            except Exception:
                extra[key] = f"<{len(blob)}B head={blob[:48]!r}>"
    if extra:
        out["other_metadata_items"] = extra
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("files", nargs="+", type=Path)
    ap.add_argument("--out", type=Path, help="write one <name>.json per input here")
    a = ap.parse_args()
    for f in a.files:
        try:
            res = dump(f)
        except Exception as ex:
            res = {"file": f.name, "error": f"{type(ex).__name__}: {ex}"}
        text = json.dumps(res, indent=1, ensure_ascii=False, default=str)
        if a.out:
            a.out.mkdir(parents=True, exist_ok=True)
            (a.out / f"{f.stem}.json").write_text(text, encoding="utf-8")
            print(f"{f} -> {a.out / (f.stem + '.json')}")
        else:
            print(text)


if __name__ == "__main__":
    main()
