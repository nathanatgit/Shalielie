import Photos
import PhotosUI
import StylePortCore
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// Palettify in the share sheet: photos shared from Photos, or HEIC (and MOV) files shared from
/// Files, are listed with the style settings; Add Photographic Style styles them and saves the
/// results to the library as new photos. It never replaces: the share sheet hands over copies,
/// so the originals always stay as they are.
final class ShareViewController: UIViewController {
    private lazy var queue = PortQueue()
    private lazy var model = ShareModel(queue: queue)

    override func viewDidLoad() {
        super.viewDidLoad()
        AppSettings.registerDefaults()
        let host = UIHostingController(rootView: ShareView(
            model: model,
            queue: queue,
            done: { [weak self] in self?.extensionContext?.completeRequest(returningItems: nil) },
            cancel: { [weak self] in self?.extensionContext?.cancelRequest(withError: CocoaError(.userCancelled)) }
        ))
        addChild(host)
        host.view.frame = view.bounds
        host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(host.view)
        host.didMove(toParent: self)

        let items = extensionContext?.inputItems as? [NSExtensionItem] ?? []
        model.load(items.flatMap { $0.attachments ?? [] })
    }
}

/// Copies what was shared into the extension's temporary folder and lists it for review; once
/// the person starts, hands it to the queue as a file import that always gets the style.
@MainActor
final class ShareModel: ObservableObject {
    enum Stage {
        case loading
        case review
        case styling
    }

    /// A shared HEIC, with the video it pairs with.
    struct Candidate: Identifiable {
        let id = UUID()
        let photo: URL
        let video: URL?
        let thumbnail: UIImage?
        let eligibility: StylePorter.Eligibility

        var name: String { photo.lastPathComponent }

        /// Why it can't be styled with these settings; nil when it can.
        func problem(texture: Bool) -> String? {
            switch eligibility {
            case .port: return nil
            case .addTexture:
                return texture ? nil : L("Already has a Photographic Style. Turn on Texture & Grain to add it.")
            case .alreadyStyled: return L("This photo already has a Photographic Style and Texture/Grain.")
            case .unsupported: return L("This HEIC is not supported yet.")
            }
        }
    }

    /// Something shared that can't be styled, with why.
    struct Skipped: Identifiable {
        let id = UUID()
        let name: String
        let reason: String
        var thumbnail: UIImage?
    }

    @Published private(set) var stage = Stage.loading
    @Published var candidates: [Candidate] = []
    @Published private(set) var skipped: [Skipped] = []
    let queue: PortQueue

    init(queue: PortQueue) {
        self.queue = queue
    }

    func load(_ providers: [NSItemProvider]) {
        Task {
            var files: [URL] = []
            var usedNames: Set<String> = []
            for (index, provider) in providers.enumerated() {
                do {
                    let loaded = try await Self.load(provider)
                    guard !loaded.isEmpty else {
                        let preview = await Self.preview(provider)
                        skipped.append(Skipped(
                            name: preview.name ?? Self.fallbackName(provider, number: index + 1),
                            reason: L("Not a HEIC photo. Only HEIC photos, as an iPhone takes them, can get a Photographic Style."),
                            thumbnail: preview.thumbnail
                        ))
                        continue
                    }
                    files += try Self.uniquelyNamed(loaded, avoiding: &usedNames)
                } catch {
                    skipped.append(Skipped(name: Self.fallbackName(provider, number: index + 1),
                                           reason: error.localizedDescription))
                }
            }
            // A video is styled only together with the HEIC of the same name.
            let key = { (url: URL) in url.deletingPathExtension().lastPathComponent.lowercased() }
            let videos = Dictionary(files.filter { Self.isVideo($0) }.map { (key($0), $0) }) { first, _ in first }
            let photos = files.filter { !Self.isVideo($0) }
            let photoNames = Set(photos.map(key))
            for (name, video) in videos where !photoNames.contains(name) {
                skipped.append(Skipped(name: video.lastPathComponent, reason: L("A video gets the style only when it is shared together with its HEIC of the same name.")))
            }
            for photo in photos {
                candidates.append(await Self.candidate(photo, video: videos[key(photo)]))
            }
            stage = .review
        }
    }

    /// What Add Photographic Style styles with these settings.
    func styleable(texture: Bool) -> [Candidate] {
        candidates.filter { $0.problem(texture: texture) == nil }
    }

