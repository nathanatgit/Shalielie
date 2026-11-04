"""Optional local MediaPipe inference shared by Python and packaged CLI builds.

No image is uploaded. The two Google model files are fetched once into model_dir.
Geometry, confidence roles, 76-point ordering and pose calibration follow web/src/face-mattes.js.
"""

from __future__ import annotations

import math
from pathlib import Path
import io
import urllib.request

FACE_MODEL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task"
SEGMENT_MODEL = "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/1/selfie_multiclass_256x256.tflite"
FACE_OVAL = [
    10,
    338,
    297,
    332,
    284,
    251,
    389,
    356,
    454,
    323,
    361,
    288,
    397,
    365,
    379,
    378,
    400,
    377,
    152,
    148,
    176,
    149,
    150,
    136,
    172,
    58,
    132,
    93,
    234,
    127,
    162,
    21,
    54,
    103,
    67,
    109,
]
FACE_HOLES = [
    [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246],
    [362, 382, 381, 380, 374, 373, 390, 249, 263, 466, 388, 387, 386, 385, 384, 398],
    [
        61,
        146,
        91,
        181,
        84,
        17,
        314,
        405,
        321,
        375,
        291,
        409,
        270,
        269,
        267,
        0,
        37,
        39,
        40,
        185,
    ],
    [70, 63, 105, 66, 107, 55, 65, 52, 53, 46],
    [336, 296, 334, 293, 300, 285, 295, 282, 283, 276],
]
LIPS_INNER = [
    13,
    312,
    311,
    310,
    415,
    308,
    324,
    318,
    402,
    317,
    14,
    87,
    178,
    88,
    95,
    78,
    191,
    80,
    81,
    82,
]
NOSE = [168, 193, 122, 196, 3, 51, 45, 4, 275, 281, 248, 419, 351, 417]
APPLE_LANDMARK_INDICES = [
    33,
    133,
    144,
    153,
    160,
    158,
    468,
    263,
    362,
    373,
    380,
    387,
    385,
    473,
    46,
    52,
    55,
    107,
    105,
    70,
    276,
    282,
    285,
    336,
    334,
    300,
    61,
    185,
    40,
    39,
    0,
    269,
    270,
    409,
    291,
    375,
    405,
    17,
    181,
    146,
    13,
    14,
    82,
    312,
    87,
    317,
    168,
    6,
    197,
    1,
    327,
    326,
    2,
    97,
    98,
    279,
    49,
    294,
    64,
    454,
    323,
    361,
    288,
    397,
    365,
    379,
    400,
    152,
    176,
    150,
    136,
    172,
    58,
    132,
    93,
    234,
]
POSE_CALIBRATION = {
    "yaw": (1.0212823540623739, 0.06557276028923575),
    "pitch": (0.7245256071153161, 0.08162727013457771),
    "roll": (1.0395766734487242, -0.028472053112188738),
}


def stored_point(x, y, angle=0, mirror=None):
    x, y = {90: (1 - y, x), 180: (1 - x, 1 - y), 270: (y, 1 - x)}.get(angle, (x, y))
    return {"x": 1 - x if mirror == 0 else x, "y": 1 - y if mirror == 1 else y}


def bounds(landmarks, indices=FACE_OVAL):
    points = [landmarks[i] for i in indices if i < len(landmarks)]
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    return dict(x=min(xs), y=min(ys), width=max(xs) - min(xs), height=max(ys) - min(ys))


def pose_from_matrix(matrix):
    import numpy as np

    m = np.asarray(matrix).reshape(4, 4)
    scale = float(np.linalg.norm(m[:3, 0]))
    if scale < 1e-8:
        return dict(yaw=0.0, pitch=0.0, roll=0.0)
    m = m / scale
    yaw = math.asin(max(-1, min(1, -float(m[2, 0]))))
    raw = dict(
        yaw=yaw,
        pitch=math.atan2(-m[1, 2], m[1, 1])
        if abs(math.cos(yaw)) < 1e-6
        else math.atan2(m[2, 1], m[2, 2]),
        roll=0.0 if abs(math.cos(yaw)) < 1e-6 else math.atan2(m[1, 0], m[0, 0]),
    )
    return {
        k: v * POSE_CALIBRATION[k][0] + POSE_CALIBRATION[k][1] for k, v in raw.items()
    }


