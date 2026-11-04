import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { topBox } from "../../web/src/box.js";
import { loadProfile } from "../../web/src/zip.js";
import {
  appendIpcoProperty, associateItemProperty, auxUriForItem, imirAxisForItem,
  parseIinf, parseIpcoIpma, propertyForItem,
} from "../../web/src/heif.js";
import { addTextureItems, MATTE_2026_URIS } from "../../web/src/texture.js";

const profile = await loadProfile(new Uint8Array(readFileSync("web/profiles/48-12.zip")));
const primary = Number(profile.manifest.donor_primary_item);
let meta = profile.meta;
assert.equal(propertyForItem(parseIpcoIpma(meta, topBox(meta, "meta")), primary, "imir"), null);

const imir0 = new Uint8Array([0, 0, 0, 9, 0x69, 0x6d, 0x69, 0x72, 0]);
let imirIndex;
[meta, imirIndex] = appendIpcoProperty(meta, imir0);
meta = associateItemProperty(meta, primary, imirIndex, true);
let props = parseIpcoIpma(meta, topBox(meta, "meta"));
assert.equal(propertyForItem(props, primary, "imir").index, imirIndex);
assert.equal(imirAxisForItem(meta, props, primary), 0);

[meta] = addTextureItems(meta, primary);
const infos = parseIinf(meta, topBox(meta, "meta"));
props = parseIpcoIpma(meta, topBox(meta, "meta"));
const matte = [...infos.keys()].find((iid) => auxUriForItem(props, iid) === MATTE_2026_URIS[0]);
assert.equal(propertyForItem(props, matte, "imir").index, imirIndex,
  "new 2026 mattes must inherit the primary mirror transform");

console.log("imir property insertion and inheritance checks passed");
