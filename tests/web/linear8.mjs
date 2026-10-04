import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import {boxes, topBox, findChild, u} from '../../web/src/box.js';
import {encodeSelectedLinearThumbnail, p3ToLinearI420, validateMain8} from '../../web/src/linear-thumbnail.js';
import {retagLinearHevc, readSpsInfo} from '../../web/src/hevc-linear-tags.js';
import {loadProfile} from '../../web/src/zip.js';
import {buildRasterHeic} from '../../web/src/raster-import.js';
import {discoverHeic, propertyBoxBytes, extractItemData} from '../../web/src/heif.js';
import {diagnosePortError} from '../../web/src/errors.js';

const cache = path.resolve('tests/web/.cache/linear8'); fs.mkdirSync(cache, {recursive: true});
const ffmpeg = process.env.FFMPEG_EXECUTABLE || 'ffmpeg';
const run = args => execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', ...args], {stdio: ['ignore', 'pipe', 'pipe']});
const gray = value => Uint8Array.from({length: 16}, (_, i) => i % 4 === 3 ? 255 : value);
assert.deepEqual([...p3ToLinearI420(gray(0), 2, 2)], [16, 16, 16, 16, 128, 128]);
assert.deepEqual([...p3ToLinearI420(gray(255), 2, 2)], [235, 235, 235, 235, 128, 128]);
assert.equal(p3ToLinearI420(gray(128), 2, 2)[0], 63, 'midpoint is linearized before quantization');
const full601 = {matrix: 'smpte170m', fullRange: true};
assert.deepEqual([...p3ToLinearI420(gray(0), 2, 2, false, full601)], [0, 0, 0, 0, 128, 128]);
assert.deepEqual([...p3ToLinearI420(gray(255), 2, 2, false, full601)], [255, 255, 255, 255, 128, 128]);
assert.equal(p3ToLinearI420(gray(128), 2, 2, false, full601)[0], 55, 'full-range midpoint remains linear');
const red = Uint8Array.from({length: 16}, (_, i) => i % 4 === 0 || i % 4 === 3 ? 255 : 0);
assert.deepEqual([...p3ToLinearI420(red, 2, 2, false, full601)], [76, 76, 76, 76, 85, 255], 'BT.601 full-range coefficients and clipping');
assert.deepEqual([...p3ToLinearI420(red, 2, 2)], [63, 63, 63, 63, 102, 240], 'BT.709 limited-range coefficients');
const pixels = Uint8Array.from({length: 32 * 32 * 4}, (_, i) => i % 4 === 3 ? 255 : (i * 17) % 256);
const input = path.join(cache, 'input.yuv'); fs.writeFileSync(input, p3ToLinearI420(pixels, 32, 32));
const mp4 = path.join(cache, 'encoded.mp4');
run(['-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-s:v', '32x32', '-r', '1', '-i', input,
  '-frames:v', '1', '-c:v', 'libx265', '-preset', 'ultrafast', '-profile:v', 'main',
  '-x265-params', 'lossless=1:pools=none:frame-threads=1:wpp=0:colorprim=1:transfer=1:colormatrix=1:range=limited:log-level=error',
  '-tag:v', 'hvc1', '-y', mp4]);
