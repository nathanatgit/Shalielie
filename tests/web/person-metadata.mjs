import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadProfile } from "../../web/src/zip.js";
import { parseBplist } from "../../web/src/bplist.js";
import { topBox } from "../../web/src/box.js";
import {
  auxUriForItem, extractItem, parseIinf, parseIloc, parseIpcoIpma, parseIref, dimensionsForItem,
} from "../../web/src/heif.js";
import { applyPersonMetadata } from "../../web/src/styles.js";
import {
  addTextureItems, MATTE_2026_URIS, URI_PERSON_INSTANCES, URI_TEXTURE_STYLES,
  upgradeStylesV16,
} from "../../web/src/texture.js";
import {
  APPLE_LANDMARK_GROUPS, APPLE_LANDMARK_INDICES, appleLandmarkPoint,
} from "../../web/src/face-mattes.js";

assert.equal(APPLE_LANDMARK_INDICES.length, 76, "native people data uses 76 landmarks");
assert.equal(new Set(APPLE_LANDMARK_INDICES).size, 76, "each Apple slot maps to a unique mesh point");
assert.deepEqual(APPLE_LANDMARK_GROUPS.map(({ start, end }) => end - start + 1),
  [7, 7, 6, 6, 14, 6, 4, 9, 17], "Apple landmark groups retain their native sizes");
assert.deepEqual(APPLE_LANDMARK_INDICES.slice(0, 14),
  [33, 133, 144, 153, 160, 158, 468, 263, 362, 373, 380, 387, 385, 473],
  "eyes use Apple's image-left then image-right order");
assert.deepEqual(APPLE_LANDMARK_INDICES.slice(26, 46),
  [61, 185, 40, 39, 0, 269, 270, 409, 291, 375, 405, 17, 181, 146,
    13, 14, 82, 312, 87, 317], "outer and inner lips retain Apple's order");
assert.deepEqual(APPLE_LANDMARK_INDICES.slice(14, 26),
  [46, 52, 55, 107, 105, 70, 276, 282, 285, 336, 334, 300],
  "eyebrows use Apple's image-left then image-right order");
assert.deepEqual(APPLE_LANDMARK_INDICES.slice(46, 59),
  [168, 6, 197, 1, 327, 326, 2, 97, 98, 279, 49, 294, 64],
  "nose crest and base retain Apple's order");
assert.deepEqual(APPLE_LANDMARK_INDICES.slice(59),
  [454, 323, 361, 288, 397, 365, 379, 400, 152, 176, 150, 136, 172, 58, 132, 93, 234],
  "face contour runs from image-right temple through the chin to image-left temple");
const meshWithoutIris = Array.from({ length: 468 }, (_, i) => ({ x: i, y: i * 2, z: 0 }));
assert.deepEqual(appleLandmarkPoint(meshWithoutIris, 6),
  { x: 781 / 6, y: 781 / 3, z: 0 }, "left iris centre has a 468-point model fallback");

const profile = await loadProfile(new Uint8Array(readFileSync("web/profiles/48-12.zip")));
const donorStyles = profile.retained.get(Number(profile.manifest.donor_styles_item));
const [v16Styles, upgraded] = upgradeStylesV16(donorStyles);
const parsedV16 = parseBplist(v16Styles);
assert.equal(upgraded, true);
assert.equal(parsedV16.get("0"), 16);
assert.equal(parsedV16.get("5"), 0);
assert.equal(parsedV16.get("3").length, 516);
assert.equal(parsedV16.get("k"), false);
assert.equal(parsedV16.get("l"), false);
assert.deepEqual(parseBplist(upgradeStylesV16(v16Styles)[0]), parsedV16,
  "v16 upgrade must be idempotent");
const block = new Map([["blackPoint", 0], ["highKey", 1], ["p02", 0.1],
  ["p10", 0.2], ["p25", 0.3], ["p50", 0.4], ["p75", 0.5],
  ["p98", 0.6], ["whitePoint", 0.7]]);
