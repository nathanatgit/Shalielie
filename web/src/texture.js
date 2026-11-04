// iOS 27 Texture/Grain (质感/颗粒). Direct port of add_texture_items / add_texture_bytes in
// photographic_style_port.py (v0.5.0), with the same Apple bytes from iPhone 18 Pro IMG_0309.
//
// Photos offers the controls only when a style photo carries BOTH the texture_styles item
// AND iOS 27's twelve 2026 semantic mattes; the item without the mattes removes the whole
// style palette. For a scene with no people every matte is the same empty 768x576 frame.

import { topBox, metaChildren, findChild, be, concat } from "./box.js";
import {
  discoverHeic, parseIloc, parseIinf, parseIpcoIpma, extractItem, propertyForItem,
  auxUriForItem, findItemsByType, appendIpcoProperty, addItems, auxcBox,
  propertyBoxBytes, dimensionsForItem, irotAngleForItem, MATTE_URIS,
} from "./heif.js";
import { buildBplist, BplistReal } from "./bplist.js";

const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const hex = (s) => Uint8Array.from(s.match(/../g), (h) => parseInt(h, 16));
const utf8 = (s) => new TextEncoder().encode(s);

export const URI_TEXTURE_STYLES = "tag:apple.com,2026:photo:metadata:texture_styles";

// Binary plist: Preset Standard, CaptureType LF, CaptureMode Still, PortType PortTypeBack,
// HardwareModel iPhone19,2 (keep it - iPhone16,1 made white areas glow),
// TextureStylePeopleDataVersion 3, FilmGrainSeed 92.
export const TEXTURE_STYLES_BLOB = b64(
  "YnBsaXN0MDDXAQIDBAUGBwgJCgsMDQ5WUHJlc2V0W0NhcHR1cmVUeXBlW0NhcHR1cmVNb2RlWFBv"
  + "cnRUeXBlXUhhcmR3YXJlTW9kZWxfEB1UZXh0dXJlU3R5bGVQZW9wbGVEYXRhVmVyc2lvbl1GaWxt"
  + "R3JhaW5TZWVkWFN0YW5kYXJkUkxGVVN0aWxsXFBvcnRUeXBlQmFja1ppUGhvbmUxOSwyEAMQXAgX"
  + "Hio2P01te4SHjZqlpwAAAAAAAAEBAAAAAAAAAA8AAAAAAAAAAAAAAAAAAACp");

export const MATTE_2026_URIS = [
  "semanticnosematte", "semanticskinmattev2", "semanticnonfaceskinmatte",
  "semanticlipsmatte", "semanticteethmattev2", "semanticpersonmatte",
  "semanticglassesmattev2", "semanticeyebrowsmatte", "semantictattoomatte",
  "semantichandsmatte", "semanticearsmatte", "semanticfaceskinmatte",
].map((n) => `tag:apple.com,2026:photo:aux:${n}`);
const MATTE_ISPE = hex("0000001469737065000000000000030000000240");
const MATTE_PIXI = hex("0000000e70697869000000000108");
const MATTE_HVCC = hex(
  "0000006f68766343010408000000bfc8000000005af000fcfcf8f800000b03a00001001740010c01ffff04"
  + "0800000300bfc800000300005a170240a100010021420101040800000300bfc800000300005ac018080241"
  + "6205e49165537020202008a2000100094401c061d2421014c9");
const MATTE_EMPTY = b64(
  "AAAAmCgBrxJdSi5rFrhWizr/aWc5IydgU/X8AAADAAADAAADAAADARsKDFgAAAMAAAMAAAMAAAMAAAacAAAD"
  + "AAADAAADAAADAAADADygAAADAAADAAADAAADAANSAAADAAADAAADAAADAyoAAAMAAAMAAAMAAHTAAAADAAAD"
  + "AAADAAP8AAADAAADAAADAA6oAAADAAADAAADACgg");
