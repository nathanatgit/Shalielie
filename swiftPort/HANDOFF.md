# Handoff: Shalielie iOS app (Swift port), updated 2026-10-10

## Where things are

| What | Where |
|---|---|
| Repository | https://github.com/nathanatgit/Shalielie |
| Branch | `agent/swift-port`, last commit `1321577`, everything pushed |
| Local worktree | `C:\Users\Han\Project\Shalielie-swift` (master stays in `C:\Users\Han\Project\Shalielie`) |
| App sources | `swiftPort/` (Xcode project `StylePort.xcodeproj`, targets still named StylePort) |
| App name | Shalielie (English), 瞎咧咧 (Simplified Chinese) |
| Installed on | iPhone 15 Pro, iOS 27.0.1, bundle ID `com.nathanhanapps.styleport.GH65F9HT24` (as Sideloadly renamed it) |

No pre-release exists. `ios-v0.6.3-beta.1` was deleted because it crashed at launch. Make
the next pre-release only after the app works on the phone. Use `ios-v…` tags: tags starting
with `v` start the Python binary release workflow.

## What's done

- **Porting core moved from v0.4.4 to v0.6.3:** photo's own item graph incl. 48 MP,
  Texture & Grain, Soft Skin, add-texture for iPhone 16/17 photos. It was checked in a
  `swift:6.0-jammy` Docker container against the Python tool on 41 photos: byte-identical
  except the styles plist's byte packing for photos with people, whose parsed content is
  equal.
- **Native app with four tabs:** Library (full library or limited selection; sort by
  filename, date captured or date saved), Albums, Backup Bin, Settings (save-as-new or
  replace, About, repo link).
- **Replace mode:** backs the original up first, then swaps in the styled photo in one
  PhotoKit change, keeping date, location, favourite and albums. The Backup Bin restores it.
- **Shortcuts action** "Add Photographic Style", which always saves new photos.
- **Import of a HEIC + MOV pair from Files:** if the HEIC already has a style, the pair is
  saved unchanged as a Live Photo. The app's Documents folder is shared, so files can be
  pushed in over USB.
- **Icon:** a 5×5 square of glowing white dots on a blue gradient
  (`tools/generate_app_icon.py`).
- **Status pop-up:** hides 2 seconds after a successful batch.

## Phone-tested

| Case | Result |
|---|---|
| Still photo, save as new or replace | ✅ Style palette works in Photos' editor |
| Live Photo with its original iPhone 15 video | ❌ Photos crashes on Edit |

Because of the crash, newly styled Live Photos are currently saved as **stills**
(`LivePhotoPolicy` in `PortQueue.swift`).

## The open problem: Live Photo video

When you edit a Live Photo, Photos applies the style to its **video** as well. Native iPhone
16 Pro Live videos carry parts that iPhone 15 videos lack:

| Part in the MOV | Details |
|---|---|
| `auxv` track `video-map.smart-style-linear-thumbnail` | 128×96 HEVC Main 10, every frame, `logs` box `com.apple.rec2020.apple-log` |
| `auxv` tracks `video-map.sky` / `.person` / `.skin` | 256×192 grey HEVC, every 2nd frame |
| `mebx` track `com.apple.quicktime.smartstyle-info` | per frame; a bplist with a 256-point tone curve (`3`) and values `0`, `4`, `5`, `h` |
| moov keys `com.apple.quicktime.smartstyle.*` | rendering-version, tone, color, intensity, bypassed, cast |

Each auxiliary track links to the main video with `tref vmap` and is named by a `udta tagc`
box.

