import Foundation

enum HEIF {
    static let hdrGainURI = "urn:com:apple:photo:2020:aux:hdrgainmap"
    static let linearThumbnailURI = "tag:apple.com,2023:photo:aux:linearthumbnail"
    static let styleDeltaURI = "tag:apple.com,2023:photo:aux:styledeltamap"
    static let stylesURI = "tag:apple.com,2023:photo:metadata:styles"
    static let depthURI = "urn:mpeg:hevc:2015:auxid:2"

    static let matteURIs: [String: String] = [
        "portraiteffectsmatte": "urn:com:apple:photo:2018:aux:portraiteffectsmatte",
        "semanticskinmatte": "urn:com:apple:photo:2019:aux:semanticskinmatte",
        "semantichairmatte": "urn:com:apple:photo:2019:aux:semantichairmatte",
        "semanticteethmatte": "urn:com:apple:photo:2019:aux:semanticteethmatte",
        "semanticglassesmatte": "urn:com:apple:photo:2020:aux:semanticglassesmatte",
        "semanticskymatte": "urn:com:apple:photo:2020:aux:semanticskymatte"
    ]
    static let matteURISet = Set(matteURIs.values)
    static let identityRotation = makeBox("irot", payload: [0])

    static let tiffTypeSizes: [Int: Int] = [
        1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1,
        7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8
    ]

    struct Extent {
        let offset: Int
        let length: Int
        let offsetPosition: Int
        let lengthPosition: Int
    }

    struct Location {
        let constructionMethod: Int
        let baseOffset: Int
        let extents: [Extent]
    }

    struct LocationTable {
        let box: ISOBox
        let version: Int
        let offsetSize: Int
        let lengthSize: Int
        let baseOffsetSize: Int
        let indexSize: Int
        let items: [Int: Location]
    }

    struct ItemInfo {
        let type: String
        let name: String
        let uri: String?
        let contentType: String?
    }

    struct Reference {
        let type: String
        let from: Int
        let to: [Int]
    }

    struct PropertyAssociation {
        let index: Int
        let essential: Bool
    }

    struct Property {
        let index: Int
        let type: String
        let box: ISOBox
        let auxiliaryURI: String?
        let width: Int?
        let height: Int?
    }

    struct PropertyTable {
        let iprpBox: ISOBox
        let ipcoBox: ISOBox
        let ipmaBox: ISOBox
        let properties: [Property]
        let associations: [Int: [PropertyAssociation]]
        let version: Int
        let flags: Int
    }

    struct Discovery {
        let meta: ISOBox
        let locations: LocationTable
        let infos: [Int: ItemInfo]
        let references: [Reference]
        let properties: PropertyTable
        let primary: Int
        let primaryTiles: [Int]
        let thumbnail: Int?
        let hdrGrid: Int?
        let hdrTiles: [Int]
        let linearThumbnail: Int?
        let deltaGrid: Int?
        let deltaTiles: [Int]
        let stylesItem: Int?
        let exifItem: Int?
    }

    struct ItemSpec {
        var key: String
        var uri: String?
        var itemType: String = "hvc1"
        var contentType: String?
        var referenceType: String = "auxl"
        var referenceTargets: [Int] = []
        var reusedProperties: [(Int, Bool)] = []
        var boxes: [Bytes] = []
        var auxiliaryBox: Bytes?
    }

    static func parsePrimaryItem(_ data: Bytes, meta: ISOBox) throws -> Int {
        let box = try findChild(metaChildren(data, meta: meta), type: "pitm")
        let version = Int(data[box.offset + box.headerSize])
        return try readUInt(data, box.offset + box.headerSize + 4, version == 0 ? 2 : 4)
    }

