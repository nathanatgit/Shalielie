// Experimental "Any Image" for the web build: a JPEG, PNG, WebP (or a HEIC the browser can
// draw) becomes an iPhone-shaped SDR HEIC that the porter can then style. A port of
// build_heic_from_image / assemble_heic in photographic_style_port.py, which the iOS app's
// RasterImport.swift also follows: the picture is drawn into sRGB (transparency on black),
// scaled to at most a 12 MP grid, cut into 512 px tiles, and each tile and the thumbnail are
// encoded by the browser's own HEVC encoder (WebCodecs). The source Exif is carried over.

import { be, box, concat } from "./box.js";
import { discoverHeic, ispeBox } from "./heif.js";
import { roundHalfEven } from "./graft.js";
import {
  rasterFrame, rasterColr, checkEncodedColorSpace, resolveEncodedColorSpace,
} from "./raster-color.js";

const TILE = 512, MAX_TILES = 48, THUMB_EDGE = 416;
const ascii = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const full = (type, payload, version = 0) => box(type, concat([new Uint8Array([version, 0, 0, 0]), payload]));
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

async function hevcConfig(width, height) {
  if (!globalThis.VideoEncoder || !globalThis.VideoFrame) return null;
  for (const codec of ["hvc1.1.6.L93.B0", "hev1.1.6.L93.B0"]) {
    const config = {
      codec, width, height, framerate: 1, bitrate: 4_000_000,
      hardwareAcceleration: "prefer-hardware", latencyMode: "quality", hevc: { format: "hevc" },
    };
    try {
      const support = await VideoEncoder.isConfigSupported(config);
      if (support.supported) return support.config || config;
    } catch { /* try the other sample-entry spelling */ }
  }
  return null;
}

/** True when the browser can encode the HEVC this needs. */
export async function canConvert() {
  return (await hevcConfig(TILE, TILE)) !== null;
}

const hvccBox = (description) => box("hvcC", (ArrayBuffer.isView(description)
  ? new Uint8Array(description.buffer, description.byteOffset, description.byteLength)
  : new Uint8Array(description)).slice());

/** Encode the canvas as one HEVC still: {sample, hvcc}. */
async function encodeStill(canvas) {
  const { width, height } = canvas;
  const config = await hevcConfig(width, height);
  if (!config) throw new Error("This browser has no HEVC encoder (WebCodecs), which Any Image needs.");
  let description = null, failure = null;
  const chunks = [], reported = [];
  const encoder = new VideoEncoder({
    output(chunk, metadata) {
      if (metadata?.decoderConfig?.colorSpace) reported.push(metadata.decoderConfig.colorSpace);
      if (metadata?.decoderConfig?.description) description = hvccBox(metadata.decoderConfig.description);
      const payload = new Uint8Array(chunk.byteLength);
      chunk.copyTo(payload);
      chunks.push(payload);
    },
    error(error) { failure = error; },
  });
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  let colorSpace;
  try {
    encoder.configure(config);
    // A probe frame first: the encoder may report a different transfer than it was given, and
    // the real pixels have to match what is written into the file.
    const probe = rasterFrame(ctx, width, height, 0);
    try { encoder.encode(probe.frame, { keyFrame: true }); } finally { probe.frame.close(); }
    await encoder.flush();
    if (failure) throw failure;
    colorSpace = resolveEncodedColorSpace(reported.at(-1), probe.colorSpace);
    chunks.length = 0; reported.length = 0;
    const real = rasterFrame(ctx, width, height, 1_000_000, colorSpace);
    try { encoder.encode(real.frame, { keyFrame: true }); } finally { real.frame.close(); }
    await encoder.flush();
  } finally { encoder.close(); }
  if (failure) throw failure;
  if (!description || chunks.length !== 1) throw new Error("The HEVC encoder returned no image.");
  for (const space of reported) checkEncodedColorSpace(space, colorSpace);
  return { sample: chunks[0], hvcc: description, colr: rasterColr(colorSpace) };
}

function canvasOf(width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  return canvas;
}

// ------------------------------------------------------------------ exif ---

const APPLE_EMPTY_MAKERNOTE = concat([
  ascii("Apple iOS\0"), new Uint8Array([0, 1]), ascii("MM"), new Uint8Array(8)]);

