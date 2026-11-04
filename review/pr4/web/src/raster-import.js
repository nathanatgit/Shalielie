import { isolatePrimaryImage } from "./primary-source.js?v=0.6.0-web";
// Experimental raster (PNG/JPEG/WebP) -> Apple-shaped Photographic Style HEIC import.
// Primary and independent 8-bit linear encoding use local Canvas + WebCodecs.

import { topBox, metaChildren, findChild, be, box, concat } from "./box.js?v=0.6.0-web";
import {
  discoverHeic, parseIloc, parseIpcoIpma, extractItem, propertyForItem,
  replaceIpcoProperty, repointItemProperty, removeItems, setItemReference, ispeBox, addItems,
  propertyBoxBytes, auxUriForItem, dimensionsForItem, DEPTH_URI, MATTE_URIS,
  appendIpcoProperty, associateItemProperty, setItemPropertyAssociations,
} from "./heif.js?v=0.6.0-web";
import { addTextureItems, upgradeStylesV16 } from "./texture.js?v=0.6.0-web";
import {
  applySceneStatistics, applyPersonMetadata, setPersonMasksValid, linearLumaFromRgb,
} from "./styles.js?v=0.6.0-web";
import { generateRasterFaceMattes } from "./face-mattes.js?v=0.6.0-web";
import {installPortraitMatte} from './portrait-matte.js?v=0.6.0-web';
import { extractRasterExif, preserveRasterExif } from "./exif.js?v=0.6.0-web";
import { rasterFrame, rasterColr, rasterVideoColorSpace, checkEncodedColorSpace, resolveEncodedColorSpace } from "./raster-color.js?v=0.6.0-web";
import { encodeSelectedLinearThumbnail as encodeLinearThumbnail } from "./linear-thumbnail.js?v=0.6.0-web";
import { irotAngleForItem, imirAxisForItem } from "./heif.js?v=0.6.0-web";

const TILE = 512, MAX_PRIMARY_TILES = 48;
const THUMB_W = 416, THUMB_H = 312;

const bytes = (s) => new TextEncoder().encode(s);

function colorContext(canvas, options = {}) {
  // Browser HEVC encoders commonly output BT.709. Convert source ICC/P3 colours here
  // rather than feeding P3 samples that the encoder may silently label as BT.709.
  return canvas.getContext("2d", { ...options, colorSpace: "srgb" });
}

function hvccBox(description) {
  const record = ArrayBuffer.isView(description)
    ? new Uint8Array(description.buffer, description.byteOffset, description.byteLength).slice()
    : new Uint8Array(description).slice();
  return box("hvcC", record);
}

async function supportedHevcConfig(width, height, bitrate) {
  if (!globalThis.VideoEncoder || !globalThis.VideoFrame) return null;
  for (const codec of ["hvc1.1.6.L93.B0", "hev1.1.6.L93.B0"]) {
    const config = {
      codec, width, height, framerate: 1, bitrate,
      hardwareAcceleration: "prefer-hardware", latencyMode: "quality",
      hevc: { format: "hevc" },
    };
    try {
      const support = await VideoEncoder.isConfigSupported(config);
      if (support.supported) return support.config || config;
    } catch { /* try the alternate HEVC sample-entry spelling */ }
  }
  return null;
}

