// Retag already-linear raw I420 samples without decoding or changing picture NALs.
// The browser encoder receives negotiated SDR transport tags because some VideoFrame
// implementations reject linear transfer. This module only changes SPS VUI.
import {be, concat} from './box.js?v=0.6.0-web';

function spsBits(nal) {
  if (nal.length < 3 || (nal[0] >> 1 & 63) !== 33) throw Error('Expected HEVC SPS');
  const bytes = [];
  for (let i = 2; i < nal.length; i++) {
    if (i >= 4 && nal[i] === 3 && nal[i - 1] === 0 && nal[i - 2] === 0) continue;
    bytes.push(nal[i]);
  }
  return bytes.flatMap(b => Array.from({length: 8}, (_, i) => b >> (7 - i) & 1));
}

function locateVui(bits) {
  let pos = 0;
  const read = n => {
    if (pos + n > bits.length) throw Error('Truncated HEVC SPS');
    let value = 0; for (let i = 0; i < n; i++) value = value * 2 + bits[pos++];
    return value;
  };
  const ue = () => {
    let zeros = 0; while (!read(1)) if (++zeros > 30) throw Error('Invalid HEVC SPS code');
    return 2 ** zeros - 1 + read(zeros);
  };
  const bounded = (value, max) => { if (value > max) throw Error('Unsupported HEVC SPS count'); return value; };
  read(4); const layers = read(3); read(1); read(96);
  const flags = Array.from({length: layers}, () => [read(1), read(1)]);
  if (layers) read((8 - layers) * 2);
  for (const [profile, level] of flags) { if (profile) read(88); if (level) read(8); }
  ue(); const chroma = ue(); if (chroma === 3) read(1);
  ue(); ue(); if (read(1)) for (let i = 0; i < 4; i++) ue();
  const luma = ue() + 8, chromaDepth = ue() + 8, pocBits = ue() + 4;
  const ordering = read(1);
  for (let i = ordering ? 0 : layers; i <= layers; i++) { ue(); ue(); ue(); }
  for (let i = 0; i < 6; i++) ue();
  if (read(1) && read(1)) {
    for (let size = 0; size < 4; size++) for (let matrix = 0; matrix < 6; matrix += size === 3 ? 3 : 1) {
      if (!read(1)) ue();
      else { if (size > 1) ue(); for (let i = 0; i < Math.min(64, 1 << (4 + size * 2)); i++) ue(); }
    }
  }
  read(1); read(1);
  if (read(1)) { read(8); ue(); ue(); read(1); }
  const sets = bounded(ue(), 64), counts = [];
  for (let i = 0; i < sets; i++) {
    if (i && read(1)) {
      read(1); ue(); let count = 0;
      for (let j = 0; j <= counts[i - 1]; j++) { const used = read(1); if (used || read(1)) count++; }
      counts.push(count);
    } else {
      const negative = bounded(ue(), 64), positive = bounded(ue(), 64);
      for (let j = 0; j < negative + positive; j++) { ue(); read(1); }
      counts.push(negative + positive);
    }
  }
  if (read(1)) { const count = bounded(ue(), 32); for (let i = 0; i < count; i++) { read(pocBits); read(1); } }
  read(1); read(1);
  const vuiPos = pos, present = read(1);
  if (!present) return {chroma, luma, chromaDepth, vuiPos, start: vuiPos, end: pos, present: false};
  if (read(1)) { const aspect = read(8); if (aspect === 255) read(32); }
  if (read(1)) read(1);
  const start = pos, video = read(1);
  let fullRange = false, primaries = null, transfer = null, matrix = null, format = 5;
  if (video) {
    format = read(3); fullRange = Boolean(read(1));
    if (read(1)) { primaries = read(8); transfer = read(8); matrix = read(8); }
  }
  return {chroma, luma, chromaDepth, vuiPos, start, end: pos, present: true, video: Boolean(video), format,
    fullRange, primaries, transfer, matrix};
}

export function readSpsInfo(nal) { return locateVui(spsBits(nal)); }

