import Photos
import PhotosUI
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// Palettify in the share sheet: photos shared from Photos, or HEIC (and MOV) files shared from
/// Files, get the style straight away and are saved to the library as new photos. It never
/// replaces: the share sheet hands over copies, so the originals always stay as they are.
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
        model.start(items.flatMap { $0.attachments ?? [] })
    }
}

/// Copies what was shared into the extension's temporary folder, then hands it to the queue
/// as a file import that always gets the style.
@MainActor
final class ShareModel: ObservableObject {
    /// Something shared that can't be styled, with why.
    struct Skipped: Identifiable {
        let id = UUID()
        let name: String
        let reason: String
    }

    @Published private(set) var isLoading = true
    @Published private(set) var skipped: [Skipped] = []
    let queue: PortQueue

    init(queue: PortQueue) {
        self.queue = queue
    }

    func start(_ providers: [NSItemProvider]) {
        Task {
            var files: [URL] = []
            var usedNames: Set<String> = []
            for provider in providers {
                let name = provider.suggestedName ?? L("Item")
                do {
                    let loaded = try await Self.load(provider)
                    guard !loaded.isEmpty else {
                        skipped.append(Skipped(name: name, reason: L("Not a HEIC photo. Only HEIC photos, as an iPhone takes them, can get a Photographic Style.")))
                        continue
                    }
                    files += try Self.uniquelyNamed(loaded, avoiding: &usedNames)
                } catch {
                    skipped.append(Skipped(name: name, reason: error.localizedDescription))
                }
            }
            // A video is styled only together with the HEIC of the same name.
            let key = { (url: URL) in url.deletingPathExtension().lastPathComponent.lowercased() }
            let photoNames = Set(files.filter { !Self.isVideo($0) }.map(key))
            for video in files where Self.isVideo(video) && !photoNames.contains(key(video)) {
                skipped.append(Skipped(name: video.lastPathComponent, reason: L("A video gets the style only when it is shared together with its HEIC of the same name.")))
            }
            isLoading = false
            queue.port(files: files, shared: true)
        }
    }

    /// The styled HEICs, to share on from here.
    var results: [URL] {
        queue.jobs.compactMap { job in
            if case .done = job.phase { return job.outputURL }
            return nil
        }
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

    private var isWorking: Bool { model.isLoading || queue.isRunning }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(queue.jobs) { job in
                        JobRow(job: job)
                    }
                    ForEach(model.skipped) { item in
                        VStack(alignment: .leading, spacing: 6) {
                            Label(item.name, systemImage: "xmark.circle")
                                .lineLimit(1)
                            Text(item.reason)
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                                .padding(.leading, 32)
                        }
                        .padding(.vertical, 2)
                    }
                } footer: {
                    if !queue.jobs.isEmpty {
                        Text("Styled copies are saved to Photos as new photos. The originals stay as they are.")
                    }
                }
            }
            .overlay {
                if model.isLoading {
                    ProgressView("Reading the shared photos…")
                } else if queue.jobs.isEmpty && model.skipped.isEmpty {
                    ContentUnavailableView("Nothing to Style", systemImage: "photo")
                }
            }
            .navigationTitle(AppSettings.displayName)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if isWorking {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel", action: cancel)
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done", action: done)
                        .disabled(isWorking)
                }
                if !isWorking && !model.results.isEmpty {
                    ToolbarItem(placement: .bottomBar) {
                        ShareLink(items: model.results) {
                            Label("Share Styled Photos", systemImage: "square.and.arrow.up")
                        }
                    }
                }
            }
        }
    }
}
