import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { loadProfile } from "../../web/src/zip.js";
import { patch } from "../../web/src/port.js";
import {
  discoverHeic, auxUriForItem, extractItem, propertyBoxBytes, findItemsByType,
} from "../../web/src/heif.js";

const fixture = "tests/private-fixtures/direct-hdr.heic";
if (!existsSync(fixture)) {
  console.log("direct-HDR fixture absent; skipped");
  process.exit(0);
}

const source = new Uint8Array(readFileSync(fixture));
const profile = await loadProfile(new Uint8Array(readFileSync("web/profiles/48-12.zip")));
const before = discoverHeic(source);
const { data, report } = await patch(source, profile, {
  texture: false, sceneStats: "donor", lightMaps: "flat",
});
const after = discoverHeic(data);
const uri = "urn:com:apple:photo:2020:aux:hdrgainmap";
const hdrItems = [...after.infos.keys()].filter((iid) => auxUriForItem(after.props, iid) === uri);
assert.equal(report.hdr.mode, "direct");
assert.equal(hdrItems.length, 1, "output must contain exactly one recognized HDR gain map");
assert.equal(after.infos.get(hdrItems[0]).type, "hvc1");
assert.equal(after.hdrTiles.length, 0, "standalone HDR must not acquire donor dimg tiles");
assert.deepEqual(extractItem(data, after.iloc, hdrItems[0]),
  extractItem(source, before.iloc, before.hdrGrid));
assert.deepEqual(propertyBoxBytes(data, after.props, hdrItems[0], "hvcC"),
  propertyBoxBytes(source, before.props, before.hdrGrid, "hvcC"));
assert.deepEqual(propertyBoxBytes(data, after.props, hdrItems[0], "ispe"),
  propertyBoxBytes(source, before.props, before.hdrGrid, "ispe"));
const tmap = findItemsByType(after.infos, "tmap")[0];
assert.deepEqual(after.refs.find((ref) => ref.type === "dimg" && ref.from === tmap)?.to,
  [after.primary, hdrItems[0]], "tmap must derive from both primary and standalone HDR");

console.log("standalone HDR payload and codec properties were preserved byte-for-byte");
