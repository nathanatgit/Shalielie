# Live Photo video experiments

Photos' editor applies a Photographic Style to a Live Photo's video too, and aborts when the
video lacks the style parts native iPhone 16+ videos carry. These scripts inspect and patch
videos on a PC to find out which parts are needed (see the Status section of the main README).

| Script | Use |
|---|---|
| `movdump.py FILE.MOV…` | Tracks, sample formats, track and file metadata keys |
| `mov_linear_thumb.py TARGET.MOV NATIVE.MOV OUT.MOV` | Adds only the `video-map.smart-style-linear-thumbnail` track |
| `mov_style_tracks.py TARGET.MOV NATIVE.MOV OUT.MOV` | Adds every style part: linear thumbnail, empty sky/person/skin mattes, `smartstyle-info` timed metadata, moov `smartstyle.*` keys |
| `make_p5.py NATIVE.MOV OUT.MOV` | Rebuilds only the native `smartstyle-info` track the way `mov_style_tracks.py` writes it, to test the sample layout |
| `lscontainer.py BUNDLE_ID` | Lists an installed app's container (pymobiledevice3) |
| `recent_dcim.py [N]` | Lists the newest HEIC/MOV files on a USB-connected iPhone (pymobiledevice3) |

`NATIVE.MOV` is a Live Photo video from an iPhone 16 or later, used as the template for every
added track. Needs ffmpeg with libx265 on PATH; `recent_dcim.py` needs pymobiledevice3.

To test a result on the phone: copy `NAME.HEIC` (already ported) and `NAME.MOV` into the
app's Documents folder (`pymobiledevice3 apps push <bundle id> FILE /Documents/FILE`), then in
the app use Library → ⋯ → Import HEIC (and MOV) Files… and pick both; it saves the pair as a
Live Photo unchanged. Read Photos' complaint with `pymobiledevice3 syslog live -pn Photos`.
