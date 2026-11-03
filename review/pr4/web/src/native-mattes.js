// Decode the semantic mattes already embedded in an iPhone 18 HEIC.
//
// These are ordinary single-frame HEVC image items.  Decoding their item payloads directly
// with WebCodecs lets the diagnostics show Apple's stored masks without modifying the photo
// or running MediaPipe again.

import { extractItem, auxUriForItem, dimensionsForItem, propertyBoxBytes,
  irotAngleForItem, imirAxisForItem, storedPointToDisplay,
  transformNormalizedRect, DEPTH_URI } from "./heif.js?v=0.6.0-web";
import { parseBplist } from "./bplist.js?v=0.6.0-web";
import { metaChildren, findChild, concat, u } from "./box.js?v=0.6.0-web";
import { decodeToDisplayCanvas } from "./decode.js?v=0.6.0-web";
import { MATTE_2026_URIS } from "./texture.js?v=0.6.0-web";

const URI_TEXTURE_STYLES = "tag:apple.com,2026:photo:metadata:texture_styles";

const WANTED = MATTE_2026_URIS.map((uri) => uri.split(":").pop());
const LEGACY_WANTED = [
  "portraiteffectsmatte", "semanticskinmatte", "semantichairmatte",
  "semanticteethmatte", "semanticglassesmatte", "semanticskymatte",
];
const STYLE_STAT_NAMES = [
  "ToneMappedImagePersonSegmentBased", "LinearImagePersonSegmentBased",
  "ToneMappedImageSkinBased", "LinearImageSkinBased",
  "ToneMappedImageRedChannelSkinBased", "ToneMappedImageGreenChannelSkinBased",
  "ToneMappedImageBlueChannelSkinBased",
];
const STAT_FIELDS = [
  "blackPoint", "whitePoint", "highKey", "p02", "p10", "p25", "p50", "p75", "p98",
];
export const INSPECTION_NAMES = [
  "HDR gain map", "style delta map", "tmap", "styles", "texture_styles",
  "TextureStylePostProcessedPeopleData",
  "portrait depth map", ...LEGACY_WANTED, ...WANTED, "semanticpersoninstances",
  "PersonMasksValidHint", "PeopleRatio", "SkinRatio", ...STYLE_STAT_NAMES,
];

function canvas(width, height) {
  const out = document.createElement("canvas");
  out.width = width;
  out.height = height;
  return out;
}

function pngBlob(source) {
  return new Promise((resolve, reject) => source.toBlob(
    (blob) => blob ? resolve(blob) : reject(new Error("Could not create native-matte PNG")),
    "image/png"));
}

export function readNativePeopleData(bytes, discovery) {
  const iid = [...discovery.infos].find(([, info]) =>
    info.type === "uri " && info.uri === URI_TEXTURE_STYLES)?.[0];
  if (iid === undefined) return [];
  const plist = parseBplist(extractItem(bytes, discovery.iloc, iid));
  const people = plist.get("TextureStylePostProcessedPeopleData");
  return Array.isArray(people) ? people : [];
}

function mapValue(map, key, fallback = 0) {
  const value = map instanceof Map ? map.get(key) : undefined;
  return Number.isFinite(value) ? value : fallback;
}

export function displayPoint(x, y, angle, mirror = null) {
  return storedPointToDisplay(x, y, angle, mirror);
}

function displayRect(roi, angle, mirror) {
  if (!(roi instanceof Map)) return null;
  const x = mapValue(roi, "x"), y = mapValue(roi, "y");
  const w = mapValue(roi, "width"), h = mapValue(roi, "height");
  return transformNormalizedRect({ x, y, width: w, height: h },
    (px, py) => displayPoint(px, py, angle, mirror));
}

