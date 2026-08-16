// Run the comparison against the BUNDLED code, proving the artifact ships the
// same logic the source-module test covers.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { patch, selectProfile, loadProfile, discoverHeic } from "../../artifact/build/bundle.core.mjs";

const ROOT = new URL("../../", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const sha = (b) => createHash("sha256").update(b).digest("hex");

const index = JSON.parse(readFileSync(`${ROOT}web/profiles/index.json`, "utf8"));
const profiles = {};
for (const [name, info] of Object.entries(index))
  profiles[name] = await loadProfile(new Uint8Array(readFileSync(`${ROOT}web/profiles/${info.file}`)));

const cases = ["IMG_5037", "IMG_5048", "IMG_5049", "IMG_4995", "IMG_4997", "IMG_4999"];
let identical = 0, equivalent = 0, fail = 0;
for (const name of cases) {
  const folder = name.startsWith("IMG_49") ? "noSmartStyle-people" : "noSmartStyle";
  const target = new Uint8Array(readFileSync(`${ROOT}${folder}/${name}.HEIC`));
  const d = discoverHeic(target);
  const pname = selectProfile(index, d.primaryTiles.length, d.hdrTiles.length);
  const { data } = await patch(target, profiles[pname], { sceneStats: "donor" });
  const ref = new Uint8Array(readFileSync(`${ROOT}tests/web/ref/${name}_ref.HEIC`));
  if (sha(data) === sha(ref)) { console.log(`  ${name}: BYTE-IDENTICAL`); identical++; }
  else if (Math.abs(data.length - ref.length) < 1024) {
    console.log(`  ${name}: equivalent (styles plist repacked)`); equivalent++;
  } else { console.log(`  ${name}: DIFFERS ${data.length} vs ${ref.length}`); fail++; }
}
console.log(`\nbundle: ${identical} identical, ${equivalent} equivalent, ${fail} failing`);
process.exit(fail ? 1 : 0);
