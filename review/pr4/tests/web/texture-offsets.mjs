import assert from "node:assert/strict";
import { shouldShiftOriginalPayload } from "../../web/src/texture.js";

const external = new Map([
  [49, { extents: [{}] }],
  [129, { extents: [{}] }],
]);
const replacements = new Map([
  [129, new Uint8Array([1, 2, 3])],
  [132, new Uint8Array([4, 5, 6])],
]);

assert.equal(shouldShiftOriginalPayload(49, external, replacements), true,
  "untouched original payload must move with meta growth");
assert.equal(shouldShiftOriginalPayload(129, external, replacements), false,
  "replaced original payload already has its appended-mdat offset");
assert.equal(shouldShiftOriginalPayload(132, external, replacements), false,
  "new payload is not an original external payload");

console.log("texture offset regression checks passed");
