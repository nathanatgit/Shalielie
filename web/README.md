# Palettify — browser build

The static site published to GitHub Pages. Everything runs in the visitor's browser; photos
are never uploaded.

`countVisit()` in `app.js` is the site's only outbound request: a fire-and-forget ping to
`abacus.jasoncameron.dev` on load, once per browser session, feeding the visits badge in the
top-level README. It sends no photo data and no identifiers. The counter namespace is public,
so treat the number as a rough signal — anyone who knows the URL can increment it.

This directory is the deploy root and contains only site files. The Claude Artifact bundle
lives in `../artifact/` and the Node tests in `../tests/web/` — neither is served, and
nothing here depends on either.

## Deploying

`.github/workflows/pages.yml` publishes this directory on every push that touches it. Enable
it once under **Settings → Pages → Source → GitHub Actions**. The workflow first runs
`tools/build_web_assets.py`, which puts the two MediaPipe models (`web/models/`) and the
MediaPipe runtime (`web/vendor/`) next to the site for Any Image and Find Faces; both are
pinned and hash-checked, and neither is committed. It then checks three things before
uploading:

- no `.heic`/`.heif` anywhere under `web/` — a guard against publishing a personal photo
- the two donor profiles are present and non-empty
- the PWA metadata, icon dimensions, registration, and offline asset list are consistent

To serve it locally instead:

```bash
python tools/build_web_assets.py   # once: models and MediaPipe runtime for Any Image / Find Faces
python -m http.server -d web 8000
```

Everything uses relative paths, so a project subpath like `https://user.github.io/repo/`
works without configuration.

## PWA and offline use

The site is installable as a Progressive Web App. `manifest.webmanifest` supplies its app
identity and icons, while `sw.js` precaches the complete converter, both donor profiles, and
all first-party JavaScript. Paths stay relative so the same files work at the root of a
domain or under a GitHub Pages project subpath.

The cache uses the network first when available, then falls back to its saved copy. This
keeps the deployed app current without giving up offline use. The optional libheif decoder
and visit counter are third-party requests and are deliberately not persisted by the service
worker; without the decoder, photo analysis falls back to the tested donor-statistics path.

After changing runtime files or the manifest, check that the offline asset list is complete:

```bash
node tests/web/check-pwa.mjs
```

## What it ships

| | |
|---|---|
| Size | ~140 KB total, including both donor profiles |
| Requests | `index.html`, `app.js`, seven modules, one profile per photo layout |
| External | one optional script — see below |
| Headers | none needed; nothing uses `SharedArrayBuffer` |

## The one external dependency

Measuring a photo's own tone and light needs a HEIC decoder, and browsers other than Safari
do not have one. `src/decode.js` loads libheif from jsDelivr for that, lazily — only when the
analysis option is on, and only on the first photo.

Nothing is uploaded to it; it is a script fetch. If it fails, or if you switch it off, the
port still runs and falls back to donor statistics and flat light maps — which is exactly the
configuration that reproduces the Python output byte for byte, so the fallback is the tested
path rather than a degraded guess.

To remove the dependency entirely, vendor the library and point `LIBHEIF_URL` at it:

```bash
npm pack libheif-js && tar -xzf libheif-js-*.tgz
cp package/libheif/libheif.js package/libheif/libheif.wasm web/vendor/
```

## Why there is no HEVC encoder

The Python tool re-encodes the linearthumbnail as 10-bit Main10 HEVC with ffmpeg. Browsers
have no dependable HEVC encoder, so a faithful port would have had to ship ffmpeg.wasm at
25–30 MB.

That turned out to be unnecessary. Reusing the photo's own embedded thumbnail as the
linearthumbnail — `--linear-thumb reuse-thumbnail` in the Python tool — was validated
on-device, so this build uses it unconditionally and needs no encoder at all.

## iPhone notes

Two iOS behaviours are handled explicitly:

- **Picking from the Photo Library gives you a JPEG.** iOS transcodes on the way in and
  throws away everything the port needs. The file input therefore sets no `accept`
  attribute, so **Browse** is offered and files chosen from Files arrive untouched. Uploads
  are sniffed by magic bytes and a transcoded one is named as such rather than failing
  obscurely.
