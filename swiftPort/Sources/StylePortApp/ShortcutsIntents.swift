import AppIntents
import Foundation
import StylePortCore
import UniformTypeIdentifiers

/// The Shortcuts action. It always saves new photos and never replaces: a shortcut runs
/// without the app on screen, where a replacement couldn't be reviewed or confirmed.
struct AddPhotographicStyleIntent: AppIntent {
    static var title: LocalizedStringResource = "Add Photographic Style"
    static var description = IntentDescription(
        "Adds the Photographic Styles palette to HEIC photos, or Texture & Grain to photos that already have a style. Live Photos from your library stay Live Photos.",
        categoryName: "Photos"
    )
    static var openAppWhenRun = false

    @Parameter(
        title: "Photos",
        description: "Original HEIC photos, for example from Select Photos.",
        supportedTypeIdentifiers: ["public.heic", "public.heif"]
    )
    var photos: [IntentFile]

    @Parameter(
        title: "Save to Photos",
        description: "Save each result to your library as a new photo.",
        default: true
    )
    var saveToPhotos: Bool

    static var parameterSummary: some ParameterSummary {
        Summary("Add Photographic Style to \(\.$photos)") {
            \.$saveToPhotos
        }
    }

    func perform() async throws -> some IntentResult & ReturnsValue<[IntentFile]> {
        let porter = StylePorter()
        let library = PhotoLibraryService()
        let options = StylePortOptions(
            analyzePhoto: AppSettings.analyzePhoto,
            texture: AppSettings.texture
        )
        var results: [IntentFile] = []
        var outputs: [PortOutput] = []
        for photo in photos {
            let data = photo.data
            let name = photo.filename.isEmpty ? "Photo.HEIC" : photo.filename
            let result = try porter.patch(data, options: options)
            // Shortcuts passes only the still; find the motion part in the library.
            let video = saveToPhotos ? await library.pairedVideo(matchingHEIC: data) : nil
            let original = OriginalPhoto(data: data, filename: name, video: video, hasEdits: false)
            let names = OutputNames(
                original: original,
                replace: false,
                textureOnly: result.report.mode == .addTexture
            )
            let directory = try TemporaryFiles.newDirectory()
            let photoURL = directory.appendingPathComponent(names.photo)
            try result.data.write(to: photoURL)
            var savedVideo: PairedVideo?
            if let video, let videoName = names.video {
                let url = directory.appendingPathComponent(videoName)
                try FileManager.default.copyItem(at: video.url, to: url)
                savedVideo = PairedVideo(url: url, filename: videoName, typeIdentifier: video.typeIdentifier)
            }
            outputs.append(PortOutput(
                photoURL: photoURL,
                photoFilename: names.photo,
                video: savedVideo,
                report: result.report
            ))
            results.append(IntentFile(data: result.data, filename: names.photo, type: .heic))
        }
        if saveToPhotos {
            _ = try await library.saveNew(outputs)
        }
        return .result(value: results)
    }
}

struct ShalielieShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: AddPhotographicStyleIntent(),
            phrases: ["Add a Photographic Style with \(.applicationName)"],
            shortTitle: "Add Photographic Style",
            systemImageName: "camera.filters"
        )
    }
}
