# Photographic Style Port

**English** | [简体中文](README.zh-CN.md)

Current version: v0.7.0

This is an experimental tool that takes a HEIC from an iPhone **older than the iPhone 16**
(iPhone 15, 14, 13 … — any model whose photos match a supported tile layout) and adds the
metadata an iPhone 16/17 photo carries, so that Apple Photos offers the **Photographic Styles**
palette on it (风格 in Chinese; Apple calls the palette 调色板).

Since v0.5 it also adds the **iOS 27 Texture/Grain** controls (质感/颗粒) that Apple introduced
with the iPhone 18 Pro. Ported photos get them as part of the port; native iPhone 16/17 photos
get only these controls, and their existing image data stays byte-identical.

It is an independent HEIC interoperability tool, not an Apple-supported format converter. It
works by reading and rewriting the ISO-BMFF item graph of photo files, and it is experimental.

**Keep your originals.**

**Keep your originals.**

**Keep your originals.**


## Project status

The tool is currently at the *functionality* stage. The goal right now is to make photos from older iPhones work with the Photographic Styles palette: the palette appears, styles and adjustments apply as expected, and edits save and reopen correctly.

Fine-tuning comes next. Bringing the rendered look of styles, and the finer detail of Texture and Grain, closer to photos taken on newer iPhones will be the focus once the core work is complete. Until then, small differences from a native photo are expected. Feedback and sample photos are very welcome.

