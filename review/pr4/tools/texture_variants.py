#!/usr/bin/env python3
"""Derive ablation donor profiles from an iOS 27 (iPhone 18) donor profile.

iOS 27 files that offer Texture/Grain in the Photographic Style editor differ from
iOS 18/26 style files in four places. Each variant below knocks out or rewrites one of
them, so one on-device round shows which one Photos keys on:

  full      unmodified iOS 27 profile (texture_styles item, styles v16, 13-key 0x54)
  hw15      texture_styles HardwareModel -> iPhone16,1 (iPhone 15 Pro)
  notex     texture_styles item disabled by renaming its URI (same length, so no
            offsets move and the item graph is otherwise identical)
  oldgen    keep texture_styles, but downgrade styles to v14 (drop k/l) and MakerNote
            0x54 to the 8-key iOS 18 form

    python tools/texture_variants.py PROFILE.zip OUTDIR
"""
import argparse
import json
import plistlib
import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import photographic_style_port as p  # noqa: E402

TEXTURE_URI = b"tag:apple.com,2026:photo:metadata:texture_styles"
DISABLED_URI = b"tag:apple.com,2026:photo:metadata:texture_stylez"
# MakerNote 0x54 from an iOS 18.2 iPhone 16 Pro Max style capture (Smartstyle/IMG_5096).
OLD_54 = {"0": 1, "1": 0.0, "2": 0.0, "3": 1.0, "4": 1, "5": 1, "6": 4, "7": 0}


def _read(zpath):
    with zipfile.ZipFile(zpath) as z:
        return {n: z.read(n) for n in z.namelist()}


def _write(files, zpath):
    with zipfile.ZipFile(zpath, "w", compression=zipfile.ZIP_DEFLATED) as z:
        for n, b in files.items():
            z.writestr(n, b)


def _texture_iid(files):
    manifest = json.loads(files["manifest.json"])
    for iid in manifest["retained_external_items"]:
        blob = files[f"payloads/{iid}.bin"]
        if blob.startswith(b"bplist"):
            try:
                if "FilmGrainSeed" in plistlib.loads(blob):
                    return iid
            except Exception:
                pass
    raise p.PortError("profile has no texture_styles payload (not an iOS 27 donor?)")


def _bplist(obj):
    return plistlib.dumps(obj, fmt=plistlib.FMT_BINARY, sort_keys=False)


def variants(files):
    manifest = json.loads(files["manifest.json"])
    tex = f"payloads/{_texture_iid(files)}.bin"
    styles = f"payloads/{manifest['donor_styles_item']}.bin"
    if files["meta.bin"].count(TEXTURE_URI) != 1:
        raise p.PortError("expected exactly one texture_styles URI in meta.bin")

    yield "full", dict(files)

    v = dict(files)
    t = plistlib.loads(v[tex])
    t["HardwareModel"] = "iPhone16,1"
    v[tex] = _bplist(t)
    yield "hw15", v

    v = dict(files)
    v["meta.bin"] = v["meta.bin"].replace(TEXTURE_URI, DISABLED_URI)
    yield "notex", v

    v = dict(files)
    st = plistlib.loads(v[styles])
    st["0"] = 14
    st.pop("k", None)
    st.pop("l", None)
    v[styles] = _bplist(st)
    v["makernote_0x54.bin"] = _bplist(OLD_54)
    yield "oldgen", v


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("profile", type=Path)
    ap.add_argument("outdir", type=Path)
    a = ap.parse_args()
    a.outdir.mkdir(parents=True, exist_ok=True)
    for name, files in variants(_read(a.profile)):
        out = a.outdir / f"{a.profile.stem}_{name}.zip"
        _write(files, out)
        print(out)


if __name__ == "__main__":
    main()
