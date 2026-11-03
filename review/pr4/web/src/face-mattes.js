// Experimental browser-only face matte generation.
//
// MediaPipe finds faces/landmarks and performs six-class selfie segmentation without
// uploading the photo. The confidence maps are converted into separate face-skin, all-skin,
// person, and per-person mattes, rotated back to the HEIC's stored orientation, then encoded
// as HEVC stills with WebCodecs.

import { concat } from "./box.js?v=0.6.0-web";
import { decodeToDisplayCanvas } from "./decode.js?v=0.6.0-web";
import { displayPointToStored, irotAngleForItem, imirAxisForItem,
  transformNormalizedRect, MATTE_URIS } from "./heif.js?v=0.6.0-web";
import { MATTE_2026_URIS, URI_PERSON_INSTANCES } from "./texture.js?v=0.6.0-web";
import { srgbToLinear, statsBlock } from "./styles.js?v=0.6.0-web";

const TASKS_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22-rc.20250304/+esm";
const WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22-rc.20250304/wasm";
const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const SEGMENTER_MODEL_URL = "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite";

// A promise alone does not let the browser render between synchronous WASM calls.
const yieldToBrowser = () => new Promise(resolve => setTimeout(resolve, 0));
async function reportProgress(options, stage, detail = {}) {
  await options.onProgress?.({stage, ...detail});
  await yieldToBrowser();
}

// Apple declares every native semantic matte as one 8-bit component. WebCodecs may
// internally carry neutral chroma planes, but the auxiliary image is semantically luma-only.
export const FACE_MATTE_PIXI = new Uint8Array([
  0, 0, 0, 14, 0x70, 0x69, 0x78, 0x69, 0, 0, 0, 0, 1, 8,
]);

// MediaPipe Face Mesh contours.  Skin is the face oval with obvious non-skin facial features
// cut out.  This is deliberately conservative: the first goal is to test whether a genuine
// face-skin matte activates Soft Skin, not to claim parity with Apple's segmentation model.
export const FACE_OVAL = [
  10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379,
  378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127,
  162, 21, 54, 103, 67, 109,
];
export const FACE_HOLES = [
  [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246],
  [362, 382, 381, 380, 374, 373, 390, 249, 263, 466, 388, 387, 386, 385, 384, 398],
  [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0,
    37, 39, 40, 185],
  [70, 63, 105, 66, 107, 55, 65, 52, 53, 46],
  [336, 296, 334, 293, 300, 285, 295, 282, 283, 276],
];

// Face Mesh contours used to populate the remaining iOS 27 semantic mattes. Apple uses a
// private segmentation network, so these are deliberately soft, conservative approximations.
export const LIPS_OUTER = FACE_HOLES[2];
export const LIPS_INNER = [13, 312, 311, 310, 415, 308, 324, 318, 402, 317, 14,
  87, 178, 88, 95, 78, 191, 80, 81, 82];
export const LEFT_EYEBROW = FACE_HOLES[3];
export const RIGHT_EYEBROW = FACE_HOLES[4];
export const NOSE_REGION = [168, 193, 122, 196, 3, 51, 45, 4, 275, 281, 248, 419, 351, 417];
const LEFT_EYE_REGION = [33, 246, 161, 160, 159, 158, 157, 173, 133, 155, 154, 153, 145, 144, 163, 7];
const RIGHT_EYE_REGION = [263, 466, 388, 387, 386, 385, 384, 398, 362, 382, 381, 380, 374, 373, 390, 249];
// Apple does not store MediaPipe's mesh order.  This table maps Apple's native 0–75
// ordering, inferred from native reference samples, onto the closest MediaPipe Face Landmarker
// points.  Keeping this order is important: downstream consumers attach semantics to
// the position in the array, rather than treating it as an unordered point cloud.
export const APPLE_LANDMARK_INDICES = [
  // 0–6: image-left eye (outer, inner, lower pair, upper pair, centre).
  33, 133, 144, 153, 160, 158, 468,
  // 7–13: image-right eye, mirrored.
  263, 362, 373, 380, 387, 385, 473,
  // 14–19: image-left eyebrow, lower outer→inner then upper inner→outer.
  46, 52, 55, 107, 105, 70,
  // 20–25: image-right eyebrow, mirrored.
  276, 282, 285, 336, 334, 300,
  // 26–39: outer lips, left corner across the upper lip and back along the lower lip.
  61, 185, 40, 39, 0, 269, 270, 409, 291, 375, 405, 17, 181, 146,
  // 40–45: inner lips (centres, upper pair, lower pair).
  13, 14, 82, 312, 87, 317,
  // 46–49: nose crest, top→tip.
  168, 6, 197, 1,
  // 50–58: nose base image-right→image-left, then alar/nostril support points.
  327, 326, 2, 97, 98, 279, 49, 294, 64,
  // 59–75: image-right temple down to chin, then up to image-left temple.
  454, 323, 361, 288, 397, 365, 379, 400, 152,
  176, 150, 136, 172, 58, 132, 93, 234,
];

export const APPLE_LANDMARK_GROUPS = Object.freeze([
  { name: "imageLeftEye", start: 0, end: 6 },
  { name: "imageRightEye", start: 7, end: 13 },
  { name: "imageLeftEyebrow", start: 14, end: 19 },
  { name: "imageRightEyebrow", start: 20, end: 25 },
  { name: "outerLips", start: 26, end: 39 },
  { name: "innerLips", start: 40, end: 45 },
  { name: "noseCrest", start: 46, end: 49 },
  { name: "noseBase", start: 50, end: 58 },
  { name: "faceContour", start: 59, end: 75 },
]);

function averageLandmarks(landmarks, indices) {
  const points = indices.map((index) => landmarks[index]).filter(Boolean);
  if (!points.length) return null;
  return {
    x: points.reduce((sum, p) => sum + p.x, 0) / points.length,
    y: points.reduce((sum, p) => sum + p.y, 0) / points.length,
    z: points.reduce((sum, p) => sum + (p.z || 0), 0) / points.length,
  };
}

/** Return one point in Apple order, including an iris-centre fallback for 468-point models. */
export function appleLandmarkPoint(landmarks, appleIndex) {
  const mediaPipeIndex = APPLE_LANDMARK_INDICES[appleIndex];
  if (landmarks[mediaPipeIndex]) return landmarks[mediaPipeIndex];
  if (mediaPipeIndex === 468) {
    return averageLandmarks(landmarks, [33, 133, 144, 153, 160, 158]);
  }
  if (mediaPipeIndex === 473) {
    return averageLandmarks(landmarks, [263, 362, 373, 380, 387, 385]);
  }
  return null;
}