const MATTE_XMP = utf8(
  '<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="XMP Core 6.0.0">\n'
  + '   <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n'
  + '      <rdf:Description rdf:about=""\n'
  + '            xmlns:fsincMattes="http://ns.apple.com/fsinc/1.0/">\n'
  + "         <fsincMattes:FSINCMatteVersion>0</fsincMattes:FSINCMatteVersion>\n"
  + "      </rdf:Description>\n"
  + "   </rdf:RDF>\n"
  + "</x:xmpmeta>\n");

// v0.6.1: an exactly empty 2016x1512 matte frame for every classic matte slot the photo does
// not fill; see CLASSIC_MATTE_EMPTY in photographic_style_port.py.
export const CLASSIC_MATTE_HVCC = hex(
  "0000007168766343010408000000bfc80000000096f000fcfcf8f800000b03a00001001740010c01ffff04"
  + "0800000300bfc8000003000096170240a100010023420101040800000300bfc8000003000096c00fc2005f"
  + "1f138817b91655370202020080a2000100094401c061d2c8405324");
export const CLASSIC_MATTE_EMPTY = b64(
  "AAADZSgBrwYF/nFq2rScpRjGD3ve5znOc5znOc5znOc5znOc5znQjAb//wjiUEbA65wTXPgAAAMAAAMAAAMA"
  + "AAMAAAMAb0Bhx0umN7O24AAAAwAAAwAAAwAAAwAAAwAYUC0JXlj6/gAAAwAAAwAAAwAAAwAAAwAAe8ANvF68"
  + "IAAAAwAAAwAAAwAAAwAAAwABlRArhYAAAAMAAAMAAAMAAAMAAAMAAdsOrgAAAwAAAwAAAwAAAwAAAwAAAwD+"
  + "gAAAAwAAAwAAAwAAAwAAAwAAAwAAQ8AAAAMAAAMAAAMAAAMAAAMAAAMACIgAAAMAAAMAAAMAAAMAAAMAAAMB"
  + "IQAAAwAAAwAAAwAAAwAAAwAAEJAAAAMAAAMAAAMAAAMAAAMAANSAAAADAAADAAADAAADAAADAAXUAAADAAAD"
  + "AAADAAADAAADACxgAAADAAADAAADAAADAAADAMSAAAADAAADAAADAAADAAADAzIAAAMAAAMAAAMAAAMAAAno"
  + "AAADAAADAAADAAADAAAcUAAAAwAAAwAAAwAAAwAAUsAAAAMAAAMAAAMAAAMAALuAAAADAAADAAADAAADAAFL"
  + "AAADAAADAAADAAADAAJuAAADAAADAAADAAADAAP6AAADAAADAAADAAADAAY8AAADAAADAAADAAADAAkYAAAD"
  + "AAADAAADAAADAAzIAAADAAADAAADAAADABFwAAADAAADAAADAAADABWwAAADAAADAAADAAADABoQAAADAAAD"
  + "AAADAAADAB3wAAADAAADAAADAAADACLgAAADAAADAAADAAADACbgAAADAAADAAADAAADAClgAAADAAADAAAD"
  + "AAADACxgAAADAAADAAADAAADAC4gAAADAAADAAADAAADAC7gAAADAAADAAADAAADAC7gAAADAAADAAADAAAD"
  + "ADAgAAADAAADAAADAAADADAgAAADAAADAAADAAADADAgAAADAAADAAADAAADADAgAAADAAADAAADAAADADAg"
  + "AAADAAADAAADAAADADAgAAADAAADAAADAAADADAgAAADAAADAAADAAADADAgAAADAAADAAADAAADADAgAAAD"
  + "AAADAAADAAADADAgAAADAAADAAADAAADADAgAAADAAADAAADAAADAAADAAADAAADAAADAAIm");

// CRC-32 (IEEE), equal to Python's zlib.crc32.
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** v0.6.1: per-photo FilmGrainSeed; see film_grain_seed in photographic_style_port.py. */
export function filmGrainSeed(data, d) {
  return crc32(extractItem(data, d.iloc, d.primaryTiles[0])) % 256;
}

