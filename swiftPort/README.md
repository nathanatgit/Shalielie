# Shalielie for iPhone and iPad

**English:** Shalielie · **简体中文:** 瞎咧咧

A native SwiftUI app that adds the Photographic Styles palette to photos in your library, the
same port as the command-line tool and the web app (v0.6.3), without leaving the phone. It is
pure Swift: no web view, JavaScript engine, Python runtime or ffmpeg.

It works through PhotoKit, so it reads each photo's original HEIC (and a Live Photo's video)
straight from the library and saves the result back, with no files to move around.

> **Live Photos:** Photos' editor applies the style to a Live Photo's video too, and aborts
> when the video has no style data, which iPhone 15 and earlier videos lack. The app can't
> add that data to a video yet, so a newly styled Live Photo is saved as a **still**; the
> original keeps its motion (and in replace mode the original, with its video, stays in the
> Backup Bin). A video styled on a computer with `tools/live-photo/mov_style_tracks.py` can
> be brought in through **Import HEIC (and MOV) Files…** together with the original HEIC: the
> HEIC is then styled for a Live Photo and kept with that video, with Texture & Grain when
> the video came from an iPhone 18 template (see Status).
> iPhone 16/17 Live Photos that only get Texture & Grain keep their own video.

## Status

Phone-tested on 2026-10-09 (iPhone 15 Pro, iOS 27.0.1) and 2026-10-10 (iPhone 17 Pro,
iOS 27.0; an iPhone 13 photo):

| Case | Result |
|---|---|
| Still photo, save as new or replace | ✅ Styles palette works in Photos' editor |
| Live Photo saved with its original video | ❌ Photos crashes on **Edit** |
| Live Photo, video styled by `mov_style_tracks.py` (iPhone 17 Pro template), HEIC without Texture & Grain, styles schema 16 | ✅ Styles and Live in the editor; the video takes the style too |
| The same with Texture & Grain in the HEIC | ❌ Photos crashes on **Edit** |
| Texture & Grain in the HEIC, video styled with an iPhone 18 Pro template (adds `texturestyle-info`) | ✅ Styles and Texture in the editor; Texture & Grain renders on the still only, as with native iPhone 18 Pro Live Photos |

Each crash, from the device log, is Photos' editor failing to connect a style step to a part
of the video ("Failed to resolve dst port ref") and aborting:

- With an unstyled video, the linear thumbnail,
  `/asset:>SEQ(NAME[media],NAME[video],NAME[linearThumbnail])`.
- With Texture & Grain in the HEIC, `/asset:>SEQ(NAME[media],NAME[video],NAME[textureStyle])`
  for `photographicStyleLearn`. It is the `com.apple.quicktime.texturestyle-info` timed
  metadata (with moov `texturestyle.*` keys) that iPhone 18 videos carry and iPhone 13 and
  17 Pro videos lack; `mov_style_tracks.py` copies it from an iPhone 18 template. The same
  may apply to an iPhone 16/17 Live Photo given Texture & Grain with its own video; that case
  is not phone-tested.

Native iOS 27 Live Photos carry styles key `0` = 16 (Photos logs it as metadata version
0.16); the donors carry 14. Whether 16 is needed or only the missing Texture & Grain matters
has not been isolated, so a Live Photo HEIC gets 16.

Open: on a bright, backlit outdoor scene the Film texture's red halation jumps at a narrow
intensity band (94–97; 93 and 98 look normal). It happens on a ported iPhone 13 photo and on
a native iPhone 17 Pro style photo given only Texture & Grain, whose texture record matches a
native iPhone 18 Pro one field by field, so it may be Photos' own behaviour. A native
iPhone 18 Pro photo of a similar scene is needed to tell.

## What it does

- **Library** tab: every photo with full access, or only the photos you selected with
  limited access (with a hint to select photos when there are none). Sort by filename, date
  captured or date saved, ascending or descending.
