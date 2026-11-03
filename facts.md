# Photographic Style Port: facts

How `photographic_style_port.py` changes the metadata of a normal HEIC so that Apple Photos
offers the Photographic Styles palette (风格 / 调色板), Portrait editing and, on iOS 27,
Texture/Grain (质感 / 颗粒). It covers everything tried from the early V-series experiments to
v0.6.2: what worked, what failed, and what is still open. Usage, testing and the version history
are in the [README](README.md).

**Status labels**

| Status | Meaning |
|---|---|
| ✅ **Proven** | Tested in Apple Photos on a device: the control appears, has a visible effect, and survives save → reopen → re-edit |
| ☑️ **Solid** | Verified at file level (libheif opens it; payloads byte- or pixel-identical; structure matches native files) or by calibration against native files, but not phone-tested on its own |
| 🔍 **Investigate** | A hypothesis, known gap, donor-derived value or unknown meaning; needs more work before it is final |

---

## 1. Overview

Photos decides which editing controls to offer from **what the file contains**, not from the
camera model. Each control appears when the file carries the data that control reads. The
renderer already runs on older iPhones; what an older photo lacks is the data. The port adds
it, and the decoded photo stays pixel-identical to the original. ☑️

### Design principle
Anything software can calculate or approximate is not considered a hardware-specific feature,
so writing it into a photo is not considered adding a hardware-only capability. The end goal
is a port that writes only five kinds of data:

1. **Format declarations**: item types, URIs, schema and pixel-format fields that describe
   what the file contains and how it is laid out.
2. **The photo's own data**: pixels, HDR, Exif, depth, mattes and sidecars, rearranged but not
   altered.
3. **Values calculated from the photo**: scalars such as tone statistics.
4. **Maps calculated from the photo**: images and grids such as light maps and the linear
   thumbnail.
5. **Neutral defaults**: software stand-ins for capture-time results the port cannot reproduce
   (identity, flat, empty). They claim nothing about the scene.

Exif `Make` / `Model` are never changed, so a ported photo still names the camera that took it.

Today the port also takes a structural template and a few values from a **donor**, a
normalized native iPhone 16 file embedded in the script. Donor-derived data is not part of the
end goal and remains an **open issue** (§8).

For where every piece of metadata stands today, see the status sheet in §2.1.

---

## 2. Metadata: status and requirements

### 2.1 Status sheet

Every piece of metadata the port writes, what kind of data it is (§1), and its status.

A row can be ✅ and still have an open point: it works, but something about it is not yet
understood or not yet in its final form.

**Photo data and container**

| Metadata | Port writes | Kind | Status | Open point |
|---|---|---|---|---|
| Primary image tiles + `hvcC`/`colr` | The photo's own, pixel-identical | Photo's own | ✅ | – |
| HDR gain-map tiles + `hvcC` | The photo's own | Photo's own | ☑️ | HDR rendering not tested on its own |
| HDR XMP sidecar (headroom) | The photo's own | Photo's own | ☑️ | – |
| `tmap` geometry (`ispe`/`irot`) | The photo's own, or derived from the primary | Photo's own | ☑️ | – |
| `tmap` payload (gain-map parameters) | The photo's own (since v0.5.1); a photo without one keeps none (v0.6.2) | Photo's own | ✅ | Donor's only on the `--graph donor` fallback |
| Ordinary thumbnail | The photo's own, or encoded from the primary if missing | Photo's own / map | ✅ | – |
| Exif, Make/Model unchanged | The photo's own | Photo's own | ✅ | – |
| Orientation `irot` / `imir` | The photo's own | Photo's own | ✅ | – |
| Item graph (IDs, `iref`, `ipma`, `ipco`, grids) | The photo's own, plus the style items (v0.6.2, §3); donor template only for sizes without a known StyleDeltaMap | Photo's own / format | ✅ | 48 MP (v0.6.3) uses 512-pixel tiles where natives use 640×896; phone-tested |
| `mdat` and `iloc` offsets | Rebuilt | Format | ✅ | – |

**Style palette**

| Metadata | Port writes | Kind | Status | Open point |
|---|---|---|---|---|
| MakerNote `0x54` | Fixed 8-key record, neutral pad | Format | ✅ | Members `1`/`2` vary with capture (likely the Tone/Color pad, §8); `4`, `6` vary too; the rest unknown |
| Styles item (`metadata:styles`) | New item | Format | ✅ | – |
| Styles `0` (schema), `e`/`f`, `g`, key `3` header | Fixed values | Format | ✅ | – |
| Styles `1` coefficients | Identity | Neutral | ✅ | Native values not reproduced (affects the look, §9) |
| Styles `3` tone curve | Identity | Neutral | ✅ | Native values not reproduced (affects the look, §9) |
| Styles `c`/`d` light maps, flat (default) | Constants | Neutral | ✅ | – |
| Styles `c`/`d` light maps, `--light-maps target` | Calculated from the photo | Map | ✅ | Stored orientation, no flip (fixed in v0.6.2, §4.1) |
| Styles `6` tone statistics | Calculated from the photo | Value | ☑️ | – |
| Styles `6` `highKey` | **Donor's** | Donor | 🔍 | Derivation unknown (§8) |
| Styles `i` (HDR range, `Gain`) | **Donor's** | Donor | 🔍 | Neither follows headroom or generation alone (§8) |
| Styles `h` | **Donor's** | Donor | 🔍 | Equals `Gain / 4` in all 30 native files; calculable once `Gain` is resolved (§8) |
| Styles `2` | **Donor's** (`True`) | Donor | ☑️ | `True` in all 30 native files: a format declaration (§8) |
| Styles `4`, `5`, `j` | **Donor's** | Donor | 🔍 | All three vary between native files; unknown (§8) |
| Styles `k` / `l` | Not written | – | ✅ | Not needed; `False` in every native file that has them |
| Delta map | Neutral constant tile | Neutral | ✅ | – |
| Linear thumbnail, `generate` | Encoded from the photo with its own `hvcC` | Map | ✅ | irot 90/270 were stored 180° off up to v0.6.1, causing a glow on some photos; fixed (§4.4) |
| Linear thumbnail, `reuse-thumbnail` | The photo's own thumbnail | Photo's own | ✅ | – |

