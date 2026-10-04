import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { box, concat, be, topBox } from "../../web/src/box.js";
import { discoverHeic, extractItemData, replaceIdatItem } from "../../web/src/heif.js";
import { readImageGrid, decodeImageItem, buildHeicInspection } from "../../web/src/native-mattes.js";

// Check descriptors in real files, including meta/idat and edge padding.
for (const path of ["tests/private-fixtures/grid-42-hdr-15.heic", "tests/private-fixtures/native-skin-v2.heic", "tests/private-fixtures/raster-output.heic"]) {
  let bytes;
  try { bytes = new Uint8Array(await readFile(path)); }
  catch (error) { if (error.code === "ENOENT") continue; throw error; }
  const discovery = discoverHeic(bytes);
  if (discovery.infos.get(discovery.hdrGrid)?.type === "grid") {
    const grid = readImageGrid(bytes, discovery, discovery.hdrGrid);
    assert.equal(grid.rows * grid.columns, discovery.hdrTiles.length);
  }
}

const descriptor = concat([new Uint8Array([0, 0, 1, 1]), be(5, 2), be(3, 2)]);
const meta = box("meta", concat([new Uint8Array(4), box("idat", descriptor)]));
const hvcc = box("hvcC", new Uint8Array([1, 1, 0x60, 0, 0, 0, 0, 0, 0, 0, 0, 0, 90]));
const rotation = box("irot", new Uint8Array([3]));
const bytes = concat([meta, hvcc, rotation, new Uint8Array([11, 22, 33, 44])]);
const payloadOffset = meta.length + hvcc.length + rotation.length;
const props = {
  properties: [
    { type: "ispe", width: 5, height: 3 },
    { type: "ispe", width: 3, height: 2 },
    { type: "hvcC", box: { off: meta.length, size: hvcc.length } },
    { type: "irot", box: { off: meta.length + hvcc.length, size: rotation.length, hdr: 8 } },
  ],
  associations: new Map([[1, [{ index: 1 }]], ...[2, 3, 4, 5].map((id) =>
    [id, [{ index: 2 }, { index: 3 }, { index: 4 }]])]),
};
const discovery = {
  meta: topBox(bytes, "meta"), props,
  infos: new Map([[1, { type: "grid" }], ...[2, 3, 4, 5].map((id) => [id, { type: "hvc1" }])]),
  iloc: { items: new Map([[1, { constructionMethod: 1, baseOffset: 0,
    extents: [{ offset: 0, length: 8 }] }], ...[2, 3, 4, 5].map((id) =>
    [id, { constructionMethod: 0, baseOffset: 0, extents: [{ offset: payloadOffset + id - 2, length: 1 }] }])]) },
  refs: [{ type: "dimg", from: 1, to: [2, 3, 4, 5] }],
  hdrGrid: 1, hdrTiles: [2, 3, 4, 5], deltaGrid: null, stylesItem: null,
};
assert.deepEqual(readImageGrid(bytes, discovery, 1), { rows: 2, columns: 2, width: 5, height: 3 });
const wide = concat([new Uint8Array([0, 1, 0, 0]), be(70000, 4), be(40000, 4)]);
assert.deepEqual(readImageGrid(wide, { iloc: { items: new Map([[1, {
  constructionMethod: 0, baseOffset: 0, extents: [{ offset: 0, length: wide.length }],
}]]) }, props: { properties: [{ type: "ispe", width: 70000, height: 40000 }],
  associations: new Map([[1, [{ index: 1 }]]]) } }, 1),
{ rows: 1, columns: 1, width: 70000, height: 40000 });

const canvases = [], frames = [];
globalThis.document = { createElement(type) {
  assert.equal(type, "canvas");
  const result = { width: 0, height: 0, draws: [], rotations: [],
    getContext() { return { translate() {}, scale() {},
      rotate(angle) { result.rotations.push(angle); },
      drawImage(source, ...args) {
        result.draws.push({ width: source.width || source.displayWidth,
          height: source.height || source.displayHeight, value: source.value,
          draws: source.draws?.slice(), args });
      },
    }; },
    toBlob(callback) { callback(new Blob(["png"], { type: "image/png" })); },
  };
  canvases.push(result);
  return result;
} };
globalThis.EncodedVideoChunk = class { constructor(config) { Object.assign(this, config); } };
globalThis.VideoDecoder = class {
  static async isConfigSupported(config) { return { supported: true, config }; }
  constructor(callbacks) { this.callbacks = callbacks; }
  configure() {}
  decode(chunk) {
    const frame = { displayWidth: 3, displayHeight: 2, value: chunk.data[0],
      closed: false, close() { this.closed = true; } };
    frames.push(frame);
    this.callbacks.output(frame);
  }
  async flush() {}
  close() {}
};
const stitched = await decodeImageItem(bytes, discovery, 1);
assert.equal(stitched.width, 5);
assert.equal(stitched.height, 3);
const tiles = stitched.draws[0].draws;
assert.deepEqual(tiles.map((tile) => tile.args), [[0, 0], [3, 0], [0, 2], [3, 2]]);
assert.deepEqual(tiles.map((tile) => tile.draws[0].value), [11, 22, 33, 44]);
assert.ok(tiles.every((tile) => tile.width === 3 && tile.height === 2),
  "tile rotations must not be applied before stitching");
