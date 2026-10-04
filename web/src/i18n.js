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
//   err.*        failures a visitor can see
//   btn.*        buttons on a finished row
//   h.* s.* p.*  the notes at the bottom: heading, numbered step, paragraph

export const STRINGS = {
  en: {
    "st.queued": "Queued for processing",
    "review.title": "Correct faces",
    "review.detected": "This run detected {count} faces",
    "review.corrected": "Faces corrected",
    "review.counts": "Keep {kept} · Exclude {excluded}",
    "review.face": "Face {number}",
    "review.kept": "Keep",
    "review.excluded": "Excluded",
    "review.hint": "Tap a face box or thumbnail to toggle keep/exclude, then apply. This corrects this run's face data and local masks; original masks and shared person/skin segmentation are retained.",
    "review.apply": "Apply and update result",
    "review.cancel": "Cancel",
    "review.zoom": "Zoom",
    "review.zoomOut": "−",
    "review.zoomIn": "+",
    "review.queued": "Face correction queued…",
    "review.updated": "Result updated",
    "review.failed": "Correction failed; the previous result is still available",
    "lang.name": "中文",
    "meta.title": "Photographic Styles Palette Port",
    "app.lede": "Add the Photographic Styles palette introduced with iPhone 16 to compatible HEIC "
      + "photos from earlier iPhones, together with the Texture and Grain controls that iOS 27 "
      + "brought with iPhone 18 Pro. Photos from iPhone 16 or 17 that already have Photographic "
      + "Styles get just Texture and Grain. Photos from any phone or camera, and screenshots, "
      + "can also be imported as HEIC, PNG, JPEG, or WebP when supported by this browser. "
      + "Processing happens entirely on this device; your "
      + "photos are never uploaded.",
    "drop.big": "Drop HEIC, PNG, JPEG, or WebP images here, or tap to choose",
    "drop.small": "Choose photos to process automatically, then download or save the results. Photos stay on this device.",
    "opt.quality": "Analyze each photo for a closer palette match. On first use, this downloads "
      + "a small image decoder. Recommended unless it causes problems.",
    "opt.faces": "Experimental Soft Skin support: locally segment face skin, body skin, and the "
      + "complete person, then generate landmarks and statistics. The first use downloads face "
      + "and segmentation models and requires a browser HEVC encoder.",

    "st.reading": "Reading…",
    "st.faceDecode": "Decoding the photo for mask analysis…",
    "st.faceModels": "Preparing local face and segmentation models…",
    "st.faceDetect": "Detecting faces and landmarks…",
    "st.faceSegment": "Running shared multiclass segmentation and preparing confidence masks…",
    "st.faceMatte": "Generating and encoding {name}…",
    "st.emptyMatte": "Generating and encoding an empty {name}…",
    "st.faceMetadata": "Building person metadata and the mask overview…",
    "st.preparingStyle": "Preparing the style profile and photo analysis…",
    "st.rasterAuxiliary": "Encoding the thumbnail and HDR auxiliary image…",
    "st.hairPreserved": "original hair mask preserved",
    "matte.portraitPerson": "person / portrait effect matte",
    "matte.portrait": "Portrait effect matte",
    "matte.nose": "Nose matte",
    "matte.skin": "Skin matte",
    "matte.skinV2": "Skin matte (v2)",
    "matte.hair": "Hair matte",
    "matte.sky": "Sky matte",
    "matte.bodySkin": "Body skin matte",
    "matte.lips": "Lips matte",
    "matte.teeth": "Teeth matte",
    "matte.teethV2": "Teeth matte (v2)",
    "matte.person": "Person matte",
    "matte.glasses": "Glasses matte",
    "matte.glassesV2": "Glasses matte (v2)",
    "matte.eyebrows": "Eyebrows matte",
    "matte.tattoo": "Tattoo matte",
    "matte.hands": "Hands matte",
    "matte.ears": "Ears matte",
    "matte.faceSkin": "Face skin matte",
    "matte.personInstance": "Person instance mattes",
    "item.hdr": "HDR gain map",
    "item.styleDelta": "Style delta map",
    "item.tmap": "HDR tone map metadata",
    "item.styles": "Photographic Style data",
    "item.texture": "Texture and Grain data",
    "item.texturePeople": "Texture person data",
    "item.depth": "Portrait depth map",
    "item.masksValid": "Person mask validity hint",
    "item.peopleRatio": "Person coverage",
    "item.skinRatio": "Skin coverage",
    "item.tonePerson": "Tone-mapped person statistics",
    "item.linearPerson": "Linear person statistics",
    "item.toneSkin": "Tone-mapped skin statistics",
    "item.linearSkin": "Linear skin statistics",
    "item.redSkin": "Tone-mapped red-channel skin statistics",
    "item.greenSkin": "Tone-mapped green-channel skin statistics",
    "item.blueSkin": "Tone-mapped blue-channel skin statistics",
    "st.working": "Processing…",
    "st.linear": "Encoding an 8-bit linear thumbnail locally…",
    "err.linear8": "8-bit linear thumbnail generation failed. Technical information:",
    "st.rasterPreparing": "Preparing PNG/JPEG/WebP locally…",
    "st.heicReencode": "This HEIC cannot use the lossless transplant path; preparing a local browser re-encode…",
    "st.genericGraft": "Adapting the HEIF graph while preserving original HEVC tiles; generating only missing auxiliaries…",
    "st.rasterEncoding": "Encoding HEVC tile {done}/{total} in this browser…",
    "st.rasterAssembling": "Assembling the Photographic Style HEIC…",
    "st.ready": "Ready",
    "st.matched": "palette tuned to this photo",
    "st.neutral": "neutral palette settings used",
    "st.portrait": "Portrait data preserved",
    "st.people": "people data preserved",
    "st.texture": "Texture and Grain added",
    "st.native": "original Photographic Style kept",
    "st.faces": "pixel-level skin and person masks generated",
    "st.noface": "no clear face found",
    "st.facesUnavailable": "face mask unavailable in this browser",
    "st.directHdr": "standalone HDR gain map preserved",
    "st.tiledHdr": "tiled HDR gain map preserved",
    "st.syntheticHdr": "neutral HDR gain map generated locally",
    "st.rasterImported": "PNG/JPEG/WebP pixels encoded locally",
    "st.heicReencoded": "HEIC rebuilt through local compatibility re-encode",
    "st.genericPreserved": "original primary HEVC tiles preserved",
    "st.hastextureMasks": "Texture and Grain already present; use the complete embedded-data comparison below.",
    "err.notheic": "Choose a HEIC, PNG, JPEG, or WebP image.",
    "err.layout": "Unsupported image layout. The generic adapter accepts up to 48 primary tiles when its graph can be mapped safely; other layouts use compatibility re-encode when available.",
    "err.hdr": "This photo has no usable HDR gain-map data.",
    "err.metadata": "This photo is missing required Apple Exif or MakerNote metadata.",
    "err.profile": "The built-in compatibility profile could not be loaded. Check the connection and reload.",
    "err.size": "This file is too large for the Web version's 32-bit HEIF offsets.",
    "err.integrity": "The result failed its integrity check, so no output was offered.",
    "err.structure": "This HEIC uses an internal structure the Web version cannot edit yet.",
    "err.unexpected": "An unexpected processing error occurred. Technical detail",
    "err.hastexture": "This photo already has the Texture and Grain controls. Nothing to do.",
    "err.encoder": "This browser cannot provide the HEVC WebCodecs encoder needed to import PNG/JPEG/WebP. No output file was created.",
    "err.raster": "This PNG/JPEG/WebP could not be decoded by the browser. No output file was created.",

    "btn.save": "Save to Photos",
    "btn.inspectCompare": "Compare all embedded data",
    "btn.download": "Download to Files",
    "btn.close": "Close",
    "btn.debugDownload": "Download PNG",
    "btn.blocked": "Couldn’t open sharing",
    "thumbnail.source": "Original photo",
    "thumbnail.result": "Processed photo · touch and hold to save to Photos",
    "thumbnail.unavailable": "Original photo preview unavailable",
    "thumbnail.saveUnavailable": "This browser cannot save HEIC by long press. Download the file instead.",
    "debug.overlay": "Detection overlay (blue person, red skin, green landmarks)",
    "inspect.overlayTitle": "Detection overlay (not embedded)",
    "inspect.overlayHint": "Blue: person; red: skin; green: landmarks. This shows browser detection and may differ from preserved native masks. The table below reads the actual embedded data.",
    "inspect.title": "Embedded data before / after",
    "inspect.hint": "Every row uses the same canonical name on both sides. Image items are decoded when possible; metadata and statistics can be expanded as JSON.",
    "inspect.loading": "Reading and decoding embedded items…",
    "inspect.item": "Item / field",
    "inspect.before": "Before",
    "inspect.after": "After",
    "inspect.present": "Present",
    "inspect.missing": "Not present",
    "inspect.metadata": "Show metadata",
    "inspect.compareHint": "Badges compare original embedded bytes, image settings and tile data, not previews. Different encoding can look identical; matching data does not prove it matches the primary photo. Item IDs and file offsets are ignored.",
    "inspect.same": "Exactly the same",
    "inspect.different": "Data differs",
    "inspect.added": "Added",
    "inspect.removed": "Removed",
    "inspect.unknown": "Unable to compare",
    "inspect.showDifferences": "Show differences",
    "inspect.linkedOnly": "This item's own data and settings are unchanged. Differences come from its references or linked images.",
    "inspect.diffPayload": "Raw bytes differ",
    "inspect.diffSerialization": "Serialization differs; parsed fields match",
    "inspect.diffProperty": "Image setting differs",
    "inspect.diffPropertyOrder": "Property types/order differ",
    "inspect.diffReference": "Image references differ",
    "inspect.diffType": "Item type differs",
    "inspect.diffCount": "Item count differs",
    "inspect.diffField": "Field value differs",
    "inspect.diffMore": "{count} more differences are in the full JSON report.",
    "inspect.diffDownload": "Download full differences JSON",
    "inspect.diffBytesHint": "Expand each reason for before/after values. changedBytes is the differing-byte count; firstOffset starts at 0 within that item's data/property, not the HEIC file.",
    "inspect.orderOnly": "Only property order differs",
    "inspect.orderHint": "Descriptive property order changed. Its effect on Apple's rendering has not been verified; this is not marked exactly the same. Transformation order and actual values are checked separately.",
    "portrait.omitted": "Portrait effect matte generation was unavailable. The template placeholder was removed; BRIGHT behaviour still needs testing in Photos.",
    "portrait.hint": "When rebuilding missing style data, preserve a native portrait effect matte or generate one from this photo's person segmentation, even with face/skin analysis off. If generation is unavailable, omit the template placeholder and report it. The generated mask approximates Apple's native matte; test BRIGHT in Photos.",
    "inspect.gainMapHint": "HDR brightness gain distribution. A neutral gain map appears black.",
    "inspect.coverage": "Average mask coverage",
    "inspect.decodeFailed": "Present, but preview failed for item",
    "inspect.failed": "Could not inspect this file",

    "h.iphone": "On iPhone",
    "s.1": "Tap the box above, choose <b>Photo Library</b>, and select your photo.",
    "s.2": "If it is rejected as not a HEIC, your iOS converted it on the way in. In Photos "
      + "tap <b>Share → Save to Files</b>, then return here and choose <b>Browse</b> instead.",
    "s.3": "When processing finishes, touch and hold the <b>processed photo thumbnail</b>, "
      + "then choose <b>Save to Photos</b>. If the direct <b>Save to Photos</b> share "
      + "button is available, that route is faster.",
    "s.4": "Open the saved copy in Photos and tap <b>Edit</b>. The Photographic Styles "
      + "palette should appear; on iOS 27 it also offers <b>Texture</b> and <b>Grain</b>.",
    "p.iphone": "Older versions of iOS may convert Photo Library picks to JPEG. The page can "
      + "now import that JPEG experimentally, but choosing the original HEIC through Browse "
      + "still preserves more camera metadata and avoids re-encoding.",
    "h.computer": "On a computer",
    "p.computer": "Drop in the HEIC files and download the results. Transfer them to your "
      + "iPhone with AirDrop, iCloud Drive, or your usual import method.",
    "h.texture": "Texture and Grain (iOS 27)",
    "p.texture": "The Texture and Grain controls appear on iPhones running iOS 27. They work on "
      + "photos with and without people, and alongside Portrait. Photos taken on iPhone 18 "
      + "already have them and are left alone. Behavior on earlier iOS versions has not been "
      + "tested yet. Experimental Soft Skin support generates approximate skin/person masks "
      + "and native-shaped face metadata when the browser provides HEVC encoding; results "
      + "still need on-device validation.",
    "h.rejected": "If a photo is not accepted",
    "p.rejected": "Compatible iPhone HEIC photos use the metadata-preserving path. The generic graph "
      + "adapter also preserves original primary HEVC tiles for many photos with up to 48 tiles, "
      + "including files without a thumbnail or HDR gain map. PNG/JPEG/WebP and HEIC graphs that cannot "
      + "be mapped safely use the separate experimental local re-encode path. Trying a file does not "
      + "change the original.",
    "h.knowing": "Worth knowing",
    "p.knowing": "Compatible HEIC uses the pixel-preserving transplant path. Unsupported HEIC and PNG/JPEG/WebP "
      + "are encoded to HEVC locally in a grid sized to their pixels; images are not enlarged merely to "
      + "match the donor. Everything runs on your device, and no photo is "
      + "uploaded. This is experimental, unofficial software, so keep your originals. This "
      + "page processes only the still HEIC image; Live Photo motion and audio are not included "
      + "in the processed copy.",
    "p.version": "Version",
  },

  zh: {
    "st.queued": "已加入处理队列",
    "review.title": "校正人脸",
    "review.detected": "本次识别到 {count} 张人脸",
    "review.corrected": "已校正人脸",
    "review.counts": "保留 {kept} 张 · 排除 {excluded} 张",
    "review.face": "人脸 {number}",
    "review.kept": "保留",
    "review.excluded": "已排除",
    "review.hint": "点按人脸框或缩略图切换保留／排除，最后应用。仅校正本次识别；原图遮罩与共用人物／皮肤分割保留。",
    "review.apply": "应用并更新结果",
    "review.cancel": "取消",
    "review.zoom": "放大",
    "review.zoomOut": "−",
    "review.zoomIn": "+",
    "review.queued": "人脸校正已加入队列…",
    "review.updated": "已更新结果",
    "review.failed": "校正失败，仍可使用上一份结果",
    "lang.name": "English",
    "meta.title": "风格调色盘移植工具",
    "app.lede": "为 iPhone 16 之前机型拍摄的兼容 HEIC 照片添加 iPhone 16 系列引入的摄影风格调色盘，"
      + "并一并加入 iOS 27 随 iPhone 18 Pro 推出的「质感」与「颗粒」控制。已带有摄影风格的 "
      + "iPhone 16/17 照片只会添加质感与颗粒。不限 iPhone，任何手机或相机拍摄的照片、截屏也可导入；"
      + "支持 HEIC、PNG、JPEG 与 WebP，实际处理取决于浏览器的格式与编码支持。"
      + "全部处理都在当前设备上完成，照片不会上传。",
    "drop.big": "拖放 HEIC、PNG、JPEG 或 WebP 图像，或点按选取",
    "drop.small": "选取照片后会自动处理，再下载或存储结果；照片只在当前设备上处理。",
    "opt.quality": "分析照片内容，使调色盘效果更贴合原片。首次使用时会下载一个小型图像解码组件；"
      + "除非出现问题，否则建议保持开启。",
    "opt.faces": "实验性柔肤支持：在本机逐像素分割脸部皮肤、身体皮肤与完整人物，并生成特征点与统计数据。"
      + "首次使用会下载人脸与分割模型，且浏览器需要支持 HEVC 编码。",

    "st.reading": "读取中…",
    "st.faceDecode": "正在解码照片以分析遮罩…",
    "st.faceModels": "正在准备本机人脸与分割模型…",
    "st.faceDetect": "正在识别人脸与特征点…",
    "st.faceSegment": "正在运行共用多类别分割并整理置信度遮罩…",
    "st.faceMatte": "正在生成并编码{name}…",
    "st.emptyMatte": "正在生成并编码空的{name}…",
    "st.faceMetadata": "正在建立人物元数据与遮罩概览…",
    "st.preparingStyle": "正在准备风格模板与照片分析…",
    "st.rasterAuxiliary": "正在编码缩略图与 HDR 辅助图…",
    "st.hairPreserved": "已保留原图头发遮罩",
    "matte.portraitPerson": "人物／人像效果遮罩",
    "matte.portrait": "人像效果遮罩",
    "matte.nose": "鼻部遮罩",
    "matte.skin": "皮肤遮罩",
    "matte.skinV2": "皮肤遮罩（v2）",
    "matte.hair": "头发遮罩",
    "matte.sky": "天空遮罩",
    "matte.bodySkin": "身体皮肤遮罩",
    "matte.lips": "嘴唇遮罩",
    "matte.teeth": "牙齿遮罩",
    "matte.teethV2": "牙齿遮罩（v2）",
    "matte.person": "人物遮罩",
    "matte.glasses": "眼镜遮罩",
    "matte.glassesV2": "眼镜遮罩（v2）",
    "matte.eyebrows": "眉毛遮罩",
    "matte.tattoo": "纹身遮罩",
    "matte.hands": "手部遮罩",
    "matte.ears": "耳朵遮罩",
    "matte.faceSkin": "脸部皮肤遮罩",
    "matte.personInstance": "人物实例遮罩",
    "item.hdr": "HDR 增益图",
    "item.styleDelta": "风格差异图",
    "item.tmap": "HDR 色调映射元数据",
    "item.styles": "摄影风格数据",
    "item.texture": "质感与颗粒数据",
    "item.texturePeople": "质感人物数据",
    "item.depth": "人像深度图",
    "item.masksValid": "人物遮罩有效提示",
    "item.peopleRatio": "人物覆盖率",
    "item.skinRatio": "皮肤覆盖率",
    "item.tonePerson": "色调映射人物统计",
    "item.linearPerson": "线性人物统计",
    "item.toneSkin": "色调映射皮肤统计",
    "item.linearSkin": "线性皮肤统计",
    "item.redSkin": "色调映射红通道皮肤统计",
    "item.greenSkin": "色调映射绿通道皮肤统计",
    "item.blueSkin": "色调映射蓝通道皮肤统计",
    "st.working": "处理中…",
    "st.linear": "正在本机编码 8-bit 线性缩略图…",
    "err.linear8": "8-bit 线性缩略图生成失败。技术信息：",
    "st.rasterPreparing": "正在本机准备 PNG/JPEG/WebP…",
    "st.heicReencode": "此 HEIC 无法使用无损移植路径，正在准备浏览器本机重新编码…",
    "st.genericGraft": "正在转接 HEIF 图结构并保留原始 HEVC 图块，仅生成缺少的辅助图…",
    "st.rasterEncoding": "正在浏览器内编码 HEVC 图块 {done}/{total}…",
    "st.rasterAssembling": "正在组装摄影风格 HEIC…",
    "st.ready": "已完成",
    "st.matched": "调色盘已根据照片调整",
    "st.neutral": "已使用中性调色盘设置",
    "st.portrait": "已保留人像数据",
    "st.people": "已保留人物数据",
    "st.texture": "已添加质感与颗粒",
    "st.native": "已保留原有摄影风格",
    "st.faces": "已生成逐像素皮肤与人物遮罩",
    "st.noface": "未识别到清晰人脸",
    "st.facesUnavailable": "当前浏览器无法生成人脸遮罩",
    "st.directHdr": "已保留单张非分块 HDR 增益图",
    "st.tiledHdr": "已保留分块 HDR 增益图",
    "st.syntheticHdr": "已在本机生成中性 HDR 增益图",
    "st.rasterImported": "已在本机编码 PNG/JPEG/WebP 像素",
    "st.heicReencoded": "已通过本机兼容模式重新编码 HEIC",
    "st.genericPreserved": "已保留原始主图 HEVC 图块",
    "st.hastextureMasks": "此照片已有质感与颗粒，不会重复处理；可使用下方的完整内嵌资料检查器。",
    "err.notheic": "请选择 HEIC、PNG、JPEG 或 WebP 图像。",
    "err.layout": "不支持此照片的图像布局；通用转接器可在结构能够安全对应时处理最多 48 个主图图块，其余布局会尽量改走兼容重新编码。",
    "err.hdr": "此照片没有可用的 HDR 增益图资料。",
    "err.metadata": "此照片缺少必要的 Apple Exif 或 MakerNote 元数据。",
    "err.profile": "无法载入内置兼容配置；请检查网络并重新载入页面。",
    "err.size": "此文件过大，超出网页版目前使用的 32 位 HEIF 偏移范围。",
    "err.integrity": "处理结果未通过完整性检查，因此没有提供输出文件。",
    "err.structure": "此 HEIC 使用网页版目前无法编辑的内部结构。",
    "err.unexpected": "处理时发生未预期的错误；技术信息",
    "err.hastexture": "此照片已带有质感与颗粒控制，无需处理。",
    "err.encoder": "当前浏览器无法提供导入 PNG/JPEG/WebP 所需的 HEVC WebCodecs 编码器，因此没有生成输出文件。",
    "err.raster": "浏览器无法解码这张 PNG/JPEG/WebP，因此没有生成输出文件。",

    "btn.save": "存储到「照片」",
    "btn.inspectCompare": "对照全部内嵌资料",
    "btn.download": "下载到「文件」",
    "btn.close": "关闭",
    "btn.debugDownload": "下载 PNG",
    "btn.blocked": "无法打开共享菜单",
    "thumbnail.source": "原图",
    "thumbnail.result": "处理结果 · 长按存储到「照片」",
    "thumbnail.unavailable": "无法预览原图",
    "thumbnail.saveUnavailable": "此浏览器无法长按保存 HEIC，请下载文件。",
    "debug.overlay": "识别叠加图（蓝色人物、红色皮肤、绿色特征点）",
    "inspect.overlayTitle": "识别叠加图（非内嵌预览）",
    "inspect.overlayHint": "蓝色为人物、红色为皮肤、绿色为特征点。这是浏览器识别过程的预览，可能与保留的原生遮罩不同；下方表格读取的是实际内嵌资料。",
    "inspect.title": "处理前／后的内嵌资料",
    "inspect.hint": "左右两侧固定使用相同名称。影像项目会尽量解码显示；元数据与统计值可展开为 JSON。",
    "inspect.loading": "正在读取并解码内嵌项目…",
    "inspect.item": "项目／字段",
    "inspect.before": "处理前",
    "inspect.after": "处理后",
    "inspect.present": "存在",
    "inspect.missing": "不存在",
    "inspect.metadata": "展开元数据",
    "inspect.compareHint": "标记比较内嵌原始字节、图像设置及图块数据，不比较预览。重新编码也可能显示不同；相同不代表已验证与主图配对。忽略 item 编号及文件位置。",
    "inspect.same": "完全相同",
    "inspect.different": "数据不同",
    "inspect.added": "新增",
    "inspect.removed": "已移除",
    "inspect.unknown": "无法比较",
    "inspect.showDifferences": "查看差异原因",
    "inspect.linkedOnly": "这个项目自身的内容及设置相同；差异来自图像关联或下级图像。",
    "inspect.diffPayload": "原始字节不同",
    "inspect.diffSerialization": "序列化不同，解析后字段相同",
    "inspect.diffProperty": "图像设置不同",
    "inspect.diffPropertyOrder": "属性种类／顺序不同",
    "inspect.diffReference": "图像关联不同",
    "inspect.diffType": "项目类型不同",
    "inspect.diffCount": "项目数量不同",
    "inspect.diffField": "字段数值不同",
    "inspect.diffMore": "另有 {count} 处差异，可下载完整 JSON 查看。",
    "inspect.diffDownload": "下载完整差异 JSON",
    "inspect.diffBytesHint": "展开各原因可看前后值。changedBytes 是不同字节数；firstOffset 从该项目／属性的数据起点 0 开始计算，不是 HEIC 文件位置。",
    "inspect.orderOnly": "仅排列不同",
    "inspect.orderHint": "描述属性的排列改变，尚未验证是否影响 Apple 渲染，因此不标为完全相同。旋转／镜像等操作顺序与实际内容会另外检查。",
    "portrait.omitted": "无法生成人像效果遮罩，已移除模板占位图；明亮效果仍需在照片 App 验证。",
    "portrait.hint": "补建风格数据时优先保留原生人像效果遮罩；缺少时从这张照片的人物分割生成，即使关闭柔肤／人脸选项也会执行。生成失败时移除模板占位图并提示。生成遮罩是原生遮罩的近似结果，明亮效果仍需在照片 App 验证。",
    "inspect.gainMapHint": "HDR 亮度增益分布。无额外增益的中性 gain map 会显示为黑色。",
    "inspect.coverage": "遮罩平均覆盖率",
    "inspect.decodeFailed": "项目存在，但无法显示预览",
    "inspect.failed": "无法检视此文件",

    "h.iphone": "在 iPhone 上",
    "s.1": "点按上方区域，选择<b>照片图库</b>，然后选取照片。",
    "s.2": "若提示不是 HEIC 照片，说明系统在导入时已转换。请在「照片」App 中点按"
      + "<b>共享 → 存储到「文件」</b>，返回本页后改选<b>浏览</b>。",
    "s.3": "处理完成后，长按<b>处理结果缩略图</b>，再选择<b>存储到照片</b>。"
      + "若页面也显示直接的<b>存储到「照片」</b>共享按钮，使用它会更快。",
    "s.4": "在「照片」App 中打开存储后的副本，点按<b>编辑</b>，此时应能看到摄影风格调色盘；"
      + "在 iOS 27 上还会出现<b>质感</b>与<b>颗粒</b>。",
    "p.iphone": "旧版 iOS 可能会把「照片图库」选取的文件转换为 JPEG。网页现在可实验性导入该 "
      + "JPEG，但通过“浏览”选择原始 HEIC 仍能保留更多相机元数据，也不需要重新编码。",
    "h.computer": "在电脑上",
    "p.computer": "拖入 HEIC 文件并下载处理结果，再通过隔空投送、iCloud 云盘或你常用的方式"
      + "将其传到 iPhone。",
    "h.texture": "质感与颗粒（iOS 27）",
    "p.texture": "质感与颗粒控制会在运行 iOS 27 的 iPhone 上出现，适用于有人物和无人物的照片，"
      + "也可与人像模式同时使用。iPhone 18 拍摄的照片本身已带有这些控制，不会被处理。"
      + "在更早的 iOS 版本上的表现尚未测试。实验性柔肤支持会在浏览器具备 HEVC 编码能力时"
      + "生成近似的皮肤/人物遮罩与原生结构的人脸数据，实际效果仍需在手机上验证。",
    "h.rejected": "如果照片未被接受",
    "p.rejected": "兼容的 iPhone HEIC 会走保留元数据的处理路径。通用图结构转接器也能为许多最多 "
      + "48 个主图图块的照片保留原始 HEVC 主图，包括缺少缩略图或 HDR 增益图的文件。PNG/JPEG/WebP "
      + "与无法安全对应的 HEIC 图结构会改走实验性的本机重新编码路径。尝试处理不会改动原片。",
    "h.knowing": "注意事项",
    "p.knowing": "兼容 HEIC 会走保留像素的移植路径；不兼容 HEIC 与 PNG/JPEG/WebP 则会按照自身像素尺寸建立"
      + "动态 grid，并在浏览器内编码为 HEVC，不会为了匹配 donor 而无故放大。全部处理都在当前设备上完成，"
      + "照片不会上传。本工具属于实验性非官方软件，请保留原片。"
      + "本页仅处理 HEIC 静态图像，处理后的副本不包含实况照片的动态画面和声音。",
    "p.version": "版本",
  },
};

