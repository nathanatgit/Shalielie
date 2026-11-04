// All localized page copy, in both languages, lives here.
//
// EDITING
//   Change the text to the right of a key. Keys are shared between en and zh, so
//   whatever you add to one you must add to the other, and whatever you rename
//   you must rename in index.html too.
//   Run `node tests/web/check-i18n.mjs` afterwards; it catches exactly those two
//   mistakes. Preview with `python -m http.server -d web 8000`, then reload.
//
//   A few tags are allowed inside a string — <b>, <br>, <code>, <a> — because the
//   values are inserted as HTML. Do not paste anything untrusted in here.
//
// STYLE
//   Chinese follows Apple's zh-Hans terms: 摄影风格, 调色板, 质感, 颗粒, 人像, “照片”App,
//   存储到“文件”, 存储图像, 点按. Use “” quotes, not 「」. Troubleshooting entries quote
//   the err.* messages, so keep the two in step when editing either.
//   Bold (<b>) marks only what the reader taps or looks for while following an
//   instruction (buttons, menu items, statuses) and the title of each
//   troubleshooting entry. Notices and the output section stay plain.
//
// WHERE EACH KEY APPEARS (top of the page to the bottom)
//   lang.name    the switch button; it names the language you switch TO
//   about.*      the README link next to it; .href is the README page in that language,
//                rendered at deploy by tools/render-about.mjs
//   meta.title   browser tab and the big heading
//   app.tagline  the line under the heading
//   h.notice n.* "Before you start": the notices, shown first
//   app.lede     the short description above the drop area
//   drop.*       the drop area: the action only, no instructions
//   tip.*        the Photo Library tip under the drop area
//   opt.quality  the analysis switch
//   more         shown instead of the tip and switch once there are results; unfolds them
//   st.*         status text on a finished row
//   err.*        failures a visitor can see
//   btn.*        buttons on a finished row
//   h.steps s.*  how to use it, as numbered steps
//   h.get g.*    about the output
//   h.trouble t.* troubleshooting
//   p.version    the footer