def _model(url, directory):
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / url.rsplit("/", 1)[1]
    if not path.exists():
        temporary = path.with_suffix(path.suffix + ".download")
        try:
            with (
                urllib.request.urlopen(url, timeout=30) as response,
                temporary.open("wb") as output,
            ):
                while block := response.read(1024 * 1024):
                    output.write(block)
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)
    return path


def _detections(landmarker, image, mp):
    import numpy as np
    from PIL import Image

    size = image.size
    candidates = []
    for rect in [
        (0, 0, 1, 1),
        (0, 0, 0.62, 0.62),
        (0.38, 0, 0.62, 0.62),
        (0, 0.38, 0.62, 0.62),
        (0.38, 0.38, 0.62, 0.62),
    ]:
        x, y, w, h = rect
        crop = image.crop(
            (
                round(x * size[0]),
                round(y * size[1]),
                round((x + w) * size[0]),
                round((y + h) * size[1]),
            )
        )
        scale = min(1.8, 1024 / max(crop.size)) if w < 1 else 1
        crop = crop.resize(
            (round(crop.width * scale), round(crop.height * scale)),
            Image.Resampling.LANCZOS,
        )
        result = landmarker.detect(
            mp.Image(image_format=mp.ImageFormat.SRGB, data=np.asarray(crop))
        )
        for i, points in enumerate(result.face_landmarks):
            face = [(x + p.x * w, y + p.y * h, p.z * w) for p in points]
            r = bounds(face)
            if any(
                math.hypot(
                    r["x"] + r["width"] / 2 - b["x"] - b["width"] / 2,
                    r["y"] + r["height"] / 2 - b["y"] - b["height"] / 2,
                )
                < max(
                    0.015,
                    (
                        math.hypot(r["width"], r["height"])
                        + math.hypot(b["width"], b["height"])
                    )
                    / 2,
                )
                * 0.38
                for _, b, _ in candidates
            ):
                continue
            candidates.append(
                (face, r, pose_from_matrix(result.facial_transformation_matrixes[i]))
            )
    return sorted(candidates[:5], key=lambda c: c[1]["x"])


def _stats(rgb, mask):
    import numpy as np

    selected = rgb[np.asarray(mask) >= 128] / 255.0
    empty = np.zeros(0)
    if not len(selected):
        return dict(
            coverage=0.0,
            averageColor=[0.0, 0.0, 0.0],
            roughness=0.0,
            red=empty,
            green=empty,
            blue=empty,
            tone=empty,
            linear=empty,
        )
    tone = selected @ np.array([0.2126, 0.7152, 0.0722])
    linear = np.where(
        selected <= 0.04045, selected / 12.92, ((selected + 0.055) / 1.055) ** 2.4
    ) @ np.array([0.2126, 0.7152, 0.0722])
    return dict(
        coverage=len(selected) / (rgb.shape[0] * rgb.shape[1]),
        averageColor=selected.mean(axis=0).tolist(),
        roughness=float(tone.var()),
        red=np.sort(selected[:, 0]),
        green=np.sort(selected[:, 1]),
        blue=np.sort(selected[:, 2]),
        tone=np.sort(tone),
        linear=np.sort(linear),
    )