function drawNormalizedRect(ctx, roi, width, height, color, label, angle, mirror,
  dashed = false) {
  if (!(roi instanceof Map)) return;
  const shown = displayRect(roi, angle, mirror);
  const x = shown.x * width, y = shown.y * height;
  const w = shown.width * width, h = shown.height * height;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(2, width / 450);
  ctx.setLineDash(dashed ? [ctx.lineWidth * 3, ctx.lineWidth * 2] : []);
  ctx.strokeRect(x, y, w, h);
  ctx.setLineDash([]);
  ctx.font = `600 ${Math.max(13, Math.round(width / 65))}px system-ui`;
  const textWidth = ctx.measureText(label).width;
  const textY = Math.max(0, y - Math.max(18, width / 50));
  ctx.fillStyle = "rgba(0,0,0,.72)";
  ctx.fillRect(x, textY, textWidth + 10, Math.max(18, width / 50));
  ctx.fillStyle = color;
  ctx.fillText(label, x + 5, textY + Math.max(14, width / 65));
  ctx.restore();
}

export function renderPeopleGeometry(display, people, angle, mirror) {
  const maxSide = 1800;
  const scale = Math.min(1, maxSide / Math.max(display.width, display.height));
  const out = canvas(Math.max(1, Math.round(display.width * scale)),
    Math.max(1, Math.round(display.height * scale)));
  const ctx = out.getContext("2d");
  ctx.drawImage(display, 0, 0, out.width, out.height);
  const radius = Math.max(2, out.width / 300);

  people.forEach((person, index) => {
    const n = index + 1;
    drawNormalizedRect(ctx, person.get("instanceROI"), out.width, out.height,
      "#23a8ff", `#${n} instanceROI`, angle, mirror, true);
    drawNormalizedRect(ctx, person.get("faceSkinROI"), out.width, out.height,
      "#ff3b30", `#${n} faceSkinROI`, angle, mirror);
    drawNormalizedRect(ctx, person.get("faceROI"), out.width, out.height,
      "#ffd60a", `#${n} faceROI`, angle, mirror);

    ctx.fillStyle = "#42ff74";
    ctx.strokeStyle = "rgba(0,0,0,.85)";
    ctx.lineWidth = Math.max(1, radius / 2);
    (person.get("faceLandmarks") || []).forEach((landmark, landmarkIndex) => {
      const point = landmark instanceof Map ? landmark.get("point") : null;
      if (!(point instanceof Map)) return;
      const error = mapValue(landmark, "error");
      const r = radius * Math.min(2.2, 1 + error * 25);
      const shown = displayPoint(mapValue(point, "x"), mapValue(point, "y"), angle, mirror);
      const x = shown.x * out.width, y = shown.y * out.height;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.font = `700 ${Math.max(8, Math.round(out.width / 150))}px ui-monospace, monospace`;
      ctx.lineWidth = Math.max(2, out.width / 800);
      ctx.strokeStyle = "rgba(0,0,0,.95)";
      ctx.fillStyle = "#fff";
      const label = String(landmarkIndex);
      ctx.strokeText(label, x + r + 1, y - r - 1);
      ctx.fillText(label, x + r + 1, y - r - 1);
      ctx.fillStyle = "#42ff74";
      ctx.strokeStyle = "rgba(0,0,0,.85)";
    });

    const roi = person.get("faceSkinROI");
    if (roi instanceof Map) {
      const shown = displayRect(roi, angle, mirror);
      const x = shown.x * out.width;
      const y = (shown.y + shown.height) * out.height;
      const pose = `yaw ${mapValue(person, "faceYaw").toFixed(2)} · pitch ${
        mapValue(person, "facePitch").toFixed(2)} · roll ${mapValue(person, "faceRoll").toFixed(2)}`;
      ctx.font = `600 ${Math.max(13, Math.round(out.width / 65))}px system-ui`;
      const tw = ctx.measureText(pose).width;
      ctx.fillStyle = "rgba(0,0,0,.72)";
      ctx.fillRect(x, y, tw + 10, Math.max(18, out.width / 50));
      ctx.fillStyle = "#fff";
      ctx.fillText(pose, x + 5, y + Math.max(14, out.width / 65));
    }
  });

  const legend = "red: faceSkinROI · yellow: faceROI · blue: instanceROI · green: landmarks 0–75";
  ctx.font = `600 ${Math.max(13, Math.round(out.width / 65))}px system-ui`;
  const lw = ctx.measureText(legend).width;
  ctx.fillStyle = "rgba(0,0,0,.72)";
  ctx.fillRect(0, 0, Math.min(out.width, lw + 16), Math.max(22, out.width / 45));
  ctx.fillStyle = "white";
  ctx.fillText(legend, 8, Math.max(16, out.width / 60));
  return out;
}