- **Getting the result back into Photos.** Where the browser supports sharing files, a
  **Save to Photos** button hands the finished `.heic` to the native share sheet, so
  **Save Image** puts it straight in the library. A normal download sits alongside it.

## Editing the copy

Every word the page shows, in both languages, is in `src/i18n.js`. `index.html` has no text
of its own — elements carry `data-i18n` keys and are filled in at load and when the language
button is pressed.

```bash
python -m http.server -d web 8000   # then edit src/i18n.js and reload
node tests/web/check-i18n.mjs       # after editing
```

The checker catches the two mistakes that are otherwise invisible until someone switches
language: a key added to one language but not the other, and a key `index.html` asks for that
no longer exists.

Adding a third language means adding a block to `STRINGS` with the same keys; the button
cycles between exactly two, so more than that needs a small change to the switch in `app.js`.

## Correctness

The browser port is checked against the Python implementation:

```bash
node tests/web/compare.mjs        # the modules this site loads
node tests/web/compare_bundle.mjs # the concatenated artifact bundle
node tests/web/check-pwa.mjs      # manifest, icons, and offline asset coverage
```

```
photo 1: BYTE-IDENTICAL (2431116)
photo 2: BYTE-IDENTICAL (1813693)
photo 3: BYTE-IDENTICAL (1861646)
portrait 1: EQUIVALENT (styles plist repacked, all items match)
portrait 2: EQUIVALENT (styles plist repacked, all items match)
portrait 3: EQUIVALENT (styles plist repacked, all items match)
native 1 add-texture: BYTE-IDENTICAL (3955304)
native 2 add-texture: BYTE-IDENTICAL (1562445)
native 3 add-texture: BYTE-IDENTICAL (2007006)
native 4 add-texture: BYTE-IDENTICAL (2056959)
```

Three are byte-for-byte identical. The other three differ only in how the styles plist is
packed — `plistlib` and this bplist writer lay objects out differently — so that one item is
compared semantically: every key and value matches, including the binary `c`/`d` maps. All
other items are byte-identical.

The fixtures are patched personal photos and are deliberately not in the repository, so the
tests only run once you generate your own:

```bash
python photographic_style_port.py patch IN.HEIC tests/web/ref/NAME_ref.HEIC \
  --linear-thumb reuse-thumbnail --scene-stats donor --light-maps flat
python photographic_style_port.py add-texture Smartstyle/NAME.HEIC tests/web/ref/NAME_addtex_ref.HEIC
```

The four `add-texture` cases cover v0.5's native-photo mode (`src/texture.js`): an iPhone 16/17
style photo gets only the iOS 27 Texture/Grain set, so its output must be byte-identical to
Python's.

## Layout

| File | Role |
|---|---|
| `src/box.js` | ISO-BMFF box reading and writing |
| `src/heif.js` | Item graph: `iloc`/`iinf`/`iref`/`ipma`/`ipco`, discovery, surgery |
| `src/bplist.js` | Apple binary plist reader and writer |
| `src/exif.js` | MakerNote `0x54` injection, preserving the target's Exif |
| `src/styles.js` | Scene statistics, `c`/`d` light maps, person-mask hint |
| `src/zip.js` | Donor profile reader, via `DecompressionStream` |
| `src/port.js` | The patch pipeline |
| `src/texture.js` | iOS 27 Texture/Grain set (texture_styles + 2026 mattes), and native-photo insertion |
| `src/decode.js` | Optional libheif decoding, isolated behind one callback |
| `profiles/` | The two donor profiles, exported from the Python build |

`src/port.js` takes the decoder as a callback, so nothing but `decode.js` knows libheif
exists — which is also why `port.js` runs unchanged under Node for the comparison tests.

## Not supported

Photos without an HDR gain map are rejected, and only the two known tile layouts (48/12 and
45/15) have profiles. Photos without an embedded thumbnail are also rejected here, with a message
pointing to the command-line tool: since v0.5 the Python tool encodes a missing thumbnail, but
the browser has no HEVC encoder to do the same.
