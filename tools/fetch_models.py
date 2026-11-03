#!/usr/bin/env python3
"""Fetch the two Google MediaPipe models Find Faces uses, once, into a folder.

The same download as PR #4 made at run time, done in advance and checked against pinned sizes
and SHA-256 hashes (tools/models.json), so a run, a CI build and a release all use the exact
same files. Nothing is uploaded; the images never leave the machine.

    python tools/fetch_models.py [DIR]      # default: ./models
    python tools/fetch_models.py --check [DIR]

Standard library only.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import urllib.request
from pathlib import Path

MANIFEST = Path(__file__).with_name("models.json")


def load_manifest() -> list[dict]:
    return json.loads(MANIFEST.read_text(encoding="utf-8"))["models"]


def verify(path: Path, entry: dict) -> bool:
    if not path.is_file() or path.stat().st_size != entry["size"]:
        return False
    return hashlib.sha256(path.read_bytes()).hexdigest() == entry["sha256"]


def fetch(directory: Path, quiet: bool = False) -> list[Path]:
    """Download whichever models are missing or wrong; returns their paths."""
    directory.mkdir(parents=True, exist_ok=True)
    paths = []
    for entry in load_manifest():
        path = directory / entry["file"]
        if not verify(path, entry):
            temporary = path.with_suffix(path.suffix + ".download")
            if not quiet:
                print(f"fetching {entry['file']} ({entry['size'] / 1e6:.1f} MB)", file=sys.stderr)
            try:
                with urllib.request.urlopen(entry["url"], timeout=60) as response, \
                        temporary.open("wb") as output:
                    while block := response.read(1024 * 1024):
                        output.write(block)
                if not verify(temporary, entry):
                    raise SystemExit(f"{entry['file']}: downloaded file does not match models.json")
                temporary.replace(path)
            finally:
                temporary.unlink(missing_ok=True)
        paths.append(path)
    return paths


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("directory", nargs="?", default="models")
    parser.add_argument("--check", action="store_true", help="verify only, download nothing")
    args = parser.parse_args()
    directory = Path(args.directory)
    if args.check:
        bad = [e["file"] for e in load_manifest() if not verify(directory / e["file"], e)]
        print("models ok" if not bad else "missing or wrong: " + ", ".join(bad))
        return 1 if bad else 0
    for path in fetch(directory):
        print(path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
