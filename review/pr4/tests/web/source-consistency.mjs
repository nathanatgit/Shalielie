import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isolatePrimaryImage } from "../../web/src/primary-source.js";
import { discoverHeic, extractItemData, propertyBoxBytes, appendIpcoProperty, associateItemProperty } from "../../web/src/heif.js";
import { buildRasterHeic } from "../../web/src/raster-import.js";
import { rasterColr, rasterVideoColorSpace } from "../../web/src/raster-color.js";
import { loadProfile } from "../../web/src/zip.js";
import { patch } from "../../web/src/port.js";

for (const path of ["tests/private-fixtures/native-style.heic", "tests/private-fixtures/grid-42-hdr-15.heic", "tests/private-fixtures/direct-hdr.heic"]) {
  const bytes = new Uint8Array(readFileSync(path)), before = bytes.slice(), d = discoverHeic(bytes);
  const primary = isolatePrimaryImage(bytes), isolated = discoverHeic(primary);
  assert.deepEqual(bytes, before, "decode isolation must not modify input");
  assert.deepEqual([...isolated.infos.keys()].sort((a,b)=>a-b), [d.primary, ...d.primaryTiles].sort((a,b)=>a-b));
  for (const id of [d.primary, ...d.primaryTiles]) {
    assert.deepEqual(extractItemData(primary, isolated, id), extractItemData(bytes, d, id));
    for (const type of ["colr", "hvcC", "ispe", "pixi", "irot", "imir"])
      assert.deepEqual(propertyBoxBytes(primary, isolated.props, id, type), propertyBoxBytes(bytes, d.props, id, type));
  }
  assert.ok(isolated.refs.every(r => r.type === "dimg" && r.from === d.primary));
  console.log(`${path}: primary-only decode preserves pixels and color/orientation; removes HDR/styles/auxiliaries`);
}
const profile = await loadProfile(new Uint8Array(readFileSync("web/profiles/48-12.zip")));
const bytes = new Uint8Array(readFileSync("tests/private-fixtures/direct-hdr.heic")), d = discoverHeic(bytes);
const { data, report } = await patch(bytes, profile, { texture: false, sceneStats: "donor", lightMaps: "flat" });
const output = discoverHeic(data);
assert.equal(report.sourceConsistency.checked, true);
assert.equal(report.hdrSidecars, "source-only");
assert.ok([...output.props.associations.keys()].every(id => output.infos.has(id)), "no properties on deleted HDR grid");
assert.deepEqual(propertyBoxBytes(data, output.props, output.hdrGrid, "colr"), propertyBoxBytes(bytes, d.props, d.hdrGrid, "colr"));
assert.deepEqual(propertyBoxBytes(data, output.props, output.hdrGrid, "pixi"), propertyBoxBytes(bytes, d.props, d.hdrGrid, "pixi"));
assert.deepEqual(propertyBoxBytes(data, output.props, output.deltaGrid, "colr"), propertyBoxBytes(profile.meta, discoverHeic(profile.meta).props, Number(profile.manifest.donor_delta_grid_item), "colr"));
assert.equal(report.delta.originalRecovered, false);
console.log("Direct HDR association regression, per-item checks, and neutral-delta codec/color isolation passed");

// A generated image must replace every color descriptor, including duplicate ICC/nclx.
const donor = discoverHeic(profile.meta), color = rasterColr(rasterVideoColorSpace());
const ids = [donor.primary, donor.thumbnail, donor.linearThumb, donor.hdrGrid, ...donor.primaryTiles, ...donor.hdrTiles];
let meta, extra;
[meta, extra] = appendIpcoProperty(profile.meta, color);
for (const id of ids) meta = associateItemProperty(meta, id, extra, false);
const raster = buildRasterHeic({ ...profile, meta }, {
  main: Array.from({ length: 48 }, () => new Uint8Array([1])),
  mainHvcc: propertyBoxBytes(profile.meta, donor.props, donor.primaryTiles[0], "hvcC"),
  thumb: new Uint8Array([2]), thumbHvcc: propertyBoxBytes(profile.meta, donor.props, donor.thumbnail, "hvcC"),
  hdr: new Uint8Array([3]), hdrHvcc: propertyBoxBytes(profile.meta, donor.props, donor.hdrTiles[0], "hvcC"),
  mainColr: color, thumbColr: color, hdrColr: color,
});
const rd = discoverHeic(raster);
for (const id of ids) {
  const colors = rd.props.associations.get(id).filter(a => rd.props.properties[a.index - 1].type === "colr");
  assert.equal(colors.length, 1, `generated item ${id} must have exactly its encoded color descriptor`);
  assert.deepEqual(propertyBoxBytes(raster, rd.props, id, "colr"), color);
}
console.log("Generated-image duplicate ICC/nclx removal regression passed");
