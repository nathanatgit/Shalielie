import CoreLocation
import Foundation
import ImageIO
import Photos
import StylePortCore
import UniformTypeIdentifiers

/// A Live Photo's motion part, as a file next to its still.
struct PairedVideo: Sendable {
    let url: URL
    let filename: String
    let typeIdentifier: String
}

/// The original resources of a library photo.
struct OriginalPhoto: Sendable {
    let data: Data
    let filename: String
    let video: PairedVideo?
    /// The photo was edited in Photos; the port starts from the unedited original.
    let hasEdits: Bool
}

/// A finished port, written to a temporary file and ready to be saved. `report` is nil for
/// a file pair saved as it was.
struct PortOutput: Sendable {
    let photoURL: URL
    let photoFilename: String
    let video: PairedVideo?
    let report: StylePortReport?
}

/// What a replaced photo had in the library besides its resources, so a replacement and a
/// restore can carry it over.
struct AssetMetadata: Codable, Sendable {
    var creationDate: Date?
    var latitude: Double?
    var longitude: Double?
    var altitude: Double?
    var isFavorite: Bool
    var isHidden: Bool
    var albumIdentifiers: [String]

    var location: CLLocation? {
        guard let latitude, let longitude else { return nil }
        return CLLocation(
            coordinate: CLLocationCoordinate2D(latitude: latitude, longitude: longitude),
            altitude: altitude ?? 0,
            horizontalAccuracy: 0,
            verticalAccuracy: altitude == nil ? -1 : 0,
            timestamp: creationDate ?? Date()
        )
    }
}

enum LibraryError: LocalizedError {
    case accessDenied
    case addAccessDenied
    case assetUnavailable
    case notHEIC
    case saveFailed(String)

    var errorDescription: String? {
        switch self {
        case .accessDenied:
            return "Allow access to your photos in Settings to read the original HEIC and Live Photo video."
        case .addAccessDenied:
            return "Allow adding to your photo library in Settings to save the result."
        case .assetUnavailable:
            return "This photo is no longer in your library."
        case .notHEIC:
            return "This photo's original isn't a HEIC."
        case .saveFailed(let message):
            return "Photos didn't save the result: \(message)"
        }
    }
}

/// Collects values inside a PhotoKit change block.
private final class Collector<Value>: @unchecked Sendable {
    var values: [Value] = []
}

struct PhotoLibraryService: Sendable {
    // MARK: Access

    static var status: PHAuthorizationStatus {
        PHPhotoLibrary.authorizationStatus(for: .readWrite)
    }

    @discardableResult
    static func requestAccess() async -> PHAuthorizationStatus {
        let current = status
        guard current == .notDetermined else { return current }
        return await PHPhotoLibrary.requestAuthorization(for: .readWrite)
    }

    func requireReadWriteAccess() async throws {
        let status = await Self.requestAccess()
        guard status == .authorized || status == .limited else { throw LibraryError.accessDenied }
    }

    // MARK: Reading

    static func photoResource(of asset: PHAsset) -> PHAssetResource? {
        PHAssetResource.assetResources(for: asset).first { $0.type == .photo }
    }

    static func isHEIC(_ asset: PHAsset) -> Bool {
        guard let identifier = photoResource(of: asset)?.uniformTypeIdentifier,
              let type = UTType(identifier) else { return false }
        return type.conforms(to: .heic) || type.conforms(to: .heif)
    }

    static func filename(of asset: PHAsset) -> String {
        photoResource(of: asset)?.originalFilename ?? "Photo"
    }

    func loadOriginal(_ asset: PHAsset) async throws -> OriginalPhoto {
        try await requireReadWriteAccess()
        let resources = PHAssetResource.assetResources(for: asset)
        guard let photo = resources.first(where: { $0.type == .photo }) else {
            throw LibraryError.assetUnavailable
        }
        let data = try await Self.data(for: photo)
        guard Self.isHEIF(data) else { throw LibraryError.notHEIC }
        let paired = resources.first { $0.type == .pairedVideo }
        var video: PairedVideo?
        if let paired {
            video = PairedVideo(
                url: try await Self.temporaryCopy(of: paired),
                filename: paired.originalFilename,
                typeIdentifier: paired.uniformTypeIdentifier
            )
        }
        return OriginalPhoto(
            data: data,
            filename: photo.originalFilename,
            video: video,
            hasEdits: resources.contains { $0.type == .adjustmentData || $0.type == .fullSizePhoto }
        )
    }

