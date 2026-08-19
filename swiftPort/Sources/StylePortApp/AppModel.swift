import Combine
import Foundation
import PhotosUI
import StylePortCore

struct ProcessedPhoto: Sendable {
    let data: Data
    let outputURL: URL
    let outputFilename: String
    let pairedVideoURL: URL?
    let pairedVideoFilename: String?
    let pairedVideoTypeIdentifier: String?
    let report: StylePortReport

    var isLivePhoto: Bool { pairedVideoURL != nil }
}

struct StylePortJob: Identifiable {
    enum Phase {
        case queued
        case converting
        case ready(ProcessedPhoto)
        case saving(ProcessedPhoto)
        case saved(ProcessedPhoto)
        case saveFailed(ProcessedPhoto, String)
        case failed(String)
    }

    let id: UUID
    let sourceName: String
    var phase: Phase
}

@MainActor
final class AppModel: ObservableObject {
    @Published var jobs: [StylePortJob] = []
    @Published var analyzePhoto = true

    private let photos = PhotoLibraryService()
    private let porter = StylePorter()

    func importPhotos(_ items: [PhotosPickerItem]) {
        let analyze = analyzePhoto
        let work = items.map { (UUID(), $0) }
        for (id, _) in work.reversed() {
            jobs.insert(
                StylePortJob(id: id, sourceName: "Photos selection", phase: .queued),
                at: 0
            )
        }
        Task {
            for (id, item) in work {
                do {
                    update(id) { $0.phase = .converting }
                    let imported = try await photos.loadOriginal(from: item)
                    update(id) {
                        $0 = StylePortJob(
                            id: id,
                            sourceName: imported.originalFilename,
                            phase: .converting
                        )
                    }
                    let processed = try await convert(imported, analyze: analyze)
                    update(id) { $0.phase = .ready(processed) }
                } catch {
                    update(id) { $0.phase = .failed(error.localizedDescription) }
                }
            }
        }
    }

    func importFiles(_ urls: [URL]) {
        let analyze = analyzePhoto
        let work = urls.map { (UUID(), $0) }
        for (id, url) in work.reversed() {
            jobs.insert(
                StylePortJob(id: id, sourceName: url.lastPathComponent, phase: .queued),
                at: 0
            )
        }
        Task {
            for (id, url) in work {
                let hasScope = url.startAccessingSecurityScopedResource()
                defer {
                    if hasScope { url.stopAccessingSecurityScopedResource() }
                }
                do {
                    update(id) { $0.phase = .converting }
                    let imported = ImportedPhoto(
                        data: try Data(contentsOf: url),
                        originalFilename: url.lastPathComponent,
                        pairedVideoURL: nil,
                        pairedVideoFilename: nil,
                        pairedVideoTypeIdentifier: nil
                    )
                    let processed = try await convert(imported, analyze: analyze)
                    update(id) { $0.phase = .ready(processed) }
                } catch {
                    update(id) { $0.phase = .failed(error.localizedDescription) }
                }
            }
        }
    }

    func save(_ processed: ProcessedPhoto, jobID: UUID) {
        update(jobID) { $0.phase = .saving(processed) }
        Task {
            do {
                try await photos.saveToPhotos(
                    photoData: processed.data,
                    originalFilename: processed.outputFilename,
                    pairedVideoURL: processed.pairedVideoURL,
                    pairedVideoFilename: processed.pairedVideoFilename,
                    pairedVideoTypeIdentifier: processed.pairedVideoTypeIdentifier
                )
                update(jobID) { $0.phase = .saved(processed) }
            } catch {
                update(jobID) {
                    $0.phase = .saveFailed(processed, error.localizedDescription)
                }
            }
        }
    }

    func remove(_ id: UUID) {
        jobs.removeAll { $0.id == id }
    }
}

private extension AppModel {
    func update(_ id: UUID, body: (inout StylePortJob) -> Void) {
        guard let index = jobs.firstIndex(where: { $0.id == id }) else { return }
        body(&jobs[index])
    }

    func convert(_ imported: ImportedPhoto, analyze: Bool) async throws -> ProcessedPhoto {
        let porter = porter
        let data = imported.data
        let result = try await Task.detached(priority: .userInitiated) {
            try porter.patch(data, options: .init(analyzePhoto: analyze))
        }.value

        let base = URL(fileURLWithPath: imported.originalFilename)
            .deletingPathExtension()
            .lastPathComponent
        let outputFilename = "\(base)-styleport.heic"
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("StylePort", isDirectory: true)
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true
        )
        let outputURL = directory.appendingPathComponent(outputFilename)
        try result.data.write(to: outputURL, options: .atomic)
        return ProcessedPhoto(
            data: result.data,
            outputURL: outputURL,
            outputFilename: outputFilename,
            pairedVideoURL: imported.pairedVideoURL,
            pairedVideoFilename: imported.pairedVideoFilename,
            pairedVideoTypeIdentifier: imported.pairedVideoTypeIdentifier,
            report: result.report
        )
    }
}
