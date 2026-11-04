import { loadProfile } from "./src/zip.js";
import { patch, profileFor, VERSION, UNSUPPORTED } from "./src/port.js";
import { discoverHeic } from "./src/heif.js";
import { addTexture, hasTexture } from "./src/texture.js";
import { decodeToRgb, loadLibheif } from "./src/decode.js";
import { convertToHeic, isAppleShapedHeic, canConvert } from "./src/raster.js";
import { estimatePeople } from "./src/faces.js";
import { pickLanguage, rememberLanguage, applyLanguage, t } from "./src/i18n.js";

const $ = (id) => document.getElementById(id);
const fileInput = $("file"), drop = $("drop"), list = $("list"), quality = $("quality");

// Fetch the decoder while the visitor is still choosing a photo (or switches analysis on),
// so the first photo does not wait for the download, and someone just reading the page
// downloads nothing. A failure here is harmless: ensureDecode() tries again and falls back.
const warmDecoder = () => { if (quality.checked) loadLibheif().catch(() => {}); };
quality.addEventListener("change", warmDecoder);
for (const ev of ["pointerdown", "dragenter", "focus"]) drop.addEventListener(ev, warmDecoder, { once: true });

const anyImage = $("anyimage"), findFaces = $("findfaces");
// Any Image takes any picture; otherwise only HEIC photos are offered.
const syncAccept = () => {
  fileInput.accept = anyImage.checked ? "image/*,.heic,.heif" : "image/heic,image/heif,.heic,.heif";
};
anyImage.addEventListener("change", syncAccept);
syncAccept();

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
  el.querySelector(".name").title = name;
  list.appendChild(el);
  // Keep the newest row on screen as its status and buttons fill in.
  new ResizeObserver(() => el.scrollIntoView({ block: "nearest", behavior: "smooth" })).observe(el);
  return {
    set(text, cls) {
      const s = el.querySelector(".status");
      // Only T() strings, which may hold a link; the span keeps it inline in the flex row.
      s.innerHTML = `<span>${text}</span>`;
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

/** Packed RGB of the canvas scaled to width x height, for the analysis of a converted picture. */
async function canvasRgb(canvas, { width, height }) {
  const small = document.createElement("canvas");
  small.width = width; small.height = height;
  const ctx = small.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(canvas, 0, 0, width, height);
  const { data } = ctx.getImageData(0, 0, width, height);
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0, p = 0; p < data.length; i += 3, p += 4) {
    rgb[i] = data[p]; rgb[i + 1] = data[p + 1]; rgb[i + 2] = data[p + 2];
  }
  return rgb;
}

async function handleFile(file) {
  const ui = row(file.name);
  try {
    ui.set(T("st.reading"));
    const bytes = new Uint8Array(await file.arrayBuffer());
    const isHeic = sniff(bytes) === "heic";
    if (!isHeic && !anyImage.checked) { ui.set(T("err.notheic"), "err"); return; }

    // Any Image: a picture that isn't an iPhone-shaped HEIC is converted to one first.
    let source = bytes, converted = null, people = null, peopleNote = null;
    if (anyImage.checked && !(isHeic && isAppleShapedHeic(bytes))) {
      if (!(await canConvert())) { ui.set(T("err.noencoder"), "err"); return; }
      ui.set(T("st.converting"));
      try {
        converted = await convertToHeic(file, bytes, ({ done, total }) =>
          ui.set(`${T("st.converting")} ${done}/${total}`));
      } catch (e) {
        console.error("could not convert", file.name, e);
        ui.set(T("err.badimage"), "err");
        return;
      }
      source = converted.heic;
      if (findFaces.checked) {
        ui.set(T("st.findfaces"));
        const found = await estimatePeople(converted.canvas, ({ stage }) =>
          ui.set(`${T("st.findfaces")} ${stage}`));
        if (found.people) people = found.people;
        else { peopleNote = T("st.nofaces"); console.warn("Find Faces:", found.why); }
      }
    }

    const d = discoverHeic(source);
    const sep = lang === "zh" ? "、" : ", ";
    let data, bits, suffix;
    if (d.stylesItem !== null) {
      // A native iPhone 16/17 style photo is never re-ported (that would replace its real
      // style data); it only gets the iOS 27 Texture/Grain set added.
      if (hasTexture(d.infos)) { ui.set(T("err.hastexture"), "err"); return; }
      ui.set(T("st.working"));
      ({ data } = addTexture(source));
      bits = [T("st.native"), T("st.texture")];
      suffix = "_TextureGrain.HEIC";
    } else {
      // No encoder in the browser, so a photo without a thumbnail needs the desktop tool.
      if (d.thumbnail === null) { ui.set(T("err.nothumb"), "err"); return; }
      // A converted picture only uses the profile's styles plist, so any layout will do.
      const name = converted ? "48-12" : profileFor(profileIndex, d);
      const profile = await getProfile(name);

      // A converted picture is analysed from its own canvas; the decoder is for real HEICs.
      const canDecode = quality.checked ? (converted ? true : await ensureDecode(bytes)) : false;
      ui.set(T("st.working"));
      const decode = converted ? (_data, req) => canvasRgb(converted.canvas, req) : decodeToRgb;
      const opts = canDecode
        ? { decode, sceneStats: "target", lightMaps: "target" }
        : { sceneStats: "donor" };
      if (converted) { opts.generic = true; if (people) opts.people = people; }
      else if (anyImage.checked) opts.sdr = true;
      let report;
      ({ data, report } = await patch(source, profile, opts));
      // patch() degrades rather than failing when the decoder misbehaves, so trust
      // what it reports it actually did, not what we asked for.
      if (report.decodeError) console.warn("decoder unavailable:", report.decodeError);

      bits = [T(report.decoded ? "st.matched" : "st.neutral")];
      if (report.mattes.added.some((m) => m.startsWith("depth"))) bits.push(T("st.portrait"));
      else if (report.mattes.transplanted.length) bits.push(T("st.people"));
      if (report.texture !== "off") bits.push(T("st.texture"));
      if (converted) bits.unshift(T("st.converted"));
      if (people) bits.push(T("st.faces"));
      else if (peopleNote) bits.push(peopleNote);
      suffix = "_PhotographicStyle.HEIC";
    }
    ui.set(`${T("st.ready")} — ${bits.join(sep)}`, "ok");

    const outName = file.name.replace(/\.[A-Za-z0-9]+$/, "") + suffix;
    // On iPhone the share sheet lands the file straight in Photos; elsewhere a plain
    // download is the shorter route.
    const shareFile = new File([data], outName, { type: "image/heic" });
    if (navigator.canShare && navigator.canShare({ files: [shareFile] })) ui.share(shareFile);
    ui.link(new Blob([data], { type: "image/heic" }), outName);
    return true;
  } catch (e) {
    // Past the format sniff, every remaining rejection means the same thing to a
    // visitor: this is a HEIC, but not one this build can handle. The real reason
    // still goes to the console, because "unsupported" on every photo is exactly
    // how a bug elsewhere would look.
    console.error("could not port", file.name, e);
    ui.set(T("err.unsupported"), "err");
  }
}

const CHECK = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm-1.2 14.4-4-4 1.4-1.4 2.6 2.6 5.4-5.4 1.4 1.4Z"/></svg>';
const WARN = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3 1.5 21h21Zm-1 6h2v6h-2Zm0 8h2v2h-2Z"/></svg>';
const fill = (text, values) => text.replace(/\{(\w+)\}/g, (_, k) => values[k]);

/** The batch, as in the Share sheet: a progress bar while styling, then a check and a count. */
function showSummary(done, total, ready, finished) {
  const box = $("summary");
  box.classList.add("show");
  $("sumbar").hidden = finished;
  $("sumbar").value = done;
  $("sumbar").max = Math.max(total, 1);
  const icon = $("sumicon");
  icon.hidden = !finished;
  icon.className = ready === total ? "ok" : "warn";
  icon.innerHTML = ready === total ? CHECK : WARN;
  $("sumhead").textContent = !finished
    ? fill(T("sum.working"), { n: Math.min(done + 1, total), total })
    : ready === total
      ? (ready === 1 ? T("sum.one") : fill(T("sum.many"), { n: ready }))
      : fill(T("sum.partial"), { n: ready, total });
  $("sumnote").textContent = finished ? T("sum.note") : "";
  $("sumnote").hidden = !finished;
}

async function handleFiles(files) {
  if (!files.length) return;
  document.querySelector("main").classList.add("folded");
  let ready = 0;
  showSummary(0, files.length, 0, false);
  for (const [index, f] of files.entries()) {
    if (await handleFile(f)) ready++;
    showSummary(index + 1, files.length, ready, index + 1 === files.length);
  }
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

$("more").addEventListener("click", () => document.querySelector("main").classList.remove("folded"));

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

// Keep installation and offline support progressive: unsupported browsers use
// the page exactly as before, while HTTPS/localhost deployments gain a PWA.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js", { scope: "./" })
      .catch((e) => console.warn("offline support unavailable:", e));
  });
}
