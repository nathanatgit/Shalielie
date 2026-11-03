// Apple MakerNote surgery: preserve the target's Exif and inject only tag 0x54.
// Port of the corresponding functions in photographic_style_port.py.

import { concat, be } from "./box.js?v=0.6.0-web";
import { TIFF_TYPE_SIZES } from "./heif.js?v=0.6.0-web";

const tiffU = (d, off, n, little) => {
  let v = 0;
  if (little) { for (let i = n - 1; i >= 0; i--) v = v * 256 + d[off + i]; }
  else { for (let i = 0; i < n; i++) v = v * 256 + d[off + i]; }
  return v;
};

const tiffBytes = (value, n, little) => {
  const b = be(value, n);
  return little ? b.reverse() : b;
};

/** Read TIFF/Exif Orientation (0x0112). HEIF normally uses irot/imir instead, but a
 * contradictory Exif value is valuable when diagnosing Photos-only rotation bugs. */
export function readExifOrientation(exifPayload) {
  try {
    const tiffStart = tiffU(exifPayload, 0, 4, false) + 4;
    const tiff = exifPayload.subarray(tiffStart);
    if (tiff.length < 8) return null;
    const order = String.fromCharCode(tiff[0], tiff[1]);
    if (order !== "II" && order !== "MM") return null;
    const little = order === "II";
    const ifd0 = tiffU(tiff, 4, 4, little);
    const count = tiffU(tiff, ifd0, 2, little);
    for (let i = 0; i < count; i++) {
      const p = ifd0 + 2 + i * 12;
      if (tiffU(tiff, p, 2, little) !== 0x0112) continue;
      const type = tiffU(tiff, p + 2, 2, little);
      const n = tiffU(tiff, p + 4, 4, little);
      if (type !== 3 || n < 1) return null;
      if (n * 2 <= 4) return tiffU(tiff, p + 8, 2, little);
      const off = tiffU(tiff, p + 8, 4, little);
      return tiffU(tiff, off, 2, little);
    }
  } catch { /* malformed Exif is reported as unavailable in diagnostics */ }
  return null;
}

function locateExifMakerNoteEntry(exifPayload) {
  // The Exif item payload starts with a 4-byte offset to the TIFF header.
  const tiffStart = tiffU(exifPayload, 0, 4, false) + 4;
  const tiff = exifPayload.subarray(tiffStart);
  if (tiff.length < 8) throw new Error("Exif TIFF offset is invalid");
  const order = String.fromCharCode(tiff[0], tiff[1]);
  if (order !== "II" && order !== "MM") throw new Error("Unknown TIFF byte order");
  const little = order === "II";
  const ifd0 = tiffU(tiff, 4, 4, little);
  const n0 = tiffU(tiff, ifd0, 2, little);
  let p = ifd0 + 2;
  let exifIfd = null;
  for (let i = 0; i < n0; i++) {
    if (tiffU(tiff, p, 2, little) === 0x8769) { exifIfd = tiffU(tiff, p + 8, 4, little); break; }
    p += 12;
  }
  if (exifIfd === null) throw new Error("ExifIFD pointer 0x8769 not found");
  const ne = tiffU(tiff, exifIfd, 2, little);
  p = exifIfd + 2;
  for (let i = 0; i < ne; i++) {
    if (tiffU(tiff, p, 2, little) === 0x927c) return { tiffStart, tiff, little, entry: p };
    p += 12;
  }
  throw new Error("Apple MakerNote tag 0x927c not found");
}

export function getMakerNoteBlob(exifPayload) {
  const { tiff, little, entry } = locateExifMakerNoteEntry(exifPayload);
  const typ = tiffU(tiff, entry + 2, 2, little);
  const cnt = tiffU(tiff, entry + 4, 4, little);
  const total = (TIFF_TYPE_SIZES[typ] || 1) * cnt;
  if (total <= 4) return tiff.subarray(entry + 8, entry + 8 + total);
  const off = tiffU(tiff, entry + 8, 4, little);
  return tiff.subarray(off, off + total);
}

