# Photographic Style Port

[English](README.md) | **简体中文**

当前版本：v0.7.0

注意这是一个实验性工具：它为 **iPhone 16 之前**的 iPhone（iPhone 15、14、13 …… 只要照片符合受支持的
tile 布局即可）拍摄的 HEIC 照片补上 iPhone 16/17 照片所携带的元数据，让编辑照片时，呈现 **摄影风格**（即 Apple 官方所称的“调色板”）。

从 v0.5 开始，加入了随 iPhone 18 Pro 推出的 **iOS 27 质感/颗粒**（Texture/Grain）调节入口。
移植的照片会在移植时一并加上；原生的 iPhone 16/17 照片只添加这两个入口相关元数据，原有的图像数据逐字节不变。

此工具不是 Apple 官方的格式转换器。它通过读取并改写照片文件的ISO-BMFF item 结构来工作，完全个人开发，由愤怒驱动，并 vibecoding 而来，与Apple没有任何关系。

**请务必保留原图。**

**请务必保留原图。**

**请务必保留原图。**

## 项目当前状态

本工具目前处于 **可用性验证阶段** ，当前目标是让旧款 iPhone 拍摄的照片能够启用摄影风格调色板，目前版本已初步可以让 iOS26/iOS27 的旧机型（iPhone 12~15 系列）具备调色板功能：调色板可以正常出现，风格与各项调节能够正确生效，编辑后可以正常保存和再次打开。

风格调节效果、以及质感/颗粒的细节效果微调，将在主体工作完成后进行，使其更接近新款 iPhone 原生**摄影风格**的调节表现。在此之前，与原生照片存在差异属于预期情况。欢迎反馈问题和提供样图。