    static func parseLocations(_ data: Bytes, meta: ISOBox) throws -> LocationTable {
        let box = try findChild(metaChildren(data, meta: meta), type: "iloc")
        var cursor = box.offset + box.headerSize
        let version = Int(data[cursor])
        cursor += 4
        let first = data[cursor]
        let second = data[cursor + 1]
        cursor += 2
        let offsetSize = Int(first >> 4)
        let lengthSize = Int(first & 0x0f)
        let baseOffsetSize = Int(second >> 4)
        let indexSize = version == 1 || version == 2 ? Int(second & 0x0f) : 0
        let itemCountSize = version < 2 ? 2 : 4
        let itemCount = try readUInt(data, cursor, itemCountSize)
        cursor += itemCountSize
        var items: [Int: Location] = [:]

        for _ in 0..<itemCount {
            let itemIDSize = version < 2 ? 2 : 4
            let itemID = try readUInt(data, cursor, itemIDSize)
            cursor += itemIDSize
            var constructionMethod = 0
            if version == 1 || version == 2 {
                constructionMethod = try readUInt(data, cursor, 2) & 0x0f
                cursor += 2
            }
            cursor += 2
            let baseOffset = baseOffsetSize > 0 ? try readUInt(data, cursor, baseOffsetSize) : 0
            cursor += baseOffsetSize
            let extentCount = try readUInt(data, cursor, 2)
            cursor += 2
            var extents: [Extent] = []
            for _ in 0..<extentCount {
                if (version == 1 || version == 2) && indexSize > 0 { cursor += indexSize }
                let offsetPosition = cursor
                let extentOffset = offsetSize > 0 ? try readUInt(data, cursor, offsetSize) : 0
                cursor += offsetSize
                let lengthPosition = cursor
                let extentLength = lengthSize > 0 ? try readUInt(data, cursor, lengthSize) : 0
                cursor += lengthSize
                extents.append(Extent(
                    offset: extentOffset,
                    length: extentLength,
                    offsetPosition: offsetPosition,
                    lengthPosition: lengthPosition
                ))
            }
            items[itemID] = Location(
                constructionMethod: constructionMethod,
                baseOffset: baseOffset,
                extents: extents
            )
        }
        return LocationTable(
            box: box,
            version: version,
            offsetSize: offsetSize,
            lengthSize: lengthSize,
            baseOffsetSize: baseOffsetSize,
            indexSize: indexSize,
            items: items
        )
    }

    static func extractItem(_ data: Bytes, locations: LocationTable, itemID: Int) throws -> Bytes {
        guard let item = locations.items[itemID] else {
            throw StylePortError.invalidData("No iloc entry for item \(itemID).")
        }
        guard item.constructionMethod == 0 else {
            throw StylePortError.invalidData(
                "Item \(itemID) uses construction_method=\(item.constructionMethod)."
            )
        }
        return try concatenated(item.extents.map {
            try byteSlice(data, item.baseOffset + $0.offset, $0.length)
        })
    }

    static func parseItemInfo(_ data: Bytes, meta: ISOBox) throws -> [Int: ItemInfo] {
        let box = try findChild(metaChildren(data, meta: meta), type: "iinf")
        let version = Int(data[box.offset + box.headerSize])
        let start = box.offset + box.headerSize + 4 + (version == 0 ? 2 : 4)
        var result: [Int: ItemInfo] = [:]
        for entry in try siblingBoxes(data, from: start, to: box.offset + box.size) {
            guard entry.type == "infe" else { continue }
            var cursor = entry.offset + entry.headerSize
            let itemVersion = Int(data[cursor])
            cursor += 4
            guard itemVersion == 2 || itemVersion == 3 else { continue }
            let itemIDSize = itemVersion == 2 ? 2 : 4
            let itemID = try readUInt(data, cursor, itemIDSize)
            cursor += itemIDSize + 2
            let itemType = try fourCC(data, at: cursor)
            cursor += 4
            let (name, next) = try cString(data, from: cursor, to: entry.offset + entry.size)
            var uri: String?
            var contentType: String?
            if itemType == "mime" {
                contentType = try cString(data, from: next, to: entry.offset + entry.size).0
            } else if itemType == "uri " {
                uri = try cString(data, from: next, to: entry.offset + entry.size).0
            }
            result[itemID] = ItemInfo(
                type: itemType,
                name: name,
                uri: uri,
                contentType: contentType
            )
        }
        return result
    }

