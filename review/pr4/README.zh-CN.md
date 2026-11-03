# Photographic Style Port

[English](README.md) | **简体中文**

版本：v0.6.0

注意这是一个实验性工具：它为 **iPhone 16 之前**的 iPhone（iPhone 15、14、13 …… 只要照片符合受支持的
tile 布局即可）拍摄的 HEIC 照片补上 iPhone 16/17 照片所携带的元数据，让编辑照片时，呈现 **摄影风格**（俗称“调色盘”）。

不限 iPhone，任何手机、相机拍摄的照片以及截屏，都可通过支持的 HEIC、PNG、JPEG、WebP 格式
在本机处理。实际可用的处理路径取决于图像结构与编解码支持。

从 v0.5 开始，加入了随 iPhone 18 Pro 推出的 **iOS 27 质感/颗粒**（Texture/Grain）调节入口。
移植的照片会在移植时一并加上；原生的 iPhone 16/17 照片还会补上 iOS 27“光晕／底片”所需的
v16 风格结构与恒等 tone curve。主图、HDR 及原生场景／人物统计保持不变。

这是独立的实验性 HEIC 互操作工具，不是 Apple 官方支持的格式转换器。它通过读取并改写照片文件的
ISO-BMFF item 结构来工作，完全是个人出于愤怒开发，并 vibecoding 而来，与 Apple 没有任何关系。

**请务必保留原图。**

## 0.5.0 → 0.6.0 更新

- **扩展 HEIC 布局支持。** 从匹配 48/12、45/15 配置扩展到许多含 1–48 个主图图块的布局，
  支持独立 HDR 及补生成缺少的辅助图；可安全转接时保留原始主图与可兼容的 HDR 压缩数据。
  无法安全转接的照片尽可能使用本机兼容重编码。
- **新增 PNG／JPEG／WebP 导入。** 支持任何手机、相机拍摄的照片及截屏，按来源尺寸生成 HEIC，
  不为匹配 donor 分辨率而放大照片；保留可用的来源 Exif、方向及拍摄信息。
- **新增实验性本机遮罩生成。** 使用 MediaPipe 生成近似的人物／皮肤遮罩、人物实例、
  特征点与逐脸数据，并可补生成缺少的人像效果遮罩。已有来源遮罩与人像深度优先保留。
- **新增网页人脸校正。** 可通过人脸框与缩略图保留或排除本次检测的人脸；应用后更新同一张
  结果卡片，复用首次推理与已编码的主图，不重复添加结果。
- **新增内嵌资料对照。** 按统一清单显示处理前后的图像、遮罩与元数据，提供译名、技术名称、
  差异原因及下载，区分编码数据、属性和图像关联的变化。
- **改善结果卡片与进度。** 显示原图及输出缩略图，失败时仍能辨认照片；提供输出小图长按存储、
  文件下载与可用时的“照片”分享。耗时按步骤独立计量，并分别显示模型准备、检测、分割与各遮罩生成。
- **新增网页独立线性缩略图。** 使用浏览器 WebCodecs 生成 8-bit HEVC Main 的 P3 线性缩略图，
  Python/CLI 保留原有的 10-bit HEVC Main10 编码；已有原生线性缩略图继续保留。
- **扩展 Python/CLI 与维护工具。** 将可变 HEIC 布局、一般图片导入及本机遮罩生成扩展到 CLI，
  更新依赖与可执行文件打包，补充回归测试、缓存版本检查、双语文档及本机 HTTP／HTTPS 工具。
  私人照片、测试样本与本机证书保留在 Git 忽略的目录中。

## 已知问题

- “柔肤”仍需要更多带有人物的原生 iPhone 18 照片来逆向分析。网页版现已提供实验选项：
  在本机识别人脸，并在浏览器具备 HEVC WebCodecs 编码器时写入近似的皮肤/人物遮罩、覆盖率与统计、
  人物实例遮罩和原生结构的逐脸数据。推理不可用时，可继续完成的路径会保留空语义遮罩；需要新编码
  图像的路径仍必须有 HEVC 编码器。生成的数据尚未验证能与 Apple 的柔肤行为一致。

- 有反馈声称，经过移植的照片用同样的调色盘参数调整后，与原生机型自带的风格微调效果并不完全一致。也需要更多样本来进一步研究这个问题。

- `swift-port` 分支中的独立 iOS 应用仍在开发中，等到我的新 Mac 到货后才会推出。

## 在浏览器中使用

