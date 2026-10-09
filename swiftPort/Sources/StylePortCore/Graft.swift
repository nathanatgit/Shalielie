import Foundation

// v0.6.2: the style items go into the photo's OWN item graph. Port of graft_style_graph /
// rebuild_heic in photographic_style_port.py via web/src/graft.js; every step runs in the
// same order with the same bytes, so all three builds write identical files.
//
// Native style files differ from an iPhone 15 photo only by a linear thumbnail, a
// StyleDeltaMap grid, the styles item, MakerNote 0x54 and two ftyp brands; tiles, HDR, tmap,
// Exif, mattes, depth and sidecars are the photo's own already. So those are added and
// nothing else moves, and any tile layout works as long as the StyleDeltaMap size is known.
enum Graft {
    static let styleBrands = ["MiHA", "heix"]
    /// StyleDeltaMap size per primary size (stored orientation), as native files have it.
    /// 48 MP natives tile their 5760x4320 map 640x896; 512x512 tiles trimmed by the grid
    /// cover it equally, and reuse the one neutral tile.
    static let styleDeltaSizes: [(Int, Int, Int, Int)] = [
        (4032, 3024, 2880, 2160), (5712, 4284, 4096, 3072), (3088, 2316, 2240, 1680),
        (8064, 6048, 5760, 4320)
    ]

    struct LinearThumbnail {
        let sample: Bytes
        let hvcC: Bytes
        let ispe: Bytes
        let pixi: Bytes
    }

    /// StyleDeltaMap size for a primary of this stored size, or nil when none is known.
    static func styleDeltaSize(width: Int?, height: Int?) -> (Int, Int)? {
        guard let width, let height else { return nil }
        for (w, h, dw, dh) in styleDeltaSizes {
            if w == width && h == height { return (dw, dh) }
            if h == width && w == height { return (dh, dw) }
        }
        return nil
    }

    /// Add MiHA and heix right after MiHB, where native style files list them.
    static func ftypWithStyleBrands(_ ftyp: Bytes) throws -> Bytes {
        var brands: [String] = []
        for offset in stride(from: 16, to: ftyp.count, by: 4) {
            brands.append(try fourCC(ftyp, at: offset))
        }
        let missing = styleBrands.filter { !brands.contains($0) }
        guard !missing.isEmpty else { return ftyp }
        let at = brands.firstIndex(of: "MiHB").map { $0 + 1 } ?? brands.count
        let ordered = Array(brands[..<at]) + missing + Array(brands[at...])
        return makeBox("ftyp", payload: concatenated(
            [try byteSlice(ftyp, 8, 8)] + ordered.map { Bytes($0.utf8) }
        ))
    }