    static func parseReferences(_ data: Bytes, meta: ISOBox) throws -> [Reference] {
        let box = try findChild(metaChildren(data, meta: meta), type: "iref")
        let version = Int(data[box.offset + box.headerSize])
        let itemIDSize = version == 0 ? 2 : 4
        var result: [Reference] = []
        let entries = try siblingBoxes(
            data,
            from: box.offset + box.headerSize + 4,
            to: box.offset + box.size
        )
        for entry in entries {
            var cursor = entry.offset + entry.headerSize
            let from = try readUInt(data, cursor, itemIDSize)
            cursor += itemIDSize
            let count = try readUInt(data, cursor, 2)
            cursor += 2
            var targets: [Int] = []
            for _ in 0..<count {
                targets.append(try readUInt(data, cursor, itemIDSize))
                cursor += itemIDSize
            }
            result.append(Reference(type: entry.type, from: from, to: targets))
        }
        return result
    }

    static func parseProperties(_ data: Bytes, meta: ISOBox? = nil) throws -> PropertyTable {
        let metaBox: ISOBox
        if let meta {
            metaBox = meta
        } else {
            metaBox = try topBox(data, type: "meta")
        }
        let iprp = try findChild(metaChildren(data, meta: metaBox), type: "iprp")
        let iprpChildren = try siblingBoxes(
            data,
            from: iprp.offset + iprp.headerSize,
            to: iprp.offset + iprp.size
        )
        let ipco = try findChild(iprpChildren, type: "ipco")
        let ipma = try findChild(iprpChildren, type: "ipma")
        var properties: [Property] = []
        let boxes = try siblingBoxes(
            data,
            from: ipco.offset + ipco.headerSize,
            to: ipco.offset + ipco.size
        )
        for (zeroIndex, box) in boxes.enumerated() {
            var auxiliaryURI: String?
            var width: Int?
            var height: Int?
            if box.type == "auxC" {
                auxiliaryURI = try cString(
                    data,
                    from: box.offset + box.headerSize + 4,
                    to: box.offset + box.size
                ).0
            } else if box.type == "ispe" {
                width = try readUInt(data, box.offset + box.headerSize + 4, 4)
                height = try readUInt(data, box.offset + box.headerSize + 8, 4)
            }
            properties.append(Property(
                index: zeroIndex + 1,
                type: box.type,
                box: box,
                auxiliaryURI: auxiliaryURI,
                width: width,
                height: height
            ))
        }

        var cursor = ipma.offset + ipma.headerSize
        let version = Int(data[cursor])
        let flags = try readUInt(data, cursor + 1, 3)
        cursor += 4
        let entryCount = try readUInt(data, cursor, 4)
        cursor += 4
        let wide = flags & 1 != 0
        var associations: [Int: [PropertyAssociation]] = [:]
        for _ in 0..<entryCount {
            let itemIDSize = version == 0 ? 2 : 4
            let itemID = try readUInt(data, cursor, itemIDSize)
            cursor += itemIDSize
            let associationCount = Int(data[cursor])
            cursor += 1
            var values: [PropertyAssociation] = []
            for _ in 0..<associationCount {
                let essential: Bool
                let propertyIndex: Int
                if wide {
                    let raw = try readUInt(data, cursor, 2)
                    cursor += 2
                    essential = raw & 0x8000 != 0
                    propertyIndex = raw & 0x7fff
                } else {
                    let raw = Int(data[cursor])
                    cursor += 1
                    essential = raw & 0x80 != 0
                    propertyIndex = raw & 0x7f
                }
                if propertyIndex != 0 {
                    values.append(PropertyAssociation(index: propertyIndex, essential: essential))
                }
            }
            associations[itemID] = values
        }
        return PropertyTable(
            iprpBox: iprp,
            ipcoBox: ipco,
            ipmaBox: ipma,
            properties: properties,
            associations: associations,
            version: version,
            flags: flags
        )
    }

    static func property(_ table: PropertyTable, itemID: Int, type: String) -> Property? {
        for association in table.associations[itemID] ?? [] {
            let index = association.index - 1
            if table.properties.indices.contains(index), table.properties[index].type == type {
                return table.properties[index]
            }
        }
        return nil
    }