// Least-squares calibration from MediaPipe's canonical face to Apple's pose zero point,
// fitted independently per axis against four faces in native reference samples. Angles are
// radians: every native entry had faceUnitOfAngle=1 and values consistent with radians.
export const APPLE_POSE_CALIBRATION = Object.freeze({
  yaw: Object.freeze({ scale: 1.0212823540623739, offset: 0.06557276028923575 }),
  pitch: Object.freeze({ scale: 0.7245256071153161, offset: 0.08162727013457771 }),
  roll: Object.freeze({ scale: 1.0395766734487242, offset: -0.028472053112188738 }),
});

/** Decompose MediaPipe's column-major canonical-to-runtime 4x4 matrix as Rz·Ry·Rx. */
export function mediaPipeEulerFromMatrix(matrix) {
  const data = matrix?.data || matrix;
  if (!data || data.length < 16) return { yaw: 0, pitch: 0, roll: 0 };
  const scale = Math.hypot(data[0], data[1], data[2]);
  if (!Number.isFinite(scale) || scale < 1e-8) return { yaw: 0, pitch: 0, roll: 0 };
  const r00 = data[0] / scale, r10 = data[1] / scale, r20 = data[2] / scale;
  const r11 = data[5] / scale, r12 = data[9] / scale;
  const r21 = data[6] / scale, r22 = data[10] / scale;
  const yaw = Math.asin(Math.max(-1, Math.min(1, -r20)));
  if (Math.abs(Math.cos(yaw)) < 1e-6) {
    return { yaw, pitch: Math.atan2(-r12, r11), roll: 0 };
  }
  return { yaw, pitch: Math.atan2(r21, r22), roll: Math.atan2(r10, r00) };
}

/** Convert a MediaPipe pose matrix to Apple's calibrated yaw/pitch/roll radians. */
export function applePoseFromMatrix(matrix) {
  const data = matrix?.data || matrix;
  if (!data || data.length < 16 || Math.hypot(data[0], data[1], data[2]) < 1e-8)
    return { yaw: 0, pitch: 0, roll: 0 };
  const raw = mediaPipeEulerFromMatrix(matrix);
  return Object.fromEntries(Object.entries(raw).map(([axis, value]) => {
    const calibration = APPLE_POSE_CALIBRATION[axis];
    return [axis, value * calibration.scale + calibration.offset];
  }));
}

let tasksPromise = null;
let visionPromise = null;
let landmarkerPromise = null;
let segmenterPromise = null;

function canvas(width, height) {
  const out = document.createElement("canvas");
  out.width = width;
  out.height = height;
  return out;
}

function loadTasks() {
  if (!tasksPromise) tasksPromise = import(TASKS_URL);
  return tasksPromise;
}

async function loadVisionFileset() {
  if (!visionPromise) {
    visionPromise = loadTasks().then(({ FilesetResolver }) =>
      FilesetResolver.forVisionTasks(WASM_URL));
  }
  return visionPromise;
}

async function loadLandmarker() {
  if (landmarkerPromise) return landmarkerPromise;
  landmarkerPromise = (async () => {
    const { FaceLandmarker } = await loadTasks();
    const vision = await loadVisionFileset();
    const options = {
      runningMode: "IMAGE", numFaces: 5,
      minFaceDetectionConfidence: 0.35, minFacePresenceConfidence: 0.4,
      minTrackingConfidence: 0.4, outputFaceBlendshapes: false,
      outputFacialTransformationMatrixes: true,
    };
    try {
      return await FaceLandmarker.createFromOptions(vision, {
        ...options, baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
      });
    } catch (gpuError) {
      console.warn("MediaPipe GPU delegate unavailable, using CPU:", gpuError);
      return FaceLandmarker.createFromOptions(vision, {
        ...options, baseOptions: { modelAssetPath: MODEL_URL, delegate: "CPU" },
      });
    }
  })().catch((error) => {
    landmarkerPromise = null;
    throw error;
  });
  return landmarkerPromise;
}

function normalizedLabel(value) {
  return String(value || "").toLowerCase().replace(/[^a-z]/g, "");
}

async function loadSegmenter() {
  if (segmenterPromise) return segmenterPromise;
  segmenterPromise = (async () => {
    const { ImageSegmenter } = await loadTasks();
    const vision = await loadVisionFileset();
    // Deliberately use CPU. MediaPipe's Web GPU delegate has returned scrambled
    // SelfieMulticlass categories on iOS Safari; correctness matters more than latency here.
    const segmenter = await ImageSegmenter.createFromOptions(vision, {
      baseOptions: { modelAssetPath: SEGMENTER_MODEL_URL, delegate: "CPU" },
      runningMode: "IMAGE", outputCategoryMask: false, outputConfidenceMasks: true,
    });
    const labels = segmenter.getLabels().map(normalizedLabel);
    const required = ["background", "hair", "bodyskin", "faceskin", "clothes", "others"];
    const indices = Object.fromEntries(required.map((name, fallback) => {
      const found = labels.indexOf(name);
      return [name, found >= 0 ? found : fallback];
    }));
    return { segmenter, indices };
  })().catch((error) => {
    segmenterPromise = null;
    throw error;
  });
  return segmenterPromise;
}

