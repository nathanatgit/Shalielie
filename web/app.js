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

// Probe with a real decode of a real photo. Checking only that the script loaded
// says nothing about whether it can actually decode, and a decoder that loads but
// cannot decode is the failure mode that is hardest to notice.
let decodeAvailable = null;
async function ensureDecode(bytes) {
  if (decodeAvailable !== null) return decodeAvailable;
  try {
    await loadLibheif();
    await decodeToRgb(bytes, { width: 8, height: 8 });
    decodeAvailable = true;
  } catch (e) {
    console.warn("image analysis unavailable, using neutral settings:", e);
    decodeAvailable = false;
  }
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

    const canDecode = quality.checked ? await ensureDecode(bytes) : false;
    ui.set(T("st.working"));
    const opts = canDecode
      ? { decode: decodeToRgb, sceneStats: "target", lightMaps: "target" }
      : { sceneStats: "donor" };
    const { data, report } = await patch(bytes, profile, opts);
    // patch() degrades rather than failing when the decoder misbehaves, so trust
    // what it reports it actually did, not what we asked for.
    if (report.decodeError) console.warn("decoder unavailable:", report.decodeError);

    const bits = [T(report.decoded ? "st.matched" : "st.neutral")];
    if (report.mattes.added.some((m) => m.startsWith("depth"))) bits.push(T("st.portrait"));
    else if (report.mattes.transplanted.length) bits.push(T("st.people"));
    ui.set(`${T("st.ready")} — ${bits.join(lang === "zh" ? "、" : ", ")}`, "ok");

    const outName = file.name.replace(/\.(heic|heif)$/i, "") + "_PhotographicStyle.HEIC";
    // On iPhone the share sheet lands the file straight in Photos; elsewhere a plain
    // download is the shorter route.
    const shareFile = new File([data], outName, { type: "image/heic" });
    if (navigator.canShare && navigator.canShare({ files: [shareFile] })) ui.share(shareFile);
    ui.link(new Blob([data], { type: "image/heic" }), outName);
  } catch (e) {
    // Past the format sniff, every remaining rejection means the same thing to a
    // visitor: this is a HEIC, but not one this build can handle. The real reason
    // still goes to the console, because "unsupported" on every photo is exactly
    // how a bug elsewhere would look.
    console.error("could not port", file.name, e);
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

// Visit counter behind the README badge. The only request this site makes to a
// third party, and it carries nothing but the fact that the page was opened —
// no photo ever reaches it. Fired once per browser session so a reload is not a
// new visit, and fire-and-forget: a counter that is down is not worth an error.
// If sessionStorage is blocked the visit goes uncounted, which undercounts
// rather than counting every reload of a private-mode window as a new visitor.
function countVisit() {
  try {
    if (sessionStorage.getItem("counted")) return;
    sessionStorage.setItem("counted", "1");
  } catch (e) {
    return;
  }
  fetch("https://abacus.jasoncameron.dev/hit/nathanatgit-shalielie/web").catch(() => {});
}

(async () => {
  applyLanguage(lang);
  $("version").textContent = VERSION;
  countVisit();
  try {
    profileIndex = await (await fetch("profiles/index.json")).json();
  } catch (e) {
    $("boot").textContent = e.message;
    $("boot").className = "err";
  }
})();