**People layers and Portrait**

| Metadata | Port writes | Kind | Status | Open point |
|---|---|---|---|---|
| Classic semantic mattes | The photo's own | Photo's own | ✅ | Which mattes are needed individually |
| Matte slots the photo does not fill (with or without people) | Exactly empty 2016×1512 frame (since v0.6.1; before, the donor's near-empty matte) | Neutral | ✅ | – |
| `PersonMasksValidHint` | 1.0 when mattes are carried | Value | ✅ | – |
| `PeopleRatio` / `SkinRatio` | Not written (stay 0) | – | ✅ | Not needed for Soft Skin (§7) |
| Depth map | The photo's own | Photo's own | ✅ | – |
| XMP sidecars (depth, mattes) | The photo's own, remapped | Photo's own | ✅ | – |

**Texture and Grain (iOS 27)**

| Metadata | Port writes | Kind | Status | Open point |
|---|---|---|---|---|
| `texture_styles` item | Native iPhone 18 Pro record | Native record | ✅ | – |
| `HardwareModel` | `iPhone19,2` | Native record | ✅ | Names a device other than the photo's own (§8) |
| `FilmGrainSeed` | CRC-32 of the photo's first primary tile mod 256 (since v0.6.1; before, 92 for every photo) | Value | ✅ | – |
| `TextureStylePeopleDataVersion` | 3 | Native record | ✅ | – |
| `Preset`, `CaptureType`, `CaptureMode`, `PortType` | Native values | Native record | ✅ | Not tested one at a time |
| `TextureStylePostProcessedPeopleData` (photos with people) | One entry per face: boxes and angles from the photo's face regions, a fixed landmark layout, median native colour statistics | Value / neutral | ✅ | Turned faces (beyond ~30°) less accurate (§7) |
| 2026 matte set (×12) | Empty frames; on photos with people, skin v2, face skin and person carry the photo's own skin / Portrait matte | Neutral / photo's own | ✅ | – |
| 2026 matte sidecars (×12) | Native XMP | Format | ☑️ | Not tested without the mattes |
| `semanticpersoninstances` (photos with people) | One per face: the photo's own Portrait matte, keyed XMP sidecar | Photo's own | ✅ | One matte serves every face |
| Soft Skin result | – | – | ✅ | Needs all of the above together (§7) |

### 2.2 What each control needs

Numbers refer to the item reference in §2.3.

| Control | Needs | What happens without it |
|---|---|---|
| **Style palette** | #1 MakerNote `0x54`, #2 styles item, #3 linear thumbnail with a matching `hvcC`, #4 delta map, #5 HDR/`tmap` structure | No `0x54` → no palette. Mismatched linear-thumbnail `hvcC` → palette appears but edits do nothing. |
| **People layers** (people and background styled separately) | #8 the photo's own mattes with sidecars, #9 `PersonMasksValidHint = 1.0` | People and background are styled as one layer |
| **Portrait** | #6 depth map + #7 its XMP sidecar | Portrait is not offered, or is offered but does nothing |
| **Texture and Grain** (iOS 27) | #10 `texture_styles` + all twelve #11 2026 mattes (with #12 sidecars) | #10 without #11 **removes the whole palette** |
| **Soft Skin** (iOS 27) | #10 with per-face people data + #13 person instances + real skin v2, face skin and person mattes in #11 | Missing any one of them, Soft Skin looks the same as Standard (§7) |

Texture and Grain have only ever appeared as a pair; no separate requirement for either is
known.

Tested and **not** required:

| Candidate | Result ✅ |
|---|---|
| Exif `Make` / `Model`, filename, other Exif fields | Changing them does nothing. Some real iPhone 16 photos have no style data and get no palette. |
| Styles schema 16, keys `k` / `l` (iOS 26.5 / 27 additions) | Schema 14 works on iOS 27, palette and Texture/Grain included |
| 13-key `0x54` (iPhone 18) | The 8-key form works on iOS 27 |
| Item order | Does not matter |
| Native coefficients, tone curve, light maps, delta map content | Identity, flat and neutral values work |
| Matte content | Empty mattes are enough for the palette |

### 2.3 Item reference

| # | Item | Identifier | Lives in | Port writes | Evidence |
|---|---|---|---|---|---|
| 1 | Apple MakerNote tag `0x54` | Exif `0x8769` → MakerNote `0x927C` → tag `0x54` (type 7) | Exif item | 109-byte, 8-key bplist `{0:1, 1:0.0, 2:0.0, 3:1.0, 4:1, 5:1, 6:4, 7:0}`, as in every native photo shot with the pad untouched; Apple's demo shots differ in `1`/`2` (and `4`, `6`), see §8 | ✅ |
| 2 | Styles item | `uri ` item `tag:apple.com,2023:photo:metadata:styles`, `cdsc` → primary + `tmap` | `iinf` + `mdat` | Mix of calculated, neutral and donor fields (§4.1) | ✅ |
| 3 | Linear thumbnail | aux `tag:apple.com,2023:photo:aux:linearthumbnail` | `hvc1` item, own `hvcC`/`ispe`/`pixi`, shared `irot` | Encoded from the photo (Main10, 1024×768), or the photo's own thumbnail reused | ✅ |
| 4 | Style delta map | aux `tag:apple.com,2023:photo:aux:styledeltamap` | `grid` of 512×512 Main10 tiles | One constant neutral tile in every slot | ✅ |
| 5 | HDR gain map + `tmap` | aux `urn:com:apple:photo:2020:aux:hdrgainmap`; `tmap` item | `grid` + derived item | The photo's tiles, `hvcC`, `tmap` geometry, `tmap` payload (v0.5.1) and HDR XMP. | ☑️ |
| 6 | Depth map | aux `urn:mpeg:hevc:2015:auxid:2` | `hvc1` item, own `ispe`/`pixi`/`colr`/`hvcC`, shared `irot` | The photo's own item, `auxC` included | ✅ |
| 7 | Depth sidecar | `mime` `application/rdf+xml`, `cdsc` → depth; `apdi:*` ranges/formats, `depthBlurEffect:*`, `depthData:Accuracy`, `portraitLightingEffect:*` | `iinf` + `mdat` | The photo's own sidecar, remapped to the new depth item | ✅ |
| 8 | Classic semantic mattes | `urn:com:apple:photo:` `2018:aux:portraiteffectsmatte`, `2019:aux:semanticskinmatte` / `semantichairmatte` / `semanticteethmatte`, `2020:aux:semanticglassesmatte` / `semanticskymatte` | `hvc1` items + XMP sidecars | The photo's own mattes; unused slots refilled with an empty matte | ✅; which mattes are individually needed 🔍 |
| 9 | Person-mask hint | styles key `7` → `PersonMasksValidHint` | styles plist | 1.0 when the photo's mattes are carried | ✅ |
| 10 | Texture styles item | `uri ` item named `metadata`, `tag:apple.com,2026:photo:metadata:texture_styles`, `cdsc` → primary + `tmap` | `iinf` + `mdat` (216-byte bplist; ~5 KB per face with people) | The record from a native iPhone 18 Pro capture (§5.1); on photos with people, plus per-face people data (§7) | ✅ |
| 11 | 2026 matte set (×12) | `tag:apple.com,2026:photo:aux:` + `semanticnosematte`, `semanticskinmattev2`, `semanticnonfaceskinmatte`, `semanticlipsmatte`, `semanticteethmattev2`, `semanticpersonmatte`, `semanticglassesmattev2`, `semanticeyebrowsmatte`, `semantictattoomatte`, `semantichandsmatte`, `semanticearsmatte`, `semanticfaceskinmatte` | 12 `hvc1` items: shared `ispe`/`pixi`/`hvcC`, own `auxC`, primary `irot`, `auxl` → primary + `tmap` | Empty 768×576 8-bit frames (156 B each); with people, skin v2 / face skin = the photo's `semanticskinmatte` and person = its `portraiteffectsmatte`, each with that matte's `ispe`/`pixi`/`hvcC` | ✅ |
| 12 | 2026 matte sidecars (×12) | `mime` items, `cdsc` → each matte; `fsincMattes:FSINCMatteVersion 0` | `iinf` + `mdat` | Native 357-byte XMP | ☑️; never tested on its own |
| 13 | Person instances (one per face) | aux `tag:apple.com,2026:photo:aux:semanticpersoninstances` + `mime` sidecar with `fsincMattes:InstanceMaskReferenceKey` | `hvc1` items wired like #11 | The photo's `portraiteffectsmatte`; keys `FSINCInstanceMask9`, then `0`, `1`, … as native files number them | ✅ |

### 2.4 What the port writes, by kind

Sorted by the five kinds in §1. The donor row is the open issue in §8.

| Kind | Contents |
|---|---|
| Format declarations | URIs and item types of #2–#12; styles `0`, `e`/`f`, `g` (`'L00h'`, the half-float pixel format of the light maps) and the key `3` header; XMP version strings; #1 `0x54` (identical across native files, so treated as a format record; member meanings 🔍) |
| The photo's own data | Primary, HDR and thumbnail tiles with their `hvcC`/`colr`; Exif; `irot`/`imir`; `tmap` geometry; HDR XMP; #6–#8 depth, sidecars and mattes; on people photos the skin/person mattes in #11 and #13 |
| Values calculated from the photo | Styles key `6` tone statistics; #9 hint (set from whether the photo has mattes); face boxes and angles in the #10 people data (from the photo's face regions) |
| Fixed values from native Soft Skin photos | Landmark layout and colour statistics in the #10 people data (medians of 14 native faces) |
| Maps calculated from the photo | #3 linear thumbnail; light maps with `--light-maps target`; a synthesized thumbnail when the photo has none |
| Neutral defaults | Identity coefficients and tone curve; flat light maps (default); #4 neutral delta map; #11/#12 empty 2026 mattes; an exactly empty frame in every matte slot the photo does not fill |
| Taken unchanged from a native capture | #10 `texture_styles`, including `HardwareModel` and a fixed `FilmGrainSeed` (both 🔍, §8) |
| **Donor** | Styles `i`, `h`, `4`, `highKey`, `2`, `5`, `j` |

---

## 3. What `patch` does, step by step

1. **Choose a route.** A photo with no style data gets the full port. A photo that already has
   native style data (iPhone 16/17) only gets Texture/Grain added (§5.4). A photo that already
   has `texture_styles` is refused.
2. **Keep the photo's own item graph** (v0.6.2, default). A native iPhone 16+ file differs from
   an iPhone 15 photo only by a linear thumbnail, a StyleDeltaMap grid, the styles item,
   MakerNote `0x54` and the `ftyp` brands `MiHA`/`heix`. Tiles, HDR, `tmap`, Exif, mattes, depth
   and sidecars are already the photo's own, so they stay where they are, byte for byte.
3. **Add the style items** with the property bytes every native file uses (identical in 31
   native files and both donors): linear thumbnail (`ispe`, `pixi` 3×10-bit, `auxC`, `hvcC`,
   primary `irot`; `auxl` → primary + `tmap`); StyleDeltaMap grid (`colr` "Display P3 Linear"
   ICC, `ispe`, `pixi`, `auxC`, primary `irot`; descriptor in `idat`; `dimg` → 512×512 tiles with
   `ispe`/`colr`/`hvcC`); styles `uri` item named `metadata` (`cdsc` → primary + `tmap`). The
   StyleDeltaMap size comes from the native table below; a photo of another size falls back to
   the donor graph.
4. **Insert MakerNote `0x54`** into the photo's Exif (§3.3).
5. **Write the style data:** the styles plist (§4.1), a neutral delta map (§4.2) and a linear
   thumbnail made from the photo (§4.3).
6. **Add the Texture/Grain set** (§5), with Soft Skin data when the photo has people (§7).
7. **Rebuild the file:** new `ftyp` and `meta` in front, every original payload in place
   (offsets shift by the header growth), new payloads in one appended `mdat`, then a
   self-check.

| Primary (stored) | StyleDeltaMap | Tiles |
|---|---|---|
| 4032×3024 (12 MP) | 2880×2160 | 6×5 |
| 5712×4284 (24 MP) | 4096×3072 | 8×6 |
| 3088×2316 (front) | 2240×1680 | 5×4 |
| 8064×6048 (48 MP) | 5760×4320 | 12×9 |
| portrait-stored | the same, swapped | |

8064×6048 (48 MP) natives tile the same 5760×4320 map 9×5 with 640×896 tiles. The port uses
12×9 of its 512×512 neutral tile instead (the grid trims the excess, as for the other sizes);
Photos accepts it: phone-tested in v0.6.3 with and without an encoder.

**Phone A/B** (v0.6.2): 48/12 photos with and without an encoder, a Portrait photo with a face
(Portrait, people layers, Soft Skin), and 24 MP / 12 MP re-saved photos without thumbnail or
`tmap` all work with the photo's own graph. ✅

**Donor graph** (`--graph donor`, the only route up to v0.6.1): pick a template by tile layout
(`48-12` or `45-15`), move the photo's tiles, thumbnail, orientation, `tmap`, mattes, depth and
sidecars into its item slots with their `hvcC`/`colr`, then write one fresh `mdat`.

### 3.1 Payloads travel with their decoder configuration
A compressed payload and its `hvcC` (and `colr`, where it has one) must always move together.
This was learned twice:

- **Primary tiles (v0.1 → v0.1.1).** The photo's tiles combined with the donor's `hvcC` showed
  rectangular block corruption. Moving the photo's own `hvcC` and `colr` along fixed it, and the
  output now decodes identically to the source. ✅
- **Linear thumbnail (V7 → V8).** Apple stores one VCL NAL in the payload and the VPS/SPS/PPS in
  `hvcC`. V7 replaced the payload but kept the donor's `hvcC`: the palette appeared but edits
  did nothing. Even re-encoding the *donor's own* image failed, so the problem was never the
  pixels. V8 encoded each candidate as a one-frame MP4 and moved the sample together with that
  MP4's `hvcC`. All four variants worked. ✅

When some items in a shared property slot get the photo's payloads and others keep donor
payloads, the port appends a second `hvcC` and repoints only the items that changed.

### 3.2 Template details (current mechanism; replacing it is open, §8)
- `extract-donor` turns a native iPhone 16/17 HEIC into a profile ZIP: `manifest.json`,
  `ftyp.bin`, `meta.bin`, `makernote_0x54.bin` and `payloads/<iid>.bin`. The donor's pixels,
  HDR, thumbnail, Exif and linear thumbnail are left out, so no donor image content reaches the
  output. ✅
- The two profiles are embedded in the script (zlib + base85).
- A matching tile count is not enough on its own: grid geometry, tile order, `hvcC`, `colr` and
  property associations must all line up. ☑️
- Do not rename the `smartstyle-port-donor-profile` format marker or the
  `smartstyle_makernote_*` manifest keys. They are stored inside the embedded ZIPs, and renaming
  them breaks loading.

### 3.3 MakerNote `0x54`
- Same style data, `0x54` absent → no palette; `0x54` present → palette works (V9). ✅
- Copying the donor's **whole** Exif also brings back the palette, but it carries unrelated
  donor capture state: one test showed a Portrait option on a photo with no usable subject.
  Only `0x54` is inserted. ✅

How the insertion works (`inject_apple_makernote_tag`):
1. Follow IFD0 → `0x8769` ExifIFD → `0x927C` MakerNote and require the `Apple iOS` header.
2. Rebuild the MakerNote IFD with `0x54` added or replaced, sorted by tag. If an entry is added,
   shift every out-of-line value offset by +12.
3. Append the rebuilt MakerNote at the end of the TIFF and point `0x927C` at it (type 7). The
   old MakerNote stays in place, unused, so no other Exif offset moves.

Photos taken with the old Photographic Styles (`SemanticStyle`, iPhone 15 era) have none of the
new items. Changing a preset ID cannot upgrade them; the new item graph has to be built.
☑️

---

## 4. Style data in detail

### 4.1 The styles plist, field by field

| Key | Shape | Meaning in native files | Port writes | Evidence |
|---|---|---|---|---|
| `0` | int | Schema: 14 (iOS 18.2), 15 (iOS 26.5), 16 (iOS 27) | 14 | ✅ |
| `1` | 51,840 B FP16 = 2×18×24×10×3 | Per-region 2nd-order RGB polynomial `[1,R,G,B,R²,G²,B²,RG,RB,GB]`; differs per scene | Identity | ✅ |
| `3` | 516 B = 4 B header + 256 × u16 | Global tone curve | Identity | ✅ |
| `c`, `d` | 32×32 FP16 (`e` = `f` = 32) | Light maps (tone-mapped / linear) | Flat 0.31152 / 0.20093 by default; calculated with `--light-maps target` | flat ✅; calculated ✅ (V10); current fit ☑️ |
| `6` | dict of stat blocks | `ToneMappedImage` / `LinearImage` percentiles, black/white point, `highKey` | Calculated from the photo (default); `highKey` from donor | ☑️ |
| `7` | dict | `PeopleRatio`, `SkinRatio`, `PersonMasksValidHint` | Hint 1.0 when mattes are carried; ratios never written | ☑️ |
| `g` | int | `1278226536` = `'L00h'`, pixel format of `c`/`d` | Same in every file | ☑️ |
| `i` | dict | HDR range: `OriginalRangeMin/Max`, `Gain` | Donor values | 🔍 (§8) |
| `h` | float | Exactly `i.Gain / 4` (30 of 30 native files) | Donor value | 🔍 (§8) |
| `4` | float | Unknown; 4.0–18.3, repeats exact values | Donor value | 🔍 (§8) |
| `2` | bool | `True` in all 30 native files | Donor value (`True`) | ☑️ format |
| `5`, `j` | int, float | Unknown; `5` is 0 or 2, `j` 1.0–1.33 | Donor values (0, 1.0) | 🔍 (§8) |
| `k`, `l` | bool | Added in iOS 26.5 / 27; always `False` | Absent | ✅ not needed |

Native coefficients, tone curve and light maps all differ from scene to scene (about 93% of
the key `1` bytes differ between two shots), but none of them is needed for the controls to
work.

**Calibration** (v0.3.1, regression on eight native files):
- `ToneMappedImage` holds percentiles of **linear-light** display luma (mean ratio 0.980,
  sd 0.076). v0.3.0 wrote gamma-encoded values, about 2× too high; that has since been fixed.
- `LinearImage` is the same signal × **0.166** (leave-one-out MAE 0.013).
- The light maps are stored in the primary's stored orientation, track linear luma, and clamp
  at 0.040741. The fits are `c = clamp(0.7774·L + 0.0294)` and `d = clamp(0.6542·L − 0.0128)`,
  with leave-one-out MAE 0.022 / 0.037 against 0.146 / 0.115 for the flat values.
- Orientation re-checked in v0.6.2 on 30 native files at `irot` 0, 180 and 270: the native
  `c` map matches the stored-orientation sample as is (r 0.94–0.99). The "180° rule" used up to
  v0.6.1 only cancelled the swapped 90/270 mapping (§4.4) and left 0/180 maps upside down. ☑️

### 4.2 Delta map: neutral, never the donor's
- Native delta maps are 10-bit RGB centred on 512 (about 470–560). Amplified, they show the
  scene they came from. ☑️
- With the donor's delta map, edits followed **the donor's scene regions** on the target.
  Flattening the light maps did not help; a constant neutral tile did (V11). ✅
- Editing still works with a neutral map, so it is a correction layer on top of the style, not
  the style itself: `styled ≈ F(image, style) + D(x, y)`, with `D = 0` in ports.
- Every tile gets the same neutral 512×512 Main10 sample with a matching `hvcC`.

### 4.3 Linear thumbnail
- Native: 1024×768, 10-bit HEVC Main10, sharing the primary's `irot`.
- **`generate`** (default): decode the photo, return it to its **stored** orientation, scale,
  encode Main10 with libx265, then move the sample and its `hvcC` in together. ✅
- **`reuse-thumbnail`** (v0.4.4): reuse the photo's own 8-bit thumbnail, which needs no encoder.
  Its `pixi` is shared with other items, so a new one is appended and only the linear thumbnail
  points to it. This is the only mode the browser build uses. ✅
- With neutral coefficients, flat light maps and a neutral delta map, the linear thumbnail is
  the renderer's **only spatially varying input**. A misoriented one is therefore the main
  possible source of blocky or patchy results.

### 4.4 Orientation and `tmap`
- Both templates share **one `irot` = 270°** across the primary, thumbnail, HDR grid, delta grid
  and linear thumbnail. Until v0.3.0 this made every photo with a different orientation display
  rotated. Now the photo's own `irot` (and `imir`, if the template has a slot) replaces it.
  ☑️
- `tmap` states its size in **display** orientation and has its own `irot`. Without updating
  it, Windows Photos (which renders through `tmap`) showed a black band under landscape ports.
  v0.4.1 copies the photo's `tmap` geometry, or derives it from the primary. ☑️
- **90/270 inversion, fixed in v0.6.2** ✅: up to v0.6.1 `raw_orientation_filters` (and
  `web/src/decode.js`) swapped irot 90 and 270, so linear thumbnails of those photos were
  stored 180° off. An early A/B showed nothing, but a 24 MP photo at irot 270 with sky above
  trees got a glow in the sky and foliage with both the donor and the photo graph; the
  corrected rotation removed it, and a 12 MP irot-270 photo that had passed still passed. Checked against 30 native files: Apple's own linear
  thumbnails match the corrected stored-orientation sample at every irot (r 0.83–0.97), never
  the 180°-turned one.
- With the photo's own graph (v0.6.2) the photo's `irot`, `imir` and `tmap` are simply kept.

---

## 5. Texture and Grain (iOS 27, v0.5.0)

### 5.1 What iPhone 18 files add
On iOS 27, Photos on an iPhone 15 Pro offers Texture/Grain for iPhone 18 photos, so the
renderer runs on older hardware too. Compared with iPhone 16 files, iPhone 18 files add
`texture_styles` (#10), the 2026 matte set (#11) with sidecars (#12), styles schema 16 with
`k`/`l`, and a 13-key `0x54`. Only #10 and #11 matter.

`texture_styles` is a 216-byte bplist with no pixel data:

| Field | Value | Notes |
|---|---|---|
| `Preset` / `CaptureType` / `CaptureMode` / `PortType` | `Standard` / `LF` / `Still` / `PortTypeBack` | Native values; not tested separately |
| `HardwareModel` | `iPhone19,2` | The iPhone 15 Pro value keeps the controls but makes white areas glow under some styles, so it likely selects render parameters. Names a device other than the photo's own. 🔍 (§8) |
| `TextureStylePeopleDataVersion` | 3 | Absent / 0 / 1 / 2 did not help a build missing #11 |
| `FilmGrainSeed` | 92 | Grain is generated from it at render time. Up to v0.6.0 every port got this same pattern; since v0.6.1 the port writes a per-photo seed (§8) |

### 5.2 On-device tests (iPhone 15 Pro, iOS 27; one 48/12 and one 45/15 photo)

| Build | Palette | Texture/Grain |
|---|---|---|
| iPhone 18 donor profile, unmodified | ✅ | ✅ |
| … with styles v14 and 8-key `0x54` | ✅ | ✅ |
| … with `texture_styles` disabled | ✅ | ❌ |
| … with `HardwareModel` → `iPhone16,1` | ✅ | ✅ but white areas glow |
| … with the 2026 matte URIs made unrecognisable | **❌** | ❌ |
| … with `texture_styles` placed after Exif | ✅ | ✅ |
| **v0.4.4 file + `texture_styles` only** | **❌** | ❌ |
| v0.4.4 file + `TextureStylePeopleDataVersion` absent / 0 / 1 / 2 | ❌ | ❌ |
| **v0.4.4 file + `texture_styles` + 12 empty 2026 mattes (v0.5.0)** | ✅ | ✅ |

`texture_styles` without the 2026 mattes removes the whole palette; item order does not matter.
✅ The test profiles come from `tools/texture_variants.py`.

### 5.3 Why it is added on top of the iPhone 16 templates
iPhone 18 donor profiles work on photos without people but **crash on people/Portrait photos**:
their matte set does not fit the people path. Adding the texture set to the v0.4.4 templates
leaves that path untouched, and `--texture off` reproduces v0.4.4 byte for byte.

How the set is appended (`add_texture_items`):
- Shared `ispe`, `pixi` and `hvcC` once, then one `auxC` per matte.
- Properties associated in native order, `ispe, pixi, auxC, hvcC, irot` (descriptive before
  transformative, as HEIF requires).
- Then the 12 sidecars, then the `texture_styles` item.
- The result matches native iPhone 18 files: property bytes, order, essential flags,
  references, payloads and sidecars. ☑️

### 5.4 Photos that already have style data (`add-texture`)
Porting a native iPhone 16/17 photo would replace its real style data with neutral values, so
only #10–#12 are inserted:
- `meta` grows (about 2.5 KB) and every external offset shifts by exactly that amount; new
  payloads go into one small `mdat` at the end.
- Before writing, every original payload must re-extract byte-identical and every new one must
  read back as written.
- Only Apple's native layout is accepted (iloc v1 4/4/0/0, iref v0, narrow ipma).
- Tested on native photos with and without people, including one with depth. ✅

### 5.5 Photos without a thumbnail
Some copies re-saved by iOS have no thumbnail and no `tmap`. Since v0.5 the port encodes a
thumbnail from the primary (416×312, 8-bit HEVC Main, stored orientation, its own `hvcC`).
✅ The browser build cannot do this, because it has no HEVC encoder.

---

## 6. People layers and Portrait

### 6.1 Layers in a people or Portrait photo
Each layer is a separate auxiliary image and drives a different control:

| Layer | Items | Separates | Drives | Port |
|---|---|---|---|---|
| Person and skin | Classic mattes #8 + sidecars | People, skin and hair from the background | People-aware styling | The photo's own mattes |
| Mask trust | `PersonMasksValidHint` #9 | – | Whether Photos uses the masks at all | 1.0 when mattes are carried |
| Depth | Depth map #6 + sidecar #7 | Subject from background by distance | Portrait (blur, depth effects) | The photo's own item and sidecar |
| iOS 27 people regions | 2026 mattes #11, person instances #13, people data in #10 | Faces, skin and each person | Soft Skin | The photo's own skin/Portrait mattes and face regions; other 2026 mattes empty (§7) |
| Light (not semantic) | Styles `c`/`d` | Bright from dark regions | Local tone adjustment | Flat or calculated |

### 6.2 Rules
1. **Layers come only from the photo itself.** A donor matte with content would apply the
   donor's regions to an unrelated photo, the same leak as the donor delta map. Slots the photo
   cannot fill get an empty matte.
2. **Never invent a layer.** A photo without mattes gets no people layer, and styling it as a
   whole is then correct. `PeopleRatio` / `SkinRatio` are never written; they are not matte
   coverage (on two native people photos, one matched within 10%, the other was 17× off).
3. **Mattes and depth are independent.** A Portrait of an object has depth and no mattes.
4. **A layer without its XMP sidecar does nothing.** The sidecar tells Photos how to read the
   samples. Every sidecar is carried and pointed at the item's new ID.
5. **Layers must line up with the photo:** shared primary `irot`, and `auxl` → primary + `tmap`.
6. **Each payload keeps its own `hvcC`.** Copy `auxC` byte for byte, because Apple stores extra
   `aux_subtype` data after the URI.
7. **The mask-trust flag must agree with the layers.** Real mattes with the hint at -1.0 still
   give whole-frame styling. The hint means "masks computed", not "person present"; native
   photos without people carry 1.0 too.
8. **Portrait must come from the photo's own depth**, never from donor capture state (§3.3).

New items are appended at the end of `ipco`, so no existing property index moves. Each needs one
`infe`, one `iloc` entry, one `ipma` entry and one `auxl`/`cdsc` reference.

### 6.3 History

| Version | Problem | Fix | Status |
|---|---|---|---|
| ≤ v0.3.1 | Edits worked, but **people and background changed as one layer**. Ports carried the donor's empty mattes and its `PersonMasksValidHint = -1.0` ("no usable masks"), and the photo's own mattes were dropped. | – | Observed ✅ |
| v0.3.2 | — | Carry the photo's mattes, refill unused donor slots with empty ones, set the hint to 1.0 (opt-in `--people on`) | People and background now separate ✅ |
| v0.4.0 | — | Automatic; photos without mattes come out byte-identical | ☑️ |
| v0.4.2 | Portrait missing: the depth map was dropped | Add depth as its own item, separate from the mattes; copy `auxC` byte for byte | ✅ |
| v0.4.3 | Portrait still did nothing: only half the XMP sidecars were carried | Carry every sidecar. This also replaced the donor's HDR headroom sidecar with the photo's. | ✅ |

Flat light maps (v0.3.1 note) also make tone adjustment uniform across the frame, but that is a
separate issue: they carry no people information.

---

## 7. Soft Skin (v0.6.0) ✅

Up to v0.5.1, Soft Skin looked the same as Standard on every port and every `add-texture` photo.

**What native photos carry.** Twelve native iOS 27 photos where Soft Skin works (iPhone 18,
14 faces) all have, beyond the v0.5 items:
- `texture_styles` of ~5.5 KB per face instead of 216 bytes: a
  `TextureStylePostProcessedPeopleData` array placed after `CaptureMode`, one entry per face, with
  `faceROI`, `faceSkinROI`, 76 `faceLandmarks`, `faceYaw`/`facePitch`/`faceRoll`, `instanceROI`,
  `instanceMaskReferenceKey` and `imageStats` (`Mattify`, `SkinSmoothingStandalone`,
  `UnderEyeBrightening`). The one face turned 45° has an empty `SkinSmoothingStandalone`.
- one `semanticpersoninstances` matte per face (#13), its XMP naming the key the entry uses;
- real 2026 skin v2, face skin and person mattes.

**Phone A/B** (iOS 27; add-texture photos and ports; one change at a time):

| Build | Soft Skin |
|---|---|
| v0.5 (all 2026 mattes empty, 216-byte `texture_styles`) | Same as Standard |
| Skin v2 / face skin / person mattes from the photo's own only | Same as Standard |
| People data only, or people data + instances | Same as Standard |
| Mattes + people data, no instances | Same as Standard |
| Mattes + instances, no people data | Same as Standard |
| People data + instances + skin mattes, no person matte | Looks different, but no real smoothing |
| People data + instances + skin mattes + person matte | **Works** ✅ |
| … plus `SkinRatio`/`PeopleRatio`, skin statistics in styles `6`, key `k` | Works; adds nothing |

**What the port writes** when the photo has face regions (MWG XMP), a `semanticskinmatte` and a
`portraiteffectsmatte` (Portrait-mode photos; iPhone 16+ photos of people):
- Skin v2 and face skin carry the photo's `semanticskinmatte`, person its
  `portraiteffectsmatte`, each with that matte's own `ispe`/`pixi`/`hvcC`. The other nine stay
  empty.
- One person instance per face, all carrying the Portrait matte.
- One people entry per face region. Measured against the 14 native faces: `faceROI` is the XMP
  region (centre → corner) × 0.968; the XMP `AngleInfoRoll` is the face's rotation in stored
  pixels, which places the landmarks; `faceRoll` = −(roll − irot) and `faceYaw` = yaw, in
  radians. Landmarks are a fixed median layout scaled into the face box; colour statistics are
  native medians; `instanceROI` is the full frame, so nothing is decoded (phone-tested on one-
  and three-face ports and add-texture photos ✅). Leave-one-out on
  frontal faces: centre within 1–6%, landmarks within 3–10% of face width.
- Values are rounded to 1e-6 and written by the same bplist layout in Python and the browser,
  so both builds produce identical bytes.

Photos without face regions or either matte are left exactly as v0.5.1 wrote them: nothing is
detected or invented. 🔍 Open: turned faces (the template is frontal), measured `instanceROI`,
and whether the colour statistics matter; a measured `instanceROI` was not needed.

**Experimental: estimated people data (iOS app only, off by default).** The app's *Find Faces
for Soft Skin* setting fills in what a photo lacks, on the device, instead of leaving it as
above. It breaks "nothing is invented", so it stays experimental: 🔍 untested in Photos.
- Face regions: the photo's own MWG regions when it has them, otherwise Vision's face rectangles
  (up to 10, largest first), turned into stored orientation like an MWG region. Roll and yaw come
  from Vision, so `AngleInfoRoll` = irot − Vision's roll.
- Person matte: the photo's `portraiteffectsmatte` when present, otherwise Vision's person
  segmentation.
- Skin matte: the photo's `semanticskinmatte` when present, otherwise the person matte weighted by
  how close each pixel's chroma is to the colour sampled in the middle of each face.
- Generated mattes are 768×576 (the native 2026 matte size, at the photo's aspect), stored like the
  photo's own (stored orientation, the primary's `irot`), encoded by ImageIO as a skin matte with
  its own `ispe`/`pixi`/`hvcC`. When this system's ImageIO writes no single-image matte, nothing
  is estimated.
- The Texture summary ends in "(estimated on the device)", and the app labels the result.

---

## 8. Donor-derived data: open issues 🔍

Nothing in the final port should come from the donor (§1). Each item below must become a format
declaration, the photo's own data, a calculated value or map, or a neutral default. A value that
proves identical in every native file of a format or capture generation counts as a format
declaration. Findings come from comparing the two templates with 30 native style files
(iPhone 16, 17 and 18; iOS 18.2, 26.5 and 27, including Apple's own demo shots), with their HDR
headroom, `tmap` parameters, lenses and Exif.

| Donor data | What is known | Likely resolution | Status |
|---|---|---|---|
| **`tmap` payload** (gain-map headroom, gain min/max, gamma, offsets) | Up to v0.5.0 every port paired the donor's parameters with the photo's gain map, so HDR highlights used the wrong curve. **v0.5.1 copies the photo's own.** Re-saved photos without a `tmap` still get the donor's. | **Photo's own data** (done). Since v0.6.2 a photo without a `tmap` keeps none, as it came. | ✅ v0.5.1 / v0.6.2; re-saved photos without `tmap` phone-tested |
| **`h`** | Exactly `i.Gain / 4` in all 30 files | **Calculated**, once `Gain` is resolved | Rule known |
| **`i.OriginalRangeMax` / `Min`** | Rises with HDR headroom but is not a function of it: iPhone 18 Pro Max shots reach ~1.0 at headroom 3.4–3.9, an iPhone 17 shot at 4.84 gives 0.31, one at 3.07 gives 0.02. Min is −0.16…0. | Depends on the scene; not calculable from headroom alone | 🔍 |
| **`i.Gain`** | 14.6 (iOS 18.2); 8.4–9.8 (iOS 26.5) with one 2.29; 7.7–10.6 (iOS 27). Not a per-generation constant. | Unknown | 🔍 |
| **`4`** | 4.0–18.3; repeats exact values (5.646 ×5, 5.692 ×3, 4.031 / 4.877 ×2), so likely quantized; no link to lens, brightness, ISO or headroom | Unknown | 🔍 |
| **`highKey`** (in `6`) | 0.52–0.92 across scenes | Unknown | 🔍 |
| **`2`** | `True` in all 30 files | **Format declaration** | ☑️ |
| **`5`** | 0 or 2; both values occur with the same lens, phone and iOS | Unknown | 🔍 |
| **`j`** | 1.0 up to iOS 18.2; 1.0–1.33 on iOS 26.5/27 | Unknown | 🔍 |
| **MakerNote `0x54`** | Members `1`/`2` are 0 in every photo shot with the pad untouched and −0.84…0.99 in Apple's demo shots: very likely the Tone/Color pad position at capture. `4` (1 or 11) and `6` (4 or 8) vary too. | The port's 0/0 is the neutral pad, a **neutral default**; `4`, `6` unknown | ☑️ `1`/`2`; 🔍 `4`, `6` |
| **Donor matte bytes** (slots the photo does not fill) | Near-empty but not empty: up to 9/255, faint donor sky | **Neutral default**: an exactly empty frame on the slots' shared `hvcC` | ✅ done in v0.6.1 |
| **Item-graph template** (item IDs, `iref`, `ipma`, `ipco`, grid descriptors) | Native files add only five things to an iPhone 15 photo's graph (§3) | **The photo's own graph** plus those items, with native format declarations; the two-layout limit goes with it | ✅ done in v0.6.2 (phone-tested); donor graph kept as a fallback for unknown sizes |
| **`HardwareModel = iPhone19,2`** | The only field naming a device other than the photo's own; the iPhone 15 Pro value causes white glow | Find a setting that renders correctly without it, or document it as an exception | 🔍 |
| **`FilmGrainSeed = 92`** | Same grain pattern on every port; native photos all differ (6–264 across 15 iOS 27 files) | **Calculated** per photo: CRC-32 of the first primary tile mod 256 | ✅ done in v0.6.1 |

Done: the `tmap` copy (v0.5.1), empty matte slots and per-photo `FilmGrainSeed` (v0.6.1).
The item graph followed in v0.6.2. `4`, `5`, `j`, `highKey`, `Gain` and `OriginalRangeMax`
do not follow anything measured so far; more random photos will not settle them, controlled
captures (same scene, one setting changed) might. New tile layouts seen in native files: 45/28,
35/12 and 54/15.

---

## 9. Other open metadata questions

- **Why the look differs from a native photo.** Likely causes: the neutral defaults (identity
  coefficients and tone curve, flat light maps) and the donor values in §8. 🔍
- **Not yet isolated:** whether each classic matte is needed; whether the 2026 sidecars are
  needed on their own; whether styles keys `6`/`7` can be dropped; what `0x54` members `4`/`6`
  mean; how the two planes of the coefficient lattice are read. 🔍
