// Check the copy after editing web/src/i18n.js.
//
//   node tests/web/check-i18n.mjs
//
// Catches the two mistakes that are easy to make and invisible until someone
// switches language: a key defined in one language but not the other, and a key
// index.html asks for that no longer exists.

import { readFileSync } from "node:fs";
import { STRINGS } from "../../web/src/i18n.js";

const ROOT = new URL("../../", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const html = readFileSync(`${ROOT}web/index.html`, "utf8");
const app = readFileSync(`${ROOT}web/app.js`, "utf8");

const usedInHtml = new Set([...html.matchAll(/data-i18n="([^"]+)"/g)].map((m) => m[1]));
// Keys reach T() through ternaries and variables as well as literal calls, so match
// any quoted token shaped like a key rather than only T("...").
const usedInJs = new Set(
  [...app.matchAll(/"([a-z]+\.[A-Za-z0-9]+)"/g)].map((m) => m[1])
    .filter((k) => k in STRINGS.en));
const used = new Set([...usedInHtml, ...usedInJs]);

const langs = Object.keys(STRINGS);
const problems = [];

// Every language must define the same keys.
const reference = new Set(Object.keys(STRINGS[langs[0]]));
for (const lang of langs.slice(1)) {
  const keys = new Set(Object.keys(STRINGS[lang]));
  for (const k of reference) if (!keys.has(k)) problems.push(`${lang} is missing "${k}"`);
  for (const k of keys) if (!reference.has(k)) problems.push(`${lang} has extra "${k}"`);
}

// Every key the page asks for must exist.
for (const k of used)
  for (const lang of langs)
    if (!(k in STRINGS[lang])) problems.push(`"${k}" is used by the page but missing from ${lang}`);

// Anything defined but never shown is dead weight, worth flagging but not fatal.
const unused = [...reference].filter((k) => !used.has(k));

// Empty strings render as a blank gap, which looks like a bug.
for (const lang of langs)
  for (const [k, v] of Object.entries(STRINGS[lang]))
    if (!String(v).trim()) problems.push(`${lang}."${k}" is empty`);

for (const lang of langs)
  console.log(`  ${lang}: ${Object.keys(STRINGS[lang]).length} strings`);
if (unused.length) console.log(`  not shown anywhere: ${unused.join(", ")}`);

if (problems.length) {
  console.log("\nProblems:");
  for (const p of problems) console.log(`  - ${p}`);
  process.exit(1);
}
console.log("\nCopy is consistent across all languages.");
