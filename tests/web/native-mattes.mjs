import assert from "node:assert/strict";
import { codecStringFromHvcc, decoderCodecCandidates, displayPoint, displayRotationRadians, findNativeMatteItems,
  hasNativeFaceMattes, readNativePeopleData }
  from "../../web/src/native-mattes.js";
import { buildBplist } from "../../web/src/bplist.js";
import { displayPointToStored, storedPointToDisplay } from "../../web/src/heif.js";
import { MATTE_2026_URIS } from "../../web/src/texture.js";

const hvcc = new Uint8Array([1, 4, 8, 0, 0, 0, 0xbf, 0xc8, 0, 0, 0, 0, 90]);
assert.equal(codecStringFromHvcc(hvcc), "hvc1.4.10.L90.BF.C8");
const still = new Uint8Array([1,3,0x70,0,0,0,0xb0,0,0,0,0,0,93]);
assert.deepEqual(decoderCodecCandidates(still), ['hvc1.3.E.L93.B0','hvc1.1.E.L93.B0','hvc1.2.E.L93.B0']);
const incompatible = still.slice();incompatible[2] = 0x10;
assert.deepEqual(decoderCodecCandidates(incompatible), ['hvc1.3.8.L93.B0']);
const lowBits = still.slice();lowBits[2] = 0;lowBits[5] = 1;
assert.equal(codecStringFromHvcc(lowBits), 'hvc1.3.80000000.L93.B0');
assert.equal(displayRotationRadians(270), -1.5 * Math.PI);
assert.deepEqual(displayPoint(0.2, 0.3, 270), { x: 0.7, y: 0.2 });
assert.deepEqual(displayPoint(0.2, 0.3, 90), { x: 0.3, y: 0.8 });
for (const angle of [0, 90, 180, 270]) {
  const displayed = storedPointToDisplay(0.23, 0.67, angle);
  const stored = displayPointToStored(displayed.x, displayed.y, angle);
  assert.ok(Math.abs(stored.x - 0.23) < 1e-12 && Math.abs(stored.y - 0.67) < 1e-12,
    `stored/display point transforms must invert at ${angle} degrees`);
}

const properties = MATTE_2026_URIS.map((auxUri) => ({ type: "auxC", auxUri }));
const discovery = {
  infos: new Map(MATTE_2026_URIS.map((_, i) => [50 + i * 2, {}])),
  props: {
    properties,
    associations: new Map(MATTE_2026_URIS.map((_, i) =>
      [50 + i * 2, [{ index: i + 1 }]])),
  },
};
const items = findNativeMatteItems(discovery);
assert.equal(items.size, 12);
assert.equal(items.get("semanticnosematte").iid, 50);
assert.equal(items.get("semanticskinmattev2").iid, 52);
assert.equal(items.get("semanticpersonmatte").iid, 60);
assert.equal(items.get("semanticfaceskinmatte").iid, 72);
assert.equal(hasNativeFaceMattes(discovery), true);

const people = [new Map([["faceID", 0], ["faceLandmarks", []]])];
const plist = buildBplist(new Map([["TextureStylePostProcessedPeopleData", people]]));
const withTexture = {
  ...discovery,
  infos: new Map([...discovery.infos,
    [129, { type: "uri ", uri: "tag:apple.com,2026:photo:metadata:texture_styles" }]]),
  iloc: { items: new Map([[129, { constructionMethod: 0, baseOffset: 0,
    extents: [{ offset: 0, length: plist.length }] }]]) },
};
assert.equal(readNativePeopleData(plist, withTexture).length, 1);
assert.equal(readNativePeopleData(plist, withTexture)[0].get("faceID"), 0);

console.log("native matte discovery, geometry, and HEVC codec parsing passed");
