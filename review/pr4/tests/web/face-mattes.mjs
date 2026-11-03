// Exercise the WebCodecs packaging without requiring a browser HEVC implementation.

class FakeFrame {
  constructor(source, init) { this.source = source; this.init = init; }
  close() { this.closed = true; }
}

class FakeEncoder {
  static async isConfigSupported(config) { return { supported: true, config }; }
  constructor({ output, error }) { this.output = output; this.error = error; }
  configure(config) { this.config = config; FakeEncoder.lastConfig = config; }
  encode() {
    const backing = new Uint8Array([99, 1, 2, 3, 88]);
    const description = new DataView(backing.buffer, 1, 3);
    this.output({
      byteLength: 4,
      copyTo(out) { out.set([0, 0, 0, 7]); },
    }, { decoderConfig: { description } });
  }
  async flush() {}
  close() {}
}

globalThis.VideoFrame = FakeFrame;
globalThis.VideoEncoder = FakeEncoder;

const {
  encodeFaceMatte, matteToStored, displayToStoredRotationRadians, peopleEntry, combineSelfieConfidence,
  mediaPipeEulerFromMatrix, applePoseFromMatrix, faceMatteDimensions,
  FACE_OVAL, FACE_HOLES, FACE_MATTE_PIXI, LIPS_OUTER, LIPS_INNER,
  LEFT_EYEBROW, RIGHT_EYEBROW, NOSE_REGION, remapFaceLandmarks, mergeFaceCandidates,
} = await import("../../web/src/face-mattes.js");
const { payload, hvcc, width, height } = await encodeFaceMatte({ width: 432, height: 768 });
const ascii = (b) => String.fromCharCode(...b);
const failures = [];
if (FakeEncoder.lastConfig.width !== 432 || FakeEncoder.lastConfig.height !== 768
    || width !== 432 || height !== 768)
  failures.push("HEVC and replacement dimensions must match the source canvas");
for (const [w, h, expected] of [
  [3213, 5712, [432, 768]], // Portrait fixture: portrait stored with irot=0.
  [1290, 2796, [354, 768]], // Tall raster fixture: tall raster input.
  [4032, 3024, [768, 576]],
  [1000, 1000, [768, 768]],
]) {
  const size = faceMatteDimensions(w, h);
  if (size.width !== expected[0] || size.height !== expected[1])
    failures.push(`source aspect ratio was lost for ${w}x${h}`);
}
if (payload.join(",") !== "0,0,0,7") failures.push("encoded chunk was not preserved");
if (ascii(hvcc.slice(4, 8)) !== "hvcC") failures.push("description was not wrapped as hvcC");
if (hvcc.slice(8).join(",") !== "1,2,3") failures.push("description view offset was lost");
if (FACE_OVAL.length < 30 || FACE_HOLES.length !== 5) failures.push("face contours are incomplete");
if (LIPS_OUTER.length < 20 || LIPS_INNER.length < 20 || NOSE_REGION.length < 12
    || LEFT_EYEBROW.length < 10 || RIGHT_EYEBROW.length < 10)
  failures.push("feature-matte contours are incomplete");
if (FACE_MATTE_PIXI.join(",") !== "0,0,0,14,112,105,120,105,0,0,0,0,1,8")
  failures.push("face matte pixi is not native-compatible single-channel 8-bit");
if (displayToStoredRotationRadians(270) !== 1.5 * Math.PI)
  failures.push("display-to-stored rotation is not the inverse of native matte display");
const transformOps = [];
globalThis.document = { createElement() { return {
  width: 0, height: 0,
  getContext() { return {
    translate(...args) { transformOps.push(["translate", ...args]); },
    scale(...args) { transformOps.push(["scale", ...args]); },
    rotate(...args) { transformOps.push(["rotate", ...args]); },
    drawImage(...args) { transformOps.push(["drawImage", ...args]); },
  }; },
}; } };
matteToStored({ width: 576, height: 768 }, 270, 0);

for (const angle of [0, 90, 180, 270]) {
  transformOps.length = 0;
  const stored = matteToStored({ width: 354, height: 768 }, angle, null);
  const swap = angle === 90 || angle === 270;
  if (stored.width !== (swap ? 768 : 354) || stored.height !== (swap ? 354 : 768)
      || transformOps.filter(([op]) => op === "drawImage").length !== 1)
    failures.push(`matte was stretched while converting to stored orientation at ${angle}`);
}
transformOps.length = 0;
matteToStored({ width: 576, height: 768 }, 270, 0);
delete globalThis.document;
if (transformOps[1]?.[0] !== "scale" || transformOps[2]?.[0] !== "rotate")
  failures.push("mirrored matte must undo rotation before mirroring in stored coordinates");
