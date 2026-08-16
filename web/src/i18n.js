// Every word the page shows, in both languages. This is the only file with
// user-facing copy in it; index.html holds no text of its own.
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
    "meta.title": "Photographic Style Port",
    "app.lede": "Adds the iPhone 16-generation Photographic Styles editing state to a HEIC "
      + "from an older iPhone. Everything runs in your browser — your photos are never uploaded.",
    "drop.big": "Drop HEIC photos here",
    "drop.small": "on iPhone choose <b>Browse</b>, not Photo Library — the Photo Library "
      + "converts HEIC to JPEG",
    "opt.quality": "Read the photo for a better match. Downloads a small helper once, the "
      + "first time. Leave it on unless it gives you trouble.",

    "st.reading": "reading…",
    "st.working": "working…",
    "st.ready": "Ready",
    "st.matched": "matched to your photo",
    "st.neutral": "using neutral settings",
    "st.portrait": "Portrait kept",
    "st.people": "people data kept",
    "err.notheic": "Not a HEIC photo.",
    "err.unsupported": "This HEIC isn't supported yet.",

    "btn.save": "Save to Photos",
    "btn.download": "Download",
    "btn.blocked": "Sharing blocked",

    "h.iphone": "On iPhone",
    "s.1": "In Photos, open the photo and tap <b>Share → Save to Files</b>.",
    "s.2": "Come back here, tap the box above and choose <b>Browse</b>, then pick that file.",
    "s.3": "When it finishes, tap <b>Save to Photos</b> and choose <b>Save Image</b>.",
    "s.4": "Open the new photo in Photos and tap <b>Edit</b> — the styles palette is there.",
    "p.iphone": "Step 1 is the part people skip. Picking straight from your Photo Library "
      + "hands this page a converted copy with the original data stripped out, and there is "
      + "nothing left to work with.",
    "h.computer": "On a computer",
    "p.computer": "Drop the files in and download the results. Then get them onto your iPhone "
      + "however you normally would — AirDrop, iCloud Drive, or importing them back into Photos.",
    "h.rejected": "If a photo is turned away",
    "p.rejected": "It has to be an untouched photo from an iPhone that shoots in HEIC. "
      + "Screenshots, JPEGs, photos already edited or exported by other apps, and photos from "
      + "some phone models are all turned away — the row will say which it was. Nothing is "
      + "harmed by trying.",
    "h.knowing": "Worth knowing",
    "p.knowing": "Your picture itself is untouched — it is not re-encoded, so what comes back "
      + "looks exactly like what went in. Everything happens on your own device; no photo is "
      + "uploaded. This is unofficial software that works by rewriting parts of the file Apple "
      + "never documented, so keep your originals.",
    "p.version": "Version",
  },

  zh: {
    "lang.name": "English",
    "meta.title": "摄影风格移植",
    "app.lede": "为旧款 iPhone 拍摄的 HEIC 照片，加上 iPhone 16 世代的「摄影风格」编辑能力。"
      + "全部处理都在你的浏览器中完成，照片不会被上传。",
    "drop.big": "把 HEIC 照片拖到这里",
    "drop.small": "在 iPhone 上请选择<b>浏览</b>，不要用「照片图库」——图库会把 HEIC 转成 JPEG",
    "opt.quality": "读取照片以获得更贴合的效果。首次使用会下载一个小的辅助文件。"
      + "除非遇到问题，建议保持勾选。",

    "st.reading": "读取中…",
    "st.working": "处理中…",
    "st.ready": "完成",
    "st.matched": "已按你的照片匹配",
    "st.neutral": "使用中性设置",
    "st.portrait": "已保留人像",
    "st.people": "已保留人物数据",
    "err.notheic": "这不是 HEIC 照片。",
    "err.unsupported": "暂不支持这张 HEIC 照片。",

    "btn.save": "存储到「照片」",
    "btn.download": "下载",
    "btn.blocked": "无法共享",

    "h.iphone": "在 iPhone 上",
    "s.1": "在「照片」中打开这张照片，点按<b>共享 → 存储到「文件」</b>。",
    "s.2": "回到本页，点按上方方框并选择<b>浏览</b>，然后选中刚才存储的文件。",
    "s.3": "处理完成后，点按<b>存储到「照片」</b>，再选择<b>存储图像</b>。",
    "s.4": "在「照片」中打开新照片，点按<b>编辑</b>，调色盘就在那里。",
    "p.iphone": "第一步最容易被跳过。直接从「照片图库」选取，本页拿到的只是一份转换后的副本，"
      + "原始数据已经被丢弃，没有东西可以处理。",
    "h.computer": "在电脑上",
    "p.computer": "把文件拖进来，下载处理结果，再用你习惯的方式传到 iPhone——AirDrop、"
      + "iCloud 云盘，或重新导入「照片」。",
    "h.rejected": "如果照片被拒绝",
    "p.rejected": "必须是 iPhone 以 HEIC 格式直接拍摄、未经改动的照片。截屏、JPEG、"
      + "已被其他应用编辑或导出的照片，以及部分机型的照片都会被拒绝——每一行会说明原因。"
      + "试一下不会有任何损害。",
    "h.knowing": "需要知道",
    "p.knowing": "你的画面本身不会被改动——不会重新编码，处理后的照片和原来一模一样。"
      + "全部处理都在你自己的设备上完成，不会上传任何照片。这是非官方工具，"
      + "靠改写 Apple 从未公开的文件结构实现，请务必保留原片。",
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