    static func propertyBytes(
        _ data: Bytes,
        table: PropertyTable,
        itemID: Int,
        type: String
    ) throws -> Bytes? {
        guard let property = property(table, itemID: itemID, type: type) else { return nil }
        return try byteSlice(data, property.box.offset, property.box.size)
    }

    static func dimensions(_ table: PropertyTable, itemID: Int) -> (Int?, Int?) {
        guard let value = property(table, itemID: itemID, type: "ispe") else {
            return (nil, nil)
        }
        return (value.width, value.height)
    }

    static func auxiliaryURI(_ table: PropertyTable, itemID: Int) -> String? {
        property(table, itemID: itemID, type: "auxC")?.auxiliaryURI
    }

    static func rotationAngle(_ data: Bytes, table: PropertyTable, itemID: Int) throws -> Int {
        guard let bytes = try propertyBytes(data, table: table, itemID: itemID, type: "irot") else {
            return 0
        }
        guard bytes.count > 8 else { throw StylePortError.invalidData("Invalid irot property.") }
        return Int(bytes[8] & 3) * 90
    }

    static func mirrorAxis(_ data: Bytes, table: PropertyTable, itemID: Int) throws -> Int? {
        guard let bytes = try propertyBytes(data, table: table, itemID: itemID, type: "imir") else {
            return nil
        }
        guard bytes.count > 8 else { throw StylePortError.invalidData("Invalid imir property.") }
        return Int(bytes[8] & 1)
    }

    static func displayDimensions(width: Int, height: Int, angle: Int) -> (Int, Int) {
        angle == 90 || angle == 270 ? (height, width) : (width, height)
    }

    static func items(ofType type: String, in infos: [Int: ItemInfo]) -> [Int] {
        infos.filter { $0.value.type == type }.map(\.key).sorted()
    }

    static func discover(_ data: Bytes) throws -> Discovery {
        let meta = try topBox(data, type: "meta")
        let locations = try parseLocations(data, meta: meta)
        let infos = try parseItemInfo(data, meta: meta)
        let references = try parseReferences(data, meta: meta)
        let properties = try parseProperties(data, meta: meta)
        let primary = try parsePrimaryItem(data, meta: meta)
        var derivedImages: [Int: [Int]] = [:]
        for reference in references where reference.type == "dimg" {
            derivedImages[reference.from] = reference.to
        }
        let primaryTiles = derivedImages[primary] ?? []
        guard !primaryTiles.isEmpty else {
            throw StylePortError.invalidData("Primary image is not a grid/dimg image.")
        }

        let thumbnail = references.first {
            $0.type == "thmb" && $0.to.contains(primary)
        }?.from
        var hdrGrid: Int?
        var linearThumbnail: Int?
        var deltaGrid: Int?
        for itemID in infos.keys {
            switch auxiliaryURI(properties, itemID: itemID) {
            case hdrGainURI: hdrGrid = itemID
            case linearThumbnailURI: linearThumbnail = itemID
            case styleDeltaURI: deltaGrid = itemID
            default: break
            }
        }

        var stylesItem: Int?
        var exifItem: Int?
        for (itemID, info) in infos {
            if info.type == "uri ", info.uri == stylesURI { stylesItem = itemID }
            if info.type == "Exif" { exifItem = itemID }
        }
        return Discovery(
            meta: meta,
            locations: locations,
            infos: infos,
            references: references,
            properties: properties,
            primary: primary,
            primaryTiles: primaryTiles,
            thumbnail: thumbnail,
            hdrGrid: hdrGrid,
            hdrTiles: hdrGrid.flatMap { derivedImages[$0] } ?? [],
            linearThumbnail: linearThumbnail,
            deltaGrid: deltaGrid,
            deltaTiles: deltaGrid.flatMap { derivedImages[$0] } ?? [],
            stylesItem: stylesItem,
            exifItem: exifItem
        )
    }