const STORE_KEY = "psport.lang";

// Shared by processing progress and embedded-data inspection. Keep raw identifiers
// as lookup keys. Progress shows localized names; inspection also shows identifiers.
export const ITEM_LABEL_KEYS = Object.freeze({
  "HDR gain map": "item.hdr", "style delta map": "item.styleDelta", tmap: "item.tmap",
  styles: "item.styles", texture_styles: "item.texture",
  TextureStylePostProcessedPeopleData: "item.texturePeople", "portrait depth map": "item.depth",
  portraiteffectsmatte: "matte.portrait", semanticskinmatte: "matte.skin",
  semantichairmatte: "matte.hair", semanticteethmatte: "matte.teeth",
  semanticglassesmatte: "matte.glasses", semanticskymatte: "matte.sky",
  semanticnosematte: "matte.nose", semanticskinmattev2: "matte.skinV2",
  semanticnonfaceskinmatte: "matte.bodySkin", semanticlipsmatte: "matte.lips",
  semanticteethmattev2: "matte.teethV2", semanticpersonmatte: "matte.person",
  semanticglassesmattev2: "matte.glassesV2", semanticeyebrowsmatte: "matte.eyebrows",
  semantictattoomatte: "matte.tattoo", semantichandsmatte: "matte.hands",
  semanticearsmatte: "matte.ears", semanticfaceskinmatte: "matte.faceSkin",
  semanticpersoninstances: "matte.personInstance", PersonMasksValidHint: "item.masksValid",
  PeopleRatio: "item.peopleRatio", SkinRatio: "item.skinRatio",
  ToneMappedImagePersonSegmentBased: "item.tonePerson", LinearImagePersonSegmentBased: "item.linearPerson",
  ToneMappedImageSkinBased: "item.toneSkin", LinearImageSkinBased: "item.linearSkin",
  ToneMappedImageRedChannelSkinBased: "item.redSkin", ToneMappedImageGreenChannelSkinBased: "item.greenSkin",
  ToneMappedImageBlueChannelSkinBased: "item.blueSkin",
});

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
