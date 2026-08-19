// Validate the install metadata and make stale/missing offline assets fail CI.
// Run from the repository root with: node tests/web/check-pwa.mjs

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = `${dirname(fileURLToPath(import.meta.url))}/../../`;
const WEB = join(ROOT, "web");
const manifest = JSON.parse(readFileSync(join(WEB, "manifest.webmanifest"), "utf8"));
const html = readFileSync(join(WEB, "index.html"), "utf8");
const app = readFileSync(join(WEB, "app.js"), "utf8");
const worker = readFileSync(join(WEB, "sw.js"), "utf8");
const errors = [];

try {
  new Function(worker);
} catch (error) {
  errors.push(`service worker has invalid JavaScript: ${error.message}`);
}

for (const key of ["name", "short_name", "start_url", "scope", "display", "icons"]) {
  if (!manifest[key]) errors.push(`manifest is missing ${key}`);
}
if (manifest.start_url !== "./" || manifest.scope !== "./") {
  errors.push("manifest start_url and scope must remain GitHub Pages subpath-safe");
}
if (!html.includes('rel="manifest" href="manifest.webmanifest"')) {
  errors.push("index.html does not link the web app manifest");
}
if (!app.includes('serviceWorker.register("./sw.js"')) {
  errors.push("app.js does not register the service worker with a relative URL");
}

function pngDimensions(path) {
  const data = readFileSync(path);
  if (data.length < 24 || data.toString("ascii", 1, 4) !== "PNG") return null;
  return [data.readUInt32BE(16), data.readUInt32BE(20)];
}

const declaredSizes = new Set((manifest.icons || []).map((icon) => icon.sizes));
for (const required of ["192x192", "512x512"]) {
  if (!declaredSizes.has(required)) errors.push(`manifest is missing a ${required} icon`);
}

for (const icon of manifest.icons || []) {
  const path = join(WEB, icon.src);
  if (!existsSync(path)) {
    errors.push(`missing manifest icon: ${icon.src}`);
    continue;
  }
  const actual = pngDimensions(path);
  const expected = icon.sizes.split("x").map(Number);
  if (!actual || actual[0] !== expected[0] || actual[1] !== expected[1]) {
    errors.push(`${icon.src} is not a ${icon.sizes} PNG`);
  }
}

const touchIcon = join(WEB, "icons", "icon-180.png");
if (!html.includes('rel="apple-touch-icon" href="icons/icon-180.png"')) {
  errors.push("index.html does not link the Apple touch icon");
} else if (pngDimensions(touchIcon)?.join("x") !== "180x180") {
  errors.push("icons/icon-180.png is not a 180x180 PNG");
}

const shellMatch = worker.match(/const APP_SHELL = (\[[\s\S]*?\n\]);/);
if (!shellMatch) {
  errors.push("could not read APP_SHELL from sw.js");
} else {
  const shell = JSON.parse(shellMatch[1]);
  for (const relative of shell) {
    if (!relative.startsWith("./")) {
      errors.push(`offline asset is not subpath-safe: ${relative}`);
      continue;
    }
    const path = join(WEB, relative.slice(2));
    if (!existsSync(path)) errors.push(`offline asset does not exist: ${relative}`);
  }

  function walk(directory) {
    return readdirSync(directory).flatMap((name) => {
      const path = join(directory, name);
      return statSync(path).isDirectory() ? walk(path) : [path];
    });
  }

  const shouldCache = new Set(
    walk(WEB)
      .filter((path) => /\.(?:html|js|json|png|webmanifest|zip)$/.test(path))
      .filter((path) => normalize(path) !== normalize(join(WEB, "sw.js")))
      .map((path) => `./${normalize(path).slice(normalize(WEB).length + 1).replaceAll("\\", "/")}`)
  );
  for (const asset of shouldCache) {
    if (!shell.includes(asset)) errors.push(`runtime asset is not precached: ${asset}`);
  }
}

if (errors.length) {
  console.error(errors.map((error) => `PWA check: ${error}`).join("\n"));
  process.exit(1);
}

console.log("PWA manifest, icons, registration, and offline asset list are consistent.");