export async function encodeCanvases(width, height, count, draw, bitrate, progress) {
  const config = await supportedHevcConfig(width, height, bitrate);
  if (!config) throw new Error("HEVC WebCodecs encoder unavailable for raster import");
  let description = null, encoderError = null, inputColorSpace = null;
  const outputColorSpaces = [];
  const chunks = [];
  const encoder = new VideoEncoder({
    output(chunk, metadata) {
      if (metadata?.decoderConfig?.colorSpace) outputColorSpaces.push(metadata.decoderConfig.colorSpace);
      if (metadata?.decoderConfig?.description) {
        const source = metadata.decoderConfig.description;
        description = ArrayBuffer.isView(source)
          ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength).slice()
          : new Uint8Array(source).slice();
      }
      const payload = new Uint8Array(chunk.byteLength);
      chunk.copyTo(payload);
      chunks.push(payload);
    },
    error(error) { encoderError = error; },
  });
  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  const ctx = colorContext(canvas, { alpha: false, desynchronized: true });
  if (!ctx) throw new Error("Could not create raster import canvas");
  try {
    encoder.configure(config);
    // Probe the same encoder/size first. Its output can use sRGB transfer even when
    // an input frame requests BT.709 transfer; real pixels must match the reported format.
    ctx.fillStyle = "black";
    ctx.fillRect(0, 0, width, height);
    const probe = rasterFrame(ctx, width, height, 0);
    try { encoder.encode(probe.frame, { keyFrame: true }); }
    finally { probe.frame.close(); }
    await encoder.flush();
    if (encoderError) throw encoderError;
    inputColorSpace = resolveEncodedColorSpace(outputColorSpaces.at(-1), probe.colorSpace);
    chunks.length = 0;
    outputColorSpaces.length = 0;
    for (let i = 0; i < count; i++) {
      draw(ctx, i);
      const prepared = rasterFrame(ctx, width, height, (i + 1) * 1_000_000, inputColorSpace);
      const frame = prepared.frame;
      if (inputColorSpace) checkEncodedColorSpace(prepared.colorSpace, inputColorSpace);
      else inputColorSpace = prepared.colorSpace;
      try { encoder.encode(frame, { keyFrame: true }); }
      finally { frame.close(); }
      if (encoder.encodeQueueSize > 3) await new Promise((resolve) => {
        const done = () => { encoder.removeEventListener("dequeue", done); resolve(); };
        encoder.addEventListener("dequeue", done, { once: true });
      });
      progress?.(i + 1, count);
    }
    await encoder.flush();
  } finally { encoder.close(); }
  if (encoderError) throw encoderError;
  if (!description || chunks.length !== count)
    throw new Error(`HEVC encoder returned ${chunks.length}/${count} raster frames`);
  for (const colorSpace of outputColorSpaces) checkEncodedColorSpace(colorSpace, inputColorSpace);
  return { chunks, hvcc: hvccBox(description), colr: rasterColr(inputColorSpace) };
}

function drawContained(ctx, image, width, height) {
  ctx.save();
  ctx.fillStyle = "black";
  ctx.fillRect(0, 0, width, height);
  const scale = Math.min(width / image.width, height / image.height);
  const w = image.width * scale, h = image.height * scale;
  ctx.drawImage(image, (width - w) / 2, (height - h) / 2, w, h);
  ctx.restore();
}

const even = (value) => Math.max(16, Math.round(value / 2) * 2);

function fitWithinTileBudget(width, height, limit) {
  if (Math.ceil(width / TILE) * Math.ceil(height / TILE) <= limit)
    return [width, height];
  let bestScale = 0;
  for (let columns = 1; columns <= limit; columns++) {
    const rows = Math.floor(limit / columns);
    const scale = Math.min(columns * TILE / width, rows * TILE / height, 1);
    if (scale > bestScale) bestScale = scale;
  }
  return [Math.max(1, Math.floor(width * bestScale)),
    Math.max(1, Math.floor(height * bestScale))];
}

export function targetGeometry(image) {
  // Keep the source's displayed pixel dimensions whenever 48 donor slots can hold it.
  // The donor carries irot=270, so the encoded grid uses the swapped stored dimensions.
  const [storedWidth, storedHeight] = fitWithinTileBudget(
    image.height, image.width, MAX_PRIMARY_TILES);
  const displayWidth = storedHeight, displayHeight = storedWidth;
  const primaryColumns = Math.ceil(storedWidth / TILE);
  const primaryRows = Math.ceil(storedHeight / TILE);
  const mapScale = Math.min(1, 2880 / storedWidth, 2160 / storedHeight);
  const thumbScale = Math.min(THUMB_W / storedWidth, THUMB_H / storedHeight);
  const hdrWidth = Math.max(1, Math.round(storedWidth / 2));
  const hdrHeight = Math.max(1, Math.round(storedHeight / 2));
  const deltaWidth = Math.max(1, Math.round(storedWidth * mapScale));
  const deltaHeight = Math.max(1, Math.round(storedHeight * mapScale));
  return {
    displayWidth, displayHeight, storedWidth, storedHeight,
    sourceWidth: image.width, sourceHeight: image.height,
    resized: displayWidth !== image.width || displayHeight !== image.height,
    primaryColumns, primaryRows, primaryTiles: primaryColumns * primaryRows,
    hdrWidth, hdrHeight,
    hdrColumns: Math.ceil(hdrWidth / TILE), hdrRows: Math.ceil(hdrHeight / TILE),
    deltaWidth, deltaHeight,
    deltaColumns: Math.ceil(deltaWidth / TILE), deltaRows: Math.ceil(deltaHeight / TILE),
    thumbWidth: even(storedWidth * thumbScale), thumbHeight: even(storedHeight * thumbScale),
  };
}

