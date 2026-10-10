import AppIntents
import Foundation
import StylePortCore
import UniformTypeIdentifiers

/// The Shortcuts action. It always saves new photos and never replaces: a shortcut runs
/// without the app on screen, where a replacement couldn't be reviewed or confirmed.
struct AddPhotographicStyleIntent: AppIntent {
    static var title: LocalizedStringResource = "Add Photographic Style"
    static var description = IntentDescription(
        "Adds the Photographic Styles palette to HEIC photos, or Texture & Grain to photos that already have a style. Live Photos found in the library keep their motion when saved to Photos.",
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
            // Shortcuts passes only the still; find the motion part in the library.
            let video = saveToPhotos ? await library.pairedVideo(matchingHEIC: data) : nil
            var photoOptions = options
            photoOptions.livePhoto = video != nil
            let result = try porter.patch(data, options: photoOptions)
            let original = OriginalPhoto(data: data, filename: name, video: video, hasEdits: false)
            let names = OutputNames(
                original: original,
                replace: false,
                textureOnly: result.report.mode == .addTexture
            )
            let directory = try TemporaryFiles.newDirectory()
            let photoURL = directory.appendingPathComponent(names.photo)
            try result.data.write(to: photoURL)
            let savedVideo = await PortQueue.styledVideo(video, named: names.video, in: directory,
                                                         texture: result.report.addedTexture)
            outputs.append(PortOutput(
                photoURL: photoURL,
                photoFilename: names.photo,
                video: savedVideo.video,
                report: result.report,
                videoError: savedVideo.error
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
