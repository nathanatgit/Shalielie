import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rgbaToI420, rasterVideoColorSpace, rasterColr, rasterFrame, checkEncodedColorSpace, srgbToBt709Rgba, resolveEncodedColorSpace }
  from "../../web/src/raster-color.js";

const solid = (rgb) => new Uint8ClampedArray(Array.from({ length: 4 }, () => [...rgb, 255]).flat());
for (const [rgb, expected] of [
  [[0, 0, 0], [16, 128, 128]], [[255, 255, 255], [235, 128, 128]],
  [[255, 0, 0], [63, 102, 240]], [[0, 255, 0], [173, 42, 26]],
  [[0, 0, 255], [32, 240, 118]],
]) {
  const yuv = rgbaToI420(solid(rgb), 2, 2);
  assert.deepEqual([...yuv], [expected[0], expected[0], expected[0], expected[0], expected[1], expected[2]]);
}
assert.throws(() => rgbaToI420(solid([0, 0, 0]), 3, 2));
const srgb = rasterVideoColorSpace(), p3 = rasterVideoColorSpace("display-p3");
assert.deepEqual([...rasterColr(srgb).slice(8)], [110, 99, 108, 120, 0, 1, 0, 13, 0, 1, 0]);
assert.deepEqual([...rasterColr(p3).slice(12, 14)], [0, 12]);
checkEncodedColorSpace(null, p3);
checkEncodedColorSpace({ ...p3, matrix: null }, p3);
assert.throws(() => checkEncodedColorSpace({ ...p3, fullRange: true }, p3));
globalThis.VideoFrame = class {
  constructor(data, init) { this.data = data; this.init = init; }
};
for (const returnedSpace of ["srgb", undefined]) {
  const ctx = { getContextAttributes: () => ({ colorSpace: "display-p3" }),
    getImageData(x, y, w, h, settings) {
      assert.equal(settings.colorSpace, "srgb");
      return { data: solid([255, 0, 0]), colorSpace: returnedSpace };
    } };
  const { frame, colorSpace } = rasterFrame(ctx, 2, 2, 100);
  assert.equal(frame.init.format, "I420");
  assert.equal(frame.init.timestamp, 100);
  assert.deepEqual(colorSpace, srgb);
  assert.deepEqual(frame.init.colorSpace, colorSpace);
  assert.deepEqual([...frame.data], [63, 63, 63, 63, 102, 240]);
}
assert.throws(() => rasterFrame({ getImageData: () => ({ data: solid([255, 0, 0]),
  colorSpace: "display-p3" }) }, 2, 2, 100), /sRGB/);
// Reproduce the user's encoder metadata: it now agrees with the actual input pixels.
const userOutput = { primaries: "bt709", transfer: "iec61966-2-1", matrix: "bt709", fullRange: false };
checkEncodedColorSpace(userOutput, resolveEncodedColorSpace(userOutput));
assert.deepEqual(resolveEncodedColorSpace({ transfer: null }), srgb);
const middle = srgbToBt709Rgba(solid([128, 128, 128]));
assert.ok(middle[0] >= 114 && middle[0] <= 116, "sRGB midtones need a real BT.709 transfer conversion");
for (let value = 0; value < 256; value++) {
  const encoded = srgbToBt709Rgba(solid([value, value, value]))[0] / 255;
  const linear = encoded < 0.081 ? encoded / 4.5 : ((encoded + 0.099) / 1.099) ** (1 / 0.45);
  const restored = linear <= 0.0031308 ? linear * 12.92 : 1.055 * linear ** (1 / 2.4) - 0.055;
  assert.ok(Math.abs(restored * 255 - value) <= 2, "transfer roundtrip changed brightness");
}
delete globalThis.VideoFrame;

// Exercise the actual encoding orchestration, including probe disposal and encoder variants.
const { encodeCanvases } = await import("../../web/src/raster-import.js");
for (const outputSpace of [userOutput, { ...userOutput, transfer: "bt709" },
  { ...userOutput, matrix: "smpte170m", fullRange: true }]) {
  const frames = [];
  const context = { value: 0, fillRect() { this.value = 0; },
    getImageData() { return { data: solid([this.value, this.value, this.value]), colorSpace: "srgb" }; } };
  globalThis.document = { createElement: () => ({ getContext: () => context }) };
  globalThis.VideoFrame = class {
    constructor(data, init) { this.data = data; this.init = init; frames.push(this); }
    close() { this.closed = true; }
  };
  globalThis.VideoEncoder = class {
    static async isConfigSupported(config) { return { supported: true, config }; }
    constructor({ output }) { this.output = output; this.encodeQueueSize = 0; }
    configure() {}
    encode() { this.output({ byteLength: 4, copyTo(out) { out.set([0, 0, 0, 7]); } },
      { decoderConfig: { description: new Uint8Array([1]), colorSpace: outputSpace } }); }
    async flush() {}
    close() {}
  };
  const progress = [];
  const encoded = await encodeCanvases(2, 2, 2, (ctx) => { ctx.value = 128; }, 1000,
    (done, total) => progress.push([done, total]));
  assert.equal(frames.length, 3, "one probe plus two real frames");
  assert.equal(encoded.chunks.length, 2, "probe payload must not enter the photo");
  assert.deepEqual(progress, [[1, 2], [2, 2]]);
  assert.deepEqual(encoded.colr, rasterColr(outputSpace));
  for (const frame of frames.slice(1)) {
    assert.deepEqual(frame.init.colorSpace, outputSpace);
    const expectedY = outputSpace.transfer === "bt709" ? 115 : outputSpace.fullRange ? 128 : 126;
    assert.equal(frame.data[0], expectedY, "pixel brightness must match negotiated transfer/range");
    assert.ok(frame.closed);
  }
}
delete globalThis.document; delete globalThis.VideoEncoder; delete globalThis.VideoFrame;
console.log("Encoding probe handles the user's sRGB transfer, BT.709 transfer and full-range BT.601 output");

// Independent matrix/range check through FFmpeg's YUV decoder, when installed.
const width = 32, height = 32;
const rgb = new Uint8ClampedArray(width * height * 4);
const colors = [[210, 120, 80], [70, 160, 110], [60, 100, 210], [200, 200, 200]];
for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
  const c = colors[(y >= 16 ? 2 : 0) + (x >= 16 ? 1 : 0)];
  rgb.set([...c, 255], (y * width + x) * 4);
}
const result = spawnSync("ffmpeg", ["-v", "error", "-f", "rawvideo", "-pixel_format", "yuv420p",
  "-video_size", "32x32", "-i", "pipe:0", "-vf", "scale=in_color_matrix=bt709:in_range=limited:out_range=full",
  "-frames:v", "1", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"],
{ input: rgbaToI420(rgb, width, height) });
if (result.error?.code === "ENOENT") console.log("FFmpeg unavailable; independent matrix check skipped");
else {
  assert.equal(result.status, 0, result.stderr.toString());
  let maxError = 0;
  for (let i = 0; i < width * height; i++) for (let c = 0; c < 3; c++)
    maxError = Math.max(maxError, Math.abs(rgb[i * 4 + c] - result.stdout[i * 3 + c]));
  assert.ok(maxError <= 3, `BT.709 color roundtrip error ${maxError}`);
  console.log(`Independent BT.709 decode: maximum RGB error ${maxError}/255`);
}
console.log("RGB/YUV matrix, range, P3-to-sRGB readback, transfer conversion and encoder metadata checks passed");
