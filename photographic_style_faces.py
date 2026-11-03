"""Find Faces for the command line: faces, a skin matte and a person matte for a picture that
has none (a JPEG, a screenshot), so Soft Skin has what it reads.

The detection is PR #4's (photographic_style_vision.py, MediaPipe on the device). This module
only locates the pre-fetched models and turns its result into the people record the porter
already writes for a photo that carries Apple's own data. Experimental: the data is
estimated, not the camera's.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

MODEL_FILES = ("face_landmarker.task", "selfie_multiclass_256x256.tflite")


def model_dir(explicit=None) -> Path:
    """The folder holding the pre-fetched models: --model-dir, $PSP_MODEL_DIR, the models
    packed next to a release binary, then ./models beside the script or the working folder."""
    places = [explicit, os.environ.get("PSP_MODEL_DIR")]
    bundle = getattr(sys, "_MEIPASS", None)
    if bundle:
        places.append(Path(bundle) / "models")
    places += [Path(__file__).resolve().parent / "models", Path.cwd() / "models"]
    for place in places:
        if place and all((Path(place) / name).is_file() for name in MODEL_FILES):
            return Path(place)
    return Path(explicit or places[-2])


def estimate_people(port, decoded, work, irot, mirror, explicit_model_dir=None):
    """(people, note): `people` is the dict `soft_skin_people` returns, or None; `note` says
    why not."""
    from photographic_style_vision import generate_mattes

    try:
        found = generate_mattes(decoded, work, model_dir(explicit_model_dir), irot, mirror,
                                False, port=port)
    except ImportError:
        return None, "needs mediapipe: pip install mediapipe"
    except Exception as error:  # a model that will not load, a decode failure
        return None, f"{type(error).__name__}: {error}"
    overrides = found.get("overrides", {})
    keys = port.SOFT_SKIN_INSTANCE_KEYS
    entries = list(found.get("texturePeopleData", []))[:len(keys)]
    instances = overrides.get(port.URI_PERSON_INSTANCES, {}).get("instances", [])[:len(keys)]
    if found.get("state") != "generated" or not entries or len(instances) < len(entries):
        return None, "no face found"

    def source(matte):
        return {"payload": matte["payload"], "ispe": port._ispe_box(matte["width"], matte["height"]),
                "pixi": matte["pixi"], "hvcC": matte["hvcc"]}

    mattes = {uri: source(overrides[uri]) for uri in port.MATTE_2026_URIS
              if isinstance(overrides.get(uri), dict) and "payload" in overrides[uri]}
    person = mattes.get(port.SOFT_SKIN_PERSON_URI)
    if person is None or not any(uri in mattes for uri in port.SOFT_SKIN_SKIN_URIS):
        return None, "the matte set came back incomplete"
    for index, entry in enumerate(entries):
        entry["instanceMaskReferenceKey"] = keys[index]
    return ({"faces": len(entries), "entries": entries, "mattes": mattes,
             "instances": [(keys[i], source(instances[i])) for i in range(len(entries))]},
            "")
