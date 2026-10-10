"""P5: the native video with its smartstyle-info track rebuilt the way mov_style_tracks.py
builds it (per-sample stsz, one chunk in a second mdat after moov)."""
import struct
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from mov_linear_thumb import boxes, box, child, handler, raw, samples, stbl_tables, track_id, tracks  # noqa: E402
from mov_style_tracks import PLACEHOLDER, clone_track, stts_entries  # noqa: E402

src, out = sys.argv[1], sys.argv[2]
data = Path(src).read_bytes()
(mp, ms, mh), ts = tracks(data)
main_video = next(t for t in ts if handler(data, t) == b"vide")
info = next(t for t in ts if b"com.apple.quicktime.smartstyle-info" in raw(data, t))
info_id = track_id(data, info)
deltas = stts_entries(data, stbl_tables(data, info))
rebuilt = clone_track(data, info, data, main_video, info_id, samples(data, info), deltas)

parts = []
for p, s, h, t in boxes(data, mp + mh, mp + ms):
    parts.append(rebuilt if (p, s, h) == info else data[p:p + s])
moov = box(b"moov", *parts)
head = data[:mp]
payload = b"".join(samples(data, info))
marker = struct.pack(">I", PLACEHOLDER + info_id)
assert moov.count(marker) == 1
moov = moov.replace(marker, struct.pack(">I", len(head) + len(moov) + 8))
assert [t for _, _, _, t in boxes(data, 0, len(data))][-1] == b"moov"
Path(out).write_bytes(head + moov + box(b"mdat", payload))
print("rebuilt track", info_id, "->", out)
