import { inspectionComparator } from "./src/inspection-compare.js?v=0.6.0-web";
import { loadProfile } from "./src/zip.js?v=0.6.0-web";
import { prepareIsolation } from "./src/isolation.js?v=0.6.0-web";
import { patch, selectProfile, VERSION } from "./src/port.js?v=0.6.0-web";
import {
  discoverHeic, extractItem,
  irotAngleForItem, imirAxisForItem, auxUriForItem, MATTE_URIS,
} from "./src/heif.js?v=0.6.0-web";
import { addTexture, hasTexture, preferNativeSkin } from "./src/texture.js?v=0.6.0-web";
import { decodeToRgb, decodeToDisplayCanvas, loadLibheif } from "./src/decode.js?v=0.6.0-web";
import { generateFaceMattes, rebuildFaceMattes } from "./src/face-mattes.js?v=0.6.0-web";
import {
  hasNativeFaceMattes, buildHeicInspection, INSPECTION_NAMES,
} from "./src/native-mattes.js?v=0.6.0-web";
import { diagnosePortError } from "./src/errors.js?v=0.6.0-web";
import { pickLanguage, rememberLanguage, applyLanguage, t, ITEM_LABEL_KEYS } from "./src/i18n.js?v=0.6.0-web";
import {
  importRaster, extractPortraitDepth, prepareHeicAuxiliaries, prepareHeicLinearThumbnail,
} from "./src/raster-import.js?v=0.6.0-web";

const $ = (id) => document.getElementById(id);
const isolationReady = prepareIsolation();
const fileInput = $("file"), drop = $("drop"), list = $("list"), quality = $("quality"),
  faces = $("faces");
let processingQueue = Promise.resolve();
let thumbnailQueue = Promise.resolve();

function enqueue(task) {
  const result = processingQueue.catch(() => {}).then(task);
  processingQueue = result;
  return result;
}

function presentResult(ui, data, filename, input = null, artifacts = null, correction = null) {
  const file = new File([data], filename, {type: "image/heic"});
  ui.replaceResult();
  ui.compare(input, data, filename, artifacts);
  if (correction) {
    Object.assign(correction, {ui, filename, input});
    ui.correctFaces(correction);
  }
  ui.link(file, filename);
  if (navigator.canShare && navigator.canShare({files: [file]})) ui.share(file);
  ui.thumbnail(file, filename);
}

function faceCorrection(faceResult, rebuild, data) {
  return faceResult.review?.items.length && typeof rebuild === "function"
    ? {review: faceResult.review, original: faceResult, rebuild, baseData: data,
      excluded: new Set(), busy: false} : null;
}

function prepareFile(file) {
  const ui = row(file.name);
  ui.thumbnail(file, file.name, true);
  ui.set(T("st.queued"));
  return enqueue(async () => {
    await isolationReady;
    if (!profileIndex) profileIndex = await (await fetch("profiles/index.json")).json();
    await handleFile(file, ui);
  }).catch(error => ui.set(`${T("err.unexpected")} (${error.message})`, "err"));
}

const comparePreview = $("compare-preview"), compareName = $("compare-name"),
  compareClose = $("compare-close"), compareGrid = $("compare-grid");
let compareUrls = [];
let comparisonGeneration = 0;
const comparisonOverlay = $("comparison-overlay"), overlayImage = $("comparison-overlay-image"),
  overlayDownload = $("comparison-overlay-download");

function closeComparison() {
  comparisonGeneration++;
  comparisonOverlay.hidden = true;
  comparisonOverlay.open = false;
  overlayImage.removeAttribute("src");
  overlayDownload.removeAttribute("href");
  comparePreview.hidden = true;
  compareGrid.replaceChildren();
  compareUrls.forEach((url) => URL.revokeObjectURL(url));
  compareUrls = [];
  document.body.style.overflow = "";
}

