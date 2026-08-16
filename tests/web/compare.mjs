// Compare the JS port against the Python reference.
// Every item must be byte-identical, except the styles plist when it is rewritten:
// plistlib and this bplist writer pack objects differently, so that one is compared
// semantically instead.

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { loadProfile } from "../../web/src/zip.js";
import { patch, selectProfile } from "../../web/src/port.js";
import { discoverHeic, extractItem, auxUriForItem } from "../../web/src/heif.js";
import { parseBplist } from "../../web/src/bplist.js";

const ROOT = new URL("../../", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const sha = (b) => createHash("sha256").update(b).digest("hex");

function deepEqual(a, b, path = "") {
  if (a instanceof Map && b instanceof Map) {
    const ka = [...a.keys()].sort(), kb = [...b.keys()].sort();
    if (ka.join("|") !== kb.join("|")) return `keys differ at ${path}`;
    for (const k of ka) {
      const r = deepEqual(a.get(k), b.get(k), `${path}/${k}`);
      if (r) return r;
    }
    return null;
  }
  if (a instanceof Uint8Array && b instanceof Uint8Array) {
    if (a.length !== b.length) return `data length ${a.length} vs ${b.length} at ${path}`;
    for (let i = 0; i < a.length; i++)
      if (a[i] !== b[i]) return `data byte ${i} at ${path}`;
    return null;
  }
  if (typeof a === "number" && typeof b === "number")
    return Math.abs(a - b) < 1e-9 || Math.abs(a - b) < Math.abs(a) * 1e-12
      ? null : `number ${a} vs ${b} at ${path}`;
  return a === b ? null : `value ${a} vs ${b} at ${path}`;
}

const index = JSON.parse(readFileSync(`${ROOT}web/profiles/index.json`, "utf8"));
const profiles = {};
for (const [name, info] of Object.entries(index))
  profiles[name] = await loadProfile(new Uint8Array(readFileSync(`${ROOT}web/profiles/${info.file}`)));

const cases = ["IMG_5037", "IMG_5048", "IMG_5049", "IMG_4995", "IMG_4997", "IMG_4999"];
let pass = 0, fail = 0;

for (const name of cases) {
  const folder = name.startsWith("IMG_49") ? "noSmartStyle-people" : "noSmartStyle";
  const target = new Uint8Array(readFileSync(`${ROOT}${folder}/${name}.HEIC`));
  const d = discoverHeic(target);
  const pname = selectProfile(index, d.primaryTiles.length, d.hdrTiles.length);
  const { data: js } = await patch(target, profiles[pname], { sceneStats: "donor" });
  const py = new Uint8Array(readFileSync(`${ROOT}tests/web/ref/${name}_ref.HEIC`));

  if (sha(js) === sha(py)) { console.log(`  ${name}: BYTE-IDENTICAL (${js.length})`); pass++; continue; }

  const dj = discoverHeic(js), dp = discoverHeic(py);
  const ids = [...new Set([...dj.iloc.items.keys(), ...dp.iloc.items.keys()])].sort((a, b) => a - b);
  const problems = [];
  for (const iid of ids) {
    let a = null, b = null;
    try { a = extractItem(js, dj.iloc, iid); } catch {}
    try { b = extractItem(py, dp.iloc, iid); } catch {}
    if (!a && !b) continue;
    if (!a || !b) { problems.push(`item ${iid} present in only one output`); continue; }
    if (a.length === b.length && a.every((v, i) => v === b[i])) continue;
    if (iid === dj.stylesItem && iid === dp.stylesItem) {
      const r = deepEqual(parseBplist(a), parseBplist(b));
      if (r) problems.push(`styles plist ${r}`);
      continue; // packing differences are fine
    }
    problems.push(`item ${iid} (${dj.infos.get(iid)?.type}${
      auxUriForItem(dj.props, iid) ? " " + auxUriForItem(dj.props, iid).split(":").pop() : ""
    }) differs: ${a.length} vs ${b.length}`);
  }
  if (dj.infos.size !== dp.infos.size)
    problems.push(`item count ${dj.infos.size} vs ${dp.infos.size}`);
  if (dj.props.properties.length !== dp.props.properties.length)
    problems.push(`ipco count ${dj.props.properties.length} vs ${dp.props.properties.length}`);

  if (!problems.length) {
    console.log(`  ${name}: EQUIVALENT (styles plist repacked, all items match)`);
    pass++;
  } else {
    console.log(`  ${name}: DIFFERS`);
    problems.forEach((p) => console.log(`      ${p}`));
    fail++;
  }
}
console.log(`\n${pass} matching, ${fail} failing`);
process.exit(fail ? 1 : 0);