    /// Style the photos that can be, with the settings chosen (the queue reads the photo
    /// analysis and Texture & Grain settings, which the toggles change).
    func start(texture: Bool, keepsMotion: Bool) {
        let chosen = styleable(texture: texture)
        guard !chosen.isEmpty else { return }
        stage = .styling
        var files: [URL] = []
        for candidate in chosen {
            files.append(candidate.photo)
            if keepsMotion, let video = candidate.video { files.append(video) }
        }
        queue.port(files: files, shared: true, findsLibraryVideos: keepsMotion)
    }

    /// The styled HEICs, to share on from here.
    var results: [URL] {
        queue.jobs.compactMap { job in
            if case .done = job.phase { return job.outputURL }
            return nil
        }
    }

    private static func candidate(_ photo: URL, video: URL?) async -> Candidate {
        let (thumbnail, eligibility) = await Task.detached(priority: .userInitiated) {
            let thumbnail = BackupStore.thumbnail(of: photo, maxPixelSize: 240)
            let data = try? Data(contentsOf: photo, options: .mappedIfSafe)
            return (thumbnail, data.map(StylePorter.eligibility) ?? .unsupported)
        }.value
        return Candidate(photo: photo, video: video, thumbnail: thumbnail, eligibility: eligibility)
    }

    /// The name of an item that can't be styled, as its file is called, and a thumbnail when
    /// it is a picture: so a JPEG or a screenshot can be told apart in the list.
    private static func preview(_ provider: NSItemProvider) async -> (name: String?, thumbnail: UIImage?) {
        let types = provider.registeredTypeIdentifiers.compactMap { UTType($0) }
        guard let type = types.first(where: { $0.conforms(to: .image) })
                ?? types.first(where: { $0.conforms(to: .data) }) else {
            return (provider.suggestedName, nil)
        }
        let suggested = provider.suggestedName
        return await withCheckedContinuation { continuation in
            _ = provider.loadFileRepresentation(forTypeIdentifier: type.identifier) { url, _ in
                guard let url else {
                    continuation.resume(returning: (suggested, nil))
                    return
                }
                // Photos suggests the name without its extension; the file has it.
                var name = url.lastPathComponent
                if let suggested, !suggested.isEmpty {
                    name = (suggested as NSString).pathExtension.isEmpty && !url.pathExtension.isEmpty
                        ? suggested + "." + url.pathExtension
                        : suggested
                }
                let thumbnail = type.conforms(to: .image)
                    ? BackupStore.thumbnail(of: url, maxPixelSize: 240)
                    : nil
                continuation.resume(returning: (name, thumbnail))
            }
        }
    }

    /// For an item with no name of its own: its kind and its place in the selection, such as
    /// "JPEG image 3".
    private static func fallbackName(_ provider: NSItemProvider, number: Int) -> String {
        if let suggested = provider.suggestedName, !suggested.isEmpty { return suggested }
        let kind = provider.registeredTypeIdentifiers.lazy.compactMap { UTType($0)?.localizedDescription }.first
        return kind.map { "\($0) \(number)" } ?? L("Item \(number)")
    }

    private static func isVideo(_ url: URL) -> Bool {
        ["mov", "mp4"].contains(url.pathExtension.lowercased())
    }

    /// One shared item as files: a Live Photo's HEIC and video, a HEIC, or a video. Empty when
    /// it is none of these, for example a JPEG.
    private static func load(_ provider: NSItemProvider) async throws -> [URL] {
        if provider.canLoadObject(ofClass: PHLivePhoto.self),
           let files = try? await livePhotoFiles(provider), !files.isEmpty {
            return files
        }
        let types = provider.registeredTypeIdentifiers.compactMap { UTType($0) }
        if let heic = types.first(where: { $0.conforms(to: .heic) || $0.conforms(to: .heif) }) {
            return [try await copy(provider, type: heic)]
        }
        if let movie = types.first(where: { $0.conforms(to: .movie) }) {
            return [try await copy(provider, type: movie)]
        }
        return []
    }

