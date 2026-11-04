import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// Experimental "any image" input (after PR #4, and the CLI's `--any-image`): turns any picture
/// into an iPhone-shaped SDR HEIC that the porter can then style. The picture is drawn into
/// sRGB (transparency on black), scaled to at most a 12 MP grid, and cut into 512 px tiles.
/// Each tile and the thumbnail are encoded by the system's own HEIC encoder, and their HEVC
/// data and colour description are lifted into one grid file with a minimal Apple Exif.
public enum RasterImport {
    static let maxTiles = 48
    static let thumbnailEdge = 416

    /// A picture the porter can't take as it is (JPEG, PNG, a screenshot, a HEIC from another
    /// phone) converted to an iPhone-shaped HEIC; nil when it is already a HEIC the porter takes.
    /// Shared by the app and the Share extension, each deciding itself whether Any Image is on.
    public static func convertedForPort(_ data: Data, captureDate: Date?, allowSDR: Bool) throws -> Data? {
        if isHEIF(data), StylePorter.eligibility(of: data, allowSDR: allowSDR) != .unsupported {
            return nil
        }
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any] else {
            throw StylePortError.invalidData(String(localized: "The photo couldn't be read."))
        }
        let width = properties[kCGImagePropertyPixelWidth] as? Int ?? 0
        let height = properties[kCGImagePropertyPixelHeight] as? Int ?? 0
        // Full size, with its orientation applied.
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: max(width, height, 1)
        ] as CFDictionary) else {
            throw StylePortError.invalidData(String(localized: "The photo couldn't be read."))
        }
        return try heic(from: image, captureDate: captureDate, source: data)
    }

    public static func isHEIF(_ data: Data) -> Bool {
        let bytes = [UInt8](data.prefix(128))
        guard bytes.count >= 12, String(bytes: bytes[4..<8], encoding: .ascii) == "ftyp" else { return false }
        let knownBrands: Set<String> = ["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"]
        var cursor = 8
        while cursor + 4 <= bytes.count {
            if let brand = String(bytes: bytes[cursor..<(cursor + 4)], encoding: .ascii), knownBrands.contains(brand) {
                return true
            }
            cursor += 4
        }
        return false
    }

    /// The HEIC for an upright picture (orientation already applied). `source` is the original
    /// file, whose Exif (location, camera, lens, dates) is carried over when it can be read.
    public static func heic(from image: CGImage, captureDate: Date?, source: Data? = nil) throws -> Data {
        let (width, height) = scaledSize(width: image.width, height: image.height)
        guard let canvas = drawSRGB(image, width: width, height: height) else {
            throw StylePortError.invalidData("Could not draw the picture.")
        }
        let columns = (width + 511) / 512
        let rows = (height + 511) / 512
        var tiles: [EncodedImage] = []
        for index in 0..<(columns * rows) {
            let x = (index % columns) * 512
            let y = (index / columns) * 512
            guard let tile = tileImage(canvas, x: x, y: y) else {
                throw StylePortError.invalidData("Could not cut a tile.")
            }
            tiles.append(try encode(tile))
        }
        let scale = Double(thumbnailEdge) / Double(max(width, height))
        let thumbWidth = max(2, Int((Double(width) * scale / 2).rounded()) * 2)
        let thumbHeight = max(2, Int((Double(height) * scale / 2).rounded()) * 2)
        guard let small = drawSRGB(canvas, width: thumbWidth, height: thumbHeight) else {
            throw StylePortError.invalidData("Could not draw the thumbnail.")
        }
        let thumbnail = try encode(small)
        let exif = source.flatMap { sourceTIFF(in: $0.stylePortBytes) }
            .flatMap { carryExif(tiff: $0, width: width, height: height) }
            ?? appleExif(width: width, height: height, date: captureDate)
        return assemble(width: width, height: height, tiles: tiles, thumbnail: thumbnail,
                        thumbnailSize: (thumbWidth, thumbHeight), exif: exif).stylePortData
    }

    /// At most `maxTiles` 512 px tiles; never scaled up.
    static func scaledSize(width: Int, height: Int) -> (Int, Int) {
        let tiles = ((width + 511) / 512) * ((height + 511) / 512)
        guard tiles > maxTiles else { return (width, height) }
        var best = 0.0
        for columns in 1...maxTiles {
            let scale = min(Double(columns * 512) / Double(width),
                            Double((maxTiles / columns) * 512) / Double(height), 1)
            best = max(best, scale)
        }
        return (max(2, Int(Double(width) * best)), max(2, Int(Double(height) * best)))
    }

    static func drawSRGB(_ image: CGImage, width: Int, height: Int) -> CGImage? {
        guard let space = CGColorSpace(name: CGColorSpace.sRGB),
              let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8,
                                      bytesPerRow: 0, space: space,
                                      bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return nil }
        context.setFillColor(CGColor(gray: 0, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        context.interpolationQuality = .high
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        return context.makeImage()
    }

    /// One 512 px tile, padded with black past the picture's edge.
    static func tileImage(_ canvas: CGImage, x: Int, y: Int) -> CGImage? {
        let width = min(512, canvas.width - x)
        let height = min(512, canvas.height - y)
        guard let part = canvas.cropping(to: CGRect(x: x, y: y, width: width, height: height)),
              let space = CGColorSpace(name: CGColorSpace.sRGB),
              let context = CGContext(data: nil, width: 512, height: 512, bitsPerComponent: 8,
                                      bytesPerRow: 0, space: space,
                                      bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return nil }
        context.setFillColor(CGColor(gray: 0, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: 512, height: 512))
        // Core Graphics counts y from the bottom: the tile's top row goes at the top.
        context.draw(part, in: CGRect(x: 0, y: 512 - height, width: width, height: height))
        return context.makeImage()
    }

    struct EncodedImage {
        let sample: Bytes
        let hvcC: Bytes
        let colr: Bytes?
        let pixi: Bytes?
    }

    /// Encode with ImageIO and take the HEVC sample and its properties out of the result.
    static func encode(_ image: CGImage) throws -> EncodedImage {
        let output = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(
            output, UTType.heic.identifier as CFString, 1, nil) else {
            throw StylePortError.invalidData("This device can't encode HEIC.")
        }
        CGImageDestinationAddImage(destination, image, [
            kCGImageDestinationLossyCompressionQuality: 0.92,
            kCGImageDestinationEmbedThumbnail: false
        ] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else {
            throw StylePortError.invalidData("HEIC encoding failed.")
        }
        let data = (output as Data).stylePortBytes
        let meta = try topBox(data, type: "meta")
        var item = try HEIF.parsePrimaryItem(data, meta: meta)
        let infos = try HEIF.parseItemInfo(data, meta: meta)
        if infos[item]?.type == "grid" {
            // A grid of one tile: its tile carries the HEVC data.
            let references = try HEIF.parseReferences(data, meta: meta)
            guard let tile = references.first(where: { $0.type == "dimg" && $0.from == item })?.to.first else {
                throw StylePortError.invalidData("Unexpected HEIC layout from the encoder.")
            }
            item = tile
        }
        let locations = try HEIF.parseLocations(data, meta: meta)
        let properties = try HEIF.parseProperties(data, meta: meta)
        guard let hvcC = try HEIF.propertyBytes(data, table: properties, itemID: item, type: "hvcC") else {
            throw StylePortError.invalidData("The encoder wrote no hvcC.")
        }
        return EncodedImage(
            sample: try HEIF.extractItem(data, locations: locations, itemID: item),
            hvcC: hvcC,
            colr: try HEIF.propertyBytes(data, table: properties, itemID: item, type: "colr"),
            pixi: try HEIF.propertyBytes(data, table: properties, itemID: item, type: "pixi")
        )
    }

    static let emptyAppleMakerNote: Bytes = Bytes("Apple iOS".utf8) + [0, 0, 1] + Bytes("MM".utf8) + [0, 0, 0, 0, 0, 0]

    /// The TIFF block of a JPEG (APP1 Exif), PNG (eXIf), WebP (EXIF) or HEIF (Exif item) file.
    static func sourceTIFF(in data: Bytes) -> Bytes? {
        if data.starts(with: [0xFF, 0xD8]) {
            var cursor = 2
            while cursor + 4 <= data.count, data[cursor] == 0xFF {
                let marker = data[cursor + 1]
                if marker == 0xDA || marker == 0xD9 { break }   // image data: no more metadata
                let length = Int(data[cursor + 2]) << 8 | Int(data[cursor + 3])
                let start = cursor + 4
                guard length >= 2, start + length - 2 <= data.count else { break }
                if marker == 0xE1, length >= 8, Array(data[start..<start + 6]) == Bytes("Exif".utf8) + [0, 0] {
                    return Array(data[(start + 6)..<(start + length - 2)])
                }
                cursor = start + length - 2
            }
            return nil
        }
        if data.starts(with: [0x89, 0x50, 0x4E, 0x47]) {
            var cursor = 8
            while cursor + 12 <= data.count {
                let length = (try? readUInt(data, cursor, 4)) ?? 0
                let type = String(bytes: data[(cursor + 4)..<(cursor + 8)], encoding: .ascii)
                guard cursor + 12 + length <= data.count else { break }
                if type == "eXIf" { return Array(data[(cursor + 8)..<(cursor + 8 + length)]) }
                cursor += 12 + length
            }
            return nil
        }
        if data.count >= 12, data.starts(with: Bytes("RIFF".utf8)), Array(data[8..<12]) == Bytes("WEBP".utf8) {
            var cursor = 12
            while cursor + 8 <= data.count {
                let size = (0..<4).reduce(0) { $0 | Int(data[cursor + 4 + $1]) << (8 * $1) }
                guard cursor + 8 + size <= data.count else { break }
                if Array(data[cursor..<(cursor + 4)]) == Bytes("EXIF".utf8) {
                    var tiff = Array(data[(cursor + 8)..<(cursor + 8 + size)])
                    if tiff.starts(with: Bytes("Exif".utf8) + [0, 0]) { tiff.removeFirst(6) }
                    return tiff
                }
                cursor += 8 + size + (size & 1)
            }
            return nil
        }
        // HEIF: the Exif item is a 4-byte offset to the TIFF header, then the TIFF.
        guard let meta = try? topBox(data, type: "meta"),
              let infos = try? HEIF.parseItemInfo(data, meta: meta),
              let item = infos.first(where: { $0.value.type == "Exif" })?.key,
              let locations = try? HEIF.parseLocations(data, meta: meta),
              let payload = try? HEIF.extractItem(data, locations: locations, itemID: item),
              payload.count > 8, let skip = try? readUInt(payload, 0, 4), 4 + skip < payload.count else { return nil }
        var tiff = Array(payload[(4 + skip)...])
        if tiff.starts(with: Bytes("Exif".utf8) + [0, 0]) { tiff.removeFirst(6) }
        return tiff
    }

    /// The source's own Exif for the converted HEIC, as the CLI does: everything stays byte for
    /// byte where it is, and a rewritten IFD0 and ExifIFD are appended (upright orientation,
    /// the new pixel size, an empty Apple MakerNote when there is none). nil when unreadable.
    static func carryExif(tiff: Bytes, width: Int, height: Int) -> Bytes? {
        guard tiff.count >= 8 else { return nil }
        let little: Bool
        switch (tiff[0], tiff[1]) {
        case (0x49, 0x49): little = true
        case (0x4D, 0x4D): little = false
        default: return nil
        }
        func read(_ bytes: Bytes, _ offset: Int, _ count: Int) -> Int {
            var value = 0
            for index in 0..<count {
                let byte = Int(bytes[offset + (little ? count - 1 - index : index)])
                value = value << 8 | byte
            }
            return value
        }
        func write(_ value: Int, _ count: Int) -> Bytes {
            let big = bigEndianBytes(value, count: count)
            return little ? big.reversed() : big
        }
        guard read(tiff, 2, 2) == 42 else { return nil }
        func readIFD(_ offset: Int) -> [Int: Bytes]? {
            guard offset >= 8, offset + 2 <= tiff.count else { return nil }
            let count = read(tiff, offset, 2)
            guard offset + 2 + 12 * count + 4 <= tiff.count else { return nil }
            var entries: [Int: Bytes] = [:]
            for index in 0..<count {
                let start = offset + 2 + 12 * index
                entries[read(tiff, start, 2)] = Array(tiff[start..<(start + 12)])
            }
            return entries
        }
        guard var ifd0 = readIFD(read(tiff, 4, 4)) else { return nil }
        var exif: [Int: Bytes] = [:]
        if let pointer = ifd0[0x8769] {
            guard let found = readIFD(read(pointer, 8, 4)) else { return nil }
            exif = found
        }
        var out = tiff
        func append(_ blob: Bytes) -> Int {
            if out.count % 2 == 1 { out.append(0) }
            let offset = out.count
            out += blob
            return offset
        }
        func entry(_ tag: Int, _ type: Int, _ count: Int, _ value: Bytes) -> Bytes {
            write(tag, 2) + write(type, 2) + write(count, 4) + value
        }
        var apple = false
        if let maker = exif[0x927C] {
            let count = read(maker, 4, 4)
            let offset = read(maker, 8, 4)
            apple = count > 20 && offset + 9 <= tiff.count
                && Array(tiff[offset..<(offset + 9)]) == Bytes("Apple iOS".utf8)
        }
        if !apple {
            exif[0x927C] = entry(0x927C, 7, emptyAppleMakerNote.count, write(append(emptyAppleMakerNote), 4))
        }
        exif[0xA002] = entry(0xA002, 4, 1, write(width, 4))
        exif[0xA003] = entry(0xA003, 4, 1, write(height, 4))
        ifd0[0x0112] = entry(0x0112, 3, 1, write(1, 2) + [0, 0])   // the pixels are upright now
        for (tag, value) in [(0x0100, width), (0x0101, height)] where ifd0[tag] != nil {
            ifd0[tag] = entry(tag, 4, 1, write(value, 4))
        }
        func ifdBytes(_ entries: [Int: Bytes]) -> Bytes {
            write(entries.count, 2) + concatenated(entries.keys.sorted().map { entries[$0]! }) + [0, 0, 0, 0]
        }
        ifd0[0x8769] = entry(0x8769, 4, 1, write(append(ifdBytes(exif)), 4))
        let ifd0Offset = append(ifdBytes(ifd0))
        out.replaceSubrange(4..<8, with: write(ifd0Offset, 4))
        return [0, 0, 0, 6] + Bytes("Exif".utf8) + [0, 0] + out
    }

    /// A minimal big-endian Exif with an empty Apple MakerNote, which the port gives the 0x54
    /// Photographic Style record. Keeps the capture date when there is one.
    static func appleExif(width: Int, height: Int, date: Date?) -> Bytes {
        let maker = emptyAppleMakerNote
        var entries: [(tag: Int, type: Int, count: Int, value: Bytes)] = []
        if let date {
            let formatter = DateFormatter()
            formatter.locale = Locale(identifier: "en_US_POSIX")
            formatter.dateFormat = "yyyy:MM:dd HH:mm:ss"
            entries.append((0x9003, 2, 20, Bytes(formatter.string(from: date).utf8.prefix(19)) + [0]))
        }
        entries.append((0x927C, 7, maker.count, maker))
        entries.append((0xA002, 4, 1, bigEndianBytes(width, count: 4)))
        entries.append((0xA003, 4, 1, bigEndianBytes(height, count: 4)))
        let ifd0 = 8
        let exifIFD = ifd0 + 2 + 12 + 4
        let dataStart = exifIFD + 2 + 12 * entries.count + 4
        var tiff: Bytes = Bytes("MM".utf8) + [0, 42] + bigEndianBytes(ifd0, count: 4)
        tiff += bigEndianBytes(1, count: 2) + bigEndianBytes(0x8769, count: 2) + bigEndianBytes(4, count: 2)
            + bigEndianBytes(1, count: 4) + bigEndianBytes(exifIFD, count: 4) + [0, 0, 0, 0]
        var table: Bytes = []
        var area: Bytes = []
        for entry in entries {
            table += bigEndianBytes(entry.tag, count: 2) + bigEndianBytes(entry.type, count: 2)
                + bigEndianBytes(entry.count, count: 4)
            if entry.value.count <= 4 {
                table += entry.value + Bytes(repeating: 0, count: 4 - entry.value.count)
            } else {
                table += bigEndianBytes(dataStart + area.count, count: 4)
                area += entry.value + (entry.value.count % 2 == 1 ? [0] : [])
            }
        }
        tiff += bigEndianBytes(entries.count, count: 2) + table + [0, 0, 0, 0] + area
        return [0, 0, 0, 6] + Bytes("Exif".utf8) + [0, 0] + tiff
    }

    private static func fullBox(_ type: String, _ payload: Bytes, version: UInt8 = 0) -> Bytes {
        makeBox(type, payload: [version, 0, 0, 0] + payload)
    }

    private static func itemInfo(_ itemID: Int, type: String, hidden: Bool) -> Bytes {
        makeBox("infe", payload: [2, 0, 0, hidden ? 1 : 0] + bigEndianBytes(itemID, count: 2) + [0, 0]
                + Bytes(type.utf8) + [0])
    }

    private static func association(_ itemID: Int, _ properties: [(Int, Bool)]) -> Bytes {
        bigEndianBytes(itemID, count: 2) + [UInt8(properties.count)]
            + properties.map { UInt8($0.0 & 0x7F) | ($0.1 ? 0x80 : 0) }
    }

    /// ftyp + meta + mdat for the tile grid, thumbnail and Exif, laid out the way the porter's
    /// parser and rebuild expect (iloc v1, 4-byte offsets, grid descriptor in idat).
    static func assemble(width: Int, height: Int, tiles: [EncodedImage], thumbnail: EncodedImage,
                         thumbnailSize: (Int, Int), exif: Bytes) -> Bytes {
        let columns = (width + 511) / 512
        let rows = (height + 511) / 512
        let primary = 1
        let tileIDs = Array(2..<(2 + tiles.count))
        let thumbnailID = tileIDs.last! + 1
        let exifID = thumbnailID + 1

        // The encoder's own colour description, which matches how it encoded the samples.
        let colr = tiles.first?.colr ?? makeBox("colr", payload: Bytes("nclx".utf8) + [0, 1, 0, 13, 0, 1, 0x80])
        let pixi = tiles.first?.pixi ?? makeBox("pixi", payload: [0, 0, 0, 0, 3, 8, 8, 8])
        var properties: [Bytes] = [colr, pixi, HEIF.dimensionsBox(width: 512, height: 512),
                                   HEIF.dimensionsBox(width: width, height: height), thumbnail.hvcC,
                                   HEIF.dimensionsBox(width: thumbnailSize.0, height: thumbnailSize.1)]
        let (colrIndex, pixiIndex, tileSizeIndex, primarySizeIndex, thumbHvcCIndex, thumbSizeIndex) = (1, 2, 3, 4, 5, 6)
        var hvcCIndex: [Bytes: Int] = [:]
        var tileHvcC: [Int] = []
        for tile in tiles {
            if hvcCIndex[tile.hvcC] == nil {
                properties.append(tile.hvcC)
                hvcCIndex[tile.hvcC] = properties.count
            }
            tileHvcC.append(hvcCIndex[tile.hvcC]!)
        }
        var associations = [association(primary, [(primarySizeIndex, false), (colrIndex, false), (pixiIndex, false)])]
        for (index, itemID) in tileIDs.enumerated() {
            associations.append(association(itemID, [(tileHvcC[index], true), (tileSizeIndex, false),
                                                     (colrIndex, false), (pixiIndex, false)]))
        }
        associations.append(association(thumbnailID, [(thumbHvcCIndex, true), (thumbSizeIndex, false),
                                                       (colrIndex, false), (pixiIndex, false)]))
        let ipma = fullBox("ipma", bigEndianBytes(associations.count, count: 4) + concatenated(associations))
        let iprp = makeBox("iprp", payload: makeBox("ipco", payload: concatenated(properties)) + ipma)

        let infos = [itemInfo(primary, type: "grid", hidden: false)]
            + tileIDs.map { itemInfo($0, type: "hvc1", hidden: true) }
            + [itemInfo(thumbnailID, type: "hvc1", hidden: false), itemInfo(exifID, type: "Exif", hidden: true)]
        let iinf = fullBox("iinf", bigEndianBytes(infos.count, count: 2) + concatenated(infos))
        let iref = fullBox("iref", HEIF.referenceBox(type: "dimg", from: primary, targets: tileIDs)
                           + HEIF.referenceBox(type: "thmb", from: thumbnailID, targets: [primary])
                           + HEIF.referenceBox(type: "cdsc", from: exifID, targets: [primary]))
        let grid: Bytes = [0, 0, UInt8(rows - 1), UInt8(columns - 1)]
            + bigEndianBytes(width, count: 2) + bigEndianBytes(height, count: 2)
        let payloads: [(Int, Bytes)] = zip(tileIDs, tiles).map { ($0, $1.sample) }
            + [(thumbnailID, thumbnail.sample), (exifID, exif)]

        func meta(offsets: [Int: Int]) -> Bytes {
            var entries: [Bytes] = [bigEndianBytes(primary, count: 2) + [0, 1, 0, 0] + bigEndianBytes(1, count: 2)
                                    + bigEndianBytes(0, count: 4) + bigEndianBytes(grid.count, count: 4)]
            for (itemID, blob) in payloads {
                entries.append(bigEndianBytes(itemID, count: 2) + [0, 0, 0, 0] + bigEndianBytes(1, count: 2)
                               + bigEndianBytes(offsets[itemID] ?? 0, count: 4) + bigEndianBytes(blob.count, count: 4))
            }
            let iloc = fullBox("iloc", [0x44, 0x00] + bigEndianBytes(entries.count, count: 2) + concatenated(entries),
                               version: 1)
            let hdlr = fullBox("hdlr", Bytes(repeating: 0, count: 4) + Bytes("pict".utf8) + Bytes(repeating: 0, count: 13))
            let pitm = fullBox("pitm", bigEndianBytes(primary, count: 2))
            return fullBox("meta", hdlr + pitm + iloc + iinf + iref + iprp + makeBox("idat", payload: grid))
        }

        let ftyp = makeBox("ftyp", payload: Bytes("heic".utf8) + [0, 0, 0, 0] + Bytes("mif1MiHEMiPrmiafMiHBheic".utf8))
        var cursor = ftyp.count + meta(offsets: [:]).count + 8
        var offsets: [Int: Int] = [:]
        for (itemID, blob) in payloads {
            offsets[itemID] = cursor
            cursor += blob.count
        }
        let body = concatenated(payloads.map(\.1))
        return ftyp + meta(offsets: offsets) + bigEndianBytes(8 + body.count, count: 4) + Bytes("mdat".utf8) + body
    }
}
