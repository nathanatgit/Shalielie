# 浏览器摄影风格移植工具

[English](README.md) | **简体中文**

## 照片处理流程（0.6.0-web）

支持导入任何手机或相机拍摄的照片，以及截屏，格式包括 HEIC、PNG、JPEG、WebP。
实际能处理哪些文件，仍取决于浏览器的解码与 HEVC 编码支持。

选取照片后会自动按队列处理。每张卡片都保留原图缩略图，处理失败时也能辨认照片。
成功后会直接在卡片上显示输出 HEIC 小图，供支持原生 HEIC 图像的 iPhone 浏览器长按存储。
结果还提供下载、可用时的“照片”分享，以及**对照全部内嵌资料**。
不支持原生 HEIC 图像的浏览器可以显示本机 Canvas 预览；此时请通过文件下载或“照片”分享
保存结果，以保留 HEIC 元数据。

进度时间是每个步骤的独立耗时，包括排队等待；步骤结束后时间不再变化。
不足一秒显示毫秒，正数不足一毫秒显示 `<1ms`；较长步骤显示三位小数的秒数。
完成／错误摘要不显示步骤计时。模型准备、人脸检测、多类别分割，以及每个遮罩的生成／编码
分别计时。人物遮罩与人像效果遮罩复用一次编码。保留原图像素的路径会保留原生头发遮罩，
浏览器生成器目前不会新编码头发遮罩。
同步解码与推理可能阻塞界面，使计时暂时停止刷新；恢复后会根据单调时钟补上实际耗时。
流程会在阶段之间及人脸检测的各次扫描之间让出执行时间，以便浏览器刷新。
**对照全部内嵌资料**是每张结果卡片的第一个操作。对照标签显示译名与技术名称，
例如“头发遮罩”与 `semantichairmatte`；外层进度只显示译名。
所有本机模块导入都使用与入口相同的构建标记，避免一般图片导入与原生 HEIC 路径
复用不同版本的人脸／进度模块缓存。

本次生成了人脸检测结果的照片，会在对照按钮后提供**校正人脸**。
对话框显示方向正确的照片、编号人脸框、对应的人脸缩略图，以及缩放控制。
点选保留／排除后统一应用；取消会丢弃本次尚未应用的选择。
应用后更新同一张卡片的 HEIC 下载、“照片”分享、长按小图、人脸数量与对照／叠图。
已应用的选择可以再次打开、调整与恢复。
校正复用首次人脸检测与共用分割结果，只重建依赖人脸的局部遮罩和人物元数据，
并复用已经编码的主图、HDR 与缩略图像素。原生来源遮罩和共用皮肤／人物遮罩保留。
排除全部检测会移除本次生成的所有人物实例与人脸记录；恢复全部人脸会恢复首次输出的原始字节。
校正失败时，上一份结果与已应用的选择仍可使用。
此对话框只校正本次检测，不新增人脸，也不编辑相机原有的内嵌遮罩。

已有摄影风格的原生照片保留原有辅助数据并加入质感／颗粒；
没有风格数据的照片通过配置移植，并生成独立的 8-bit 线性缩略图。

内嵌资料对照检查实际输入／输出的元数据、项目负载与遮罩。

验证：使用已有 Playwright 环境运行 `node tests/web/basic-workflow-browser.mjs`，
可检查普通原生输出的逐字节一致性、对照，以及 320／390 像素宽度的布局。
`node tests/web/linear8.mjs` 使用外部安装的 FFmpeg 测试程序验证真实 HEVC 样本；网站不附带 FFmpeg。

## 部署

`.github/workflows/pages.yml` 会在涉及此目录的推送后发布网页。
首次在 **Settings → Pages → Source → GitHub Actions** 中启用即可。
没有构建步骤；上传前工作流会检查：

- `web/` 下没有 `.heic`／`.heif` 文件，避免发布个人照片。
- 两个 donor 配置存在且非空。
- PWA 元数据、图标尺寸、注册方式与离线资源清单一致。