// v0.6.0: Soft Skin. Port of soft_skin_people & co. in photographic_style_port.py; see the
// comment there. iOS 27 smooths skin per face from TextureStylePostProcessedPeopleData plus
// one semanticpersoninstances matte per face, and only when the skin v2 / face skin / person
// mattes are real. Everything comes from the photo: its face-region XMP, semanticskinmatte
// and portraiteffectsmatte. Values are rounded and typed exactly as the Python build writes
// them, so both produce the same bytes.
export const URI_PERSON_INSTANCES = "tag:apple.com,2026:photo:aux:semanticpersoninstances";
export const SOFT_SKIN_SKIN_URIS = ["semanticskinmattev2", "semanticfaceskinmatte"]
  .map((n) => `tag:apple.com,2026:photo:aux:${n}`);
export const SOFT_SKIN_PERSON_URI = "tag:apple.com,2026:photo:aux:semanticpersonmatte";
export const SOFT_SKIN_INSTANCE_KEYS = ["FSINCInstanceMask9",
  ...Array.from({ length: 9 }, (_, i) => `FSINCInstanceMask${i}`)];
const TEXTURE_STYLES_HEADER = [["Preset", "Standard"], ["CaptureType", "LF"],
  ["CaptureMode", "Still"], ["PortType", "PortTypeBack"], ["HardwareModel", "iPhone19,2"],
  ["TextureStylePeopleDataVersion", 3], ["FilmGrainSeed", 92]];
// Median face layout of 14 native iOS 27 Soft Skin faces; see SOFT_SKIN_LANDMARKS in Python.
const SOFT_SKIN_LANDMARKS = [
  -0.3411, -0.1971, -0.1456, -0.1813, -0.2857, -0.1842, -0.2046, -0.183, -0.2917, -0.2316,
  -0.2028, -0.2305, -0.2593, -0.2173, 0.3462, -0.216, 0.1382, -0.1951, 0.2886, -0.1967,
  0.2046, -0.1939, 0.2885, -0.2529, 0.1912, -0.2427, 0.2363, -0.2343, -0.4396, -0.3135,
  -0.2977, -0.3602, -0.1383, -0.3263, -0.1331, -0.3882, -0.3011, -0.4217, -0.4498, -0.3449,
  0.4441, -0.3325, 0.2915, -0.3779, 0.133, -0.3542, 0.1279, -0.4186, 0.2995, -0.4409, 0.4506,
  -0.366, -0.188, 0.3426, -0.1588, 0.2971, -0.1076, 0.2627, -0.0523, 0.2449, -0.0037, 0.253,
  0.045, 0.2402, 0.1087, 0.2598, 0.1666, 0.2991, 0.2101, 0.335, 0.1474, 0.3798, 0.0745,
  0.4022, -0.0015, 0.4111, -0.0758, 0.401, -0.1437, 0.3733, -0.0008, 0.3182, -0.0007, 0.3325,
  -0.0845, 0.3189, 0.0861, 0.3152, -0.0835, 0.3274, 0.0864, 0.3322, -0.0079, -0.2384, -0.0096,
  -0.1509, -0.0097, -0.0697, -0.0126, 0.0174, 0.1254, 0.1286, 0.0584, 0.1219, -0.0088, 0.1251,
  -0.0673, 0.1186, -0.1329, 0.1264, 0.1241, -0.0042, -0.1267, -0.0032, 0.1102, 0.054, -0.1153,
  0.0489, 0.6088, -0.1704, 0.6101, -0.0178, 0.6033, 0.1255, 0.5716, 0.2813, 0.5101, 0.4279,
  0.4194, 0.5368, 0.2905, 0.6203, 0.1554, 0.6812, -0.0025, 0.7043, -0.1426, 0.6773, -0.2791,
  0.6185, -0.384, 0.5307, -0.4829, 0.4244, -0.5531, 0.2924, -0.5871, 0.1388, -0.6052, -0.0192,
  -0.6, -0.1667];
const SOFT_SKIN_ROI_PER_XMP = [0.9682, 0.967];
const SOFT_SKIN_SKIN_ROI = 1.8;
const SOFT_SKIN_FACE_COLOR = [0.6843, 0.5275, 0.4353];
const SOFT_SKIN_SMOOTH_COLOR = [0.6651, 0.5179, 0.4315];
const SOFT_SKIN_ROUGHNESS = 0.0121;
const SOFT_SKIN_EYE_COLOR = [0.5776, 0.4579, 0.3829];
const SOFT_SKIN_EYE_VARIANCE = 0.0052;

