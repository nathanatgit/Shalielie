// Explicit RGB -> limited-range BT.709 YCbCr, avoiding implicit canvas VideoFrame conversion.
import { be, box, concat } from "./box.js";

export function rasterVideoColorSpace(canvasSpace = "srgb") {
  return { primaries: canvasSpace === "display-p3" ? "smpte432" : "bt709",
    transfer: "iec61966-2-1", matrix: "bt709", fullRange: false };
}

/** Resolve all encoder-reported fields together before converting real photo pixels. */
export function resolveEncodedColorSpace(actual, fallback = rasterVideoColorSpace()) {
  const resolved = Object.fromEntries(Object.keys(fallback)
    .map((key) => [key, actual?.[key] ?? fallback[key]]));
  if (resolved.primaries !== "bt709"
      || !["iec61966-2-1", "bt709", "smpte170m"].includes(resolved.transfer)
      || !["bt709", "smpte170m", "bt470bg"].includes(resolved.matrix)
      || typeof resolved.fullRange !== "boolean")
    throw new Error(`Unsupported HEVC output colour space: ${JSON.stringify(resolved)}`);
  return resolved;
}

export function rasterColr(colorSpace) {
  const primaries = colorSpace.primaries === "smpte432" ? 12 : 1;
  const transfer = { "iec61966-2-1": 13, bt709: 1, smpte170m: 6 }[colorSpace.transfer];
  const matrix = { bt709: 1, smpte170m: 6, bt470bg: 5 }[colorSpace.matrix];
  if (transfer === undefined || matrix === undefined) throw new Error("Unsupported HEIC colour description");
  return box("colr", concat([new TextEncoder().encode("nclx"),
    be(primaries, 2), be(transfer, 2), be(matrix, 2), new Uint8Array([colorSpace.fullRange ? 128 : 0])]));
}

const SRGB_TO_BT709 = Uint8Array.from({ length: 256 }, (_, value) => {
  const s = value / 255;
  const linear = s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  const video = linear < 0.018 ? 4.5 * linear : 1.099 * linear ** 0.45 - 0.099;
  return Math.round(video * 255);
});

/** Convert the transfer curve too: sRGB and BT.709 share primaries, but differ in gamma. */
export function srgbToBt709Rgba(rgba) {
  const out = new Uint8ClampedArray(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    out[i] = SRGB_TO_BT709[rgba[i]];
    out[i + 1] = SRGB_TO_BT709[rgba[i + 1]];
    out[i + 2] = SRGB_TO_BT709[rgba[i + 2]];
    out[i + 3] = rgba[i + 3];
  }
  return out;
}

/** I420 uses even dimensions; the input RGB samples must already use the signalled transfer. */
export function rgbaToI420(rgba, width, height, colorSpace = rasterVideoColorSpace()) {
  if (width % 2 || height % 2 || width < 2 || height < 2 || rgba.length !== width * height * 4)
    throw new Error("Invalid RGB dimensions for I420 encoding");
  const plane = width * height, chroma = plane / 4;
  const out = new Uint8Array(plane + 2 * chroma);
  const kr = colorSpace.matrix === "bt709" ? 0.2126 : 0.299;
  const kb = colorSpace.matrix === "bt709" ? 0.0722 : 0.114, kg = 1 - kr - kb;
  const yOffset = colorSpace.fullRange ? 0 : 16;
  const yScale = (colorSpace.fullRange ? 255 : 219) / 255;
  const cScale = (colorSpace.fullRange ? 255 : 224) / (255 * 4);
  const quantize = (v, min, max) => Math.max(min, Math.min(max, Math.round(v)));
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      let red = 0, green = 0, blue = 0;
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const i = (y + dy) * width + x + dx, p = i * 4;
        const r = rgba[p], g = rgba[p + 1], b = rgba[p + 2];
        out[i] = quantize(yOffset + yScale * (kr * r + kg * g + kb * b),
          yOffset, colorSpace.fullRange ? 255 : 235);
        red += r; green += g; blue += b;
      }
      const c = (y / 2) * (width / 2) + x / 2;
      const luma = kr * red + kg * green + kb * blue;
      out[plane + c] = quantize(128 + cScale * (blue - luma) / (2 * (1 - kb)),
        colorSpace.fullRange ? 0 : 16, colorSpace.fullRange ? 255 : 240);
      out[plane + chroma + c] = quantize(128 + cScale * (red - luma) / (2 * (1 - kr)),
        colorSpace.fullRange ? 0 : 16, colorSpace.fullRange ? 255 : 240);
    }
  }
  return out;
}

export function rasterFrame(ctx, width, height, timestamp, colorSpace = rasterVideoColorSpace()) {
  let pixels;
  // Ask Canvas to colour-manage P3 sources into sRGB before encoding BT.709 video.
  try { pixels = ctx.getImageData(0, 0, width, height, { colorSpace: "srgb" }); }
  catch { pixels = ctx.getImageData(0, 0, width, height); }
  if (pixels.colorSpace && pixels.colorSpace !== "srgb")
    throw new Error("Raster encoder requires colour-managed sRGB pixels");
  const rgba = colorSpace.transfer === "iec61966-2-1" ? pixels.data : srgbToBt709Rgba(pixels.data);
  const frame = new VideoFrame(rgbaToI420(rgba, width, height, colorSpace), {
    format: "I420", codedWidth: width, codedHeight: height,
    timestamp, duration: 1_000_000, colorSpace,
  });
  return { frame, colorSpace };
}

export function checkEncodedColorSpace(actual, expected) {
  if (!actual) return;
  for (const field of ["primaries", "transfer", "matrix", "fullRange"])
    if (actual[field] !== null && actual[field] !== undefined && actual[field] !== expected[field])
      throw new Error(`HEVC encoder changed ${field}: ${actual[field]} (expected ${expected[field]})`);
}
