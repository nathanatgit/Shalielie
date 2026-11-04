"""CLI/Web parity regressions; personal fixtures and cached models are optional.

Run: python -m unittest discover -s tests -p test_cli_sync.py -v
"""

import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from argparse import Namespace

import numpy as np
from PIL import Image

import photographic_style_port as p
from photographic_style_pipeline import Converter, linear_i420_10
from photographic_style_vision import APPLE_LANDMARK_INDICES, stored_point

ROOT = Path(__file__).resolve().parents[1]
CONVERTER = Converter(p)


def aux(data, uri):
    d = p.discover_heic(data)
    iid = next(
        (i for i in d["infos"] if p.aux_uri_for_item(d["props"], i) == uri), None
    )
    return d, iid


class SyncTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.work = Path(self.temporary.name)
        self.addCleanup(self.temporary.cleanup)

    def cli(self, source, *flags):
        output = self.work / "out.HEIC"
        command = [
            os.sys.executable,
            str(ROOT / "photographic_style_port.py"),
            "patch",
            str(source),
            str(output),
            "--report",
            *flags,
        ]
        run = subprocess.run(command, cwd=ROOT, capture_output=True, text=True)
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        return output.read_bytes(), json.loads(
            output.with_suffix(".HEIC.report.json").read_text()
        )

    def preserved(self, before, after):
        b, a = p.discover_heic(before), p.discover_heic(after)
        pairs = [
            (b["primary"], a["primary"]),
            *zip(b["primary_tiles"], a["primary_tiles"]),
        ]
        if b["hdr_grid"] is not None:
            pairs += [
                (b["hdr_grid"], a["hdr_grid"]),
                *zip(b["hdr_tiles"], a["hdr_tiles"]),
            ]
        self.assertEqual(len(b["primary_tiles"]), len(a["primary_tiles"]))
        for source, target in pairs:
            self.assertEqual(
                p.extract_item(before, b["iloc"], source),
                p.extract_item(after, a["iloc"], target),
            )
            self.assertEqual(
                CONVERTER.render_properties(before, b, source),
                CONVERTER.render_properties(after, a, target),
            )

    @unittest.skipUnless(
        shutil.which("ffmpeg") and shutil.which("heif-convert"),
        "external codecs unavailable",
    )
    def test_graph_graft_and_native_upgrade(self):
        cases = [
            ("tests/private-fixtures/grid-42-no-hdr.heic", 42, 0),
            ("tests/private-fixtures/grid-40-no-hdr.heic", 40, 0),
            ("tests/private-fixtures/grid-36-no-hdr.heic", 36, 0),
            ("tests/private-fixtures/grid-42-hdr-15.heic", 42, 15),
            ("tests/private-fixtures/direct-hdr.heic", 48, 0),
            ("tests/private-fixtures/native-style.heic", 45, 15),
        ]
        available = [case for case in cases if (ROOT / case[0]).exists()]
        if not available:
            self.skipTest("personal HEIC fixtures unavailable")
        for name, tiles, hdr in available:
            with self.subTest(photo=name):
                source = ROOT / name
                result, report = self.cli(
                    source,
                    "--faces",
                    "off",
                    "--portrait-matte",
                    "off",
                    "--linear-thumb",
                    "reuse-thumbnail",
                    "--scene-stats",
                    "donor",
                )
                self.preserved(source.read_bytes(), result)
                d = p.discover_heic(result)
                self.assertEqual(len(d["primary_tiles"]), tiles)
                self.assertEqual(len(d["hdr_tiles"]), hdr)
                self.assertIsNotNone(d["styles_item"])
                if p.discover_heic(source.read_bytes())["hdr_grid"] is None:
                    self.assertEqual(report["target_hdr_mode"], "synthetic-direct")
                    self.assertIsNone(
                        aux(result, p.MATTE_URIS["portraiteffectsmatte"])[1]
                    )
                if name.endswith("direct-hdr.heic"):
                    self.assertEqual(
                        report["portraitMatte"]["mode"], "native-preserved"
                    )
                    b, bi = aux(
                        source.read_bytes(), p.MATTE_URIS["portraiteffectsmatte"]
                    )
                    a, ai = aux(result, p.MATTE_URIS["portraiteffectsmatte"])
                    self.assertEqual(
                        CONVERTER.render_properties(source.read_bytes(), b, bi),
                        CONVERTER.render_properties(result, a, ai),
                    )

    def test_legacy_skin_priority_and_separate_native_v2(self):
        source = ROOT / "tests/private-fixtures/direct-hdr.heic"
        if not source.exists():
            self.skipTest("skin fixture unavailable")
        data = source.read_bytes()
        d = p.discover_heic(data)
        v2 = p.MATTE_2026_URIS[1]
        overrides = CONVERTER.skin_overrides(data, d, {v2: dict(payload=b"generated")})
        self.assertIn("source", overrides[v2])
        legacy = overrides[p.MATTE_URIS["semanticskinmatte"]]
        self.assertEqual(legacy["item"], overrides[v2]["item"])
        source = ROOT / "tests/private-fixtures/native-skin-both.heic"
        if source.exists():
            data = source.read_bytes()
            d = p.discover_heic(data)
            overrides = CONVERTER.skin_overrides(data, d)
            self.assertNotEqual(
                overrides[v2]["item"],
                overrides[p.MATTE_URIS["semanticskinmatte"]]["item"],
            )

    def test_inference_failure_is_reported_without_fake_portrait(self):
        args = Namespace(faces="auto", portrait_matte="auto", model_dir=self.work)
        with patch(
            "photographic_style_vision.generate_mattes",
            side_effect=RuntimeError("model unavailable"),
        ):
            result = CONVERTER.infer(self.work / "input.png", self.work, args)
        self.assertEqual(result["state"], "unavailable")
        self.assertEqual(result["overrides"], {})
        self.assertEqual(result["error"], "model unavailable")

    def test_linear_samples_are_linear_not_gamma_codes(self):
        source = self.work / "gray.png"
        Image.new("RGB", (2, 2), (128, 128, 128)).save(source)
        samples = np.frombuffer(linear_i420_10(source, 2, 2), dtype="<u2")
        expected = 64 + 876 * ((128 / 255 + 0.055) / 1.055) ** 2.4
        self.assertLess(abs(float(samples[0]) - expected), 1)
        self.assertLess(samples[0], 300)
        self.assertTrue(np.all(np.abs(samples[4:].astype(float) - 512) < 1))

    def test_pixel_orientation_matches_web_geometry(self):
        rgba = np.zeros((4, 6, 3), dtype="uint8")
        rgba[0, 0] = 255
        source = self.work / "orientation.png"
        Image.fromarray(rgba).save(source)
        for angle in [0, 90, 180, 270]:
            for mirror in [None, 0, 1]:
                w, h = (4, 6) if angle in (90, 270) else (6, 4)
                y = np.frombuffer(
                    linear_i420_10(source, w, h, angle, mirror), dtype="<u2"
                )[: w * h].reshape(h, w)
                position = stored_point(0.5 / 6, 0.5 / 4, angle, mirror)
                self.assertEqual(
                    np.unravel_index(y.argmax(), y.shape),
                    (int(position["y"] * h), int(position["x"] * w)),
                )

    @unittest.skipUnless(shutil.which("ffmpeg"), "encoder unavailable")
    def test_raster_formats_and_real_main10_bitstream(self):
        for extension in ["png", "jpg", "webp"]:
            with self.subTest(format=extension):
                source = self.work / f"input.{extension}"
                exif = Image.Exif()
                exif[0x112] = 6
                exif[0x10F] = "CLI test camera"
                exif[0x132] = "2026:10:04 12:00:00"
                Image.new("RGB", (80, 120), (180, 80, 30)).save(source, exif=exif)
                result, report = self.cli(
                    source,
                    "--faces",
                    "off",
                    "--portrait-matte",
                    "off",
                    "--scene-stats",
                    "donor",
                )
                d = p.discover_heic(result)
                self.assertTrue(report["compatibility_reencoded"])
                self.assertEqual(len(d["primary_tiles"]), 1)
                self.assertEqual(report["linearthumb_bit_depth"], 10)
                lt = next(
                    i
                    for i in d["infos"]
                    if p.aux_uri_for_item(d["props"], i) == p.URI_LINEAR_THUMB
                )
                hvcc = p.property_box_bytes(result, d["props"], lt, "hvcC")[8:]
                self.assertEqual(hvcc[1] & 31, 2)
                self.assertEqual(hvcc[17] & 7, 2)
                self.assertEqual(hvcc[18] & 7, 2)
                self.assertEqual(
                    p.property_box_bytes(result, d["props"], lt, "colr")[8:],
                    b"nclx\0\x0c\0\x08\0\x01\0",
                )
                original = p.extract_item(result, d["iloc"], d["exif_item"])
                parsed = Image.Exif()
                parsed.load(
                    b"Exif\0\0" + original[4 + int.from_bytes(original[:4], "big") :]
                )
                self.assertEqual(parsed[0x10F], "CLI test camera")
                self.assertEqual(parsed[0x132], "2026:10:04 12:00:00")
                mp4 = self.work / "linearthumb.mp4"
                image = self.work / "linear.png"
                Image.new("RGB", (16, 16), (128, 128, 128)).save(image)
                p.encode_target_linear_thumbnail(image, self.work, 16, 16)
                probe = subprocess.run(
                    [
                        shutil.which("ffmpeg"),
                        "-hide_banner",
                        "-i",
                        str(mp4),
                        "-f",
                        "null",
                        "-",
                    ],
                    capture_output=True,
                    text=True,
                    check=True,
                )
                self.assertIn("yuv420p10le", probe.stderr)
                self.assertIn("bt709/smpte432/linear", probe.stderr)

    def test_web_geometry_and_landmark_contract(self):
        if not shutil.which("node"):
            self.skipTest("Node unavailable")
        script = "import {displayPointToStored} from './web/src/heif.js';import {APPLE_LANDMARK_INDICES} from './web/src/face-mattes.js';console.log(JSON.stringify({indices:APPLE_LANDMARK_INDICES,points:[0,90,180,270].flatMap(a=>[null,0,1].map(m=>displayPointToStored(.23,.67,a,m)))}));"
        run = subprocess.run(
            ["node", "--input-type=module", "-e", script],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=True,
        )
        web = json.loads(run.stdout)
        self.assertEqual(web["indices"], APPLE_LANDMARK_INDICES)
        self.assertEqual(
            web["points"],
            [
                stored_point(0.23, 0.67, a, m)
                for a in [0, 90, 180, 270]
                for m in [None, 0, 1]
            ],
        )

    @unittest.skipUnless(
        (ROOT / "tests/.cache/cli-sync/models/face_landmarker.task").exists()
        and (ROOT / "tests/private-fixtures/people.jpg").exists(),
        "cached models or face fixture unavailable",
    )
    def test_local_people_generation(self):
        result, report = self.cli(
            ROOT / "tests/private-fixtures/people.jpg",
            "--model-dir",
            str(ROOT / "tests/.cache/cli-sync/models"),
            "--scene-stats",
            "donor",
        )
        self.assertEqual(report["faces"]["state"], "generated")
        self.assertGreaterEqual(report["faces"]["count"], 1)
        for uri in p.MATTE_2026_URIS:
            self.assertIsNotNone(aux(result, uri)[1])
        d = p.discover_heic(result)
        iid = next(
            i
            for i, info in d["infos"].items()
            if info.get("uri") == p.URI_TEXTURE_STYLES
        )
        people = plistlib.loads(p.extract_item(result, d["iloc"], iid))[
            "TextureStylePostProcessedPeopleData"
        ]
        self.assertEqual(len(people), report["faces"]["count"])
        self.assertEqual(len(people[0]["faceLandmarks"]), 76)
        self.assertIsNotNone(aux(result, p.URI_PERSON_INSTANCES)[1])
        self.assertEqual(report["portraitMatte"]["mode"], "target-person-segmentation")


if __name__ == "__main__":
    unittest.main()