function inspectionCell(entry) {
  const cell = document.createElement("div");
  cell.className = `inspection-cell ${entry?.present ? "present" : "missing"}`;
  if (!entry?.present) { cell.textContent = T("inspect.missing"); return cell; }
  const badge = document.createElement("div");
  badge.className = "inspection-badge";
  badge.textContent = entry.itemIds?.length
    ? `${T("inspect.present")} · item ${entry.itemIds.map((id) => `#${id}`).join(", ")}`
    : T("inspect.present");
  cell.appendChild(badge);
  if (entry.name === "HDR gain map") {
    const hint = document.createElement("small");
    hint.textContent = T("inspect.gainMapHint");
    cell.appendChild(hint);
  }
  for (const preview of entry.previews || []) {
    const url = URL.createObjectURL(preview.blob);
    compareUrls.push(url);
    const img = document.createElement("img");
    img.src = url;
    img.alt = entry.name;
    cell.appendChild(img);
    const download = document.createElement("a");
    download.href = url;
    download.download = `${entry.name.replace(/[^a-z0-9_-]/gi, "_")}_item_${preview.itemId}.png`;
    download.textContent = T("btn.debugDownload");
    download.className = "dl alt";
    cell.appendChild(download);
    if (Number.isFinite(preview.coverage)) {
      const coverage = document.createElement("small");
      coverage.textContent = `${T("inspect.coverage")}: ${(preview.coverage * 100).toFixed(2)}%`;
      cell.appendChild(coverage);
    }
  }
  if (entry.value !== undefined) {
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = T("inspect.metadata");
    const pre = document.createElement("pre");
    pre.textContent = JSON.stringify(entry.value, null, 2);
    details.append(summary, pre);
    cell.appendChild(details);
  }
  for (const failure of entry.errors || []) {
    const error = document.createElement("small");
    error.className = "err";
    error.textContent = `${T("inspect.decodeFailed")} #${failure.itemId}: ${failure.error}`;
    cell.appendChild(error);
  }
  return cell;
}