function readEncodedMp4(data) {
const children = (box, skip = 0) => [...boxes(data, box.off + box.hdr + skip, box.off + box.size)];
let parent = topBox(data, 'moov'); for (const name of ['trak', 'mdia', 'minf', 'stbl']) parent = findChild(children(parent), name);
const table = children(parent), stsd = findChild(table, 'stsd'), entry = children(stsd, 8)[0];
const hvcc = findChild(children(entry, 78), 'hvcC'), record = data.slice(hvcc.off + hvcc.hdr, hvcc.off + hvcc.size);
const stsz = findChild(table, 'stsz'), sp = stsz.off + stsz.hdr;
const size = u(data, sp + 4, 4) || u(data, sp + 12, 4), stco = findChild(table, 'stco'), offset = u(data, stco.off + stco.hdr + 8, 4);
const payload = data.slice(offset, offset + size);
return {record, payload};
}
const {record, payload} = readEncodedMp4(new Uint8Array(fs.readFileSync(mp4)));
validateMain8(record);
const tagged = retagLinearHevc(record, payload);
validateMain8(tagged.record);
function nalArrays(r) {
  const arrays = []; let pos = 23;
  for (let i = 0; i < r[22]; i++) { const type = r[pos++] & 63, count = r[pos++] * 256 + r[pos++];
    for (let j = 0; j < count; j++) { const n = r[pos++] * 256 + r[pos++]; arrays.push({type, nal: r.slice(pos, pos + n)}); pos += n; }
  } return arrays;
}
const info = readSpsInfo(nalArrays(tagged.record).find(n => n.type === 33).nal);
assert.equal(info.primaries, 12); assert.equal(info.transfer, 8); assert.equal(info.matrix, 1); assert.equal(info.fullRange, false);
const originals = nalArrays(record), changed = nalArrays(tagged.record);
// Browsers may omit either the video-signal section or the complete VUI.
const originalSps = originals.find(n => n.type === 33).nal, originalInfo = readSpsInfo(originalSps);
function rbspBits(nal) {
  const bytes = []; for (let i = 2; i < nal.length; i++) {if (i >= 4 && nal[i] === 3 && nal[i - 1] === 0 && nal[i - 2] === 0) continue; bytes.push(nal[i]);}
  return bytes.flatMap(b => Array.from({length: 8}, (_, i) => b >> (7 - i) & 1));
}
function spsFromBits(bits) {
  while (bits.length % 8) bits.push(0); const bytes = [originalSps[0], originalSps[1]]; let zeros = 0;
  for (let i = 0; i < bits.length; i += 8) {const b = bits.slice(i, i + 8).reduce((a, c) => a * 2 + c, 0); if (zeros >= 2 && b <= 3) {bytes.push(3); zeros = 0;} bytes.push(b); zeros = b === 0 ? zeros + 1 : 0;}
  return new Uint8Array(bytes);
}
const spsSource = rbspBits(originalSps), stop = spsSource.lastIndexOf(1);
const noVideo = spsFromBits([...spsSource.slice(0, originalInfo.start), 0, ...spsSource.slice(originalInfo.end, stop + 1)]);
const noVui = spsFromBits([...spsSource.slice(0, originalInfo.vuiPos), 0, 0, 1]);
for (const variant of [noVideo, noVui]) {
  const header = record.slice(0, 23); header[22] = originals.length;
  const array = originals.map(n => {const bytes = n.type === 33 ? variant : n.nal; return Buffer.concat([Buffer.from([128 | n.type, 0, 1, bytes.length >> 8, bytes.length & 255]), Buffer.from(bytes)]);});
  const variantRecord = new Uint8Array(Buffer.concat([Buffer.from(header), ...array]));
  const fixed = retagLinearHevc(variantRecord, payload), result = readSpsInfo(nalArrays(fixed.record).find(n => n.type === 33).nal);
  assert.equal(result.transfer, 8); assert.equal(result.primaries, 12);
  const file = path.join(cache, `variant-${readSpsInfo(variant).present}.265`);
  // Include one in-band SPS as well as the hvcC SPS and prove that both are updated.
  const inband = new Uint8Array(Buffer.concat([Buffer.from([0, 0, originalSps.length >> 8, originalSps.length & 255]), Buffer.from(originalSps), Buffer.from(payload)]));
  const inline = retagLinearHevc(variantRecord, inband), inlineSize = u(inline.payload, 0, 4);
  assert.equal(readSpsInfo(inline.payload.slice(4, 4 + inlineSize)).transfer, 8);
  assert.deepEqual(inline.payload.slice(4 + inlineSize), payload);
  const stream = nalArrays(fixed.record).map(n => Buffer.concat([Buffer.from([0, 0, 0, 1]), Buffer.from(n.nal)]));
  for (let pos = 0; pos < payload.length;) {const size = u(payload, pos, 4); pos += 4; stream.push(Buffer.concat([Buffer.from([0, 0, 0, 1]), Buffer.from(payload.slice(pos, pos + size))])); pos += size;}
  fs.writeFileSync(file, Buffer.concat(stream));
  const decoded = file + '.yuv'; run(['-f', 'hevc', '-i', file, '-frames:v', '1', '-pix_fmt', 'yuv420p', '-f', 'rawvideo', '-y', decoded]);
  assert.deepEqual(fs.readFileSync(decoded), fs.readFileSync(input), 'absent VUI fields are added without changing decoded samples');
}
for (let i = 0; i < originals.length; i++) if (originals[i].type !== 33) assert.deepEqual(changed[i], originals[i]);
assert.deepEqual(tagged.payload, payload, 'picture sample with out-of-band SPS remains exact');
const raw = path.join(cache, 'tagged.265');
const chunks = changed.map(n => Buffer.concat([Buffer.from([0, 0, 0, 1]), Buffer.from(n.nal)]));
let pos = 0, lengthSize = (record[21] & 3) + 1;
while (pos < payload.length) { let n = 0; for (let i = 0; i < lengthSize; i++) n = n * 256 + tagged.payload[pos++]; chunks.push(Buffer.concat([Buffer.from([0, 0, 0, 1]), Buffer.from(tagged.payload.slice(pos, pos + n))])); pos += n; }
fs.writeFileSync(raw, Buffer.concat(chunks));
const decoded = path.join(cache, 'decoded.yuv');
run(['-f', 'hevc', '-i', raw, '-frames:v', '1', '-pix_fmt', 'yuv420p', '-f', 'rawvideo', '-y', decoded]);
assert.deepEqual(fs.readFileSync(decoded), fs.readFileSync(input), 'retagged actual HEVC decodes to the exact linear samples');
const trace = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'info', '-f', 'hevc', '-i', raw,
  '-map', '0:v:0', '-c:v', 'copy', '-bsf:v', 'trace_headers', '-f', 'null', '-'], {encoding: 'utf8'});