    /// Write a new ftyp + meta in front of the photo's own payloads. Untouched payloads stay
    /// byte for byte where they were, moved only by the header growth; items in `payloads`
    /// go into one mdat appended at the end.
    static func rebuild(
        _ data: Bytes,
        discovery: HEIF.Discovery,
        ftyp: Bytes,
        meta: Bytes,
        payloads: [Int: Bytes]
    ) throws -> Bytes {
        let fileType = try topBox(data, type: "ftyp")
        let metaOffset = discovery.meta.offset
        let metaSize = discovery.meta.size
        guard fileType.offset == 0, metaOffset >= fileType.size else {
            throw StylePortError.invalidData("Expected ftyp first and meta after it.")
        }
        let old = discovery.locations.items
        for location in old.values where location.constructionMethod == 0 {
            for extent in location.extents where extent.offset < metaOffset + metaSize {
                throw StylePortError.invalidData("An item payload sits before the end of meta.")
            }
        }
        let shift = (ftyp.count - fileType.size) + (meta.count - metaSize)
        let head = ftyp + Array(data[fileType.size..<metaOffset])
        let tail = Array(data[(metaOffset + metaSize)...])
        var outputMeta = meta
        let newLocations = try HEIF.parseLocations(outputMeta, meta: topBox(outputMeta, type: "meta"))
        guard newLocations.offsetSize == 4, newLocations.lengthSize == 4 else {
            throw StylePortError.invalidData("Unsupported iloc layout.")
        }
        let cursor = head.count + outputMeta.count + tail.count + 8
        var extra = Bytes()
        for itemID in newLocations.items.keys.sorted() {
            guard let location = newLocations.items[itemID], location.constructionMethod == 0,
                  !location.extents.isEmpty else { continue }
            if let payload = payloads[itemID] {
                guard location.extents.count == 1 else {
                    throw StylePortError.invalidData("Item \(itemID) is not single-extent.")
                }
                let extent = location.extents[0]
                try writeBytes(
                    bigEndianBytes(cursor + extra.count, count: 4),
                    into: &outputMeta,
                    at: extent.offsetPosition
                )
                try writeBytes(
                    bigEndianBytes(payload.count, count: 4),
                    into: &outputMeta,
                    at: extent.lengthPosition
                )
                extra += payload
            } else if let original = old[itemID] {
                for (extent, oldExtent) in zip(location.extents, original.extents) {
                    try writeBytes(
                        bigEndianBytes(oldExtent.offset + shift, count: 4),
                        into: &outputMeta,
                        at: extent.offsetPosition
                    )
                }
            }
        }
        guard cursor + extra.count < 1 << 32 else {
            throw StylePortError.invalidData("File too large for 32-bit offsets.")
        }
        var parts = [head, outputMeta, tail]
        if !extra.isEmpty {
            parts += [bigEndianBytes(8 + extra.count, count: 4), Bytes("mdat".utf8), extra]
        }
        let result = concatenated(parts)

        // Self-check: every untouched payload re-extracts byte-identical, every new one as written.
        let check = try HEIF.discover(result)
        for (itemID, location) in old where location.constructionMethod == 0 && payloads[itemID] == nil {
            guard try HEIF.extractItem(result, locations: check.locations, itemID: itemID)
                    == HEIF.extractItem(data, locations: discovery.locations, itemID: itemID) else {
                throw StylePortError.invalidData("Self-check failed: item \(itemID) changed.")
            }
        }
        for (itemID, payload) in payloads {
            guard try HEIF.extractItem(result, locations: check.locations, itemID: itemID)
                    == payload else {
                throw StylePortError.invalidData("Self-check failed: item \(itemID) unreadable.")
            }
        }
        return result
    }