const [styles] = applyPersonMetadata(donorStyles, {
  peopleRatio: 0.25, skinRatio: 0.1,
  blocks: { ToneMappedImageSkinBased: block },
});
const parsedStyles = parseBplist(styles);
assert.equal(parsedStyles.get("7").get("PersonMasksValidHint"), 1);
assert.equal(parsedStyles.get("7").get("PeopleRatio"), 0.25);
assert.equal(parsedStyles.get("7").get("SkinRatio"), 0.1);
assert.equal(parsedStyles.get("6").get("ToneMappedImageSkinBased").get("p50"), 0.4);

const payload = new Uint8Array([1, 2, 3, 4]);
const hvcc = new Uint8Array([0, 0, 0, 9, 0x68, 0x76, 0x63, 0x43, 1]);
const pixi = new Uint8Array([0, 0, 0, 14, 0x70, 0x69, 0x78, 0x69, 0, 0, 0, 0, 1, 8]);
const people = [new Map([["faceID", 0], ["instanceMaskReferenceKey", "FSINCInstanceMask9"]])];
const secondPayload = new Uint8Array([5, 6, 7, 8]);
const [meta, payloads] = addTextureItems(profile.meta,
  Number(profile.manifest.donor_primary_item), {
    matteOverrides: new Map([
      [MATTE_2026_URIS[1], { payload, hvcc, pixi, width: 432, height: 768 }],
      [URI_PERSON_INSTANCES, { instances: [
        { payload, hvcc, pixi, width: 768, height: 354, referenceKey: "FSINCInstanceMask9" },
        { payload: secondPayload, hvcc, pixi, width: 768, height: 354, referenceKey: "FSINCInstanceMask10" },
      ] }],
    ]),
    texturePeopleData: [
      people[0],
      new Map([["faceID", 0], ["instanceMaskReferenceKey", "FSINCInstanceMask10"]]),
    ],
  });
const infos = parseIinf(meta, topBox(meta, "meta"));
const props = parseIpcoIpma(meta, topBox(meta, "meta"));
const iloc = parseIloc(meta, topBox(meta, "meta"));
const instances = [...infos.keys()].filter((iid) => auxUriForItem(props, iid) === URI_PERSON_INSTANCES);
assert.equal(instances.length, 2, "each detected person must receive an instance mask");
assert.deepEqual(payloads.get(instances[0]), payload);
assert.deepEqual(payloads.get(instances[1]), secondPayload);
for (const iid of instances) assert.deepEqual(dimensionsForItem(props, iid), [768, 354],
  "instance masks must declare their encoded stored dimensions");
const skin = [...infos.keys()].find((iid) => auxUriForItem(props, iid) === MATTE_2026_URIS[1]);
assert.deepEqual(dimensionsForItem(props, skin), [432, 768],
  "portrait matte with irot=0 must retain portrait ispe");
const empty = [...infos.keys()].find((iid) => auxUriForItem(props, iid) === MATTE_2026_URIS[0]);
assert.deepEqual(dimensionsForItem(props, empty), [768, 576],
  "reference empty bitstreams must keep their original dimensions");
assert.equal([...infos.keys()].filter((iid) => MATTE_2026_URIS.includes(auxUriForItem(props, iid))).length,
  12, "the twelve standard 2026 matte slots remain present");
const refs = parseIref(meta, topBox(meta, "meta"));
for (const [i, instance] of instances.entries()) {
  const sidecar = refs.find((ref) => ref.type === "cdsc" && ref.to.includes(instance));
  assert.match(new TextDecoder().decode(payloads.get(sidecar.from)),
    new RegExp(`FSINCInstanceMask${9 + i}`));
}
const texture = [...infos].find(([, info]) => info.uri === URI_TEXTURE_STYLES)?.[0];
assert.equal(parseBplist(payloads.get(texture)).get("TextureStylePostProcessedPeopleData").length, 2);

console.log("person metadata and instance-mask checks passed");
