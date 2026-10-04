# Photographic Style Port

**English** | [简体中文](README.zh-CN.md)

Version: v0.6.0

This is an experimental tool that takes a HEIC from an iPhone **older than the iPhone 16**
(iPhone 15, 14, 13 … — any model whose photos match a supported tile layout) and adds the
metadata an iPhone 16/17 photo carries, so that Apple Photos offers the **Photographic Styles**
palette on it (风格 in Chinese, though most people just call it 调色盘).

Supported HEIC, PNG, JPEG, and WebP photos from any phone or camera, including screenshots,
can also be processed locally. Available routes depend on the image structure and codec support.

Since v0.5 it also adds the **iOS 27 Texture/Grain** controls (质感/颗粒) that Apple introduced
with the iPhone 18 Pro. Ported photos get them as part of the port; native iPhone 16/17 photos
also receive the v16 style schema and identity tone curve that iOS 27 requires for Glow and
Film. Image, HDR and original scene/person measurements remain unchanged.

It is an independent, experimental HEIC interoperability tool, developed out of personal
frustration using vibe coding. It reads and rewrites the ISO-BMFF item graph of photo files
and has no affiliation with Apple or official support as a format converter.

**Keep your originals.**

## Changes from 0.5.0 to 0.6.0

- **Broader HEIC layout support.** Extend the matching 48/12 and 45/15 profiles to many
  layouts with 1–48 primary tiles, standalone HDR, and generation of missing auxiliaries.
  Safely graftable photos retain their original primary and compatible HDR compressed data;
  other photos use local compatibility re-encoding when possible.
- **PNG/JPEG/WebP import.** Support photos from any phone or camera, including screenshots,
  and build HEIC images from the source dimensions without upscaling to the donor resolution.
  Preserve available source Exif, orientation, and capture information.
- **Experimental local mask generation.** Use MediaPipe to generate approximate person/skin
  masks, person instances, landmarks, and per-face data, and fill a missing Portrait effect
  matte. Existing source masks and portrait depth take priority.
- **Browser face correction.** Keep or exclude this run's detections using face boxes and
  thumbnails. Applying a correction updates the existing result card, reuses the initial
  inference and encoded main image, and does not append another result.
- **Embedded-data comparison.** Show input/output images, masks, and metadata in a shared
  inventory with localized labels, technical identifiers, difference explanations, and
  downloads. Distinguish changes to encoded data, properties, and image relationships.
- **Result cards and progress.** Show source and output thumbnails so failed inputs remain
  identifiable. Provide long-press saving, file downloads, and Photos sharing when available.
  Measure each step separately, including model preparation, detection, segmentation, and
  generation of each mask.
- **Independent browser linear thumbnails.** Use WebCodecs to generate 8-bit HEVC Main
  Display P3 linear thumbnails. Python/CLI retains its existing 10-bit HEVC Main10 encoding;
  existing native linear thumbnails are preserved.
- **Python/CLI and maintenance tools.** Extend adaptive HEIC layouts, raster import, and
  local mask generation to the CLI. Update dependencies and executable packaging, and add
  regressions, cache-version checks, bilingual documentation, and local HTTP/HTTPS tools.
  Keep private photos, test fixtures, and local certificates in Git-ignored directories.

## Known issue

- Soft Skin still needs more native iPhone 18 people samples for reverse engineering. The web
  build now has an experimental option that detects faces locally and writes approximate skin and
  person mattes, coverage/statistics, a person-instance mask, and native-shaped per-face metadata
  when the browser exposes an HEVC WebCodecs encoder. Unavailable inference leaves empty semantic
  masks on routes that can still complete; routes requiring newly encoded images need an HEVC
  encoder. Generated data is not yet validated to match Apple's Soft Skin behavior.

- Reports suggest that using the same style settings on ported and native photos does not
  produce identical results. More samples are needed to investigate this issue.

- Standalone iOS app in `swift-port` branch is under construction and is not available until my new mac arrives.
## Use it in a browser

