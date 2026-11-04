// Optional browser regression: basic processing must not depend on advanced controls.
// PLAYWRIGHT_MODULE and PLAYWRIGHT_EXECUTABLE may point at an existing runtime.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {addTexture} from "../../web/src/texture.js";
import {discoverHeic, extractItem, auxUriForItem} from "../../web/src/heif.js";
import {parseBplist} from "../../web/src/bplist.js";

const {chromium} = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = fileURLToPath(new URL("../../web/", import.meta.url));
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  const filename = path.resolve(root, "." + decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname));
  if (!filename.startsWith(root) || !fs.existsSync(filename) || !fs.statSync(filename).isFile()) {
    res.writeHead(404); res.end(); return;
  }
  const mime = {".js": "text/javascript", ".html": "text/html", ".json": "application/json", ".webmanifest": "application/manifest+json"};
  res.writeHead(200, {"Content-Type": mime[path.extname(filename)] || "application/octet-stream", "Cache-Control": "no-store"});
  res.end(fs.readFileSync(filename));
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const sourcePath = "tests/private-fixtures/native-style.heic";
const source = new Uint8Array(fs.readFileSync(sourcePath));
const expected = addTexture(source).data;
let browser;
try {
  browser = await chromium.launch({headless: true, executablePath: process.env.PLAYWRIGHT_EXECUTABLE || undefined});
  const context = await browser.newContext({serviceWorkers: "block", viewport: {width: 1000, height: 900}, locale: "zh-TW"});
  const decoder = "tests/web/.cache/libheif.js";
  await context.route("**/*", route => {
    const url = route.request().url();
    if (url.startsWith(origin)) return route.continue();
    if (url.includes("@mediapipe/tasks-vision@") && url.endsWith("/+esm"))
      return route.fulfill({contentType: "text/javascript", body: `
        export const FilesetResolver = {forVisionTasks: async () => ({})};
        export const FaceLandmarker = {createFromOptions: async () => {
          let calls = 0;
          return {detect: () => {
            globalThis.testFaceDetectCalls = (globalThis.testFaceDetectCalls || 0) + 1;
            return {faceLandmarks: calls++ % 5 ? [] : Array.from({length: globalThis.testFaceCount || 1}, (_, face) =>
              Array.from({length: 478}, (_, i) => ({x: (globalThis.testFaceCount === 2 ? .3 + face * .4 : .5)
                + .1 * Math.cos(i), y: .5 + .15 * Math.sin(i), z: 0})))};
          }};
        }};
        export const ImageSegmenter = {createFromOptions: async () => ({
          getLabels: () => ['background', 'hair', 'body-skin', 'face-skin', 'clothes', 'others'],
          segment: () => {
            globalThis.testSegmentationCalls = (globalThis.testSegmentationCalls || 0) + 1;
            return {confidenceMasks: [.1, .1, .2, .4, .1, .1].map(value => ({width: 4, height: 4,
              getAsFloat32Array: () => new Float32Array(16).fill(value), close() {}}))};
          }
        })};
      `});
    if (/libheif-js@1\.18\.2\/libheif\/libheif\.js$/.test(url) && fs.existsSync(decoder))
      return route.fulfill({contentType: "text/javascript", body: fs.readFileSync(decoder)});
    return route.abort();
  });
  const page = await context.newPage(), errors = [], requests = [];
  page.setDefaultTimeout(20000);
  page.on("pageerror", e => errors.push(e.message));
  page.on("request", req => requests.push(req.url()));
  await page.goto(origin);
  // A fake monotonic clock verifies step reset/freeze and no timer on a summary.
  // This catches cumulative timestamps even when ordinary processing is too fast.
  const appSource = fs.readFileSync(path.join(root, "app.js"), "utf8");
  const rowSource = appSource.slice(appSource.indexOf("function row(name)"), appSource.indexOf("function updateLinearProgress"));
  const times = await page.evaluate(source => {
    let now = 5000, id = 0;
    const timers = new Map(), list = document.createElement("div");
    const createRow = new Function("performance", "setInterval", "clearInterval", "document", "list", "T", `${source}; return row;`)(
      {now: () => now}, fn => {timers.set(++id, fn); return id;}, key => timers.delete(key), document, list, key => key);
    const ui = createRow("timing-fixture");
    ui.set("queued"); now += 1200;
    [...timers.values()].forEach(fn => fn());
    ui.set("reading");
    const reset = list.querySelectorAll(".status-time")[1].textContent;
    now += 250; ui.update("reading progress"); now += 650;
    ui.set("encoding"); now += 2000; ui.set("short mask");
    now += 14; ui.set("submillisecond mask"); now += .4; ui.set("complete", "ok");
    now += 10000;
    return {reset, stamps: [...list.querySelectorAll(".status-time")].map(el => el.textContent), timers: timers.size};
  }, rowSource);
  assert.deepEqual(times, {reset: "0ms", stamps: ["1.200s", "900ms", "2.000s", "14ms", "<1ms", "—"], timers: 0});
  assert.equal(await page.locator("#advanced-options-toggle").count(), 0);
  assert.equal(await page.locator("#quality").isVisible(), true);
  assert.equal(await page.locator("#faces").isVisible(), true);
  assert.equal(await page.locator("#quality").isChecked(), true);
  assert.equal(await page.locator("#faces").isChecked(), true);
  assert.equal(await page.locator("#linear10").count(), 0);
  const encoding = await page.evaluate(async () => {
    if (!globalThis.VideoEncoder) return {supported: false};
    const support = await VideoEncoder.isConfigSupported({codec: 'hvc1.1.6.L120.B0', width: 32, height: 32,
      framerate: 1, bitrate: 4_000_000, hardwareAcceleration: 'no-preference', latencyMode: 'quality', hevc: {format: 'hevc'}});
    if (!support.supported) return {supported: false};
    const {encodeSelectedLinearThumbnail} = await import('./src/linear-thumbnail.js?v=0.6.0-web');
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 32;
    const ctx = canvas.getContext('2d', {colorSpace: 'display-p3'}); ctx.fillStyle = '#789abc'; ctx.fillRect(0, 0, 32, 32);
    const output = await encodeSelectedLinearThumbnail(canvas);
    return {supported: true, bitDepth: output.bitDepth, mode: output.mode};
  });
  if (encoding.supported) {assert.equal(encoding.bitDepth, 8); assert.equal(encoding.mode, 'webcodecs-main8-p3-linear');}
  console.log(encoding.supported ? 'Browser native 8-bit HEVC linear encoding passed.' : 'This browser exposes no 8-bit HEVC encoder; native encoding requires another supported browser.');
  await page.locator("#quality").uncheck();
  await page.locator("#faces").uncheck();
  await page.locator("#file").setInputFiles(sourcePath);
  const card = page.locator("#list > .row").first();
  assert.equal(await page.locator(".process-photo").count(), 0);
  assert.equal(await page.locator("#preview").count(), 0);
  await card.locator(".source-thumbnail").waitFor();
  assert.equal(await card.locator(".photo-editor").count(), 0);
  assert.equal(requests.some(url => url.includes("/photo-editor.js")), false);
  assert.equal(await card.locator(":scope > .advanced-content").count(), 0);
  assert.equal(await card.locator(".advanced-toggle").count(), 0);
  const downloadBytes = async link => {
    const url = await link.getAttribute("href");
    return new Uint8Array(await page.evaluate(async href => [...new Uint8Array(await (await fetch(href)).arrayBuffer())], url));
  };
  const artifacts = path.resolve("tests/web/.cache/basic-ui"); fs.mkdirSync(artifacts, {recursive: true});
  await page.setViewportSize({width: 390, height: 844});
  assert.ok(await page.locator(".portrait-hint").evaluate(hint =>
    hint.getBoundingClientRect().top - document.querySelector('label[for="faces"]').getBoundingClientRect().bottom >= 15));
  await page.screenshot({path: path.join(artifacts, "basic-mobile.png")});
  await page.setViewportSize({width: 1000, height: 900});
  const first = card.locator('a[download$="_TextureGrain.HEIC"]').first();
  await first.waitFor();
  assert.deepEqual(await downloadBytes(first), expected, "basic output matches the original native Texture path");
  assert.equal(await card.locator(".photo-editor").count(), 0, "processing must not construct advanced editors");
  assert.equal(requests.some(url => /ffmpeg-core\.wasm|wasm-hevc-worker/.test(url)), false);
  const result = card;
  assert.equal(await result.locator(":scope > .row").count(), 0, "each input owns exactly one result card");
  assert.equal(await result.getByRole("button", {name: "检视并存储到「照片」", exact: true}).count(), 0);
  const outputImage = result.locator(".result-thumbnail img");
  const outputUrl = await outputImage.getAttribute("src");
  const downloadUrl = await first.getAttribute("href");
  assert.equal(await page.evaluate(async ([a,b]) => {
    const [image,download] = await Promise.all([fetch(a).then(r=>r.blob()),fetch(b).then(r=>r.blob())]);
    return image.type==='image/heic' && image.size===download.size;
  }, [outputUrl,downloadUrl]), true, "the long-press image must use the actual output HEIC");
  if (fs.existsSync(decoder)) {
    await result.locator(".source-thumbnail canvas").waitFor();
    await result.locator(".result-thumbnail canvas").waitFor();
  }
  assert.equal(await result.locator(":scope > .advanced-content").count(), 0);
  assert.equal(await result.locator(":scope > .act .advanced-toggle").count(), 0);
  assert.equal(await result.locator(".orientation-diagnostics").count(), 0);
  assert.equal(await result.locator(".lightmap-viewer").count(), 0);
  await page.setViewportSize({width: 390, height: 844});
  await result.screenshot({path: path.join(artifacts, "result-mobile.png")});
  await page.setViewportSize({width: 1000, height: 900});
  const comparisonButton = result.locator(":scope > .act").getByRole("button", {name: "对照全部内嵌资料", exact: true});
  assert.equal(await result.locator(":scope > .act > :first-child").textContent(), "对照全部内嵌资料");
  assert.equal(await comparisonButton.isVisible(), true);
  await comparisonButton.click();
  await page.locator("#compare-grid .inspection-head").first().waitFor();
  const hairLabel = page.locator("#compare-grid .inspection-name").filter({hasText: "头发遮罩"});
  assert.equal(await hairLabel.count(), 1);
  assert.equal(await hairLabel.locator("code").textContent(), "semantichairmatte");
  await page.screenshot({path: path.join(artifacts, "comparison-labels.png")});
  assert.equal(await page.locator(".source-image-comparison").count(), 0);
  assert.equal(requests.some(url => /source-image-compare|linear-preview/.test(url)), false);
  assert.equal(await page.getByRole("button", {name: "比對主圖與線性縮略圖", exact: true}).count(), 0);
  assert.equal(await result.locator(":scope > .advanced-content").count(), 0);
  assert.equal(await result.locator(":scope > .act .advanced-toggle").count(), 0);
  await page.locator("#compare-close").click();
  // A readable PNG can fail HEVC encoding; its source image must remain visible.
  // The next queued native HEIC must still finish without a manual process button.
  const png = Buffer.from(await page.evaluate(() => {
    globalThis.VideoEncoder = undefined;
    const canvas = document.createElement("canvas"); canvas.width = 48; canvas.height = 32;
    canvas.getContext("2d").fillRect(0,0,48,32);
    return canvas.toDataURL("image/png").split(",")[1];
  }), "base64");
  await page.locator("#file").setInputFiles([
    {name: "cannot-encode.png", mimeType: "image/png", buffer: png},
    {name: "next-photo.HEIC", mimeType: "image/heic", buffer: Buffer.from(source)},
  ]);
  const failed = page.locator("#list > .row").nth(1), next = page.locator("#list > .row").nth(2);
  await failed.locator(".status-line.err").waitFor();
  const failedImage = failed.locator(".source-thumbnail img");
  assert.equal(await failedImage.isVisible(), true);
  assert.equal(await failedImage.evaluate(img => img.complete && img.naturalWidth===48), true);
  assert.equal(await failed.locator(".result-thumbnail").count(), 0);
  await next.locator('a[download$="_TextureGrain.HEIC"]').waitFor();
  assert.equal(await page.locator("#list > .row").count(), 3);
  assert.equal(await page.locator(".process-photo").count(), 0);
  await page.setViewportSize({width: 390, height: 844});
  await failed.screenshot({path: path.join(artifacts, "failed-source-mobile.png")});
  // All global and per-photo controls fit a small phone screen.
  for (const width of [390, 320]) {
    await page.setViewportSize({width, height: 844});
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${width}px page must fit`);
  }
  assert.equal(await card.locator(":scope > .row > .advanced-content").count(), 0);
  assert.equal(await card.locator(":scope > .row > .act .advanced-toggle").count(), 0);
  assert.equal(await page.locator(".orientation-diagnostics").count(), 0);
  assert.deepEqual(errors, []);
  // Exercise actual mask construction/progress with synthetic inference and an
  // encoder stub: the host Edge has no HEVC encoder or offline vision models.
  const maskProgress = await page.evaluate(async () => {
    const savedEncoder = globalThis.VideoEncoder, savedFrame = globalThis.VideoFrame;
    let ticks = 0, encodes = 0;
    const clock = setInterval(() => ticks++, 0), events = [];
    globalThis.VideoFrame = class {close() {}};
    globalThis.VideoEncoder = class {
      static async isConfigSupported(config) {return {supported: true, config};}
      constructor({output}) {this.output = output;}
      configure() {}
      encode() {encodes++; this.output({byteLength: 4, copyTo: out => out.set([0,0,0,7])},
        {decoderConfig: {description: new Uint8Array([1,2,3])}});}
      async flush() {}
      close() {}
    };
    try {
      const {generateRasterFaceMattes} = await import('./src/face-mattes.js?v=0.6.0-web');
      const image = document.createElement('canvas'); image.width = image.height = 64;
      image.getContext('2d').fillRect(0,0,64,64);
      const result = await generateRasterFaceMattes(image, 0, null, {onProgress: p => events.push(p)});
      return {state: result.state, events, ticks, encodes, segmentations: globalThis.testSegmentationCalls};
    } finally {
      clearInterval(clock); globalThis.VideoEncoder = savedEncoder; globalThis.VideoFrame = savedFrame;
    }
  });
  assert.equal(maskProgress.state, "generated");
  assert.equal(maskProgress.segmentations, 1, "all masks share one inference");
  const generatedNames = maskProgress.events.filter(p => p.stage === "matte").map(p => p.matte);
  assert.equal(generatedNames.length, 12, "Portrait/person share one encode, plus eleven separate semantic mattes");
  assert.equal(maskProgress.encodes, 12);
  assert.ok(generatedNames.includes("semanticskinmattev2"));
  assert.ok(generatedNames.includes("semanticfaceskinmatte"));
  assert.ok(generatedNames.includes("semanticnonfaceskinmatte"));
  assert.ok(maskProgress.ticks >= generatedNames.length, "the browser gets scheduling opportunities between masks");
  assert.deepEqual(maskProgress.events.slice(0,4).map(p=>p.stage), ["decode", "models", "detect", "segment"]);
  assert.equal(maskProgress.events.at(-1).stage, "metadata");
  // Complete correction workflow on real native HEIF bytes, with synthetic faces
  // and a checksum encoder. Assertions inspect the actual regenerated file.
  await page.evaluate(() => {
    globalThis.testFaceCount = 2;
    globalThis.VideoFrame = class {constructor(source) {this.source = source;} close() {}};
    globalThis.VideoEncoder = class {
      static async isConfigSupported(config) {return {supported: true, config};}
      constructor({output}) {this.output = output;}
      configure() {}
      encode(frame) {
        if (globalThis.testFailFaceEncoding) throw Error("test encoder failure");
        const pixels = frame.source.getContext('2d').getImageData(0,0,frame.source.width,frame.source.height).data;
        let sum = 0; for (const pixel of pixels) sum = (sum + pixel) >>> 0;
        const bytes = new Uint8Array([sum >>> 24, sum >>> 16 & 255, sum >>> 8 & 255, sum & 255]);
        this.output({byteLength: 4, copyTo: out => out.set(bytes)},
          {decoderConfig: {description: new Uint8Array([1,2,3])}});
      }
      async flush() {}
      close() {}
    };
    Object.defineProperty(navigator, "canShare", {configurable: true, value: () => true});
    Object.defineProperty(navigator, "share", {configurable: true, value: async ({files}) => {
      globalThis.testSharedBytes = [...new Uint8Array(await files[0].arrayBuffer())];
    }});
  });
  await page.locator("#faces").check();
  await page.locator("#file").setInputFiles({name: "face-review.HEIC", mimeType: "image/heic", buffer: Buffer.from(source)});
  const reviewed = page.locator("#list > .row").nth(3), editor = page.locator("#face-preview");
  await reviewed.locator(".face-correct").waitFor();
  assert.equal(await reviewed.locator(".face-summary").textContent(), "本次识别到 2 张人脸");
  const originalResult = await downloadBytes(reviewed.locator("a[download]"));
  const faceData = bytes => {
    const d = discoverHeic(bytes);
    const texture = [...d.infos].find(([, info]) => info.uri?.endsWith(":texture_styles"))[0];
    const people = parseBplist(extractItem(bytes, d.iloc, texture)).get("TextureStylePostProcessedPeopleData") || [];
    const items = [...d.infos.keys()].filter(id => auxUriForItem(d.props, id)?.endsWith(":semanticpersoninstances"));
    const nose = [...d.infos.keys()].find(id => auxUriForItem(d.props, id)?.endsWith(":semanticnosematte"));
    return {d, people, instances: items.length, nose: extractItem(bytes, d.iloc, nose)};
  };
  assert.equal(faceData(originalResult).people.length, 2);
  assert.equal(faceData(originalResult).instances, 2);
  const calls = await page.evaluate(() => [testFaceDetectCalls, testSegmentationCalls]);
  const openReview = async () => {await reviewed.locator(".face-correct").click(); await editor.waitFor({state: "visible"});};
  const applyReview = async () => {
    await page.locator("#face-apply").click(); await editor.waitFor({state: "hidden"});
    await page.waitForFunction(() => document.querySelectorAll('#list > .row')[3].getAttribute('aria-busy') === 'false');
  };
  await page.setViewportSize({width: 390, height: 844});
  await openReview();
  assert.equal(await page.locator("#face-apply").isDisabled(), true);
  await editor.locator('.face-choice[data-face-id="1"]').click();
  assert.equal(await editor.locator('.face-box[data-face-id="1"]').getAttribute("data-excluded"), "true");
  await page.locator("#face-cancel").click();
  assert.deepEqual(await downloadBytes(reviewed.locator("a[download]")), originalResult, "cancel leaves original output");
  await openReview();
  assert.equal(await editor.locator('.face-choice[data-face-id="1"]').getAttribute("data-excluded"), "false");
  await editor.locator('.face-box[data-face-id="1"]').click();
  for (const width of [320, 390]) {
    await page.setViewportSize({width, height: 844});
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await page.locator("#face-apply").isVisible(), true);
    await page.screenshot({path: path.join(artifacts, `face-review-${width}.png`)});
  }
  await page.locator("#face-zoom-in").click();
  assert.equal(await page.locator("#face-zoom-value").textContent(), "150%");
  await page.locator("#face-zoom-out").click();
  const previousUrl = await reviewed.locator('a[download]').getAttribute("href");
  await applyReview();
  const corrected = await downloadBytes(reviewed.locator("a[download]")), correctedData = faceData(corrected);
  assert.equal(correctedData.people.length, 1);
  assert.equal(correctedData.instances, 1);
  assert.notDeepEqual(correctedData.nose, faceData(originalResult).nose, "exclusion changes the actual facial matte payload");
  const src = discoverHeic(source);
  for (const id of src.primaryTiles)
    assert.deepEqual(extractItem(corrected, correctedData.d.iloc, id), extractItem(source, src.iloc, id), "main HEVC tiles are unchanged");
  assert.equal(await page.locator("#list > .row").count(), 4, "correction updates the existing card");
  assert.equal(await reviewed.locator(".result-thumbnail").count(), 1);
  assert.equal(await reviewed.locator(".source-thumbnail").count(), 1);
  assert.equal(await reviewed.locator(":scope > .act > :first-child").textContent(), "对照全部内嵌资料");
  assert.equal(await reviewed.locator(".face-summary").textContent(), "已校正人脸 · 保留 1 张 · 排除 1 张");
  const correctedUrl = await reviewed.locator('a[download]').getAttribute("href");
  assert.equal(await reviewed.locator(".result-thumbnail img").getAttribute("src"), correctedUrl);
  assert.notEqual(correctedUrl, previousUrl);
  await reviewed.getByRole("button", {name: "存储到「照片」", exact: true}).click();
  await page.waitForFunction(() => globalThis.testSharedBytes !== undefined);
  assert.deepEqual(new Uint8Array(await page.evaluate(() => testSharedBytes)), corrected, "share uses corrected file");
  await reviewed.getByRole("button", {name: "对照全部内嵌资料", exact: true}).click();
  await page.locator("#compare-grid .inspection-name").filter({hasText: "质感人物数据"}).waitFor();
  const embeddedPeople = page.locator("#compare-grid .inspection-name").filter({hasText: "质感人物数据"});
  assert.equal(await embeddedPeople.locator("xpath=following-sibling::*[2]").locator("pre").evaluate(el => JSON.parse(el.textContent).length), 1);
  await page.locator("#compare-close").click();
  await openReview();
  assert.equal(await editor.locator('.face-choice[data-face-id="1"]').getAttribute("data-excluded"), "true");
  await editor.locator('.face-choice[data-face-id="0"]').click();
  await applyReview();
  const emptyResult = await downloadBytes(reviewed.locator("a[download]"));
  assert.equal(faceData(emptyResult).people.length, 0);
  assert.equal(faceData(emptyResult).instances, 0);
  // A failed correction must preserve the file and last committed selection.
  await openReview(); await editor.locator('.face-choice[data-face-id="0"]').click();
  await page.evaluate(() => {globalThis.testFailFaceEncoding = true;});
  await applyReview();
  assert.deepEqual(await downloadBytes(reviewed.locator("a[download]")), emptyResult);
  await openReview();
  assert.equal(await editor.locator('.face-choice[data-face-id="0"]').getAttribute("data-excluded"), "true");
  await page.evaluate(() => {globalThis.testFailFaceEncoding = false;});
  await editor.locator('.face-choice[data-face-id="0"]').click();
  await editor.locator('.face-choice[data-face-id="1"]').click();
  await applyReview();
  assert.deepEqual(await downloadBytes(reviewed.locator("a[download]")), originalResult, "restoring all faces restores exact original bytes");
  assert.deepEqual(await page.evaluate(() => [testFaceDetectCalls, testSegmentationCalls]), calls, "correction never repeats inference");
  // Exercise the entire JPEG -> raster import -> face pipeline -> UI, rather than
  // calling the mask generator directly. The stub covers canvas and I420 frames;
  // its Main8 fixture permits real linear-SPS validation without a host encoder.
  const jpeg = Buffer.from(await page.evaluate(() => {
    const description = Uint8Array.from(atob('AQFgAAAAkAAAAAAA//AA/P34+AAADwOgAAEAGEABDAH//wFgAAADAJAAAAMAAAMA/5WUCaEAAQArQgEBAWAAAAMAkAAAAwAAAwD/oEIIWWVlSkwuagICAggAAAMACAAAAwAIQKIAAQAGRAHAcYkS'), c => c.charCodeAt(0));
    globalThis.VideoFrame = class {constructor(source) {this.source = source;} close() {}};
    globalThis.VideoEncoder = class {
      static async isConfigSupported(config) {return {supported: true, config};}
      constructor({output}) {this.output = output;}
      configure() {}
      encode(frame) {
        const pixels = frame.source instanceof Uint8Array ? frame.source
          : frame.source.getContext('2d').getImageData(0,0,frame.source.width,frame.source.height).data;
        let sum = 0; for (const pixel of pixels) sum = (sum + pixel) >>> 0;
        const bytes = new Uint8Array([0,0,0,3,0x26,1,sum & 255]);
        this.output({byteLength: bytes.length, copyTo: out => out.set(bytes)},
          {decoderConfig: {description, colorSpace: {primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false}}});
      }
      async flush() {}
      close() {}
    };
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#987654'; ctx.fillRect(0,0,64,64);
    return canvas.toDataURL('image/jpeg').split(',')[1];
  }), 'base64');
  await page.locator('#file').setInputFiles({name: 'raster-progress.jpeg', mimeType: 'image/jpeg', buffer: jpeg});
  const raster = page.locator('#list > .row').nth(4);
  await raster.locator('a[download]').waitFor();
  assert.equal(faceData(await downloadBytes(raster.locator('a[download]'))).people.length, 2);
  const rasterProgress = await raster.locator('.status-label').allTextContents();
  assert.ok(rasterProgress.includes('正在识别人脸与特征点…'));
  assert.ok(rasterProgress.includes('正在运行共用多类别分割并整理置信度遮罩…'));
  for (const name of ['人物／人像效果遮罩', '鼻部遮罩', '皮肤遮罩（v2）', '身体皮肤遮罩',
    '嘴唇遮罩', '牙齿遮罩（v2）', '眼镜遮罩（v2）', '眉毛遮罩', '手部遮罩', '耳朵遮罩', '脸部皮肤遮罩'])
    assert.ok(rasterProgress.includes(`正在生成并编码${name}…`), `JPEG progress includes ${name}`);
  assert.ok(rasterProgress.includes('正在生成并编码空的纹身遮罩…'));
  assert.ok(rasterProgress.includes('正在生成并编码人物实例遮罩… (1/2)'));
  assert.ok(rasterProgress.includes('正在生成并编码人物实例遮罩… (2/2)'));
  assert.equal(rasterProgress.some(text => /semantic|portraiteffects/.test(text)), false, 'progress contains only translated mask names');
  const buildTag = appSource.match(/face-mattes\.js\?v=([^"']+)/)[1];
  for (const request of requests.filter(url => url.startsWith(origin) && /\.js\?v=/.test(url)))
    assert.equal(new URL(request).searchParams.get('v'), buildTag, 'all local dependencies use the current build, including raster face masks');
  assert.match(await page.locator('[data-i18n="app.lede"]').textContent(), /任何手机或相机.*截屏/);
  await page.setViewportSize({width: 390, height: 844});
  await raster.screenshot({path: path.join(artifacts, 'raster-progress-mobile.png')});
  assert.deepEqual(errors, []);
  console.log("Browser: automatic processing preserves output bytes, original thumbnails survive failures, output image uses HEIC, queue continues after errors, comparison and mobile layout passed.");
  console.log("Step durations, localized item labels, first comparison action and separate mask progress/yields passed.");
  console.log("Face correction: cancel, box/crop selection, zoom, same-card update, real metadata/mask changes, stable main pixels, share/inspection, all excluded, failure recovery and exact restore passed.");
  console.log("Full JPEG workflow: every generated mask reaches localized UI progress, embedded identifiers remain in comparison, all local dependency versions match and broader photo/screenshot support is documented.");
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
}
