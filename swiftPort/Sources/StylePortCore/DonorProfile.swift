import Foundation

struct DonorManifest: Decodable {
    let format: String
    let version: String
    let smartStyleMakerNoteType: Int
    let donorPrimaryItem: Int
    let donorPrimaryTiles: [Int]
    let donorThumbnailItem: Int
    let donorHDRGridItem: Int
    let donorHDRTiles: [Int]
    let donorLinearThumbnailItem: Int
    let donorStylesItem: Int
    let donorExifItem: Int
    let linearThumbnailHVCCPropertyIndex: Int
    let primaryTileCount: Int
    let hdrTileCount: Int
    let retainedExternalItems: [Int]

    enum CodingKeys: String, CodingKey {
        case format
        case version
        case smartStyleMakerNoteType = "smartstyle_makernote_type"
        case donorPrimaryItem = "donor_primary_item"
        case donorPrimaryTiles = "donor_primary_tiles"
        case donorThumbnailItem = "donor_thumbnail_item"
        case donorHDRGridItem = "donor_hdr_grid_item"
        case donorHDRTiles = "donor_hdr_tiles"
        case donorLinearThumbnailItem = "donor_linear_thumb_item"
        case donorStylesItem = "donor_styles_item"
        case donorExifItem = "donor_exif_item"
        case linearThumbnailHVCCPropertyIndex = "linear_thumb_hvcc_property_index"
        case primaryTileCount = "primary_tile_count"
        case hdrTileCount = "hdr_tile_count"
        case retainedExternalItems = "retained_external_items"
    }
}

struct DonorProfile {
    let manifest: DonorManifest
    let fileTypeBox: Bytes
    let metadataBox: Bytes
    let makerNote54: Bytes
    let retainedPayloads: [Int: Bytes]
}

private final class StylePortBundleToken: NSObject {}

enum DonorProfileLoader {
    private static var resourceBundle: Bundle {
        #if SWIFT_PACKAGE
        return .module
        #else
        return Bundle(for: StylePortBundleToken.self)
        #endif
    }

    static func profile(primaryTiles: Int, hdrTiles: Int) throws -> DonorProfile {
        let name: String
        switch (primaryTiles, hdrTiles) {
        case (45, 15): name = "45-15"
        case (48, 12): name = "48-12"
        default: throw StylePortError.unsupportedPhoto
        }
        return try load(named: name)
    }

    static func load(named name: String) throws -> DonorProfile {
        let subdirectory = "Profiles/\(name)"
        func bytes(_ resource: String, extension fileExtension: String) throws -> Bytes {
            guard let url = resourceBundle.url(
                forResource: resource,
                withExtension: fileExtension,
                subdirectory: subdirectory
            ) else {
                throw StylePortError.missingResource("\(subdirectory)/\(resource).\(fileExtension)")
            }
            return try Data(contentsOf: url).stylePortBytes
        }

        guard let manifestURL = resourceBundle.url(
            forResource: "manifest",
            withExtension: "json",
            subdirectory: subdirectory
        ) else {
            throw StylePortError.missingResource("\(subdirectory)/manifest.json")
        }
        let manifest = try JSONDecoder().decode(
            DonorManifest.self,
            from: Data(contentsOf: manifestURL)
        )
        guard manifest.format == "smartstyle-port-donor-profile" else {
            throw StylePortError.invalidData("The bundled donor profile has an unknown format.")
        }

        var retained: [Int: Bytes] = [:]
        for itemID in manifest.retainedExternalItems {
            guard let url = resourceBundle.url(
                forResource: String(itemID),
                withExtension: "bin",
                subdirectory: "\(subdirectory)/payloads"
            ) else {
                throw StylePortError.missingResource(
                    "\(subdirectory)/payloads/\(itemID).bin"
                )
            }
            retained[itemID] = try Data(contentsOf: url).stylePortBytes
        }
        return DonorProfile(
            manifest: manifest,
            fileTypeBox: try bytes("ftyp", extension: "bin"),
            metadataBox: try bytes("meta", extension: "bin"),
            makerNote54: try bytes("makernote_0x54", extension: "bin"),
            retainedPayloads: retained
        )
    }
}
