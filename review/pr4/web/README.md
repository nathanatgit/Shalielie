# Browser photographic style port

**English** | [简体中文](README.zh-CN.md)

## Photo workflow (0.6.0-web)

Photos from any phone or camera, as well as screenshots, can be imported in the
supported HEIC/PNG/JPEG/WebP formats; browser decode/HEVC encoding support still
determines which files can be processed.

Selected photos process automatically in order. Each card keeps an original-photo
thumbnail, including failed photos, and successful results show a small processed
HEIC image directly on the card for native iPhone long-press saving. Each result also
provides download, optional Photos sharing, and **Compare all embedded data**.
Browsers without native HEIC images can render a local canvas preview; save those
results using the file download or Photos sharing to retain the HEIC metadata.

Status times measure each individual step (including queue waiting) and freeze when
that step ends. Steps under a second display milliseconds (or `<1ms`); longer steps
display seconds to three decimal places. Completion/error summaries have no step timer. Shared model loading,
face detection and multiclass segmentation are timed separately from generating and
encoding each output mask. Person/Portrait reuse one encode. Native hair masks are
preserved on the lossless paths; the browser generator does not encode a new hair
mask. Synchronous decoding and inference can block the UI and pause the visible timer; it
catches up using the monotonic clock. The pipeline yields between stages and face
detection passes so the browser can refresh. **Compare all embedded data** is the
first action on each result card. Its labels include the localized name and technical
identifier (for example, Hair matte / `semantichairmatte`); progress uses only localized
names. All local module imports share the entry point's build tag so raster and
native HEIC paths cannot reuse different cached face/progress implementations.

Results with generated face detections provide **Correct faces** after the comparison
action. The dialog shows an upright photo, numbered face boxes, corresponding face
crops and zoom controls. Toggle exclusions and apply once; cancel discards the draft.
Applying updates the same card's HEIC download, Photos sharing, long-press thumbnail,
face count and inspection/overlay. Saved selections can be reopened and restored.
Corrections reuse the first detections and shared segmentation, rebuild face-dependent
local masks and person metadata, and reuse already encoded primary/HDR/thumbnail
pixels. Native source masks and shared skin/person masks are preserved. Excluding all
detections removes all generated person instances and face records. Restoring every
face restores the original output bytes. Failed updates leave the previous result and
selection available. The dialog corrects this run's detections; it does not add faces
or edit masks already embedded by the camera.

Native style photos retain
their original auxiliaries and receive Texture/Grain; style-less photos use the
profile graft and independently generated 8-bit linear thumbnail.

The embedded-data inspection panel compares actual input/output metadata,
item payloads and masks.

Validation: `node tests/web/basic-workflow-browser.mjs` with an existing Playwright
runtime checks ordinary native output byte-for-byte, inspection,
and 320/390-pixel layouts. `node tests/web/linear8.mjs` validates real HEVC samples
using an externally installed FFmpeg test executable; the website ships no FFmpeg.

## Deploying

`.github/workflows/pages.yml` publishes this directory on every push that touches it. Enable
it once under **Settings → Pages → Source → GitHub Actions**. There is no build step; the
workflow checks three things before uploading:

- no `.heic`/`.heif` anywhere under `web/` — a guard against publishing a personal photo
- the two donor profiles are present and non-empty
- the PWA metadata, icon dimensions, registration, and offline asset list are consistent

To test on the same computer (localhost is a secure-context exception):

```bash
uv run tools/serve_web.py
```

Open `http://localhost:8000/` on the same computer. Local testing does not require
certificate generation or certificate installation; the helper serves HTTP and
supplies COOP/COEP headers.

