---
name: photographic-style-port
description: Patch an iPhone HEIC so Apple Photos offers the Photographic Styles palette (风格 / 调色盘). Use when the user asks to add, enable, port or restore Photographic Styles on a .HEIC photo, to make an iPhone 15 photo stylable like an iPhone 16/17 one, or to inspect a HEIC's style-related metadata.
---

# Photographic Style Port

CLI that rewrites a HEIC's metadata so Apple Photos offers the Photographic Styles palette.
Pixels are never altered — the decoded output is identical to the input.

## Before the first run

Locate `photographic_style_port.py` in the project, then check which mode is available:

```bash
command -v ffmpeg heif-convert     # both present -> default mode
```

On Windows the repo's `tools/` directory supplies `heif-convert`; add it to PATH first:
`$env:PATH = "$PWD\tools;$env:PATH"`.

Run `uv sync` once if `.venv` is missing. Invoke as `uv run photographic_style_port.py ...`,
or `python photographic_style_port.py ...` if the project has no uv setup — the script itself
is standard-library only.

## Choosing a mode

| Situation | Command |
|---|---|
| ffmpeg **and** heif-convert available | `patch IN.HEIC OUT.HEIC` |
| Either missing, or reproducible output wanted | `patch IN.HEIC OUT.HEIC --linear-thumb reuse-thumbnail --scene-stats donor --light-maps flat` |
| User reports weak or uneven results | add `--light-maps target` |
| User reports wrong colour or exposure | add `--scene-stats donor` |

Do not install ffmpeg or libheif without asking — the no-encoder mode is a complete fallback,
not a degraded one.

## Running

```bash
uv run photographic_style_port.py patch IN.HEIC OUT.HEIC
```

Exit code 0 means success, and a summary goes to stdout. The output HEIC is the only file
written unless you ask for more — add `--report` for a machine-readable
`OUT.HEIC.report.json`, which is worth doing when you need to verify the result rather than
just report it. Useful fields:

- `output_sha256` — identifies the result
- `linear_thumb_mode` — `generate` or `reuse-thumbnail`
- `mattes_transplanted` / `mattes_added` — Portrait data carried over
- `warnings` — non-fatal issues worth relaying to the user

For batches, loop one file at a time and report per-file outcomes; there is no batch mode and
a failure on one photo says nothing about the next.

Do not leave report or ZIP files in the user's directories unless they asked for them, and
clean up any `--report` output you generated purely for your own verification.

## Errors

| Message | Meaning |
|---|---|
| `Required command not found in PATH: heif-convert` / `ffmpeg` | Switch to no-encoder mode, or set up the tool. |
| `Target thumbnail/Exif not found` | This photo cannot be patched. Not fixable by flags — say so and move on. |
| `No built-in profile matches target layout N primary/M HDR` | Unsupported tile layout. Needs `extract-donor` against an iPhone 16/17 photo with the same layout. |

## Other commands

```bash
uv run photographic_style_port.py profiles              # built-in donor profiles, as JSON
uv run photographic_style_port.py inspect PHOTO.HEIC    # style-related metadata, as JSON
```

Use `inspect` before patching when diagnosing why a photo behaves unexpectedly.

## Rules

- **Never write the output over the input**, and never patch a file in place. These are
  irreplaceable photos and the tool is experimental.
- **Do not delete or move the user's originals**, including after a successful patch.
- Tell the user that transferring the result to an iPhone must be done **as a file**. Going
  through the Photo Library converts HEIC to JPEG and discards everything this tool adds.
- Results are not validated by Apple and vary by photo. Report what the tool did; do not
  promise that the palette will appear.