const R = (v) => new BplistReal(v);
const r6 = (x) => Math.floor(x * 1e6 + 0.5) / 1e6;
const radians = (deg) => deg * (Math.PI / 180);
// Python's float % (floored), which JS % (truncated) is not.
const wrap = (deg) => { const a = deg + 180; return a - 360 * Math.floor(a / 360) - 180; };
const clamp = (c) => Math.min(1, Math.max(0, c));
const obj = (pairs) => new Map(pairs);

/** Face regions from the photo's MWG region XMP, in stored orientation. */
export function xmpFaceRegions(data, d) {
  for (const iid of [...d.infos.keys()].sort((a, b) => a - b)) {
    if (d.infos.get(iid).type !== "mime") continue;
    let xmp;
    try { xmp = new TextDecoder().decode(extractItem(data, d.iloc, iid)); } catch { continue; }
    if (!xmp.includes("mwg-rs:Regions")) continue;
    const faces = [];
    for (const [, li] of xmp.matchAll(/<rdf:li rdf:parseType="Resource">([\s\S]*?)<\/rdf:li>/g)) {
      if (!li.includes("<mwg-rs:Type>Face</mwg-rs:Type>")) continue;
      const area = {};
      let ok = true;
      for (const tag of ["x", "y", "w", "h"]) {
        const m = li.match(new RegExp(`<stArea:${tag}>([^<]+)</stArea:${tag}>`));
        if (!m) { ok = false; break; }
        area[tag] = parseFloat(m[1]);
      }
      if (!ok) continue;
      const angle = (tag) => {
        const m = li.match(new RegExp(`<apple-fi:${tag}>([^<]+)</apple-fi:${tag}>`));
        return m ? parseFloat(m[1]) : 0;
      };
      faces.push({ ...area, yaw: angle("AngleInfoYaw"), roll: angle("AngleInfoRoll") });
    }
    return faces;
  }
  return [];
}

function softSkinPeopleEntry(face, index, irot, width, height) {
  const box = (x, y, w, h) => {
    const x0 = clamp(x), y0 = clamp(y), x1 = clamp(x + w), y1 = clamp(y + h);
    return obj([["y", R(r6(y0))], ["x", R(r6(x0))], ["width", R(r6(x1 - x0))], ["height", R(r6(y1 - y0))]]);
  };
  const fw = face.w * SOFT_SKIN_ROI_PER_XMP[0], fh = face.h * SOFT_SKIN_ROI_PER_XMP[1];
  const scale = fw * width;
  const theta = radians(face.roll);
  const c = Math.cos(theta), s = Math.sin(theta);
  const marks = [];
  for (let k = 0; k < SOFT_SKIN_LANDMARKS.length; k += 2) {
    const u = SOFT_SKIN_LANDMARKS[k], v = SOFT_SKIN_LANDMARKS[k + 1];
    marks.push(obj([["point", obj([
      ["x", R(r6(clamp((face.x * width + (u * c - v * s) * scale) / width)))],
      ["y", R(r6(clamp((face.y * height + (u * s + v * c) * scale) / height)))],
    ])], ["error", R(0.02)]]));
  }
  const side = SOFT_SKIN_SKIN_ROI * scale;
  const reals = (a) => a.map(R);
  const full = () => obj([["y", R(0)], ["x", R(0)], ["width", R(1)], ["height", R(1)]]);
  return obj([
    ["faceSkinROI", box(face.x - side / 2 / width, face.y - side / 2 / height, side / width, side / height)],
    ["faceID", index],
    ["faceYaw", R(r6(radians(wrap(face.yaw))))],
    ["faceROI", box(face.x - fw / 2, face.y - fh / 2, fw, fh)],
    ["imageStats", obj([
      ["Mattify", obj([["SkipPerson", false], ["HighlightsToMaskRatio", R(0)], ["faceID", index],
        ["AverageFaceColor", reals(SOFT_SKIN_FACE_COLOR)]])],
      ["SkinSmoothingStandalone", obj([["faceID", index],
        ["SkinSmoothAverageFaceColour", reals(SOFT_SKIN_SMOOTH_COLOR)],
        ["SkinSmoothSkipPerson", false], ["SkinSmoothFaceRoughness", R(SOFT_SKIN_ROUGHNESS)]])],
      ["UnderEyeBrightening", obj([["faceID", index], ["RightEyeIsBiModal", false],
        ["LeftEyeLumaVariance", R(SOFT_SKIN_EYE_VARIANCE)], ["LeftEyeIsBiModal", false],
        ["LeftEyeAverageColor", reals(SOFT_SKIN_EYE_COLOR)],
        ["RightEyeAverageColor", reals(SOFT_SKIN_EYE_COLOR)],
        ["RightEyeLumaVariance", R(SOFT_SKIN_EYE_VARIANCE)]])],
    ])],
    ["faceLandmarkType", 1],
    ["faceUnitOfAngle", 1],
    ["instanceROI", full()],
    ["instanceMaskReferenceKey", SOFT_SKIN_INSTANCE_KEYS[index]],
    ["faceROIAndLandmarksROIRelativeScalingROI", full()],
    ["facePitch", R(0)],
    ["faceRoll", R(r6(-radians(wrap(face.roll - irot))))],
    ["faceLandmarks", marks],
  ]);
}