const confidence = combineSelfieConfidence([
  new Float32Array([0.1, 0.7]), new Float32Array([0.1, 0.1]),
  new Float32Array([0.25, 0.05]), new Float32Array([0.5, 0.1]),
  new Float32Array([0.04, 0.03]), new Float32Array([0.01, 0.02]),
]);
if (confidence.faceSkin.join(",") !== "128,26")
  failures.push("face-skin confidence was not preserved");
if (confidence.bodySkin.join(",") !== "64,13")
  failures.push("body-skin confidence was not preserved");
if (confidence.skin.join(",") !== "191,38")
  failures.push("body and face skin confidence were not combined");
if (confidence.person.join(",") !== "229,77")
  failures.push("person confidence was not derived from background probability");
if (confidence.accessories.join(",") !== "3,5")
  failures.push("accessory confidence was not preserved for the glasses mask");
const fakeFace = (x, y, size = 0.1) => ({
  landmarks: Array.from({ length: 478 }, () => ({ x, y, z: size })), matrix: [],
});
const remapped = remapFaceLandmarks([{ x: 0.5, y: 0.25, z: 0.1 }],
  { x: 0.4, y: 0.3, width: 0.5, height: 0.6 })[0];
if (Math.abs(remapped.x - 0.65) > 1e-12 || Math.abs(remapped.y - 0.45) > 1e-12
    || Math.abs(remapped.z - 0.05) > 1e-12)
  failures.push("crop face coordinates were not remapped to the full image");
const mergedFaces = mergeFaceCandidates([
  fakeFace(0.2, 0.5), fakeFace(0.205, 0.502), fakeFace(0.5, 0.5), fakeFace(0.8, 0.5),
]);
if (mergedFaces.length !== 3)
  failures.push("overlapping full-frame and crop face detections were not deduplicated");
const poseSamples = [
  [[0.9955455661, 0.0307721104, -0.0891112238, 0,
    -0.0321421102, 0.9993847609, -0.0139798559, 0,
    0.0886262506, 0.0167817697, 0.9959229231, 0, 0, 0, 0, 1],
  { yaw: 0.1395922601, pitch: 0.0582912713, roll: -0.0153398076 }],
  [[0.9520481229, 0.1329495907, -0.2755514681, 0,
    -0.1304356009, 0.9910745025, 0.0275157578, 0,
    0.2767502964, 0.0097452533, 0.9608923197, 0, 0, 0, 0, 1],
  { yaw: 0.3804272413, pitch: 0.1288543940, roll: 0.1104466245 }],
  [[0.9547578096, -0.0126251001, 0.2971164584, 0,
    -0.0324867703, 0.9886912704, 0.1464049816, 0,
    -0.2956047952, -0.1494336724, 0.9435505271, 0, 0, 0, 0, 1],
  { yaw: -0.2224272192, pitch: 0.1886796504, roll: -0.0061359233 }],
  [[0.9880636334, -0.1524812430, -0.0219147671, 0,
    0.1530763805, 0.9877985120, 0.0286785942, 0,
    0.0172744151, -0.0316909030, 0.9993487597, 0, 0, 0, 0, 1],
  { yaw: 0.0552233122, pitch: 0.0935728252, roll: -0.1994175166 }],
];
const rawPose = mediaPipeEulerFromMatrix(poseSamples[0][0]);
if (Math.abs(rawPose.yaw - 0.0892295831) > 1e-7
    || Math.abs(rawPose.pitch + 0.0140361644) > 1e-7
    || Math.abs(rawPose.roll - 0.0308999578) > 1e-7)
  failures.push("MediaPipe column-major pose matrix was decomposed with the wrong axes");
for (const [matrix, nativePose] of poseSamples) {
  const predicted = applePoseFromMatrix(matrix);
  for (const axis of ["yaw", "pitch", "roll"]) {
    if (Math.abs(predicted[axis] - nativePose[axis]) > 0.037)
      failures.push(`Apple ${axis} calibration exceeded the native-sample residual`);
  }
}
const landmarks = Array.from({ length: 468 }, () => ({ x: 0.2, y: 0.3 }));
const entry = peopleEntry(landmarks, { averageColor: [0, 0, 0], roughness: 0 },
  "FSINCInstanceMask9", 270, null, { yaw: 0.1, pitch: 0.2, roll: -0.3 });
const firstPoint = entry.get("faceLandmarks")[0].get("point");
if (Math.abs(firstPoint.get("x") - 0.3) > 1e-12 || Math.abs(firstPoint.get("y") - 0.8) > 1e-12)
  failures.push("generated landmarks were not converted to HEIF stored coordinates");
if (entry.get("faceYaw") !== 0.1 || entry.get("facePitch") !== 0.2
    || entry.get("faceRoll") !== -0.3)
  failures.push("generated pose was not written into Apple people metadata");

if (failures.length) {
  failures.forEach((failure) => console.error(`  [FAIL] ${failure}`));
  process.exit(1);
}
console.log("  [PASS] face contour data and HEVC WebCodecs packaging");