    /// graft_style_graph: the photo plus the style items. Returns the bytes, the
    /// StyleDeltaMap geometry and the Texture/Grain summary.
    static func graftStyleGraph(
        _ data: Bytes,
        discovery: HEIF.Discovery,
        styles: Bytes,
        makerNote54: Bytes,
        makerNoteType: Int,
        linearThumbnail: LinearThumbnail,
        texture: Bool
    ) throws -> (Bytes, [Int], String) {
        let properties = discovery.properties
        let primary = discovery.primary
        let dimensions = HEIF.dimensions(properties, itemID: primary)
        guard let size = styleDeltaSize(width: dimensions.0, height: dimensions.1),
              let exifItem = discovery.exifItem else {
            throw StylePortError.unsupportedPhoto
        }
        let (deltaWidth, deltaHeight) = size
        let columns = (deltaWidth + 511) / 512
        let rows = (deltaHeight + 511) / 512
        let rotation = HEIF.property(properties, itemID: primary, type: "irot")
            .map { [($0.index, true)] } ?? []
        let targets = [primary] + HEIF.items(ofType: "tmap", in: discovery.infos).prefix(1)
        var meta = try byteSlice(data, discovery.meta.offset, discovery.meta.size)
        guard try HEIF.parseProperties(meta, meta: topBox(meta, type: "meta")).flags & 1 == 0 else {
            throw StylePortError.invalidData("Wide ipma is not supported.")
        }

        // Properties, appended so no existing index moves; associated in native order.
        func append(_ box: Bytes) throws -> Int {
            let appended = try HEIF.appendProperty(in: meta, box: box)
            meta = appended.0
            return appended.1
        }
        let colorIndex = try append(AppleBytes.styleDeltaColr)
        let pixiIndex = try append(AppleBytes.stylePixi10bit)
        let deltaISPE = try append(HEIF.dimensionsBox(width: deltaWidth, height: deltaHeight))
        let deltaAuxC = try append(HEIF.auxiliaryTypeBox(HEIF.styleDeltaURI))
        let tileISPE = try append(HEIF.dimensionsBox(width: 512, height: 512))
        let tileHVCC = try append(AppleBytes.neutralDeltaHvcc)
        let linearISPE = try append(linearThumbnail.ispe)
        var linearPixi = pixiIndex
        if linearThumbnail.pixi != AppleBytes.stylePixi10bit {
            linearPixi = try append(linearThumbnail.pixi)
        }
        let linearAuxC = try append(HEIF.auxiliaryTypeBox(HEIF.linearThumbnailURI))
        let linearHVCC = try append(linearThumbnail.hvcC)

        let linear = try HEIF.addItems(to: meta, specs: [HEIF.ItemSpec(
            key: "lt",
            uri: nil,
            referenceType: "auxl",
            referenceTargets: targets,
            reusedProperties: [(linearISPE, false)] + rotation
                + [(linearPixi, false), (linearAuxC, true), (linearHVCC, true)]
        )])
        meta = linear.0
        let tiles = try HEIF.addItems(to: meta, specs: (0..<(rows * columns)).map {
            HEIF.ItemSpec(
                key: "t\($0)",
                uri: nil,
                reusedProperties: [(tileISPE, true), (colorIndex, true), (tileHVCC, true)]
            )
        })
        meta = tiles.0
        let tileIDs = (0..<(rows * columns)).map { tiles.1["t\($0)"]! }
        let grid = try HEIF.addItems(to: meta, specs: [HEIF.ItemSpec(
            key: "grid",
            uri: nil,
            itemType: "grid",
            referenceType: "auxl",
            referenceTargets: targets,
            reusedProperties: [(colorIndex, true), (deltaISPE, false)] + rotation
                + [(pixiIndex, false), (deltaAuxC, true)]
        )])
        meta = grid.0
        let gridID = grid.1["grid"]!
        meta = try HEIF.appendReference(
            in: meta,
            box: HEIF.referenceBox(type: "dimg", from: gridID, targets: tileIDs)
        )
        // ImageGrid descriptor: version 0, 16-bit sizes, rows-1, columns-1, width, height.
        meta = try HEIF.moveItemToIdat(
            in: meta,
            itemID: gridID,
            payload: [0, 0, UInt8(rows - 1), UInt8(columns - 1)]
                + bigEndianBytes(deltaWidth, count: 2) + bigEndianBytes(deltaHeight, count: 2)
        )
        let stylesItem = try HEIF.addItems(to: meta, specs: [HEIF.ItemSpec(
            key: "styles",
            uri: nil,
            itemType: "uri ",
            itemName: "metadata",
            contentType: HEIF.stylesURI,
            referenceType: "cdsc",
            referenceTargets: targets
        )])
        meta = stylesItem.0

        var payloads: [Int: Bytes] = [
            linear.1["lt"]!: linearThumbnail.sample,
            stylesItem.1["styles"]!: styles,
            exifItem: try AppleExif.injectMakerNoteTag(
                into: HEIF.extractItem(data, locations: discovery.locations, itemID: exifItem),
                payload: makerNote54,
                type: makerNoteType
            )
        ]
        for tile in tileIDs { payloads[tile] = AppleBytes.neutralDeltaSample }
        var textureSummary = "off"
        if texture {
            let added = try Texture.addItems(
                to: meta,
                primary: primary,
                people: Texture.softSkinPeople(data, discovery),
                grainSeed: Texture.filmGrainSeed(data, discovery)
            )
            meta = added.0
            payloads.merge(added.1) { _, new in new }
            textureSummary = added.2
        }
        let fileType = try topBox(data, type: "ftyp")
        let ftyp = try ftypWithStyleBrands(byteSlice(data, 0, fileType.size))
        return (
            try rebuild(data, discovery: discovery, ftyp: ftyp, meta: meta, payloads: payloads),
            [deltaWidth, deltaHeight, rows, columns],
            textureSummary
        )
    }
}