export function extractAppleMakerNoteTag(exifPayload, wantedTag = 0x54) {
  const mn = getMakerNoteBlob(exifPayload);
  const sig = String.fromCharCode(...mn.subarray(0, 9));
  if (mn.length < 20 || sig !== "Apple iOS") throw new Error("Unsupported Apple MakerNote");
  const little = String.fromCharCode(mn[12], mn[13]) === "II";
  const n = tiffU(mn, 14, 2, little);
  for (let i = 0; i < n; i++) {
    const p = 16 + i * 12;
    if (tiffU(mn, p, 2, little) !== wantedTag) continue;
    const typ = tiffU(mn, p + 2, 2, little);
    const cnt = tiffU(mn, p + 4, 4, little);
    const total = (TIFF_TYPE_SIZES[typ] || 1) * cnt;
    if (total <= 4) return { type: typ, payload: mn.subarray(p + 8, p + 8 + total) };
    const off = tiffU(mn, p + 8, 4, little);
    return { type: typ, payload: mn.subarray(off, off + total) };
  }
  throw new Error(`Apple MakerNote tag 0x${wantedTag.toString(16)} not found`);
}

/**
 * Preserve the target's Exif and inject or replace one MakerNote tag.
 *
 * The existing MakerNote data area is kept byte for byte: inserting a 12-byte IFD
 * entry shifts it by exactly 12, so only out-of-line value offsets are adjusted.
 * The rebuilt MakerNote is appended at the end of the TIFF block and the outer
 * 0x927c entry is repointed at it, which leaves every other target Exif offset
 * valid. This mirrors the Python implementation exactly.
 */
export function injectAppleMakerNoteTag(exifPayload, payload, wantedTag = 0x54, typ = 7) {
  const { tiffStart, tiff, little: outerLittle, entry } = locateExifMakerNoteEntry(exifPayload);
  const oldMn = getMakerNoteBlob(exifPayload);
  const sig = String.fromCharCode(...oldMn.subarray(0, 9));
  if (oldMn.length < 20 || sig !== "Apple iOS") throw new Error("Unsupported Apple MakerNote");
  const little = String.fromCharCode(oldMn[12], oldMn[13]) === "II";
  const n = tiffU(oldMn, 14, 2, little);
  const tableStart = 16;
  const oldDataStart = tableStart + n * 12 + 4;
  if (oldDataStart > oldMn.length) throw new Error("Truncated Apple MakerNote table");

  const entries = [];
  let found = false;
  for (let i = 0; i < n; i++) {
    const p = tableStart + i * 12;
    const raw = oldMn.slice(p, p + 12);
    const tag = tiffU(raw, 0, 2, little);
    const etyp = tiffU(raw, 2, 2, little);
    const cnt = tiffU(raw, 4, 4, little);
    const total = (TIFF_TYPE_SIZES[etyp] ?? 0) * cnt;
    if (tag === wantedTag) { found = true; continue; }
    entries.push({ tag, raw, total });
  }

  const grow = found ? 0 : 12;
  if (grow) {
    for (const e of entries) {
      if (e.total > 4) {
        const off = tiffU(e.raw, 8, 4, little);
        if (off >= oldDataStart) e.raw.set(tiffBytes(off + grow, 4, little), 8);
      }
    }
  }

  const oldNextPos = tableStart + n * 12;
  const oldNext = tiffU(oldMn, oldNextPos, 4, little);
  const newNext = (grow && oldNext >= oldDataStart && oldNext !== 0) ? oldNext + grow : oldNext;
  const oldData = oldMn.subarray(oldDataStart);

  const newCount = found ? n : n + 1;
  const newDataStart = tableStart + newCount * 12 + 4;
  const newPayloadOff = newDataStart + oldData.length;
  const newEntry = new Uint8Array(12);
  newEntry.set(tiffBytes(wantedTag, 2, little), 0);
  newEntry.set(tiffBytes(typ, 2, little), 2);
  newEntry.set(tiffBytes(payload.length, 4, little), 4);
  if (payload.length <= 4) newEntry.set(payload, 8);
  else newEntry.set(tiffBytes(newPayloadOff, 4, little), 8);
  entries.push({ tag: wantedTag, raw: newEntry, total: payload.length });
  entries.sort((a, b) => a.tag - b.tag);

  const rebuilt = concat([
    oldMn.subarray(0, 14), tiffBytes(newCount, 2, little),
    ...entries.map((e) => e.raw), tiffBytes(newNext, 4, little), oldData,
    payload.length > 4 ? payload : new Uint8Array(0),
  ]);

  const newMnOff = tiff.length;
  const newTiff = concat([tiff, rebuilt]);
  newTiff.set(tiffBytes(7, 2, outerLittle), entry + 2); // UNDEFINED
  newTiff.set(tiffBytes(rebuilt.length, 4, outerLittle), entry + 4);
  newTiff.set(tiffBytes(newMnOff, 4, outerLittle), entry + 8);
  return concat([exifPayload.subarray(0, tiffStart), newTiff]);
}