const readUint = (d, off, n, little) => {
  let v = 0;
  for (let i = 0; i < n; i++) v += d[off + i] * 2 ** (8 * (little ? i : n - 1 - i));
  return v;
};

/** The Exif TIFF block of a JPEG, PNG or WebP file, or null. */
export function sourceTiff(data) {
  const text = (off, n) => String.fromCharCode(...data.subarray(off, off + n));
  const noHeader = (p) => (String.fromCharCode(...p.subarray(0, 6)) === "Exif\0\0" ? p.subarray(6) : p);
  if (data[0] === 0xff && data[1] === 0xd8) {
    for (let pos = 2; pos + 4 <= data.length;) {
      if (data[pos++] !== 0xff) return null;
      while (data[pos] === 0xff) pos++;
      const marker = data[pos++];
      if (marker === 0xda || marker === 0xd9) return null;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      const size = readUint(data, pos, 2, false);
      if (size < 2 || pos + size > data.length) return null;
      if (marker === 0xe1 && text(pos + 2, 6) === "Exif\0\0") return data.subarray(pos + 8, pos + size);
      pos += size;
    }
  } else if (data[0] === 0x89 && text(1, 3) === "PNG") {
    for (let pos = 8; pos + 12 <= data.length;) {
      const size = readUint(data, pos, 4, false);
      if (pos + 12 + size > data.length) return null;
      if (text(pos + 4, 4) === "eXIf") return noHeader(data.subarray(pos + 8, pos + 8 + size));
      pos += 12 + size;
    }
  } else if (text(0, 4) === "RIFF" && text(8, 4) === "WEBP") {
    for (let pos = 12; pos + 8 <= data.length;) {
      const size = readUint(data, pos + 4, 4, true);
      if (pos + 8 + size > data.length) return null;
      if (text(pos, 4) === "EXIF") return noHeader(data.subarray(pos + 8, pos + 8 + size));
      pos += 8 + size + (size & 1);
    }
  }
  return null;
}

/** DateTimeOriginal ("YYYY:MM:DD HH:MM:SS") out of a TIFF block, or null. */
function exifDate(tiff) {
  try {
    const little = tiff[0] === 0x49;
    const rd = (off, n) => readUint(tiff, off, n, little);
    const find = (ifd, tag) => {
      const count = rd(ifd, 2);
      for (let i = 0; i < count; i++) if (rd(ifd + 2 + 12 * i, 2) === tag) return ifd + 2 + 12 * i;
      return -1;
    };
    const pointer = find(rd(4, 4), 0x8769);
    if (pointer < 0) return null;
    const entry = find(rd(pointer + 8, 4), 0x9003);
    if (entry < 0) return null;
    const at = rd(entry + 8, 4);
    return String.fromCharCode(...tiff.subarray(at, at + 19));
  } catch { return null; }
}

/** The source Exif for the converted HEIC: location, camera, lens and dates stay byte for byte
 *  where they are; rewritten IFD0 and ExifIFD tables are appended (orientation upright, the new
 *  pixel size, an empty Apple MakerNote when there is none) and the header points at them.
 *  null when the source Exif can't be read. */