[![Web app visits](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fabacus.jasoncameron.dev%2Fget%2Fnathanatgit-shalielie%2Fweb&query=%24.value&label=web%20app%20visits&style=flat-square)](https://nathanatgit.github.io/Shalielie/)

网页版为纯前端处理，支持 PWA，可添加到主屏幕，无需命令行。选取照片后会自动按队列处理，
全部处理都在当前设备上完成，照片不会上传。

**https://nathanatgit.github.io/Shalielie/**

本机开发可运行 `uv run tools/serve_web.py`，在同一台电脑打开 `http://localhost:8000/`，
无需生成或安装本机证书。iPhone 测试可使用托管网站，或按
[`web/README.zh-CN.md`](web/README.zh-CN.md#部署) 配置受信任的本机 HTTPS；浏览器编码仍要求安全环境，
localhost 的 HTTP 可用，普通区网 IP 的 HTTP 不具备相同条件。

每张照片的卡片都会保留原图缩略图，失败时也能辨认是哪张照片。成功后提供可在支持的浏览器中
长按存储的输出 HEIC 小图、下载、可用时的“照片”分享，以及“对照全部内嵌资料”。本次生成的人脸
可通过“校正人脸”排除；应用后更新同一张卡片，复用首次推理与已编码的主图。

网页版包含质感/颗粒功能、原生照片模式，以及实验性本机人脸／皮肤／人物遮罩生成。
网页版现在可以转接许多含 1–48 个
主图图块的 HEIC 图结构（已测试 42/0、40/0、36/0 与 42/15），并逐字节保留全部原始主图及可对应的
分块 HDR HEVC 负载；只生成
缺少的缩略图／HDR 辅助图。无法安全对应的图结构才会改走本机兼容重编码。
网页版也可实验性导入 PNG、JPEG 与 WebP（包括截屏）：Canvas 在浏览器内解码，
WebCodecs 编码新的分块 HEVC 主图，再由网页本机组装摄影风格 HEIC。此路径不使用 Windows/Python
后端，也不会上传文件；tile grid 会依来源尺寸动态计算，能容纳在 48 个图块内的图像不会被放大到 donor
分辨率。它需要浏览器提供 HEVC 编码，并与保留原像素的 HEIC 元数据移植路径分开。

当前网页版**不加载、也不附带 FFmpeg WASM**。新 HEVC 图像由浏览器 WebCodecs 编码；
新生成的线性缩略图使用 **8-bit HEVC Main**，再由 JavaScript 写入 P3 线性 SPS 色彩标记，
不重新编码图像数据。Python/CLI 使用本机 FFmpeg/libx265 生成 **10-bit HEVC Main10** 线性缩略图。
已有摄影风格的原生照片保留其原有线性缩略图。

模型准备使用 MediaPipe Tasks Vision/WASM、人脸特征点模型与 SelfieMulticlass 分割模型，
与 FFmpeg 无关。首次使用会下载并初始化所需运行环境和模型，同一页面后续照片会直接复用。
重新加载页面仍需创建模型实例，即使下载命中了浏览器缓存。关闭实验性人脸选项时，
补生成缺少的人像效果遮罩仍可能使用人物分割模型。

进度时间是各步骤的独立耗时，包括逐项生成遮罩；不足一秒时显示毫秒。
内嵌资料对照显示译名和技术名称（如 `semantichairmatte`），外层进度只显示译名。
对照会检查编码数据、设置、属性顺序及图像关联；复用的遮罩像素仍可能有不同的关联或设置，
这些变化会如实列出。

两个版本使用相同的移植逻辑，确定性的元数据路径经过逐字节对照；新线性缩略图的位深与平台相关
推理／编码有所不同。浏览器要求、验证与 iPhone 存储方式见 [`web/README.zh-CN.md`](web/README.zh-CN.md)。

## 下载可执行文件

[![Release downloads](https://img.shields.io/github/downloads/nathanatgit/Shalielie/total?label=release%20downloads&style=flat-square)](https://github.com/nathanatgit/Shalielie/releases)

每个带版本标签的发行版提供无需安装 Python 的命令行可执行文件，支持：

- Windows x86-64
- Linux x86-64
- macOS x86-64（Intel）
- macOS arm64（Apple 芯片）

从 GitHub Releases 页面下载对应系统的压缩包，解压后运行 `photographic-style-port`（Windows 上为
`photographic-style-port.exe`），执行：

```bash
photographic-style-port patch IN.HEIC OUT.HEIC
```

可执行文件内置了 Python 运行时和两个内置 donor 配置；用 `--version`
查看当前版本。

默认的 patch 模式经过手机验证，仍会调用 `ffmpeg` 和 `heif-convert`。如果想完全独立运行，
请使用已验证的免编码器模式：

```bash
photographic-style-port patch IN.HEIC OUT.HEIC \
  --linear-thumb reuse-thumbnail --scene-stats donor --light-maps flat \
  --faces off --portrait-matte off
```

`Build binary release` GitHub Actions 工作流会在推送版本标签或手动运行时，
构建并执行四个平台的冒烟测试。

## 从源码安装

需要 **Python 3.12+**。最省事的方式是用 [uv](https://docs.astral.sh/uv/)：

```bash
git clone https://github.com/nathanatgit/Shalielie.git
cd Shalielie
uv sync --extra faces
```

默认模式还需要两个外部工具——用于编码的 `ffmpeg`（需带 libx265），以及用于解码的
`heif-convert`（libheif）：

| 系统            | 安装方式                                                  |
| --------------- | --------------------------------------------------------- |
| Debian / Ubuntu | `sudo apt install ffmpeg libheif-examples`                |
| macOS           | `brew install ffmpeg libheif`                             |
| Windows         | `winget install Gyan.FFmpeg`，再把本仓库的 `tools/` 加入 PATH |

Windows 上没有 libheif 包，所以 `tools/` 附带了一个基于 pillow-heif 的 `heif-convert` 替代品，
`uv sync` 会自动安装所需依赖：

```powershell
$env:PATH = "$PWD\tools;$env:PATH"
```

如果使用[免编码器模式](#免编码器模式)，这两个工具都不需要。

Python/CLI 已同步网页的处理路径：可变 HEIC 图块、独立或缺少的 HDR、补缩略图、
PNG/JPEG/WebP 导入，以及本机人物／皮肤遮罩。新生成的线性缩图在 Python/CLI 保持
**10-bit HEVC Main10**，网页版保持 **8-bit HEVC Main**；两者都写入实际的 Display P3
线性像素及对应色彩标记。`faces` 可选依赖提供 MediaPipe，首次使用会下载两个模型到本机缓存，
也可用 `--model-dir PATH` 指定已有模型离线使用。照片不会上传。未安装该依赖时会提示并回退；
`--faces off --portrait-matte off` 可完全关闭模型使用。

## 用法

```bash
uv run photographic_style_port.py patch INPUT.HEIC OUTPUT.HEIC
```

把输出文件拷到 iPhone，在“照片”中打开——点“编辑”后应该就能看到风格调色盘，iOS 27 上还会有质感/颗粒。
请以**文件**形式传输输出，以保留 HEIC 元数据。从照片图库选取时，选择“选项 → 格式 → 当前”
（繁体界面为“目前”），避免自动转换格式。

`patch` 会根据照片自动决定怎么处理：

| 照片                                   | 处理方式                                    |
| -------------------------------------- | ------------------------------------------- |
| 没有风格数据（iPhone 16 之前的机型）   | 完整移植，并加上质感/颗粒                   |
| 有原生风格数据（iPhone 16/17）         | 添加质感/颗粒，并升级为 iOS 27 v16 风格结构 |
| 已经有质感/颗粒（iPhone 18）           | 不会重写；网页版可检视照片内嵌的语义遮罩    |

`add-texture IN.HEIC OUT.HEIC` 可以显式执行第二种处理。

常用参数：

| 参数                               | 用途                                                  |
| ---------------------------------- | ----------------------------------------------------- |
| `--report`                         | 额外写出 `OUTPUT.HEIC.report.json`，记录改动内容      |
| `--zip`                            | 把 HEIC 和报告打包成 `OUTPUT.zip`，方便传输           |
| `--light-maps target`              | 根据你的照片重建色调图——最可能改善效果的参数          |
| `--scene-stats donor`              | 颜色看起来不对时，改用 donor 的色调锚点               |
| `--linear-thumb reuse-thumbnail`   | 将内嵌缩略图复用于线性辅助图                           |
| `--texture off`                    | 不添加 iOS 27 质感/颗粒项（即 v0.4.4 的输出）         |
| `--faces off`                      | 跳过本机人脸／皮肤／人物遮罩生成                      |
| `--portrait-matte off`             | 跳过补生成人像效果遮罩                                |
| `--model-dir PATH`                 | 指定已有的 MediaPipe 模型缓存                         |

默认只写出输出的 HEIC 文件，运行摘要会打印在终端中；如果还想保存为 JSON，请加 `--report` 或 `--zip`。

原生语义遮罩、人像效果遮罩和深度会保留完整编码与几何属性；原生旧版皮肤遮罩也会补到缺少的 v2。
缺少的人像效果遮罩可由本机人物分割生成，推理不可用时移除 donor 占位图。
生成的是近似遮罩，不是相机深度数据。

### 免编码器模式

```bash
uv run photographic_style_port.py patch IN.HEIC OUT.HEIC \
  --linear-thumb reuse-thumbnail --scene-stats donor --light-maps flat \
  --faces off --portrait-matte off
```

当 HEIC 已有可对应的主图／HDR 图结构和缩略图时，即使 **ffmpeg 和 heif-convert 都不存在**也能运行。
补 HDR／缩略图、一般图片导入及兼容重编码仍需要编解码器。复用缩略图会保留其原有位深。

### 其他命令

```bash
uv run photographic_style_port.py profiles              # 列出内置的 donor 配置
uv run photographic_style_port.py inspect PHOTO.HEIC    # 以 JSON 输出与风格相关的元数据
uv run photographic_style_port.py extract-donor DONOR.HEIC PROFILE.zip
```

`extract-donor` 用于为尚无内置配置的 tile 布局添加支持。

## 通过 AI 智能体使用

CLI 无需交互，报告采用 JSON，方便编程智能体调用。本仓库在
[skills/photographic-style-port/](skills/photographic-style-port/) 中提供了一个现成的 skill。

**Claude Code**——把它复制到你的 skills 目录：

```bash
# 仅当前项目
mkdir -p .claude/skills && cp -r skills/photographic-style-port .claude/skills/

# 或全局可用
mkdir -p ~/.claude/skills && cp -r skills/photographic-style-port ~/.claude/skills/
```

然后正常提问即可——比如 *“给这些照片加上摄影风格”*——智能体会自动加载这个 skill。

**其他智能体**（Cursor、Codex、Copilot、Continue）：skill 文件就是普通的 Markdown。在智能体的规则文件
中引用它，或把内容粘贴进 `AGENTS.md` / `.cursorrules`。

这个 skill 会告诉智能体：根据已安装的工具选择模式，批量处理时逐个文件进行，不覆盖原图。

## 它实际工作原理

安全转接的 HEIC 会保留主图与原有 HDR 压缩数据和显示属性；Exif 会补上风格标记。
一般图片导入或不支持的 HEIC 图结构会本机重编码，并在报告中注明。
修改照片Metadata，添加的是“照片” App 所需的风格相关数据：来自归一化 donor 配置的风格 plist 和 Apple MakerNote 标签
`0x54`，以及根据你自己的照片计算出的 `linearthumbnail`、场景统计和光照图。对于质感/颗粒，它会添加
iOS 27 的 `texture_styles` 项和 12 个 2026 语义遮罩。本机推理可填入近似遮罩和逐脸数据；
不可用时使用空语义遮罩，并移除 donor 人像效果占位图。

## 限制

- **内置的主图／HDR grid 配置为 48/12 和 45/15。** 如果主图布局相符，而 HDR 增益图是单个独立的
  `hvc1` item，同样可以处理；程序会逐字节保留原始压缩增益图及其编码属性，不会切块或重新编码。自 v0.5 起支持没有内嵌缩略图的照片，但需要使用
  默认（编码器）模式。
  两个版本都提供实验性的图结构转接器，可处理许多含 1–48 个主图图块的布局；HDR 图块数量能与现有
  donor 对应时也会原样保留。无法对应的布局会兼容重编码，并在报告中注明。
- **质感/颗粒需要打开照片的手机运行 iOS 27。**
- **未经 Apple 验证，效果因照片而异。** 在放弃之前，可以请先试试上面的不同的运行参数。
- **生成的遮罩是近似数据。** MediaPipe 不会复现 Apple 私有分割或生成相机深度；柔肤效果仍需手机验证。

## 免责声明

本项目与 Apple Inc. **没有任何关联，也未获得其授权、赞助或认可**。

Apple、iPhone、Apple Photos 和 Photographic Styles 是 Apple Inc. 的商标，此处仅用于描述本工具与之
互操作的对象。本项目不包含、也不再分发任何 Apple 软件、源代码或 SDK。

本工具会改写照片文件。它是实验性的，从未经过 Apple 验证，生成的文件在任何照片应用中都可能出现不可预期的
行为。请在副本上操作。

## 许可证

[MIT](LICENSE)。许可证仅涵盖本项目自身的源代码，不对上文提到的任何第三方格式、商标或元数据结构主张权利。

## Why Shalielie？

Shalielie 是中文“瞎咧咧”的发音转写。此仓库的初衷是为了怼某个评论区 Apple “精神股东”——
那些像持有 Apple 股份一样为其每个决定辩护的粉丝。例如：

> “Apple 不给老机型开放摄影风格调色盘，是因为 Apple 想提供更好、更一致的用户体验。”
>
> “瞎咧咧 🙄。”