**How the tests went** (each test = a HEIC + MOV pair pushed into the app's Documents
folder, imported in the app, then Edit in Photos; the failing port is read from Photos' log):

| # | Still | Video | Photos' log on Edit |
|---|---|---|---|
| 1 | styled + Texture | iPhone 15 video + linear-thumbnail track | linear thumbnail found; fails on `/video/semanticStyle` |
| 2 | styled + Texture | iPhone 15 video + **all** style parts (`mov_style_tracks.py`) | still fails on `/video/semanticStyle` |
| 3 | styled + Texture | **native iPhone 16 Pro video**, only its Live Photo ID changed | **passes semanticStyle**; fails on `/video/textureStyle` |

What that shows:

- **My rebuilt `smartstyle-info` track isn't recognised; the native one is.** The two are
  identical except timing values and sample layout: native uses one fixed `stsz` size and
  many chunks interleaved in the main `mdat`; mine lists sizes per sample and puts one chunk
  in a second `mdat` after `moov`. Not yet known which difference (or something else in the
  iPhone 15 video) matters.
- **iOS 27 also wants `textureStyle` timed metadata in the video** when the still has Texture &
  Grain. The iOS 26.5 native video has none. Workaround: port the still with `--texture off`;
  the real fix needs a Live Photo shot on iOS 27 to copy the texture track from.

**Gotcha:** iCloud Photos reuses an existing record when a new original's bytes match one it
already has, including that record's video and name. Give every test HEIC unique bytes (the
scripts append a small `free` box).

**Next test, prepared but not pushed** (the phone disconnected), files on the PC in the
scratch folder `exp5/` and reproducible with the scripts:

| Pair | Still | Video | Tells us |
|---|---|---|---|
| `IMG_5710_P6` | styled, **no Texture** (`--texture off`) | native video, ID changed | if Edit opens, the approach works end to end |
| `IMG_5710_P5` | styled + Texture | native video with its `smartstyle-info` track rebuilt my way (`make_p5.py`) | if semanticStyle fails again, my sample layout is the problem |

**Next steps:**

1. Run the P5/P6 test.
2. If the layout is the problem, write the timed-metadata track the native way (fixed size,
   interleaved), retest a patched iPhone 15 video with `--texture off`.
3. Once a patched iPhone 15 video opens in Edit: real linear-colour thumbnail, per-frame
   `smartstyle-info` from the photo's own style data, real mattes if needed, a `textureStyle`
   track (needs an iOS 27 sample). Then build it into the app (VideoToolbox encoding,
   box-level MOV writing) and lift `LivePhotoPolicy`.

## Tools and tricks

- **iPhone over USB:** pymobiledevice3 in a scratch venv (`pip install pymobiledevice3`).
  - Crash reports: `crash pull DIR --match Photos-…`
  - Photos' log: `syslog live --label -pn Photos -o FILE`. NeutrinoCore `<ERROR>` lines name
    the missing pipeline port.
  - Camera roll: `afc ls /DCIM/105APPLE`, `afc pull …`. In Git Bash, set
    `MSYS_NO_PATHCONV=1` first.
  - Photos database: `/PhotoData/Photos.sqlite`. The original file name is in
    `ZADDITIONALASSETATTRIBUTES.ZORIGINALFILENAME`; `ZINTERNALRESOURCE.ZRESOURCETYPE` 3 is
    the paired video.
  - App folder: `apps push <bundle id> FILE /Documents/FILE`, `apps pull …`.
- **Native iPhone 16 Pro Live pairs on the phone:** stored as `IMG_5175`–`IMG_5179` in
  `/DCIM/105APPLE` (originally named 5860/5861/5862/5867/5868).
- **Video scripts:** `swiftPort/tools/live-photo/` (see its README); `make_p5.py` and `lscontainer.py` (app container listing) are there too.
- **IPA:** comes only from the GitHub Actions artifact `Shalielie-iOS-unsigned-ipa-<sha>`.
  Install with Sideloadly (free Apple ID, 7 days); check that its log's "Using IPA file" line
  shows the new file.
- **Xcode project:** files are listed explicitly; after adding a `.swift` file run
  `python tools/generate_xcodeproj.py .` in `swiftPort/`. The framework needs
  `DYLIB_INSTALL_NAME_BASE = @rpath`.
- **Sideloadly pairing error `LOCKDOWN_E_INVALID_HOST_ID`:** a stale
  `C:\ProgramData\Apple\Lockdown\<UDID>.plist`. Rename it as administrator, then re-trust
  the phone.
- **Python tool:** needs the `heif-convert` shim on PATH:
  `PATH="…/Shalielie/tools:$PATH"`.