[![Web app visits](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fabacus.jasoncameron.dev%2Fget%2Fnathanatgit-shalielie%2Fweb&query=%24.value&label=web%20app%20visits&style=flat-square)](https://nathanatgit.github.io/Shalielie/)

The browser build needs no install or command line and supports PWA installation on the
home screen. Select a photo to start processing and get the patched one back. It runs
entirely on your machine; nothing is uploaded.

**https://nathanatgit.github.io/Shalielie/**

For local development, run `uv run tools/serve_web.py` and open
`http://localhost:8000/` on the same computer. Local certificates are not needed.
For iPhone testing, use the hosted website or the trusted local HTTPS setup in
[`web/README.md`](web/README.md#deploying). Browser encoding still requires a secure
context, which localhost HTTP provides but plain LAN-IP HTTP does not.

Selecting photos starts an automatic processing queue. Each photo keeps its original thumbnail,
including failed inputs, so an error can be identified visually. Successful cards provide the
output HEIC thumbnail for native long-press saving, download, optional Photos sharing, and
**Compare all embedded data**. Generated face detections can be excluded with **Correct faces**;
applying the selection updates the same card and reuses the first inference and main-image encodes.

The browser build includes Texture/Grain, native-photo mode, and experimental local
face/skin/person matte generation for Soft Skin. The Web build can adapt many 1–48-tile HEIC
graphs—including tested 42/0, 40/0, 36/0, and 42/15 photos—while preserving every original primary
and compatible tiled-HDR HEVC payload byte-for-byte. It generates only missing auxiliaries. Graphs that cannot
be mapped safely still use an explicit local compatibility re-encode.
It can also import PNG, JPEG, and WebP experimentally, including screenshots:
Canvas decodes the source, WebCodecs encodes a new tiled HEVC image, and the page builds the
Photographic Style HEIC locally. The tile grid is computed from the source dimensions, so images
that fit within 48 tiles are not enlarged to the donor's resolution. This path uses no Windows/Python backend and uploads nothing.
It requires a browser with HEVC encoding and is separate from the lossless HEIC metadata path.

The current Web build **does not load or ship FFmpeg WASM**. New HEVC images use the browser's
WebCodecs encoder. New linear thumbnails use **8-bit HEVC Main**; JavaScript sets their P3-linear
SPS colour tags without re-encoding the picture data. Python/CLI uses a locally installed
FFmpeg/libx265 to generate **10-bit HEVC Main10** linear thumbnails. Existing native style
photos retain their original linear thumbnails.

Model preparation uses MediaPipe Tasks Vision/WASM, Face Landmarker, and SelfieMulticlass;
these are separate from FFmpeg. First use downloads and initializes the required runtime/models.
Later photos in the same page reuse the initialized models. Reloading creates new model instances,
even if downloads are served from the browser cache. A missing Portrait effect matte can also
trigger person segmentation when the experimental face option is off.

Progress shows the duration of each step, including individual mask generation, with milliseconds
below one second. The comparison panel shows localized names plus technical identifiers such as
`semantichairmatte`; outer progress uses localized names only. It compares encoded data, settings,
property order, and image associations. Reused mask pixels can still have changed associations or
settings; these are reported rather than labelled completely identical.

Both builds share the porting logic. Deterministic metadata routes are checked byte-for-byte;
new linear-thumbnail bit depth and platform-specific inference/encoding differ. See
[`web/README.md`](web/README.md) for browser requirements, verification, and iPhone saving notes.

## Download a binary

[![Release downloads](https://img.shields.io/github/downloads/nathanatgit/Shalielie/total?label=release%20downloads&style=flat-square)](https://github.com/nathanatgit/Shalielie/releases)

Each tagged release provides a Python-free command-line executable for:

- Windows x86-64
- Linux x86-64
- macOS x86-64 (Intel)
- macOS arm64 (Apple silicon)

Download the archive for your system from the GitHub Releases page, extract it, and run
`photographic-style-port` (`photographic-style-port.exe` on Windows). Simply run

```bash
photographic-style-port patch IN.HEIC OUT.HEIC
```

The executable includes
the Python runtime and both built-in donor profiles; use `--version` to check which release you
have.

The default, phone-validated patch mode still calls `ffmpeg` and `heif-convert`. For a completely
standalone run, use the validated no-encoder mode:

```bash
photographic-style-port patch IN.HEIC OUT.HEIC \
  --linear-thumb reuse-thumbnail --scene-stats donor --light-maps flat \
  --faces off --portrait-matte off
```

The `Build binary release` GitHub Actions workflow builds and smoke-tests all four targets
on version-tag pushes or manual runs.

## Install from source

Needs **Python 3.12+**. [uv](https://docs.astral.sh/uv/) is the shortest path:

```bash
git clone https://github.com/nathanatgit/Shalielie.git
cd Shalielie
uv sync --extra faces
```

The default mode also uses two external tools — `ffmpeg` (with libx265) to encode, and
`heif-convert` (libheif) to decode:

| OS              | Install                                                                 |
| --------------- | ----------------------------------------------------------------------- |
| Debian / Ubuntu | `sudo apt install ffmpeg libheif-examples`                            |
| macOS           | `brew install ffmpeg libheif`                                         |
| Windows         | `winget install Gyan.FFmpeg`, then add this repo's `tools/` to PATH |

Windows has no libheif package, so `tools/` ships a drop-in `heif-convert` backed by
pillow-heif, which `uv sync` installs for you:

```powershell
$env:PATH = "$PWD\tools;$env:PATH"
```

Neither tool is required if you use [the no-encoder mode](#no-encoder-mode).

Python/CLI now supports the Web processing routes: adaptive HEIC grids, standalone or
missing HDR, missing thumbnails, PNG/JPEG/WebP import, and local person/skin masks.
New linear thumbnails remain **10-bit HEVC Main10 in Python/CLI**; the Web build generates
**8-bit HEVC Main**. Both encode actual Display P3 linear samples with matching colour tags.
The `faces` extra supplies MediaPipe. Its two model files download once into the local model
cache; `--model-dir PATH` selects an existing cache for offline use. Photos stay local.
Without the extra, mask generation falls back with a warning. `--faces off --portrait-matte off`
disables model use entirely.

## Usage

```bash
uv run photographic_style_port.py patch INPUT.HEIC OUTPUT.HEIC
```

Copy the output to your iPhone and open it in Photos — Edit should now offer the style
palette, with Texture/Grain on iOS 27. Transfer the output as a **file** to preserve its
HEIC metadata. When selecting from the Photo Library, choose **Options → Format → Current**
to prevent automatic format conversion.

`patch` chooses what to do from the photo:

| Photo                                        | What happens                                              |
| -------------------------------------------- | --------------------------------------------------------- |
| No style data (iPhones before the iPhone 16) | full port, plus Texture/Grain                             |
| Native style data (iPhone 16/17)             | Texture/Grain plus the iOS 27 v16 style-schema upgrade    |
| Already has Texture/Grain (iPhone 18)        | no rewrite; the Web build can inspect its embedded masks  |

`add-texture IN.HEIC OUT.HEIC` runs the second route explicitly.

Useful flags:

| Flag                               | What it's for                                                       |
| ---------------------------------- | ------------------------------------------------------------------- |
| `--report`                       | also write `OUTPUT.HEIC.report.json` describing what changed      |
| `--zip`                          | bundle the HEIC and its report into `OUTPUT.zip` for transfer     |
| `--light-maps target`            | rebuild tone maps from your photo — the flag most likely to help   |
| `--scene-stats donor`            | fall back to donor tone anchors if colors look wrong                |
| `--linear-thumb reuse-thumbnail` | reuse the embedded thumbnail for the linear auxiliary              |
| `--texture off`                  | leave out the iOS 27 Texture/Grain items (v0.4.4 output)            |
| `--faces off`                    | skip experimental local face/skin/person generation              |
| `--portrait-matte off`           | skip generating a missing Portrait effect matte                  |
| `--model-dir PATH`               | use locally cached MediaPipe model files                         |

By default the only file written is the output HEIC. A run summary is printed to the terminal;
pass `--report` or `--zip` if you want it saved as JSON too.

Native semantic mattes, Portrait effect mattes and depth are preserved with their codec and
geometry. Native legacy skin also supplies a missing v2 skin mask. A missing Portrait effect
matte can be generated from local person segmentation; unavailable inference omits the donor
placeholder. This supplies an approximate mask, not camera depth.

### No-encoder mode

```bash
uv run photographic_style_port.py patch IN.HEIC OUT.HEIC \
  --linear-thumb reuse-thumbnail --scene-stats donor --light-maps flat \
  --faces off --portrait-matte off
```

Runs with **ffmpeg and heif-convert both absent** when the HEIC already has a compatible
primary/HDR graph and a thumbnail. Missing HDR or thumbnails, raster import, and compatibility
re-encoding still need codecs. The existing thumbnail is reused at its original bit depth.

### Other commands

```bash
uv run photographic_style_port.py profiles              # list the built-in donor profiles
uv run photographic_style_port.py inspect PHOTO.HEIC    # dump style-related metadata as JSON
uv run photographic_style_port.py extract-donor DONOR.HEIC PROFILE.zip
```

`extract-donor` is for adding support for a tile layout that has no built-in profile.

## Use from an AI agent

The CLI is non-interactive and reports in JSON, which makes it easy for coding agents to
drive. This repo ships a ready-made skill in [skills/photographic-style-port/](skills/photographic-style-port/).

**Claude Code** — copy it into your skills directory:

```bash
# just this project
mkdir -p .claude/skills && cp -r skills/photographic-style-port .claude/skills/

# or available everywhere
mkdir -p ~/.claude/skills && cp -r skills/photographic-style-port ~/.claude/skills/
```

Then ask normally — *"add Photographic Styles to these photos"* — and the agent loads the
skill on its own.

**Other agents** (Cursor, Codex, Copilot, Continue): the skill file is plain Markdown. Point
your agent's rules file at it, or paste its contents into `AGENTS.md` / `.cursorrules`.

The skill tells the agent to pick a mode based on what's installed, to process batches one file
at a time, and never to overwrite an original.

## What it actually does

Safely graftable HEIC inputs keep their primary/HDR compressed pixels and rendering properties;
Exif receives the eligibility marker. Raster inputs and unsupported HEIC graphs are re-encoded
locally and identified in the report. What gets added is the
style machinery Photos looks for: the style plist and Apple MakerNote tag `0x54` from a
normalized donor profile, plus a `linearthumbnail`, scene statistics and light maps computed
from your own photo. For Texture/Grain it adds iOS 27's `texture_styles` item together with the
12 2026 semantic mattes. Local inference fills approximate masks and per-person data when
available; unavailable inference uses empty semantic masks without a donor Portrait placeholder.

## Limits

- **The two built-in primary/HDR grid profiles are 48/12 and 45/15.** A matching target whose
  HDR gain map is one standalone `hvc1` item is also supported: its original compressed gain map
  and codec properties are preserved byte-for-byte instead of being split or re-encoded. Photos without an
  embedded thumbnail have been supported since v0.5, but need the default (encoder) mode.
  Both builds have an experimental graph adapter for many 1–48-primary-tile layouts,
  including tiled HDR when its tile count matches an available donor graph;
  other layouts use local compatibility re-encoding, reported in the output JSON.
- **Texture/Grain needs iOS 27** on the phone that opens the photo.
- **Not validated by Apple, and results vary by photo.** Try the flags above before concluding
  it does not work.
- **Generated masks are approximate.** Local MediaPipe inference does not reproduce Apple's
  private segmentation or generate camera depth; its Soft Skin behavior still needs phone validation.

## Disclaimer

This project is **not affiliated with, authorized, sponsored, or endorsed by Apple Inc.**

Apple, iPhone, Apple Photos and Photographic Styles are trademarks of Apple Inc., used here
only to describe what this tool interoperates with. No Apple software, source code or SDK is
included or redistributed.

The tool rewrites photo files. It is experimental, it has never been validated by Apple, and
it can produce files that behave unpredictably in any photo application. Work on copies.

## License

[MIT](LICENSE). The license covers this project's own source code; it makes no claim over any
third-party format, trademark or metadata structure described above.

## Why "Shalielie"?

Shalielie is the romanized pronunciation of a Chinese phrase, and it is my reply to Apple's
"shareholders in spirit" — the fans who defend every Apple decision as if they
owned the company. For example:

> "Apple doesn't bring the Photographic Styles palette to older models because it wants to
> provide a better, more consistent user experience."
>
> "Shalielie 🙄."
