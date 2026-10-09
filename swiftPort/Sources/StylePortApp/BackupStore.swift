import Foundation
import ImageIO
import SwiftUI
import UIKit

/// One original kept by replace mode.
struct BackupEntry: Codable, Identifiable, Sendable {
    let id: UUID
    let replacedAt: Date
    let photoFilename: String
    let videoFilename: String?
    let videoTypeIdentifier: String?
    let metadata: AssetMetadata
    /// The styled photo that took its place, for "restore and remove the styled copy".
    var replacementIdentifier: String?
    let byteCount: Int64

    var isLivePhoto: Bool { videoFilename != nil }
}

/// The backup bin: originals replaced by styled versions, kept in the app's own storage until
/// they are restored or deleted. Photos also keeps the replaced asset in Recently Deleted
/// for 30 days; this copy has no time limit.
@MainActor
final class BackupStore: ObservableObject {
    @Published private(set) var entries: [BackupEntry] = []

    private let root: URL

    init() {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        root = support.appendingPathComponent("Backups", isDirectory: true)
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        reload()
    }

    var totalBytes: Int64 { entries.reduce(0) { $0 + $1.byteCount } }

    func photoURL(of entry: BackupEntry) -> URL {
        folder(of: entry.id).appendingPathComponent(entry.photoFilename)
    }

    func videoURL(of entry: BackupEntry) -> URL? {
        entry.videoFilename.map { folder(of: entry.id).appendingPathComponent($0) }
    }

    func fileURLs(of entry: BackupEntry) -> [URL] {
        [photoURL(of: entry)] + (videoURL(of: entry).map { [$0] } ?? [])
    }

    /// Copy an original into the bin before it is replaced.
    func add(original: OriginalPhoto, metadata: AssetMetadata) throws -> BackupEntry {
        let id = UUID()
        let directory = folder(of: id)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        do {
            try original.data.write(to: directory.appendingPathComponent(original.filename))
            var bytes = Int64(original.data.count)
            if let video = original.video {
                let destination = directory.appendingPathComponent(video.filename)
                try FileManager.default.copyItem(at: video.url, to: destination)
                let size = try destination.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
                bytes += Int64(size)
            }
            let entry = BackupEntry(
                id: id,
                replacedAt: Date(),
                photoFilename: original.filename,
                videoFilename: original.video?.filename,
                videoTypeIdentifier: original.video?.typeIdentifier,
                metadata: metadata,
                replacementIdentifier: nil,
                byteCount: bytes
            )
            try write(entry)
            return entry
        } catch {
            try? FileManager.default.removeItem(at: directory)
            throw error
        }
    }

    /// Make entries added for a replacement visible, linking each to its styled photo.
    func commit(_ added: [BackupEntry], replacements: [String]) {
        for (index, var entry) in added.enumerated() {
            if replacements.indices.contains(index) {
                entry.replacementIdentifier = replacements[index]
                try? write(entry)
            }
        }
        reload()
    }

    /// Drop entries whose replacement never happened.
    func discard(_ added: [BackupEntry]) {
        for entry in added { try? FileManager.default.removeItem(at: folder(of: entry.id)) }
        reload()
    }

    func delete(_ entry: BackupEntry) {
        try? FileManager.default.removeItem(at: folder(of: entry.id))
        reload()
    }

    func deleteAll() {
        for entry in entries { try? FileManager.default.removeItem(at: folder(of: entry.id)) }
        reload()
    }

    func reload() {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let folders = (try? FileManager.default.contentsOfDirectory(
            at: root,
            includingPropertiesForKeys: nil
        )) ?? []
        entries = folders.compactMap { folder in
            guard let data = try? Data(contentsOf: folder.appendingPathComponent("entry.json")) else {
                return nil
            }
            return try? decoder.decode(BackupEntry.self, from: data)
        }
        .sorted { $0.replacedAt > $1.replacedAt }
    }

    /// A small preview of a backed-up photo, display-oriented.
    nonisolated static func thumbnail(of url: URL, maxPixelSize: Int) -> UIImage? {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: maxPixelSize
              ] as CFDictionary) else { return nil }
        return UIImage(cgImage: image)
    }

    private func folder(of id: UUID) -> URL {
        root.appendingPathComponent(id.uuidString, isDirectory: true)
    }

    private func write(_ entry: BackupEntry) throws {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(entry).write(
            to: folder(of: entry.id).appendingPathComponent("entry.json"),
            options: .atomic
        )
    }
}