    static func replaceProperty(
        in meta: Bytes,
        propertyIndex: Int,
        with newBox: Bytes,
        expectedType: String? = nil
    ) throws -> Bytes {
        let metaBox = try topBox(meta, type: "meta")
        let properties = try parseProperties(meta, meta: metaBox)
        let ipco = properties.ipcoBox
        let entries = try siblingBoxes(
            meta,
            from: ipco.offset + ipco.headerSize,
            to: ipco.offset + ipco.size
        )
        guard propertyIndex >= 1, propertyIndex <= entries.count else {
            throw StylePortError.invalidData("Property index \(propertyIndex) is out of range.")
        }
        let old = entries[propertyIndex - 1]
        if let expectedType, old.type != expectedType {
            throw StylePortError.invalidData(
                "Property \(propertyIndex) is \(old.type), expected \(expectedType)."
            )
        }
        let delta = newBox.count - old.size
        var rebuilt = concatenated([
            try byteSlice(meta, 0, old.offset),
            newBox,
            try byteSlice(meta, old.offset + old.size, meta.count - old.offset - old.size)
        ])
        for box in [metaBox, properties.iprpBox, ipco] {
            try writeBytes(bigEndianBytes(box.size + delta, count: 4), into: &rebuilt, at: box.offset)
        }
        return rebuilt
    }

    static func replaceItemProperty(
        in meta: Bytes,
        itemID: Int,
        type: String,
        sourceBox: Bytes?
    ) throws -> Bytes {
        guard let sourceBox else { return meta }
        let properties = try parseProperties(meta, meta: topBox(meta, type: "meta"))
        guard let target = property(properties, itemID: itemID, type: type) else { return meta }
        return try replaceProperty(
            in: meta,
            propertyIndex: target.index,
            with: sourceBox,
            expectedType: type
        )
    }

    static func appendProperty(in meta: Bytes, box newBox: Bytes) throws -> (Bytes, Int) {
        let metaBox = try topBox(meta, type: "meta")
        let properties = try parseProperties(meta, meta: metaBox)
        let ipco = properties.ipcoBox
        let newIPCO = makeBox("ipco", payload: concatenated([
            try byteSlice(meta, ipco.offset + ipco.headerSize, ipco.size - ipco.headerSize),
            newBox
        ]))
        let iprp = properties.iprpBox
        var iprpParts: [Bytes] = []
        for child in try siblingBoxes(
            meta,
            from: iprp.offset + iprp.headerSize,
            to: iprp.offset + iprp.size
        ) {
            iprpParts.append(
                child.type == "ipco"
                    ? newIPCO
                    : try byteSlice(meta, child.offset, child.size)
            )
        }
        let newIPRP = makeBox("iprp", payload: concatenated(iprpParts))
        var rebuilt: [Bytes] = [
            try byteSlice(meta, metaBox.offset + metaBox.headerSize, 4)
        ]
        for child in try siblingBoxes(
            meta,
            from: metaBox.offset + metaBox.headerSize + 4,
            to: metaBox.offset + metaBox.size
        ) {
            rebuilt.append(
                child.type == "iprp"
                    ? newIPRP
                    : try byteSlice(meta, child.offset, child.size)
            )
        }
        return (
            makeBox("meta", payload: concatenated(rebuilt)),
            properties.properties.count + 1
        )
    }

    static func repointProperty(
        in meta: Bytes,
        itemID: Int,
        oldIndex: Int,
        newIndex: Int
    ) throws -> Bytes {
        let properties = try parseProperties(meta, meta: topBox(meta, type: "meta"))
        guard properties.flags & 1 == 0 else {
            throw StylePortError.invalidData("Wide ipma editing is not supported.")
        }
        guard newIndex <= 0x7f else {
            throw StylePortError.invalidData("Property index \(newIndex) needs a wide ipma.")
        }
        let ipma = properties.ipmaBox
        var output = meta
        var cursor = ipma.offset + ipma.headerSize + 8
        let itemIDSize = properties.version == 0 ? 2 : 4
        let entryCount = try readUInt(meta, ipma.offset + ipma.headerSize + 4, 4)
        for _ in 0..<entryCount {
            let current = try readUInt(meta, cursor, itemIDSize)
            cursor += itemIDSize
            let count = Int(output[cursor])
            cursor += 1
            for _ in 0..<count {
                if current == itemID, Int(output[cursor] & 0x7f) == oldIndex {
                    output[cursor] = (output[cursor] & 0x80) | UInt8(newIndex)
                }
                cursor += 1
            }
        }
        return output
    }