export function carryExif(tiff, width, height) {
  if (!tiff || tiff.length < 8 || !(tiff[0] === 0x49 || tiff[0] === 0x4d)) return null;
  const little = tiff[0] === 0x49;
  const rd = (off, n) => readUint(tiff, off, n, little);
  const wr = (v, n) => {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[little ? i : n - 1 - i] = Math.floor(v / 2 ** (8 * i)) & 0xff;
    return out;
  };
  if (rd(2, 2) !== 42) return null;
  const readIfd = (off) => {
    if (off < 8 || off + 2 > tiff.length) throw new Error("bad IFD offset");
    const n = rd(off, 2);
    if (off + 2 + 12 * n + 4 > tiff.length) throw new Error("truncated IFD");
    const entries = new Map();
    for (let i = 0; i < n; i++) entries.set(rd(off + 2 + 12 * i, 2), tiff.slice(off + 2 + 12 * i, off + 14 + 12 * i));
    return entries;
  };
  let ifd0, exif;
  try {
    ifd0 = readIfd(rd(4, 4));
    const pointer = ifd0.get(0x8769);
    exif = pointer ? readIfd(readUint(pointer, 8, 4, little)) : new Map();
  } catch { return null; }
  const chunks = [tiff.slice()];
  let length = tiff.length;
  const append = (blob) => {
    if (length & 1) { chunks.push(new Uint8Array(1)); length++; }
    const off = length;
    chunks.push(blob); length += blob.length;
    return off;
  };
  const entry = (tag, type, count, value) => concat([wr(tag, 2), wr(type, 2), wr(count, 4), value]);
  const long = (v) => wr(v, 4);
  const short = (v) => concat([wr(v, 2), new Uint8Array(2)]);
  const maker = exif.get(0x927c);
  let apple = false;
  if (maker) {
    const count = readUint(maker, 4, 4, little), off = readUint(maker, 8, 4, little);
    apple = count > 20 && String.fromCharCode(...tiff.subarray(off, off + 9)) === "Apple iOS";
  }
  if (!apple)
    exif.set(0x927c, entry(0x927c, 7, APPLE_EMPTY_MAKERNOTE.length, long(append(APPLE_EMPTY_MAKERNOTE))));
  exif.set(0xa002, entry(0xa002, 4, 1, long(width)));
  exif.set(0xa003, entry(0xa003, 4, 1, long(height)));
  ifd0.set(0x0112, entry(0x0112, 3, 1, short(1)));            // the pixels are upright now
  for (const [tag, value] of [[0x0100, width], [0x0101, height]])
    if (ifd0.has(tag)) ifd0.set(tag, entry(tag, 4, 1, long(value)));
  const table = (entries) => concat([wr(entries.size, 2),
    ...[...entries].sort(([a], [b]) => a - b).map(([, v]) => v), new Uint8Array(4)]);
  ifd0.set(0x8769, entry(0x8769, 4, 1, long(append(table(exif)))));
  const rootOffset = append(table(ifd0));
  const out = concat(chunks);
  out.set(long(rootOffset), 4);
  return concat([be(6, 4), ascii("Exif\0\0"), out]);
}

/** A minimal big-endian Exif with an empty Apple MakerNote (and the capture date). */
export function appleExif(width, height, date) {
  const entries = [];
  if (date) entries.push([0x9003, 2, 20, concat([ascii(date.slice(0, 19).padEnd(19, " ")), new Uint8Array(1)])]);
  entries.push([0x927c, 7, APPLE_EMPTY_MAKERNOTE.length, APPLE_EMPTY_MAKERNOTE]);
  entries.push([0xa002, 4, 1, be(width, 4)], [0xa003, 4, 1, be(height, 4)]);
  const exifIfd = 8 + 2 + 12 + 4;
  const dataStart = exifIfd + 2 + 12 * entries.length + 4;
  const table = [], area = [];
  let areaLength = 0;
  for (const [tag, type, count, value] of entries) {
    table.push(be(tag, 2), be(type, 2), be(count, 4));
    if (value.length <= 4) table.push(concat([value, new Uint8Array(4 - value.length)]));
    else {
      table.push(be(dataStart + areaLength, 4));
      const padded = value.length & 1 ? concat([value, new Uint8Array(1)]) : value;
      area.push(padded);
      areaLength += padded.length;
    }
  }
  const tiff = concat([ascii("MM"), be(42, 2), be(8, 4),
    be(1, 2), be(0x8769, 2), be(4, 2), be(1, 4), be(exifIfd, 4), new Uint8Array(4),
    be(entries.length, 2), ...table, new Uint8Array(4), ...area]);
  return concat([be(6, 4), ascii("Exif\0\0"), tiff]);
}

// -------------------------------------------------------------- assemble ---

const SRGB_NCLX = box("colr", concat([ascii("nclx"), be(1, 2), be(13, 2), be(1, 2), new Uint8Array([0x80])]));
const PIXI_8BIT = box("pixi", new Uint8Array([0, 0, 0, 0, 3, 8, 8, 8]));
const infe = (iid, type, hidden) => box("infe", concat([new Uint8Array([2, 0, 0, hidden ? 1 : 0]),
  be(iid, 2), new Uint8Array(2), ascii(type), new Uint8Array(1)]));
