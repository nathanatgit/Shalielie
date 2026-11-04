#!/usr/bin/env python3
"""Fetch what the web build needs for Any Image and Find Faces, so it runs with no CDN.

    python tools/build_web_assets.py          # into web/vendor/ and web/models/

* web/models/: the two Google MediaPipe models, pinned and hash-checked by tools/models.json
  (the same files the command line and the iOS app bundle).
* web/vendor/mediapipe/: @mediapipe/tasks-vision (ES module and WASM runtime), pinned to one
  npm release and checked against its published SHA-512.

Both folders are generated, not committed. The Pages workflow runs this before it publishes.
Standard library only.
"""

from __future__ import annotations

import base64
import hashlib
import io
import sys
import tarfile
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fetch_models  # noqa: E402

VERSION = "0.10.22-rc.20250304"
TARBALL = f"https://registry.npmjs.org/@mediapipe/tasks-vision/-/tasks-vision-{VERSION}.tgz"
INTEGRITY = "sha512-dElxVXMFGthshfIj+qAVm8KE2jmNo2p8oXFib8WzEjb7GNaX/ClWBc8UJfoSZwjEMVrdHJ4YUfa7P3ifl6MIWw=="
WANTED = ("package/vision_bundle.mjs", "package/LICENSE")
WASM_PREFIX = "package/wasm/"

root = Path(__file__).resolve().parent.parent


def vendor(destination: Path) -> None:
    marker = destination / ".version"
    if marker.is_file() and marker.read_text().strip() == VERSION:
        return
    print(f"fetching @mediapipe/tasks-vision {VERSION}", file=sys.stderr)
    with urllib.request.urlopen(TARBALL, timeout=120) as response:
        blob = response.read()
    digest = "sha512-" + base64.b64encode(hashlib.sha512(blob).digest()).decode()
    if digest != INTEGRITY:
        raise SystemExit("@mediapipe/tasks-vision tarball does not match the pinned integrity hash")
    destination.mkdir(parents=True, exist_ok=True)
    with tarfile.open(fileobj=io.BytesIO(blob), mode="r:gz") as archive:
        for member in archive.getmembers():
            if not member.isfile() or not (member.name in WANTED or member.name.startswith(WASM_PREFIX)):
                continue
            target = destination / member.name[len("package/"):]
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(archive.extractfile(member).read())
    marker.write_text(VERSION + "\n")


def main() -> int:
    fetch_models.fetch(root / "web" / "models")
    vendor(root / "web" / "vendor" / "mediapipe")
    print("web assets ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
