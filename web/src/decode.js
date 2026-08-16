// Optional HEIC decoding via libheif compiled to WebAssembly.
//
// Decoding is only needed for the target-derived scene statistics and c/d light
// maps. If libheif cannot be loaded the app still works: it falls back to the
// donor statistics and flat maps, which is the configuration that reproduces the
// Python reference byte for byte.

const LIBHEIF_URL = "https://cdn.jsdelivr.net/npm/libheif-js@1.18.2/libheif/libheif.js";

let libheifPromise = null;

export function loadLibheif() {
  if (libheifPromise) return libheifPromise;
  libheifPromise = new Promise((resolve, reject) => {
    if (globalThis.libheif) return resolve(globalThis.libheif);
    const s = document.createElement("script");
    s.src = LIBHEIF_URL;
    s.onload = () => (globalThis.libheif ? resolve(globalThis.libheif)
      : reject(new Error("libheif loaded but did not register")));
    s.onerror = () => reject(new Error("could not load libheif"));
    document.head.appendChild(s);
  });
  return libheifPromise;
}

/** ffmpeg's transpose semantics, expressed as a canvas transform. */
function orientationTransform(ctx, w, h, angle, mirror) {
  // Undo the display rotation to recover the stored orientation, matching
  // raw_orientation_filters() in the Python implementation.
  const swap = angle === 90 || angle === 270;
  const outW = swap ? h : w;
  const outH = swap ? w : h;
  ctx.translate(outW / 2, outH / 2);
  if (angle === 90) ctx.rotate(-Math.PI / 2);
  else if (angle === 180) ctx.rotate(Math.PI);
  else if (angle === 270) ctx.rotate(Math.PI / 2);
  if (mirror === 0) ctx.scale(-1, 1);
  else if (mirror === 1) ctx.scale(1, -1);
  ctx.translate(-w / 2, -h / 2);
  return [outW, outH];
}

let cache = new WeakMap();

async function decodeFull(bytes) {
  if (cache.has(bytes)) return cache.get(bytes);
  const libheif = await loadLibheif();
  const decoder = new libheif.HeifDecoder();
  const images = decoder.decode(bytes);
  if (!images || !images.length) throw new Error("libheif decoded no image");
  const image = images[0];
  const w = image.get_width(), h = image.get_height();
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const imageData = ctx.createImageData(w, h);
  await new Promise((res, rej) => {
    image.display(imageData, (out) => (out ? res(out) : rej(new Error("libheif display failed"))));
  });
  ctx.putImageData(imageData, 0, 0);
  const result = { canvas, w, h };
  cache.set(bytes, result);
  return result;
}

/**
 * Decode and resample to width x height, optionally undoing the display rotation.
 * Returns packed RGB bytes.
 */
export async function decodeToRgb(bytes, { width, height, angle = 0, mirror = null }) {
  const { canvas, w, h } = await decodeFull(bytes);
  const rotated = document.createElement("canvas");
  const swap = angle === 90 || angle === 270;
  rotated.width = swap ? h : w;
  rotated.height = swap ? w : h;
  const rctx = rotated.getContext("2d", { willReadFrequently: true });
  rctx.save();
  orientationTransform(rctx, w, h, angle, mirror);
  rctx.drawImage(canvas, 0, 0);
  rctx.restore();

  const small = document.createElement("canvas");
  small.width = width; small.height = height;
  const sctx = small.getContext("2d", { willReadFrequently: true });
  sctx.imageSmoothingEnabled = true;
  sctx.imageSmoothingQuality = "high";
  sctx.drawImage(rotated, 0, 0, width, height);
  const { data } = sctx.getImageData(0, 0, width, height);
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0, p = 0; p < data.length; i += 3, p += 4) {
    rgb[i] = data[p]; rgb[i + 1] = data[p + 1]; rgb[i + 2] = data[p + 2];
  }
  return rgb;
}
