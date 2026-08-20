# StylePort

**Photographic Styles Palette for HEIC and Live Photos**

StylePort is a pure Swift/SwiftUI port of the browser and Python implementations in this
repository. It does not embed a web view, JavaScript engine, Python runtime, or ffmpeg.

The application targets iPhone, iPad, and Mac from one multiplatform Xcode project. When a
photo is chosen from Photos, StylePort uses PhotoKit to read the underlying original photo
resource rather than the JPEG rendition returned by a web file picker. For a Live Photo it
also retains the original paired video and writes the patched HEIC and paired video together
as a new Live Photo.

## Requirements

- Xcode 16 or newer
- iOS or iPadOS 17 or newer
- macOS 14 or newer
- A free or paid Apple development team for device builds

## Open and build

Open `StylePort.xcodeproj` in Xcode, select the `StylePort` scheme, choose an iPhone, iPad,
Mac, or simulator destination, and press **Run**.

The placeholder bundle identifier is `com.nathanhanapps.styleport`. Select your development
team under **Signing & Capabilities** before installing on a physical device.

Command-line builds on a Mac:

```bash
bash scripts/build-apple.sh
```

The script builds the macOS app plus unsigned iOS and iPadOS simulator variants and runs the
core unit tests. Device archives still require a configured signing team.

The repository also contains `.github/workflows/swift-port.yml`, which performs the same
unsigned Apple-platform builds on a macOS GitHub Actions runner after the branch is pushed.
Apple targets cannot be compiled on Windows because the Photos, PhotosUI, SwiftUI, and
ImageIO SDKs ship with Xcode.

After every successful workflow run, GitHub Actions keeps two downloadable artifacts for 14
days: an unsigned macOS app ZIP and an unsigned iPhone/iPad Simulator app ZIP. These are
workflow artifacts only; the workflow does not create a GitHub Release or an installable,
device-signed IPA.

## Regenerating the Xcode project

`StylePort.xcodeproj` is checked in, so XcodeGen is not required. If XcodeGen is installed,
the project can also be regenerated from `project.yml`:

```bash
xcodegen generate
```

## Source layout

| Path | Role |
|---|---|
| `Sources/StylePortCore/` | Native HEIF graph, Exif, binary-plist, profile, and patch code |
| `Sources/StylePortApp/` | SwiftUI interface and PhotoKit original/Live Photo handling |
| `Resources/Profiles/` | Expanded donor profiles bundled without a ZIP dependency |
| `Tests/StylePortCoreTests/` | Format, profile, and parser tests |
| `Package.swift` | Standalone Swift package for the core and its tests |
| `project.yml` | Reproducible multiplatform XcodeGen specification |

## Privacy and behavior

- Photo bytes remain on the device.
- Original-resource access needs Photos read permission.
- Saving a result to Photos needs Photos add permission.
- Files selected through the document picker are handled with security-scoped access.
- A file import has no Photos asset relationship, so it produces a normal HEIC rather than a
  Live Photo unless a paired video is supplied through PhotoKit.

For a Photos import, the app copies the `.pairedVideo` resource without transcoding it and
adds the patched `.photo` plus that video in one `PHAssetCreationRequest`. The native Exif
port retains the source MakerNote fields used for the Live Photo content identifier while
replacing the Photographic Styles entry. Test this path with a real Live Photo on a physical
device before distributing the app; simulator libraries do not reliably model original
iPhone Live Photo resources.

The port keeps the same supported tile layouts and donor-profile constraints as version
0.4.4 of the browser implementation.