assert.equal(trace.status, 0, trace.stderr);
for (const [name, value] of [['colour_primaries', 12], ['transfer_characteristics', 8], ['matrix_coefficients', 1], ['video_full_range_flag', 0]])
  assert.match(trace.stderr, new RegExp(name + '\\s+[01]+\\s+= ' + value + '(?:\\r?\\n|$)'));

let captured, supported = true, metadataOnce = false, realColor = null, realRecord = null, outputRecord = record, outputPayload = payload, outputColor = {matrix: 'bt709', fullRange: false};
globalThis.VideoFrame = class {constructor(bytes, init) {captured = {bytes, init};} close() {}};
globalThis.VideoEncoder = class {
  static async isConfigSupported(config) {assert.match(config.codec, /\.1\.6\./); return {supported, config};}
  constructor(callbacks) {this.callbacks = callbacks; this.count = 0;} configure() {} close() {} async flush() {}
  encode() {
    this.count++;
    const metadata = metadataOnce && this.count > 1 ? undefined
      : {decoderConfig: {description: this.count > 1 && realRecord ? realRecord : outputRecord,
        colorSpace: this.count > 1 && realColor ? realColor : outputColor}};
    this.callbacks.output({byteLength: outputPayload.length, copyTo(b) {b.set(outputPayload);}}, metadata);
  }
};
globalThis.document = {createElement() {return {getContext() {return {
  getContextAttributes() {return {colorSpace: 'display-p3'};}, save() {}, restore() {}, translate() {}, scale() {}, rotate() {}, drawImage() {},
  getImageData() {return {data: pixels, colorSpace: 'display-p3'};},
};}};}};
globalThis.Worker = class {constructor() {throw Error('Default 8-bit must not start a WASM worker');}};
const encoded = await encodeSelectedLinearThumbnail({width: 32, height: 32});
assert.equal(encoded.bitDepth, 8); assert.equal(encoded.mode, 'webcodecs-main8-p3-linear');
assert.equal(captured.init.format, 'I420'); assert.deepEqual(captured.bytes, new Uint8Array(fs.readFileSync(input)));
assert.deepEqual([...encoded.pixi.slice(-3)], [8, 8, 8]);
supported = false; await assert.rejects(encodeSelectedLinearThumbnail({width: 32, height: 32}), /encoder unavailable/); supported = true;
outputColor = {matrix: 'smpte170m', fullRange: true};
const reportedMismatch = await encodeSelectedLinearThumbnail({width: 32, height: 32});
assert.equal(reportedMismatch.transportColor.matrix, 'bt709'); assert.equal(reportedMismatch.transportColor.fullRange, false);
assert.deepEqual(captured.bytes, new Uint8Array(fs.readFileSync(input)), 'actual SPS takes precedence over conflicting browser metadata');
// Reproduce the actual Safari report and SPS, using real linear samples in a
// stream initially tagged as sRGB. The transport is negotiated, not rejected.
const srgbMp4 = path.join(cache, 'srgb-transport.mp4');
run(['-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-s:v', '32x32', '-r', '1', '-i', input,
  '-frames:v', '1', '-c:v', 'libx265', '-preset', 'ultrafast', '-profile:v', 'main',
  '-x265-params', 'lossless=1:pools=none:frame-threads=1:wpp=0:colorprim=1:transfer=13:colormatrix=1:range=limited:log-level=error',
  '-tag:v', 'hvc1', '-y', srgbMp4]);