def _people_entry(face, stats, key, angle, mirror, pose):
    def rect(r):
        pts = [
            stored_point(x, y, angle, mirror)
            for x, y in [
                (r["x"], r["y"]),
                (r["x"] + r["width"], r["y"]),
                (r["x"], r["y"] + r["height"]),
                (r["x"] + r["width"], r["y"] + r["height"]),
            ]
        ]
        xs = [p["x"] for p in pts]
        ys = [p["y"] for p in pts]
        return dict(
            x=min(xs), y=min(ys), width=max(xs) - min(xs), height=max(ys) - min(ys)
        )

    def clip(r):
        x = max(0, r["x"])
        y = max(0, r["y"])
        return dict(
            x=x,
            y=y,
            width=max(0, min(1, r["x"] + r["width"]) - x),
            height=max(0, min(1, r["y"] + r["height"]) - y),
        )

    skin = bounds(face)
    inner = bounds(face, FACE_HOLES[0] + FACE_HOLES[1] + FACE_HOLES[2])
    sw = min(1, 0.129 / max(skin["width"], 0.001))
    sh = min(1, 0.17 / max(skin["height"], 0.001))
    points = []
    for i in APPLE_LANDMARK_INDICES:
        if i < len(face):
            p = face[i]
        else:
            indices = (
                [33, 133, 144, 153, 160, 158]
                if i == 468
                else [263, 362, 373, 380, 387, 385]
            )
            p = tuple(sum(face[j][k] for j in indices) / len(indices) for k in range(3))
        points.append(dict(point=stored_point(p[0], p[1], angle, mirror), error=0.02))
    colour = stats["averageColor"]
    rough = stats["roughness"]
    return dict(
        faceSkinROI=rect(clip(skin)),
        faceID=0,
        faceYaw=pose["yaw"],
        faceROI=rect(clip(inner)),
        faceLandmarkType=1,
        faceUnitOfAngle=1,
        instanceROI=rect(
            clip(
                dict(
                    x=skin["x"] - skin["width"] * 0.32,
                    y=skin["y"] - skin["height"] * 0.12,
                    width=skin["width"] * 1.64,
                    height=skin["height"] * 1.42,
                )
            )
        ),
        instanceMaskReferenceKey=key,
        faceROIAndLandmarksROIRelativeScalingROI=rect(
            dict(x=(1 - sw) / 2, y=(1 - sh) / 2, width=sw, height=sh)
        ),
        facePitch=pose["pitch"],
        faceRoll=pose["roll"],
        faceLandmarks=points,
        imageStats=dict(
            Mattify=dict(
                SkipPerson=False,
                HighlightsToMaskRatio=0,
                faceID=0,
                AverageFaceColor=colour,
            ),
            SkinSmoothingStandalone=dict(
                faceID=0,
                SkinSmoothAverageFaceColour=colour,
                SkinSmoothSkipPerson=False,
                SkinSmoothFaceRoughness=rough,
            ),
            UnderEyeBrightening=dict(
                faceID=0,
                RightEyeIsBiModal=False,
                LeftEyeLumaVariance=rough,
                LeftEyeIsBiModal=False,
                LeftEyeAverageColor=colour,
                RightEyeAverageColor=colour,
                RightEyeLumaVariance=rough,
            ),
        ),
    )


