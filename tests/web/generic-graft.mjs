import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { loadProfile } from "../../web/src/zip.js";
import { patch } from "../../web/src/port.js";
import { inspectionComparator } from "../../web/src/inspection-compare.js";
import { topBox, boxes } from "../../web/src/box.js";
import {
  discoverHeic, dimensionsForItem, extractItem, propertyBoxBytes, auxUriForItem, DEPTH_URI,
  parseIloc, extractItemData,
} from "../../web/src/heif.js";

function gridDescriptor(data, iid) {
  const meta = topBox(data, "meta"), iloc = parseIloc(data, meta);
  const item = iloc.items.get(iid);
  const idat = boxes(data, meta.off + meta.hdr + 4, meta.off + meta.size)
    .find((box) => box.type === "idat");
  const extent = item.extents[0];
  const start = idat.off + idat.hdr + item.baseOffset + extent.offset;
  return data.slice(start, start + extent.length);
}

const cases = [
  ["tests/private-fixtures/grid-42-no-hdr.heic", 42, [3213, 5712]],
  ["tests/private-fixtures/grid-40-no-hdr.heic", 40, [2268, 4032]],
  ["tests/private-fixtures/grid-36-no-hdr.heic", 36, [3024, 3024]],
];
const available = cases.filter(([path]) => existsSync(path));
const tiledHdrFixture = "tests/private-fixtures/grid-42-hdr-15.heic";
if (!available.length && !existsSync(tiledHdrFixture)) {
  console.log("generic-graft fixtures absent; skipped");
  process.exit(0);
}

const profile48 = await loadProfile(new Uint8Array(readFileSync("web/profiles/48-12.zip")));
for (const [path, expectedTiles, expectedDimensions] of available) {
  const source = new Uint8Array(readFileSync(path));
  const before = discoverHeic(source);
  const representative = before.primaryTiles[0];
  const synthetic = {
    payload: extractItem(source, before.iloc, representative),
    hvcc: propertyBoxBytes(source, before.props, representative, "hvcC"),
  };
  const { data, report } = await patch(source, profile48, {
    generic: true,
    syntheticThumbnail: { ...synthetic, width: 234, height: 416 },
    syntheticHdr: {
      ...synthetic,
      width: Math.max(1, Math.floor(expectedDimensions[0] / 2)),
      height: Math.max(1, Math.floor(expectedDimensions[1] / 2)),
    },
    texture: false,
    sceneStats: "donor",
    lightMaps: "flat",
  });
  const after = discoverHeic(data);

  assert.equal(after.primaryTiles.length, expectedTiles, `${path}: primary tile count`);
  assert.deepEqual(dimensionsForItem(after.props, after.primary), expectedDimensions,
    `${path}: primary dimensions`);
  assert.equal(report.generic.primaryPayloadsPreserved, expectedTiles);
  assert.equal(report.hdr.mode, "synthetic-direct");
  assert.equal(after.hdrTiles.length, 0, `${path}: synthetic HDR must be standalone`);
  for (let i = 0; i < expectedTiles; i++) {
    assert.deepEqual(
      extractItem(data, after.iloc, after.primaryTiles[i]),
      extractItem(source, before.iloc, before.primaryTiles[i]),
      `${path}: primary tile ${i + 1} changed`,
    );
  }
  console.log(`${path}: ${expectedTiles} original primary HEVC tiles preserved byte-for-byte`);
}

