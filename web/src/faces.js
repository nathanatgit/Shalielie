// Find Faces for the web build: faces, a skin matte and a person matte for a picture that has
// none (a JPEG, a screenshot), so Soft Skin has what it reads. The detection is PR #4's
// (face-mattes.js, MediaPipe in the browser, with the models served from this site); this
// module turns its result into the same people record the other builds write, as
// estimate_people does in photographic_style_faces.py. Experimental: the data is estimated,
// not the camera's.

import { BplistReal } from "./bplist.js";
import { ispeBox } from "./heif.js";
import { generateRasterFaceMattes } from "./face-mattes.js";
import {
  MATTE_2026_URIS, URI_PERSON_INSTANCES, SOFT_SKIN_INSTANCE_KEYS, SOFT_SKIN_SKIN_URIS,
  SOFT_SKIN_PERSON_URI,
} from "./texture.js";

// The only whole numbers in a people entry; every other number is a real in Apple's plist.
const INTEGER_KEYS = new Set(["faceID", "faceLandmarkType", "faceUnitOfAngle"]);

function typed(value, key = "") {
  if (value instanceof Map) return new Map([...value].map(([k, v]) => [k, typed(v, k)]));
  if (Array.isArray(value)) return value.map((v) => typed(v, key));
  if (typeof value === "number" && !INTEGER_KEYS.has(key)) return new BplistReal(value);
  return value;
}

/**
 * @param image  a drawable (ImageBitmap, canvas) of the upright picture
 * @returns {{people: object|null, why: string}} people has the shape softSkinPeople() returns
 */
export async function estimatePeople(image, onProgress = () => {}) {
  let found;
  try {
    found = await generateRasterFaceMattes(image, 0, null, { onProgress });
  } catch (error) {
    return { people: null, why: (error && error.message) || String(error) };
  }
  const keys = SOFT_SKIN_INSTANCE_KEYS;
  const entries = (found.texturePeopleData || []).slice(0, keys.length);
  const instances = (found.overrides?.get(URI_PERSON_INSTANCES)?.instances || []).slice(0, keys.length);
  if (found.state !== "generated" || !entries.length || instances.length < entries.length)
    return { people: null, why: "no face found" };

  const source = (matte) => ({
    payload: matte.payload, ispe: ispeBox(matte.width, matte.height), pixi: matte.pixi, hvcC: matte.hvcc,
  });
  const mattes = new Map();
  for (const uri of MATTE_2026_URIS) {
    const matte = found.overrides.get(uri);
    if (matte && matte.payload) mattes.set(uri, source(matte));
  }
  if (!mattes.has(SOFT_SKIN_PERSON_URI) || !SOFT_SKIN_SKIN_URIS.some((u) => mattes.has(u)))
    return { people: null, why: "the matte set came back incomplete" };
  entries.forEach((entry, i) => entry.set("instanceMaskReferenceKey", keys[i]));
  return {
    people: {
      faces: entries.length,
      entries: entries.map((entry) => typed(entry)),
      mattes,
      instances: entries.map((_, i) => [keys[i], source(instances[i])]),
    },
    why: "",
  };
}