function storedCanvas(image, geometry) {
  const canvas = document.createElement("canvas");
  canvas.width = geometry.storedWidth; canvas.height = geometry.storedHeight;
  const ctx = colorContext(canvas, { alpha: false });
  ctx.fillStyle = "black"; ctx.fillRect(0, 0, canvas.width, canvas.height);
  // The donor primary carries irot=270. Draw the upright source through
  // its inverse so Photos presents it upright after applying the item transform.
  ctx.save();
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.translate(-geometry.displayWidth / 2, -geometry.displayHeight / 2);
  ctx.drawImage(image, 0, 0, geometry.displayWidth, geometry.displayHeight);
  ctx.restore();
  return canvas;
}

function thumbnailCanvas(stored, geometry) {
  const canvas = document.createElement("canvas");
  canvas.width = geometry.thumbWidth; canvas.height = geometry.thumbHeight;
  const ctx = colorContext(canvas, { alpha: false });
  ctx.drawImage(stored, 0, 0, canvas.width, canvas.height);
  return canvas;
}

async function openBrowserImage(file) {
  let image, close = () => image?.close?.();
  try { image = await createImageBitmap(file, { imageOrientation: "from-image" }); }
  catch {
    try { image = await createImageBitmap(file); }
    catch {
      const url = URL.createObjectURL(file);
      try {
        const element = new Image();
        element.src = url;
        await element.decode();
        image = element;
        close = () => URL.revokeObjectURL(url);
      } catch (error) {
        URL.revokeObjectURL(url);
        throw new Error(`Raster image decode failed: ${error?.message || error}`);
      }
    }
  }
  return { image, close };
}

/** Build the independent auxiliary without changing the source's primary tiles. */
export async function prepareHeicLinearThumbnail(file, bytes, discovery, onProgress = () => {}) {
  const primaryBytes = isolatePrimaryImage(bytes);
  const primaryFile = new File([primaryBytes], file.name, { type: "image/heic" });
  let opened;
  try { opened = await openBrowserImage(primaryFile); }
  catch (error) { throw new Error(`8-bit linear thumbnail primary decode unavailable: ${error.message}`); }
  try {
    const encoded = await encodeLinearThumbnail(opened.image, {
      angle: irotAngleForItem(bytes, discovery.props, discovery.primary),
      mirror: imirAxisForItem(bytes, discovery.props, discovery.primary),
    }, onProgress);
    return { ...encoded, sourceImage: "isolated-primary", gainMapApplied: false };
  } finally { opened.close(); }
}

export async function prepareHeicAuxiliaries(file, discovery, onProgress = () => {}) {
  const opened = await openBrowserImage(file);
  const { image } = opened;
  try {
    let thumbnail = null, hdrAux = null;
    if (discovery.thumbnail === null) {
      const portrait = image.height > image.width;
      const maxThumbW = portrait ? 312 : 416, maxThumbH = portrait ? 416 : 312;
      const thumbScale = Math.min(maxThumbW / image.width, maxThumbH / image.height);
      const thumbWidth = even(image.width * thumbScale), thumbHeight = even(image.height * thumbScale);
      const thumb = await encodeCanvases(thumbWidth, thumbHeight, 1, (ctx) => {
        ctx.drawImage(image, 0, 0, thumbWidth, thumbHeight);
      }, 800_000);
      thumbnail = {
        payload: thumb.chunks[0], hvcc: thumb.hvcc, colr: thumb.colr,
        width: thumbWidth, height: thumbHeight,
      };
      onProgress({ stage: "thumbnail" });
    }

    if (discovery.hdrGrid === null) {
      const [storedWidth, storedHeight] = dimensionsForItem(discovery.props, discovery.primary);
      const hdrWidth = even(storedWidth / 2), hdrHeight = even(storedHeight / 2);
      const hdr = await encodeCanvases(hdrWidth, hdrHeight, 1, (ctx) => {
        ctx.fillStyle = "black";
        ctx.fillRect(0, 0, hdrWidth, hdrHeight);
      }, 600_000);
      hdrAux = {
        payload: hdr.chunks[0], hvcc: hdr.hvcc, colr: hdr.colr,
        width: hdrWidth, height: hdrHeight,
      };
      onProgress({ stage: "hdr" });
    }
    return {
      thumbnail,
      hdr: hdrAux,
    };
  } finally { opened.close(); }
}