在同一台电脑测试时，localhost 属于安全环境的例外：

```bash
uv run tools/serve_web.py
```

打开 `http://localhost:8000/` 即可。本机测试不需要生成或安装证书；
辅助服务器提供 HTTP 服务及 COOP／COEP 响应头。

iPhone／区网测试可使用托管网站或受信任的本机 HTTPS。
WebCodecs 要求安全环境：回环地址 HTTP 可用，
普通区网 IP 的 HTTP 不具备相同条件，无法因此取得所需的编码／PWA API。
参见 [WebCodecs](https://www.w3.org/TR/webcodecs/#videoencoder-interface)
与 [Secure Contexts](https://www.w3.org/TR/secure-contexts/#is-origin-trustworthy)。

使用 Python 生成证书；uv 管理脚本独立的 `cryptography` 依赖，不修改项目依赖：

```bash
uv run tools/create_https_cert.py --ip YOUR_LAN_IP
uv run tools/serve_web.py --bind 0.0.0.0 --port 8443 --cert .local-https/lan-cert.pem --key .local-https/lan-key.pem
```

将 `YOUR_LAN_IP` 替换成电脑实际的区网 IP，再在 iPhone 打开 `https://YOUR_LAN_IP:8443/`。
只将 `.local-https/rootCA.cer` 传到 iPhone 并打开，在“设置 → 已下载描述文件”中安装，
再到“设置 → 通用 → 关于本机 → 证书信任设置”启用信任。
仅跳过证书警告不足以启用相关 API。
私钥留在电脑上、存放于网页服务目录之外；`.local-https/` 已被 Git 忽略。
工具不会自动修改操作系统的信任设置。

服务器证书有效期为 90 天。再次运行生成器可续期或更换 IP，并复用已有 CA。
如果 CA 文件被删除后重新生成，必须在 iPhone 重新安装并信任新的 `rootCA.cer`。

也可以提供其他工具生成的已有证书：

```bash
uv run tools/serve_web.py --bind 0.0.0.0 --port 8443 --cert path/to/lan-cert.pem --key path/to/lan-key.pem
```

在安全的静态托管环境中，应用会等待当前构建的 Service Worker 控制页面，
检查响应头，并在必要时每个构建最多重新加载一次。

所有资源使用相对路径，因此 `https://user.github.io/repo/` 这类项目子路径无需额外配置。

## PWA 与离线使用

网站可安装为渐进式 Web 应用（PWA）。`manifest.webmanifest` 提供应用名称与图标，
`sw.js` 预缓存完整转换器、两个 donor 配置，以及全部第一方 JavaScript。
路径保持相对形式，可用于域名根目录或 GitHub Pages 项目子路径。

缓存优先访问网络，失败后使用已保存的副本，兼顾更新与离线使用。
可选 libheif 解码器、MediaPipe 运行环境／模型及访问计数器属于第三方请求，Service Worker 不会持久缓存它们。
解码器不可用时，照片分析会回退到经过测试的 donor 统计路径。

修改运行时文件或 manifest 后，检查离线资源清单是否完整：

```bash
node tests/web/check-pwa.mjs
```

## 网站包含哪些内容

当前网站不加载或附带 FFmpeg WASM、ffprobe WASM 或 FFmpeg Worker。
新的 HEVC 主图、辅助图、遮罩，以及 8-bit 线性缩略图使用 WebCodecs 编码；
线性缩略图的 SPS 色彩标记由 JavaScript 修改。
Python／CLI 仍使用本机 FFmpeg/libx265 生成新的 10-bit Main10 线性缩略图，
部分本机验证测试也使用原生 FFmpeg；两者都不是网站依赖。
MediaPipe 的 WASM 运行环境用于本机推理，与 FFmpeg 无关。

| 项目 | 内容 |
|---|---|
| 组成 | 第一方 JavaScript 与两个精简 donor 配置，不附带 FFmpeg |
| 请求 | `index.html`、`app.js`、第一方模块，以及每种照片布局所需的配置 |
| 外部依赖 | 可选解码器与可选 MediaPipe 运行环境／模型，详见下节 |
| 托管 | localhost 的本机 HTTP 或托管 HTTPS 网站；开发服务器或 Service Worker 提供 COOP／COEP |

## 可选外部依赖

HEIC 场景测量、遮罩分析与备用预览可以使用从 jsDelivr 按需加载的 libheif 解码器。
`src/decode.js` 当前加载传统 JavaScript／asm.js 构建，并在同一页面复用已初始化的库。
其他处理流程可在浏览器支持时使用原生图像解码。

HEIC 遮罩分析目前在主执行线程调用 libheif，先解码完整分辨率，再缩小供分析。
异步回调不会把耗时解码移到 Worker，因此大照片可能阻塞按钮、滚动和进度计时。
HTTP 与 HTTPS 使用同一条遮罩解码路径。
解码图像缓存以字节数组对象为键；预览与处理若使用不同数组，同一张照片可能再次解码。

这些请求下载处理代码，照片数据保留在本机。可选场景分析失败时使用 donor 统计和中性光照图，
这也是与 Python 参考输出进行确定性对照的配置。
需要解码像素或新 HEVC 图像的路径，仍需可用的解码器／编码器；不可用时会显示错误。

若要从本机提供解码器，可将相同版本的传统构建放入项目，并将 `LIBHEIF_URL` 指向它：

```bash
npm pack libheif-js@1.18.2
tar -xzf libheif-js-1.18.2.tgz
mkdir -p web/vendor
cp package/libheif/libheif.js web/vendor/
```

生成人脸数据或缺少的人像效果遮罩时，`src/face-mattes.js` 会按需下载固定版本的
MediaPipe Tasks Vision 模块／WASM、Google Face Landmarker，以及六分类 SelfieMulticlass 分割器。
推理在浏览器内完成，请求不会发送照片。
Face Landmarker 提供 ROI／特征点元数据；SelfieMulticlass 提供逐像素背景、头发、身体皮肤、
脸部皮肤、衣服与其他／配饰置信度。
只生成人像效果遮罩时需要分割器，不需要 Face Landmarker。
“正在准备本机人脸与分割模型”包含运行环境／模型下载与初始化。
首次使用可能花数秒；同一页面后续照片复用已缓存的模型 Promise，可能只需数毫秒。
即使 HTTP 下载命中缓存，重新加载页面仍需创建模型实例。
Face Landmarker 优先使用 GPU，初始化失败后改用 CPU；SelfieMulticlass 使用 CPU。
人脸检测和分割在后续各自独立的步骤中计时。
合照会进行一次全图扫描及四次重叠放大裁切扫描，再将检测映射回完整图像坐标，
去除重复检测后生成遮罩与人物元数据。

写入遮罩需要 HEVC 编码。实现会调用 `VideoEncoder.isConfigSupported()` 检查编码器，
并将返回的 `HEVCDecoderConfigurationRecord` 写为遮罩的 `hvcC` 属性。
人脸／遮罩生成不可用时，其他条件仍满足的路径会继续使用空的 2026 语义遮罩，
并在结果卡片说明未加入生成遮罩的原因。
需要新主图或线性缩略图的路径仍需 HEVC 编码器；无法生成缺少的人像效果遮罩时会省略该项目。

浏览器将脸部与身体皮肤置信度合并为 `semanticskinmattev2`，脸部皮肤映射为
`semanticfaceskinmatte`，身体皮肤映射为 `semanticnonfaceskinmatte`，
背景置信度的补集映射为 `semanticpersonmatte`。
原生来源皮肤遮罩优先：已有 `semanticskinmatte` 会保留，并通过复用编码像素、尺寸、编码、
色彩与变换属性补建缺少的 `semanticskinmattev2`。
如果来源同时拥有两种遮罩，各自保留原有内容，两种辅助图 URI 保持不同。
此规则适用于两个 donor 配置、添加质感／颗粒的原生风格照片，以及 HEIC 兼容重编码。
只有来源没有皮肤遮罩时，才用浏览器生成的置信度供给两代语义遮罩，包括 PNG／JPEG／WebP 导入。
不会将 donor 遮罩当成来源原生皮肤数据。
生成遮罩只是近似结果；将旧版像素复制到 v2 项目并不会复现 Apple 的 v2 分割模型。
其他项目的共用属性保持不变。

人物置信度会依据最近的检测人脸划分为 `semanticpersoninstances`。
置信度图在保留宽高比的前提下平滑重采样，最长边为 768 像素，尺寸为适合 HEVC 的偶数。
旋转与镜像将其转换为存储方向；每个生成遮罩和人物实例都有匹配的 HEVC 尺寸与独立 `ispe`。
PNG／JPEG／WebP 的人脸分析也保留来源宽高比；空遮罩回退保留参考的 768×576 尺寸。
流程还会计算 styles plist 中的人物／皮肤覆盖率与统计，为每张检测人脸创建实例遮罩，
并将逐脸 ROI、色彩、粗糙度和实例遮罩关联写入 `TextureStylePostProcessedPeopleData`。
76 个特征点按 原生参考样本 推断出的原生顺序排列：左右眼、左右眉毛、外／内嘴唇、
鼻梁／鼻底，最后是从右太阳穴到左太阳穴的脸部轮廓。
单个 MediaPipe 点位是对 Apple 私有检测结果的近似；分组边界与数组位置保持稳定。
Face Mesh 轮廓提供鼻部、嘴唇、眉毛和近似耳朵遮罩；嘴部像素用于保守的牙齿遮罩；
分割器的配饰置信度限制在眼部区域以生成眼镜遮罩；脸／颈核心以外的非脸部身体皮肤
用于保守的手部候选区域。纹身遮罩保持为空，直到有可靠分类器能避免把阴影和衣物误认为纹身。
所有生成数据仍属实验性，尚未在手机上验证与 Apple 私有分割等价。

偏航、俯仰、翻滚来自 MediaPipe 以列为主序的标准脸到当前脸变换矩阵。
旋转分解为 `Rz * Ry * Rx`，使用弧度（`faceUnitOfAngle = 1`），再依据 原生参考样本
中的四张原生人脸逐轴校准，以修正不同的中性脸零点而不混合各轴。
这四个参考样本的最大残差约为 0.036 弧度（2.1 度），所以数值属于估计，并非 Apple 检测器输出。

每张卡片只有一个**对照全部内嵌资料**入口，包括已有质感／颗粒、文件逐字节不改动的照片。
输入与输出使用统一项目清单，缺少的项目显示“不存在”。
此面板从实际 HEIC 读取遮罩、比例、统计与 ROI／编号特征点几何。
每个标签显示译名及技术名称。差异涵盖负载字节、属性与 essential 标记、属性顺序和图像关联。
精简的 `references` 摘要列出关联类型与目标数量：
`["auxl", 1]` 变成 `["auxl", 2]` 表示一个目标变为两个，不是项目重新编号。
移植的辅助图可能在保留编码像素的同时连到主图与 tmap。
部分深度图／遮罩移植还会改变描述属性顺序或 essential 标记；对照会列出这些变化，
不宣称 Apple 渲染等价。仅凭覆盖率相同不能证明编码数据一致。

本次运行了浏览器人脸检测时，同一面板还会提供可折叠的**检测叠图（未内嵌）**及 PNG 下载。
蓝色表示人物、红色表示皮肤、绿色表示人脸特征点。
这是推理预览，可能与输出中保留的来源原生遮罩不同；没有运行检测时隐藏此区域。

清单涵盖 HDR 增益图、风格差异图、tmap、styles 与 texture_styles plist、
`TextureStylePostProcessedPeopleData`、人像深度、六种旧版人像／语义遮罩、全部十二种
2026 遮罩、`semanticpersoninstances`、三个遮罩提示／比例，以及七组人物／皮肤统计，
每组包含九个百分位字段。直接 HEVC 遮罩在 WebCodecs 支持时解码为图像；
分块图与元数据项目显示结构或 JSON，不将它们当作语义遮罩。

## 独立的 8-bit 线性缩略图

没有风格数据的 HEIC 与一般图片导入，会编码独立且保留宽高比的缩略图，最长边为 1024 像素。
Display P3 Canvas 提供经过色彩管理的像素；显式转换为受限范围 YUV 前，先移除 sRGB／P3 传递曲线。
编码使用 8-bit I420 像素与 WebCodecs HEVC Main。
为兼容不接受 linear 传递标记的 VideoFrame，已经线性化的原始像素在编码时使用与编码器协商的
SDR 传输标记。黑色探测帧会在提交真实线性像素前，确认编码器的传递曲线、YUV 矩阵与全／受限范围。
线性 RGB 直接转换为协商后的 BT.709 或 BT.601 YUV，不再次进行 gamma 编码。
随后由 JavaScript 修改 SPS VUI，将原色设为 P3、传递特性设为 linear，不改变图像 NAL，
并在 SPS 与 HEIC nclx 中保留协商的矩阵／范围。
实际 SPS 字段优先；浏览器元数据只补充缺少的字段。
协商后色彩变化或 SPS 不一致会被拒绝。
输出保留 P3 原色、线性传递特性及协商的 YUV 矩阵／范围。
返回的 hvcC、实际 SPS 与 pixi 必须一致声明 8-bit；HEIC 为此辅助图写入独立 hvcC、pixi、ispe 与 nclx。

不支持的 Canvas 格式、编码失败或色彩元数据变化都会停止转换并显示明确错误。
已有摄影风格的原生照片保留其原有线性缩略图，包括原生 10-bit 数据。
优先使用 Float16 Canvas 像素；这是实验性的辅助图重建。

网页版提供实验性通用 HEIF 图结构移植，适用于许多含 1–48 个主图图块的无风格 HEIC，
HDR 可以不存在、为单个独立项目，或为图块数量能对应现有 donor 的分块图。
它改写 donor 的项目图结构与 grid 描述以匹配来源布局，同时逐字节复制原始主图及可对应的 HDR HEVC 图块。
来源没有缩略图或 HDR 增益图时，WebCodecs 只生成缺少的辅助图，不重新编码原始主图压缩数据。
分析或新线性缩略图仍可能需要单独解码；已验证的布局包括 42/0、40/0、36/0 与 42/15。

无法安全映射的 HEIC 图结构，包括目前没有对应 donor 的分块 HDR 数量或超过 48 个主图图块，
会回退到 PNG／JPEG／WebP 使用的本机 WebCodecs 兼容路径。
此路径会重建像素，不能保证通用移植的主图负载保留。
grid 根据实际尺寸动态计算，不会为了模仿 donor 的 4032 像素长边而放大来源。

PNG／JPEG／WebP 没有可以直接保留的压缩 HEVC 主图，因此需要支持 HEVC 的浏览器 `VideoEncoder`。
来源像素能容纳在 donor 的 48 个项目槽内时，保留原尺寸，计算所需的最小 512 像素图块 grid，
并移除未使用的槽。流程也会生成独立 8-bit 线性缩略图与中性分块 HDR 增益图。
超过 48 个图块的图像只缩小到刚好能容纳的尺寸。
接着加入 v16 摄影风格、质感／颗粒，以及在本机人脸推理可用时生成的 2026 语义遮罩；
不可用时使用空语义遮罩。缺少的人像效果遮罩在人物分割可用时生成，不可用时省略。
主图编码不依赖 Windows 程序、Python 进程或服务器上传；新线性缩略图使用 8-bit WebCodecs。
WebP 通过 RIFF／WEBP 文件签名识别，使用相同流程。
透明像素合成到黑色背景，输出为静态 HEIC。
没有兼容 HEVC 编码器时会显示明确错误，不提供不完整文件。
此新编码路径仍属实验性，与保留原像素的 HEIC 容器修改路径不同。

一般图片的色彩显式编码：Canvas 将来源 ICC／Display P3 色彩管理到 sRGB。
浏览器 HEVC 编码器即使收到 P3 输入，也可能返回 BT.709 原色，所以此重编码路径以 sRGB／BT.709 色域为目标。
每批编码前使用同一编码器、相同尺寸的一个弃用帧探测输出色彩。
返回的描述决定真实 RGB 转换为 I420 时使用的传递曲线（sRGB 或 BT.709）、
YUV 矩阵（BT.709 或 BT.601）与全／受限范围。
`src/raster-color.js` 执行相匹配的像素转换，并将配置写入 HEIC 的 `nclx`。
探测帧不进入照片，也不计入图块数量。
主图图块、主图 grid、tmap、普通缩略图与中性增益图使用编码器自身的色彩描述，不沿用 donor ICC。
编码器返回矛盾的色彩元数据时导入会失败，不会输出标记错误的照片。
已有 HEIC 的主图位流保留。

## iPhone 注意事项

流程处理了两种 iOS 行为：

- **从照片图库选取。** 打开“选项 → 格式”，将“自动”改成“当前”（繁体界面为“目前”），
  即可保持照片现有格式。HEIC 照片可使用 HEIC 元数据移植路径，也可通过“浏览”直接选择 HEIC 文件。
  JPEG／PNG／WebP 照片在 Safari 提供 HEVC WebCodecs 时使用本机导入路径。
- **将结果存回“照片”。** 浏览器支持文件分享时，“存储到『照片』”按钮会将完成的 `.heic`
  交给原生分享面板，通过“存储图像”存入图库；旁边也提供普通文件下载。

## 编辑界面文案

页面两种语言的文案集中在 `src/i18n.js`。
`index.html` 的元素通过 `data-i18n` 键，在加载时及切换语言时填入文案。

```bash
uv run python -m http.server -d web 8000   # 编辑 src/i18n.js 后重新加载
node tests/web/check-i18n.mjs       # 修改后检查
```

检查器会发现两类通常在切换语言后才出现的问题：只在一种语言新增键，
以及 `index.html` 使用了已经不存在的键。

新增第三种语言需要在 `STRINGS` 添加相同键的语言区块；当前按钮只在两种语言间切换，
因此还需小幅修改 `app.js` 的切换逻辑。

## 正确性验证

浏览器移植与 Python 实现进行对照：

```bash
node tests/web/compare.mjs        # 网站加载的模块
node tests/web/compare_bundle.mjs # 合并后的 artifact 模块
node tests/web/generic-graft.mjs  # 42/0、40/0、36/0 主图负载保留
node tests/web/legacy-skin.mjs    # 两个 donor、缺少皮肤、PNG 导入与原生升级
node tests/web/check-pwa.mjs      # manifest、图标与离线资源清单
```

```
sample-1: BYTE-IDENTICAL (2436545)
sample-2: BYTE-IDENTICAL (1819103)
sample-3: BYTE-IDENTICAL (1867038)
sample-4: EQUIVALENT (styles plist repacked, all items match)
sample-5: EQUIVALENT (styles plist repacked, all items match)
sample-6: EQUIVALENT (styles plist repacked, all items match)
native-1 add-texture: BYTE-IDENTICAL (3955304)
native-2 add-texture: BYTE-IDENTICAL (1562445)
native-3 add-texture: BYTE-IDENTICAL (1977002)
native-4 add-texture: BYTE-IDENTICAL (2002601)
```

前三份移植结果逐字节一致；另外三份只在 styles plist 的序列化布局上不同，
因为 `plistlib` 与这里的 bplist 写入器排列对象的方式不同。
该项目按语义比较：每个键和值都相同，包括二进制 `c`／`d` 图；其他项目逐字节一致。

照片样本只保存在本机。测试使用 Git 忽略的 `tests/private-fixtures/` 目录中的通用文件名；
请按各测试指定的文件名与图像布局提供样本。对照测试的参考输出可用以下命令生成：

```bash
uv run photographic_style_port.py patch IN.HEIC tests/web/ref/NAME_ref.HEIC \
  --linear-thumb reuse-thumbnail --scene-stats donor --light-maps flat
uv run photographic_style_port.py add-texture Smartstyle/NAME.HEIC tests/web/ref/NAME_addtex_ref.HEIC
```

四份 `add-texture` 样本覆盖原生照片模式（`src/texture.js`）：iPhone 16／17 风格照片
加入 iOS 27 质感／颗粒，必要时将旧 styles plist 升级为 v16，并加入恒等 tone curve。
这避免了在原生参考照片中重现并经手机验证的“光晕／底片”近黑结果。
JavaScript 输出必须与 Python 对应。

## 文件结构

| 文件 | 用途 |
|---|---|
| `src/box.js` | ISO-BMFF box 读写 |
| `src/heif.js` | `iloc`／`iinf`／`iref`／`ipma`／`ipco` 项目图结构的发现与修改 |
| `src/native-mattes.js` | 内嵌 iPhone 18 语义遮罩的只读 WebCodecs 查看器 |
| `src/raster-import.js` | 本机 Canvas／WebCodecs PNG／JPEG／WebP 转 HEIC 编码与容器组装 |
| `src/linear-thumbnail.js` | P3 线性化与 8-bit 辅助图编码 |
| `src/raster-color.js` | 显式 P3／sRGB RGB 转 I420，以及 HEIC 色彩标记 |
| `src/bplist.js` | Apple 二进制 plist 读写 |
| `src/exif.js` | 注入 MakerNote `0x54`，保留来源 Exif |
| `src/styles.js` | 场景统计、`c`／`d` 光照图与人物遮罩提示 |
| `src/zip.js` | 通过 `DecompressionStream` 读取 donor 配置 |
| `src/port.js` | 移植流程 |
| `src/texture.js` | iOS 27 质感／颗粒（texture_styles 与 2026 遮罩）及原生照片写入 |
| `src/decode.js` | 通过回调提供的可选 libheif 解码 |
| `profiles/` | 从 Python 构建导出的两个 donor 配置 |

`src/port.js` 通过回调使用解码器，使容器修改独立于 libheif，
也让 `port.js` 可在 Node 下不修改地运行对照测试。

## 布局支持与限制

两个精确 donor 图结构仍是 48/12 与 45/15，匹配的来源直接使用对应配置。
主图布局匹配、HDR 增益图为单个独立 `hvc1` 项目时也支持：
浏览器逐字节保留该增益图负载、编码配置、尺寸、方向与辅助关联。

其他许多含 1–48 个主图图块的来源，会选择主图槽足够、分块 HDR 数量相同的 donor 进行通用移植。
来源主图／HDR 负载保留，只创建缺少的辅助图。
例如 42/15 使用 45/15 donor，并移除三个未使用的主图槽。
这不是重建所有不透明 Apple 配置数据的公式，而是经过结构检查的明确图结构改写，
并复用 donor 风格元数据与中性差异图块。
未知分块 HDR 图结构、超过 48 个主图图块、缺少 Apple Exif、不支持的 HEIF box 布局，
以及没有缩略图且方向变换不是恒等的组合，会尽可能使用兼容重编码；否则显示明确错误。

来源需要兼容重编码且包含 Apple 人像深度辅助图时，回退流程会保留其原始 HEVC 位流、尺寸、
编码／方向属性、`auxl` 关联，以及附属的 XMP 虚化元数据，不会直接丢弃深度图。