async function decodePrimary(bytes) {
  const url = URL.createObjectURL(new Blob([bytes], { type: "image/heic" }));
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const out = canvas(image.naturalWidth, image.naturalHeight);
    out.getContext("2d").drawImage(image, 0, 0);
    return out;
  } catch {
    return decodeToDisplayCanvas(bytes);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function findNativeMatteItems(discovery) {
  const byName = new Map();
  for (const iid of discovery.infos.keys()) {
    const uri = auxUriForItem(discovery.props, iid);
    if (uri) byName.set(uri.split(":").pop(), iid);
  }
  return new Map(WANTED.flatMap((name) =>
    byName.has(name) ? [[name, { iid: byName.get(name), name }]] : []));
}

export function hasNativeFaceMattes(discovery) {
  const items = findNativeMatteItems(discovery);
  return items.has("semanticskinmattev2") || items.has("semanticfaceskinmatte")
    || items.has("semanticpersonmatte");
}

/** RFC 6381 codec string derived from an HEVCDecoderConfigurationRecord. */
export function codecStringFromHvcc(record, sampleEntry = "hvc1") {
  if (!record || record.length < 13 || record[0] !== 1)
    throw new Error("Invalid hvcC decoder configuration");
  const profileSpace = record[1] >> 6;
  const tier = (record[1] & 0x20) ? "H" : "L";
  const profile = record[1] & 0x1f;
  // ISO 14496-15: compatibility flags are represented in reverse bit order.
  let reversed = 0;
  for (let bit = 0; bit < 32; bit++)
    if (record[2 + (bit >> 3)] & (0x80 >> (bit & 7))) reversed += 2 ** bit;
  const compat = reversed.toString(16).toUpperCase();
  const constraints = [...record.slice(6, 12)];
  while (constraints.length && constraints.at(-1) === 0) constraints.pop();
  const space = ["", "A", "B", "C"][profileSpace];
  const tail = constraints.map((v) => v.toString(16).toUpperCase().padStart(2, "0")).join(".");
  return `${sampleEntry}.${space}${profile}.${compat}.${tier}${record[12]}${tail ? `.${tail}` : ""}`;
}

export function decoderCodecCandidates(record, sampleEntry = 'hvc1') {
  const candidates = [codecStringFromHvcc(record, sampleEntry)];
  // The description and compressed payload stay untouched. Only advertise a
  // compatible decoding profile explicitly declared by the source hvcC.
  if ((record[1] & 31) === 3 && (record[1] >> 6) === 0) {
    for (const profile of [1, 2]) if (record[2] & (0x80 >> profile)) {
      const compatible = record.slice();compatible[1] = (compatible[1] & 0xe0) | profile;
      candidates.push(codecStringFromHvcc(compatible, sampleEntry));
    }
  }
  return candidates;
}

function displayCanvas(frame, angle, mirror, maxSide = Infinity) {
  const sw = frame.displayWidth || frame.codedWidth || frame.width;
  const sh = frame.displayHeight || frame.codedHeight || frame.height;
  const swap = angle === 90 || angle === 270;
  const scale=Math.min(1,maxSide/Math.max(sw,sh)),w=sw*scale,h=sh*scale;
  const out = canvas(Math.max(1,Math.round(swap ? h : w)),Math.max(1,Math.round(swap ? w : h)));
  const ctx = out.getContext("2d", { willReadFrequently: true });
  ctx.translate(out.width / 2, out.height / 2);
  // HEIF irot is counter-clockwise. Canvas uses the opposite visual direction because its
  // y-axis points down, so applying +angle here turns a native irot=270 mask by 180 degrees
  // from its intended display orientation.
  ctx.rotate(displayRotationRadians(angle));
  if (mirror === 0) ctx.scale(-1, 1);
  else if (mirror === 1) ctx.scale(1, -1);
  ctx.drawImage(frame, -w / 2, -h / 2, w, h);
  return out;
}

export function displayRotationRadians(angle) {
  return -angle * Math.PI / 180;
}

async function decodeItem(bytes, discovery, iid, applyTransform = true, maxSide = Infinity, diagnostics = null, renderFrame = null) {
  if (!globalThis.VideoDecoder || !globalThis.EncodedVideoChunk)
    throw new Error("HEVC WebCodecs decoder unavailable");
  const hvccBox = propertyBoxBytes(bytes, discovery.props, iid, "hvcC");
  if (!hvccBox || hvccBox.length <= 8) throw new Error(`Matte item ${iid} has no hvcC`);
  const description = hvccBox.slice(8);
  const itemType = discovery.infos.get(iid)?.type === "hev1" ? "hev1" : "hvc1";
  const [width, height] = dimensionsForItem(discovery.props, iid);
  const config = {
    codec: codecStringFromHvcc(description, itemType),
    codedWidth: width, codedHeight: height,
    description,
    hardwareAcceleration: "prefer-hardware",
  };
  let support;
  const candidates = decoderCodecCandidates(description, itemType);
  for (const codec of candidates) {
    for (const hardwareAcceleration of ['prefer-hardware', 'no-preference']) {
      try { const probe = await VideoDecoder.isConfigSupported({...config, codec, hardwareAcceleration});
        if (probe.supported) { support = probe; break; }
      } catch { /* Try the remaining declared-compatible configurations. */ }
    }
    if (support) break;
  }
  if (!support) throw new Error(`HEVC decoder does not support ${candidates.join(' / ')}`);

  let resolveFrame, rejectFrame;
  const framePromise = new Promise((resolve, reject) => {
    resolveFrame = resolve;
    rejectFrame = reject;
  });
  framePromise.catch(() => {}); // flush can reject before the frame promise is awaited.
  const decoder = new VideoDecoder({ output: resolveFrame, error: rejectFrame });
  let frame;
  try {
    decoder.configure(support.config || config);
    decoder.decode(new EncodedVideoChunk({
      type: "key", timestamp: 0, duration: 1_000_000,
      data: extractItem(bytes, discovery.iloc, iid),
    }));
    await decoder.flush();
    frame = await framePromise;
    if (diagnostics) diagnostics.push({itemId:iid, codec:(support.config || config).codec, format:frame.format, colorSpace:frame.colorSpace?.toJSON?.() ?? {primaries:frame.colorSpace?.primaries,transfer:frame.colorSpace?.transfer,matrix:frame.colorSpace?.matrix,fullRange:frame.colorSpace?.fullRange}, outerICCProvided:false});
    const rendered=renderFrame ? await renderFrame(frame) : frame;
    try { return displayCanvas(rendered,
      applyTransform ? irotAngleForItem(bytes, discovery.props, iid) : 0,
      applyTransform ? imirAxisForItem(bytes, discovery.props, iid) : null,maxSide); } finally {if(renderFrame) rendered.width=rendered.height=0;}
  } finally {
    if (frame) frame.close();
    if(decoder.state !== 'closed') decoder.close();
  }
}

/** Grid descriptors may live in meta/idat rather than the file's mdat. */
export function readImageGrid(bytes, discovery, iid) {
  const item = discovery.iloc.items.get(iid);
  if (!item) throw new Error(`No iloc entry for grid ${iid}`);
  let descriptor;
  if (item.constructionMethod === 0) descriptor = extractItem(bytes, discovery.iloc, iid);
  else if (item.constructionMethod === 1) {
    const idat = findChild(metaChildren(bytes, discovery.meta), "idat");
    if (!idat) throw new Error(`Grid ${iid} has no idat`);
    descriptor = concat(item.extents.map((extent) => {
      const start = idat.off + idat.hdr + item.baseOffset + extent.offset;
      const end = start + extent.length;
      if (start < idat.off + idat.hdr || end > idat.off + idat.size)
        throw new Error(`Grid ${iid} descriptor exceeds idat`);
      return bytes.slice(start, end);
    }));
  } else throw new Error(`Unsupported grid construction method ${item.constructionMethod}`);
  if (descriptor.length < 8 || descriptor[0] !== 0 || (descriptor[1] & ~1))
    throw new Error(`Invalid grid descriptor for item ${iid}`);
  const size = descriptor[1] & 1 ? 4 : 2;
  if (descriptor.length < 4 + size * 2) throw new Error(`Truncated grid descriptor ${iid}`);
  const grid = { rows: descriptor[2] + 1, columns: descriptor[3] + 1,
    width: u(descriptor, 4, size), height: u(descriptor, 4 + size, size) };
  if (!grid.width || !grid.height) throw new Error(`Invalid grid dimensions for item ${iid}`);
  const [width, height] = dimensionsForItem(discovery.props, iid);
  if (width !== grid.width || height !== grid.height)
    throw new Error(`Grid ${iid} descriptor and ispe dimensions disagree`);
  return grid;
}

export async function decodeImageItem(bytes, discovery, iid, {maxSide=Infinity,diagnostics=null,renderFrame=null} = {}) {
  if (discovery.infos.get(iid)?.type !== "grid") return decodeItem(bytes, discovery, iid,true,maxSide,diagnostics,renderFrame);
  const grid = readImageGrid(bytes, discovery, iid);
  const tiles = discovery.refs.filter((ref) => ref.type === "dimg" && ref.from === iid)
    .flatMap((ref) => ref.to);
  if (tiles.length !== grid.rows * grid.columns)
    throw new Error(`Grid ${iid} has an incorrect tile count`);
  const [tileWidth, tileHeight] = dimensionsForItem(discovery.props, tiles[0]);
  if (tileWidth <= 0 || tileHeight <= 0 ||
      grid.width <= (grid.columns - 1) * tileWidth || grid.width > grid.columns * tileWidth ||
      grid.height <= (grid.rows - 1) * tileHeight || grid.height > grid.rows * tileHeight)
    throw new Error(`Grid ${iid} has invalid tile geometry`);
  const scale=Math.min(1,maxSide/Math.max(grid.width,grid.height));
  const stitched = canvas(Math.max(1,Math.round(grid.width*scale)),Math.max(1,Math.round(grid.height*scale)));
  const scaleX=stitched.width/grid.width,scaleY=stitched.height/grid.height;
  const ctx = stitched.getContext("2d");
  try {
    for (let index = 0; index < tiles.length; index++) {
      const [width, height] = dimensionsForItem(discovery.props, tiles[index]);
      if (width !== tileWidth || height !== tileHeight)
        throw new Error(`Grid ${iid} has inconsistent tile dimensions`);
      const tile = await decodeItem(bytes, discovery, tiles[index], false,Infinity,diagnostics,renderFrame);
      try {
        if (tile.width !== tileWidth || tile.height !== tileHeight)
          throw new Error(`Grid ${iid} decoded tile dimensions disagree with ispe`);
        // Canvas clips padded edge tiles to the grid's actual output dimensions.
        if(scale===1) ctx.drawImage(tile,(index%grid.columns)*tileWidth,Math.floor(index/grid.columns)*tileHeight);
        else ctx.drawImage(tile, (index % grid.columns) * tileWidth*scaleX,
          Math.floor(index / grid.columns) * tileHeight*scaleY,tileWidth*scaleX,tileHeight*scaleY);
      } finally { tile.width = tile.height = 0; }
    }
    return displayCanvas(stitched, irotAngleForItem(bytes, discovery.props, iid),
      imirAxisForItem(bytes, discovery.props, iid));
  } finally { stitched.width = stitched.height = 0; }
}

function scalar(value) {
  if (typeof value === "number" || typeof value === "string" || typeof value === "boolean")
    return value;
  return value ?? null;
}

function statisticsValue(value) {
  if (!(value instanceof Map)) return null;
  return Object.fromEntries(STAT_FIELDS.filter((key) => value.has(key))
    .map((key) => [key, scalar(value.get(key))]));
}

function peopleSummary(people) {
  return people.map((person, index) => ({
    person: index + 1,
    faceYaw: scalar(person.get("faceYaw")),
    facePitch: scalar(person.get("facePitch")),
    faceRoll: scalar(person.get("faceRoll")),
    faceLandmarks: Array.isArray(person.get("faceLandmarks"))
      ? person.get("faceLandmarks").length : 0,
    instanceMaskReferenceKey: scalar(person.get("instanceMaskReferenceKey")),
    hasFaceROI: person.get("faceROI") instanceof Map,
    hasFaceSkinROI: person.get("faceSkinROI") instanceof Map,
    hasInstanceROI: person.get("instanceROI") instanceof Map,
  }));
}

/** Build one canonical inventory. Missing rows are added by the comparison UI, so the same
 * names and ordering are used before and after processing. */
export async function buildHeicInspection(bytes, discovery) {
  const entries = new Map();
  const set = (name, value) => entries.set(name, { name, present: true, ...value });
  const tmapGainIds = discovery.refs.filter((ref) => ref.type === "dimg" &&
    discovery.infos.get(ref.from)?.type === "tmap" && ref.to.length === 2 && ref.to[0] === discovery.primary)
    .map((ref) => ref.to[1]);
  const gainId = discovery.hdrGrid ?? (new Set(tmapGainIds).size === 1 ? tmapGainIds[0] : null);
  if (gainId != null) {
    const iid = gainId;
    const previews = [], errors = [];
    try {
      const source = await decodeImageItem(bytes, discovery, iid);
      try { previews.push({ itemId: iid, blob: await pngBlob(source) }); }
      finally { source.width = source.height = 0; }
    } catch (error) { errors.push({ itemId: iid, error: error?.message || String(error) }); }
    set("HDR gain map", {
      kind: "image", itemIds: [iid], previews, errors,
      value: { item: iid, tiles: discovery.refs.filter((ref) => ref.type === "dimg" && ref.from === iid)
          .reduce((count, ref) => count + ref.to.length, 0),
        dimensions: dimensionsForItem(discovery.props, iid) },
    });
  }
  if (discovery.deltaGrid !== null) set("style delta map", {
    kind: "structure", itemIds: [discovery.deltaGrid],
    value: { item: discovery.deltaGrid, tiles: discovery.deltaTiles.length,
      dimensions: dimensionsForItem(discovery.props, discovery.deltaGrid) },
  });
  const tmaps = [...discovery.infos].filter(([, info]) => info.type === "tmap").map(([iid]) => iid);
  if (tmaps.length) set("tmap", { kind: "structure", itemIds: tmaps,
    value: tmaps.map((iid) => ({ item: iid, dimensions: dimensionsForItem(discovery.props, iid) })) });

  let styles = null;
  if (discovery.stylesItem !== null) {
    try { styles = parseBplist(extractItem(bytes, discovery.iloc, discovery.stylesItem)); }
    catch { styles = null; }
    set("styles", { kind: "metadata", itemIds: [discovery.stylesItem],
      value: { item: discovery.stylesItem, schemaVersion: scalar(styles?.get("0")) } });
  }
  const textureItem = [...discovery.infos].find(([, info]) =>
    info.type === "uri " && info.uri === URI_TEXTURE_STYLES)?.[0];
  let people = [];
  if (textureItem !== undefined) {
    let texture = null;
    try { texture = parseBplist(extractItem(bytes, discovery.iloc, textureItem)); }
    catch { texture = null; }
    people = Array.isArray(texture?.get("TextureStylePostProcessedPeopleData"))
      ? texture.get("TextureStylePostProcessedPeopleData") : [];
    set("texture_styles", { kind: "metadata", itemIds: [textureItem], value: {
      item: textureItem, preset: scalar(texture?.get("Preset")),
      hardwareModel: scalar(texture?.get("HardwareModel")), people: people.length,
    } });
    if (texture?.has("TextureStylePostProcessedPeopleData"))
      set("TextureStylePostProcessedPeopleData", {
        kind: "metadata", itemIds: [textureItem], value: peopleSummary(people),
      });
  }

  const seven = styles?.get("7");
  for (const name of ["PersonMasksValidHint", "PeopleRatio", "SkinRatio"])
    if (seven instanceof Map && seven.has(name)) set(name, { kind: "value", value: scalar(seven.get(name)) });
  const six = styles?.get("6");
  for (const name of STYLE_STAT_NAMES)
    if (six instanceof Map && six.has(name))
      set(name, { kind: "statistics", value: statisticsValue(six.get(name)) });

  const auxByName = new Map();
  for (const iid of discovery.infos.keys()) {
    const uri = auxUriForItem(discovery.props, iid);
    if (!uri) continue;
    const name = uri === DEPTH_URI ? "portrait depth map" : uri.split(":").pop();
    if (!auxByName.has(name)) auxByName.set(name, []);
    auxByName.get(name).push(iid);
  }
  for (const name of ["portrait depth map", ...LEGACY_WANTED, ...WANTED, "semanticpersoninstances"]) {
    const ids = auxByName.get(name) || [];
    if (!ids.length) continue;
    const previews = [];
    const errors = [];
    for (const iid of ids) {
      try {
        const source = await decodeItem(bytes, discovery, iid);
        previews.push({ itemId: iid, blob: await pngBlob(source), coverage: maskCoverage(source) });
      } catch (error) { errors.push({ itemId: iid, error: error?.message || String(error) }); }
    }
    set(name, { kind: "image", itemIds: ids, previews, errors });
  }
  if (people.length) {
    try {
      const geometry = await pngBlob(renderPeopleGeometry(await decodePrimary(bytes), people,
        irotAngleForItem(bytes, discovery.props, discovery.primary),
        imirAxisForItem(bytes, discovery.props, discovery.primary)));
      const entry = entries.get("TextureStylePostProcessedPeopleData");
      if (entry) entry.previews = [{ itemId: textureItem, blob: geometry }];
    } catch { /* metadata remains visible even if the primary decoder is unavailable */ }
  }
  return { entries };
}

function maskCoverage(source) {
  const data = source.getContext("2d", { willReadFrequently: true })
    .getImageData(0, 0, source.width, source.height).data;
  let sum = 0;
  for (let p = 0; p < data.length; p += 4)
    sum += (data[p] + data[p + 1] + data[p + 2]) / (3 * 255);
  return sum / (source.width * source.height);
}

export async function extractNativeMatteArtifacts(bytes, discovery) {
  const items = findNativeMatteItems(discovery);
  if (!items.size) throw new Error("No iPhone 18 semantic mattes are present");
  const decoded = new Map();
  for (const [key, spec] of items)
    decoded.set(key, await decodeItem(bytes, discovery, spec.iid));
  const people = readNativePeopleData(bytes, discovery);
  const artifacts = { native: true, faces: people.length };
  if (people.length) artifacts.geometry = await pngBlob(renderPeopleGeometry(await decodePrimary(bytes),
    people, irotAngleForItem(bytes, discovery.props, discovery.primary),
    imirAxisForItem(bytes, discovery.props, discovery.primary)));
  for (const [key, source] of decoded) artifacts[key] = await pngBlob(source);
  artifacts.skinRatio = decoded.has("semanticskinmattev2")
    ? maskCoverage(decoded.get("semanticskinmattev2")) : 0;
  artifacts.peopleRatio = decoded.has("semanticpersonmatte")
    ? maskCoverage(decoded.get("semanticpersonmatte")) : 0;
  artifacts.itemIds = Object.fromEntries([...items].map(([key, spec]) => [key, spec.iid]));
  artifacts.labels = Object.fromEntries([...items.keys()].map((name) => [name, name]));
  artifacts.coverage = Object.fromEntries(
    [...decoded].map(([name, source]) => [name, maskCoverage(source)]));
  artifacts.matteCount = items.size;
  artifacts.missingMattes = WANTED.filter((name) => !items.has(name));
  return artifacts;
}