    private static func itemInfoBox(
        itemID: Int,
        itemType: String = "hvc1",
        contentType: String? = nil
    ) -> Bytes {
        var parts: [Bytes] = [
            [2, 0, 0, 1],
            bigEndianBytes(itemID, count: 2),
            [0, 0],
            Bytes(itemType.utf8),
            [0]
        ]
        if let contentType { parts.append(Bytes(contentType.utf8) + [0]) }
        return makeBox("infe", payload: concatenated(parts))
    }

    private static func referenceBox(type: String, from: Int, targets: [Int]) -> Bytes {
        makeBox(type, payload: concatenated(
            [bigEndianBytes(from, count: 2), bigEndianBytes(targets.count, count: 2)]
            + targets.map { bigEndianBytes($0, count: 2) }
        ))
    }

    static func auxiliaryTypeBox(_ uri: String) -> Bytes {
        makeBox("auxC", payload: Bytes(repeating: 0, count: 4) + Bytes(uri.utf8) + [0])
    }

    private static func associationEntry(
        itemID: Int,
        associations: [(Int, Bool)]
    ) throws -> Bytes {
        var values: Bytes = []
        for (index, essential) in associations {
            guard index <= 0x7f else {
                throw StylePortError.invalidData("Property index \(index) needs a wide ipma.")
            }
            values.append(UInt8((essential ? 0x80 : 0) | index))
        }
        return bigEndianBytes(itemID, count: 2) + [UInt8(associations.count)] + values
    }

    private static func locationEntryV1(itemID: Int) -> Bytes {
        concatenated([
            bigEndianBytes(itemID, count: 2),
            bigEndianBytes(0, count: 2),
            bigEndianBytes(0, count: 2),
            bigEndianBytes(1, count: 2),
            bigEndianBytes(0, count: 4),
            bigEndianBytes(0, count: 4)
        ])
    }

    static func dimensionsBox(width: Int, height: Int) -> Bytes {
        makeBox("ispe", payload: concatenated([
            Bytes(repeating: 0, count: 4),
            bigEndianBytes(width, count: 4),
            bigEndianBytes(height, count: 4)
        ]))
    }

