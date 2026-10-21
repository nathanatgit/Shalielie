"""Container regressions use synthetic bytes; no personal photo fixtures are published."""
import importlib.util
import struct
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import photographic_style_port as p


def fixture(clean_width=144, denominator=1, horizontal=0, trailing=False):
    def u(*values):
        return struct.pack(">" + "I" * len(values), *values)

    def track(kind, offset, sizes):
        description = b""
        if kind == b"vide":
            clap = p._mov_box(b"clap", struct.pack(">IIIIiIiI", clean_width, denominator, 112, 1, horizontal, 1, 0, 1))
            hvcc = p._mov_box(b"hvcC", b"old")
            entry = bytearray(86)
            entry[:8] = u(86 + len(clap) + len(hvcc)) + b"hvc1"
            entry[32:36] = struct.pack(">HH", 160, 128)
            description = bytes(entry) + clap + hvcc
        stbl = p._mov_box(b"stbl",
            p._mov_box(b"stsd", bytes(4), u(1), description),
            p._mov_box(b"stts", bytes(4), u(1, len(sizes), 100)),
            p._mov_box(b"stsc", bytes(4), u(1, 1, len(sizes), 1)),
            p._mov_box(b"stsz", bytes(4), u(0, len(sizes), *sizes)),
            p._mov_box(b"stco", bytes(4), u(1, offset)))
        return p._mov_box(b"trak", p._mov_box(b"mdia",
            p._mov_box(b"hdlr", bytes(8), kind), p._mov_box(b"minf", stbl)))
    return (p._mov_box(b"mdat", b"abcxyz")
            + p._mov_box(b"moov", track(b"vide", 8, [1, 2]), track(b"soun", 11, [3]))
            + (p._mov_box(b"mdat", b"z") if trailing else b""))


class ApertureTests(unittest.TestCase):
    def test_signed_offset(self):
        self.assertEqual(p.live_video_aperture(fixture(horizontal=-4)), (160,128,144,112,-4,0))

    def test_rejects_invalid_crop(self):
        for data in [fixture(denominator=0), fixture(horizontal=30)]:
            with self.assertRaises(p.PortError):
                p.live_video_aperture(data)

    def test_explicit_crop_does_not_depend_on_ffmpeg_clap_support(self):
        original = fixture(horizontal=-4)

        def encode(inputs, vf, pixel_format, frames):
            source = Path(inputs[inputs.index("-i") + 1]).read_bytes()
            self.assertEqual(p.live_video_aperture(source), (160,128,160,128,0,0))
            self.assertEqual(vf, "crop=w=144:h=112:x=4:y=8:exact=1,scale=160:128:flags=lanczos")
            return [b"new", b"video"], p._mov_box(b"hvcC", b"new"), b""

        with patch.object(p, "_encode_live_track", side_effect=encode):
            p.normalize_live_video_aperture(Path("unused.MOV"), original)

    def test_normalization_keeps_audio_and_timing_even_with_trailing_media(self):
        for trailing in [False, True]:
            original = fixture(trailing=trailing)
            samples = [b"new", b"video"]
            with patch.object(p, "_encode_live_track", return_value=(samples, p._mov_box(b"hvcC",b"new"), b"")):
                normalized, changed = p.normalize_live_video_aperture(Path("unused.MOV"), original)
            self.assertTrue(changed)
            self.assertEqual(p.live_video_aperture(normalized), (160,128,160,128,0,0))
            old = p._mov_tracks(original)[1]
            new = p._mov_tracks(normalized)[1]
            self.assertEqual(p._mov_samples(original,old[1]),p._mov_samples(normalized,new[1]))
            self.assertEqual(p._mov_samples(normalized,new[0]),samples)
            self.assertEqual(p._mov_stts(original,p._mov_stbl(original,old[0])),
                             p._mov_stts(normalized,p._mov_stbl(normalized,new[0])))
            self.assertEqual(list(p._mov_boxes(normalized,0,len(normalized)))[-1][3],b"moov")
            with patch.object(p, "_encode_live_track", side_effect=AssertionError("must not re-encode twice")):
                self.assertEqual(p.normalize_live_video_aperture(Path("unused"), normalized),(normalized,False))


class MultipartTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        spec = importlib.util.spec_from_file_location("shortcut_server",Path(__file__).resolve().parents[1]/"shortcut-server/server.py")
        cls.server = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.server)

    def body(self, fields):
        return b"".join(b'--test-boundary\r\nContent-Disposition: form-data; name="'+name+b'"; filename="'+filename+b'"\r\n\r\n'+data+b'\r\n'
                        for name,filename,data in fields)+b'--test-boundary--\r\n'

    def test_live_pair_is_not_silently_reduced_to_first_file(self):
        fields=self.server.parse_live_multipart(self.body([(b"photo",b"original.HEIC",b"photo\x00"),(b"video",b"original.MOV",b"video\x00")]),
                                                 'multipart/form-data; boundary="test-boundary"')
        self.assertEqual(fields["video"],(b"video\x00","original.MOV"))
        self.assertEqual(fields["photo"][0],b"photo\x00")

    def test_missing_or_duplicate_fields_rejected(self):
        for fields in [[(b"photo",b"a.HEIC",b"a")],[(b"photo",b"a.HEIC",b"a"),(b"photo",b"b.HEIC",b"b"),(b"video",b"a.MOV",b"v")]]:
            with self.assertRaises(ValueError):
                self.server.parse_live_multipart(self.body(fields),'multipart/form-data; boundary=test-boundary')


if __name__ == "__main__":
    unittest.main()