    /// A Live Photo from Photos: its original HEIC and its video, under their own names, so
    /// the queue pairs them.
    private static func livePhotoFiles(_ provider: NSItemProvider) async throws -> [URL] {
        let livePhoto: PHLivePhoto = try await withCheckedThrowingContinuation { continuation in
            _ = provider.loadObject(ofClass: PHLivePhoto.self) { object, error in
                if let livePhoto = object as? PHLivePhoto {
                    continuation.resume(returning: livePhoto)
                } else {
                    continuation.resume(throwing: error ?? CocoaError(.fileReadUnknown))
                }
            }
        }
        let resources = PHAssetResource.assetResources(for: livePhoto)
        guard let photo = resources.first(where: { $0.type == .photo }),
              let type = UTType(photo.uniformTypeIdentifier),
              type.conforms(to: .heic) || type.conforms(to: .heif),
              let video = resources.first(where: { $0.type == .pairedVideo }) else { return [] }
        let directory = try TemporaryFiles.newDirectory()
        let base = (photo.originalFilename as NSString).deletingPathExtension
        let photoName = photo.originalFilename.isEmpty ? "Photo.HEIC" : photo.originalFilename
        // The video must carry the photo's name for the two to pair.
        let videoExtension = (video.originalFilename as NSString).pathExtension
        let videoName = (base.isEmpty ? "Photo" : base) + "." + (videoExtension.isEmpty ? "MOV" : videoExtension)
        var urls: [URL] = []
        for (resource, name) in [(photo, photoName), (video, videoName)] {
            let url = directory.appendingPathComponent(name)
            try await write(resource, to: url)
            urls.append(url)
        }
        return urls
    }

    private static func write(_ resource: PHAssetResource, to url: URL) async throws {
        let options = PHAssetResourceRequestOptions()
        options.isNetworkAccessAllowed = true
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            PHAssetResourceManager.default().writeData(for: resource, toFile: url, options: options) { error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume()
                }
            }
        }
    }

    /// Copy a shared file while the provider keeps it, named as it was shared.
    private static func copy(_ provider: NSItemProvider, type: UTType) async throws -> URL {
        let directory = try TemporaryFiles.newDirectory()
        let suggested = provider.suggestedName.map { ($0 as NSString).deletingPathExtension }
        return try await withCheckedThrowingContinuation { continuation in
            _ = provider.loadFileRepresentation(forTypeIdentifier: type.identifier) { url, error in
                guard let url else {
                    continuation.resume(throwing: error ?? CocoaError(.fileReadUnknown))
                    return
                }
                let fileExtension = url.pathExtension.isEmpty
                    ? (type.preferredFilenameExtension ?? "HEIC")
                    : url.pathExtension
                let base = suggested.flatMap { $0.isEmpty ? nil : $0 } ?? url.deletingPathExtension().lastPathComponent
                let destination = directory.appendingPathComponent(base + "." + fileExtension)
                do {
                    try FileManager.default.copyItem(at: url, to: destination)
                    continuation.resume(returning: destination)
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    /// The queue pairs a HEIC and a video by name, so files of one item that share a name
    /// with an earlier item's get a number: two Live Photos both named IMG_0001 must not
    /// swap videos.
    private static func uniquelyNamed(_ urls: [URL], avoiding used: inout Set<String>) throws -> [URL] {
        let base = urls[0].deletingPathExtension().lastPathComponent
        var name = base
        var number = 2
        while used.contains(name.lowercased()) {
            name = "\(base) \(number)"
            number += 1
        }
        used.insert(name.lowercased())
        guard name != base else { return urls }
        return try urls.map { url in
            let renamed = url.deletingLastPathComponent()
                .appendingPathComponent(name + "." + url.pathExtension)
            try FileManager.default.moveItem(at: url, to: renamed)
            return renamed
        }
    }
}

struct ShareView: View {
    @ObservedObject var model: ShareModel
    @ObservedObject var queue: PortQueue
    let done: () -> Void
    let cancel: () -> Void

    var body: some View {
        NavigationStack {
            Group {
                switch model.stage {
                case .loading:
                    ProgressView("Reading the shared photos…")
                case .review:
                    ShareReview(model: model, cancel: cancel)
                case .styling:
                    ShareProgress(model: model, queue: queue, done: done, cancel: cancel)
                }
            }
            .navigationTitle(AppSettings.displayName)
            .navigationBarTitleDisplayMode(.inline)
        }
    }
}

/// The shared photos and the style settings, before anything is styled.
private struct ShareReview: View {
    @ObservedObject var model: ShareModel
    let cancel: () -> Void
    @AppStorage(AppSettings.analyzePhotoKey) private var analyzePhoto = true
    @AppStorage(AppSettings.textureKey) private var texture = true
    @AppStorage(AppSettings.shareKeepsMotionKey) private var keepsMotion = true

    private var count: Int { model.styleable(texture: texture).count }

    var body: some View {
        List {
            if !model.candidates.isEmpty {
                Section {
                    ForEach(model.candidates) { candidate in
                        CandidateRow(candidate: candidate, texture: texture, keepsMotion: keepsMotion)
                    }
                    .onDelete { model.candidates.remove(atOffsets: $0) }
                } header: {
                    Text("Photos")
                } footer: {
                    Text("Styled copies are saved to Photos as new photos. The originals stay as they are.")
                }
                Section {
                    Toggle("Analyze Each Photo", isOn: $analyzePhoto)
                    Toggle("Add Texture & Grain", isOn: $texture)
                } header: {
                    Text("Style")
                } footer: {
                    Text("Analyzing measures the photo's own tones for the palette instead of using the reference photo's. Texture & Grain adds the iOS 27 controls, and Soft Skin when the photo has the face data for it.")
                }
                Section {
                    Toggle("Keep Live Photo Motion", isOn: $keepsMotion)
                } footer: {
                    Text("A Live Photo's video gets the parts Photos' editor needs for the style. Turn this off to save stills, which is quicker.")
                }
            }
            if !model.skipped.isEmpty {
                Section("Can't Be Styled") {
                    ForEach(model.skipped) { SkippedRow(item: $0) }
                }
            }
        }
        .overlay {
            if model.candidates.isEmpty && model.skipped.isEmpty {
                ContentUnavailableView("Nothing to Style", systemImage: "photo")
            }
        }
        .safeAreaInset(edge: .bottom) {
            Button {
                model.start(texture: texture, keepsMotion: keepsMotion)
            } label: {
                Text(count == 1 ? L("Add Photographic Style to 1 Photo") : L("Add Photographic Style to \(count) Photos"))
                    .frame(maxWidth: .infinity)
            }
            .modernProminentButton()
            .controlSize(.large)
            .disabled(count == 0)
            .padding()
        }
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel", action: cancel)
            }
        }
    }
}

/// A shared picture's thumbnail, or a placeholder for one without.
private struct ShareThumbnail: View {
    let image: UIImage?
    var systemImage = "photo"

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
            } else {
                Color.secondary.opacity(0.2)
                    .overlay {
                        Image(systemName: systemImage)
                            .foregroundStyle(.secondary)
                    }
            }
        }
        .frame(width: 52, height: 52)
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }
}