function retagSps(nal, {matrix, fullRange}) {
  const bits = spsBits(nal), info = locateVui(bits);
  if ((info.video && info.fullRange !== fullRange)
      || (info.matrix != null && info.matrix !== 2 && info.matrix !== matrix))
    throw Error(`8-bit linear thumbnail SPS disagrees with negotiated YUV: matrix=${info.matrix}, fullRange=${info.fullRange}; expected matrix=${matrix}, fullRange=${fullRange}`);
  if ((info.primaries != null && ![1, 2].includes(info.primaries))
      || (info.transfer != null && ![1, 2, 6, 13].includes(info.transfer)))
    throw Error('8-bit linear thumbnail encoder changed transport colour');
  const binary = (value, n) => Array.from({length: n}, (_, i) => value >> (n - 1 - i) & 1);
  const video = [1, ...binary(info.format ?? 5, 3), Number(fullRange), 1,
    ...binary(12, 8), ...binary(8, 8), ...binary(matrix, 8)];
  // Absent VUI: add a minimal VUI with all unrelated optional fields disabled.
  const replacement = info.present ? video : [1, 0, 0, ...video, ...Array(7).fill(0)];
  const stop = bits.lastIndexOf(1);
  if (stop < info.end) throw Error('Invalid HEVC SPS trailing bits');
  const changed = [...bits.slice(0, info.start), ...replacement, ...bits.slice(info.end, stop + 1)];
  while (changed.length % 8) changed.push(0);
  const rbsp = [];
  for (let i = 0; i < changed.length; i += 8) rbsp.push(changed.slice(i, i + 8).reduce((a, b) => a * 2 + b, 0));
  const escaped = [];
  let zeros = 0;
  for (const byte of rbsp) {
    if (zeros >= 2 && byte <= 3) { escaped.push(3); zeros = 0; }
    escaped.push(byte); zeros = byte === 0 ? zeros + 1 : 0;
  }
  const result = concat([nal.slice(0, 2), new Uint8Array(escaped)]), after = readSpsInfo(result);
  if (after.primaries !== 12 || after.transfer !== 8 || after.matrix !== matrix || after.fullRange !== fullRange)
    throw Error('Linear SPS colour validation failed');
  return result;
}

export function retagLinearHevc(record, payload, {matrix = 1, fullRange = false} = {}) {
  if (![1, 5, 6].includes(matrix) || typeof fullRange !== 'boolean')
    throw Error('Unsupported linear HEVC matrix/range');
  const color = {matrix, fullRange};
  if (record.length < 23 || record[0] !== 1) throw Error('Invalid HEVC configuration');
  const chunks = [record.slice(0, 23)]; let pos = 23, spsCount = 0;
  const u16 = () => { if (pos + 2 > record.length) throw Error('Truncated HEVC configuration'); const value = record[pos] * 256 + record[pos + 1]; pos += 2; return value; };
  for (let i = 0; i < record[22]; i++) {
    if (pos + 3 > record.length) throw Error('Truncated HEVC array');
    const type = record[pos++] & 63, count = u16(); chunks.push(new Uint8Array([record[pos - 3]]), be(count, 2));
    for (let j = 0; j < count; j++) {
      const size = u16(); if (pos + size > record.length) throw Error('Truncated HEVC NAL');
      const old = record.slice(pos, pos + size), nal = type === 33 ? retagSps(old, color) : old; pos += size;
      if (type === 33) spsCount++;
      chunks.push(be(nal.length, 2), nal);
    }
  }
  if (!spsCount || pos !== record.length) throw Error('Invalid HEVC SPS array');
  const lengthSize = (record[21] & 3) + 1, frames = [];
  for (pos = 0; pos < payload.length;) {
    if (pos + lengthSize > payload.length) throw Error('Truncated HEVC sample');
    let size = 0; for (let i = 0; i < lengthSize; i++) size = size * 256 + payload[pos++];
    if (size < 2 || pos + size > payload.length) throw Error('Invalid HEVC sample NAL');
    const old = payload.slice(pos, pos + size), nal = (old[0] >> 1 & 63) === 33 ? retagSps(old, color) : old; pos += size;
    frames.push(be(nal.length, lengthSize), nal);
  }
  return {record: concat(chunks), payload: concat(frames)};
}