For iPhone/LAN testing, use the hosted website or trusted local HTTPS.
WebCodecs requires a secure context: loopback HTTP
is eligible, but plain HTTP through a LAN IP is not equivalent and does not provide
the required encoding/PWA APIs. See [WebCodecs](https://www.w3.org/TR/webcodecs/#videoencoder-interface)
and [Secure Contexts](https://www.w3.org/TR/secure-contexts/#is-origin-trustworthy).

Generate certificates using Python (uv manages the script's isolated `cryptography`
dependency without changing the project's dependencies):

```bash
uv run tools/create_https_cert.py --ip YOUR_LAN_IP
uv run tools/serve_web.py --bind 0.0.0.0 --port 8443 --cert .local-https/lan-cert.pem --key .local-https/lan-key.pem
```

Replace `YOUR_LAN_IP` with the computer's actual LAN IP, then open `https://YOUR_LAN_IP:8443/`
on the iPhone. Transfer only `.local-https/rootCA.cer` to the iPhone and open it.
Install the profile under Settings → Profile Downloaded, then enable it under
Settings → General → About → Certificate Trust Settings. Merely bypassing a
certificate warning is insufficient. Private keys stay on the computer, outside
the served directory; `.local-https/` is excluded from Git. The tools do not change
OS trust settings automatically.

The server certificate lasts 90 days. Re-running the generator renews it or changes
the IP while retaining the existing CA. If the CA files were deleted and regenerated,
the new `rootCA.cer` must be installed and trusted again on the iPhone.

Existing certificates from another tool can also be supplied:

```bash
uv run tools/serve_web.py --bind 0.0.0.0 --port 8443 --cert path/to/lan-cert.pem --key path/to/lan-key.pem
```

On secure static hosting, the app waits for the current build’s Service Worker
to control the page and verifies headers before at most one reload per build.

Everything uses relative paths, so a project subpath like `https://user.github.io/repo/`
works without configuration.

## PWA and offline use

The site is installable as a Progressive Web App. `manifest.webmanifest` supplies its app
identity and icons, while `sw.js` precaches the complete converter, both donor profiles, and
all first-party JavaScript. Paths stay relative so the same files work at the root of a
domain or under a GitHub Pages project subpath.

The cache uses the network first when available, then falls back to its saved copy. This
keeps the deployed app current without giving up offline use. The optional libheif decoder,
MediaPipe runtime/models, and visit counter are third-party requests and are deliberately
not persisted by the service worker; without the decoder, photo analysis falls back to the
tested donor-statistics path.

After changing runtime files or the manifest, check that the offline asset list is complete:

```bash
node tests/web/check-pwa.mjs
```

## What it ships

The current website does not load or ship FFmpeg WASM, ffprobe WASM, or an FFmpeg
worker. New HEVC main images, auxiliaries, masks, and 8-bit linear thumbnails use
WebCodecs; the linear-thumbnail SPS colour tags are edited in JavaScript. Python/CLI
still uses native FFmpeg/libx265 for its new 10-bit Main10 linear thumbnails, and
some local verification tests use native FFmpeg. Neither is a website dependency.
MediaPipe's WASM runtime is used for local inference and is unrelated to FFmpeg.

| | |
|---|---|
| Size | First-party JavaScript and two compact donor profiles; no bundled FFmpeg |
| Requests | `index.html`, `app.js`, first-party modules, one profile per photo layout |
| External | optional decoder plus optional MediaPipe runtime/model — see below |
| Hosting | local HTTP on localhost, or the hosted HTTPS website; COOP/COEP supplied by the development server or Service Worker |

## Optional external dependencies

HEIC scene measurements, mask analysis, and fallback previews can use the lazy libheif
decoder from jsDelivr. `src/decode.js` currently loads its classic JavaScript/asm.js
build and reuses the initialized library in the same page. Other workflows can use native
image decoding when available.

HEIC mask analysis currently calls libheif on the main thread: it decodes the full-resolution
image before scaling it for analysis. Its asynchronous callback does not move the heavy decode
into a Worker, so large photos can block buttons, scrolling, and the progress timer. HTTP and
HTTPS use this same mask-decoding path. The decoded-image cache is keyed by the byte-array object;
separate arrays for preview and processing can cause the same photo to be decoded again.

These requests fetch processing code; photo data stays on the device. Optional scene
analysis failures use donor statistics and flat light maps, the configuration used for
deterministic Python reference comparisons. Routes requiring decoded pixels or new HEVC
images still need a working decoder/encoder and report an error if those are unavailable.

To serve the decoder locally, vendor the matching classic build and point `LIBHEIF_URL` at it:

```bash
npm pack libheif-js@1.18.2
tar -xzf libheif-js-1.18.2.tgz
mkdir -p web/vendor
cp package/libheif/libheif.js web/vendor/
```

When generating face data or a missing Portrait effect matte, `src/face-mattes.js` lazily downloads a pinned
MediaPipe Tasks Vision module/WASM, Google's Face Landmarker, and the six-class
SelfieMulticlass segmenter. Inference happens in the browser; the photo is never sent with those
requests. Face Landmarker supplies ROI/landmark metadata while SelfieMulticlass supplies
per-pixel background, hair, body-skin, face-skin, clothes, and accessory confidence.
Portrait-only generation requires the segmenter without the Face Landmarker. The
"Preparing local face and segmentation models" step includes runtime/model fetching
and initialization. First use can take seconds; subsequent photos in the same page
reuse cached model promises and may take milliseconds. Reloading creates new model
instances even when HTTP downloads are cached. Face Landmarker tries GPU, then CPU on
initialization failure; SelfieMulticlass uses CPU. Detection and segmentation are timed
in their own later steps.
Group photos use one full-frame face pass plus four overlapping enlarged crop passes; detections
are remapped to full-image coordinates and deduplicated before masks and people metadata are built.

Writing that mask needs HEVC. The implementation asks `VideoEncoder.isConfigSupported()` for
an HEVC encoder and uses the returned `HEVCDecoderConfigurationRecord` as the matte's `hvcC`
property. If face/mask generation is unavailable, otherwise supported routes continue with
empty 2026 semantic mattes and the result row explains why no generated face mask was included.
Routes requiring new main images or linear thumbnails still need an HEVC encoder; a missing
Portrait effect matte is omitted when its generation is unavailable.

The browser maps face-skin plus body-skin confidence to `semanticskinmattev2`, face-skin to
`semanticfaceskinmatte`, body-skin to `semanticnonfaceskinmatte`, and inverse-background confidence
to `semanticpersonmatte`. Source-native skin takes priority: an existing `semanticskinmatte`
is preserved and supplies a missing `semanticskinmattev2` by reusing its encoded pixels,
dimensions, codec, colour and transform properties. If both source masks exist, each keeps
its own original content. The two auxiliary URIs remain distinct. This applies to both donor
profiles, native style photos receiving Texture/Grain, and HEIC compatibility re-encoding.
Only when source skin is absent does browser-generated confidence supply both semantic
generations, including PNG/JPEG/WebP imports. Donor masks are never treated as source-native skin.
Generated masks approximate Apple's detector; copying legacy pixels into a v2 item does
not reproduce Apple's v2 segmentation model. Shared properties on other items remain unchanged.
It partitions
the person confidence by the closest detected face for `semanticpersoninstances`. These confidence
maps are smoothly resampled with their source aspect ratio preserved, with a longest edge of
768 pixels and even dimensions for HEVC. Rotation and mirroring convert them to stored
orientation; each generated matte and person instance carries matching HEVC dimensions and
its own `ispe`. PNG/JPEG/WebP face analysis also preserves the source aspect ratio. Empty fallback
mattes retain the reference 768x576 raster. It also derives the people/skin
coverage and statistics in the styles plist, creates one instance mask per detected face, and
writes per-face ROI, colour, roughness, and instance-mask references into
`TextureStylePostProcessedPeopleData`. Its 76 landmarks follow the native ordering inferred from
native reference samples: left/right eyes, left/right eyebrows, outer/inner lips, nose crest/base, then the
right-temple-to-left-temple face contour. The individual MediaPipe points are approximations of
Apple's private detector output; the group boundaries and array positions are kept stable. Face Mesh
contours populate nose, lips, eyebrows, and approximate ears; mouth pixels provide a conservative teeth
mask; the segmenter's accessory confidence is restricted to the eye region for glasses; and non-face
body skin outside the face/neck core supplies conservative hand candidates. Tattoo remains blank unless
a future dependable classifier can avoid confusing shadows and clothing with ink. All generated data is
experimental and not yet phone-validated as equivalent to Apple's private segmentation.

Yaw, pitch, and roll come from MediaPipe's column-major canonical-to-runtime face matrix. The
rotation is decomposed as `Rz * Ry * Rx`, kept in radians (`faceUnitOfAngle = 1`), then calibrated
per axis against the four native faces in native reference samples. This corrects the different neutral-face
zero points without mixing axes; the largest residual on those four reference faces is about
0.036 radians (2.1 degrees), so the values are estimates rather than Apple detector output.

Every row has a single **Compare all embedded data** inspection entry, including photos
that already carry Texture/Grain and are left byte-for-byte untouched. It uses one canonical
row list for the input and output, so a missing item is shown as “Not present”. Masks, ratios,
statistics and ROI/numbered landmark geometry are read from the actual HEIC in this panel.
Each label shows a localized name and its technical identifier. Differences cover
payload bytes, properties and essential flags, property order, and graph relationships.
The compact `references` summary lists each reference type and its target count:
`["auxl", 1]` to `["auxl", 2]` means one target became two, not that an item was renumbered.
Grafted auxiliaries can be linked to both the primary and tmap while retaining encoded
pixels. Some depth/matte transplantation also changes descriptive-property order or
essential flags; the comparison reports these changes and does not claim Apple rendering
equivalence. Coverage percentages alone do not establish identical encoded data.
When browser face detection ran, the same panel includes a collapsible **Detection overlay
(not embedded)** with PNG download. Blue marks people, red marks skin, and green marks face
landmarks. This is the inference preview and can differ from source-native masks preserved
in the output. Without a detection run, the overlay section is hidden.

The inventory covers the HDR gain map, style delta map, tmap, styles and texture_styles plists,
TextureStylePostProcessedPeopleData, Portrait depth, six legacy Portrait/semantic mattes, all twelve 2026 mattes,
semanticpersoninstances, the three person-mask hints/ratios, and the seven person/skin statistics
blocks with their nine percentile fields. Direct HEVC masks are decoded to images when WebCodecs
allows it; grid maps and metadata items show their structure or JSON rather than pretending to be
semantic masks.

## Independent 8-bit linear thumbnails

Style-less HEIC and raster imports now encode a separate, proportional thumbnail with a
maximum 1024-pixel long edge. A Display P3 canvas provides colour-managed samples; the
sRGB/P3 transfer curve is removed before explicit limited-range YUV conversion.
Encoding uses 8-bit I420 samples and WebCodecs HEVC Main. To support browsers
that reject a linear-transfer VideoFrame, these already-linear raw samples use
encoder-negotiated SDR transport tags during encoding. A black probe detects the
encoder's transfer, YUV matrix and full/limited range before the actual linear
samples are submitted. Linear RGB is converted directly into that negotiated
BT.709 or BT.601 YUV representation; it is not gamma-encoded again. A JavaScript
SPS VUI edit then sets P3 primaries and linear transfer without changing picture
NALs, preserving the negotiated matrix/range in both SPS and HEIC nclx. Actual
SPS fields take precedence over browser metadata, which supplies omitted fields. Colour
changes after negotiation and SPS disagreements are rejected. The output retains P3
primaries and linear transfer with the negotiated YUV matrix/range. The returned
hvcC, actual SPS and pixi must agree on 8-bit depth. The HEIC receives separate
hvcC, pixi, ispe and nclx properties for this auxiliary.

Unsupported canvas formats, encoder failures and changed colour metadata stop
conversion with an explicit error. Existing native style photos keep their original
linear thumbnail, including native 10-bit data. Float16 canvas samples are preferred.
This is an experimental reconstruction of an auxiliary image.

The Web build now has an experimental generic HEIF graph graft for many style-less HEIC files with
1–48 primary tiles and either no HDR gain map, one standalone HDR item, or a tiled HDR count that
matches an available donor graph. It rewrites the donor's item graph and grid descriptors to the
source layout while copying every original primary and compatible HDR HEVC tile payload byte-for-byte.
When the source lacks a thumbnail or HDR gain map, WebCodecs generates only the missing auxiliary;
the original primary compressed data is not re-encoded. Separate decoding can still be
needed for analysis or a new linear thumbnail. This covers the tested 42/0, 40/0,
36/0, and 42/15 layouts.

HEIC graphs that cannot be mapped safely—currently including tiled-HDR counts for which no donor exists or
more than 48 primary tiles—still fall back to the same local WebCodecs compatibility path used for
PNG/JPEG/WebP. That path rebuilds the pixels and therefore does not promise the generic graft's
primary-payload preservation. Its grid is now sized dynamically and does not upscale an image merely
to imitate the donor's 4032-pixel edge.

PNG/JPEG/WebP import is different because there is no compressed HEVC image to preserve. That path
requires a browser HEVC `VideoEncoder`: it keeps the source pixel dimensions whenever they fit in
the donor's 48 available item slots, computes the smallest required 512-pixel tile grid, and removes
the unused slots. It also makes an independent 8-bit linear thumbnail and a neutral tiled HDR
gain map. Images too large for 48 tiles are reduced only as much as necessary. It then adds v16 Photographic Styles,
Texture/Grain, and generated 2026 semantic mattes when local face inference is available,
otherwise empty semantic masks. A missing Portrait effect matte is generated from person
segmentation when possible and omitted when unavailable. No Windows program, Python process or server upload
participates in primary encoding; new linear thumbnails use 8-bit WebCodecs.
WebP imports use the same pipeline, identified by the RIFF/WEBP file signature. Transparent
pixels are composited onto black, and the output is a still HEIC image.
Browsers without a compatible HEVC encoder receive an explicit
error and no partial file. This newly encoded path is experimental and must be kept separate from
the lossless container-only path used for existing HEIC photos.

Raster colour is encoded explicitly: Canvas colour-manages source ICC/Display P3 colours
into sRGB. Browser HEVC encoders can return BT.709 primaries even for a P3 input frame,
so this re-encode path targets the sRGB/BT.709 gamut. Before each encoding batch, one
discarded frame probes the same encoder and dimensions. Its returned colour description
selects the transfer curve (sRGB or BT.709), YUV matrix (BT.709 or BT.601) and full/limited
range used to convert the real RGB samples to I420. `src/raster-color.js` performs the
matching pixel conversion and writes that configuration into the HEIC's `nclx` boxes.
The probe frame never enters the photo or its tile count. The primary tiles,
primary grid, tmap, ordinary thumbnail and neutral gain map receive their encoder's colour description
instead of inheriting the donor ICC. Conflicting colour metadata from an encoder fails the
import rather than producing a mislabeled photo. Existing HEIC primary bitstreams are preserved.

## iPhone notes

Two iOS behaviours are handled explicitly:

- **Selecting from the Photo Library.** Open **Options → Format** and change
  **Automatic** to **Current** to keep the photo's existing format. A HEIC photo can then
  use the HEIC metadata-port path. **Browse** also lets you select a HEIC file directly.
  JPEG/PNG/WebP photos use the local import path when Safari exposes HEVC WebCodecs.
- **Getting the result back into Photos.** Where the browser supports sharing files, a
  **Save to Photos** button hands the finished `.heic` to the native share sheet, so
  **Save Image** puts it straight in the library. A normal download sits alongside it.

## Editing the copy

Every word the page shows, in both languages, is in `src/i18n.js`. `index.html` has no text
of its own — elements carry `data-i18n` keys and are filled in at load and when the language
button is pressed.

```bash
uv run python -m http.server -d web 8000   # then edit src/i18n.js and reload
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
node tests/web/generic-graft.mjs  # 42/0, 40/0, and 36/0 primary-payload preservation
node tests/web/legacy-skin.mjs    # both donors, missing skin, PNG import, native upgrade
node tests/web/check-pwa.mjs      # manifest, icons, and offline asset coverage
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

Three are byte-for-byte identical. The other three differ only in how the styles plist is
packed — `plistlib` and this bplist writer lay objects out differently — so that one item is
compared semantically: every key and value matches, including the binary `c`/`d` maps. All
other items are byte-identical.

Photo fixtures stay local. Tests use generic filenames under the Git-ignored
`tests/private-fixtures/` directory; supply samples matching the filenames and layouts
specified in each test. Generate reference outputs for the comparison tests with:

```bash
uv run photographic_style_port.py patch IN.HEIC tests/web/ref/NAME_ref.HEIC \
  --linear-thumb reuse-thumbnail --scene-stats donor --light-maps flat
uv run photographic_style_port.py add-texture Smartstyle/NAME.HEIC tests/web/ref/NAME_addtex_ref.HEIC
```

The four `add-texture` cases cover native-photo mode (`src/texture.js`): an iPhone 16/17 style
photo gets the iOS 27 Texture/Grain set and, when needed, its styles plist is upgraded from the
older schema to v16 with an identity tone curve. This avoids the near-black Glow/Film result
reproduced and validated on a phone with a native reference photo. JavaScript output must match Python's.

## Layout

| File | Role |
|---|---|
| `src/box.js` | ISO-BMFF box reading and writing |
| `src/heif.js` | Item graph: `iloc`/`iinf`/`iref`/`ipma`/`ipco`, discovery, surgery |
| `src/native-mattes.js` | Read-only WebCodecs viewer for embedded iPhone 18 semantic masks |
| `src/raster-import.js` | Local Canvas/WebCodecs PNG/JPEG/WebP-to-HEIC encoder and container builder |
| `src/linear-thumbnail.js` | P3 linearization, 8-bit auxiliary encoding |
| `src/raster-color.js` | Explicit P3/sRGB RGB-to-I420 conversion and HEIC colour signalling |
| `src/bplist.js` | Apple binary plist reader and writer |
| `src/exif.js` | MakerNote `0x54` injection, preserving the target's Exif |
| `src/styles.js` | Scene statistics, `c`/`d` light maps, person-mask hint |
| `src/zip.js` | Donor profile reader, via `DecompressionStream` |
| `src/port.js` | The patch pipeline |
| `src/texture.js` | iOS 27 Texture/Grain set (texture_styles + 2026 mattes), and native-photo insertion |
| `src/decode.js` | Optional libheif decoding, isolated behind one callback |
| `profiles/` | The two donor profiles, exported from the Python build |

`src/port.js` takes the decoder as a callback, keeping container manipulation independent
of libheif. This also lets `port.js` run unchanged under Node for the comparison tests.

## Layout support and limits

The two exact donor graphs remain 48/12 and 45/15. Matching sources use those profiles directly. A
matching primary layout with one standalone `hvc1` HDR gain map is also supported: the browser
preserves that gain-map payload, codec configuration, dimensions, orientation, and auxiliary
relationship byte-for-byte.

For many other sources with 1–48 primary tiles, the generic graph graft chooses a donor with enough
primary slots and, for tiled HDR, the same HDR tile count. It preserves the source primary/HDR
payloads and creates only missing auxiliaries. For example, 42/15 uses the 45/15 donor and removes
three unused primary slots.
This is not a formula that reconstructs every opaque Apple profile blob: it is an explicit graph
rewrite with structural checks, and it reuses the donor's style metadata and neutral delta tiles.
Unknown tiled-HDR graphs, more than 48 primary tiles, missing Apple Exif, unsupported HEIF box
layouts, and a missing thumbnail combined with non-identity orientation use the compatibility
re-encode when possible and otherwise produce a clear error.

When a compatibility re-encode is required and the source contains an Apple Portrait depth
auxiliary, the fallback preserves its original HEVC bitstream, dimensions, codec/orientation
properties, `auxl` relationship, and associated XMP blur metadata instead of silently dropping it.
