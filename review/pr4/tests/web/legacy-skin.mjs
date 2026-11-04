import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { topBox, be, box, concat } from "../../web/src/box.js";
import { loadProfile } from "../../web/src/zip.js";
import {
  MATTE_URIS, auxUriForItem, discoverHeic, dimensionsForItem, extractItem,
  propertyBoxBytes, parseIinf, parseIpcoIpma, removeItems, irotAngleForItem, imirAxisForItem, parseIloc,
} from "../../web/src/heif.js";
import { addTextureItems, addTexture, MATTE_2026_URIS, preferNativeSkin } from "../../web/src/texture.js";
import { patch } from "../../web/src/port.js";
import { buildRasterHeic, targetGeometry, buildRasterExif } from "../../web/src/raster-import.js";

const find = (d, uri) => [...d.infos.keys()].find((iid) => auxUriForItem(d.props, iid) === uri);
const metadata = (meta) => ({ infos: parseIinf(meta, topBox(meta, "meta")),
  props: parseIpcoIpma(meta, topBox(meta, "meta")) });
const profiles = new Map();
for (const name of ["45-15", "48-12"]) {
  const profile = await loadProfile(new Uint8Array(readFileSync(`web/profiles/${name}.zip`)));
  profiles.set(name, profile);
  const before = metadata(profile.meta);
  const originalSkin = find(before, MATTE_URIS.semanticskinmatte);
  const replacement = {
    payload: new Uint8Array([0, 0, 0, 7]),
    hvcc: propertyBoxBytes(profile.meta, before.props, originalSkin, "hvcC"),
    width: 768, height: 354,
  };
  const overrides = new Map([[MATTE_2026_URIS[1], replacement]]);
  const primary = Number(profile.manifest.donor_primary_item);
  const [meta, payloads] = addTextureItems(profile.meta, primary, { matteOverrides: overrides });
  const after = metadata(meta);
  assert.equal(find(after, MATTE_URIS.semanticskinmatte), originalSkin, "existing item ID stays stable");
  for (const uri of [MATTE_URIS.semanticskinmatte, MATTE_2026_URIS[1]]) {
    const iid = find(after, uri);
    assert.deepEqual(payloads.get(iid), replacement.payload);
    assert.deepEqual(dimensionsForItem(after.props, iid), [768, 354]);
    assert.deepEqual(propertyBoxBytes(meta, after.props, iid, "hvcC"), replacement.hvcc);
    assert.equal(irotAngleForItem(meta, after.props, iid), irotAngleForItem(meta, after.props, primary));
    assert.equal(imirAxisForItem(meta, after.props, iid), imirAxisForItem(meta, after.props, primary));
  }
  for (const iid of before.infos.keys()) {
    if (iid === originalSkin) continue;
    for (const type of ["ispe", "hvcC", "pixi", "irot", "imir", "colr"])
      assert.deepEqual(propertyBoxBytes(meta, after.props, iid, type),
        propertyBoxBytes(profile.meta, before.props, iid, type), `${name}: shared ${type} changed for ${iid}`);
  }
  const [noFaces, noFacesPayloads] = addTextureItems(profile.meta, primary);
  assert.equal(noFacesPayloads.has(originalSkin), false, "no generation preserves original skin");
  assert.deepEqual(propertyBoxBytes(noFaces, metadata(noFaces).props, originalSkin, "hvcC"), replacement.hvcc);
  const [missing, added] = addTextureItems(removeItems(profile.meta, [originalSkin]), primary,
    { matteOverrides: overrides });
  const addedSkin = find(metadata(missing), MATTE_URIS.semanticskinmatte);
  assert.ok(addedSkin !== undefined, "missing legacy skin must be added");
  assert.deepEqual(added.get(addedSkin), replacement.payload);
  console.log(`${name}: existing/missing legacy skin synced; shared properties and no-face path preserved`);
}

const profile = profiles.get("48-12"), donor = discoverHeic(profile.meta);
const replacement = { payload: new Uint8Array([0, 0, 0, 7]), width: 768, height: 354,
  hvcc: propertyBoxBytes(profile.meta, donor.props, donor.thumbnail, "hvcC") };
const overrides = new Map([[MATTE_2026_URIS[1], replacement]]);
const rasterGeometry = targetGeometry({ width: 1290, height: 2796 });
const raster = buildRasterHeic(profile, {
  main: Array.from({ length: rasterGeometry.primaryTiles }, () => replacement.payload), mainHvcc: replacement.hvcc,
  thumb: replacement.payload, thumbHvcc: replacement.hvcc,
  hdr: replacement.payload, hdrHvcc: replacement.hvcc,
}, null, { state: "generated", overrides }, rasterGeometry);
const rasterDiscovery = discoverHeic(raster);
const rasterSkin = find(rasterDiscovery, MATTE_URIS.semanticskinmatte);
assert.ok(rasterSkin !== undefined);
assert.deepEqual(extractItem(raster, rasterDiscovery.iloc, rasterSkin), replacement.payload);
assert.deepEqual(dimensionsForItem(rasterDiscovery.props, rasterSkin), [768, 354]);
console.log("PNG raster container includes generated legacy skin with matching payload and dimensions");

