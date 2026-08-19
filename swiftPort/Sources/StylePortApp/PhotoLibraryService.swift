import Foundation
import Photos
import PhotosUI
import StylePortCore
import SwiftUI
import UniformTypeIdentifiers

struct ImportedPhoto: Sendable {
    let data: Data
    let originalFilename: String
    let pairedVideoURL: URL?
    let pairedVideoFilename: String?
    let pairedVideoTypeIdentifier: String?

    var isLivePhoto: Bool { pairedVideoURL != nil }
}

struct PhotoLibraryService: Sendable {
    func loadOriginal(from item: PhotosPickerItem) async throws -> ImportedPhoto {
        try await requireReadWriteAccess()
        guard let identifier = item.itemIdentifier else {
            throw StylePortError.photoAssetUnavailable
        }
        let result = PHAsset.fetchAssets(
            withLocalIdentifiers: [identifier],
            options: nil
        )
        guard let asset = result.firstObject else {
            throw StylePortError.photoAssetUnavailable
        }

        let resources = PHAssetResource.assetResources(for: asset)
        guard let photo = resources.first(where: { $0.type == .photo }) else {
            throw StylePortError.photoAssetUnavailable
        }
        let photoData = try await data(for: photo)
        guard Self.isHEIF(photoData) else {
            throw StylePortError.originalIsNotHEIC
        }

        let paired = resources.first(where: { $0.type == .pairedVideo })
            ?? resources.first(where: { $0.type == .fullSizePairedVideo })
        let pairedURL: URL?
        if let paired {
            pairedURL = try await temporaryCopy(of: paired)
        } else {
            pairedURL = nil
        }

        return ImportedPhoto(
            data: photoData,
            originalFilename: photo.originalFilename,
            pairedVideoURL: pairedURL,
            pairedVideoFilename: paired?.originalFilename,
            pairedVideoTypeIdentifier: paired?.uniformTypeIdentifier
        )
    }

    func saveToPhotos(
        photoData: Data,
        originalFilename: String,
        pairedVideoURL: URL?,
        pairedVideoFilename: String?,
        pairedVideoTypeIdentifier: String?
    ) async throws {
        try await requireAddAccess()
        try await withCheckedThrowingContinuation { continuation in
            PHPhotoLibrary.shared().performChanges {
                let request = PHAssetCreationRequest.forAsset()

                let photoOptions = PHAssetResourceCreationOptions()
                photoOptions.originalFilename = originalFilename
                photoOptions.uniformTypeIdentifier = UTType.heic.identifier
                request.addResource(with: .photo, data: photoData, options: photoOptions)

                if let pairedVideoURL {
                    let videoOptions = PHAssetResourceCreationOptions()
                    videoOptions.originalFilename = pairedVideoFilename
                        ?? pairedVideoURL.lastPathComponent
                    videoOptions.uniformTypeIdentifier = pairedVideoTypeIdentifier
                        ?? UTType.quickTimeMovie.identifier
                    videoOptions.shouldMoveFile = false
                    request.addResource(
                        with: .pairedVideo,
                        fileURL: pairedVideoURL,
                        options: videoOptions
                    )
                }
            } completionHandler: { succeeded, error in
                if succeeded {
                    continuation.resume()
                } else {
                    continuation.resume(
                        throwing: StylePortError.saveFailed(
                            error?.localizedDescription ?? "Photos rejected the new asset."
                        )
                    )
                }
            }
        }
    }
}

private extension PhotoLibraryService {
    func requireReadWriteAccess() async throws {
        let current = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        let status: PHAuthorizationStatus
        if current == .notDetermined {
            status = await withCheckedContinuation { continuation in
                PHPhotoLibrary.requestAuthorization(for: .readWrite) {
                    continuation.resume(returning: $0)
                }
            }
        } else {
            status = current
        }
        guard status == .authorized || status == .limited else {
            throw StylePortError.photoPermissionDenied
        }
    }

    func requireAddAccess() async throws {
        let current = PHPhotoLibrary.authorizationStatus(for: .addOnly)
        let status: PHAuthorizationStatus
        if current == .notDetermined {
            status = await withCheckedContinuation { continuation in
                PHPhotoLibrary.requestAuthorization(for: .addOnly) {
                    continuation.resume(returning: $0)
                }
            }
        } else {
            status = current
        }
        guard status == .authorized else {
            throw StylePortError.photoSavePermissionDenied
        }
    }

    func data(for resource: PHAssetResource) async throws -> Data {
        let options = PHAssetResourceRequestOptions()
        options.isNetworkAccessAllowed = true
        return try await withCheckedThrowingContinuation { continuation in
            var output = Data()
            PHAssetResourceManager.default().requestData(
                for: resource,
                options: options,
                dataReceivedHandler: { output.append($0) },
                completionHandler: { error in
                    if let error {
                        continuation.resume(throwing: error)
                    } else {
                        continuation.resume(returning: output)
                    }
                }
            )
        }
    }

    func temporaryCopy(of resource: PHAssetResource) async throws -> URL {
        let directory = try temporaryDirectory()
        let filename = resource.originalFilename.isEmpty
            ? "paired-video.mov"
            : resource.originalFilename
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

    func temporaryDirectory() throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("StylePort", isDirectory: true)
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(
            at: url,
            withIntermediateDirectories: true
        )
        return url
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
