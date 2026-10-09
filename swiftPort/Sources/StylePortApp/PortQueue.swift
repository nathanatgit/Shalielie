import Foundation
import Photos
import StylePortCore

struct PortJob: Identifiable {
    enum Phase {
        case waiting
        case reading
        case porting
        case saving
        case done
        case failed(String)
    }

    let id = UUID()
    let assetIdentifier: String?
    var title: String
    var phase: Phase = .waiting
    var isLivePhoto = false
    var report: StylePortReport?
    var warnings: [String] = []
    /// For a file import: the result, to share.
    var outputURL: URL?

    var isFinished: Bool {
        switch phase {
        case .done, .failed: return true
        default: return false
        }
    }

    var isFailed: Bool {
        if case .failed = phase { return true }
        return false
    }
}

/// Runs ports one after another and saves each batch in one PhotoKit change, either as new
/// photos or, in replace mode, in place of the originals (after backing them up).
@MainActor
final class PortQueue: ObservableObject {
    @Published private(set) var jobs: [PortJob] = []
    @Published private(set) var isRunning = false
    /// Whether the floating status capsule shows. It hides 2 seconds after a batch that
    /// went through, and stays after a failure until the Activity sheet is opened.
    @Published private(set) var showsStatus = false
    weak var backups: BackupStore?

    private let library = PhotoLibraryService()
    private let porter = StylePorter()
    private var pending: [Batch] = []

    private struct Batch {
        enum Source {
            case assets([PHAsset])
            case files([URL])
        }

        let source: Source
        let replace: Bool
        let jobIDs: [UUID]
    }

    init() {
        TemporaryFiles.purge()
    }

    /// One line for the floating status capsule; nil hides it.
    var statusLine: String? {
        guard showsStatus, !jobs.isEmpty else { return nil }
        let finished = jobs.filter(\.isFinished).count
        let failed = jobs.filter(\.isFailed).count
        if isRunning { return "Styling \(min(finished + 1, jobs.count)) of \(jobs.count)…" }
        if failed > 0 { return "\(jobs.count - failed) done, \(failed) failed" }
        return jobs.count == 1 ? "1 photo done" : "\(jobs.count) photos done"
    }

    func job(forAsset identifier: String) -> PortJob? {
        jobs.last { $0.assetIdentifier == identifier }
    }

    func dismissStatus() {
        if !isRunning { showsStatus = false }
    }

    func clearFinished() {
        jobs.removeAll(where: \.isFinished)
    }

    /// Port library photos. Replace mode comes from Settings at the time of the call.
    func port(_ assets: [PHAsset]) {
        guard !assets.isEmpty else { return }
        let newJobs = assets.map {
            PortJob(
                assetIdentifier: $0.localIdentifier,
                title: PhotoLibraryService.filename(of: $0),
                isLivePhoto: $0.mediaSubtypes.contains(.photoLive)
            )
        }
        enqueue(newJobs, Batch(
            source: .assets(assets),
            replace: AppSettings.replaceOriginals,
            jobIDs: newJobs.map(\.id)
        ))
    }

    /// Port HEIC files chosen in Files. They have no library photo to replace, so they are
    /// always saved as new photos, without a Live Photo video.
    func port(files: [URL]) {
        guard !files.isEmpty else { return }
        let newJobs = files.map { PortJob(assetIdentifier: nil, title: $0.lastPathComponent) }
        enqueue(newJobs, Batch(source: .files(files), replace: false, jobIDs: newJobs.map(\.id)))
    }

    private func enqueue(_ newJobs: [PortJob], _ batch: Batch) {
        if !isRunning { jobs.removeAll(where: \.isFinished) }
        jobs.append(contentsOf: newJobs)
        pending.append(batch)
        showsStatus = true
        guard !isRunning else { return }
        isRunning = true
        Task { await drain() }
    }

    private func drain() async {
        while !pending.isEmpty {
            let batch = pending.removeFirst()
            await run(batch)
        }
        isRunning = false
        guard !jobs.contains(where: \.isFailed) else { return }
        try? await Task.sleep(for: .seconds(2))
        if !isRunning { showsStatus = false }
    }