assert.ok(frames.every((frame) => frame.closed));
const small = await decodeImageItem(bytes,discovery,1,{maxSide:3});
assert.deepEqual([small.width,small.height],[3,2]);
const smallTiles=small.draws[0].draws;
assert.equal(smallTiles.length,4);
assert.ok(Math.abs(smallTiles[1].args[0]-1.8)<1e-12);
assert.ok(Math.abs(smallTiles[0].args[2]-1.8)<1e-12);
assert.ok(Math.abs(smallTiles[0].args[3]-4/3)<1e-12);
props.associations.get(1).push({ index: 4 });
const rotated = await decodeImageItem(bytes, discovery, 1);
assert.equal(rotated.width, 3);
assert.equal(rotated.height, 5);
assert.deepEqual(rotated.rotations, [-1.5 * Math.PI]);
const inspection = await buildHeicInspection(bytes, discovery);
const entry = inspection.entries.get("HDR gain map");
assert.equal(entry.previews[0].blob.type, "image/png");
assert.deepEqual(entry.value.dimensions, [5, 3]);
assert.equal(entry.errors.length, 0);
const direct = await decodeImageItem(bytes, discovery, 2);
assert.deepEqual([direct.width, direct.height], [2, 3]);
const stillBytes=bytes.slice();stillBytes[meta.length+9]=3;stillBytes[meta.length+10]=0x70;
const attempts=[];
const originalProbe=VideoDecoder.isConfigSupported;
VideoDecoder.isConfigSupported=async config=>{
  attempts.push([config.codec,config.hardwareAcceleration]);
  assert.equal(config.description[1],3,'hvcC is never rewritten to claim Main');
  return {supported:config.codec.startsWith('hvc1.1.E.')&&config.hardwareAcceleration==='no-preference',config};
};
assert.deepEqual([(await decodeImageItem(stillBytes,discovery,2)).width], [2]);
assert.deepEqual(attempts.map(a=>a[0]),['hvc1.3.E.L90','hvc1.3.E.L90','hvc1.1.E.L90','hvc1.1.E.L90']);
VideoDecoder.isConfigSupported=originalProbe;
await assert.rejects(decodeImageItem(bytes, { ...discovery, refs: [] }, 1), /tile count/);
delete globalThis.VideoDecoder;
const failed = (await buildHeicInspection(bytes, discovery)).entries.get("HDR gain map");
assert.equal(failed.previews.length, 0);
assert.match(failed.errors[0].error, /decoder unavailable/);
assert.deepEqual(failed.value.dimensions, [5, 3]);
const tmapDiscovery = { ...discovery, hdrGrid: null,
  infos: new Map([...discovery.infos, [6, { type: "tmap" }]]), primary: 7,
  refs: [...discovery.refs, { type: "dimg", from: 6, to: [7, 1] }] };
assert.equal((await buildHeicInspection(bytes, tmapDiscovery)).entries.get("HDR gain map").present, true);
// Variable-length replacement must preserve every old idat item and update iloc.
const { loadProfile } = await import("../../web/src/zip.js");
const profile = await loadProfile(new Uint8Array(await readFile("web/profiles/45-15.zip")));
const before = discoverHeic(profile.meta);
const tmapId = [...before.infos].find(([, info]) => info.type === "tmap")[0];
const replacement = new Uint8Array(143).fill(37);
const updatedMeta = replaceIdatItem(profile.meta, tmapId, replacement);
const after = discoverHeic(updatedMeta);
assert.deepEqual(extractItemData(updatedMeta, after, tmapId), replacement);
for (const [iid, item] of before.iloc.items)
  if (item.constructionMethod === 1 && iid !== tmapId)
    assert.deepEqual(extractItemData(updatedMeta, after, iid), extractItemData(profile.meta, before, iid));
console.log("HDR gain map descriptors, tile stitching, rotation, previews and decoder errors passed");