/**
 * Everything Soft Skin needs, taken from the photo, or null when the photo lacks any of it
 * (face regions, semanticskinmatte, portraiteffectsmatte). null keeps the v0.5 output.
 */
export function softSkinPeople(data, d) {
  const faces = xmpFaceRegions(data, d);
  if (!faces.length || faces.length > SOFT_SKIN_INSTANCE_KEYS.length) return null;
  const found = new Map();
  for (const iid of d.infos.keys()) {
    const uri = auxUriForItem(d.props, iid);
    if ((uri === MATTE_URIS.semanticskinmatte || uri === MATTE_URIS.portraiteffectsmatte)
        && !found.has(uri)) found.set(uri, iid);
  }
  const sources = new Map();
  for (const [uri, iid] of found) {
    const src = { payload: extractItem(data, d.iloc, iid) };
    for (const t of ["ispe", "pixi", "hvcC"]) {
      src[t] = propertyBoxBytes(data, d.props, iid, t);
      if (!src[t]) return null;
    }
    sources.set(uri, src);
  }
  const skin = sources.get(MATTE_URIS.semanticskinmatte);
  const person = sources.get(MATTE_URIS.portraiteffectsmatte);
  if (!skin || !person) return null;
  const [width, height] = dimensionsForItem(d.props, d.primary);
  const irot = irotAngleForItem(data, d.props, d.primary);
  return {
    faces: faces.length,
    entries: faces.map((f, i) => softSkinPeopleEntry(f, i, irot, width, height)),
    mattes: new Map([...SOFT_SKIN_SKIN_URIS.map((u) => [u, skin]), [SOFT_SKIN_PERSON_URI, person]]),
    instances: faces.map((_, i) => [SOFT_SKIN_INSTANCE_KEYS[i], person]),
  };
}

/** The texture_styles plist; see texture_styles_payload in photographic_style_port.py. */
export function textureStylesPayload(people = null, grainSeed = null) {
  if (people === null && grainSeed === null) return TEXTURE_STYLES_BLOB;
  const root = new Map();
  for (const [key, value] of TEXTURE_STYLES_HEADER) {
    root.set(key, key === "FilmGrainSeed" && grainSeed !== null ? grainSeed : value);
    if (key === "CaptureMode" && people !== null)
      root.set("TextureStylePostProcessedPeopleData", people.entries);
  }
  return buildBplist(root);
}

function softSkinInstanceXmp(key) {
  const xmp = new TextDecoder().decode(MATTE_XMP);
  const marker = "         <fsincMattes:FSINCMatteVersion>";
  return utf8(xmp.replace(marker,
    `         <fsincMattes:InstanceMaskReferenceKey>${key}</fsincMattes:InstanceMaskReferenceKey>\n`
    + marker));
}