    private func run(_ batch: Batch) async {
        let options = StylePortOptions(
            analyzePhoto: AppSettings.analyzePhoto,
            texture: AppSettings.texture
        )
        var ported: [(jobID: UUID, asset: PHAsset?, original: OriginalPhoto, output: PortOutput)] = []

        switch batch.source {
        case .assets(let assets):
            for (jobID, asset) in zip(batch.jobIDs, assets) {
                do {
                    update(jobID) { $0.phase = .reading }
                    let original = try await library.loadOriginal(asset)
                    update(jobID) {
                        $0.phase = .porting
                        $0.isLivePhoto = original.video != nil
                        if original.hasEdits {
                            $0.warnings.append("Edits made in Photos aren't carried over; the style is added to the original.")
                        }
                    }
                    let output = try await port(original, replace: batch.replace, options: options)
                    ported.append((jobID: jobID, asset: Optional(asset), original: original, output: output))
                    update(jobID) {
                        $0.report = output.report
                        if original.video != nil && output.video == nil {
                            $0.isLivePhoto = false
                            $0.warnings.append(batch.replace
                                ? "Saved as a still photo: Photos can't edit a styled Live Photo yet. The original, with its motion, is in the Backup Bin."
                                : "Saved as a still photo: Photos can't edit a styled Live Photo yet. The original Live Photo is unchanged.")
                        }
                    }
                } catch {
                    update(jobID) { $0.phase = .failed(error.localizedDescription) }
                }
            }
        case .files(let urls):
            for (jobID, url) in zip(batch.jobIDs, urls) {
                let scoped = url.startAccessingSecurityScopedResource()
                defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                do {
                    update(jobID) { $0.phase = .porting }
                    let original = OriginalPhoto(
                        data: try Data(contentsOf: url),
                        filename: url.lastPathComponent,
                        video: nil,
                        hasEdits: false
                    )
                    let output = try await port(original, replace: false, options: options)
                    ported.append((jobID: jobID, asset: nil, original: original, output: output))
                    update(jobID) {
                        $0.report = output.report
                        $0.outputURL = output.photoURL
                    }
                } catch {
                    update(jobID) { $0.phase = .failed(error.localizedDescription) }
                }
            }
        }
        guard !ported.isEmpty else { return }

        for item in ported { update(item.jobID) { $0.phase = .saving } }
        do {
            if batch.replace {
                try await replace(ported.compactMap { item in
                    item.asset.map {
                        (jobID: item.jobID, asset: $0, original: item.original, output: item.output)
                    }
                })
            } else {
                _ = try await library.saveNew(ported.map { $0.output })
            }
            for item in ported { update(item.jobID) { $0.phase = .done } }
        } catch {
            for item in ported { update(item.jobID) { $0.phase = .failed(error.localizedDescription) } }
        }
    }

    private func replace(
        _ items: [(jobID: UUID, asset: PHAsset, original: OriginalPhoto, output: PortOutput)]
    ) async throws {
        guard let backups else { throw LibraryError.saveFailed("The backup bin isn't available.") }
        // Back up first: an original is only deleted once its copy is safely in the bin.
        var added: [BackupEntry] = []
        var metadata: [AssetMetadata] = []
        do {
            for item in items {
                let meta = PhotoLibraryService.metadata(of: item.asset)
                metadata.append(meta)
                added.append(try backups.add(original: item.original, metadata: meta))
            }
        } catch {
            backups.discard(added)
            throw error
        }
        do {
            let replacements = try await library.replace(zip(items, metadata).map {
                (asset: $0.0.asset, output: $0.0.output, metadata: $0.1)
            })
            backups.commit(added, replacements: replacements)
        } catch {
            backups.discard(added)
            throw error
        }
    }

    /// Port off the main actor and write the result to a temporary file.
    private func port(
        _ original: OriginalPhoto,
        replace: Bool,
        options: StylePortOptions
    ) async throws -> PortOutput {
        let porter = porter
        let data = original.data
        let result = try await Task.detached(priority: .userInitiated) {
            try porter.patch(data, options: options)
        }.value
        let names = OutputNames(
            original: original,
            replace: replace,
            textureOnly: result.report.mode == .addTexture
        )
        let directory = try TemporaryFiles.newDirectory()
        let photoURL = directory.appendingPathComponent(names.photo)
        try result.data.write(to: photoURL, options: .atomic)
        var video: PairedVideo?
        if LivePhotoPolicy.keepsVideo(result.report), let source = original.video, let name = names.video {
            let url = directory.appendingPathComponent(name)
            try FileManager.default.copyItem(at: source.url, to: url)
            video = PairedVideo(url: url, filename: name, typeIdentifier: source.typeIdentifier)
        }
        return PortOutput(photoURL: photoURL, photoFilename: names.photo, video: video, report: result.report)
    }

    private func update(_ id: UUID, _ body: (inout PortJob) -> Void) {
        guard let index = jobs.firstIndex(where: { $0.id == id }) else { return }
        body(&jobs[index])
    }
}

/// Which results keep their Live Photo video. Photos' editor applies the style to a Live
/// Photo's video too and aborts when the video has no style data, which an iPhone 15 or
/// earlier video lacks. So a newly styled photo is saved as a still; a native style photo
/// that only gets Texture & Grain keeps its own, style-ready video.
enum LivePhotoPolicy {
    static func keepsVideo(_ report: StylePortReport) -> Bool {
        report.mode == .addTexture
    }
}

/// File names for a result: the original's in replace mode, otherwise the original's with
/// the same suffixes the command-line tool and the web app use, for photo and video alike.
struct OutputNames {
    let photo: String
    let video: String?

    init(original: OriginalPhoto, replace: Bool, textureOnly: Bool) {
        if replace {
            photo = original.filename
            video = original.video?.filename
            return
        }
        let suffix = textureOnly ? "_TextureGrain" : "_PhotographicStyle"
        let base = (original.filename as NSString).deletingPathExtension
        photo = base + suffix + ".HEIC"
        video = original.video.map {
            let videoExtension = ($0.filename as NSString).pathExtension
            return base + suffix + "." + (videoExtension.isEmpty ? "MOV" : videoExtension)
        }
    }
}