const refBox = (type, from, to) =>
  box(type, concat([be(from, 2), be(to.length, 2), ...to.map((t) => be(t, 2))]));
const ipmaEntry = (iid, assoc) => concat([be(iid, 2), new Uint8Array([assoc.length]),
  new Uint8Array(assoc.map(([i, essential]) => (essential ? 0x80 : 0) | i))]);

/** ftyp + meta + mdat for a grid of 512 px HEVC tiles, a thumbnail and Exif, laid out the way
 *  the porter's parser and rebuild expect (iloc v1, 4-byte offsets, grid in idat). */
export function assembleHeic(width, height, tiles, thumb, exif) {
  const cols = Math.ceil(width / TILE), rows = Math.ceil(height / TILE);
  if (tiles.length !== cols * rows) throw new Error("Tile count does not match the grid");
  const primary = 1;
  const tileIds = tiles.map((_, n) => 2 + n);
  const thumbId = tileIds.at(-1) + 1, exifId = thumbId + 1;

  const props = [SRGB_NCLX, PIXI_8BIT, ispeBox(TILE, TILE), ispeBox(width, height),
    thumb.hvcc, ispeBox(thumb.width, thumb.height)];
  const [colrI, pixiI, tileIspeI, primaryIspeI, thumbHvccI, thumbIspeI] = [1, 2, 3, 4, 5, 6];
  const hvccIndex = [], tileHvcc = [];
  for (const { hvcc } of tiles) {
    let found = hvccIndex.find((e) => same(e.hvcc, hvcc));
    if (!found) {
      props.push(hvcc);
      found = { hvcc, index: props.length };
      hvccIndex.push(found);
    }
    tileHvcc.push(found.index);
  }
  if (props.length > 0x7f) throw new Error("Too many distinct tile encodings");
  const assoc = [[primary, [[primaryIspeI, false], [colrI, false], [pixiI, false]]]];
  tileIds.forEach((iid, n) => assoc.push([iid,
    [[tileHvcc[n], true], [tileIspeI, false], [colrI, false], [pixiI, false]]]));
  assoc.push([thumbId, [[thumbHvccI, true], [thumbIspeI, false], [colrI, false], [pixiI, false]]]);
  const ipma = full("ipma", concat([be(assoc.length, 4), ...assoc.map(([iid, a]) => ipmaEntry(iid, a))]));
  const iprp = box("iprp", concat([box("ipco", concat(props)), ipma]));

  const infes = [infe(primary, "grid", false), ...tileIds.map((i) => infe(i, "hvc1", true)),
    infe(thumbId, "hvc1", false), infe(exifId, "Exif", true)];
  const iinf = full("iinf", concat([be(infes.length, 2), ...infes]));
  const iref = full("iref", concat([refBox("dimg", primary, tileIds),
    refBox("thmb", thumbId, [primary]), refBox("cdsc", exifId, [primary])]));
  const grid = concat([new Uint8Array([0, 0, rows - 1, cols - 1]), be(width, 2), be(height, 2)]);
  const payloads = [...tileIds.map((iid, n) => [iid, tiles[n].sample]),
    [thumbId, thumb.sample], [exifId, exif]];

  const metaWith = (offsets) => {
    const entries = [[primary, 1, 0, grid.length],
      ...payloads.map(([iid, blob]) => [iid, 0, offsets.get(iid) || 0, blob.length])];
    const iloc = full("iloc", concat([new Uint8Array([0x44, 0x00]), be(entries.length, 2),
      ...entries.map(([iid, cm, off, len]) => concat([
        be(iid, 2), be(cm, 2), new Uint8Array(2), be(1, 2), be(off, 4), be(len, 4)]))]), 1);
    const hdlr = full("hdlr", concat([new Uint8Array(4), ascii("pict"), new Uint8Array(12), new Uint8Array(1)]));
    return full("meta", concat([hdlr, full("pitm", be(primary, 2)), iloc, iinf, iref, iprp, box("idat", grid)]));
  };
  const ftyp = box("ftyp", concat([ascii("heic"), new Uint8Array(4), ascii("mif1MiHEMiPrmiafMiHBheic")]));
  let meta = metaWith(new Map());
  let cursor = ftyp.length + meta.length + 8;
  const offsets = new Map();
  for (const [iid, blob] of payloads) { offsets.set(iid, cursor); cursor += blob.length; }
  meta = metaWith(offsets);
  const body = concat(payloads.map(([, blob]) => blob));
  return concat([ftyp, meta, be(8 + body.length, 4), ascii("mdat"), body]);
}

