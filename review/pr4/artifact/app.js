// Artifact-specific shell. Two differences from the GitHub Pages build:
//   * profiles are inlined as base64, since the sandbox blocks relative fetches
//   * decoding uses the browser's own HEIC support (Safari) instead of libheif
//     from a CDN, which the sandbox's CSP blocks
const $ = (id) => document.getElementById(id);

const b64ToBytes = (b64) => {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

const PROFILE_INDEX = Object.fromEntries(Object.entries(PROFILE_DATA).map(
  ([n, p]) => [n, { primary_tiles: p.primary_tiles, hdr_tiles: p.hdr_tiles }]));
const profileCache = new Map();
async function getProfile(name) {
  if (!profileCache.has(name))
    profileCache.set(name, await loadProfile(b64ToBytes(PROFILE_DATA[name].b64)));
  return profileCache.get(name);
}

// --- decoding: only Safari can decode HEIC natively; elsewhere we go without ---
let bitmapCache = new WeakMap();
async function nativeBitmap(bytes) {
  if (bitmapCache.has(bytes)) return bitmapCache.get(bytes);
  const bmp = await createImageBitmap(new Blob([bytes], { type: "image/heic" }));
  bitmapCache.set(bytes, bmp);
  return bmp;
}

async function decodeToRgb(bytes, { width, height, angle = 0, mirror = null }) {
  const bmp = await nativeBitmap(bytes);
  const swap = angle === 90 || angle === 270;
  const rot = document.createElement("canvas");
  rot.width = swap ? bmp.height : bmp.width;
  rot.height = swap ? bmp.width : bmp.height;
  const rctx = rot.getContext("2d", { willReadFrequently: true });
  rctx.translate(rot.width / 2, rot.height / 2);
  if (angle === 90) rctx.rotate(-Math.PI / 2);
  else if (angle === 180) rctx.rotate(Math.PI);
  else if (angle === 270) rctx.rotate(Math.PI / 2);
  if (mirror === 0) rctx.scale(-1, 1);
  else if (mirror === 1) rctx.scale(1, -1);
  rctx.translate(-bmp.width / 2, -bmp.height / 2);
  rctx.drawImage(bmp, 0, 0);

  const small = document.createElement("canvas");
  small.width = width; small.height = height;
  const sctx = small.getContext("2d", { willReadFrequently: true });
  sctx.imageSmoothingEnabled = true;
  sctx.imageSmoothingQuality = "high";
  sctx.drawImage(rot, 0, 0, width, height);
  const { data } = sctx.getImageData(0, 0, width, height);
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0, p = 0; p < data.length; i += 3, p += 4) {
    rgb[i] = data[p]; rgb[i + 1] = data[p + 1]; rgb[i + 2] = data[p + 2];
  }
  return rgb;
}

let canDecode = null;
async function probeDecode(bytes) {
  if (canDecode !== null) return canDecode;
  try { await nativeBitmap(bytes); canDecode = true; }
  catch { canDecode = false; }
  return canDecode;
}

let downloads = null;
let downloadsReady = false;

function chip(text, kind) {
  const s = document.createElement("span");
  s.className = `chip ${kind || ""}`;
  s.textContent = text;
  return s;
}

function makeRow(filename) {
  const el = document.createElement("li");
  el.className = "row";
  el.innerHTML = `<div class="rname"></div><div class="rchips"></div><div class="ract"></div>`;
  el.querySelector(".rname").textContent = filename;
  $("results").appendChild(el);
  $("resultsWrap").hidden = false;
  return {
    chips(items) {
      const c = el.querySelector(".rchips");
      c.textContent = "";
      for (const [t, k] of items) c.appendChild(chip(t, k));
    },
    action(node) {
      const a = el.querySelector(".ract");
      a.textContent = "";
      if (node) a.appendChild(node);
    },
  };
}

/** Identify the container from its magic bytes, so a transcoded upload is obvious. */
function sniff(b) {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b.length > 7 && b[0] === 0x89 && b[1] === 0x50) return "png";
  if (b.length > 11 && String.fromCharCode(b[4], b[5], b[6], b[7]) === "ftyp") {
    const brand = String.fromCharCode(b[8], b[9], b[10], b[11]);
    return /^(hei|mif|msf|avi)/.test(brand) ? "heic" : `iso (${brand.trim()})`;
  }
  return "unknown";
}

/** iOS Safari can hand a File straight to the share sheet, which offers Save Image. */
function canShareFiles(file) {
  try { return Boolean(navigator.canShare && navigator.canShare({ files: [file] })); }
  catch { return false; }
}

