# Live Photo video experiments

Photos' editor applies a Photographic Style to a Live Photo's video too, and aborts when the
video lacks the style parts native iPhone 16+ videos carry. These scripts inspect and patch
videos on a PC to find out which parts are needed (see the Status section of the main README).

| Script | Use |
|---|---|
| `movdump.py FILE.MOV…` | Tracks, sample formats, track and file metadata keys |
| `mov_linear_thumb.py TARGET.MOV NATIVE.MOV OUT.MOV` | Adds only the `video-map.smart-style-linear-thumbnail` track |
| `mov_style_tracks.py TARGET.MOV NATIVE.MOV OUT.MOV` | Adds every style part: linear thumbnail, empty sky/person/skin mattes, `smartstyle-info` timed metadata, moov `smartstyle.*` keys |
| `recent_dcim.py [N]` | Lists the newest HEIC/MOV files on a USB-connected iPhone (pymobiledevice3) |

`NATIVE.MOV` is a Live Photo video from an iPhone 16 or later, used as the template for every
added track. Needs ffmpeg with libx265 on PATH; `recent_dcim.py` needs pymobiledevice3.

To test a result on the phone: copy `NAME.HEIC` and the patched `NAME.MOV` into the app's
Documents folder (`pymobiledevice3 apps push <bundle id> FILE /Documents/FILE`, or
`xcrun devicectl device copy to … --domain-type appDataContainer`), then in the app use
Library → ⋯ → Import HEIC (and MOV) Files… and pick both. An already styled HEIC is saved
with the video unchanged; the original, unstyled HEIC is styled for a Live Photo (no Texture &
Grain, styles schema 16) and saved with the video. Read Photos' complaint with
`pymobiledevice3 syslog live -pn Photos`.

Found on 2026-10-10 (iPhone 17 Pro, iOS 27.0) with an iPhone 13 Live Photo and a native
iPhone 17 Pro one as `NATIVE.MOV`: `mov_style_tracks.py` output is enough for Photos to edit
the Live Photo and restyle its video, as long as the HEIC has no Texture & Grain. With
Texture & Grain, Photos also asks the video for a `textureStyle` part, which iPhone 17 Pro
videos don't have either; an iPhone 18 Pro Live Photo is the next template to try.