const srgbStream = readEncodedMp4(new Uint8Array(fs.readFileSync(srgbMp4)));
outputRecord = srgbStream.record; outputPayload = srgbStream.payload;
outputColor = {primaries: 'bt709', matrix: 'bt709', fullRange: false, transfer: 'iec61966-2-1'};
const safari = await encodeSelectedLinearThumbnail({width: 32, height: 32});
assert.equal(safari.transportColor.transfer, 'iec61966-2-1');
assert.equal(captured.init.colorSpace.transfer, 'iec61966-2-1');
assert.deepEqual(captured.bytes, new Uint8Array(fs.readFileSync(input)), 'transport negotiation never gamma-encodes the linear pixels');
const safariRecord = safari.hvcc.slice(8);
assert.equal(readSpsInfo(nalArrays(safariRecord).find(n => n.type === 33).nal).transfer, 8);
const srgbRaw = path.join(cache, 'srgb-retagged.265'), srgbChunks = nalArrays(safariRecord).map(n => Buffer.concat([Buffer.from([0, 0, 0, 1]), Buffer.from(n.nal)]));
for (let pos = 0; pos < safari.payload.length;) {const size = u(safari.payload, pos, 4); pos += 4; srgbChunks.push(Buffer.concat([Buffer.from([0, 0, 0, 1]), Buffer.from(safari.payload.slice(pos, pos + size))])); pos += size;}
fs.writeFileSync(srgbRaw, Buffer.concat(srgbChunks));
const srgbDecoded = srgbRaw + '.yuv'; run(['-f', 'hevc', '-i', srgbRaw, '-frames:v', '1', '-pix_fmt', 'yuv420p', '-f', 'rawvideo', '-y', srgbDecoded]);
assert.deepEqual(fs.readFileSync(srgbDecoded), fs.readFileSync(input), 'actual sRGB-transport HEVC still decodes to exact linear samples after retagging');
metadataOnce = true;
const initialMetadataOnly = await encodeSelectedLinearThumbnail({width: 32, height: 32});
assert.deepEqual(initialMetadataOnly.payload, safari.payload, 'initial decoder configuration is retained when the real frame omits metadata');
assert.equal(initialMetadataOnly.transportColor.transfer, 'iec61966-2-1');
metadataOnce = false;
realColor = {...outputColor, transfer: 'bt709'};
assert.equal((await encodeSelectedLinearThumbnail({width: 32, height: 32})).transportColor.transfer, 'iec61966-2-1', 'unchanged SPS takes precedence over stale transfer metadata');
realRecord = record;
await assert.rejects(encodeSelectedLinearThumbnail({width: 32, height: 32}), /changed transfer: bt709/);
realColor = null; realRecord = null;
// All common browser matrix/range reports must encode the corresponding linear
// samples and retain those values in both SPS and HEIC nclx, without loading WASM.
for (const [matrix, code] of [['bt709', 1], ['smpte170m', 6], ['bt470bg', 5]]) for (const fullRange of [false, true]) {
  const color = {primaries: 'bt709', transfer: 'iec61966-2-1', matrix, fullRange};
  const samples = p3ToLinearI420(pixels, 32, 32, false, color);
  const label = `${matrix}-${fullRange ? 'full' : 'limited'}`, rawInput = path.join(cache, label + '.yuv');
  const file = path.join(cache, label + '.mp4'); fs.writeFileSync(rawInput, samples);
  run(['-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-s:v', '32x32', '-r', '1', '-i', rawInput,
    '-frames:v', '1', '-c:v', 'libx265', '-preset', 'ultrafast', '-profile:v', 'main',
    '-x265-params', `lossless=1:pools=none:frame-threads=1:wpp=0:colorprim=1:transfer=13:colormatrix=${code}:range=${fullRange ? 'full' : 'limited'}:log-level=error`,
    '-tag:v', 'hvc1', '-y', file]);
  const source = readEncodedMp4(new Uint8Array(fs.readFileSync(file)));
  outputRecord = source.record; outputPayload = source.payload; outputColor = color;
  const result = await encodeSelectedLinearThumbnail({width: 32, height: 32});
  assert.deepEqual(captured.init.colorSpace, color, label);
  assert.deepEqual(captured.bytes, samples, label + ': pixels use the negotiated matrix/range');
  assert.deepEqual(result.transportColor, color);
  assert.equal(u(result.colr, 16, 2), code); assert.equal(result.colr[18], fullRange ? 128 : 0);
  const sps = readSpsInfo(nalArrays(result.hvcc.slice(8)).find(n => n.type === 33).nal);
  assert.equal(sps.primaries, 12); assert.equal(sps.transfer, 8);
  assert.equal(sps.matrix, code); assert.equal(sps.fullRange, fullRange);
  assert.deepEqual(result.payload, source.payload, label + ': picture NALs are retained');
  // Missing video-signal fields must also accept the negotiated metadata,
  // including full range, when constructing the previously absent VUI section.
  const sourceArrays = nalArrays(source.record), sourceSps = sourceArrays.find(n => n.type === 33).nal;
  const sourceInfo = readSpsInfo(sourceSps), sourceBits = rbspBits(sourceSps);
  const missingVideo = spsFromBits([...sourceBits.slice(0, sourceInfo.start), 0, ...sourceBits.slice(sourceInfo.end, sourceBits.lastIndexOf(1) + 1)]);
  const arrays = sourceArrays.map(n => {const bytes = n.type === 33 ? missingVideo : n.nal; return Buffer.concat([Buffer.from([128 | n.type, 0, 1, bytes.length >> 8, bytes.length & 255]), Buffer.from(bytes)]);});
  const header = source.record.slice(0, 23); header[22] = sourceArrays.length;
  outputRecord = new Uint8Array(Buffer.concat([Buffer.from(header), ...arrays]));
  const missing = await encodeSelectedLinearThumbnail({width: 32, height: 32});
  assert.deepEqual(missing.transportColor, color, label + ': metadata fills absent SPS colour fields');
  const restored = readSpsInfo(nalArrays(missing.hvcc.slice(8)).find(n => n.type === 33).nal);
  assert.equal(restored.matrix, code); assert.equal(restored.fullRange, fullRange);
  const stream = nalArrays(result.hvcc.slice(8)).map(n => Buffer.concat([Buffer.from([0, 0, 0, 1]), Buffer.from(n.nal)]));
  for (let pos = 0; pos < result.payload.length;) {const size = u(result.payload, pos, 4); pos += 4; stream.push(Buffer.concat([Buffer.from([0, 0, 0, 1]), Buffer.from(result.payload.slice(pos, pos + size))])); pos += size;}
  const hevc = path.join(cache, label + '.265'), rawOutput = hevc + '.yuv'; fs.writeFileSync(hevc, Buffer.concat(stream));
  // yuv420p requests limited-range normalization from FFmpeg; yuvj420p retains
  // a full-range decoder's raw sample values for this exact-byte comparison.
  run(['-f', 'hevc', '-i', hevc, '-frames:v', '1', '-pix_fmt', fullRange ? 'yuvj420p' : 'yuv420p', '-f', 'rawvideo', '-y', rawOutput]);
  assert.deepEqual(fs.readFileSync(rawOutput), Buffer.from(samples), label + ': decoded linear samples survive retagging exactly');
}
for (const bitDepth of [9, 10]) await assert.rejects(encodeSelectedLinearThumbnail({width: 32, height: 32}, {bitDepth}), /Only 8-bit/);
assert.equal(diagnosePortError(Error('8-bit linear thumbnail encode failed')).code, 'linear8');
const profile = await loadProfile(new Uint8Array(fs.readFileSync('web/profiles/48-12.zip'))), donor = discoverHeic(profile.meta);
const output = buildRasterHeic(profile, {main: Array.from({length: 48}, () => new Uint8Array([1])),
  mainHvcc: propertyBoxBytes(profile.meta, donor.props, donor.primaryTiles[0], 'hvcC'),
  thumb: new Uint8Array([2]), thumbHvcc: propertyBoxBytes(profile.meta, donor.props, donor.thumbnail, 'hvcC'),
  hdr: new Uint8Array([3]), hdrHvcc: propertyBoxBytes(profile.meta, donor.props, donor.hdrTiles[0], 'hvcC'), linearThumbnail: encoded});
const out = discoverHeic(output);
assert.deepEqual(propertyBoxBytes(output, out.props, out.linearThumb, 'pixi'), encoded.pixi);
assert.deepEqual(propertyBoxBytes(output, out.props, out.linearThumb, 'colr'), encoded.colr);
assert.deepEqual(extractItemData(output, out, out.linearThumb), encoded.payload);
console.log('8-bit default: linear BT.709/BT.601 in full/limited range, actual HEVC lossless roundtrips, SPS/pixi/colr agreement, no WASM worker, errors and independent auxiliary passed');