private struct CandidateRow: View {
    let candidate: ShareModel.Candidate
    let texture: Bool
    let keepsMotion: Bool

    var body: some View {
        let problem = candidate.problem(texture: texture)
        HStack(spacing: 12) {
            ShareThumbnail(image: candidate.thumbnail)
                .overlay(alignment: .bottomLeading) {
                    if candidate.video != nil && keepsMotion {
                        Image(systemName: "livephoto")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(.white)
                            .shadow(radius: 2)
                            .padding(3)
                    }
                }
            VStack(alignment: .leading, spacing: 2) {
                Text(candidate.name)
                    .lineLimit(1)
                Text(problem ?? detail)
                    .font(.caption)
                    .foregroundStyle(problem == nil ? Color.secondary : Color.orange)
            }
        }
        .opacity(problem == nil ? 1 : 0.6)
    }

    private var detail: String {
        var parts = [candidate.eligibility == .addTexture ? L("Gets Texture & Grain") : L("Gets a Photographic Style")]
        if candidate.video != nil && keepsMotion { parts.append(L("Live Photo")) }
        return parts.joined(separator: " · ")
    }
}

private struct SkippedRow: View {
    let item: ShareModel.Skipped

    var body: some View {
        HStack(spacing: 12) {
            ShareThumbnail(image: item.thumbnail, systemImage: isVideo ? "video" : "xmark")
            VStack(alignment: .leading, spacing: 2) {
                Text(item.name)
                    .lineLimit(1)
                Text(item.reason)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .opacity(0.6)
    }

    private var isVideo: Bool {
        ["mov", "mp4"].contains((item.name as NSString).pathExtension.lowercased())
    }
}

/// Each photo as it is styled and saved.
private struct ShareProgress: View {
    @ObservedObject var model: ShareModel
    @ObservedObject var queue: PortQueue
    let done: () -> Void
    let cancel: () -> Void

    var body: some View {
        List {
            Section {
                ForEach(queue.jobs) { JobRow(job: $0) }
            } footer: {
                Text("Styled copies are saved to Photos as new photos. The originals stay as they are.")
            }
        }
        .toolbar {
            if queue.isRunning {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: cancel)
                }
            }
            ToolbarItem(placement: .confirmationAction) {
                Button("Done", action: done)
                    .disabled(queue.isRunning)
            }
            if !queue.isRunning && !model.results.isEmpty {
                ToolbarItem(placement: .bottomBar) {
                    ShareLink(items: model.results) {
                        Label("Share Styled Photos", systemImage: "square.and.arrow.up")
                    }
                }
            }
        }
    }
}
