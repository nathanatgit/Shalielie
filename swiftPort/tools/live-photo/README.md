# Live Photo video experiments

Photos' editor applies a Photographic Style to a Live Photo's video too, and aborts when the
video lacks the style parts native iPhone 16+ videos carry. These scripts are the PC-side
reference and research tools: they inspect and patch videos on a PC to find out which parts
are needed (see the Status section of the main README). The app now does the same on the
phone (`Sources/StylePortCore/LivePhotoVideo.swift` and `LinearThumbnailEncoder.swift`).

| Script | Use |
|---|---|
| `movdump.py FILE.MOV…` | Tracks, sample formats, track and file metadata keys |
| `mov_linear_thumb.py TARGET.MOV NATIVE.MOV OUT.MOV` | Adds only the `video-map.smart-style-linear-thumbnail` track |
| `mov_style_tracks.py TARGET.MOV NATIVE.MOV OUT.MOV` | Adds every style part: linear thumbnail, empty sky/person/skin mattes, `smartstyle-info` timed metadata, moov `smartstyle.*` keys; from an iPhone 18 template also `texturestyle-info` and moov `texturestyle.*` keys |
| `make_video_template.py NATIVE.MOV OUT.mov` | Builds the app's video template from a native iPhone 18 Pro Live Photo video: the four `video-map` tracks (sky/person/skin with one black sample each, linear thumbnail empty), the `smartstyle-info` and `texturestyle-info` tracks with all samples, and the moov `smartstyle.*` / `texturestyle.*` keys; strips location, dates, device and identifier metadata. Output is `Resources/Profiles/live-photo-video/template.mov`, which the app uses |
| `mov_style_tracks.py TARGET.MOV NATIVE.MOV OUT.MOV` | Adds every style part: linear thumbnail, empty sky/person/skin mattes, `smartstyle-info` timed metadata, moov `smartstyle.*` keys |
| `make_p5.py NATIVE.MOV OUT.MOV` | Rebuilds only the native `smartstyle-info` track the way `mov_style_tracks.py` writes it, to test the sample layout |
| `lscontainer.py BUNDLE_ID` | Lists an installed app's container (pymobiledevice3) |
| `recent_dcim.py [N]` | Lists the newest HEIC/MOV files on a USB-connected iPhone (pymobiledevice3) |

`NATIVE.MOV` is a Live Photo video from an iPhone 16 or later, used as the template for every
added track. Needs ffmpeg with libx265 on PATH; `recent_dcim.py` needs pymobiledevice3.

The app styles a Live Photo's video itself, so these scripts are not needed to use it. To
test a script's result on the phone: copy `NAME.HEIC` and the patched `NAME.MOV` into the
app's Documents folder (`pymobiledevice3 apps push <bundle id> FILE /Documents/FILE`, or
`xcrun devicectl device copy to … --domain-type appDataContainer`), then in the app use
Library → ⋯ → Import HEIC (and MOV) Files… and pick both. An already styled HEIC is saved
unchanged and its video only gets the parts it lacks; the original, unstyled HEIC is styled
for a Live Photo (styles schema 16, with Texture & Grain when the Settings say so) and saved
with its video, which gets the parts it lacks. To compare the app's output with a script's,
import the original pair and read Photos' complaint, if any, with
`pymobiledevice3 syslog live -pn Photos`.

Found on 2026-10-10 (iPhone 17 Pro, iOS 27.0) with an iPhone 13 Live Photo and a native
iPhone 17 Pro one as `NATIVE.MOV`: `mov_style_tracks.py` output is enough for Photos to edit
the Live Photo and restyle its video, as long as the HEIC has no Texture & Grain. With
Texture & Grain, Photos also asks the video for a `textureStyle` part: the
`texturestyle-info` track of an iPhone 18 video. With an iPhone 18 Pro Live Photo as
`NATIVE.MOV`, a textured HEIC edits too; Texture & Grain then renders on the still only, as it
does for native iPhone 18 Pro Live Photos.