/** Extract raster EXIF into the HEIF Exif-item representation. No pixel decoding. */
export function extractRasterExif(data) {
  const text = (off, length) => String.fromCharCode(...data.subarray(off, off + length));
  const wrap = payload => {
    const tiff = String.fromCharCode(...payload.subarray(0, 6)) === 'Exif\0\0' ? payload.subarray(6) : payload;
    if (tiff.length < 8 || !['II', 'MM'].includes(String.fromCharCode(...tiff.subarray(0, 2))))
      throw Error('Invalid raster Exif TIFF header');
    return concat([be(6, 4), new TextEncoder().encode('Exif\0\0'), tiff]);
  };
  if (data[0] === 255 && data[1] === 216) {
    for (let pos = 2; pos + 1 < data.length;) {
      if (data[pos++] !== 255) throw Error('Invalid JPEG metadata marker');
      while (data[pos] === 255) pos++;
      const marker = data[pos++];
      if (marker === 218 || marker === 217) break;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      if (pos + 2 > data.length) throw Error('Truncated JPEG metadata');
      const size = data[pos] * 256 + data[pos + 1];
      if (size < 2 || pos + size > data.length) throw Error('Invalid JPEG metadata length');
      if (marker === 225 && size >= 8 && text(pos + 2, 6) === 'Exif\0\0') return wrap(data.subarray(pos + 2, pos + size));
      pos += size;
    }
  } else if (data.length >= 8 && text(1, 3) === 'PNG' && data[0] === 137) {
    for (let pos = 8; pos + 12 <= data.length;) {
      const size = tiffU(data, pos, 4, false);
      if (pos + size + 12 > data.length) throw Error('Truncated PNG metadata chunk');
      if (text(pos + 4, 4) === 'eXIf') return wrap(data.subarray(pos + 8, pos + 8 + size));
      pos += size + 12;
    }
  } else if (data.length >= 12 && text(0, 4) === 'RIFF' && text(8, 4) === 'WEBP') {
    const end = tiffU(data, 4, 4, true) + 8;
    if (end > data.length) throw Error('Truncated WebP metadata');
    for (let pos = 12; pos + 8 <= end;) {
      const size = tiffU(data, pos + 4, 4, true);
      if (pos + 8 + size > end) throw Error('Truncated WebP metadata chunk');
      if (text(pos, 4) === 'EXIF') return wrap(data.subarray(pos + 8, pos + 8 + size));
      pos += 8 + size + (size & 1);
    }
  }
  return null;
}

/** Keep source camera/GPS/date fields while adding the Apple style marker.
 * Append new IFD tables so all original TIFF-relative value offsets remain valid.
 * Output pixels use the raster pipeline's stored orientation, not source Orientation.
 */