function actionButtons(bytes, baseName) {
  const wrap = document.createElement("div");
  wrap.className = "actions";
  const file = new File([bytes], `${baseName}.heic`, { type: "image/heic" });

  if (canShareFiles(file)) {
    const share = document.createElement("button");
    share.className = "save";
    share.textContent = "Save to Photos";
    share.addEventListener("click", async () => {
      share.disabled = true;
      share.textContent = "Opening…";
      try {
        await navigator.share({ files: [file] });
        share.textContent = "Shared";
        share.classList.add("done");
      } catch (e) {
        share.disabled = false;
        share.textContent = e && e.name === "AbortError" ? "Save to Photos" : "Sharing blocked";
      }
    });
    wrap.appendChild(share);
  }

  if (downloadsReady) {
    const btn = document.createElement("button");
    btn.className = wrap.children.length ? "save alt" : "save";
    btn.textContent = wrap.children.length ? "Save as .txt" : "Save file";
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      const original = btn.textContent;
      btn.textContent = "Saving…";
      try {
        await downloads.save({ filename: `${baseName}.txt`, data: bytes.buffer.slice(0) });
        btn.textContent = "Saved — rename to .heic";
        btn.classList.add("done");
      } catch (e) {
        const code = e && e.code;
        btn.disabled = false;
        btn.textContent = code === "declined" ? original : `Couldn't save (${code || "error"})`;
      }
    });
    wrap.appendChild(btn);
  }

  if (!wrap.children.length) {
    const note = document.createElement("span");
    note.className = "nosave";
    note.textContent = "ready — no way to save from this view";
    wrap.appendChild(note);
  }
  return wrap;
}

async function handleFile(file) {
  const row = makeRow(file.name);
  row.chips([["reading", ""]]);
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const kind = sniff(bytes);
    if (kind !== "heic") {
      const why = kind === "jpeg"
        ? "iOS re-encoded this as JPEG on the way in, which throws away everything the port "
          + "needs. Pick the photo through Browse / Files instead of Photo Library — see below."
        : `This is not a HEIC file (looks like ${kind}).`;
      row.chips([[why, "err"]]);
      row.action(null);
      $("iosHelp").hidden = kind !== "jpeg";
      return;
    }
    const d = discoverHeic(bytes);
    const name = selectProfile(PROFILE_INDEX, d.primaryTiles.length, d.hdrTiles.length);
    const profile = await getProfile(name);

    row.chips([["working", ""]]);
    const decodes = await probeDecode(bytes);
    const opts = decodes
      ? { decode: decodeToRgb, sceneStats: "target", lightMaps: "target" }
      : { sceneStats: "donor" };
    const { data, report } = await patch(bytes, profile, opts);

    const chips = [[`layout ${name}`, ""]];
    chips.push(decodes ? ["measured from your photo", "ok"] : ["neutral values", "warn"]);
    const aux = report.mattes.transplanted.length + report.mattes.added.length;
    if (aux) chips.push([`${aux} extra maps kept`, "ok"]);
    if (report.orientation.donor !== report.orientation.target)
      chips.push(["orientation corrected", "ok"]);
    row.chips(chips);

    const base = file.name.replace(/\.(heic|heif)$/i, "") + "_PhotographicStyle";
    row.action(actionButtons(data, base));
  } catch (e) {
    row.chips([[e.message || String(e), "err"]]);
    row.action(null);
  }
}

async function handleFiles(files) {
  for (const f of files) await handleFile(f);
}

const drop = $("drop"), input = $("file");
drop.addEventListener("click", () => input.click());
drop.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); }
});
drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => {
  e.preventDefault(); drop.classList.remove("over");
  handleFiles([...e.dataTransfer.files]);
});
input.addEventListener("change", () => handleFiles([...input.files]));

(async () => {
  $("version").textContent = VERSION;
  $("layouts").textContent = Object.values(PROFILE_INDEX)
    .map((v) => `${v.primary_tiles}/${v.hdr_tiles}`).join(" or ");
  try { downloads = await claude.use("downloads"); } catch { downloads = null; }
  downloadsReady = Boolean(downloads);
  // The .txt caveat only matters if that is the route the viewer will actually take.
  const probe = new File([new Uint8Array([0])], "probe.heic", { type: "image/heic" });
  const shareable = canShareFiles(probe);
  $("saveNote").hidden = shareable || !downloadsReady;
  $("shareNote").hidden = !shareable;
})();