**Contents:** [Browser](#use-it-in-a-browser) · [Binary](#download-a-binary) ·
[From source](#install-from-source) · [Usage](#usage) · [What it does](#what-it-actually-does) ·
[Known issues and limits](#known-issues-and-limits) · [Testing a port](#testing-a-port) ·
[Version history](#version-history) · [AI agents](#use-from-an-ai-agent) ·
[Developer tools](#developer-tools)

## Use it in a browser

[![Web app visits](<https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fabacus.jasoncameron.dev%2Fget%2Fnathanatgit-shalielie%2Fweb&query=%24.value&label=web%20app%20visits&style=flat-square>)](https://nathanatgit.github.io/Shalielie/)

There is a browser build that needs no install and no command line — drop a photo in, get the
patched one back. It runs entirely on your machine; nothing is uploaded.

**https://nathanatgit.github.io/Shalielie/**

The browser build includes Texture/Grain and native-photo mode. The one thing it cannot do is
patch a photo without an embedded thumbnail, because the browser has no HEVC encoder to create
one; use the command-line tool for those.

It runs the same porting logic as the Python tool, checked against it item by item (byte for byte where the plist packing allows) — see
[`web/README.md`](web/README.md) for how that is verified, and for the two iPhone quirks it
works around. The command-line tool remains the reference implementation and is the one to use
for batches or for the encoder-based linear thumbnail.

## Download a binary

[![Release downloads](<https://img.shields.io/github/downloads/nathanatgit/Shalielie/total?label=release%20downloads&style=flat-square>)](https://github.com/nathanatgit/Shalielie/releases)

Each tagged release provides a Python-free command-line executable for Windows x86-64, Linux
x86-64, macOS x86-64 (Intel) and macOS arm64 (Apple silicon). Download the archive for your
system from the [Releases page](https://github.com/nathanatgit/Shalielie/releases), extract it,
and run:

```bash
photographic-style-port patch IN.HEIC OUT.HEIC     # photographic-style-port.exe on Windows
```

The executable includes the Python runtime and both built-in donor profiles; use `--version` to
check which release you have.

The default mode still calls `ffmpeg` and `heif-convert`. For a completely standalone run, use
the [no-encoder mode](#no-encoder-mode).

### Drag and drop

Drop HEIC photos, or a folder of them, onto `photographic-style-port.exe` (or pass file paths
with no command). Each HEIC is patched next to its original as `NAME_PhotographicStyle.HEIC`;
photos from iPhone 16/17 get `NAME_TextureGrain.HEIC`. JPEGs, PNGs and other files are
skipped, existing files are never overwritten, and a summary lists every file.

**Live Photos.** Drop the HEIC together with its MOV. When a HEIC and a MOV have the same name
in the same folder, the video is processed as well and saved under the same new name
(`NAME_PhotographicStyle.HEIC` + `NAME_PhotographicStyle.MOV`). Photos on iOS 27 applies the
style to the video too, and its editor crashes on Live Photo videos that lack the style tracks
and timed metadata of a native iOS 27 video, so those are added. A MOV without a HEIC of the
same name is skipped. If you drop exactly one HEIC and one MOV whose names differ, they are
still processed as one Live Photo, with a warning, and the video takes the photo's Live Photo
ID. The video needs `ffmpeg` (with libx265); without it the photo is saved as a still.

The executable does **not** include an HEVC encoder. Drag and drop uses full mode when `ffmpeg`
and `heif-convert` are on PATH, and the [no-encoder mode](#no-encoder-mode) otherwise, which
handles original iPhone photos but not copies without an embedded thumbnail.

## Install from source

Needs **Python 3.12+**. [uv](https://docs.astral.sh/uv/) is the shortest path:

```bash
git clone https://github.com/nathanatgit/Shalielie.git
cd Shalielie
uv sync
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

Neither tool is required in the [no-encoder mode](#no-encoder-mode).

## Usage

```bash
uv run photographic_style_port.py patch INPUT.HEIC OUTPUT.HEIC
```

Copy the output to your iPhone and open it in Photos — Edit should now offer the style palette,
with Texture/Grain on iOS 27. Send it as a **file**, not through the Photo Library, which
re-encodes HEIC to JPEG and strips everything this tool adds.

`patch` chooses what to do from the photo:

| Photo                                        | What happens                                             |
| -------------------------------------------- | -------------------------------------------------------- |
| No style data (iPhones before the iPhone 16) | Full port, plus Texture/Grain                            |
| Native style data (iPhone 16/17)             | Texture/Grain added only; existing image data byte-identical |
| Already has Texture/Grain (iPhone 18)        | Refused, nothing to do                                   |

`add-texture IN.HEIC OUT.HEIC` runs the second route explicitly.

Useful flags:

| Flag                               | What it's for                                                      |
| ---------------------------------- | ------------------------------------------------------------------ |
| `--report`                       | Also write`OUTPUT.HEIC.report.json` describing what changed      |
| `--zip`                          | Bundle the HEIC and its report into`OUTPUT.zip` for transfer     |
| `--light-maps target`            | Rebuild light maps from your photo — the flag most likely to help |
| `--scene-stats donor`            | Fall back to donor tone anchors if colours look wrong              |
| `--linear-thumb reuse-thumbnail` | Skip the encoder entirely                                          |
| `--texture off`                  | Leave out the iOS 27 Texture/Grain items (v0.4.4 output)           |

By default the only file written is the output HEIC. A run summary is printed to the terminal;
pass `--report` or `--zip` to save it as JSON too.

Portrait data — semantic mattes and depth — is carried automatically when the photo has it.
There is no flag, and a photo without it is unaffected.

### No-encoder mode

```bash
uv run photographic_style_port.py patch IN.HEIC OUT.HEIC \
  --linear-thumb reuse-thumbnail --scene-stats donor --light-maps flat
```

Runs with **ffmpeg and heif-convert both absent** by reusing the photo's own thumbnail instead of
encoding a new one. Fewer quality refinements, but zero setup, and the output is reproducible
byte for byte across machines.

### Other commands

```bash
uv run photographic_style_port.py profiles              # list the built-in donor profiles
uv run photographic_style_port.py inspect PHOTO.HEIC    # dump style-related metadata as JSON
uv run photographic_style_port.py extract-donor DONOR.HEIC PROFILE.zip
```

`extract-donor` is for adding support for a tile layout that has no built-in profile.

## What it actually does

Your photo's pixels are untouched — the primary image, HDR gain map, thumbnail and Exif all come
from your photo (Exif only gains tag `0x54`), and the decoded output is pixel-identical to the
input. What gets added is the style data Photos looks for: the style plist and Apple MakerNote tag
`0x54`, plus a linear thumbnail and scene statistics computed from your own photo (light maps
too, with `--light-maps target`). For Texture/Grain it adds iOS 27's
`texture_styles` item together with the 12 2026 semantic mattes that must accompany it. On a
photo with people (face regions plus Apple's skin and Portrait mattes), the skin and person
mattes among them carry the photo's own mattes, and `texture_styles` gains the per-face data
Soft Skin needs, so Soft Skin works.

Every metadata item it writes — what it is, where it comes from, and whether it is proven on a
device — is documented in **[facts.md](facts.md)**.

## Known issues and limits

- **Soft Skin needs Apple's own people data in the photo:** face regions, a skin matte and a
  Portrait matte, as in Portrait-mode shots and iPhone 16+ photos of people. Faces are never
  detected, so photos without that data keep a Soft Skin that looks like Standard. Strongly
  turned faces (beyond ~30°) get less accurate face data.
- **The look after editing is not identical to a native photo.** The port uses neutral defaults
  where Apple's capture-time values cannot be reproduced, and a few values still come from the
  donor profile. More native samples are needed.
- **Supported sizes: 12 MP, 24 MP, 48 MP and front-camera photos**, in any tile layout. The
  style data is added to the photo's own file structure, which needs the size of the style's
  delta map; any other size falls back to the two built-in layouts (48/12 and 45/15).
- **Photos without an embedded thumbnail** need the default (encoder) mode, not the browser or
  no-encoder mode.
- **Texture/Grain needs iOS 27** on the phone that opens the photo.
- **A normal photo cannot be turned into a "people" photo.** Portrait data is only ever copied
  from the photo itself, never invented.
- **Not validated by Apple, and results vary by photo.** Try the flags above before concluding
  it does not work.
- **The standalone iOS app** lives in the `agent/swift-port` branch, co-authored by
  [@lzh20025](https://github.com/lzh20025), who added its Live Photo support
  ([#7](https://github.com/nathanatgit/Shalielie/pull/7)). It is a pre-release: an unsigned IPA
  for sideloading in [ios-v0.7.0-beta.1](https://github.com/nathanatgit/Shalielie/releases/tag/ios-v0.7.0-beta.1).

Open metadata questions are tracked in [facts.md](facts.md) (donor-derived values).

## Testing a port

Seeing the palette only means Photos recognized the file as stylable. A port works when:

1. The palette appears.
2. Switching styles visibly changes the photo.
3. Tone and colour controls visibly change the photo.
4. Save, reopen and re-edit all work.
5. There are no patches that follow another photo's regions.
6. The main image is pixel-identical, with no block corruption.
7. No unexpected options appear (for example Portrait on a photo without depth).
8. On people photos, people and background respond separately.
9. On iOS 27, Texture/Grain is offered, and Portrait where the source had it.

Change one thing at a time against the last working build, and transfer test files **as files**.

Across machines, compare structure rather than whole-file SHA: x265 builds encode the linear
thumbnail differently. Only the no-encoder mode is reproducible byte for byte, and
`tests/web/compare.mjs` checks the browser build against it.

## Version history

✅ tested on a device · ☑️ verified at file level or by calibration · 🔍 needs investigation.
"V" steps are experiments from before the first release.

| Step        | What was tried                                                               | Result                                                            |
| ----------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| initial     | Copy the donor's whole structure                                             | Palette depends on file data, not the camera model                |
| V4          | Identity style metadata                                                      | Palette and editing work ✅                                       |
| V5          | Synthetic auxiliary images                                                   | Palette appears; edits do nothing                                 |
| V6          | A/B on the linear thumbnail                                                  | Linear thumbnail is the critical item                             |
| V7          | Synthetic linear thumbnails, donor`hvcC`                                   | All fail                                                          |
| V8          | Synthetic linear thumbnail**with its own `hvcC`**                    | All 4 variants work ✅                                            |
| v0.1        | Donor profiles; matched linear-thumbnail`hvcC`                             | First frozen baseline                                             |
| v0.1.1      | Move the photo's`hvcC` + `colr` with its tiles                           | Block corruption gone ✅                                          |
| V9 / v0.1.2 | Exif A/B; insert only`0x54`                                                | `0x54` required; no donor state leaks ✅                        |
| V10         | Calculated vs flat light maps                                                | Both work; donor-region artifact remains ✅                       |
| V11 / v0.2  | Neutral delta map, flat maps, identity coefficients                          | Full editing loop; donor-region artifact gone ✅                  |
| v0.2.1      | Templates embedded in the script                                             | No donor file needed                                              |
| v0.3.0      | Photo's orientation; linear thumbnail in stored orientation; tone statistics | Rotation fixed ☑️; statistics in wrong units                    |
| v0.3.1      | Statistics in linear light;`--light-maps target`                           | Calibrated ☑️                                                   |
| v0.3.2      | Carry the photo's mattes; person-mask hint 1.0                               | People and background separate ✅                                 |
| v0.4.0      | Mattes handled automatically                                                 | ☑️                                                              |
| v0.4.1      | `tmap` geometry                                                            | Windows black band gone ☑️                                      |
| v0.4.2      | Depth map                                                                    | All source auxiliary images survive ☑️                          |
| v0.4.3      | XMP sidecars; photo's HDR headroom                                           | Portrait works ✅                                                 |
| v0.4.4      | `--linear-thumb reuse-thumbnail`                                           | No encoder needed ✅; used by the web build                       |
| v0.5.0      | Texture/Grain; native-photo mode; thumbnail synthesis                        | Palette, Texture/Grain and Portrait ✅; Soft Skin 🔍              |
| v0.5.1      | Photo's own`tmap` gain-map parameters                                      | Only the`tmap` bytes change; pixels and payloads identical ☑️ |
| v0.6.0      | Soft Skin from the photo's face regions and mattes; Windows drag and drop    | Soft Skin ✅ (needs all four parts, phone A/B); no-people output unchanged ☑️ |
| v0.6.1      | Exactly empty frames in unfilled matte slots; per-photo`FilmGrainSeed`     | Two donor-derived values gone; palette, styles, people and Soft Skin unchanged ✅ |
| v0.6.2      | Style items added to the photo's own item graph; 90°/270° rotation fixed      | Any tile layout of a known size; re-saved photos without thumbnail/`tmap`; sky/foliage glow on 270° photos gone ✅ |
| v0.6.3      | 48 MP photos (8064×6048) on the photo's own item graph                       | 48 MP photos from older iPhones port, with and without an encoder ✅ |
| v0.7.0      | Live Photos: a dropped HEIC + MOV pair; the video gets the iOS 27 style tracks and timed metadata | Photos' editor opens iPhone 15 Pro Live Photos with style and motion (iOS 27.0.1) ✅ |

**Reverse-engineering tests of key assumptions**

- Edits had no effect with a synthetic linear thumbnail: the cause was the image data not
  matching its `hvcC`; the pixel content played no part (V8).
- The main image showed block corruption: the cause was the tile data not matching its
  `hvcC`/`colr`; a matching tile count alone is not enough (v0.1.1).
- Edits followed the donor photo's regions: the cause was the donor's delta map; the light
  maps played no part (V11).
- Tone statistics came out about twice too high: the cause was that Apple records them in linear
  light, while v0.3.0 wrote gamma-encoded values (v0.3.1).
- People and background were adjusted as one layer: the cause was the donor's empty mattes
  together with a person-mask hint of -1.0 (v0.3.2).
- Portrait still did nothing after adding the depth map: the cause was the missing XMP sidecar
  for the depth map (v0.4.3).
- The whole palette disappeared after adding only `texture_styles`: the cause was the missing
  twelve 2026 semantic mattes; the two must be present together (v0.5.0).
- For enabling Texture/Grain on iOS 27, what matters is `texture_styles` plus the 2026 mattes;
  styles schema 14 and the 8-key `0x54` are enough, with no need for schema 16 or 13 keys
  (v0.5.0).

## Use from an AI agent

The CLI is non-interactive and reports in JSON, which makes it easy for coding agents to drive.
This repo ships a ready-made skill in [skills/photographic-style-port/](skills/photographic-style-port/).

**Claude Code** — copy it into your skills directory:

```bash
# just this project
mkdir -p .claude/skills && cp -r skills/photographic-style-port .claude/skills/

# or available everywhere
mkdir -p ~/.claude/skills && cp -r skills/photographic-style-port ~/.claude/skills/
```

Then ask normally — *"add Photographic Styles to these photos"* — and the agent loads the skill
on its own.

**Other agents** (Cursor, Codex, Copilot, Continue): the skill file is plain Markdown. Point your
agent's rules file at it, or paste its contents into `AGENTS.md` / `.cursorrules`.

The skill tells the agent to pick a mode based on what's installed, to process batches one file
at a time, and never to overwrite an original.

## Developer tools

| Tool                          | What it does                                                                                    |
| ----------------------------- | ----------------------------------------------------------------------------------------------- |
| `inspect`                   | Style-related item structure of a HEIC, as JSON                                                 |
| `extract-donor`             | Builds a donor profile from a native iPhone 16/17 photo, for a new tile layout                  |
| `tools/style_dump.py`       | Item graph, Exif identity, MakerNote tags and styles schema, for comparing capture generations  |
| `tools/texture_variants.py` | Builds the Texture/Grain test profiles (see[facts.md](facts.md)) from an iPhone 18 donor profile |
| `tests/web/`                | Checks the browser build against the Python tool; see[`web/README.md`](web/README.md)          |

## Disclaimer

This project is **not affiliated with, authorized, sponsored, or endorsed by Apple Inc.**

Apple, iPhone, Apple Photos and Photographic Styles are trademarks of Apple Inc., used here only
to describe what this tool interoperates with. No Apple software, source code or SDK is included
or redistributed.

The tool rewrites photo files. It is experimental, it has never been validated by Apple, and it
can produce files that behave unpredictably in any photo application. Work on copies.

## License

[MIT](LICENSE). The license covers this project's own source code; it makes no claim over any
third-party format, trademark or metadata structure described above.

## Why "Shalielie"?

Shalielie is the romanized pronunciation of a Chinese phrase, and it is my reply to Apple's
"shareholders in spirit" — the fans who defend every Apple decision as if they owned the
company. For example:

> "Apple doesn't bring the Photographic Styles palette to older models because it wants to
> provide a better, more consistent user experience."
>
> "Shalielie 🙄."