export const STRINGS = {
  en: {
    "lang.name": "中文",
    "about.name": "About this page",
    "about.href": "about.html",
    "meta.title": "Palettify",
    "app.tagline": "The Photographic Styles palette for photos from older iPhones",

    "h.notice": "Before you start",
    "n.1": "Experimental, unofficial software, not affiliated with Apple.",
    "n.2": "An Apple HEIC holds only the still image. Keep your original photos.",
    "n.3": "This page runs entirely in your browser: photos are processed on this device and "
      + "never uploaded.",
    "app.lede": "Adds the Photographic Styles palette, introduced with iPhone 16, to HEIC "
      + "photos from earlier iPhones, plus the Texture and Grain controls on iOS 27.",
    "drop.big": "Choose HEIC photos, or drop them here",
    "drop.small": "Original HEIC photos from iPhone · processed on this device",
    "tip.title": "Choosing from Photo Library",
    "tip.body": "On iOS versions that support it, select your photos, then tap <b>•••</b> in the "
      + "bottom-left corner → <b>Options</b> → <b>Format</b> → <b>Current</b>. This sends the "
      + "original HEIC instead of a converted JPEG. If a photo is still rejected, choose "
      + "<b>Browse</b> and pick it from Files.",
    "more": "Tips and options",


    "opt.quality": "Analyze each photo",
    "opt.qualityNote": "Makes the style data match the photo’s own tones. Downloads a small image decoder on "
      + "first use. Can be slow on iPhone; turn it off if the page freezes.",
    "opt.anyimage": "Any Image (experimental)",
    "opt.anyimageNote": "Also styles JPEG, PNG and WebP pictures, and HEIC photos from other phones. They are "
      + "converted to an iPhone-shaped HEIC in your browser first, which needs a browser that can encode "
      + "HEVC (Chrome or Edge on a computer, or Safari).",
    "opt.faces": "Find Faces (experimental)",
    "opt.facesNote": "Needs Any Image. Finds faces and people on this device so Soft Skin has data to work "
      + "with. Downloads about 20 MB of models from this site on first use. The estimate is not the "
      + "camera’s own data.",

    "sum.working": "Styling {n} of {total}…",
    "sum.one": "1 photo ready",
    "sum.many": "{n} photos ready",
    "sum.partial": "{n} of {total} photos ready",
    "sum.note": "Saved as new files; your originals are unchanged. Nothing is uploaded.",

    "st.reading": "Reading…",
    "st.converting": "Converting to HEIC…",
    "st.findfaces": "Finding faces…",
    "st.converted": "converted to HEIC, experimental",
    "st.faces": "Soft Skin for the faces found",
    "st.nofaces": "no face found, Soft Skin left out",
    "err.noencoder": "This browser can’t encode HEVC, which Any Image needs. Try Chrome or Edge on a computer, or Safari.",
    "err.badimage": "This picture couldn’t be read.",
    "st.working": "Processing…",
    "st.ready": "Ready",
    "st.matched": "matched to this photo’s tones",
    "st.neutral": "default tone settings",
    "st.portrait": "Portrait data kept",
    "st.people": "people data kept",
    "st.texture": "Texture and Grain added",
    "st.native": "original Photographic Style kept",
    "err.notheic": "Not a HEIC photo. iOS may have converted it; see Troubleshooting.",
    "err.unsupported": "This HEIC isn’t supported yet.",
    "err.hastexture": "This photo already has Texture and Grain. Nothing to do.",
    "err.nothumb": "No embedded thumbnail, which the browser can’t create. Use the "
      + '<a href="https://github.com/nathanatgit/Shalielie/releases/latest" target="_blank" rel="noopener">command-line tool</a> on a Windows PC or Mac for this photo.',

    "btn.save": "Save to Photos",
    "btn.download": "Download",
    "btn.blocked": "Couldn’t open sharing",

    "h.steps": "How to use",
    "s.1": "Choose your photos above, as described in the Photo Library tip. On a computer, "
      + "drop the files in.",
    "s.2": "Wait until each photo shows <b>Ready</b>; this takes a few seconds.",
    "s.3": "On iPhone, tap <b>Save to Photos</b>, then <b>Save Image</b>. On a computer, "
      + "download the result and send it to your iPhone as a file, with AirDrop or iCloud Drive.",
    "s.4": "Open the copy in Photos and tap <b>Edit</b>. The Photographic Styles palette "
      + "appears, and on iOS 27 also <b>Texture</b> and <b>Grain</b>.",

    "h.get": "About the output",
    "g.1": "When you edit the processed photo in Photos, the Photographic Styles palette "
      + "and Texture controls are available: adjust the style, tone and colour, save, and "
      + "edit again later.",
    "g.2": "Texture and Grain are available only on iOS 27.",
    "g.3": "Portrait and people data (depth, people masks) comes from the original "
      + "photo’s own data; this tool never computes it. Even if the original shows people, a "
      + "photo without Portrait depth data (you can tell: editing it shows no Portrait depth "
      + "control) won’t have it after processing either.",
    "g.4": "The tool is at the functionality stage: the look of styles and the detail of "
      + "Texture and Grain differ from a native photo, which is expected. Fine-tuning comes later.",
    "g.5": "Soft Skin works when the original carries Apple’s own people data (face regions, "
      + "skin and Portrait masks), as Portrait-mode photos and iPhone 16+ photos of people do. "
      + "Faces are never detected, so other photos keep a Soft Skin that looks like Standard.",
    "g.6": "The output HEIC does not include the Live Photo’s MOV video. To keep the "
      + "motion, on a computer (PC or Mac) copy the original’s matching MOV and rename it to the "
      + "new HEIC’s file name.",

    "h.trouble": "Troubleshooting",
    "t.1": "<b>“Not a HEIC photo”</b>: iOS converted the photo to JPEG while you picked it. "
      + "Use the Photo Library tip above, or in Photos tap <b>Share → Save to Files</b> and "
      + "choose it with <b>Browse</b>.",
    "t.2": "<b>“No embedded thumbnail”</b>: common for copies re-saved by iOS. Use the "
      + '<a href="https://github.com/nathanatgit/Shalielie/releases/latest" target="_blank" rel="noopener">command-line tool</a>, which can create the thumbnail. It runs on a Windows PC '
      + "or Mac, not on iPhone.",
    "t.3": "<b>“This HEIC isn’t supported yet”</b>: screenshots, copies edited or exported by "
      + "other apps, and photo layouts the tool does not support yet.",
    "t.4": "<b>The page freezes or reloads</b>: turn off the analysis switch above and try "
      + "again.",

    "p.version": "Version",
  },

  zh: {
    "lang.name": "English",
    "about.name": "关于此页面",
    "about.href": "about.zh.html",
    "meta.title": "盘它",
    "app.tagline": "让旧款 iPhone 拍摄的照片也能使用摄影风格调色板",

    "h.notice": "注意事项",
    "n.1": "实验性非官方工具，与 Apple 无关。",
    "n.2": "Apple 的 HEIC 文件只包含静态图像，请保留原图。",
    "n.3": "网页版为纯前端，照片处理在本设备上完成，照片不会上传。",
    "app.lede": "为 iPhone 16 之前机型拍摄的 HEIC 照片加上 iPhone 16 引入的摄影风格调色板，"
      + "并在 iOS 27 上加上质感与颗粒控制。",
    "drop.big": "选取 HEIC 照片，或拖放到此处",
    "drop.small": "iPhone 拍摄的 HEIC 原图 · 在本设备上处理",
    "tip.title": "从“照片图库”选取时",
    "tip.body": "在支持的 iOS 版本中，勾选照片后点按左下角的 <b>•••</b> → <b>选项</b> → "
      + "<b>格式</b> → <b>当前</b>，即可上传 HEIC 原图，而不是转换后的 JPEG。若仍被拒绝，"
      + "请改选<b>浏览</b>，从“文件”中选取。",
    "more": "提示和选项",


    "opt.quality": "分析每张照片",
    "opt.qualityNote": "使风格数据与照片自身的影调相匹配。首次使用时会下载一个小型图像解码组件。"
      + "在 iPhone 上可能较慢；若页面卡住，请关闭此项。",
    "opt.anyimage": "任意图片（实验性）",
    "opt.anyimageNote": "也处理 JPEG、PNG、WebP 图片，以及其他手机拍摄的 HEIC 照片。它们会先在浏览器中转换为 "
      + "iPhone 样式的 HEIC，需要支持 HEVC 编码的浏览器（电脑上的 Chrome 或 Edge，或 Safari）。",
    "opt.faces": "识别人脸（实验性）",
    "opt.facesNote": "需开启任意图片。在本机识别人脸和人物，让“柔肤”有数据可用。首次使用会从本站下载约 20 MB 的模型。"
      + "估算结果并非相机自身的数据。",

    "sum.working": "正在处理第 {n} 张，共 {total} 张…",
    "sum.one": "1 张照片已就绪",
    "sum.many": "{n} 张照片已就绪",
    "sum.partial": "{n}/{total} 张照片已就绪",
    "sum.note": "结果为新文件，原照片不会改动。不会上传任何内容。",

    "st.reading": "读取中…",
    "st.converting": "正在转换为 HEIC…",
    "st.findfaces": "正在识别人脸…",
    "st.converted": "已转换为 HEIC（实验性）",
    "st.faces": "已为识别到的人脸添加柔肤",
    "st.nofaces": "未识别到人脸，未添加柔肤",
    "err.noencoder": "此浏览器无法进行 HEVC 编码，而“任意图片”需要它。请在电脑上使用 Chrome 或 Edge，或使用 Safari。",
    "err.badimage": "无法读取这张图片。",
    "st.working": "处理中…",
    "st.ready": "已完成",
    "st.matched": "已匹配照片影调",
    "st.neutral": "已使用默认影调设置",
    "st.portrait": "已保留人像数据",
    "st.people": "已保留人物数据",
    "st.texture": "已添加质感与颗粒",
    "st.native": "已保留原有摄影风格",
    "err.notheic": "不是 HEIC 照片。可能已被 iOS 转换，请参阅“遇到问题”。",
    "err.unsupported": "暂不支持此 HEIC 文件。",
    "err.hastexture": "此照片已带有质感与颗粒，无需处理。",
    "err.nothumb": "没有内嵌缩略图，网页版无法生成。请在 Windows 电脑或 Mac 上改用"
      + '<a href="https://github.com/nathanatgit/Shalielie/releases/latest" target="_blank" rel="noopener">命令行工具</a>处理这张照片。',

    "btn.save": "存储到“照片”",
    "btn.download": "下载",
    "btn.blocked": "无法打开共享菜单",

    "h.steps": "使用步骤",
    "s.1": "按上方“照片图库”提示选取照片；在电脑上直接拖入文件即可。",
    "s.2": "等待每张照片显示<b>已完成</b>，通常只需几秒。",
    "s.3": "在 iPhone 上点按<b>存储到“照片”</b>，再点按<b>存储图像</b>；在电脑上下载结果，"
      + "再通过隔空投送或 iCloud 云盘以文件形式传到 iPhone。",
    "s.4": "在“照片”App 中打开副本并点按<b>编辑</b>，即可看到摄影风格调色板；"
      + "在 iOS 27 上还会出现<b>质感</b>与<b>颗粒</b>。",

    "h.get": "输出结果说明",
    "g.1": "处理后的照片在“照片”App 中编辑时可启用摄影风格调色板与质感调节，"
      + "支持风格、影调和色彩调整，存储后可再次编辑。",
    "g.2": "质感与颗粒调节仅在 iOS 27 上可用。",
    "g.3": "人像与人物数据（深度、人物遮罩）来自原图的原始数据，本工具不会凭空计算。"
      + "原图即使拍到了人物，如果没有人像景深数据（判断方法：编辑原图时看不到人像景深控制），"
      + "处理后也不会有。",
    "g.4": "当前处于可用性验证阶段：风格效果以及质感/颗粒的细节与原生照片存在差异，"
      + "属于预期情况，微调会在之后进行。",
    "g.5": "原图本身带有 Apple 的人物数据（人脸区域、皮肤遮罩和人像遮罩）时，“柔肤”可以生效，"
      + "人像模式照片和 iPhone 16 及以后机型拍的人物照片都有这些数据。本工具不会自行检测人脸，"
      + "其他照片的“柔肤”仍与“标准”看起来一样。",
    "g.6": "生成的 HEIC 不包含实况照片对应的 MOV 视频。若要保留动态画面，需在电脑（PC 或 Mac）"
      + "上将原文件对应的 MOV 手动复制一份，并重命名为与新 HEIC 相同的文件名。",

    "h.trouble": "遇到问题",
    "t.1": "<b>“不是 HEIC 照片”</b>：选取时 iOS 把照片转换成了 JPEG。请按上方“照片图库”提示操作，"
      + "或在“照片”App 中点按<b>共享 → 存储到“文件”</b>，再通过<b>浏览</b>选取。",
    "t.2": "<b>“没有内嵌缩略图”</b>：常见于经 iOS 重新存储的副本。请改用"
      + '<a href="https://github.com/nathanatgit/Shalielie/releases/latest" target="_blank" rel="noopener">命令行工具</a>，它可以生成缩略图。命令行工具需要在 Windows 电脑或 Mac 上运行，'
      + "无法在 iPhone 上使用。",
    "t.3": "<b>“暂不支持此 HEIC 文件”</b>：截屏、经其他 App 编辑或导出的副本，以及暂不支持的照片布局。",
    "t.4": "<b>页面卡住或自动刷新</b>：关闭上方的分析开关后重试。",

    "p.version": "版本",
  },
};

const STORE_KEY = "psport.lang";

export function pickLanguage() {
  const saved = (() => { try { return localStorage.getItem(STORE_KEY); } catch { return null; } })();
  if (saved && STRINGS[saved]) return saved;
  const nav = (navigator.languages || [navigator.language || "en"]).join(",").toLowerCase();
  return /\bzh\b|zh-/.test(nav) ? "zh" : "en";
}

export function rememberLanguage(lang) {
  try { localStorage.setItem(STORE_KEY, lang); } catch { /* private mode */ }
}

export function t(lang, key) {
  return (STRINGS[lang] && STRINGS[lang][key]) ?? STRINGS.en[key] ?? key;
}

/** Fill every [data-i18n] element and set the document language. */
export function applyLanguage(lang) {
  document.documentElement.lang = lang === "zh" ? "zh-Hans" : "en";
  document.title = t(lang, "meta.title");
  for (const el of document.querySelectorAll("[data-i18n]"))
    el.innerHTML = t(lang, el.dataset.i18n);
  for (const el of document.querySelectorAll("[data-i18n-href]"))
    el.href = t(lang, el.dataset.i18nHref);
}