**目录：** [网页版](#在浏览器中使用) · [可执行文件](#下载可执行文件) · [从源码安装](#从源码安装) · [用法](#用法) · [工作原理](#工作原理) · [已知问题与限制](#已知问题与限制) · [测试移植结果](#测试移植结果for-ai-testing) · [版本历史](#版本历史) · [AI 智能体](#通过-ai-智能体使用) · [开发者工具](#开发者工具)

## 在浏览器中使用

[![Web app visits](<https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fabacus.jasoncameron.dev%2Fget%2Fnathanatgit-shalielie%2Fweb&query=%24.value&label=web%20app%20visits&style=flat-square>)](https://nathanatgit.github.io/Shalielie/)

网页版为纯前端处理，支持 PWA ，可直接通过 Safari 分享按钮分享到主屏幕，无需安装、无需命令行。把照片拖如待放区，即可得到输出。它完全在你的设备上运行，不会上传任何内容。

**https://nathanatgit.github.io/Shalielie/**

网页版包含 v0.5 的质感/颗粒功能和原生照片模式。但前端脚本没有办法处理无内嵌缩略图（`thmb`）的照片（浏览器没有 HEVC 编码器，无法生成缩略图），这类照片请使用命令行工具。

网页版与 命令行/Python 工具使用同一套移植逻辑，见 [`web/README.md`](web/README.md)。
批量处理或需要基于编码器，需要生成内嵌缩略图时请用 命令行/Python 版本。

## 下载可执行文件

[![Release downloads](<https://img.shields.io/github/downloads/nathanatgit/Shalielie/total?label=release%20downloads&style=flat-square>)](https://github.com/nathanatgit/Shalielie/releases)

下载时请对应平台，可执行文件支持：

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

默认的 patch 模式仍会调用 `ffmpeg` 和 `heif-convert`。如果想完全独立运行，
请使用已验证的免编码器模式：

```bash
photographic-style-port patch IN.HEIC OUT.HEIC \
  --linear-thumb reuse-thumbnail --scene-stats donor --light-maps flat
```

`Build binary release` 由 GitHub Actions 工作流自动生成。

### 拖放使用

把 HEIC 照片（或装有照片的文件夹）拖到 `photographic-style-port.exe` 上即可（也可以不带命令、直接传入文件路径）。每张 HEIC 会在原图旁边生成 `文件名_PhotographicStyle.HEIC`；iPhone 16/17 拍摄的照片生成 `文件名_TextureGrain.HEIC`。JPEG、PNG 等其他文件会被跳过，已有文件不会被覆盖，处理结束后会列出每个文件的结果。

**实况照片。** 把 HEIC 和它的 MOV 一起拖进来。同一文件夹中同名的 HEIC 和 MOV 会一起处理，视频以相同的新文件名保存（`文件名_PhotographicStyle.HEIC` + `文件名_PhotographicStyle.MOV`）。iOS 27 的照片 App 会把风格同时应用到视频上，而视频若缺少原生 iOS 27 视频里的风格轨道和定时元数据，编辑器就会崩溃，所以工具会补上这些内容。没有同名 HEIC 的 MOV 会被跳过。如果只拖入一个 HEIC 和一个 MOV 且文件名不同，会给出提示，但仍作为同一张实况照片处理，视频改用照片的实况照片 ID。处理视频需要 `ffmpeg`（含 libx265）；没有它时照片会保存为静态照片。

可执行文件**不包含** HEVC 编码器。若 PATH 中有 `ffmpeg` 和 `heif-convert`，拖放时使用完整模式；否则使用免编码器模式，可处理 iPhone 原图，但无法处理没有内嵌缩略图的副本。

## 从源码安装

需要 **Python 3.12+**。推荐使用 [uv](https://docs.astral.sh/uv/)：

```bash
git clone https://github.com/nathanatgit/Shalielie.git
cd Shalielie
uv sync
```

默认模式还需要两个外部工具——用于编码的 `ffmpeg`（需带 libx265），以及用于解码的
`heif-convert`（libheif）：

| 系统            | 安装方式                                                          |
| --------------- | ----------------------------------------------------------------- |
| Debian / Ubuntu | `sudo apt install ffmpeg libheif-examples`                      |
| macOS           | `brew install ffmpeg libheif`                                   |
| Windows         | `winget install Gyan.FFmpeg`，再把本仓库的 `tools/` 加入 PATH |

Windows 上没有 libheif 包，所以 `tools/` 附带了一个基于 pillow-heif 的 `heif-convert` 替代品，
`uv sync` 会自动安装所需依赖：

```powershell
$env:PATH = "$PWD\tools;$env:PATH"
```

如果使用[免编码器模式](#免编码器模式)，这两个工具都不需要。

## 用法

```bash
uv run photographic_style_port.py patch INPUT.HEIC OUTPUT.HEIC
```

把输出文件拷到 iPhone，在“照片”中打开——点“编辑”后应该就能看到风格调色板，iOS 27 上还会有质感/颗粒。
请以**文件**形式传输，不要通过照片图库：图库会把 HEIC 重新编码为 JPEG，并去掉本工具添加的所有内容。

`patch` 会根据照片自动决定怎么处理：

| 照片                                 | 处理方式                                |
| ------------------------------------ | --------------------------------------- |
| 没有风格数据（iPhone 16 之前的机型） | 完整移植，并加上质感/颗粒               |
| 有原生风格数据（iPhone 16/17）       | 只添加质感/颗粒，原有图像数据逐字节不变 |
| 已经有质感/颗粒（iPhone 18）         | 拒绝处理，无需操作                      |

`add-texture IN.HEIC OUT.HEIC` 可以显式执行第二种处理。

常用参数：

| 参数                               | 用途                                              |
| ---------------------------------- | ------------------------------------------------- |
| `--report`                       | 额外写出`OUTPUT.HEIC.report.json`，记录改动内容 |
| `--zip`                          | 把 HEIC 和报告打包成`OUTPUT.zip`，方便传输      |
| `--light-maps target`            | 根据你的照片重建光照图——最可能改善效果的参数    |
| `--scene-stats donor`            | 颜色看起来不对时，改用 donor 的色调锚点           |
| `--linear-thumb reuse-thumbnail` | 完全跳过编码器                                    |
| `--texture off`                  | 不添加 iOS 27 质感/颗粒项（即 v0.4.4 的输出）     |

默认只写出输出的 HEIC 文件，运行摘要会打印在终端中；如果还想保存为 JSON，请加 `--report` 或 `--zip`。

人像数据（语义遮罩和深度）在照片中存在时会自动保留。

### 免编码器模式

```bash
uv run photographic_style_port.py patch IN.HEIC OUT.HEIC \
  --linear-thumb reuse-thumbnail --scene-stats donor --light-maps flat
```

在 **ffmpeg 和 heif-convert 都不存在**的情况下也能运行：它直接复用照片自带的缩略图，而不是重新编码。画质上的细节优化少一些，但无需任何配置，而且在不同机器上输出逐字节一致、可复现。

### 其他命令

```bash
uv run photographic_style_port.py profiles              # 列出内置的 donor 配置
uv run photographic_style_port.py inspect PHOTO.HEIC    # 以 JSON 输出与风格相关的元数据
uv run photographic_style_port.py extract-donor DONOR.HEIC PROFILE.zip
```

`extract-donor` 用于为尚无内置配置的 tile 布局添加支持。

## 工作原理

照片的像素不会被改动，主图像、HDR 增益图、缩略图和 Exif 都来自你的照片（Exif 中仅插入 `0x54`），解码后的输出与输入逐像素一致。
修改照片Metadata，添加的是“照片” App 所需的风格相关数据：来自归一化 donor 配置的风格 plist 和 Apple MakerNote 标签
`0x54`，以及根据你自己的照片计算出的 `linearthumbnail` 和场景统计（加 `--light-maps target` 时光照图也由照片计算）。对于质感/颗粒，它会添加
iOS 27 的 `texture_styles` 项，以及随之出现的 12 个 2026 语义遮罩（质感/颗粒必需）。对于带人物的照片（有人脸区域，以及 Apple 的皮肤遮罩和人像遮罩），其中的皮肤和人物遮罩会使用照片自己的遮罩，`texture_styles` 也会加入“柔肤”所需的逐张人脸数据，因此“柔肤”可以生效。

写入的每一项元数据是什么、从哪里来、是否已在真机上验证，都记录在 **[facts.md](facts.md)** 中（英文）。

## 已知问题与限制

- **“柔肤”需要照片里本身带有 Apple 的人物数据**：人脸区域、皮肤遮罩和人像遮罩（人像模式照片和 iPhone 16 及以后机型拍的人物照片都有）。本工具不会自行检测人脸，所以缺少这些数据的照片，“柔肤”仍与“标准”看起来一样。侧脸角度较大（约 30° 以上）时，生成的人脸数据会不太准确。
- 有反馈声称，经过移植的照片用同样的调色板参数调整后，与原生机型自带的风格微调效果并不完全一致。也需要更多样本来进一步研究这个问题。
- **支持 1200 万、2400 万、4800 万像素和前置摄像头照片**，不限 tile 布局：风格数据直接加入照片自己的文件结构，
  只需要知道该尺寸的 delta map 大小。其他尺寸仍回退到两种内置布局（48/12 和 45/15）。
  没有内嵌缩略图的照片需要使用默认（编码器）模式。
- **质感/颗粒需要打开照片的手机运行 iOS 27。**
- **无法把普通照片变成“人像”照片。** 人像数据只会从照片本身复制，绝不会凭空生成。
- **未经 Apple 验证，效果因照片而异。** 在放弃之前，可以请先试试上面的不同的运行参数。
- swift-port 分支中的独立 iOS 应用仍在开发中，等到我的新 Mac 到货后才会推出。

未解决的元数据问题（仍来自 donor 的数值等）记录在 [facts.md](facts.md) 中。

## 测试移植结果(For AI testing)

看到调色板只说明“照片” App 认出了这是一张可调风格的照片。移植成功需要满足以下全部条件：

1. 出现调色板。
2. 切换风格时照片有明显变化。
3. 色调和色彩调节对照片有明显影响。
4. 保存、重新打开、再次编辑都正常。
5. 没有跟随另一张照片区域分布的色块。
6. 主图像逐像素一致，没有方块状损坏。
7. 没有出现不该有的选项（比如没有深度数据的照片出现人像选项）。
8. 有人物的照片中，人物和背景能分别响应调节。
9. iOS 27 上出现质感/颗粒；原图有人像数据时，人像也可用。

每次只改一个变量，并与上一个可用版本对比；测试文件请以**文件**形式传输。

跨机器比较时，请比较文件结构而不是整个文件的 SHA：不同的 x265 版本编码出的 `linearthumbnail` 不同。
只有免编码器模式能做到逐字节可复现，`tests/web/compare.mjs` 也是用它来检查网页版的。

## 版本历史

✅ 已在真机验证 · ☑️ 已在文件层面或通过统计校准验证 · 🔍 有待研究。
“V” 开头的是首个版本发布前的实验。

| 阶段        | 尝试内容                                                       | 结果                                             |
| ----------- | -------------------------------------------------------------- | ------------------------------------------------ |
| 初始        | 照搬 donor 的整个结构                                          | 调色板取决于文件数据，而非机型                   |
| V4          | 单位化（identity）的风格元数据                                 | 调色板和编辑可用 ✅                              |
| V5          | 合成的辅助图像                                                 | 出现调色板，但编辑无效                           |
| V6          | 对`linearthumbnail` 做 A/B                                   | `linearthumbnail` 是关键项                     |
| V7          | 合成`linearthumbnail`，沿用 donor 的 `hvcC`                | 全部失败                                         |
| V8          | 合成`linearthumbnail`，**配上它自己的 `hvcC`**       | 4 个变体全部可用 ✅                              |
| v0.1        | donor 配置；`linearthumbnail` 与 `hvcC` 匹配               | 第一个固定基线                                   |
| v0.1.1      | 照片的`hvcC` + `colr` 随 tile 一起迁移                     | 方块状损坏消失 ✅                                |
| V9 / v0.1.2 | Exif A/B；只写入`0x54`                                       | `0x54` 必需；不再带入 donor 的拍摄状态 ✅      |
| V10         | 计算得出的光照图 vs 平坦光照图                                 | 都可用；donor 区域残影仍在 ✅                    |
| V11 / v0.2  | 中性 delta map、平坦光照图、单位化系数                         | 完整编辑流程可用；donor 区域残影消失 ✅          |
| v0.2.1      | 模板内嵌进脚本                                                 | 不再需要 donor 文件                              |
| v0.3.0      | 采用照片自身方向；`linearthumbnail` 按存储方向生成；色调统计 | 旋转问题修复 ☑️；统计数值单位有误              |
| v0.3.1      | 统计改用线性光；`--light-maps target`                        | 已校准 ☑️                                      |
| v0.3.2      | 迁移照片自己的语义遮罩；人物遮罩提示设为 1.0                   | 人物和背景可分别调节 ✅                          |
| v0.4.0      | 自动处理语义遮罩                                               | ☑️                                             |
| v0.4.1      | `tmap` 几何信息                                              | Windows 照片中的黑边消失 ☑️                    |
| v0.4.2      | 深度图                                                         | 原图所有辅助图像都得以保留 ☑️                  |
| v0.4.3      | XMP 附属数据；照片自己的 HDR headroom                          | 人像可用 ✅                                      |
| v0.4.4      | `--linear-thumb reuse-thumbnail`                             | 无需编码器 ✅；网页版使用此模式                  |
| v0.5.0      | 质感/颗粒；原生照片模式；缩略图生成                            | 调色板、质感/颗粒和人像可用 ✅；柔肤 🔍          |
| v0.5.1      | 使用照片自己的`tmap` 增益图参数                              | 只有`tmap` 字节变化；像素和数据逐字节一致 ☑️ |
| v0.6.0      | 用照片自己的人脸区域和遮罩实现柔肤；Windows 拖放               | 柔肤可用 ✅（四部分缺一不可，真机 A/B）；无人物照片输出不变 ☑️ |
| v0.6.1      | 未使用的遮罩槽位改为完全空白的帧；`FilmGrainSeed` 按照片计算  | 去掉两处来自 donor 的数据；调色板、风格、人物与柔肤均正常 ✅ |
| v0.6.2      | 风格数据加入照片自己的 item graph；修正 90°/270° 旋转        | 已知尺寸的任意 tile 布局；无缩略图/`tmap` 的照片可用；270° 照片天空和树木的异常发光消失 ✅ |
| v0.6.3      | 4800 万像素照片（8064×6048）加入照片自己的 item graph          | 旧机型的 4800 万像素照片可移植，有无编码器均可 ✅ |
| v0.7.0      | 实况照片：拖入的 HEIC + MOV 一起处理；视频补上 iOS 27 的风格轨道和定时元数据 | iPhone 15 Pro 的实况照片可在照片 App 中编辑，风格和动态效果都在（iOS 27.0.1）✅ |

**针对部分假设的逆向工程测试**

- 针对合成的 `linearthumbnail` 后编辑无效的问题，实际原因是图像数据与 `hvcC` 不匹配，与像素内容无关（V8）。
- 针对主图出现方块状损坏的问题，实际原因是 tile 数据与 `hvcC`/`colr` 不匹配，仅 tile 数量一致并不够（v0.1.1）。
- 针对编辑效果跟随 donor 照片区域分布的问题，实际原因是 donor 的 delta map，与光照图无关（V11）。
- 针对色调统计数值偏高约一倍的问题，实际原因是 Apple 以线性光记录这些统计，而 v0.3.0 写入的是 gamma 编码值（v0.3.1）。
- 针对人物和背景被当作同一图层调节的问题，实际原因是沿用了 donor 的空遮罩，且人物遮罩提示为 -1.0（v0.3.2）。
- 针对加入深度图后人像仍然无效的问题，实际原因是缺少深度图对应的 XMP 附属数据（v0.4.3）。
- 针对只加 `texture_styles` 后整个调色板消失的问题，实际原因是缺少 12 个 2026 语义遮罩，两者必须同时存在（v0.5.0）。
- 针对 iOS 27 质感/颗粒入口的启用条件，实际起作用的是 `texture_styles` 和 2026 语义遮罩；风格数据版本 14 和 8 键的 `0x54` 即可，无需版本 16 和 13 键（v0.5.0）。

## 通过 AI 智能体使用

本仓库在
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

## 开发者工具

| 工具                          | 用途                                                                              |
| ----------------------------- | --------------------------------------------------------------------------------- |
| `inspect`                   | 以 JSON 输出 HEIC 中与风格相关的 item 结构                                        |
| `extract-donor`             | 从原生 iPhone 16/17 照片生成 donor 配置，用于新的 tile 布局                       |
| `tools/style_dump.py`       | 输出 item 结构、Exif 机型信息、MakerNote 标签和风格数据结构，便于对比不同代的照片 |
| `tools/texture_variants.py` | 从 iPhone 18 donor 配置生成质感/颗粒测试配置（见[facts.md](facts.md)）             |
| `tests/web/`                | 检查网页版与 Python 工具的输出是否一致，见[`web/README.md`](web/README.md)       |

## 免责声明

本项目与 Apple Inc. **没有任何关联，也未获得其授权、赞助或认可**。

Apple、iPhone、Apple Photos 和 Photographic Styles 是 Apple Inc. 的商标，此处仅用于描述本工具与之
互操作的对象。本项目不包含、也不再分发任何 Apple 软件、源代码或 SDK。

本工具会改写照片文件。它是实验性的，从未经过 Apple 验证，生成的文件在任何照片应用中都可能出现不可预期的
行为。请在副本上操作。

## 许可证

[MIT](LICENSE)。许可证仅涵盖本项目自身的源代码，不对上文提到的任何第三方格式、商标或元数据结构主张权利。

## Why Shalielie？

此仓库的初衷是为了怼某个评论区 Apple “精神股东”

> “Apple 不给老机型开放摄影风格调色板，是因为 Apple 想提供更好、更一致的用户体验。”
>
> “瞎咧咧 🙄。”