// --------------------------------------------------------------- convert ---

/** A HEIC the porter takes as it is: a grid primary with a thumbnail and Exif. */
export function isAppleShapedHeic(data) {
  try {
    const d = discoverHeic(data);
    return d.primaryTiles.length > 0 && d.thumbnail !== null && d.exifItem !== null;
  } catch { return false; }
}

async function openImage(file) {
  try { return await createImageBitmap(file, { imageOrientation: "from-image" }); } catch { /* retry */ }
  try { return await createImageBitmap(file); } catch (error) {
    throw new Error(`The browser can't read ${file.name} as a picture (${error?.message || error}).`);
  }
}

/** The size that fits the picture in at most MAX_TILES tiles. */
export function fitTiles(width, height) {
  if (Math.ceil(width / TILE) * Math.ceil(height / TILE) <= MAX_TILES) return [width, height];
  let best = 0;
  for (let cols = 1; cols <= MAX_TILES; cols++)
    best = Math.max(best, Math.min(cols * TILE / width, Math.floor(MAX_TILES / cols) * TILE / height, 1));
  return [Math.max(2, Math.floor(width * best)), Math.max(2, Math.floor(height * best))];
}

/**
 * @param file   the picture
 * @param bytes  its bytes (the Exif is carried over)
 * @returns {{heic: Uint8Array, canvas: HTMLCanvasElement, width, height}} canvas is the upright
 *   picture the HEIC was cut from, for Find Faces.
 */
export async function convertToHeic(file, bytes, onProgress = () => {}) {
  const image = await openImage(file);
  try {
    const [width, height] = fitTiles(image.width, image.height);
    const canvas = canvasOf(width, height);
    const ctx = canvas.getContext("2d", { alpha: false, colorSpace: "srgb", willReadFrequently: true });
    ctx.fillStyle = "black"; ctx.fillRect(0, 0, width, height);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(image, 0, 0, width, height);

    const cols = Math.ceil(width / TILE), rows = Math.ceil(height / TILE);
    const tiles = [];
    for (let n = 0; n < cols * rows; n++) {
      const tile = canvasOf(TILE, TILE);
      const tctx = tile.getContext("2d", { alpha: false, colorSpace: "srgb", willReadFrequently: true });
      tctx.fillStyle = "black"; tctx.fillRect(0, 0, TILE, TILE);
      tctx.drawImage(canvas, (n % cols) * TILE, Math.floor(n / cols) * TILE, TILE, TILE, 0, 0, TILE, TILE);
      const { sample, hvcc } = await encodeStill(tile);
      tiles.push({ sample, hvcc });
      onProgress({ stage: "tiles", done: n + 1, total: cols * rows });
    }
    const scale = THUMB_EDGE / Math.max(width, height);
    const [tw, th] = [width, height].map((v) => Math.max(2, roundHalfEven(v * scale / 2) * 2));
    const thumbCanvas = canvasOf(tw, th);
    const thctx = thumbCanvas.getContext("2d", { alpha: false, colorSpace: "srgb", willReadFrequently: true });
    thctx.imageSmoothingQuality = "high";
    thctx.drawImage(canvas, 0, 0, tw, th);
    const thumbEncoded = await encodeStill(thumbCanvas);
    const tiff = sourceTiff(bytes);
    const exif = carryExif(tiff, width, height) || appleExif(width, height, tiff ? exifDate(tiff) : null);
    const heic = assembleHeic(width, height, tiles,
      { sample: thumbEncoded.sample, hvcc: thumbEncoded.hvcc, width: tw, height: th }, exif);
    return { heic, canvas, width, height };
  } finally { image.close?.(); }
}