function sceneLuma(image) {
  const canvas = document.createElement("canvas");
  canvas.width = 256; canvas.height = 192;
  const ctx = colorContext(canvas, { alpha: false, willReadFrequently: true });
  drawContained(ctx, image, canvas.width, canvas.height);
  const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const rgb = new Uint8Array(canvas.width * canvas.height * 3);
  for (let i = 0, p = 0; i < rgba.length; i += 4) {
    rgb[p++] = rgba[i]; rgb[p++] = rgba[i + 1]; rgb[p++] = rgba[i + 2];
  }
  return Array.from(linearLumaFromRgb(rgb)).sort((a, b) => a - b);
}

/** Minimal Apple Exif containing Orientation=6 and only MakerNote tag 0x54. */
export function buildRasterExif(mn54, makerType = 7, sourceExif = null, geometry = null) {
  const mnHeader = concat([bytes("Apple iOS"), new Uint8Array([0, 0, 1]), bytes("MM")]);
  const maker = concat([
    mnHeader, be(1, 2),
    be(0x54, 2), be(makerType, 2), be(mn54.length, 4), be(32, 4),
    be(0, 4), mn54,
  ]);
  const tiff = concat([
    bytes("MM"), be(42, 2), be(8, 4),
    be(2, 2),
    be(0x0112, 2), be(3, 2), be(1, 4), be(6, 2), be(0, 2),
    be(0x8769, 2), be(4, 2), be(1, 4), be(38, 4),
    be(0, 4),
    be(1, 2),
    be(0x927c, 2), be(7, 2), be(maker.length, 4), be(56, 4),
    be(0, 4), maker,
  ]);
  const minimal = concat([be(6, 4), bytes("Exif\0\0"), tiff]);
  return sourceExif ? preserveRasterExif(sourceExif, minimal, {
    width: geometry?.storedWidth, height: geometry?.storedHeight,
  }) : minimal;
}

function setGridLayout(meta, iid, width, height, columns = null, rows = null) {
  const iloc = parseIloc(meta, topBox(meta, "meta"));
  const item = iloc.items.get(iid);
  if (!item || item.constructionMethod !== 1 || item.extents.length !== 1)
    throw new Error(`Grid item ${iid} is not stored in idat`);
  const idat = findChild(metaChildren(meta, topBox(meta, "meta")), "idat");
  const extent = item.extents[0];
  const offset = idat.off + idat.hdr + item.baseOffset + extent.offset;
  if (extent.length < 8 || meta[offset] !== 0 || (meta[offset + 1] & 1))
    throw new Error(`Grid item ${iid} has an unsupported descriptor`);
  const out = meta.slice();
  if (columns !== null && rows !== null) {
    if (columns < 1 || columns > 256 || rows < 1 || rows > 256)
      throw new Error(`Grid item ${iid} has invalid ${columns}x${rows} layout`);
    out[offset + 2] = rows - 1;
    out[offset + 3] = columns - 1;
  }
  out.set(be(width, 2), offset + 4);
  out.set(be(height, 2), offset + 6);
  return out;
}

function replaceIspe(meta, iid, width, height) {
  const props = parseIpcoIpma(meta, topBox(meta, "meta"));
  const ispe = propertyForItem(props, iid, "ispe");
  if (!ispe) throw new Error(`Item ${iid} has no ispe property`);
  return replaceIpcoProperty(meta, ispe.index, ispeBox(width, height), "ispe");
}

