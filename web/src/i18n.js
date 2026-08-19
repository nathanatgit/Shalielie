// All localized page copy, in both languages, lives here.
//
// EDITING
//   Change the text to the right of a key. Keys are shared between en and zh, so
//   whatever you add to one you must add to the other, and whatever you rename
//   you must rename in index.html too.
//   Run `node tests/web/check-i18n.mjs` afterwards; it catches exactly those two
//   mistakes. Preview with `python -m http.server -d web 8000`, then reload.
//
//   A few tags are allowed inside a string — <b>, <br>, <code> — because the
//   values are inserted as HTML. Do not paste anything untrusted in here.
//
// WHERE EACH KEY APPEARS
//   lang.name    the switch button; it names the language you switch TO
//   meta.title   browser tab and the big heading
//   app.lede     the paragraph under the heading
//   drop.*       the drop area
//   opt.quality  the checkbox label
//   st.*         status text on a finished row
//   err.*        the only two failures a visitor can see
//   btn.*        buttons on a finished row
//   h.* s.* p.*  the notes at the bottom: heading, numbered step, paragraph

export const STRINGS = {
  en: {
    "lang.name": "中文",
    "meta.title": "Photographic Styles Palette Port",
    "app.lede": "Add the Photographic Styles palette editing controls introduced with iPhone 16 "
      + "to compatible HEIC photos from older iPhones. Processing happens entirely on "
      + "this device; your photos are never uploaded.",
    "drop.big": "Drop HEIC photos here, or tap to choose",
    "drop.small": "On iPhone, try <b>Photo Library</b> first. If a photo is rejected as not "
      + "a HEIC, iOS converted it — use <b>Browse</b> instead, as described below.",
    "opt.quality": "Analyze each photo for a closer palette match. On first use, this downloads "
      + "a small image decoder. Recommended unless it causes problems.",

    "st.reading": "Reading…",
    "st.working": "Processing…",
    "st.ready": "Ready",
    "st.matched": "palette tuned to this photo",
    "st.neutral": "neutral palette settings used",
    "st.portrait": "Portrait data preserved",
    "st.people": "people data preserved",
    "err.notheic": "This file is not a HEIC photo.",
    "err.unsupported": "This HEIC file is not compatible with this tool yet.",

    "btn.save": "Save to Photos",
    "btn.download": "Download",
    "btn.blocked": "Couldn’t open sharing",

    "h.iphone": "On iPhone",
    "s.1": "Tap the box above, choose <b>Photo Library</b>, and select your photo.",
    "s.2": "If it is rejected as not a HEIC, your iOS converted it on the way in. In Photos "
      + "tap <b>Share → Save to Files</b>, then return here and choose <b>Browse</b> instead.",
    "s.3": "When processing finishes, tap <b>Save to Photos</b>, then choose <b>Save Image</b> "
      + "in the share sheet.",
    "s.4": "Open the saved copy in Photos and tap <b>Edit</b>. The Photographic Styles "
      + "palette should appear.",
    "p.iphone": "Older versions of iOS always converted Photo Library picks to JPEG, which "
      + "strips the data this page needs. Newer ones can hand over the original HEIC, so it "
      + "is worth trying first — step 2 is only needed if yours still converts.",
    "h.computer": "On a computer",
    "p.computer": "Drop in the HEIC files and download the results. Transfer them to your "
      + "iPhone with AirDrop, iCloud Drive, or your usual import method.",
    "h.rejected": "If a photo is not accepted",
    "p.rejected": "This tool needs a compatible, unmodified HEIC photo captured by an iPhone. "
      + "It rejects JPEGs, screenshots, copies edited or exported by other apps, and HEIC "
      + "formats it does not support yet. Trying a file does not change the original.",
    "h.knowing": "Worth knowing",
    "p.knowing": "The image pixels are not re-encoded; this tool rewrites parts of the HEIC "
      + "container and its metadata. Everything runs locally on your device, and no photo is "
      + "uploaded. This is experimental, unofficial software, so keep your originals. This "
      + "page processes only the still HEIC image; Live Photo motion and audio are not included "
      + "in the processed copy.",
    "p.version": "Version",
  },

  zh: {
    "lang.name": "English",
    "meta.title": "风格调色盘移植工具",
    "app.lede": "为兼容的旧款 iPhone HEIC 照片添加 iPhone 16 系列引入的摄影风格调色盘编辑功能。"
      + "全部处理都在当前设备上完成，照片不会上传。",
    "drop.big": "拖放 HEIC 照片，或点按选取",
    "drop.small": "在 iPhone 上可先试<b>照片图库</b>。若提示不是 HEIC 照片，说明系统已转换，"
      + "请改用<b>浏览</b>，详见下方说明。",
    "opt.quality": "分析照片内容，使调色盘效果更贴合原片。首次使用时会下载一个小型图像解码组件；"
      + "除非出现问题，否则建议保持开启。",

    "st.reading": "读取中…",
    "st.working": "处理中…",
    "st.ready": "已完成",
    "st.matched": "调色盘已根据照片调整",
    "st.neutral": "已使用中性调色盘设置",
    "st.portrait": "已保留人像数据",
    "st.people": "已保留人物数据",
    "err.notheic": "此文件不是 HEIC 照片。",
    "err.unsupported": "本工具暂不兼容此 HEIC 文件。",

    "btn.save": "存储到「照片」",
    "btn.download": "下载",
    "btn.blocked": "无法打开共享菜单",

    "h.iphone": "在 iPhone 上",
    "s.1": "点按上方区域，选择<b>照片图库</b>，然后选取照片。",
    "s.2": "若提示不是 HEIC 照片，说明系统在导入时已转换。请在「照片」App 中点按"
      + "<b>共享 → 存储到「文件」</b>，返回本页后改选<b>浏览</b>。",
    "s.3": "处理完成后，点按<b>存储到「照片」</b>，再在共享菜单中选择<b>存储图像</b>。",
    "s.4": "在「照片」App 中打开存储后的副本，点按<b>编辑</b>，此时应能看到摄影风格调色盘。",
    "p.iphone": "旧版 iOS 从「照片图库」选取时总会转换为 JPEG，本页需要的数据会因此丢失；"
      + "较新版本则可能直接提供原始 HEIC，所以值得先试一次——只有仍会转换时才需要第 2 步。",
    "h.computer": "在电脑上",
    "p.computer": "拖入 HEIC 文件并下载处理结果，再通过隔空投送、iCloud 云盘或你常用的方式"
      + "将其传到 iPhone。",
    "h.rejected": "如果照片未被接受",
    "p.rejected": "本工具需要由 iPhone 拍摄、未经修改且格式兼容的 HEIC 照片。JPEG、截屏、"
      + "经其他 App 编辑或导出的副本，以及暂不支持的 HEIC 格式都会被拒绝。"
      + "尝试处理不会改动原片。",
    "h.knowing": "注意事项",
    "p.knowing": "图像像素不会被重新编码；本工具会改写 HEIC 容器和部分元数据。"
      + "全部处理都在当前设备上完成，照片不会上传。本工具属于实验性非官方软件，请保留原片。"
      + "本页仅处理 HEIC 静态图像，处理后的副本不包含实况照片的动态画面和声音。",
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
}