- **Albums** tab: your albums and the media-type albums, each in the same grid.
- **Backup Bin** tab: originals kept by replace mode, to restore or delete.
- **Settings** tab: save-as-new or replace mode, photo analysis, Texture & Grain, the About
  page (features and privacy) and the repository link.

Select photos and tap **Add Style**, or open a photo and add it there. Each photo gets:

| Photo | Result |
|---|---|
| HEIC from an iPhone before 16 | The Photographic Styles palette, plus iOS 27 Texture & Grain (and Soft Skin for portraits with face data) |
| HEIC from iPhone 16 or 17 with a style | Just Texture & Grain |
| Already has both, or not a HEIC | Not selectable |

### Save as new or replace

- **Save as New** (default) saves `<name>_PhotographicStyle.HEIC` next to the original.
  Photos that only get Texture & Grain use `_TextureGrain`, and a Live Photo among them keeps
  its video as `<name>_TextureGrain.MOV`.
- **Replace Original** first copies the original HEIC and video into the Backup Bin, then
  saves the styled photo with the original's file names, capture date, location, favorite,
  hidden state and album memberships, and deletes the original, all in one PhotoKit change.
  iOS asks once per batch to confirm the deletion; if you decline, nothing changes and the
  backups are discarded. The deleted original also stays in Photos' Recently Deleted for
  30 days.

The patched HEIC keeps the photo's MakerNote `0x11`, the Live Photo content identifier the
video carries, so a kept video pairs with it again.

### Backup Bin

Originals stay in the app's Application Support folder until you act on them:

- **Restore** puts the original (and its video) back with its date, location, favorite and
  albums, and can delete the styled version at the same time.
- **Export** shares the original files.
- **Delete** removes them for good.

### Shortcuts

The **Add Photographic Style** action takes HEIC files (for example from *Select Photos*),
returns the styled HEICs, and by default saves them as new photos. It never replaces.
Shortcuts hands an app only the still; for a Texture & Grain Live Photo the app finds the
library photo with the same capture date and content identifier and saves its video too.

## Build

Requirements: Xcode 16 or newer, iOS/iPadOS 17 or newer.

Open `StylePort.xcodeproj`, select the `StylePort` scheme and an iPhone, iPad or simulator,
choose your team under **Signing & Capabilities**, and run. Command line on a Mac:

```bash
bash scripts/build-apple.sh
```

`.github/workflows/swift-port.yml` runs the same on a macOS runner after a push and keeps two
artifacts for 14 days: an unsigned simulator app and an **unsigned device IPA**. Sideloading
tools such as Sideloadly or AltStore sign the IPA with your own Apple ID when they install
it; with a free Apple ID the install lasts 7 days.

The core (`StylePortCore`) also builds and tests on Linux with `swift test`, which is how its
output was compared with the Python tool: identical bytes for photos without people and for
every Texture & Grain photo; for photos with people only the styles plist's byte packing
differs (its parsed content is equal), exactly as for the web app.

`StylePort.xcodeproj` is checked in; `project.yml` describes the same project for XcodeGen.
The app icon is drawn by `tools/generate_app_icon.py` (Pillow).

## Source layout

| Path | Role |
|---|---|
| `Sources/StylePortCore/` | HEIF item graph, Exif, binary plist, Texture & Grain, the port itself |
| `Sources/StylePortApp/` | SwiftUI tabs, PhotoKit reading/saving/replacing, Backup Bin, Shortcuts |
| `Resources/Profiles/` | Built-in donor profiles, expanded |
| `Resources/*.lproj/` | Localized app name |
| `Tests/StylePortCoreTests/` | Core tests, and the opt-in byte comparison with Python |

## Privacy

Photos are processed on the device and never uploaded. There are no servers, accounts,
analytics or ads. Reading needs Photos access (full or limited); saving needs add access;
replacing needs full read-write access to the photos being replaced. Backups live in the
app's own storage and are deleted with the app.