// Verify actual bitstreams and appended-mdat offsets using local photo fixtures when present.
if (existsSync("tests/private-fixtures/grid-42-hdr-15.heic") && existsSync("tests/private-fixtures/generated-skin.heic")) {
  const source = new Uint8Array(readFileSync("tests/private-fixtures/grid-42-hdr-15.heic"));
  const generated = new Uint8Array(readFileSync("tests/private-fixtures/generated-skin.heic"));
  const gd = discoverHeic(generated), skin = find(gd, MATTE_2026_URIS[1]);
  const real = { payload: extractItem(generated, gd.iloc, skin),
    hvcc: propertyBoxBytes(generated, gd.props, skin, "hvcC"), width: 432, height: 768 };
  const opts = { generic: true, sceneStats: "donor", lightMaps: "flat",
    syntheticThumbnail: { payload: extractItem(generated, gd.iloc, gd.thumbnail),
      hvcc: propertyBoxBytes(generated, gd.props, gd.thumbnail, "hvcC"),
      width: 234, height: 416 },
    matteOverrides: new Map([[MATTE_2026_URIS[1], real]]) };
  const ported = (await patch(source, profiles.get("45-15"), opts)).data;
  const native = (await patch(source, profiles.get("45-15"), { ...opts, texture: false })).data;
  const upgraded = addTexture(native, { matteOverrides: opts.matteOverrides }).data;
  for (const [data, expected] of [[ported, real], [upgraded,
    preferNativeSkin(native, discoverHeic(native)).get(MATTE_URIS.semanticskinmatte)]]) {
    const d = discoverHeic(data);
    for (const uri of [MATTE_URIS.semanticskinmatte, MATTE_2026_URIS[1]]) {
      const iid = find(d, uri);
      assert.ok(Buffer.from(extractItem(data, d.iloc, iid)).equals(Buffer.from(expected.payload)));
      assert.deepEqual(dimensionsForItem(d.props, iid), [expected.width, expected.height]);
      assert.deepEqual(propertyBoxBytes(data, d.props, iid, "hvcC"), expected.hvcc);
    }
  }
  console.log("Portrait fixture: generated skin used when absent; native add-texture prefers existing legacy skin");
}

// A source with legacy skin only must retain that exact mask, even with conflicting AI output.
const nativeProfile = profiles.get("45-15");
const nativeMeta = nativeProfile.meta.slice();
const ni = parseIloc(nativeMeta, topBox(nativeMeta, "meta"));
let cursor = nativeProfile.ftyp.length + nativeMeta.length + 8;
const chunks = [];
for (const [iid, item] of ni.items) {
  if (item.constructionMethod !== 0) continue;
  // Profile bundles omit primary/HDR tiles; dummy samples suffice for container surgery.
  const payload = iid === Number(nativeProfile.manifest.donor_exif_item)
    ? buildRasterExif(nativeProfile.mn54)
    : nativeProfile.retained.get(iid) || replacement.payload;
  assert.equal(item.extents.length, 1);
  nativeMeta.set(be(cursor, 4), item.extents[0].offsetPos);
  nativeMeta.set(be(payload.length, 4), item.extents[0].lengthPos);
  chunks.push(payload); cursor += payload.length;
}
const legacyOnly = concat([nativeProfile.ftyp, nativeMeta, box("mdat", concat(chunks))]);
const ld = discoverHeic(legacyOnly);
assert.equal(find(ld, MATTE_2026_URIS[1]), undefined);
const preferred = preferNativeSkin(legacyOnly, ld, overrides);
const original = preferred.get(MATTE_URIS.semanticskinmatte);
assert.equal(preferred.get(MATTE_2026_URIS[1]), original);
const upgraded = addTexture(legacyOnly, { matteOverrides: overrides }).data;
const grafted = (await patch(legacyOnly, nativeProfile, {
  matteOverrides: overrides, sceneStats: "donor", lightMaps: "flat",
})).data;
const reencoded = buildRasterHeic(profile, {
  main: Array.from({ length: rasterGeometry.primaryTiles }, () => replacement.payload), mainHvcc: replacement.hvcc,
  thumb: replacement.payload, thumbHvcc: replacement.hvcc,
  hdr: replacement.payload, hdrHvcc: replacement.hvcc, sourceSkin: preferred,
}, null, { state: "generated", overrides }, rasterGeometry);
for (const data of [upgraded, grafted, reencoded]) {
  const d = discoverHeic(data);
  for (const uri of [MATTE_URIS.semanticskinmatte, MATTE_2026_URIS[1]]) {
    const iid = find(d, uri);
    assert.ok(Buffer.from(extractItem(data, d.iloc, iid)).equals(Buffer.from(original.payload)));
    for (const p of original.nativeProperties) {
      if (p.type === "auxC") continue;
      assert.deepEqual(propertyBoxBytes(data, d.props, iid, p.type), p.bytes,
        `${uri}: original ${p.type} changed`);
    }
  }
}
console.log("Legacy-only source preserved byte-for-byte and reused for v2 across graft, native upgrade and re-encode");

if (existsSync("tests/private-fixtures/native-skin-v2.heic")) {
  const source = new Uint8Array(readFileSync("tests/private-fixtures/native-skin-v2.heic"));
  const d = discoverHeic(source);
  const preferred = preferNativeSkin(source, d, overrides);
  for (const uri of [MATTE_URIS.semanticskinmatte, MATTE_2026_URIS[1]]) {
    const iid = find(d, uri), mask = preferred.get(uri);
    assert.ok(Buffer.from(mask.payload).equals(Buffer.from(extractItem(source, d.iloc, iid))));
    assert.deepEqual([mask.width, mask.height], dimensionsForItem(d.props, iid));
  }
  assert.notEqual(preferred.get(MATTE_URIS.semanticskinmatte), preferred.get(MATTE_2026_URIS[1]),
    "existing native generations must keep separate content");
  console.log("Native-skin fixture: both original native skin generations retained separately");
}