export function preserveRasterExif(sourceExif, styleExif, {width, height} = {}) {
  const parse = payload => {
    if (payload.length < 4) throw Error('Truncated source Exif');
    const start = tiffU(payload, 0, 4, false) + 4, tiff = payload.subarray(start);
    const order = String.fromCharCode(...tiff.subarray(0, 2)), little = order === 'II';
    if (tiff.length < 8 || !['II', 'MM'].includes(order) || tiffU(tiff, 2, 2, little) !== 42)
      throw Error('Unsupported source Exif TIFF header');
    const readIfd = off => {
      if (!Number.isInteger(off) || off < 8 || off + 2 > tiff.length) throw Error('Invalid source Exif IFD offset');
      const count = tiffU(tiff, off, 2, little), end = off + 2 + count * 12;
      if (end + 4 > tiff.length) throw Error('Truncated source Exif IFD');
      const entries = new Map();
      for (let i = 0; i < count; i++) {
        const pos = off + 2 + i * 12, raw = tiff.slice(pos, pos + 12);
        const tag = tiffU(raw, 0, 2, little), type = tiffU(raw, 2, 2, little), n = tiffU(raw, 4, 4, little);
        const size = (TIFF_TYPE_SIZES[type] ?? (type === 13 ? 4 : 0)) * n;
        if (size > 4) { const value = tiffU(raw, 8, 4, little); if (value + size > tiff.length) throw Error('Invalid source Exif value offset'); }
        if (entries.has(tag)) throw Error('Duplicate source Exif tag');
        entries.set(tag, raw);
      }
      return entries;
    };
    const root = readIfd(tiffU(tiff, 4, 4, little)), pointer = root.get(0x8769);
    if (pointer && (tiffU(pointer, 2, 2, little) !== 4 || tiffU(pointer, 4, 4, little) !== 1))
      throw Error('Invalid source ExifIFD pointer');
    return {start, tiff, little, root, exif: pointer ? readIfd(tiffU(pointer, 8, 4, little)) : new Map()};
  };
  let work = sourceExif, source = parse(work), nativeApple = false;
  if (source.exif.has(0x927c)) {
    const maker = getMakerNoteBlob(work);
    nativeApple = String.fromCharCode(...maker.subarray(0, 9)) === 'Apple iOS';
    if (nativeApple) {
      const marker = extractAppleMakerNoteTag(styleExif);
      work = injectAppleMakerNoteTag(work, marker.payload, 0x54, marker.type);
      source = parse(work);
    }
  }
  const {start, tiff, little, root, exif} = source;
  const entry = (tag, type, count, value) => concat([tiffBytes(tag, 2, little), tiffBytes(type, 2, little),
    tiffBytes(count, 4, little), tiffBytes(value, type === 3 ? 2 : 4, little), ...(type === 3 ? [new Uint8Array(2)] : [])]);
  const chunks = [tiff.slice()]; let length = tiff.length;
  const append = data => { if (length & 1) { chunks.push(new Uint8Array(1)); length++; } const off = length; chunks.push(data); length += data.length; return off; };
  if (!nativeApple) {
    const maker = getMakerNoteBlob(styleExif), off = append(maker);
    // Retain a non-Apple MakerNote's original bytes in the untouched TIFF area;
    // the active MakerNote must contain Apple's 0x54 marker for style editing.
    exif.set(0x927c, entry(0x927c, 7, maker.length, off));
  }
  root.set(0x0112, entry(0x0112, 3, 1, 6));
  for (const [value, rootTag, exifTag] of [[width, 0x0100, 0xa002], [height, 0x0101, 0xa003]]) {
    if (!Number.isInteger(value) || value < 1 || value > 0xffffffff) continue;
    if (root.has(rootTag)) root.set(rootTag, entry(rootTag, 4, 1, value));
    exif.set(exifTag, entry(exifTag, 4, 1, value));
  }
  const table = entries => concat([tiffBytes(entries.size, 2, little),
    ...[...entries].sort(([a], [b]) => a - b).map(([, raw]) => raw), new Uint8Array(4)]);
  const exifOff = append(table(exif)); root.set(0x8769, entry(0x8769, 4, 1, exifOff));
  // HEIF supplies its own thumbnail; do not retain a stale TIFF thumbnail link.
  const rootOff = append(table(root)), rebuilt = concat(chunks);
  rebuilt.set(tiffBytes(rootOff, 4, little), 4);
  return concat([work.subarray(0, start), rebuilt]);
}