if (existsSync(tiledHdrFixture)) {
  const profile45 = await loadProfile(new Uint8Array(readFileSync("web/profiles/45-15.zip")));
  const source = new Uint8Array(readFileSync(tiledHdrFixture));
  const before = discoverHeic(source);
  const representative = before.primaryTiles[0];
  const syntheticThumbnail = {
    payload: extractItem(source, before.iloc, representative),
    hvcc: propertyBoxBytes(source, before.props, representative, "hvcC"),
    width: 234,
    height: 416,
  };
  const { data, report } = await patch(source, profile45, {
    generic: true,
    syntheticThumbnail,
    texture: false,
    sceneStats: "donor",
    lightMaps: "flat",
  });
  const after = discoverHeic(data);
  assert.equal(after.primaryTiles.length, 42);
  assert.equal(after.hdrTiles.length, 15);
  assert.deepEqual(dimensionsForItem(after.props, after.primary), [3213, 5712]);
  assert.deepEqual(dimensionsForItem(after.props, after.primaryTiles[0]), [640, 896]);
  assert.deepEqual(dimensionsForItem(after.props, after.hdrGrid), [1607, 2856]);
  assert.deepEqual(dimensionsForItem(after.props, after.hdrTiles[0]), [384, 960]);
  assert.deepEqual(gridDescriptor(data, after.primary), gridDescriptor(source, before.primary));
  assert.deepEqual(gridDescriptor(data, after.hdrGrid), gridDescriptor(source, before.hdrGrid));
  assert.equal(report.generic.primaryPayloadsPreserved, 42);
  assert.equal(report.hdr.mode, "tiled-preserved");
  assert.equal(report.hdr.payloadsPreserved, 15);
  const sourceTmap = [...before.infos].find(([, info]) => info.type === "tmap")?.[0];
  const outputTmap = [...after.infos].find(([, info]) => info.type === "tmap")?.[0];
  assert.deepEqual(extractItemData(data, after, outputTmap), extractItemData(source, before, sourceTmap),
    "Original HDR reconstruction metadata must accompany preserved gain map tiles");
  for (const type of ["colr", "pixi"])
    assert.deepEqual(propertyBoxBytes(data, after.props, outputTmap, type),
      propertyBoxBytes(source, before.props, sourceTmap, type), `tmap ${type} must be preserved`);
  assert.equal(report.tmapMetadata, "target-preserved");
  const allProperties = (bytes,props,id) => (props.associations.get(id)||[]).map(a=>{
    const p=props.properties[a.index-1];return {type:p.type,essential:a.essential,bytes:bytes.slice(p.box.off,p.box.off+p.box.size)};
  });
  assert.deepEqual(allProperties(data,after.props,after.hdrGrid),allProperties(source,before.props,before.hdrGrid),
    'HDR associations must keep auxC at its original position, with every byte and essential flag preserved');
  assert.deepEqual(allProperties(data,after.props,outputTmap),allProperties(source,before.props,sourceTmap));
  assert.equal(report.sourceConsistency.hdrPropertyOrderPreserved,true);
  const compare=inspectionComparator(source,data), row=(name,id)=>({name,present:true,itemIds:[id]});
  assert.equal(compare(row('HDR gain map',before.hdrGrid),row('HDR gain map',after.hdrGrid)),'same');
  assert.equal(compare(row('tmap',sourceTmap),row('tmap',outputTmap)),'same');
  const renderingProperties = (bytes, props, iid) => (props.associations.get(iid) || [])
    .filter((association) => ["colr", "clli", "mdcv"].includes(props.properties[association.index - 1].type))
    .map((association) => {
      const property = props.properties[association.index - 1];
      return { essential: association.essential,
        bytes: bytes.slice(property.box.off, property.box.off + property.box.size) };
    });
  for (const [sourceId, outputId] of [[before.primary, after.primary], [before.hdrGrid, after.hdrGrid],
    [sourceTmap, outputTmap], ...before.primaryTiles.map((iid, index) => [iid, after.primaryTiles[index]]),
    ...before.hdrTiles.map((iid, index) => [iid, after.hdrTiles[index]])])
    assert.deepEqual(renderingProperties(data, after.props, outputId),
      renderingProperties(source, before.props, sourceId), "complete source HDR/color descriptors must be preserved");
  for (const [label, beforeItem, afterItem] of [
    ["primary", before.primaryTiles[0], after.primaryTiles[0]],
    ["HDR", before.hdrTiles[0], after.hdrTiles[0]],
  ]) {
    for (const type of ["ispe", "hvcC"])
      assert.deepEqual(propertyBoxBytes(data, after.props, afterItem, type),
        propertyBoxBytes(source, before.props, beforeItem, type),
        `${tiledHdrFixture}: ${label} ${type} changed`);
  }
  for (const [label, beforeItems, afterItems] of [
    ["primary", before.primaryTiles, after.primaryTiles],
    ["HDR", before.hdrTiles, after.hdrTiles],
  ]) {
    for (let i = 0; i < beforeItems.length; i++)
      assert.deepEqual(extractItem(data, after.iloc, afterItems[i]),
        extractItem(source, before.iloc, beforeItems[i]),
        `${tiledHdrFixture}: ${label} tile ${i + 1} changed`);
  }
  const beforeDepth = [...before.infos.keys()]
    .find((iid) => auxUriForItem(before.props, iid) === DEPTH_URI);
  const afterDepth = [...after.infos.keys()]
    .find((iid) => auxUriForItem(after.props, iid) === DEPTH_URI);
  assert.notEqual(beforeDepth, undefined);
  assert.notEqual(afterDepth, undefined);
  assert.deepEqual(extractItem(data, after.iloc, afterDepth),
    extractItem(source, before.iloc, beforeDepth));
  console.log(`${tiledHdrFixture}: 42 primary, 15 HDR, and Portrait depth payloads preserved byte-for-byte`);
}