export function hasTexture(infos) {
  return [...infos.values()].some((i) => i.uri === URI_TEXTURE_STYLES);
}

/**
 * Add every missing 2026 matte (with its XMP sidecar) and the texture_styles item; with
 * people (softSkinPeople), also what Soft Skin needs.
 * Returns [meta, Map(itemId -> payload), summary].
 */
export function addTextureItems(meta, primary, people = null, grainSeed = null) {
  const props0 = parseIpcoIpma(meta, topBox(meta, "meta"));
  if (props0.flags & 1) throw new Error("Wide ipma is not supported for adding Texture/Grain items");
  const infos = parseIinf(meta, topBox(meta, "meta"));
  const present = new Set([...infos.keys()].map((i) => auxUriForItem(props0, i)));
  const missing = MATTE_2026_URIS.filter((uri) => !present.has(uri));
  const targets = [primary, ...findItemsByType(infos, "tmap").slice(0, 1)];
  const irot = propertyForItem(props0, primary, "irot");
  const payloads = new Map();
  // A source matte's ispe/pixi/hvcC are appended once, then shared by every item using it.
  const sourceProps = new Map();
  const sourceAssoc = (src) => {
    if (!sourceProps.has(src)) {
      const idx = [];
      for (const b of [src.ispe, src.pixi, src.hvcC]) {
        let i;
        [meta, i] = appendIpcoProperty(meta, b);
        idx.push(i);
      }
      sourceProps.set(src, idx);
    }
    return sourceProps.get(src);
  };

  if (missing.length) {
    // auxC (descriptive) must precede irot (transformative), so associate in native order.
    let ispeI, pixiI, hvccI;
    [meta, ispeI] = appendIpcoProperty(meta, MATTE_ISPE);
    [meta, pixiI] = appendIpcoProperty(meta, MATTE_PIXI);
    [meta, hvccI] = appendIpcoProperty(meta, MATTE_HVCC);
    const specs = [];
    const filled = new Map();
    for (const uri of missing) {
      const src = people ? people.mattes.get(uri) : undefined;
      let [mIspe, mPixi, mHvcc] = [ispeI, pixiI, hvccI];
      if (src) {
        [mIspe, mPixi, mHvcc] = sourceAssoc(src);
        filled.set(uri, src.payload);
      }
      let auxcI;
      [meta, auxcI] = appendIpcoProperty(meta, auxcBox(uri));
      const reuse = [[mIspe, false], [mPixi, false], [auxcI, true], [mHvcc, true]];
      if (irot) reuse.push([irot.index, true]);
      specs.push({ key: uri, reuse, refType: "auxl", refTo: targets });
    }
    let mattes, sidecars;
    [meta, mattes] = addItems(meta, specs);
    for (const [uri, iid] of mattes) payloads.set(iid, filled.get(uri) ?? MATTE_EMPTY);
    [meta, sidecars] = addItems(meta, missing.map((uri) => ({
      key: `xmp:${uri}`, itemType: "mime", contentType: "application/rdf+xml",
      refType: "cdsc", refTo: [mattes.get(uri)],
    })));
    for (const iid of sidecars.values()) payloads.set(iid, MATTE_XMP);
  }

  let tex;
  [meta, tex] = addItems(meta, [{
    key: "texture", itemType: "uri ", itemName: "metadata",
    contentType: URI_TEXTURE_STYLES, refType: "cdsc", refTo: targets,
  }]);
  payloads.set(tex.get("texture"), textureStylesPayload(people, grainSeed));
  let summary = `added #${tex.get("texture")} -> [${targets}], ${missing.length} 2026 mattes`;

  if (people) {
    let auxcI;
    [meta, auxcI] = appendIpcoProperty(meta, auxcBox(URI_PERSON_INSTANCES));
    const specs = people.instances.map(([, src], n) => {
      const [mIspe, mPixi, mHvcc] = sourceAssoc(src);
      const reuse = [[mIspe, false], [mPixi, false], [auxcI, true], [mHvcc, true]];
      if (irot) reuse.push([irot.index, true]);
      return { key: `instance${n}`, reuse, refType: "auxl", refTo: targets };
    });
    let inst, instXmp;
    [meta, inst] = addItems(meta, specs);
    [meta, instXmp] = addItems(meta, people.instances.map((_, n) => ({
      key: `xmp${n}`, itemType: "mime", contentType: "application/rdf+xml",
      refType: "cdsc", refTo: [inst.get(`instance${n}`)],
    })));
    people.instances.forEach(([key, src], n) => {
      payloads.set(inst.get(`instance${n}`), src.payload);
      payloads.set(instXmp.get(`xmp${n}`), softSkinInstanceXmp(key));
    });
    summary += `, Soft Skin for ${people.faces} face(s)`;
  }
  return [meta, payloads, summary];
}