    static func addItems(to meta: Bytes, specs: [ItemSpec]) throws -> (Bytes, [String: Int]) {
        guard !specs.isEmpty else { return (meta, [:]) }
        let metaBox = try topBox(meta, type: "meta")
        let children = try metaChildren(meta, meta: metaBox)
        let properties = try parseProperties(meta, meta: metaBox)
        let infos = try parseItemInfo(meta, meta: metaBox)
        let locations = try parseLocations(meta, meta: metaBox)
        guard let maximumID = infos.keys.max() else {
            throw StylePortError.invalidData("The donor profile contains no items.")
        }
        let nextItemID = maximumID + 1
        let nextProperty = properties.properties.count + 1
        var infoBoxes: [Bytes] = []
        var referenceBoxes: [Bytes] = []
        var associationEntries: [Bytes] = []
        var locationEntries: [Bytes] = []
        var newProperties: [Bytes] = []
        var assigned: [String: Int] = [:]

        for (offset, spec) in specs.enumerated() {
            let itemID = nextItemID + offset
            assigned[spec.key] = itemID
            infoBoxes.append(itemInfoBox(
                itemID: itemID,
                itemType: spec.itemType,
                contentType: spec.contentType
            ))
            if !spec.referenceTargets.isEmpty {
                referenceBoxes.append(referenceBox(
                    type: spec.referenceType,
                    from: itemID,
                    targets: spec.referenceTargets
                ))
            }
            locationEntries.append(locationEntryV1(itemID: itemID))
            var associations = spec.reusedProperties
            var boxes = spec.boxes
            if let auxiliary = spec.auxiliaryBox {
                boxes.append(auxiliary)
            } else if let uri = spec.uri {
                boxes.append(auxiliaryTypeBox(uri))
            }
            for box in boxes {
                newProperties.append(box)
                let type = try fourCC(box, at: 4)
                associations.append((nextProperty + newProperties.count - 1, type != "ispe"))
            }
            if !associations.isEmpty {
                associationEntries.append(try associationEntry(
                    itemID: itemID,
                    associations: associations
                ))
            }
        }

        let iinf = try findChild(children, type: "iinf")
        var iinfBody = try byteSlice(meta, iinf.offset + iinf.headerSize, iinf.size - iinf.headerSize)
        let countSize = iinfBody[0] == 0 ? 2 : 4
        let oldInfoCount = try readUInt(iinfBody, 4, countSize)
        try writeBytes(
            bigEndianBytes(oldInfoCount + specs.count, count: countSize),
            into: &iinfBody,
            at: 4
        )
        let newIINF = makeBox("iinf", payload: concatenated([iinfBody] + infoBoxes))

        let iref = try findChild(children, type: "iref")
        let newIREF = makeBox("iref", payload: concatenated([
            try byteSlice(meta, iref.offset + iref.headerSize, iref.size - iref.headerSize)
        ] + referenceBoxes))

        let iloc = try findChild(children, type: "iloc")
        var ilocBody = try byteSlice(meta, iloc.offset + iloc.headerSize, iloc.size - iloc.headerSize)
        let locationCountSize = locations.version < 2 ? 2 : 4
        let oldLocationCount = try readUInt(ilocBody, 6, locationCountSize)
        try writeBytes(
            bigEndianBytes(oldLocationCount + specs.count, count: locationCountSize),
            into: &ilocBody,
            at: 6
        )
        let newILOC = makeBox("iloc", payload: concatenated([ilocBody] + locationEntries))

        let ipco = properties.ipcoBox
        let newIPCO = makeBox("ipco", payload: concatenated([
            try byteSlice(meta, ipco.offset + ipco.headerSize, ipco.size - ipco.headerSize)
        ] + newProperties))
        let ipma = properties.ipmaBox
        var ipmaBody = try byteSlice(meta, ipma.offset + ipma.headerSize, ipma.size - ipma.headerSize)
        let oldAssociationCount = try readUInt(ipmaBody, 4, 4)
        try writeBytes(
            bigEndianBytes(oldAssociationCount + associationEntries.count, count: 4),
            into: &ipmaBody,
            at: 4
        )
        let newIPMA = makeBox("ipma", payload: concatenated([ipmaBody] + associationEntries))

        let iprp = properties.iprpBox
        var iprpParts: [Bytes] = []
        for child in try siblingBoxes(
            meta,
            from: iprp.offset + iprp.headerSize,
            to: iprp.offset + iprp.size
        ) {
            if child.type == "ipco" { iprpParts.append(newIPCO) }
            else if child.type == "ipma" { iprpParts.append(newIPMA) }
            else { iprpParts.append(try byteSlice(meta, child.offset, child.size)) }
        }
        let newIPRP = makeBox("iprp", payload: concatenated(iprpParts))

        let replacements: [String: Bytes] = [
            "iinf": newIINF,
            "iref": newIREF,
            "iloc": newILOC,
            "iprp": newIPRP
        ]
        var rebuilt: [Bytes] = [
            try byteSlice(meta, metaBox.offset + metaBox.headerSize, 4)
        ]
        for child in try siblingBoxes(
            meta,
            from: metaBox.offset + metaBox.headerSize + 4,
            to: metaBox.offset + metaBox.size
        ) {
            if let replacement = replacements[child.type] {
                rebuilt.append(replacement)
            } else {
                rebuilt.append(try byteSlice(meta, child.offset, child.size))
            }
        }
        return (makeBox("meta", payload: concatenated(rebuilt)), assigned)
    }
}