function same(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Capture a source Portrait depth auxiliary and its XMP sidecar for compatibility re-encode. */
export function extractPortraitDepth(source, discovery = discoverHeic(source)) {
  const depthId = [...discovery.infos.keys()]
    .find((iid) => auxUriForItem(discovery.props, iid) === DEPTH_URI);
  if (depthId === undefined) return null;
  const item = discovery.iloc.items.get(depthId);
  if (!item || item.constructionMethod !== 0 || !item.extents.length) return null;
  const boxes = ["ispe", "pixi", "colr", "hvcC", "irot", "imir"]
    .map((type) => propertyBoxBytes(source, discovery.props, depthId, type)).filter(Boolean);
  const auxc = propertyBoxBytes(source, discovery.props, depthId, "auxC");
  if (!auxc || !boxes.some((b) => String.fromCharCode(...b.slice(4, 8)) === "hvcC"))
    return null;
  const sidecars = [];
  for (const ref of discovery.refs) {
    if (ref.type !== "cdsc" || !ref.to.includes(depthId)) continue;
    const info = discovery.infos.get(ref.from);
    const sidecar = discovery.iloc.items.get(ref.from);
    if (info?.type !== "mime" || !sidecar || sidecar.constructionMethod !== 0) continue;
    sidecars.push({
      contentType: info.contentType || "application/rdf+xml",
      payload: extractItem(source, discovery.iloc, ref.from),
    });
  }
  return {
    itemType: discovery.infos.get(depthId)?.type || "hvc1",
    payload: extractItem(source, discovery.iloc, depthId), boxes, auxc, sidecars,
  };
}

function appendPortraitDepth(meta, payloads, depth, primary) {
  if (!depth) return [meta, null];
  const tmaps = [...discoverHeic(meta).infos]
    .filter(([, info]) => info.type === "tmap").map(([iid]) => iid);
  let assigned;
  [meta, assigned] = addItems(meta, [{
    key: "portrait-depth", itemType: depth.itemType || "hvc1",
    boxes: depth.boxes || [], auxc: depth.auxc,
    refType: "auxl", refTo: [primary, ...tmaps],
  }]);
  const depthId = assigned.get("portrait-depth");
  payloads.set(depthId, depth.payload);
  const specs = (depth.sidecars || []).map((sidecar, index) => ({
    key: `portrait-depth-xmp-${index}`, itemType: "mime",
    contentType: sidecar.contentType || "application/rdf+xml",
    refType: "cdsc", refTo: [depthId], _payload: sidecar.payload,
  }));
  if (specs.length) {
    let sidecarIds;
    [meta, sidecarIds] = addItems(meta, specs);
    for (const spec of specs) payloads.set(sidecarIds.get(spec.key), spec._payload);
  }
  return [meta, depthId];
}

/** Adapt the 48/12 donor graph to encoded raster geometry. Exported for container tests. */
export function buildRasterHeic(profile, encoded, sortedLuma = null, faceResult = null,
  geometry = null) {
  const manifest = profile.manifest;
  if (Number(manifest.primary_tile_count) !== 48 || Number(manifest.hdr_tile_count) !== 12)
    throw new Error("Raster import requires the 48/12 profile");
  if (encoded.main.length < 1 || encoded.main.length > 48)
    throw new Error("Raster import needs between 1 and 48 primary tiles");
  let meta = profile.meta.slice();
  const payloads = new Map(profile.retained);
  let primarySlots = manifest.donor_primary_tiles.map(Number);
  let hdrSlots = manifest.donor_hdr_tiles.map(Number);
  let deltaSlots = manifest.donor_delta_tiles.map(Number);
  if (geometry) {
    const primaryId = Number(manifest.donor_primary_item);
    const hdrId = Number(manifest.donor_hdr_grid_item);
    const deltaId = Number(manifest.donor_delta_grid_item);
    const tmapId = [...discoverHeic(meta).infos].find(([, info]) => info.type === "tmap")?.[0];
    const primaryColumns = geometry.primaryColumns ?? 8;
    const primaryRows = geometry.primaryRows ?? 6;
    const primaryCount = geometry.primaryTiles ?? encoded.main.length;
    if (primaryCount !== encoded.main.length || primaryCount > primarySlots.length
        || primaryColumns * primaryRows !== primaryCount)
      throw new Error("Raster geometry does not match encoded primary tiles");
    const unusedPrimary = primarySlots.slice(primaryCount);
    if (unusedPrimary.length) {
      meta = removeItems(meta, unusedPrimary);
      unusedPrimary.forEach((iid) => payloads.delete(iid));
    }
    primarySlots = primarySlots.slice(0, primaryCount);
    meta = setItemReference(meta, "dimg", primaryId, primarySlots);
    meta = setGridLayout(meta, primaryId, geometry.storedWidth, geometry.storedHeight,
      primaryColumns, primaryRows);
    meta = replaceIspe(meta, primaryId, geometry.storedWidth, geometry.storedHeight);

    const hdrColumns = geometry.hdrColumns ?? 4;
    const hdrRows = geometry.hdrRows ?? 3;
    const hdrCount = hdrColumns * hdrRows;
    if (hdrCount < 1 || hdrCount > hdrSlots.length)
      throw new Error("Raster HDR grid exceeds donor capacity");
    const unusedHdr = hdrSlots.slice(hdrCount);
    if (unusedHdr.length) {
      meta = removeItems(meta, unusedHdr);
      unusedHdr.forEach((iid) => payloads.delete(iid));
    }
    hdrSlots = hdrSlots.slice(0, hdrCount);
    meta = setItemReference(meta, "dimg", hdrId, hdrSlots);
    meta = setGridLayout(meta, hdrId, geometry.hdrWidth, geometry.hdrHeight,
      hdrColumns, hdrRows);
    meta = replaceIspe(meta, hdrId, geometry.hdrWidth, geometry.hdrHeight);
    if (Number.isFinite(deltaId)) {
      const deltaColumns = geometry.deltaColumns ?? 6;
      const deltaRows = geometry.deltaRows ?? 5;
      const deltaCount = deltaColumns * deltaRows;
      if (deltaCount > deltaSlots.length)
        throw new Error(`Raster StyleDeltaMap needs ${deltaCount} tiles`);
      const unusedDelta = deltaSlots.slice(deltaCount);
      if (unusedDelta.length) {
        meta = removeItems(meta, unusedDelta);
        unusedDelta.forEach((iid) => payloads.delete(iid));
      }
      deltaSlots = deltaSlots.slice(0, deltaCount);
      meta = setItemReference(meta, "dimg", deltaId, deltaSlots);
      meta = setGridLayout(meta, deltaId, geometry.deltaWidth, geometry.deltaHeight,
        deltaColumns, deltaRows);
      meta = replaceIspe(meta, deltaId, geometry.deltaWidth, geometry.deltaHeight);
    }
    if (tmapId !== undefined)
      meta = replaceIspe(meta, tmapId, geometry.displayWidth, geometry.displayHeight);
    meta = replaceIspe(meta, Number(manifest.donor_thumbnail_item),
      geometry.thumbWidth, geometry.thumbHeight);
  }

  // The donor's old people mattes must never leak into a newly imported screenshot/photo.
  const donorPeople = [96, 97, 98, 99, 100, 101].filter((iid) =>
    parseIloc(meta, topBox(meta, "meta")).items.has(iid));
  if (donorPeople.length) {
    meta = removeItems(meta, donorPeople);
    donorPeople.forEach((iid) => payloads.delete(iid));
  }

  primarySlots.forEach((iid, i) => payloads.set(iid, encoded.main[i]));
  payloads.set(Number(manifest.donor_thumbnail_item), encoded.thumb);
  payloads.set(Number(manifest.donor_linear_thumb_item), encoded.linearThumbnail?.payload || encoded.thumb);
  hdrSlots.forEach((iid) => payloads.set(iid, encoded.hdr));
  const makerType = Number(manifest.smartstyle_makernote_type ?? 7);
  const exif = buildRasterExif(profile.mn54, makerType, encoded.sourceExif, geometry);
  payloads.set(Number(manifest.donor_exif_item), exif);

  let props = parseIpcoIpma(meta, topBox(meta, "meta"));
  const main0 = Number(manifest.donor_primary_tiles[0]);
  meta = replaceIpcoProperty(meta, propertyForItem(props, main0, "hvcC").index,
    encoded.mainHvcc, "hvcC");
  props = parseIpcoIpma(meta, topBox(meta, "meta"));
  const thumb = Number(manifest.donor_thumbnail_item);
  meta = replaceIpcoProperty(meta, propertyForItem(props, thumb, "hvcC").index,
    encoded.thumbHvcc, "hvcC");

  // Encoded RGB/YUV color must travel with its own colr, never the donor's ICC profile.
  const assignColor = (ids, color) => {
    let index;
    [meta, index] = appendIpcoProperty(meta, color);
    for (const iid of ids) {
      const current = parseIpcoIpma(meta, topBox(meta, "meta"));
      const kept = (current.associations.get(iid) || []).filter(a => !["colr", "clli", "mdcv"].includes(current.properties[a.index - 1]?.type));
      meta = setItemPropertyAssociations(meta, iid, [...kept.map(a => [a.index, a.essential]), [index, false]]);
    }
  };
  const tmapItems = [...discoverHeic(meta).infos].filter(([, info]) => info.type === "tmap")
    .map(([iid]) => iid);
  assignColor([Number(manifest.donor_primary_item), ...primarySlots, ...tmapItems],
    encoded.mainColr || rasterColr(rasterVideoColorSpace()));
  assignColor([thumb, Number(manifest.donor_linear_thumb_item)],
    encoded.thumbColr || rasterColr(rasterVideoColorSpace()));

  // linearthumbnail reuses the encoded thumbnail, including its dimensions/pixi/hvcC.
  const linear = Number(manifest.donor_linear_thumb_item);
  props = parseIpcoIpma(meta, topBox(meta, "meta"));
  for (const type of ["ispe", "pixi", "hvcC"]) {
    const from = propertyForItem(props, linear, type), to = propertyForItem(props, thumb, type);
    if (from && to && from.index !== to.index)
      meta = repointItemProperty(meta, linear, from.index, to.index);
    props = parseIpcoIpma(meta, topBox(meta, "meta"));
  }
  if (encoded.linearThumbnail) {
    const lt = encoded.linearThumbnail;
    for (const [type, value] of [["ispe", ispeBox(lt.width, lt.height)],
      ["pixi", lt.pixi], ["hvcC", lt.hvcc], ["colr", lt.colr]]) {
      let index;
      [meta, index] = appendIpcoProperty(meta, value);
      const current = parseIpcoIpma(meta, topBox(meta, "meta"));
      const kept = (current.associations.get(linear) || []).filter(a => {
        const name = current.properties[a.index - 1]?.type;
        return type === "colr" ? !["colr", "clli", "mdcv"].includes(name) : name !== type;
      });
      meta = setItemPropertyAssociations(meta, linear, [...kept.map(a => [a.index, a.essential]), [index, type === "hvcC"]]);
    }
  }

  const hdr0 = Number(manifest.donor_hdr_tiles[0]);
  props = parseIpcoIpma(meta, topBox(meta, "meta"));
  meta = replaceIpcoProperty(meta, propertyForItem(props, hdr0, "hvcC").index,
    encoded.hdrHvcc, "hvcC");
  // WebCodecs emits ordinary 3-plane video; point the gain-map grid at a 3x8 pixi.
  props = parseIpcoIpma(meta, topBox(meta, "meta"));
  const hdrGrid = Number(manifest.donor_hdr_grid_item);
  assignColor([hdrGrid, ...hdrSlots], encoded.hdrColr || rasterColr(rasterVideoColorSpace()));
  props = parseIpcoIpma(meta, topBox(meta, "meta"));
  const primary = Number(manifest.donor_primary_item);
  const hdrPixi = propertyForItem(props, hdrGrid, "pixi");
  const rgbPixi = propertyForItem(props, primary, "pixi");
  if (hdrPixi && rgbPixi && hdrPixi.index !== rgbPixi.index)
    meta = repointItemProperty(meta, hdrGrid, hdrPixi.index, rgbPixi.index);

  const stylesId = Number(manifest.donor_styles_item);
  let styles = payloads.get(stylesId);
  if (sortedLuma) [styles] = applySceneStatistics(styles, "target", sortedLuma);
  if (faceResult?.state === "generated") {
    [styles] = setPersonMasksValid(styles);
    [styles] = applyPersonMetadata(styles, faceResult.personMetadata);
  }
  [styles] = upgradeStylesV16(styles);
  payloads.set(stylesId, styles);

  // A compatibility re-encode rebuilds the main/HDR graph, but Portrait depth is an
  // independent HEVC auxiliary. Keep its original bitstream, codec properties,
  // orientation, auxiliary relationship, and blur-parameter XMP sidecar intact.
  [meta] = appendPortraitDepth(meta, payloads, encoded.sourceDepth, primary);

  let texturePayloads;
  [meta, texturePayloads] = addTextureItems(meta, primary, {
    matteOverrides: new Map([...(faceResult?.overrides || []), ...(encoded.sourceSkin || [])]),
    texturePeopleData: faceResult?.texturePeopleData,
  });
  for (const [iid, payload] of texturePayloads) payloads.set(iid, payload);
  const portraitResult=installPortraitMatte(meta,payloads,null,null,faceResult?.overrides?.get(MATTE_URIS.portraiteffectsmatte),primary);
  meta=portraitResult.meta;

  const iloc = parseIloc(meta, topBox(meta, "meta"));
  const ids = [...iloc.items].filter(([, item]) => item.constructionMethod === 0 && item.extents.length)
    .map(([iid]) => iid).sort((a, b) => a - b);
  const missing = ids.filter((iid) => !payloads.has(iid));
  if (missing.length) throw new Error(`Profile is missing payload(s): ${missing}`);
  let cursor = profile.ftyp.length + meta.length + 8;
  const metaOut = meta.slice(), chunks = [];
  const outIloc = parseIloc(metaOut, topBox(metaOut, "meta"));
  for (const iid of ids) {
    const payload = payloads.get(iid);
    const extent = outIloc.items.get(iid).extents[0];
    metaOut.set(be(cursor, outIloc.offsetSize), extent.offsetPos);
    metaOut.set(be(payload.length, outIloc.lengthSize), extent.lengthPos);
    chunks.push(payload); cursor += payload.length;
  }
  if (cursor >= 2 ** 32) throw new Error("file too large for 32-bit offsets");
  const mdat = concat(chunks);
  const result = concat([profile.ftyp, metaOut, box("mdat", mdat)]);
  const check = discoverHeic(result);
  for (const iid of ids)
    if (!same(extractItem(result, check.iloc, iid), payloads.get(iid)))
      throw new Error(`self-check failed: raster item ${iid} unreadable`);
  return result;
}

export async function importRaster(file, profile, onProgress = () => {}, {
  faces = false, sourceExif = null, sourceDepth = null, sourceSkin = null,
} = {}) {
  if (!sourceExif) sourceExif = extractRasterExif(new Uint8Array(await file.arrayBuffer()));
  const opened = await openBrowserImage(file);
  const image = opened.image;
  try {
    onProgress({ stage: "prepare", width: image.width, height: image.height });
    if (!await supportedHevcConfig(TILE, TILE, 3_000_000))
      throw new Error("HEVC WebCodecs encoder unavailable for raster import");
    let faceResult = { state: "skipped", overrides: new Map(), faces: 0 };
    const onFaceProgress = detail => onProgress({stage: "faces", detail});
    if (faces) {
      try { faceResult = await generateRasterFaceMattes(image, 270, null, {onProgress: onFaceProgress}); }
      catch (error) {
        console.warn("raster face matte generation unavailable:", error);
        faceResult = { state: "unavailable", overrides: new Map(), faces: 0 };
      }
    }
    if(!faceResult.overrides.has(MATTE_URIS.portraiteffectsmatte)){
      try{const portrait=await generateRasterFaceMattes(image,270,null,{portraitOnly:true,onProgress:onFaceProgress});for(const [uri,value] of portrait.overrides)faceResult.overrides.set(uri,value);}
      catch(e){faceResult.portraitError=e.message;}
    }
    const geometry = targetGeometry(image);
    const linearThumbnail = await encodeLinearThumbnail(image, { angle: 270 }, onProgress);
    const stored = storedCanvas(image, geometry), thumbCanvas = thumbnailCanvas(stored, geometry);
    const main = await encodeCanvases(TILE, TILE, geometry.primaryTiles, (ctx, i) => {
      ctx.fillStyle = "black"; ctx.fillRect(0, 0, TILE, TILE);
      const x = (i % geometry.primaryColumns) * TILE;
      const y = Math.floor(i / geometry.primaryColumns) * TILE;
      ctx.drawImage(stored, -x, -y);
    }, 3_000_000, (done, total) => onProgress({ stage: "main", done, total }));
    onProgress({stage: "auxiliary"});
    const thumb = await encodeCanvases(geometry.thumbWidth, geometry.thumbHeight, 1,
      (ctx) => ctx.drawImage(thumbCanvas, 0, 0), 800_000);
    const hdr = await encodeCanvases(TILE, TILE, 1, (ctx) => {
      ctx.fillStyle = "black"; ctx.fillRect(0, 0, TILE, TILE);
    }, 200_000);
    onProgress({ stage: "assemble" });
    const encoded = {
      main: main.chunks, mainHvcc: main.hvcc, mainColr: main.colr,
      thumb: thumb.chunks[0], thumbHvcc: thumb.hvcc, thumbColr: thumb.colr,
      hdr: hdr.chunks[0], hdrHvcc: hdr.hvcc, hdrColr: hdr.colr,
      sourceExif, sourceDepth, sourceSkin,
      linearThumbnail,
    };
    const luma = sceneLuma(image);
    // Reuse the original main/HDR/thumbnail encodes when correcting generated faces.
    const rebuild = updated => buildRasterHeic(profile, encoded, luma, updated, geometry);
    const data = rebuild(faceResult);
    return { data, rebuild, source: { width: image.width, height: image.height }, faceResult, geometry,
      portraitMatte:{mode:faceResult.overrides.has(MATTE_URIS.portraiteffectsmatte)?'target-person-segmentation':'omitted-unavailable',donorPlaceholderUsed:false,error:faceResult.portraitError},
      linearThumbnail: { mode: linearThumbnail.mode, bitDepth: linearThumbnail.bitDepth, transportColor: linearThumbnail.transportColor, sourcePixels: linearThumbnail.sourcePixels,
        width: linearThumbnail.width, height: linearThumbnail.height } };
  } finally { opened.close(); }
}