function path(ctx, landmarks, indices, width, height) {
  ctx.beginPath();
  indices.forEach((index, i) => {
    const point = landmarks[index];
    if (!point) return;
    const x = point.x * width, y = point.y * height;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.closePath();
}

function softened(source, blur = 1.5) {
  const out = canvas(source.width, source.height);
  const ctx = out.getContext("2d");
  ctx.filter = `blur(${blur}px)`;
  ctx.drawImage(source, 0, 0);
  return out;
}

function contourMask(faceLandmarks, indices, width, height, blur = 1.5) {
  const hard = canvas(width, height);
  const ctx = hard.getContext("2d");
  ctx.fillStyle = "white";
  for (const landmarks of faceLandmarks) {
    path(ctx, landmarks, indices, width, height);
    ctx.fill();
  }
  return softened(hard, blur);
}

/** Lips are the outer lip ring, not the mouth cavity. */
export function rasterizeLips(faceLandmarks, width, height) {
  const hard = canvas(width, height);
  const ctx = hard.getContext("2d");
  ctx.fillStyle = "white";
  for (const landmarks of faceLandmarks) {
    path(ctx, landmarks, LIPS_OUTER, width, height);
    ctx.fill();
    ctx.save();
    ctx.globalCompositeOperation = "destination-out";
    path(ctx, landmarks, LIPS_INNER, width, height);
    ctx.fill();
    ctx.restore();
  }
  return softened(hard, 1.25);
}

export function rasterizeEyebrows(faceLandmarks, width, height) {
  const hard = canvas(width, height);
  const ctx = hard.getContext("2d");
  ctx.fillStyle = "white";
  for (const landmarks of faceLandmarks) {
    for (const contour of [LEFT_EYEBROW, RIGHT_EYEBROW]) {
      path(ctx, landmarks, contour, width, height);
      ctx.fill();
    }
  }
  return softened(hard, 1.25);
}

/** Face Mesh stops just before the pinna; infer a restrained ear oval from each face box. */
export function rasterizeEars(faceLandmarks, width, height) {
  const hard = canvas(width, height);
  const ctx = hard.getContext("2d");
  ctx.fillStyle = "white";
  for (const landmarks of faceLandmarks) {
    const r = bounds(landmarks);
    const cy = (r.y + r.height * 0.51) * height;
    for (const cx of [r.x - r.width * 0.018, r.x + r.width * 1.018]) {
      ctx.beginPath();
      ctx.ellipse(cx * width, cy, r.width * width * 0.075,
        r.height * height * 0.19, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  return softened(hard, 1.75);
}

function multiplyMasks(first, second) {
  const width = first.width, height = first.height;
  const a = first.getContext("2d", { willReadFrequently: true })
    .getImageData(0, 0, width, height).data;
  const bCanvas = canvas(width, height);
  bCanvas.getContext("2d").drawImage(second, 0, 0, width, height);
  const b = bCanvas.getContext("2d", { willReadFrequently: true })
    .getImageData(0, 0, width, height).data;
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let p = 0; p < pixels.length; p += 4) {
    const alpha = Math.round(a[p + 3] * b[p + 3] / 255);
    pixels[p] = 255; pixels[p + 1] = 255; pixels[p + 2] = 255; pixels[p + 3] = alpha;
  }
  const out = canvas(width, height);
  out.getContext("2d").putImageData(new ImageData(pixels, width, height), 0, 0);
  return out;
}

/** Restrict SelfieMulticlass' accessory/other confidence to the two eye bands. */
export function rasterizeGlasses(faceLandmarks, accessoryMask, width, height) {
  const region = canvas(width, height);
  const ctx = region.getContext("2d");
  ctx.fillStyle = "white";
  for (const landmarks of faceLandmarks) {
    const r = bounds(landmarks, [...LEFT_EYE_REGION, ...RIGHT_EYE_REGION]);
    ctx.beginPath();
    ctx.rect((r.x - r.width * 0.15) * width, (r.y - r.height * 1.1) * height,
      r.width * 1.3 * width, r.height * 3.2 * height);
    ctx.fill();
  }
  return softened(multiplyMasks(accessoryMask, region), 1.25);
}

/** Bright, low-chroma pixels inside the open mouth are a conservative teeth estimate. */
export function rasterizeTeeth(display, faceLandmarks, width, height) {
  const mouth = contourMask(faceLandmarks, LIPS_INNER, width, height, 0);
  const image = canvas(width, height);
  image.getContext("2d").drawImage(display, 0, 0, width, height);
  const rgba = image.getContext("2d", { willReadFrequently: true })
    .getImageData(0, 0, width, height).data;
  const inside = mouth.getContext("2d", { willReadFrequently: true })
    .getImageData(0, 0, width, height).data;
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let p = 0; p < pixels.length; p += 4) {
    if (!inside[p + 3]) continue;
    const hi = Math.max(rgba[p], rgba[p + 1], rgba[p + 2]);
    const lo = Math.min(rgba[p], rgba[p + 1], rgba[p + 2]);
    const brightness = (rgba[p] + rgba[p + 1] + rgba[p + 2]) / (3 * 255);
    const whiteness = Math.max(0, Math.min(1, (brightness - 0.42) / 0.32))
      * Math.max(0, Math.min(1, 1 - (hi - lo) / 80));
    pixels[p] = 255; pixels[p + 1] = 255; pixels[p + 2] = 255;
    pixels[p + 3] = Math.round(inside[p + 3] * whiteness);
  }
  const out = canvas(width, height);
  out.getContext("2d").putImageData(new ImageData(pixels, width, height), 0, 0);
  return softened(out, 1);
}

/** Body-skin far outside the face/neck core is used only as a cautious hand candidate. */
export function rasterizeHands(faceLandmarks, bodySkinMask, width, height) {
  const candidates = canvas(width, height);
  candidates.getContext("2d").drawImage(bodySkinMask, 0, 0, width, height);
  const ctx = candidates.getContext("2d");
  ctx.save();
  ctx.globalCompositeOperation = "destination-out";
  ctx.fillStyle = "white";
  for (const landmarks of faceLandmarks) {
    const r = bounds(landmarks);
    ctx.beginPath();
    ctx.ellipse((r.x + r.width / 2) * width, (r.y + r.height * 0.9) * height,
      r.width * width * 0.82, r.height * height * 1.15, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
  return softened(candidates, 1.5);
}

function emptyMask(width, height) { return canvas(width, height); }

/** Build an upright confidence matte at the source image's aspect ratio. */
export function rasterizeFaceSkin(faceLandmarks, width, height) {
  const hard = canvas(width, height);
  const hctx = hard.getContext("2d");
  hctx.fillStyle = "white";
  for (const landmarks of faceLandmarks) {
    path(hctx, landmarks, FACE_OVAL, width, height);
    hctx.fill();
    hctx.save();
    hctx.globalCompositeOperation = "destination-out";
    for (const hole of FACE_HOLES) {
      path(hctx, landmarks, hole, width, height);
      hctx.fill();
    }
    hctx.restore();
  }

  // Apple's native mattes have soft anti-aliased boundaries.  A small blur keeps the mask
  // useful as a confidence map instead of introducing a hard retouching seam.
  const soft = canvas(width, height);
  const sctx = soft.getContext("2d");
  sctx.filter = "blur(2px)";
  sctx.drawImage(hard, 0, 0);
  return soft;
}

function bounds(landmarks, indices = FACE_OVAL) {
  const pts = indices.map((i) => landmarks[i]).filter(Boolean);
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

function clippedRect(x, y, width, height) {
  const left = Math.max(0, x), top = Math.max(0, y);
  const right = Math.min(1, x + width), bottom = Math.min(1, y + height);
  return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

/** Approximate the head and visible upper body when only face landmarks are available. */
export function rasterizePerson(faceLandmarks, width, height) {
  const hard = canvas(width, height);
  const ctx = hard.getContext("2d");
  ctx.fillStyle = "white";
  for (const landmarks of faceLandmarks) {
    const r = bounds(landmarks);
    const cx = r.x + r.width / 2;
    ctx.beginPath();
    ctx.ellipse(cx * width, (r.y + r.height * 0.48) * height,
      r.width * 0.62 * width, r.height * 0.62 * height, 0, 0, Math.PI * 2);
    ctx.fill();
    const shoulderY = Math.min(1, r.y + r.height * 0.88);
    const bottom = Math.min(1, r.y + r.height * 2.1);
    ctx.beginPath();
    ctx.moveTo(Math.max(0, cx - r.width * 1.25) * width, bottom * height);
    ctx.quadraticCurveTo((cx - r.width * 0.85) * width, shoulderY * height,
      (cx - r.width * 0.38) * width, (r.y + r.height * 0.72) * height);
    ctx.lineTo((cx + r.width * 0.38) * width, (r.y + r.height * 0.72) * height);
    ctx.quadraticCurveTo((cx + r.width * 0.85) * width, shoulderY * height,
      Math.min(1, cx + r.width * 1.25) * width, bottom * height);
    ctx.closePath();
    ctx.fill();
  }
  const soft = canvas(width, height);
  const sctx = soft.getContext("2d");
  sctx.filter = "blur(2px)";
  sctx.drawImage(hard, 0, 0);
  return soft;
}

function clampByte(value) {
  return Math.max(0, Math.min(255, Math.round(value * 255)));
}

/** Combine SelfieMulticlass probabilities into the three Apple-style semantic roles. */
export function combineSelfieConfidence(confidenceMasks, indices = {
  background: 0, hair: 1, bodyskin: 2, faceskin: 3, clothes: 4, others: 5,
}) {
  const background = confidenceMasks[indices.background];
  const bodySkin = confidenceMasks[indices.bodyskin];
  const faceSkin = confidenceMasks[indices.faceskin];
  const others = confidenceMasks[indices.others];
  if (!background || !bodySkin || !faceSkin)
    throw new Error("SelfieMulticlass did not return the required confidence masks");
  const length = background.length;
  if (bodySkin.length !== length || faceSkin.length !== length)
    throw new Error("SelfieMulticlass confidence-mask sizes do not match");
  const skin = new Uint8ClampedArray(length);
  const face = new Uint8ClampedArray(length);
  const body = new Uint8ClampedArray(length);
  const person = new Uint8ClampedArray(length);
  const accessories = new Uint8ClampedArray(length);
  for (let i = 0; i < length; i++) {
    face[i] = clampByte(faceSkin[i]);
    body[i] = clampByte(bodySkin[i]);
    skin[i] = clampByte(Math.min(1, bodySkin[i] + faceSkin[i]));
    person[i] = clampByte(1 - background[i]);
    accessories[i] = clampByte(others?.[i] || 0);
  }
  return { skin, faceSkin: face, bodySkin: body, person, accessories };
}

/** Turn one confidence plane into a soft alpha mask at the HEIC auxiliary-image size. */
export function confidenceMaskCanvas(values, sourceWidth, sourceHeight, width, height) {
  if (values.length !== sourceWidth * sourceHeight)
    throw new Error("SelfieMulticlass mask dimensions do not match its pixels");
  const low = canvas(sourceWidth, sourceHeight);
  const pixels = new Uint8ClampedArray(values.length * 4);
  for (let i = 0, p = 0; i < values.length; i++, p += 4) {
    pixels[p] = 255; pixels[p + 1] = 255; pixels[p + 2] = 255; pixels[p + 3] = values[i];
  }
  low.getContext("2d").putImageData(new ImageData(pixels, sourceWidth, sourceHeight), 0, 0);
  const out = canvas(width, height);
  const ctx = out.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(low, 0, 0, width, height);
  return out;
}

function analysisCanvas(display, maxDimension = 1024) {
  const scale = Math.min(1, maxDimension / Math.max(display.width, display.height));
  const out = canvas(Math.max(1, Math.round(display.width * scale)),
    Math.max(1, Math.round(display.height * scale)));
  const ctx = out.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(display, 0, 0, out.width, out.height);
  return out;
}

export function remapFaceLandmarks(landmarks, rect) {
  return landmarks.map((point) => ({
    ...point,
    x: rect.x + point.x * rect.width,
    y: rect.y + point.y * rect.height,
    z: (point.z || 0) * rect.width,
  }));
}

function faceCandidateBounds(candidate) {
  return bounds(candidate.landmarks);
}

function duplicateFace(a, b) {
  const ra = faceCandidateBounds(a), rb = faceCandidateBounds(b);
  const acx = ra.x + ra.width / 2, acy = ra.y + ra.height / 2;
  const bcx = rb.x + rb.width / 2, bcy = rb.y + rb.height / 2;
  const scale = Math.max(0.015,
    (Math.hypot(ra.width, ra.height) + Math.hypot(rb.width, rb.height)) / 2);
  return Math.hypot(acx - bcx, acy - bcy) < scale * 0.38;
}

/** Merge full-frame and crop detections without counting the same face twice. */
export function mergeFaceCandidates(candidates, maxFaces = 5) {
  const merged = [];
  for (const candidate of candidates) {
    if (!candidate?.landmarks?.length || merged.some((known) => duplicateFace(known, candidate)))
      continue;
    merged.push(candidate);
    if (merged.length === maxFaces) break;
  }
  return merged.sort((a, b) => faceCandidateBounds(a).x - faceCandidateBounds(b).x);
}

function detectionCandidates(result, rect = { x: 0, y: 0, width: 1, height: 1 }) {
  return (result.faceLandmarks || []).map((landmarks, i) => ({
    landmarks: remapFaceLandmarks(landmarks, rect),
    matrix: Array.from(result.facialTransformationMatrixes?.[i]?.data
      || result.facialTransformationMatrixes?.[i] || []),
  }));
}

/**
 * Face Landmarker internally sees a small detector input, so distant group faces can disappear
 * even when the source canvas is large. Run one whole-frame pass, then four overlapping crops
 * enlarged back to the analysis size, and merge their coordinates into the whole image.
 */
async function detectFacesMultiPass(landmarker, source) {
  const candidates = detectionCandidates(landmarker.detect(source));
  const windows = [
    { x: 0, y: 0, width: 0.62, height: 0.62 },
    { x: 0.38, y: 0, width: 0.62, height: 0.62 },
    { x: 0, y: 0.38, width: 0.62, height: 0.62 },
    { x: 0.38, y: 0.38, width: 0.62, height: 0.62 },
  ];
  for (const rect of windows) {
    await yieldToBrowser();
    const cropWidth = Math.max(1, Math.round(source.width * rect.width));
    const cropHeight = Math.max(1, Math.round(source.height * rect.height));
    const scale = Math.min(1.8, 1024 / Math.max(cropWidth, cropHeight));
    const crop = canvas(Math.round(cropWidth * scale), Math.round(cropHeight * scale));
    crop.getContext("2d").drawImage(source,
      Math.round(source.width * rect.x), Math.round(source.height * rect.y),
      cropWidth, cropHeight, 0, 0, crop.width, crop.height);
    candidates.push(...detectionCandidates(landmarker.detect(crop), rect));
  }
  return mergeFaceCandidates(candidates, 5);
}

async function segmentSelfie(source, width, height) {
  const { segmenter, indices } = await loadSegmenter();
  const result = segmenter.segment(source);
  const masks = result.confidenceMasks || [];
  if (masks.length < 6) {
    masks.forEach((mask) => mask.close());
    throw new Error(`SelfieMulticlass returned ${masks.length} confidence masks`);
  }
  const sourceWidth = masks[0].width, sourceHeight = masks[0].height;
  try {
    const copied = masks.map((mask) => Float32Array.from(mask.getAsFloat32Array()));
    const combined = combineSelfieConfidence(copied, indices);
    return {
      skin: confidenceMaskCanvas(combined.skin, sourceWidth, sourceHeight, width, height),
      faceSkin: confidenceMaskCanvas(combined.faceSkin, sourceWidth, sourceHeight, width, height),
      bodySkin: confidenceMaskCanvas(combined.bodySkin, sourceWidth, sourceHeight, width, height),
      person: confidenceMaskCanvas(combined.person, sourceWidth, sourceHeight, width, height),
      accessories: confidenceMaskCanvas(combined.accessories,
        sourceWidth, sourceHeight, width, height),
    };
  } finally {
    masks.forEach((mask) => mask.close());
  }
}

/** Partition a shared confidence mask into stable per-face regions for instance mattes. */
export function partitionMaskByFaces(source, faces) {
  if (faces.length <= 1) return [source];
  const width = source.width, height = source.height;
  const rgba = source.getContext("2d", { willReadFrequently: true })
    .getImageData(0, 0, width, height).data;
  const descriptors = faces.map((landmarks) => {
    const r = bounds(landmarks);
    return { x: r.x + r.width / 2, y: r.y + r.height / 2,
      scale: Math.max(0.02, Math.hypot(r.width, r.height)) };
  });
  const outputs = faces.map(() => new Uint8ClampedArray(width * height * 4));
  for (let y = 0, pixel = 0; y < height; y++) {
    const ny = (y + 0.5) / height;
    for (let x = 0; x < width; x++, pixel++) {
      const alpha = rgba[pixel * 4 + 3];
      if (!alpha) continue;
      const nx = (x + 0.5) / width;
      let winner = 0, best = Infinity;
      for (let i = 0; i < descriptors.length; i++) {
        const d = descriptors[i];
        const score = ((nx - d.x) ** 2 + (ny - d.y) ** 2) / (d.scale ** 2);
        if (score < best) { best = score; winner = i; }
      }
      const p = pixel * 4;
      outputs[winner][p] = 255; outputs[winner][p + 1] = 255;
      outputs[winner][p + 2] = 255; outputs[winner][p + 3] = alpha;
    }
  }
  return outputs.map((pixels) => {
    const out = canvas(width, height);
    out.getContext("2d").putImageData(new ImageData(pixels, width, height), 0, 0);
    return out;
  });
}

function analyzeMasked(display, mask) {
  const width = mask.width, height = mask.height;
  const image = canvas(width, height);
  const ictx = image.getContext("2d", { willReadFrequently: true });
  ictx.drawImage(display, 0, 0, width, height);
  const rgba = ictx.getImageData(0, 0, width, height).data;
  const alpha = mask.getContext("2d", { willReadFrequently: true })
    .getImageData(0, 0, width, height).data;
  const red = [], green = [], blue = [], tone = [], linear = [];
  let selected = 0;
  for (let p = 0; p < rgba.length; p += 4) {
    if (alpha[p + 3] < 128) continue;
    const r = rgba[p] / 255, g = rgba[p + 1] / 255, b = rgba[p + 2] / 255;
    red.push(r); green.push(g); blue.push(b);
    tone.push(0.2126 * r + 0.7152 * g + 0.0722 * b);
    linear.push(0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b));
    selected++;
  }
  for (const a of [red, green, blue, tone, linear]) a.sort((x, y) => x - y);
  const avg = (a) => a.length ? a.reduce((sum, v) => sum + v, 0) / a.length : 0;
  const mean = avg(tone);
  const variance = tone.length
    ? tone.reduce((sum, v) => sum + (v - mean) ** 2, 0) / tone.length : 0;
  return {
    coverage: selected / (width * height), averageColor: [avg(red), avg(green), avg(blue)],
    roughness: variance, red, green, blue, tone, linear,
  };
}

export function peopleEntry(landmarks, faceStats, referenceKey, angle, mirror,
  pose = { yaw: 0, pitch: 0, roll: 0 }) {
  const skin = bounds(landmarks);
  const innerIndices = [...FACE_HOLES[0], ...FACE_HOLES[1], ...FACE_HOLES[2]];
  const inner = bounds(landmarks, innerIndices);
  const instance = clippedRect(skin.x - skin.width * 0.32, skin.y - skin.height * 0.12,
    skin.width * 1.64, skin.height * 1.42);
  const scaleW = Math.min(1, 0.129 / Math.max(skin.width, 0.001));
  const scaleH = Math.min(1, 0.17 / Math.max(skin.height, 0.001));
  const storedPoint = (p) => displayPointToStored(p.x, p.y, angle, mirror);
  const point = (p) => new Map(Object.entries(storedPoint(p)));
  const storedRect = (rect) => new Map(Object.entries(transformNormalizedRect(rect,
    (x, y) => displayPointToStored(x, y, angle, mirror))));
  const skinRect = clippedRect(skin.x, skin.y, skin.width, skin.height);
  const faceRect = clippedRect(inner.x, inner.y, inner.width, inner.height);
  const scalingRect = { x: (1 - scaleW) / 2, y: (1 - scaleH) / 2,
    width: scaleW, height: scaleH };
  return new Map([
    ["faceSkinROI", storedRect(skinRect)],
    ["faceID", 0], ["faceYaw", pose.yaw],
    ["faceROI", storedRect(faceRect)],
    ["imageStats", new Map([
      ["Mattify", new Map([["SkipPerson", false], ["HighlightsToMaskRatio", 0],
        ["faceID", 0], ["AverageFaceColor", faceStats.averageColor]])],
      ["SkinSmoothingStandalone", new Map([["faceID", 0],
        ["SkinSmoothAverageFaceColour", faceStats.averageColor],
        ["SkinSmoothSkipPerson", false], ["SkinSmoothFaceRoughness", faceStats.roughness]])],
      ["UnderEyeBrightening", new Map([["faceID", 0],
        ["RightEyeIsBiModal", false], ["LeftEyeLumaVariance", faceStats.roughness],
        ["LeftEyeIsBiModal", false], ["LeftEyeAverageColor", faceStats.averageColor],
        ["RightEyeAverageColor", faceStats.averageColor],
        ["RightEyeLumaVariance", faceStats.roughness]])],
    ])],
    ["faceLandmarkType", 1], ["faceUnitOfAngle", 1],
    ["instanceROI", storedRect(instance)],
    ["instanceMaskReferenceKey", referenceKey],
    ["faceROIAndLandmarksROIRelativeScalingROI", storedRect(scalingRect)],
    ["facePitch", pose.pitch], ["faceRoll", pose.roll],
    ["faceLandmarks", APPLE_LANDMARK_INDICES.map((_, appleIndex) => new Map([
      ["point", point(appleLandmarkPoint(landmarks, appleIndex))], ["error", 0.02],
    ]))],
  ]);
}

export function buildPersonMetadata(display, skinMask, personMask, faces, referenceKeys,
  angle = 0, mirror = null, faceMasks = null, poses = null) {
  const skin = analyzeMasked(display, skinMask);
  const person = analyzeMasked(display, personMask);
  const block = (values) => statsBlock(values, 1);
  return {
    personMetadata: {
      peopleRatio: person.coverage, skinRatio: skin.coverage,
      blocks: {
        ToneMappedImageRedChannelSkinBased: block(skin.red),
        ToneMappedImageGreenChannelSkinBased: block(skin.green),
        ToneMappedImageBlueChannelSkinBased: block(skin.blue),
        ToneMappedImageSkinBased: block(skin.tone),
        LinearImageSkinBased: block(skin.linear),
        ToneMappedImagePersonSegmentBased: block(person.tone),
        LinearImagePersonSegmentBased: block(person.linear),
      },
    },
    texturePeopleData: faces.map((face, i) => {
      const faceMask = faceMasks?.[i]
        || rasterizeFaceSkin([face], skinMask.width, skinMask.height);
      return peopleEntry(face, analyzeMasked(display, faceMask), referenceKeys[i], angle, mirror,
        poses?.[i]);
    }),
  };
}

function opaqueMask(source) {
  const out = canvas(source.width, source.height);
  const ctx = out.getContext("2d");
  ctx.fillStyle = "black";
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(source, 0, 0);
  return out;
}

function drawTint(ctx, mask, color, alpha) {
  const tint = canvas(mask.width, mask.height);
  const tctx = tint.getContext("2d");
  tctx.drawImage(mask, 0, 0);
  tctx.globalCompositeOperation = "source-in";
  tctx.fillStyle = color;
  tctx.fillRect(0, 0, tint.width, tint.height);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.drawImage(tint, 0, 0);
  ctx.restore();
}

function diagnosticOverlay(display, skinMask, personMask, faces) {
  const out = canvas(skinMask.width, skinMask.height);
  const ctx = out.getContext("2d");
  ctx.drawImage(display, 0, 0, out.width, out.height);
  drawTint(ctx, personMask, "#1687ff", 0.25);
  drawTint(ctx, skinMask, "#ff2d2d", 0.58);
  ctx.lineWidth = Math.max(1.5, out.width / 300);
  ctx.strokeStyle = "#58ff72";
  ctx.fillStyle = "#58ff72";
  ctx.font = `bold ${Math.max(13, Math.round(out.width / 32))}px system-ui`;
  faces.forEach((landmarks, faceIndex) => {
    path(ctx, landmarks, FACE_OVAL, out.width, out.height);
    ctx.stroke();
    for (let appleIndex = 0; appleIndex < APPLE_LANDMARK_INDICES.length; appleIndex++) {
      const p = appleLandmarkPoint(landmarks, appleIndex);
      if (!p) continue;
      ctx.beginPath();
      ctx.arc(p.x * out.width, p.y * out.height, Math.max(1.2, out.width / 420), 0, Math.PI * 2);
      ctx.fill();
    }
    const r = bounds(landmarks);
    ctx.fillText(`${faceIndex + 1}`, r.x * out.width, Math.max(18, r.y * out.height - 4));
  });
  return out;
}

function pngBlob(source) {
  return new Promise((resolve, reject) => source.toBlob(
    (blob) => blob ? resolve(blob) : reject(new Error("Could not create diagnostic PNG")),
    "image/png"));
}

async function buildDebugArtifacts(display, semanticMasks, faces) {
  // The inspector decodes masks and geometry from the final HEIC. Only this process
  // overlay is unique to inference and is not embedded in the output file.
  return { overlay: await pngBlob(diagnosticOverlay(display, semanticMasks.semanticskinmattev2,
    semanticMasks.semanticpersonmatte, faces)) };
}

/** Inverse of the HEIC display transform used in decode.js. */
export function matteToStored(display, angle, mirror) {
  const swap = angle === 90 || angle === 270;
  const rotated = canvas(swap ? display.height : display.width,
    swap ? display.width : display.height);
  const ctx = rotated.getContext("2d");
  ctx.translate(rotated.width / 2, rotated.height / 2);
  // displayPointToStored() first undoes rotation, then applies the mirror in stored
  // coordinates. Canvas composes transforms in reverse point-operation order, so the
  // mirror command must come before rotate here. The old R*M order only failed on files
  // carrying imir: geometry (which uses the point helper) stayed correct while every newly
  // encoded 2026 matte appeared reflected/rotated in the embedded-data inspector.
  if (mirror === 0) ctx.scale(-1, 1);
  else if (mirror === 1) ctx.scale(1, -1);
  ctx.rotate(displayToStoredRotationRadians(angle));
  ctx.translate(-display.width / 2, -display.height / 2);
  ctx.drawImage(display, 0, 0);

  return rotated;
}

/** Keep the source aspect ratio, rounding to even pixels for HEVC encoders. */
export function faceMatteDimensions(width, height, maxDimension = 768) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0)
    throw new Error("Invalid face-matte source dimensions");
  const scale = Math.min(1, maxDimension / Math.max(width, height));
  return {
    width: Math.max(2, Math.round(width * scale / 2) * 2),
    height: Math.max(2, Math.round(height * scale / 2) * 2),
  };
}

export function displayToStoredRotationRadians(angle) {
  return angle * Math.PI / 180;
}

const be32 = (n) => new Uint8Array([
  (n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255,
]);

function hvccBox(description) {
  const record = ArrayBuffer.isView(description)
    ? new Uint8Array(description.buffer, description.byteOffset, description.byteLength).slice()
    : new Uint8Array(description).slice();
  return concat([be32(record.length + 8), new TextEncoder().encode("hvcC"), record]);
}

async function supportedHevcConfig(width, height) {
  if (!globalThis.VideoEncoder || !globalThis.VideoFrame) return null;
  const codecs = ["hvc1.1.6.L93.B0", "hev1.1.6.L93.B0"];
  for (const codec of codecs) {
    const config = {
      codec, width, height, framerate: 1, bitrate: 2_000_000,
      hardwareAcceleration: "prefer-hardware", latencyMode: "quality",
      hevc: { format: "hevc" },
    };
    try {
      const support = await VideoEncoder.isConfigSupported(config);
      if (support.supported) return support.config || config;
    } catch { /* try the next codec string */ }
  }
  return null;
}

/** Encode one stored-orientation grayscale canvas as a canonical HEVC access unit. */
export async function encodeFaceMatte(canvasSource) {
  const { width, height } = canvasSource;
  const config = await supportedHevcConfig(width, height);
  if (!config) throw new Error("HEVC WebCodecs encoder unavailable");
  let description = null;
  const chunks = [];
  let encoderError = null;
  const encoder = new VideoEncoder({
    output(chunk, metadata) {
      if (metadata?.decoderConfig?.description) {
        const source = metadata.decoderConfig.description;
        description = ArrayBuffer.isView(source)
          ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength).slice()
          : new Uint8Array(source).slice();
      }
      const bytes = new Uint8Array(chunk.byteLength);
      chunk.copyTo(bytes);
      chunks.push(bytes);
    },
    error(error) { encoderError = error; },
  });
  try {
    encoder.configure(config);
    const frame = new VideoFrame(canvasSource, { timestamp: 0, duration: 1_000_000 });
    try { encoder.encode(frame, { keyFrame: true }); }
    finally { frame.close(); }
    await encoder.flush();
  } finally {
    encoder.close();
  }
  if (encoderError) throw encoderError;
  if (!description || !chunks.length) throw new Error("HEVC encoder returned no configuration");
  return { payload: concat(chunks), hvcc: hvccBox(description), width, height };
}

/**
 * Return an optional Map(aux URI -> encoded replacement) plus a user-facing outcome code.
 * Skin and person mattes are accompanied by the coverage/statistics and per-face metadata
 * observed in native iPhone 18 files. The semantic masks come from SelfieMulticlass confidence
 * maps; no photo pixels leave the browser.
 */
async function generateFaceMattesFromDisplay(display, angle, mirror, options = {}) {
  const {portraitOnly = false} = options;
  const analysis = analysisCanvas(display);
  await reportProgress(options, "models");
  const landmarker = portraitOnly ? null : await loadLandmarker();
  await loadSegmenter();
  let detections = [];
  if (!portraitOnly) {
    await reportProgress(options, "detect");
    detections = await detectFacesMultiPass(landmarker, analysis);
  }
  const faces = detections.map((candidate) => candidate.landmarks);

  const { width: displayWidth, height: displayHeight } =
    faceMatteDimensions(display.width, display.height);
  await reportProgress(options, "segment");
  const segmented = await segmentSelfie(analysis, displayWidth, displayHeight);
  const review = {display, angle, mirror, detections, segmented,
    items: detections.map((candidate, index) => {
      const r = bounds(candidate.landmarks);
      return {id: index, rect: clippedRect(r.x - r.width * .15, r.y - r.height * .15,
        r.width * 1.3, r.height * 1.3)};
    })};
  if (!portraitOnly && faces.length) {
    const result = await rebuildFaceMattes(review, [], options);
    // Keep a bounded, upright preview for subsequent corrections, rather than the
    // full-resolution HEIC canvas. Restoring all faces uses the original output.
    review.display = analysis;
    return result;
  }
  await reportProgress(options, "matte", {matte: "portraiteffectsmatte"});
  const portraitEncoded=await encodeFaceMatte(matteToStored(opaqueMask(segmented.person),angle,mirror));
  const portraitOverride={...portraitEncoded,pixi:FACE_MATTE_PIXI};
  return {state:portraitOnly?'skipped':'none',overrides:new Map([[MATTE_URIS.portraiteffectsmatte,portraitOverride]]),faces:0,portraitGenerated:true};
}

/** Rebuild from the saved detections; never run inference again after manual exclusion. */
export async function rebuildFaceMattes(review, excludedIds = [], options = {}) {
  const excluded = new Set(excludedIds);
  if ([...excluded].some(id => !Number.isInteger(id) || id < 0 || id >= review.detections.length))
    throw new Error("Invalid excluded face ID");
  const keptIds = review.detections.map((_, i) => i).filter(i => !excluded.has(i));
  const kept = keptIds.map(i => review.detections[i]);
  const faces = kept.map(candidate => candidate.landmarks);
  const poses = kept.map(candidate => applePoseFromMatrix(candidate.matrix));
  const {display, angle, mirror} = review;
  const segmented = {...review.segmented};
  const displayWidth = segmented.person.width, displayHeight = segmented.person.height;
  // Erase only excluded face regions from the generated face-skin mask. A kept,
  // overlapping detection protects the same real face when removing a duplicate.
  if (excluded.size) {
    const removed = contourMask(review.detections.filter((_, i) => excluded.has(i))
      .map(candidate => candidate.landmarks), FACE_OVAL, displayWidth, displayHeight, 0);
    const removedCtx = removed.getContext("2d");
    removedCtx.globalCompositeOperation = "destination-out";
    removedCtx.drawImage(contourMask(faces, FACE_OVAL, displayWidth, displayHeight, 0), 0, 0);
    const faceSkin = canvas(displayWidth, displayHeight), ctx = faceSkin.getContext("2d");
    ctx.drawImage(segmented.faceSkin, 0, 0);
    ctx.globalCompositeOperation = "destination-out"; ctx.drawImage(removed, 0, 0);
    segmented.faceSkin = faceSkin;
  }
  let portraitEncoded = review.portraitEncoded;
  if (!portraitEncoded) {
    await reportProgress(options, "matte", {matte: "portraiteffectsmatte"});
    portraitEncoded = review.portraitEncoded = await encodeFaceMatte(
      matteToStored(opaqueMask(segmented.person), angle, mirror));
  }
  const portraitOverride = {...portraitEncoded, pixi: FACE_MATTE_PIXI};
  const builders = {
    semanticnosematte: () => contourMask(faces, NOSE_REGION, displayWidth, displayHeight),
    semanticskinmattev2: () => segmented.skin,
    semanticnonfaceskinmatte: () => segmented.bodySkin,
    semanticlipsmatte: () => rasterizeLips(faces, displayWidth, displayHeight),
    semanticteethmattev2: () => rasterizeTeeth(display, faces, displayWidth, displayHeight),
    semanticpersonmatte: () => segmented.person,
    semanticglassesmattev2: () => rasterizeGlasses(faces, segmented.accessories,
      displayWidth, displayHeight),
    semanticeyebrowsmatte: () => rasterizeEyebrows(faces, displayWidth, displayHeight),
    // No dependable browser tattoo classifier exists here. Empty is correct for the common
    // case and avoids treating shadows or clothing patterns as tattoos.
    semantictattoomatte: () => emptyMask(displayWidth, displayHeight),
    semantichandsmatte: () => faces.length
      ? rasterizeHands(faces, segmented.bodySkin, displayWidth, displayHeight) : emptyMask(displayWidth, displayHeight),
    semanticearsmatte: () => rasterizeEars(faces, displayWidth, displayHeight),
    semanticfaceskinmatte: () => segmented.faceSkin,
  };
  const semanticMasks = {};
  const encodeMask = (mask) => encodeFaceMatte(
    matteToStored(opaqueMask(mask), angle, mirror));
  const encodedByName = new Map();
  const shared = new Set(["semanticskinmattev2", "semanticnonfaceskinmatte", "semanticpersonmatte", "semantictattoomatte"]);
  for (const [name, build] of Object.entries(builders)) {
    // Person and Portrait share the encoded mask; do not report a second fake encode.
    const cached = shared.has(name) ? review.baseEncoded?.get(name) : null;
    if (!cached && name !== "semanticpersonmatte") await reportProgress(options, "matte", {matte: name});
    const mask = semanticMasks[name] = build();
    encodedByName.set(name, cached || (name === 'semanticpersonmatte' ? portraitEncoded : await encodeMask(mask)));
  }
  review.baseEncoded ||= new Map(encodedByName);
  const encodedPerson = encodedByName.get("semanticpersonmatte");
  const referenceKeys = keptIds.map(i => `FSINCInstanceMask${9 + i}`);
  const instances = [];
  let personInstances;
  for (let i = 0; i < faces.length; i++) {
    if (faces.length > 1) {
      await reportProgress(options, "matte", {matte: "personInstance", index: i + 1, total: faces.length});
      personInstances ||= partitionMaskByFaces(segmented.person, faces);
    }
    const encoded = faces.length === 1 ? encodedPerson : await encodeMask(personInstances[i]);
    instances.push({ ...encoded, pixi: FACE_MATTE_PIXI, referenceKey: referenceKeys[i] });
  }
  const byName = new Map(MATTE_2026_URIS.map((uri) => [uri.split(":").pop(), uri]));
  const overrides = new Map();
  for (const [name, encoded] of encodedByName)
    overrides.set(byName.get(name), { ...encoded, pixi: FACE_MATTE_PIXI });
  overrides.set(MATTE_URIS.portraiteffectsmatte,portraitOverride);
  overrides.set(URI_PERSON_INSTANCES, { instances });
  await reportProgress(options, "metadata");
  const faceInstances = partitionMaskByFaces(segmented.faceSkin, faces);
  const metadata = buildPersonMetadata(display, segmented.skin, segmented.person,
    faces, referenceKeys, angle, mirror, faceInstances, poses);
  const debugArtifacts = await buildDebugArtifacts(
    display, semanticMasks, faces);
  return { state: "generated", overrides, faces: faces.length, debugArtifacts, review, ...metadata };
}

export async function generateFaceMattes(bytes, discovery,options={}) {
  await reportProgress(options, "decode");
  const display = await decodeToDisplayCanvas(bytes);
  const angle = irotAngleForItem(bytes, discovery.props, discovery.primary);
  const mirror = imirAxisForItem(bytes, discovery.props, discovery.primary);
  return generateFaceMattesFromDisplay(display, angle, mirror,options);
}

/** Run the same local face/skin pipeline on a decoded PNG/JPEG source. */
export async function generateRasterFaceMattes(image, angle = 270, mirror = null,options={}) {
  await reportProgress(options, "decode");
  const display = document.createElement("canvas");
  const dimensions = faceMatteDimensions(image.width, image.height, 1024);
  display.width = dimensions.width;
  display.height = dimensions.height;
  const ctx = display.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("Could not create raster face-analysis canvas");
  ctx.fillStyle = "black";
  ctx.fillRect(0, 0, display.width, display.height);
  // Analyze the source without stretching faces to a fixed 3:4 raster.
  ctx.drawImage(image, 0, 0, display.width, display.height);
  return generateFaceMattesFromDisplay(display, angle, mirror,options);
}