    /// What the port would do with this photo, read from the original only when it is on the
    /// device: no iCloud download just to look. nil when it isn't local or can't be read.
    func eligibility(of asset: PHAsset) async -> StylePorter.Eligibility? {
        guard let photo = Self.photoResource(of: asset),
              let data = try? await Self.data(for: photo, allowNetwork: false) else { return nil }
        return StylePorter.eligibility(of: data)
    }

    static func metadata(of asset: PHAsset) -> AssetMetadata {
        let albums = PHAssetCollection.fetchAssetCollectionsContaining(
            asset,
            with: .album,
            options: nil
        )
        var albumIdentifiers: [String] = []
        albums.enumerateObjects { album, _, _ in
            if album.canPerform(.addContent) { albumIdentifiers.append(album.localIdentifier) }
        }
        return AssetMetadata(
            creationDate: asset.creationDate,
            latitude: asset.location?.coordinate.latitude,
            longitude: asset.location?.coordinate.longitude,
            altitude: asset.location?.altitude,
            isFavorite: asset.isFavorite,
            isHidden: asset.isHidden,
            albumIdentifiers: albumIdentifiers
        )
    }

    // MARK: Writing

    /// Save each output as a new photo (a Live Photo when it has a video). Returns the new
    /// assets' local identifiers.
    func saveNew(_ outputs: [PortOutput]) async throws -> [String] {
        try await requireAddAccess()
        let created = Collector<String>()
        do {
            try await PHPhotoLibrary.shared().performChanges {
                for output in outputs {
                    let request = PHAssetCreationRequest.forAsset()
                    Self.addResources(
                        to: request,
                        photoURL: output.photoURL,
                        photoFilename: output.photoFilename,
                        video: output.video
                    )
                    if let id = request.placeholderForCreatedAsset?.localIdentifier {
                        created.values.append(id)
                    }
                }
            }
        } catch {
            throw LibraryError.saveFailed(error.localizedDescription)
        }
        return created.values
    }

    /// Replace each asset with its output in one change: the new photo takes the original's
    /// date, location, favorite and album memberships, and the original is deleted (it stays
    /// in Recently Deleted). iOS asks once to confirm the deletion; if the person declines,
    /// nothing changes. Returns the new assets' local identifiers, in order.
    func replace(_ items: [(asset: PHAsset, output: PortOutput, metadata: AssetMetadata)]) async throws -> [String] {
        try await requireReadWriteAccess()
        let albumIDs = Set(items.flatMap { $0.metadata.albumIdentifiers })
        let albums = Self.albums(withIdentifiers: Array(albumIDs))
        let created = Collector<String>()
        do {
            try await PHPhotoLibrary.shared().performChanges {
                for item in items {
                    let request = PHAssetCreationRequest.forAsset()
                    Self.addResources(
                        to: request,
                        photoURL: item.output.photoURL,
                        photoFilename: item.output.photoFilename,
                        video: item.output.video
                    )
                    Self.apply(item.metadata, to: request, albums: albums)
                    if let id = request.placeholderForCreatedAsset?.localIdentifier {
                        created.values.append(id)
                    }
                }
                PHAssetChangeRequest.deleteAssets(items.map { $0.asset } as NSArray)
            }
        } catch {
            throw LibraryError.saveFailed(error.localizedDescription)
        }
        return created.values
    }

