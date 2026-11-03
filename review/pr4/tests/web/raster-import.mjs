import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { loadProfile } from "../../web/src/zip.js";
import { topBox, boxes } from "../../web/src/box.js";
import {
  buildRasterHeic, extractPortraitDepth, targetGeometry,
} from "../../web/src/raster-import.js";
import {
  discoverHeic, extractItem, propertyBoxBytes, auxUriForItem, dimensionsForItem,
  auxcBox, DEPTH_URI, parseIloc,
} from "../../web/src/heif.js";
import { readExifOrientation, extractAppleMakerNoteTag } from "../../web/src/exif.js";
import { hasTexture, MATTE_2026_URIS } from "../../web/src/texture.js";
import { buildHeicInspection, INSPECTION_NAMES } from "../../web/src/native-mattes.js";
import { rasterColr, rasterVideoColorSpace } from "../../web/src/raster-color.js";

function gridDescriptor(data, iid) {
  const meta = topBox(data, "meta"), iloc = parseIloc(data, meta);
  const item = iloc.items.get(iid);
  const idat = boxes(data, meta.off + meta.hdr + 4, meta.off + meta.size)
    .find((entry) => entry.type === "idat");
  const extent = item.extents[0];
  const start = idat.off + idat.hdr + item.baseOffset + extent.offset;
  return data.slice(start, start + extent.length);
}

const profile = await loadProfile(new Uint8Array(await readFile("web/profiles/48-12.zip")));
const donor = discoverHeic(profile.meta);
const sample = (value) => new Uint8Array([0, 0, 0, value]);
const output = buildRasterHeic(profile, {
  main: Array.from({ length: 48 }, (_, i) => sample(i)),
  mainHvcc: propertyBoxBytes(profile.meta, donor.props, donor.primaryTiles[0], "hvcC"),
  thumb: sample(77),
  thumbHvcc: propertyBoxBytes(profile.meta, donor.props, donor.thumbnail, "hvcC"),
  hdr: sample(88),
  hdrHvcc: propertyBoxBytes(profile.meta, donor.props, donor.hdrTiles[0], "hvcC"),
});
const result = discoverHeic(output);
assert.equal(result.primaryTiles.length, 48);
assert.equal(result.hdrTiles.length, 12);
assert.equal(readExifOrientation(extractItem(output, result.iloc, result.exifItem)), 6);
assert.deepEqual(
  extractAppleMakerNoteTag(extractItem(output, result.iloc, result.exifItem)).payload,
  profile.mn54,
);
assert.equal(hasTexture(result.infos), true);
const uris = new Set([...result.infos.keys()].map((iid) => auxUriForItem(result.props, iid)));
for (const uri of MATTE_2026_URIS) assert.equal(uris.has(uri), true, `missing ${uri}`);
for (const iid of [96, 97, 98, 99, 100, 101]) assert.equal(result.infos.has(iid), false);
const inspection = await buildHeicInspection(output, result);
assert.equal(new Set(INSPECTION_NAMES).size, INSPECTION_NAMES.length);
for (const name of ["HDR gain map", "style delta map", "tmap", "styles", "texture_styles",
  "PersonMasksValidHint", "PeopleRatio", "SkinRatio", ...MATTE_2026_URIS.map((uri) =>
    uri.split(":").pop())]) assert.equal(inspection.entries.get(name)?.present, true, `missing ${name}`);

const tallGeometry = {
  displayWidth: 2268, displayHeight: 4032, storedWidth: 4032, storedHeight: 2268,
  hdrWidth: 2016, hdrHeight: 1134, deltaWidth: 2880, deltaHeight: 1620,
  thumbWidth: 416, thumbHeight: 234,
};
const tall = buildRasterHeic(profile, {
  main: Array.from({ length: 48 }, (_, i) => sample(i)),
  mainHvcc: propertyBoxBytes(profile.meta, donor.props, donor.primaryTiles[0], "hvcC"),
  thumb: sample(77), thumbHvcc: propertyBoxBytes(profile.meta, donor.props, donor.thumbnail, "hvcC"),
  hdr: sample(88), hdrHvcc: propertyBoxBytes(profile.meta, donor.props, donor.hdrTiles[0], "hvcC"),
}, null, null, tallGeometry);
const tallResult = discoverHeic(tall);
assert.deepEqual(dimensionsForItem(tallResult.props, tallResult.primary), [4032, 2268]);
assert.deepEqual(dimensionsForItem(tallResult.props, tallResult.hdrGrid), [2016, 1134]);
assert.deepEqual(dimensionsForItem(tallResult.props, tallResult.deltaGrid), [2880, 1620]);
assert.deepEqual(dimensionsForItem(tallResult.props, tallResult.thumbnail), [416, 234]);