async function openComparison(input, output, filename, artifacts = null) {
  closeFaceReview();
  closeComparison();
  const generation = comparisonGeneration;
  if (artifacts?.overlay) {
    const url = URL.createObjectURL(artifacts.overlay);
    compareUrls.push(url);
    overlayImage.src = url;
    overlayImage.alt = T("debug.overlay");
    overlayDownload.href = url;
    overlayDownload.download = `${filename.replace(/\.(heic|heif)$/i, "")}_DetectionOverlay.png`;
    comparisonOverlay.hidden = false;
  }
  compareName.textContent = `${T("inspect.title")} — ${filename}`;
  compareGrid.textContent = T("inspect.loading");
  comparePreview.hidden = false;
  document.body.style.overflow = "hidden";
  compareClose.focus();
  try {
    const inspect = async (bytes) => {
      if (!bytes) return null;
      const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      return buildHeicInspection(data, discoverHeic(data));
    };
    const [before, after] = await Promise.all([inspect(input), inspect(output)]);
    if (generation !== comparisonGeneration) return;
    const compare = inspectionComparator(input ? new Uint8Array(input) : null, output ? new Uint8Array(output) : null);
    compareGrid.replaceChildren();
    const hint = document.createElement("div"); hint.className = "inspection-comparison-hint";
    hint.textContent = T("inspect.compareHint"); compareGrid.append(hint);
    for (const text of [T("inspect.item"), T("inspect.before"), T("inspect.after")]) {
      const head = document.createElement("div"); head.className = "inspection-head";
      head.textContent = text; compareGrid.appendChild(head);
    }
    for (const name of INSPECTION_NAMES) {
      const label = document.createElement("div"); label.className = "inspection-name";
      label.textContent = T(ITEM_LABEL_KEYS[name]);
      const identifier = document.createElement("code"); identifier.className = "inspection-identifier";
      identifier.textContent = name; label.append(identifier);
      const comparison = compare.explain(before?.entries.get(name), after?.entries.get(name));
      const status = comparison.status;
      const badge = document.createElement("span"); badge.className = `inspection-match ${status}`;
      const statusKeys = {same: "inspect.same", different: "inspect.different", added: "inspect.added",
        removed: "inspect.removed", missing: "inspect.missing", unknown: "inspect.unknown", orderOnly: "inspect.orderOnly"};
      badge.dataset.comparison = status; badge.textContent = T(statusKeys[status]);
      label.append(badge);
      const reasons = [...comparison.differences,...(comparison.orderChanges || [])];
      if(reasons.length || comparison.error) {
        const details=document.createElement('details'); details.className='inspection-differences';
        const summary=document.createElement('summary'); summary.textContent=T("inspect.showDifferences");
        details.append(summary);
        const byteHint=document.createElement('p'); byteHint.textContent=T("inspect.diffBytesHint"); details.append(byteHint);
        if(comparison.orderChanges?.length) {const note=document.createElement('p');note.textContent=T("inspect.orderHint");details.append(note);}
        if(comparison.ownDataSame && reasons.length) {
          const hint=document.createElement('p'); hint.textContent=T("inspect.linkedOnly"); details.append(hint);
        }
        const kindKeys={payload:"inspect.diffPayload",serialization:"inspect.diffSerialization",property:"inspect.diffProperty",
          propertyOrder:"inspect.diffPropertyOrder",reference:"inspect.diffReference",type:"inspect.diffType",itemCount:"inspect.diffCount",field:"inspect.diffField"};
        for(const difference of reasons.slice(0,40)) {
          const reason=document.createElement('details'), title=document.createElement('summary'), pre=document.createElement('pre');
          title.textContent=`${difference.path} · ${T(kindKeys[difference.kind])}`;
          pre.textContent=`${T("inspect.before")}: ${JSON.stringify(difference.before,null,2)}\n${T("inspect.after")}: ${JSON.stringify(difference.after,null,2)}`;
          reason.append(title,pre); details.append(reason);
        }
        if(comparison.error) {const error=document.createElement('p');error.textContent=comparison.error;details.append(error);}
        if(reasons.length>40) {const note=document.createElement('p');note.textContent=T("inspect.diffMore").replace('{count}',reasons.length-40);details.append(note);}
        const download=document.createElement('button'); download.type='button';download.className='diag-copy';download.textContent=T("inspect.diffDownload");
        download.addEventListener('click',()=>{
          const url=URL.createObjectURL(new Blob([JSON.stringify(comparison,null,2)],{type:'application/json'}));
          const a=document.createElement('a');a.href=url;a.download=`${name.replace(/[^a-z0-9_-]/gi,'_')}_differences.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
        });
        details.append(download);label.append(details);
      }
      compareGrid.appendChild(label);
      compareGrid.appendChild(inspectionCell(before?.entries.get(name)));
      compareGrid.appendChild(inspectionCell(after?.entries.get(name)));
    }
  } catch (error) {
    if (generation !== comparisonGeneration) return;
    compareGrid.textContent = `${T("inspect.failed")}: ${error?.message || error}`;
  }
}

compareClose.addEventListener("click", closeComparison);
comparePreview.addEventListener("click", (event) => {
  if (event.target === comparePreview) closeComparison();
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (!comparePreview.hidden) closeComparison();
});

const facePreview = $("face-preview"), faceName = $("face-name"), faceStage = $("face-stage"),
  faceViewport = $("face-viewport"), faceChoices = $("face-choices"), faceCounts = $("face-counts"),
  faceApply = $("face-apply"), faceCancel = $("face-cancel"), faceClose = $("face-close"),
  faceZoom = $("face-zoom-value");
let faceSession = null;

function selectionCounts(total, excluded) {
  return T("review.counts").replace("{kept}", total - excluded).replace("{excluded}", excluded);
}

function faceCountText(total, excluded) {
  return excluded ? `${T("review.corrected")} · ${selectionCounts(total, excluded)}`
    : T("review.detected").replace("{count}", total);
}

function closeFaceReview() {
  if (!faceSession) return;
  const {state} = faceSession;
  faceSession = null;
  facePreview.hidden = true; faceStage.replaceChildren(); faceChoices.replaceChildren();
  document.body.style.overflow = "";
  state.ui.el.querySelector(".face-correct")?.focus();
}

function renderFaceSelections() {
  const {state, draft} = faceSession;
  for (const button of facePreview.querySelectorAll("[data-face-id]")) {
    const id = Number(button.dataset.faceId), excluded = draft.has(id);
    button.dataset.excluded = String(excluded);
    button.setAttribute("aria-pressed", String(!excluded));
    button.setAttribute("aria-label", T("review.face").replace("{number}", id + 1)
      + ` · ${T(excluded ? "review.excluded" : "review.kept")}`);
    button.querySelector("span").textContent = button.classList.contains("face-box")
      ? `${id + 1}${excluded ? " ×" : ""}`
      : `${id + 1} · ${T(excluded ? "review.excluded" : "review.kept")}`;
  }
  faceCounts.textContent = selectionCounts(state.review.items.length, draft.size);
  faceApply.disabled = draft.size === state.excluded.size && [...draft].every(id => state.excluded.has(id));
}

function toggleReviewFace(id) {
  const {draft} = faceSession;
  if (draft.has(id)) draft.delete(id); else draft.add(id);
  renderFaceSelections();
}

function setFaceZoom(value) {
  const session = faceSession;
  if (!session) return;
  session.zoom = Math.max(1, Math.min(3, value));
  faceStage.style.width = `${session.zoom * 100}%`;
  faceZoom.textContent = `${Math.round(session.zoom * 100)}%`;
  $("face-zoom-out").disabled = session.zoom === 1;
  $("face-zoom-in").disabled = session.zoom === 3;
}

function openFaceReview(state) {
  if (state.busy) return;
  closeComparison(); closeFaceReview();
  faceSession = {state, draft: new Set(state.excluded), zoom: 1};
  faceName.textContent = `${T("review.title")} — ${state.filename}`;
  const display = state.review.display, preview = document.createElement("canvas");
  preview.width = display.width; preview.height = display.height;
  preview.getContext("2d").drawImage(display, 0, 0);
  preview.setAttribute("role", "img"); preview.setAttribute("aria-label", state.filename);
  faceStage.append(preview);
  for (const {id, rect} of state.review.items) {
    const box = document.createElement("button"), badge = document.createElement("span");
    box.type = "button"; box.className = "face-box"; box.dataset.faceId = id;
    Object.assign(box.style, {left: `${rect.x * 100}%`, top: `${rect.y * 100}%`,
      width: `${rect.width * 100}%`, height: `${rect.height * 100}%`});
    box.append(badge); box.addEventListener("click", () => toggleReviewFace(id)); faceStage.append(box);
    const choice = document.createElement("button"), crop = document.createElement("canvas"), label = document.createElement("span");
    choice.type = "button"; choice.className = "face-choice"; choice.dataset.faceId = id;
    crop.width = 96; crop.height = 96;
    const x = rect.x * display.width, y = rect.y * display.height,
      w = Math.max(1, rect.width * display.width), h = Math.max(1, rect.height * display.height);
    const scale = Math.min(96 / w, 96 / h);
    crop.getContext("2d").drawImage(display, x, y, w, h, (96 - w * scale) / 2,
      (96 - h * scale) / 2, w * scale, h * scale);
    choice.append(crop, label);
    choice.addEventListener("click", () => {
      toggleReviewFace(id);
      faceViewport.scrollTo({left: (rect.x + rect.width / 2) * faceStage.clientWidth - faceViewport.clientWidth / 2,
        top: (rect.y + rect.height / 2) * faceStage.clientHeight - faceViewport.clientHeight / 2});
    });
    faceChoices.append(choice);
  }
  facePreview.hidden = false; document.body.style.overflow = "hidden";
  setFaceZoom(1); renderFaceSelections();
  faceViewport.scrollTo(0, 0); faceClose.focus();
}

async function applyFaceReview() {
  if (!faceSession || faceApply.disabled) return;
  const {state, draft} = faceSession, desired = new Set(draft), ui = state.ui;
  closeFaceReview();
  state.busy = true; ui.resultBusy(true); ui.set(T("review.queued"));
  try {
    await enqueue(async () => {
      let result = state.original, data = state.baseData;
      if (desired.size) {
        result = await rebuildFaceMattes(state.review, [...desired],
          {onProgress: progress => updateFaceProgress(ui, progress)});
        ui.set(T("st.working")); await yieldToBrowser();
        data = await state.rebuild(result);
      }
      // Commit the selection only after the complete replacement HEIC is available.
      state.excluded = desired;
      presentResult(ui, data, state.filename, state.input, result.debugArtifacts, state);
      ui.set(T("review.updated"), "ok");
    });
  } catch (error) {
    console.error("face correction unavailable:", error);
    ui.set(`${T("review.failed")} (${error.message})`, "err");
  } finally {
    state.busy = false; ui.resultBusy(false);
    ui.el.querySelector(".face-correct")?.focus();
  }
}

faceClose.addEventListener("click", closeFaceReview);
faceCancel.addEventListener("click", closeFaceReview);
faceApply.addEventListener("click", applyFaceReview);
facePreview.addEventListener("click", event => {if (event.target === facePreview) closeFaceReview();});
$("face-zoom-in").addEventListener("click", () => setFaceZoom(faceSession.zoom + .5));
$("face-zoom-out").addEventListener("click", () => setFaceZoom(faceSession.zoom - .5));
document.addEventListener("keydown", event => {
  if (!faceSession) return;
  if (event.key === "Escape") {event.preventDefault(); closeFaceReview();}
  if (event.key === "Tab") {
    const controls = [...facePreview.querySelectorAll("button:not(:disabled)")];
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) {event.preventDefault(); last.focus();}
    else if (!event.shiftKey && document.activeElement === last) {event.preventDefault(); first.focus();}
  }
});

let lang = pickLanguage();
const T = (key) => t(lang, key);

let profileIndex = null;
const profileCache = new Map();

async function getProfile(name) {
  if (!profileCache.has(name)) {
    let res;
    try {
      res = await fetch(`profiles/${profileIndex[name].file}`);
    } catch (error) {
      throw new Error(`Profile fetch failed: ${name}`, { cause: error });
    }
    if (!res.ok) throw new Error(`Profile fetch failed: ${name} (${res.status})`);
    profileCache.set(name, await loadProfile(new Uint8Array(await res.arrayBuffer())));
  }
  return profileCache.get(name);
}

const ERROR_KEYS = {
  layout: "err.layout",
  hdr: "err.hdr",
  metadata: "err.metadata",
  profile: "err.profile",
  size: "err.size",
  integrity: "err.integrity",
  structure: "err.structure",
  encoder: "err.encoder",
  linear8: "err.linear8",
  raster: "err.raster",
  unexpected: "err.unexpected",
};

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
  if (b.length > 11 && String.fromCharCode(...b.subarray(0, 4)) === "RIFF"
      && String.fromCharCode(...b.subarray(8, 12)) === "WEBP") return "webp";
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
  const status = el.querySelector(".status");
  const loadBar = document.createElement("progress");
  loadBar.className = "encoder-progress";
  loadBar.max = 100; loadBar.hidden = true;
  el.appendChild(loadBar);
  let stepStarted = performance.now();
  let current = null;
  let currentLabel = null;
  let clock = null;
  const elapsed = () => {
    const milliseconds = Math.max(0, performance.now() - stepStarted);
    if (milliseconds > 0 && milliseconds < 1) return "<1ms";
    if (milliseconds < 1000) return `${Math.round(milliseconds)}ms`;
    const seconds = milliseconds / 1000;
    if (seconds < 60) return `${seconds.toFixed(3)}s`;
    const minutes = Math.floor(seconds / 60);
    return `${minutes}:${(seconds % 60).toFixed(3).padStart(6, "0")}`;
  };
  const stamp = () => { if (current) current.textContent = elapsed(); };
  const stopClock = () => {
    stamp();
    if (clock !== null) clearInterval(clock);
    clock = null;
  };
  return {
    el,
    set(text, cls) {
      if (cls === "ok" || cls === "err") loadBar.hidden = true;
      stopClock();
      if (current) current.closest(".status-line").dataset.state = "done";
      const line = document.createElement("div");
      line.className = `status-line ${cls || ""}`;
      const time = document.createElement("span");
      time.className = "status-time";
      const label = document.createElement("span");
      label.className = "status-label";
      label.textContent = text;
      line.append(time, label);
      status.appendChild(line);
      current = time;
      currentLabel = label;
      stepStarted = performance.now();
      if (cls === "ok" || cls === "err") {
        time.textContent = "—";
        line.dataset.state = "summary";
        current = null;
      } else {
        line.dataset.state = "active";
        stamp();
        clock = setInterval(stamp, 100);
      }
    },
    update(text) {
      if (currentLabel) currentLabel.textContent = text;
    },
    progress(value) {
      loadBar.hidden = value === null;
      if (value !== null) loadBar.value = Math.max(0, Math.min(100, value));
    },
    replaceResult() {
      const actions = el.querySelector(".act");
      for (const link of actions.querySelectorAll("a[href^='blob:']")) URL.revokeObjectURL(link.href);
      actions.replaceChildren();
      el.querySelector(".result-thumbnail")?.remove();
      el.querySelector(".face-summary")?.remove();
    },
    resultBusy(busy) {
      el.querySelector(".act").inert = busy;
      const result = el.querySelector(".result-thumbnail");
      if (result) result.hidden = busy;
      el.setAttribute("aria-busy", String(busy));
    },
    correctFaces(state) {
      const button = document.createElement("button"), count = document.createElement("p");
      button.type = "button"; button.className = "dl alt face-correct";
      button.dataset.i18n = "review.title";
      button.textContent = T("review.title"); button.addEventListener("click", () => openFaceReview(state));
      el.querySelector(".act").append(button);
      count.className = "face-summary";
      count.dataset.total = state.review.items.length; count.dataset.excluded = state.excluded.size;
      count.textContent = faceCountText(state.review.items.length, state.excluded.size);
      el.querySelector(".thumbnails").before(count);
    },
    link(blob, filename) {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.textContent = T("btn.download");
      a.className = "dl";
      el.querySelector(".act").appendChild(a);
    },
    thumbnail(blob, filename, source = false) {
      let thumbnails = el.querySelector(".thumbnails");
      if (!thumbnails) {
        thumbnails = document.createElement("div"); thumbnails.className = "thumbnails";
        el.append(thumbnails);
      }
      const figure = document.createElement("figure"), img = document.createElement("img"), caption = document.createElement("figcaption");
      figure.className = `thumbnail ${source ? "source-thumbnail" : "result-thumbnail"}`;
      img.alt = filename;
      caption.dataset.i18n = source ? "thumbnail.source" : "thumbnail.result";
      caption.textContent = T(caption.dataset.i18n);
      figure.append(img, caption); thumbnails.append(figure);
      // Keep the real HEIC as the image URL so Safari's native long-press saves the output.
      const url = source ? URL.createObjectURL(blob) : el.querySelector(".act a[download]").href;
      img.addEventListener("error", () => {
        img.hidden = true;
        caption.dataset.i18n = source ? "thumbnail.unavailable" : "thumbnail.saveUnavailable";
        caption.textContent = T(caption.dataset.i18n);
        thumbnailQueue = thumbnailQueue.catch(() => {}).then(async () => {
          if (!figure.isConnected) return;
          const bytes = new Uint8Array(await blob.arrayBuffer());
          if (sniff(bytes) !== "heic") return;
          try {
            const display = await decodeToDisplayCanvas(bytes);
            if (!figure.isConnected) return;
            const canvas = document.createElement("canvas"), scale = Math.min(1, 144 / Math.max(display.width, display.height));
            canvas.width = Math.max(1, Math.round(display.width * scale));
            canvas.height = Math.max(1, Math.round(display.height * scale));
            canvas.setAttribute("role", "img"); canvas.setAttribute("aria-label", filename);
            canvas.getContext("2d").drawImage(display, 0, 0, canvas.width, canvas.height);
            figure.prepend(canvas);
            if (source) { caption.dataset.i18n = "thumbnail.source"; caption.textContent = T("thumbnail.source"); }
          } catch { /* An undecodable file keeps its name, error and unavailable-preview label. */ }
        }).catch(() => {});
        if (source) URL.revokeObjectURL(url);
      }, {once: true});
      img.src = url;
    },
    compare(input, output, filename, artifacts = null) {
      const b = document.createElement("button");
      b.className = "dl alt";
      b.type = "button";
      b.textContent = T("btn.inspectCompare");
      b.addEventListener("click", async () => {
        b.disabled = true;
        try { await openComparison(input, output, filename, artifacts); }
        finally { b.disabled = false; }
      });
      el.querySelector(".act").appendChild(b);
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

function updateLinearProgress(ui) {
  ui.progress(null); ui.update(T("st.linear"));
}

const yieldToBrowser = () => new Promise(resolve => setTimeout(resolve, 0));

function updateFaceProgress(ui, progress) {
  const keys = {
    decode: "st.faceDecode", models: "st.faceModels", detect: "st.faceDetect",
    segment: "st.faceSegment", metadata: "st.faceMetadata",
  };
  if (progress.stage === "matte") {
    const key = progress.matte === "portraiteffectsmatte" ? "matte.portraitPerson"
      : ITEM_LABEL_KEYS[progress.matte === "personInstance" ? "semanticpersoninstances" : progress.matte];
    const name = T(key);
    ui.set(T(progress.matte === "semantictattoomatte" ? "st.emptyMatte" : "st.faceMatte").replace("{name}", name)
      + (progress.index ? ` (${progress.index}/${progress.total})` : ""));
  } else if (keys[progress.stage]) ui.set(T(keys[progress.stage]));
}

async function handleBrowserReencode(file, ui, bytes, kind, inputDiscovery = null) {
  ui.set(T(kind === "heic" ? "st.heicReencode" : "st.rasterPreparing"));
  const profile = await getProfile("48-12");
  let rasterEncodingStarted = false;
  let sourceExif = null;
  let sourceDepth = null;
  let sourceSkin = null;
  if (inputDiscovery?.exifItem !== null && inputDiscovery?.exifItem !== undefined) {
    try { sourceExif = extractItem(bytes, inputDiscovery.iloc, inputDiscovery.exifItem); }
    catch { /* a malformed source Exif must not block compatibility re-encoding */ }
  }
  if (inputDiscovery) {
    sourceSkin = preferNativeSkin(bytes, inputDiscovery);
    try { sourceDepth = extractPortraitDepth(bytes, inputDiscovery); }
    catch (error) { console.warn("could not preserve source Portrait depth:", error); }
  }
  let { data, faceResult, portraitMatte, rebuild } = await importRaster(file, profile, (progress) => {
    if (progress.stage === "main") {
      const message = T("st.rasterEncoding")
        .replace("{done}", progress.done).replace("{total}", progress.total);
      if (!rasterEncodingStarted) { ui.set(message); rasterEncodingStarted = true; }
      else ui.update(message);
    } else if (progress.stage === "faces") updateFaceProgress(ui, progress.detail);
    else if (progress.stage === "linear") ui.set(T("st.linear"));
    else if (progress.stage === "auxiliary") ui.set(T("st.rasterAuxiliary"));
    else if (progress.stage === "assemble") ui.set(T("st.rasterAssembling"));
  }, { faces: faces.checked, sourceExif, sourceDepth, sourceSkin });
  const outName = file.name.replace(/\.(heic|heif|png|jpe?g|webp)$/i, "") + "_PhotographicStyle.HEIC";
  const sep = lang === "zh" ? "、" : ", ";
  const bits = [T(kind === "heic" ? "st.heicReencoded" : "st.rasterImported"), T("st.texture")];
  if (faceResult.state === "generated") bits.push(T("st.faces"));
  else if (faceResult.state === "none") bits.push(T("st.noface"));
  else if (faceResult.state === "unavailable") bits.push(T("st.facesUnavailable"));
  ui.set(`${T("st.ready")} — ${bits.join(sep)}`, "ok");
  presentResult(ui, data, outName, inputDiscovery ? bytes : null, faceResult.debugArtifacts,
    faceCorrection(faceResult, rebuild, data));
  if(portraitMatte?.mode==='omitted-unavailable'){const note=document.createElement('p');note.textContent=T('portrait.omitted');ui.el.append(note);}
}

async function handleFile(file, ui = row(file.name), preparedBytes = null) {
  try {
    ui.set(T("st.reading"));
    const bytes = preparedBytes || new Uint8Array(await file.arrayBuffer());
    const kind = sniff(bytes);
    if (["png", "jpeg", "webp"].includes(kind)) {
      await handleBrowserReencode(file, ui, bytes, kind);
      return;
    }
    if (kind !== "heic") { ui.set(T("err.notheic"), "err"); return; }

    const d = discoverHeic(bytes);
    const sep = lang === "zh" ? "、" : ", ";
    let data, bits, suffix, genericGraft = false, genericProfileName = null,
      generatedAux = null, pipelineReport = null, rebuild = null;
    if (d.stylesItem !== null && hasTexture(d.infos)) {
      if (hasNativeFaceMattes(d)) {
        ui.set(T("st.hastextureMasks"), "ok");
      } else ui.set(T("err.hastexture"), "err");
      ui.compare(bytes, null, file.name);
      return;
    }
    if (d.stylesItem === null) {
      const directHdr = d.hdrGrid !== null && d.hdrTiles.length === 0
        && d.infos.get(d.hdrGrid)?.type === "hvc1";
      let compatibleLayout = false;
      try {
        selectProfile(profileIndex, d.primaryTiles.length, d.hdrTiles.length, directHdr);
        compatibleLayout = true;
      } catch { /* unsupported containers can use the local re-encode path */ }
      const usableHdr = d.hdrGrid !== null && (d.hdrTiles.length || directHdr);
      if (d.thumbnail === null || !compatibleLayout || !usableHdr) {
        // Experimental arbitrary-layout graft: keep every primary HEVC tile byte-for-byte
        // and generate only missing auxiliaries. Tiled HDR layouts other than the two
        // profiles still use the full compatibility re-encode until their graph adapter lands.
        const missingThumbCanStayOriented = d.thumbnail !== null
          || (irotAngleForItem(bytes, d.props, d.primary) === 0
            && imirAxisForItem(bytes, d.props, d.primary) === null);
        const matchingTiledHdrProfile = d.hdrTiles.length
          ? Object.entries(profileIndex)
            .filter(([, candidate]) => candidate.hdr_tiles === d.hdrTiles.length
              && candidate.primary_tiles >= d.primaryTiles.length)
            .sort((a, b) => a[1].primary_tiles - b[1].primary_tiles)[0]?.[0]
          : null;
        genericProfileName = (d.hdrGrid === null || directHdr)
          ? (d.primaryTiles.length <= profileIndex["48-12"].primary_tiles ? "48-12" : null)
          : matchingTiledHdrProfile;
        const canGraft = d.exifItem !== null && d.primaryTiles.length > 0
          && genericProfileName !== null && missingThumbCanStayOriented;
        if (!canGraft) {
          await handleBrowserReencode(file, ui, bytes, "heic", d);
          return;
        }
        genericGraft = true;
        if (d.thumbnail === null || d.hdrGrid === null) {
          ui.set(T("st.genericGraft"));
          await yieldToBrowser();
          generatedAux = await prepareHeicAuxiliaries(file, d);
        }
      }
    }

    let faceResult = { state: "skipped", overrides: new Map(), faces: 0 };
    if (faces.checked) {
      try {
        faceResult = await generateFaceMattes(bytes, d, {onProgress: progress => updateFaceProgress(ui, progress)});
      } catch (error) {
        console.warn("face matte generation unavailable:", error);
        faceResult = { state: "unavailable", overrides: new Map(), faces: 0 };
      }
    }

    if(d.stylesItem===null&&![...d.infos.keys()].some(id=>auxUriForItem(d.props,id)===MATTE_URIS.portraiteffectsmatte)&&!faceResult.overrides.has(MATTE_URIS.portraiteffectsmatte)){
      try{const portrait=await generateFaceMattes(bytes,d,{portraitOnly:true,onProgress:progress=>updateFaceProgress(ui,progress)});for(const [uri,value] of portrait.overrides)faceResult.overrides.set(uri,value);}
      catch(e){faceResult.portraitError=e.message;}
    }
    if (d.stylesItem !== null) {
      // Preserve native style data while adding Texture/Grain.
      ui.set(T("st.working"));
      await yieldToBrowser();
      rebuild = updated => addTexture(bytes, {
        matteOverrides: updated.overrides, personMetadata: updated.personMetadata,
        texturePeopleData: updated.texturePeopleData,
      }).data;
      data = rebuild(faceResult);
      bits = [T("st.native"), T("st.texture")];
      if ([...d.infos.keys()].some(id => auxUriForItem(d.props, id) === MATTE_URIS.semantichairmatte))
        bits.push(T("st.hairPreserved"));
      suffix = "_TextureGrain.HEIC";
    } else {
      // Preserve primary HEVC; encode only an independent 8-bit linear thumbnail.
      const directHdr = d.hdrGrid !== null && d.hdrTiles.length === 0
        && d.infos.get(d.hdrGrid)?.type === "hvc1";
      const name = genericGraft ? genericProfileName
        : selectProfile(profileIndex, d.primaryTiles.length, d.hdrTiles.length, directHdr);
      ui.set(T("st.preparingStyle"));
      await yieldToBrowser();
      const profile = await getProfile(name);
      const canDecode = quality.checked ? await ensureDecode(bytes) : false;
      const opts = canDecode
        ? { decode: decodeToRgb, sceneStats: "target", lightMaps: "target",
          matteOverrides: faceResult.overrides, personMetadata: faceResult.personMetadata,
          texturePeopleData: faceResult.texturePeopleData }
        : { sceneStats: "donor", matteOverrides: faceResult.overrides,
          personMetadata: faceResult.personMetadata,
          texturePeopleData: faceResult.texturePeopleData };
      if (genericGraft) {
        opts.generic = true;
        opts.syntheticThumbnail = generatedAux?.thumbnail;
        opts.syntheticHdr = generatedAux?.hdr;
      }
      ui.set(T("st.linear"));
      opts.linearThumbnail = await prepareHeicLinearThumbnail(file, bytes, d,
        (progress) => updateLinearProgress(ui, progress));
      ui.set(T("st.working"));
      await yieldToBrowser();
      let report;
      ({ data, report } = await patch(bytes, profile, opts));
      rebuild = async updated => (await patch(bytes, profile, {...opts,
        matteOverrides: updated.overrides, personMetadata: updated.personMetadata,
        texturePeopleData: updated.texturePeopleData})).data;
      if(faceResult.portraitError)report.portraitMatte.error=faceResult.portraitError;
      pipelineReport = report;
      // patch() degrades rather than failing when the decoder misbehaves, so trust
      // what it reports it actually did, not what we asked for.
      if (report.decodeError) console.warn("decoder unavailable:", report.decodeError);

      bits = [T(report.decoded ? "st.matched" : "st.neutral")];
      if (report.generic) bits.unshift(T("st.genericPreserved"));
      if (report.hdr?.mode === "direct") bits.push(T("st.directHdr"));
      else if (report.hdr?.mode === "tiled-preserved") bits.push(T("st.tiledHdr"));
      else if (report.hdr?.mode === "synthetic-direct") bits.push(T("st.syntheticHdr"));
      if (report.mattes.added.some((m) => m.startsWith("depth"))) bits.push(T("st.portrait"));
      else if (report.mattes.transplanted.length) bits.push(T("st.people"));
      if (report.texture !== "off") bits.push(T("st.texture"));
      if (report.mattes.transplanted.includes("semantichairmatte")
          || report.mattes.added.some(name => name.startsWith("semantichairmatte#")))
        bits.push(T("st.hairPreserved"));
      suffix = "_PhotographicStyle.HEIC";
    }
    if (faceResult.state === "generated") bits.push(T("st.faces"));
    else if (faceResult.state === "none") bits.push(T("st.noface"));
    else if (faceResult.state === "unavailable") bits.push(T("st.facesUnavailable"));
    ui.set(`${T("st.ready")} — ${bits.join(sep)}`, "ok");
    if(pipelineReport?.portraitMatte?.mode==='omitted-unavailable'){const note=document.createElement('p');note.textContent=T('portrait.omitted');ui.el.append(note);}

    const outName = file.name.replace(/\.(heic|heif)$/i, "") + suffix;
    // On iPhone the share sheet lands the file straight in Photos; elsewhere a plain
    // download is the shorter route.
    const outputBytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    presentResult(ui, outputBytes, outName, bytes, faceResult.debugArtifacts,
      faceCorrection(faceResult, rebuild, outputBytes));
  } catch (e) {
    console.error("could not port", file.name, e);
    const diagnosed = diagnosePortError(e);
    const detail = diagnosed.detail ? ` (${diagnosed.detail})` : "";
    ui.set(`${T(ERROR_KEYS[diagnosed.code])}${detail}`, "err");
  }
}

async function handleFiles(files) {
  await Promise.all(files.map(prepareFile));
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
  for (const note of document.querySelectorAll(".face-summary"))
    note.textContent = faceCountText(Number(note.dataset.total), Number(note.dataset.excluded));
  if (faceSession) {
    faceName.textContent = `${T("review.title")} — ${faceSession.state.filename}`;
    renderFaceSelections();
  }
});

// Visit counter behind the README badge. This request carries only the fact that the
// page was opened; no photo reaches the counter. Fired once per browser session so
// a reload is not a new visit, and fire-and-forget: a counter that is down is not
// worth an error. If sessionStorage is blocked the visit goes uncounted.
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
