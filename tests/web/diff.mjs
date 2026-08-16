// Localize where the JS output diverges from the Python reference.
import { readFileSync } from "node:fs";
import { loadProfile } from "../../web/src/zip.js";
import { patch, selectProfile } from "../../web/src/port.js";
import { discoverHeic, extractItem, parseIpcoIpma, auxUriForItem } from "../../web/src/heif.js";
import { topBox } from "../../web/src/box.js";

const ROOT = new URL("../../", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const index = JSON.parse(readFileSync(`${ROOT}web/profiles/index.json`, "utf8"));
const name = process.argv[2] || "IMG_5037";
const folder = name.startsWith("IMG_49") ? "noSmartStyle-people" : "noSmartStyle";

const target = new Uint8Array(readFileSync(`${ROOT}${folder}/${name}.HEIC`));
const d0 = discoverHeic(target);
const pname = selectProfile(index, d0.primaryTiles.length, d0.hdrTiles.length);
const profile = await loadProfile(new Uint8Array(readFileSync(`${ROOT}web/profiles/${index[pname].file}`)));
const { data: js } = await patch(target, profile, { sceneStats: "donor" });
const py = new Uint8Array(readFileSync(`${ROOT}tests/web/ref/${name}_ref.HEIC`));

console.log(`${name}: js=${js.length} py=${py.length} delta=${js.length - py.length}`);
const dj = discoverHeic(js), dp = discoverHeic(py);
const mj = topBox(js, "meta"), mp = topBox(py, "meta");
console.log(`  meta size: js=${mj.size} py=${mp.size}`);
console.log(`  item count: js=${dj.infos.size} py=${dp.infos.size}`);
console.log(`  ipco props: js=${dj.props.properties.length} py=${dp.props.properties.length}`);

const ids = [...new Set([...dj.iloc.items.keys(), ...dp.iloc.items.keys()])].sort((a, b) => a - b);
for (const iid of ids) {
  let a = null, b = null;
  try { a = extractItem(js, dj.iloc, iid); } catch {}
  try { b = extractItem(py, dp.iloc, iid); } catch {}
  if (!a && !b) continue;
  const same = a && b && a.length === b.length && a.every((v, i) => v === b[i]);
  if (!same) {
    const t = dj.infos.get(iid)?.type ?? dp.infos.get(iid)?.type;
    const aux = auxUriForItem(dj.props, iid) || "";
    console.log(`  item ${iid} (${t}${aux ? " " + aux.split(":").pop() : ""}): `
      + `js=${a ? a.length : "-"} py=${b ? b.length : "-"}`);
    if (a && b) {
      const n = Math.min(a.length, b.length);
      let first = -1;
      for (let i = 0; i < n; i++) if (a[i] !== b[i]) { first = i; break; }
      console.log(`      first byte diff at ${first}`);
    }
  }
}
