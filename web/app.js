import { loadProfile } from "./src/zip.js";
import { patch, selectProfile, VERSION, UNSUPPORTED } from "./src/port.js";
import { discoverHeic } from "./src/heif.js";
import { decodeToRgb, loadLibheif } from "./src/decode.js";
import { pickLanguage, rememberLanguage, applyLanguage, t } from "./src/i18n.js";

const $ = (id) => document.getElementById(id);
const fileInput = $("file"), drop = $("drop"), list = $("list"), quality = $("quality");

let lang = pickLanguage();
const T = (key) => t(lang, key);

let profileIndex = null;
const profileCache = new Map();

async function getProfile(name) {
  if (!profileCache.has(name)) {
    const res = await fetch(`profiles/${profileIndex[name].file}`);
    if (!res.ok) throw new Error(UNSUPPORTED);
    profileCache.set(name, await loadProfile(new Uint8Array(await res.arrayBuffer())));
  }
  return profileCache.get(name);
}

let decodeAvailable = null;
async function ensureDecode() {
  if (decodeAvailable !== null) return decodeAvailable;
  try { await loadLibheif(); decodeAvailable = true; }
  catch { decodeAvailable = false; }
  return decodeAvailable;
}

/** Identify the container from its magic bytes, so a transcoded upload is obvious. */
function sniff(b) {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b.length > 7 && b[0] === 0x89 && b[1] === 0x50) return "png";
  if (b.length > 11 && String.fromCharCode(b[4], b[5], b[6], b[7]) === "ftyp") {
    const brand = String.fromCharCode(b[8], b[9], b[10], b[11]);
    return /^(hei|mif|msf|avi)/.test(brand) ? "heic" : "iso";
  }
  return "unknown";
}

function row(name) {
  const el = document.createElement("div");
  el.className = "row";
  el.innerHTML = `<div class="name"></div><div class="status"></div><div class="act"></div>`;
  el.querySelector(".name").textContent = name;
  list.appendChild(el);
  return {
    set(text, cls) {
      const s = el.querySelector(".status");
      s.textContent = text;
      s.className = `status ${cls || ""}`;
    },
    link(blob, filename) {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.textContent = T("btn.download");
      a.className = el.querySelector(".act").children.length ? "dl alt" : "dl";
      el.querySelector(".act").appendChild(a);
    },
    share(file) {
      const b = document.createElement("button");
      b.className = "dl";
      b.type = "button";
      b.textContent = T("btn.save");
      b.addEventListener("click", async () => {
        try { await navigator.share({ files: [file] }); }
        catch (e) { if (e.name !== "AbortError") b.textContent = T("btn.blocked"); }
      });
      el.querySelector(".act").appendChild(b);
    },
  };
}

async function handleFile(file) {
  const ui = row(file.name);
  try {
    ui.set(T("st.reading"));
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (sniff(bytes) !== "heic") { ui.set(T("err.notheic"), "err"); return; }

    const d = discoverHeic(bytes);
    const name = selectProfile(profileIndex, d.primaryTiles.length, d.hdrTiles.length);
    const profile = await getProfile(name);

    const canDecode = quality.checked ? await ensureDecode() : false;
    ui.set(T("st.working"));
    const opts = canDecode
      ? { decode: decodeToRgb, sceneStats: "target", lightMaps: "target" }
      : { sceneStats: "donor" };
    const { data, report } = await patch(bytes, profile, opts);

    const bits = [T(canDecode ? "st.matched" : "st.neutral")];
    if (report.mattes.added.some((m) => m.startsWith("depth"))) bits.push(T("st.portrait"));
    else if (report.mattes.transplanted.length) bits.push(T("st.people"));
    ui.set(`${T("st.ready")} — ${bits.join(lang === "zh" ? "、" : ", ")}`, "ok");

    const outName = file.name.replace(/\.(heic|heif)$/i, "") + "_PhotographicStyle.HEIC";
    // On iPhone the share sheet lands the file straight in Photos; elsewhere a plain
    // download is the shorter route.
    const shareFile = new File([data], outName, { type: "image/heic" });
    if (navigator.canShare && navigator.canShare({ files: [shareFile] })) ui.share(shareFile);
    ui.link(new Blob([data], { type: "image/heic" }), outName);
  } catch {
    // Past the format sniff, every remaining rejection means the same thing to a
    // visitor: this is a HEIC, but not one this build can handle.
    ui.set(T("err.unsupported"), "err");
  }
}

async function handleFiles(files) {
  for (const f of files) await handleFile(f);
}

drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => {
  e.preventDefault();
  drop.classList.remove("over");
  handleFiles([...e.dataTransfer.files]);
});
drop.addEventListener("click", () => fileInput.click());
drop.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); }
});
fileInput.addEventListener("change", () => handleFiles([...fileInput.files]));

$("lang").addEventListener("click", () => {
  lang = lang === "zh" ? "en" : "zh";
  rememberLanguage(lang);
  applyLanguage(lang);
});

(async () => {
  applyLanguage(lang);
  $("version").textContent = VERSION;
  try {
    profileIndex = await (await fetch("profiles/index.json")).json();
  } catch (e) {
    $("boot").textContent = e.message;
    $("boot").className = "err";
  }
})();