    /// Put a backed-up original back in the library, optionally deleting its styled
    /// replacement. Returns the restored asset's local identifier.
    @MainActor
    func restore(_ entry: BackupEntry, from store: BackupStore, deleteReplacement: Bool) async throws -> String? {
        try await requireReadWriteAccess()
        let albums = Self.albums(withIdentifiers: entry.metadata.albumIdentifiers)
        var replacement: PHAsset?
        if deleteReplacement, let id = entry.replacementIdentifier {
            replacement = PHAsset.fetchAssets(withLocalIdentifiers: [id], options: nil).firstObject
        }
        let photoURL = store.photoURL(of: entry)
        let video = store.videoURL(of: entry).map {
            PairedVideo(
                url: $0,
                filename: entry.videoFilename ?? $0.lastPathComponent,
                typeIdentifier: entry.videoTypeIdentifier ?? UTType.quickTimeMovie.identifier
            )
        }
        let created = Collector<String>()
        do {
            try await PHPhotoLibrary.shared().performChanges {
                let request = PHAssetCreationRequest.forAsset()
                Self.addResources(
                    to: request,
                    photoURL: photoURL,
                    photoFilename: entry.photoFilename,
                    video: video
                )
                Self.apply(entry.metadata, to: request, albums: albums)
                if let id = request.placeholderForCreatedAsset?.localIdentifier {
                    created.values.append(id)
                }
                if let replacement {
                    PHAssetChangeRequest.deleteAssets([replacement] as NSArray)
                }
            }
        } catch {
            throw LibraryError.saveFailed(error.localizedDescription)
        }
        return created.values.first
    }

    // MARK: Shortcuts

    /// The paired video of the library Live Photo this HEIC came from, found by its capture
    /// date and confirmed by the Live Photo content identifier. Shortcuts hands an app only
    /// the still, so this is how the motion part is recovered. nil when there is no match
    /// or no library access.
    func pairedVideo(matchingHEIC data: Data) async -> PairedVideo? {
        let status = Self.status
        guard status == .authorized || status == .limited,
              let identifier = AppleExif.contentIdentifier(ofHEIC: data),
              let captured = Self.captureDate(ofImage: data) else { return nil }
        let options = PHFetchOptions()
        options.predicate = NSPredicate(
            format: "creationDate >= %@ AND creationDate <= %@ AND (mediaSubtypes & %d) != 0",
            captured.addingTimeInterval(-2) as NSDate,
            captured.addingTimeInterval(2) as NSDate,
            Int(PHAssetMediaSubtype.photoLive.rawValue)
        )
        options.fetchLimit = 12
        let candidates = PHAsset.fetchAssets(with: .image, options: options)
        for index in 0..<candidates.count {
            let resources = PHAssetResource.assetResources(for: candidates.object(at: index))
            guard let photo = resources.first(where: { $0.type == .photo }),
                  let paired = resources.first(where: { $0.type == .pairedVideo }),
                  let candidate = try? await Self.data(for: photo),
                  AppleExif.contentIdentifier(ofHEIC: candidate) == identifier,
                  let url = try? await Self.temporaryCopy(of: paired) else { continue }
            return PairedVideo(
                url: url,
                filename: paired.originalFilename,
                typeIdentifier: paired.uniformTypeIdentifier
            )
        }
        return nil
    }

    /// Exif DateTimeOriginal with its offset; Photos uses the same instant as creationDate.
    static func captureDate(ofImage data: Data) -> Date? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let exif = properties[kCGImagePropertyExifDictionary] as? [CFString: Any],
              let original = exif[kCGImagePropertyExifDateTimeOriginal] as? String else { return nil }
        let offset = exif[kCGImagePropertyExifOffsetTimeOriginal] as? String
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = offset == nil ? "yyyy:MM:dd HH:mm:ss" : "yyyy:MM:dd HH:mm:ssxxx"
        return formatter.date(from: original + (offset ?? ""))
    }
}

private extension PhotoLibraryService {
    func requireAddAccess() async throws {
        let current = PHPhotoLibrary.authorizationStatus(for: .addOnly)
        let status = current == .notDetermined
            ? await PHPhotoLibrary.requestAuthorization(for: .addOnly)
            : current
        guard status == .authorized || status == .limited else { throw LibraryError.addAccessDenied }
    }

