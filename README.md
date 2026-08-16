# Photographic Style Port

Current version: v0.4.4

This is an experimental tool that gives an iPhone HEIC the metadata an iPhone 16/17
photo carries, so that Apple Photos offers the **Photographic Styles** palette (风格/ or most people would simply call it 调色盘) on it.

It is an independent HEIC interoperability tool, not an Apple-supported format converter. It
works by reading and rewriting the ISO-BMFF item graph of photo files, and it is experimental.

**Keep your originals.**

Shalielie is my reply (a Chinese word pronouciation) to those Apple shareholder in spirit.

## Install

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
| Windows         | `winget install Gyan.FFmpeg`, then put this repo's `tools/` on PATH |

Windows has no libheif package, so `tools/` ships a drop-in `heif-convert` backed by
pillow-heif, which `uv sync` installs for you:

```powershell
$env:PATH = "$PWD\tools;$env:PATH"
```

Neither tool is required if you use [the no-encoder mode](#no-encoder-mode).

## Usage

```bash
uv run photographic_style_port.py patch INPUT.HEIC OUTPUT.HEIC
```

Copy the output to your iPhone and open it in Photos — Edit should now offer the style
palette. Send it as a **file**, not through the Photo Library, which re-encodes HEIC to JPEG
and strips everything this tool adds.

Useful flags:

| Flag                               | What it's for                                                       |
| ---------------------------------- | ------------------------------------------------------------------- |
| `--report`                       | also write`OUTPUT.HEIC.report.json` describing what changed       |
| `--zip`                          | bundle the HEIC and its report into`OUTPUT.zip` for transfer      |
| `--light-maps target`            | rebuild tone maps from your photo — most likely to improve results |
| `--scene-stats donor`            | fall back to donor tone anchors if colours look wrong               |
| `--linear-thumb reuse-thumbnail` | skip the encoder entirely                                           |

By default the only file written is the output HEIC. A run summary is printed to the terminal;
pass `--report` or `--zip` if you want it saved as JSON too.

Portrait data — semantic mattes and depth — is carried automatically when the photo has it.
There is no flag, and a photo without it is unaffected.

### No-encoder mode

```bash
uv run photographic_style_port.py patch IN.HEIC OUT.HEIC \
  --linear-thumb reuse-thumbnail --scene-stats donor --light-maps flat
```

Runs with **ffmpeg and heif-convert both absent** by reusing the photo's own thumbnail instead
of encoding a new one. Fewer quality refinements, but zero setup, and the output is
reproducible byte-for-byte across machines.

### Other commands

```bash
uv run photographic_style_port.py profiles              # list the built-in donor profiles
uv run photographic_style_port.py inspect PHOTO.HEIC    # dump style-related metadata as JSON
uv run photographic_style_port.py extract-donor DONOR.HEIC PROFILE.zip
```

`extract-donor` is for adding support for a tile layout that has no built-in profile.

## Use from an AI agent

The CLI is JSON-reporting and non-interactive, so coding agents drive it well. This repo ships
a ready-made skill in [skills/photographic-style-port/](skills/photographic-style-port/).

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

The skill tells an agent which mode to pick based on what's installed, that batches should be
looped one file at a time, and never to overwrite an original.

## What it actually does

Your photo's pixels are untouched — the primary image, HDR gain map, thumbnail and Exif all
stay yours, and the decoded output is pixel-identical to the input. What gets added is the
style machinery Photos looks for: the style plist and Apple MakerNote tag `0x54` from a
normalized donor profile, plus a `linearthumbnail`, scene statistics and light maps computed
from your own photo.

## Limits

- **Photos without an embedded thumbnail are rejected**, and only two tile layouts (48/12 and
  45/15) have built-in profiles.
- **Not validated by Apple, and results vary by photo.** Try the flags above before concluding
  it does not work.
- **A normal photo cannot be turned into a "people" photo.** Portrait data is only ever copied
  from the photo itself, never invented.

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