/**
 * Native iPhone 16/17 style photo -> the same photo plus Texture/Grain. Nothing is ported:
 * existing payloads stay byte-identical, meta grows and every extent offset moves with it,
 * and the new payloads go into one mdat appended at the end.
 */
export function addTexture(data) {
  const d = discoverHeic(data);
  if (d.stylesItem === null) throw new Error("no native Photographic Style");
  if (hasTexture(d.infos)) throw new Error("already has texture_styles");
  const iloc = d.iloc;
  if (iloc.version !== 1 || iloc.offsetSize !== 4 || iloc.lengthSize !== 4
      || iloc.baseOffsetSize !== 0 || iloc.indexSize !== 0)
    throw new Error("unsupported iloc layout");
  const iref = findChild(metaChildren(data, d.meta), "iref");
  if (data[iref.off + iref.hdr] !== 0) throw new Error("unsupported iref version");
  const { off: mo, size: ms } = d.meta;
  const external = new Map([...iloc.items].filter(([, it]) =>
    it.constructionMethod === 0 && it.extents.length));
  for (const it of external.values())
    for (const e of it.extents)
      if (e.offset < mo + ms) throw new Error("payload before end of meta");

  const [newMeta, newPayloads, summary] = addTextureItems(data.slice(mo, mo + ms), d.primary,
    softSkinPeople(data, d), filmGrainSeed(data, d));
  const delta = newMeta.length - ms;
  const metaOut = newMeta.slice();
  const niloc = parseIloc(metaOut, topBox(metaOut, "meta"));
  const tail = data.subarray(mo + ms);
  const cursor = mo + newMeta.length + tail.length + 8;
  const extra = [];
  let extraLen = 0;
  for (const iid of [...newPayloads.keys()].sort((a, b) => a - b)) {
    const e = niloc.items.get(iid).extents[0];
    metaOut.set(be(cursor + extraLen, 4), e.offsetPos);
    metaOut.set(be(newPayloads.get(iid).length, 4), e.lengthPos);
    extra.push(newPayloads.get(iid));
    extraLen += newPayloads.get(iid).length;
  }
  if (cursor + extraLen >= 2 ** 32) throw new Error("file too large for 32-bit offsets");
  for (const [iid, it] of niloc.items)
    if (external.has(iid))
      for (const e of it.extents) metaOut.set(be(e.offset + delta, 4), e.offsetPos);
  const result = concat([
    data.subarray(0, mo), metaOut, tail,
    be(8 + extraLen, 4), new Uint8Array([0x6d, 0x64, 0x61, 0x74]), ...extra,
  ]);

  // Self-check: every original payload byte-identical, every new one readable.
  const check = discoverHeic(result);
  const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
  for (const iid of external.keys())
    if (!same(extractItem(result, check.iloc, iid), extractItem(data, iloc, iid)))
      throw new Error(`self-check failed: item ${iid} changed`);
  for (const [iid, blob] of newPayloads)
    if (!same(extractItem(result, check.iloc, iid), blob))
      throw new Error(`self-check failed: new item ${iid} unreadable`);
  return { data: result, report: { mode: "add-texture", texture: summary, metaGrowth: delta } };
}