    static func addResources(
        to request: PHAssetCreationRequest,
        photoURL: URL,
        photoFilename: String,
        video: PairedVideo?
    ) {
        let photoOptions = PHAssetResourceCreationOptions()
        photoOptions.originalFilename = photoFilename
        photoOptions.uniformTypeIdentifier = UTType.heic.identifier
        photoOptions.shouldMoveFile = false
        request.addResource(with: .photo, fileURL: photoURL, options: photoOptions)
        guard let video else { return }
        // The patched HEIC keeps MakerNote 0x11, the content identifier the video carries,
        // so Photos pairs the two into a Live Photo again.
        let videoOptions = PHAssetResourceCreationOptions()
        videoOptions.originalFilename = video.filename
        videoOptions.uniformTypeIdentifier = video.typeIdentifier
        videoOptions.shouldMoveFile = false
        request.addResource(with: .pairedVideo, fileURL: video.url, options: videoOptions)
    }

    static func apply(
        _ metadata: AssetMetadata,
        to request: PHAssetCreationRequest,
        albums: [PHAssetCollection]
    ) {
        if let date = metadata.creationDate { request.creationDate = date }
        if let location = metadata.location { request.location = location }
        request.isFavorite = metadata.isFavorite
        request.isHidden = metadata.isHidden
        guard let placeholder = request.placeholderForCreatedAsset else { return }
        for album in albums where metadata.albumIdentifiers.contains(album.localIdentifier) {
            PHAssetCollectionChangeRequest(for: album)?.addAssets([placeholder] as NSArray)
        }
    }

    static func albums(withIdentifiers identifiers: [String]) -> [PHAssetCollection] {
        guard !identifiers.isEmpty else { return [] }
        let result = PHAssetCollection.fetchAssetCollections(
            withLocalIdentifiers: identifiers,
            options: nil
        )
        var albums: [PHAssetCollection] = []
        result.enumerateObjects { album, _, _ in
            if album.canPerform(.addContent) { albums.append(album) }
        }
        return albums
    }

    static func data(for resource: PHAssetResource, allowNetwork: Bool = true) async throws -> Data {
        let options = PHAssetResourceRequestOptions()
        options.isNetworkAccessAllowed = allowNetwork
        let buffer = Collector<Data>()
        return try await withCheckedThrowingContinuation { continuation in
            PHAssetResourceManager.default().requestData(
                for: resource,
                options: options,
                dataReceivedHandler: { buffer.values.append($0) },
                completionHandler: { error in
                    if let error {
                        continuation.resume(throwing: error)
                    } else {
                        continuation.resume(returning: buffer.values.reduce(into: Data()) { $0.append($1) })
                    }
                }
            )
        }
    }

    static func temporaryCopy(of resource: PHAssetResource) async throws -> URL {
        let directory = try TemporaryFiles.newDirectory()
        let filename = resource.originalFilename.isEmpty ? "paired-video.mov" : resource.originalFilename
        let destination = directory.appendingPathComponent(filename)
        let options = PHAssetResourceRequestOptions()
        options.isNetworkAccessAllowed = true
        return try await withCheckedThrowingContinuation { continuation in
            PHAssetResourceManager.default().writeData(
                for: resource,
                toFile: destination,
                options: options
            ) { error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume(returning: destination)
                }
            }
        }
    }

    static func isHEIF(_ data: Data) -> Bool {
        let bytes = [UInt8](data.prefix(128))
        guard bytes.count >= 12,
              String(bytes: bytes[4..<8], encoding: .ascii) == "ftyp" else {
            return false
        }
        let knownBrands: Set<String> = [
            "heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"
        ]
        var cursor = 8
        while cursor + 4 <= bytes.count {
            if let brand = String(bytes: bytes[cursor..<(cursor + 4)], encoding: .ascii),
               knownBrands.contains(brand) {
                return true
            }
            cursor += 4
        }
        return false
    }
}

/// Per-job scratch folders under the app's temporary directory.
enum TemporaryFiles {
    static var root: URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("Shalielie", isDirectory: true)
    }

    static func newDirectory() throws -> URL {
        let url = root.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    /// Clear what earlier launches left behind.
    static func purge() {
        try? FileManager.default.removeItem(at: root)
    }
}