def generate_mattes(
    decoded, work, model_dir, angle=0, mirror=None, portrait_only=False, port=None
):
    import numpy as np
    import mediapipe as mp
    from PIL import Image, ImageDraw, ImageFilter, ImageCms
    from mediapipe.tasks import python
    from mediapipe.tasks.python import vision

    if port is None:
        import photographic_style_port as port
    image = Image.open(decoded).convert("RGB")
    if image.info.get("icc_profile"):
        image = ImageCms.profileToProfile(
            image,
            ImageCms.ImageCmsProfile(io.BytesIO(image.info["icc_profile"])),
            ImageCms.createProfile("sRGB"),
            outputMode="RGB",
        )
    analysis = image.copy()
    analysis.thumbnail((1024, 1024), Image.Resampling.LANCZOS)
    base = python.BaseOptions
    with vision.ImageSegmenter.create_from_options(
        vision.ImageSegmenterOptions(
            base_options=base(model_asset_path=str(_model(SEGMENT_MODEL, model_dir))),
            running_mode=vision.RunningMode.IMAGE,
            output_confidence_masks=True,
            output_category_mask=False,
        )
    ) as segmenter:
        segmentation = segmenter.segment(
            mp.Image(image_format=mp.ImageFormat.SRGB, data=np.asarray(analysis))
        )
        masks = [
            m.numpy_view().copy().reshape(m.height, m.width)
            for m in segmentation.confidence_masks
        ]
    if len(masks) != 6:
        raise RuntimeError("SelfieMulticlass must return six confidence planes")
    candidates = []
    if not portrait_only:
        with vision.FaceLandmarker.create_from_options(
            vision.FaceLandmarkerOptions(
                base_options=base(model_asset_path=str(_model(FACE_MODEL, model_dir))),
                running_mode=vision.RunningMode.IMAGE,
                num_faces=5,
                min_face_detection_confidence=0.35,
                min_face_presence_confidence=0.35,
                output_facial_transformation_matrixes=True,
            )
        ) as landmarker:
            candidates = _detections(landmarker, analysis, mp)
    scale = min(1, 768 / max(image.size))
    size = tuple(max(2, int(math.floor(n * scale / 2 + 0.5)) * 2) for n in image.size)

    def confidence(values):
        return Image.fromarray(
            np.clip(np.floor(values * 255 + 0.5), 0, 255).astype("uint8")
        ).resize(size, Image.Resampling.LANCZOS)

    skin = confidence(np.minimum(1, masks[2] + masks[3]))
    face_skin = confidence(masks[3])
    body = confidence(masks[2])
    person = confidence(1 - masks[0])
    accessories = confidence(masks[5])
    faces = [c[0] for c in candidates]

    def contour(indices, holes=(), blur=1.5):
        result = Image.new("L", size)
        draw = ImageDraw.Draw(result)
        for face in faces:
            draw.polygon(
                [(face[i][0] * size[0], face[i][1] * size[1]) for i in indices],
                fill=255,
            )
            for hole in holes:
                draw.polygon(
                    [(face[i][0] * size[0], face[i][1] * size[1]) for i in hole], fill=0
                )
        return result.filter(ImageFilter.GaussianBlur(blur)) if blur else result

    def encode(mask, name):
        path = Path(work) / (name + ".png")
        mask.save(path)
        width, height = size[::-1] if angle in (90, 270) else size
        hvcc, payload, _ = port.encode_hevc_still(
            path, Path(work), width, height, angle, mirror, name=name
        )
        return dict(
            payload=payload,
            hvcc=hvcc,
            pixi=port.MATTE_2026_PIXI,
            width=width,
            height=height,
        )

    portrait = encode(person, "portrait")
    overrides = {port.MATTE_URIS["portraiteffectsmatte"]: portrait}
    if portrait_only or not faces:
        return dict(
            state="skipped" if portrait_only else "none", faces=0, overrides=overrides
        )
    eye_region = Image.new("L", size)
    ears = Image.new("L", size)
    hands = body.copy()
    ed = ImageDraw.Draw(eye_region)
    ear_draw = ImageDraw.Draw(ears)
    hd = ImageDraw.Draw(hands)
    for face in faces:
        r = bounds(face, FACE_HOLES[0] + FACE_HOLES[1])
        ed.rectangle(
            (
                (r["x"] - 0.15 * r["width"]) * size[0],
                (r["y"] - 1.1 * r["height"]) * size[1],
                (r["x"] + 1.15 * r["width"]) * size[0],
                (r["y"] + 2.1 * r["height"]) * size[1],
            ),
            fill=255,
        )
        r = bounds(face)
        cy = (r["y"] + 0.51 * r["height"]) * size[1]
        for cx in [r["x"] - 0.018 * r["width"], r["x"] + 1.018 * r["width"]]:
            ear_draw.ellipse(
                (
                    (cx - 0.075 * r["width"]) * size[0],
                    cy - 0.19 * r["height"] * size[1],
                    (cx + 0.075 * r["width"]) * size[0],
                    cy + 0.19 * r["height"] * size[1],
                ),
                fill=255,
            )
        cx = r["x"] + r["width"] / 2
        cy = r["y"] + 0.9 * r["height"]
        hd.ellipse(
            (
                (cx - 0.82 * r["width"]) * size[0],
                (cy - 1.15 * r["height"]) * size[1],
                (cx + 0.82 * r["width"]) * size[0],
                (cy + 1.15 * r["height"]) * size[1],
            ),
            fill=0,
        )
    rgb = np.asarray(image.resize(size, Image.Resampling.LANCZOS)).astype(float)
    bright = rgb.mean(axis=2) / 255
    white = np.clip((bright - 0.42) / 0.32, 0, 1) * np.clip(
        1 - (rgb.max(axis=2) - rgb.min(axis=2)) / 80, 0, 1
    )
    teeth = Image.fromarray(
        np.floor(np.asarray(contour(LIPS_INNER, blur=0)) * white + 0.5).astype("uint8")
    ).filter(ImageFilter.GaussianBlur(1))
    glasses = Image.fromarray(
        np.floor(
            np.asarray(accessories).astype(float) * np.asarray(eye_region) / 255 + 0.5
        ).astype("uint8")
    ).filter(ImageFilter.GaussianBlur(1.25))
    eyebrows = Image.fromarray(
        np.maximum(
            np.asarray(contour(FACE_HOLES[3], blur=0)),
            np.asarray(contour(FACE_HOLES[4], blur=0)),
        )
    ).filter(ImageFilter.GaussianBlur(1.25))
    semantic = dict(
        semanticnosematte=contour(NOSE),
        semanticskinmattev2=skin,
        semanticnonfaceskinmatte=body,
        semanticlipsmatte=contour(FACE_HOLES[2], [LIPS_INNER], 1.25),
        semanticteethmattev2=teeth,
        semanticpersonmatte=person,
        semanticglassesmattev2=glasses,
        semanticeyebrowsmatte=eyebrows,
        semantictattoomatte=Image.new("L", size),
        semantichandsmatte=hands.filter(ImageFilter.GaussianBlur(1.5)),
        semanticearsmatte=ears.filter(ImageFilter.GaussianBlur(1.75)),
        semanticfaceskinmatte=face_skin,
    )
    for uri in port.MATTE_2026_URIS:
        name = uri.rsplit(":", 1)[1]
        overrides[uri] = (
            portrait if name == "semanticpersonmatte" else encode(semantic[name], name)
        )
    yy, xx = np.mgrid[: size[1], : size[0]]
    scores = []
    for face in faces:
        r = bounds(face)
        scores.append(
            (
                ((xx + 0.5) / size[0] - r["x"] - r["width"] / 2) ** 2
                + ((yy + 0.5) / size[1] - r["y"] - r["height"] / 2) ** 2
            )
            / max(0.02, math.hypot(r["width"], r["height"])) ** 2
        )
    nearest = np.argmin(scores, axis=0)
    instances = []
    people = []
    for i, (face, _, pose) in enumerate(candidates):
        key = f"FSINCInstanceMask{9 + i}"
        instance = (
            portrait.copy()
            if len(faces) == 1
            else encode(
                Image.fromarray(
                    np.where(nearest == i, np.asarray(person), 0).astype("uint8")
                ),
                f"instance-{i}",
            )
        )
        instance["referenceKey"] = key
        instances.append(instance)
        stats = _stats(
            rgb,
            Image.fromarray(
                np.where(nearest == i, np.asarray(face_skin), 0).astype("uint8")
            ),
        )
        people.append(_people_entry(face, stats, key, angle, mirror, pose))
    overrides[port.URI_PERSON_INSTANCES] = dict(instances=instances)
    s = _stats(rgb, skin)
    p = _stats(rgb, person)
    fields = {
        "ToneMappedImageRedChannelSkinBased": s["red"],
        "ToneMappedImageGreenChannelSkinBased": s["green"],
        "ToneMappedImageBlueChannelSkinBased": s["blue"],
        "ToneMappedImageSkinBased": s["tone"],
        "LinearImageSkinBased": s["linear"],
        "ToneMappedImagePersonSegmentBased": p["tone"],
        "LinearImagePersonSegmentBased": p["linear"],
    }
    metadata = dict(
        peopleRatio=p["coverage"],
        skinRatio=s["coverage"],
        blocks={
            name: port._stats_block(values.tolist(), 1)
            for name, values in fields.items()
        },
    )
    return dict(
        state="generated",
        faces=len(faces),
        overrides=overrides,
        personMetadata=metadata,
        texturePeopleData=people,
    )
