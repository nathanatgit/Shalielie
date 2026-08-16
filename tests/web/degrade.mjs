// Regression test: measuring the photo is an enhancement, never a requirement.
//
// A broken or blocked decoder once took the whole port down with it, and because
// every failure surfaced as the same "unsupported" message, it looked as though no
// photo worked at all. patch() must degrade to the donor values instead.

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { loadProfile } from "../../web/src/zip.js";
import { patch, selectProfile } from "../../web/src/port.js";
import { discoverHeic } from "../../web/src/heif.js";

const ROOT = new URL("../../", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const sha = (b) => createHash("sha256").update(b).digest("hex");

const index = JSON.parse(readFileSync(`${ROOT}web/profiles/index.json`, "utf8"));
const name = process.argv[2] || "IMG_5049";
const folder = name.startsWith("IMG_49") ? "noSmartStyle-people" : "noSmartStyle";
const bytes = new Uint8Array(readFileSync(`${ROOT}${folder}/${name}.HEIC`));
const d = discoverHeic(bytes);
const profile = await loadProfile(new Uint8Array(
  readFileSync(`${ROOT}web/profiles/${index[selectProfile(index, d.primaryTiles.length, d.hdrTiles.length)].file}`)));

let pass = 0, fail = 0;
const check = (label, cond, extra = "") => {
  if (cond) { console.log(`  [PASS] ${label}${extra ? " - " + extra : ""}`); pass++; }
  else { console.log(`  [FAIL] ${label}${extra ? " - " + extra : ""}`); fail++; }
};

// The reference: no decoder offered at all.
const { data: plain } = await patch(bytes, profile, { sceneStats: "donor" });

for (const [label, decode] of [
  ["decoder throws", async () => { throw new Error("boom"); }],
  ["decoder rejects", () => Promise.reject(new Error("blocked by policy"))],
  ["decoder returns nothing", async () => undefined],
  ["decoder returns a short buffer", async () => new Uint8Array(3)],
]) {
  let out, report, threw = null;
  try { ({ data: out, report } = await patch(bytes, profile, {
    decode, sceneStats: "target", lightMaps: "target",
  })); } catch (e) { threw = e; }

  check(`${label}: still produces a file`, !threw, threw ? threw.message : "");
  if (threw) continue;
  check(`${label}: reports it did not measure`, report.decoded === false,
    `decoded=${report.decoded}`);
  check(`${label}: falls back to the donor values`, sha(out) === sha(plain));
}

// And the healthy path must still actually measure.
const { report: good } = await patch(bytes, profile, {
  decode: async (_b, { width, height }) => new Uint8Array(width * height * 3).fill(128),
  sceneStats: "target", lightMaps: "target",
});
check("a working decoder is used", good.decoded === true && !good.decodeError);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