const pngGeometry = targetGeometry({ width: 1290, height: 2796 });
assert.deepEqual(pngGeometry, {
  displayWidth: 1290, displayHeight: 2796,
  storedWidth: 2796, storedHeight: 1290,
  sourceWidth: 1290, sourceHeight: 2796, resized: false,
  primaryColumns: 6, primaryRows: 3, primaryTiles: 18,
  hdrWidth: 1398, hdrHeight: 645, hdrColumns: 3, hdrRows: 2,
  deltaWidth: 2796, deltaHeight: 1290, deltaColumns: 6, deltaRows: 3,
  thumbWidth: 416, thumbHeight: 192,
});
const pngSized = buildRasterHeic(profile, {
  main: Array.from({ length: pngGeometry.primaryTiles }, (_, i) => sample(i)),
  mainHvcc: propertyBoxBytes(profile.meta, donor.props, donor.primaryTiles[0], "hvcC"),
  thumb: sample(77), thumbHvcc: propertyBoxBytes(profile.meta, donor.props, donor.thumbnail, "hvcC"),
  hdr: sample(88), hdrHvcc: propertyBoxBytes(profile.meta, donor.props, donor.hdrTiles[0], "hvcC"),
  mainColr: rasterColr(rasterVideoColorSpace("display-p3")),
  thumbColr: rasterColr(rasterVideoColorSpace("srgb")),
}, null, null, pngGeometry);
const pngResult = discoverHeic(pngSized);
for (const iid of [pngResult.primary, ...pngResult.primaryTiles,
  ...[...pngResult.infos].filter(([, info]) => info.type === "tmap").map(([iid]) => iid)])
  assert.deepEqual(propertyBoxBytes(pngSized, pngResult.props, iid, "colr"),
    rasterColr(rasterVideoColorSpace("display-p3")), "primary color must match its encoded YUV");
for (const iid of [pngResult.thumbnail, pngResult.linearThumb])
  assert.deepEqual(propertyBoxBytes(pngSized, pngResult.props, iid, "colr"),
    rasterColr(rasterVideoColorSpace("srgb")), "thumbnail color must be independent of donor/main ICC");
assert.equal(pngResult.primaryTiles.length, 18);
assert.equal(pngResult.hdrTiles.length, 6);
assert.equal(pngResult.deltaTiles.length, 18);
assert.deepEqual(dimensionsForItem(pngResult.props, pngResult.primary), [2796, 1290]);
assert.deepEqual(dimensionsForItem(pngResult.props, pngResult.hdrGrid), [1398, 645]);
assert.deepEqual(dimensionsForItem(pngResult.props, pngResult.deltaGrid), [2796, 1290]);
assert.deepEqual(dimensionsForItem(pngResult.props, pngResult.thumbnail), [416, 192]);
assert.equal(Buffer.from(gridDescriptor(pngSized, pngResult.primary)).toString("hex"),
  "000002050aec050a");
assert.equal(Buffer.from(gridDescriptor(pngSized, pngResult.hdrGrid)).toString("hex"),
  "0000010205760285");
assert.equal(Buffer.from(gridDescriptor(pngSized, pngResult.deltaGrid)).toString("hex"),
  "000002050aec050a");

const depthPayload = new Uint8Array([0, 0, 0, 4, 0x44, 0x45, 0x50, 0x54]);
const depthXmp = new TextEncoder().encode("<x:xmpmeta>portrait-depth-test</x:xmpmeta>");
const withDepth = buildRasterHeic(profile, {
  main: Array.from({ length: 48 }, (_, i) => sample(i)),
  mainHvcc: propertyBoxBytes(profile.meta, donor.props, donor.primaryTiles[0], "hvcC"),
  thumb: sample(77), thumbHvcc: propertyBoxBytes(profile.meta, donor.props, donor.thumbnail, "hvcC"),
  hdr: sample(88), hdrHvcc: propertyBoxBytes(profile.meta, donor.props, donor.hdrTiles[0], "hvcC"),
  sourceDepth: {
    itemType: "hvc1", payload: depthPayload,
    boxes: [
      propertyBoxBytes(profile.meta, donor.props, donor.thumbnail, "ispe"),
      propertyBoxBytes(profile.meta, donor.props, donor.thumbnail, "pixi"),
      propertyBoxBytes(profile.meta, donor.props, donor.thumbnail, "hvcC"),
    ].filter(Boolean),
    auxc: auxcBox(DEPTH_URI),
    sidecars: [{ contentType: "application/rdf+xml", payload: depthXmp }],
  },
});
const depthResult = discoverHeic(withDepth);
const depthId = [...depthResult.infos.keys()]
  .find((iid) => auxUriForItem(depthResult.props, iid) === DEPTH_URI);
assert.notEqual(depthId, undefined);
assert.deepEqual(extractItem(withDepth, depthResult.iloc, depthId), depthPayload);
const depthAux = depthResult.refs.find((ref) => ref.type === "auxl" && ref.from === depthId);
assert.deepEqual(depthAux.to, [depthResult.primary,
  ...[...depthResult.infos].filter(([, info]) => info.type === "tmap").map(([iid]) => iid)]);
const depthCdsc = depthResult.refs.find((ref) => ref.type === "cdsc" && ref.to.includes(depthId));
assert.ok(depthCdsc);
assert.deepEqual(extractItem(withDepth, depthResult.iloc, depthCdsc.from), depthXmp);
const capturedDepth = extractPortraitDepth(withDepth, depthResult);
assert.deepEqual(capturedDepth.payload, depthPayload);
assert.deepEqual(capturedDepth.sidecars[0].payload, depthXmp);

console.log("Raster import container, Exif, Portrait depth, Texture, semantic items, and inspection are consistent.");
