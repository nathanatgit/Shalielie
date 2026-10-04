import { diagnosePortError } from "../../web/src/errors.js";

const cases = [
  ["Unsupported tile layout: 63/16 HDR", "layout", "63/16"],
  ["Missing HDR gain-map grid or HDR tiles", "hdr", ""],
  ["Apple MakerNote tag 0x54 not found", "metadata", ""],
  ["Profile fetch failed: 48-12 (404)", "profile", ""],
  ["file too large for 32-bit offsets", "size", ""],
  ["self-check failed: item 42 changed", "integrity", ""],
  ["HEVC WebCodecs encoder unavailable for raster import", "encoder", ""],
  ["8-bit linear thumbnail encode failed", "linear8", "8-bit linear thumbnail encode failed"],
  ["Raster image decode failed: unsupported image", "raster", ""],
  ["unsupported iloc layout", "structure", "unsupported iloc layout"],
  ["something entirely new", "unexpected", "something entirely new"],
];

let failures = 0;
for (const [message, code, detail] of cases) {
  const actual = diagnosePortError(new Error(message));
  const pass = actual.code === code && actual.detail === detail;
  console.log(`  [${pass ? "PASS" : "FAIL"}] ${message} -> ${actual.code}`);
  if (!pass) failures++;
}
process.exit(failures ? 1 : 0);
