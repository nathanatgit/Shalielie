import Foundation

public struct StylePortOptions: Sendable {
    public var analyzePhoto: Bool

    public init(analyzePhoto: Bool = true) {
        self.analyzePhoto = analyzePhoto
    }
}

public struct StylePortReport: Sendable {
    public let version: String
    public var warnings: [String]
    public var decodedForPalette: Bool
    public var sceneStatistics: [String]
    public var lightMaps: [String]
    public var transplantedMattes: [String]
    public var addedMattes: [String]
    public var neutralizedMattes: [String]
    public var sidecarsAdded: Int

    init(version: String) {
        self.version = version
        warnings = []
        decodedForPalette = false
        sceneStatistics = []
        lightMaps = []
        transplantedMattes = []
        addedMattes = []
        neutralizedMattes = []
        sidecarsAdded = 0
    }
}

public struct StylePortResult: Sendable {
    public let data: Data
    public let report: StylePortReport
}

public struct StylePorter: Sendable {
    public static let version = "0.4.4-swift"

    public init() {}

    public func patch(
        _ targetData: Data,
        options: StylePortOptions = .init()
    ) throws -> StylePortResult {
        let targetBytes = targetData.stylePortBytes
        let target = try HEIF.discover(targetBytes)
        guard target.hdrGrid != nil, !target.hdrTiles.isEmpty,
              let targetThumbnail = target.thumbnail,
              let targetExifItem = target.exifItem else {
            throw StylePortError.unsupportedPhoto
        }

        let profile = try DonorProfileLoader.profile(
            primaryTiles: target.primaryTiles.count,
            hdrTiles: target.hdrTiles.count
        )
        let manifest = profile.manifest
        guard target.primaryTiles.count == manifest.primaryTileCount,
              target.hdrTiles.count == manifest.hdrTileCount else {
            throw StylePortError.unsupportedPhoto
        }

        var metadata = profile.metadataBox
        var payloads = profile.retainedPayloads
        var report = StylePortReport(version: Self.version)

        for (index, donorItemID) in manifest.donorPrimaryTiles.enumerated() {
            payloads[donorItemID] = try HEIF.extractItem(
                targetBytes,
                locations: target.locations,
                itemID: target.primaryTiles[index]
            )
        }
        for (index, donorItemID) in manifest.donorHDRTiles.enumerated() {
            payloads[donorItemID] = try HEIF.extractItem(
                targetBytes,
                locations: target.locations,
                itemID: target.hdrTiles[index]
            )
        }
        payloads[manifest.donorThumbnailItem] = try HEIF.extractItem(
            targetBytes,
            locations: target.locations,
            itemID: targetThumbnail
        )

        let targetExif = try HEIF.extractItem(
            targetBytes,
            locations: target.locations,
            itemID: targetExifItem
        )
        payloads[manifest.donorExifItem] = try AppleExif.injectMakerNoteTag(
            into: targetExif,
            payload: profile.makerNote54,
            type: manifest.smartStyleMakerNoteType
        )

        let donorPrimaryTile = manifest.donorPrimaryTiles[0]
        let targetPrimaryTile = target.primaryTiles[0]
        metadata = try HEIF.replaceItemProperty(
            in: metadata,
            itemID: donorPrimaryTile,
            type: "hvcC",
            sourceBox: HEIF.propertyBytes(
                targetBytes,
                table: target.properties,
                itemID: targetPrimaryTile,
                type: "hvcC"
            )
        )
        metadata = try HEIF.replaceItemProperty(
            in: metadata,
            itemID: donorPrimaryTile,
            type: "colr",
            sourceBox: HEIF.propertyBytes(
                targetBytes,
                table: target.properties,
                itemID: targetPrimaryTile,
                type: "colr"
            )
        )
        metadata = try HEIF.replaceItemProperty(
            in: metadata,
            itemID: manifest.donorThumbnailItem,
            type: "hvcC",
            sourceBox: HEIF.propertyBytes(
                targetBytes,
                table: target.properties,
                itemID: targetThumbnail,
                type: "hvcC"
            )
        )
        metadata = try HEIF.replaceItemProperty(
            in: metadata,
            itemID: manifest.donorThumbnailItem,
            type: "colr",
            sourceBox: HEIF.propertyBytes(
                targetBytes,
                table: target.properties,
                itemID: targetThumbnail,
                type: "colr"
            )
        )
        metadata = try HEIF.replaceItemProperty(
            in: metadata,
            itemID: manifest.donorHDRTiles[0],
            type: "hvcC",
            sourceBox: HEIF.propertyBytes(
                targetBytes,
                table: target.properties,
                itemID: target.hdrTiles[0],
                type: "hvcC"
            )
        )

        let targetAngle = try HEIF.rotationAngle(
            targetBytes,
            table: target.properties,
            itemID: target.primary
        )
        let targetMirror = try HEIF.mirrorAxis(
            targetBytes,
            table: target.properties,
            itemID: target.primary
        )
        metadata = try HEIF.replaceItemProperty(
            in: metadata,
            itemID: manifest.donorPrimaryItem,
            type: "irot",
            sourceBox: try HEIF.propertyBytes(
                targetBytes,
                table: target.properties,
                itemID: target.primary,
                type: "irot"
            ) ?? HEIF.identityRotation
        )
        if targetMirror != nil {
            let current = try HEIF.parseProperties(
                metadata,
                meta: topBox(metadata, type: "meta")
            )
            if HEIF.property(current, itemID: manifest.donorPrimaryItem, type: "imir") == nil {
                report.warnings.append(
                    "The target has an imir property but the donor profile has no slot for it."
                )
            } else {
                metadata = try HEIF.replaceItemProperty(
                    in: metadata,
                    itemID: manifest.donorPrimaryItem,
                    type: "imir",
                    sourceBox: HEIF.propertyBytes(
                        targetBytes,
                        table: target.properties,
                        itemID: target.primary,
                        type: "imir"
                    )
                )
            }
        }

        let donorTmaps = try HEIF.items(
            ofType: "tmap",
            in: HEIF.parseItemInfo(metadata, meta: topBox(metadata, type: "meta"))
        )
        let targetTmaps = HEIF.items(ofType: "tmap", in: target.infos)
        if let donorTmap = donorTmaps.first {
            let sourceDimensions: Bytes
            let sourceRotation: Bytes
            if let targetTmap = targetTmaps.first,
               let targetDimensions = try HEIF.propertyBytes(
                    targetBytes,
                    table: target.properties,
                    itemID: targetTmap,
                    type: "ispe"
               ) {
                sourceDimensions = targetDimensions
                sourceRotation = try HEIF.propertyBytes(
                    targetBytes,
                    table: target.properties,
                    itemID: targetTmap,
                    type: "irot"
                ) ?? HEIF.identityRotation
            } else {
                let dimensions = HEIF.dimensions(target.properties, itemID: target.primary)
                guard let width = dimensions.0, let height = dimensions.1 else {
                    throw StylePortError.unsupportedPhoto
                }
                let display = HEIF.displayDimensions(
                    width: width,
                    height: height,
                    angle: targetAngle
                )
                sourceDimensions = HEIF.dimensionsBox(width: display.0, height: display.1)
                sourceRotation = HEIF.identityRotation
            }
            metadata = try HEIF.replaceItemProperty(
                in: metadata,
                itemID: donorTmap,
                type: "ispe",
                sourceBox: sourceDimensions
            )
            metadata = try HEIF.replaceItemProperty(
                in: metadata,
                itemID: donorTmap,
                type: "irot",
                sourceBox: sourceRotation
            )
        }

        try transplantAuxiliaryItems(
            targetBytes: targetBytes,
            target: target,
            manifest: manifest,
            profile: profile,
            metadata: &metadata,
            payloads: &payloads,
            report: &report
        )

        let donorLinearThumbnail = manifest.donorLinearThumbnailItem
        let thumbnailHVCC = try HEIF.propertyBytes(
            targetBytes,
            table: target.properties,
            itemID: targetThumbnail,
            type: "hvcC"
        )
        guard let thumbnailHVCC else { throw StylePortError.unsupportedPhoto }
        payloads[donorLinearThumbnail] = try HEIF.extractItem(
            targetBytes,
            locations: target.locations,
            itemID: targetThumbnail
        )
        metadata = try HEIF.replaceProperty(
            in: metadata,
            propertyIndex: manifest.linearThumbnailHVCCPropertyIndex,
            with: thumbnailHVCC,
            expectedType: "hvcC"
        )
        metadata = try HEIF.replaceItemProperty(
            in: metadata,
            itemID: donorLinearThumbnail,
            type: "ispe",
            sourceBox: HEIF.propertyBytes(
                targetBytes,
                table: target.properties,
                itemID: targetThumbnail,
                type: "ispe"
            )
        )
        let sourcePixelInfo = try HEIF.propertyBytes(
            targetBytes,
            table: target.properties,
            itemID: targetThumbnail,
            type: "pixi"
        )
        let currentProperties = try HEIF.parseProperties(
            metadata,
            meta: topBox(metadata, type: "meta")
        )
        if let sourcePixelInfo,
           let currentPixelInfo = HEIF.property(
                currentProperties,
                itemID: donorLinearThumbnail,
                type: "pixi"
           ) {
            let oldBytes = try HEIF.propertyBytes(
                metadata,
                table: currentProperties,
                itemID: donorLinearThumbnail,
                type: "pixi"
            )
            if !bytesEqual(oldBytes, sourcePixelInfo) {
                let appended = try HEIF.appendProperty(in: metadata, box: sourcePixelInfo)
                metadata = try HEIF.repointProperty(
                    in: appended.0,
                    itemID: donorLinearThumbnail,
                    oldIndex: currentPixelInfo.index,
                    newIndex: appended.1
                )
            }
        }

        if var styles = payloads[manifest.donorStylesItem] {
            var sortedLuma: [Double]?
            if options.analyzePhoto {
                do {
                    let rgb = try NativeImageAnalyzer.rgb(
                        from: targetBytes,
                        width: 256,
                        height: 192
                    )
                    sortedLuma = StyleMaps.linearLuma(fromRGB: rgb).sorted()
                    report.decodedForPalette = true
                } catch {
                    report.warnings.append(
                        "Native palette analysis failed; donor statistics were retained: "
                        + error.localizedDescription
                    )
                }
            }
            let scene = try BinaryPlist.applySceneStatistics(
                to: styles,
                mode: sortedLuma == nil ? .donor : .target,
                sortedLuma: sortedLuma
            )
            styles = scene.0
            report.sceneStatistics = scene.1

            if options.analyzePhoto, report.decodedForPalette {
                do {
                    let rgb = try NativeImageAnalyzer.rgb(
                        from: targetBytes,
                        width: StyleMaps.lightMapSize,
                        height: StyleMaps.lightMapSize
                    )
                    let maps = StyleMaps.buildLightMaps(
                        from: StyleMaps.linearLuma(fromRGB: rgb)
                    )
                    let changed = try BinaryPlist.applyLightMaps(
                        to: styles,
                        c: maps.0,
                        d: maps.1
                    )
                    styles = changed.0
                    report.lightMaps = changed.1
                } catch {
                    report.warnings.append(
                        "Native light-map analysis failed; flat maps were retained: "
                        + error.localizedDescription
                    )
                }
            }
            if !report.transplantedMattes.isEmpty {
                styles = try BinaryPlist.setPersonMasksValid(in: styles).0
            }
            payloads[manifest.donorStylesItem] = styles
        }

        let rebuilt = try rebuild(
            profile: profile,
            metadata: metadata,
            payloads: payloads
        )
        return StylePortResult(data: rebuilt.stylePortData, report: report)
    }
}

private extension StylePorter {
    func shortURIName(_ uri: String) -> String {
        uri.split(separator: ":").last.map(String.init) ?? uri
    }

    func transplantAuxiliaryItems(
        targetBytes: Bytes,
        target: HEIF.Discovery,
        manifest: DonorManifest,
        profile: DonorProfile,
        metadata: inout Bytes,
        payloads: inout [Int: Bytes],
        report: inout StylePortReport
    ) throws {
        let donorMeta = try topBox(metadata, type: "meta")
        let donorProperties = try HEIF.parseProperties(metadata, meta: donorMeta)
        let donorInfos = try HEIF.parseItemInfo(metadata, meta: donorMeta)
        var donorSlots: [String: Int] = [:]
        var targetSlots: [String: Int] = [:]
        for itemID in donorInfos.keys {
            if let uri = HEIF.auxiliaryURI(donorProperties, itemID: itemID),
               HEIF.matteURISet.contains(uri) {
                donorSlots[uri] = itemID
            }
        }
        for itemID in target.infos.keys {
            if let uri = HEIF.auxiliaryURI(target.properties, itemID: itemID),
               HEIF.matteURISet.contains(uri) {
                targetSlots[uri] = itemID
            }
        }
        guard let templateItemID = donorSlots.sorted(by: { $0.key < $1.key }).first?.value else {
            return
        }

        let templateTargets = try HEIF.parseReferences(
            metadata,
            meta: topBox(metadata, type: "meta")
        ).first {
            $0.type == "auxl" && $0.from == templateItemID
        }?.to
        let auxiliaryTargets = templateTargets?.isEmpty == false
            ? templateTargets!
            : [target.primary]
        var specs: [HEIF.ItemSpec] = []

        if !targetSlots.isEmpty {
            let shared = targetSlots.keys.filter { donorSlots[$0] != nil }.sorted()
            let extra = targetSlots.keys.filter { donorSlots[$0] == nil }.sorted()
            let spare = donorSlots.keys.filter { targetSlots[$0] == nil }.sorted()
            guard let anyTargetID = targetSlots.sorted(by: { $0.key < $1.key }).first?.value,
                  let newHVCCBytes = try HEIF.propertyBytes(
                    targetBytes,
                    table: target.properties,
                    itemID: anyTargetID,
                    type: "hvcC"
                  ) else {
                throw StylePortError.unsupportedPhoto
            }
            let appended = try HEIF.appendProperty(in: metadata, box: newHVCCBytes)
            metadata = appended.0
            let oldHVCCSource = shared.first.flatMap { donorSlots[$0] } ?? templateItemID
            guard let oldHVCC = HEIF.property(
                donorProperties,
                itemID: oldHVCCSource,
                type: "hvcC"
            ) else {
                throw StylePortError.invalidData("Donor matte hvcC property is missing.")
            }

            for uri in shared {
                guard let donorItemID = donorSlots[uri], let targetItemID = targetSlots[uri] else {
                    continue
                }
                metadata = try HEIF.repointProperty(
                    in: metadata,
                    itemID: donorItemID,
                    oldIndex: oldHVCC.index,
                    newIndex: appended.1
                )
                metadata = try HEIF.replaceItemProperty(
                    in: metadata,
                    itemID: donorItemID,
                    type: "auxC",
                    sourceBox: HEIF.propertyBytes(
                        targetBytes,
                        table: target.properties,
                        itemID: targetItemID,
                        type: "auxC"
                    )
                )
                payloads[donorItemID] = try HEIF.extractItem(
                    targetBytes,
                    locations: target.locations,
                    itemID: targetItemID
                )
                report.transplantedMattes.append(shortURIName(uri))
            }

            if let neutralSource = HEIF.matteURIs["portraiteffectsmatte"].flatMap({ donorSlots[$0] }),
               let neutralPayload = profile.retainedPayloads[neutralSource] {
                for uri in spare {
                    guard let donorItemID = donorSlots[uri], payloads[donorItemID] != nil else {
                        continue
                    }
                    payloads[donorItemID] = neutralPayload
                    report.neutralizedMattes.append(shortURIName(uri))
                }
            }

            let currentProperties = try HEIF.parseProperties(
                metadata,
                meta: topBox(metadata, type: "meta")
            )
            let templateAssociations = currentProperties.associations[templateItemID] ?? []
            let templateAuxiliaryIndex = HEIF.property(
                currentProperties,
                itemID: templateItemID,
                type: "auxC"
            )?.index
            let matteReuse = templateAssociations.compactMap { association -> (Int, Bool)? in
                association.index == templateAuxiliaryIndex
                    ? nil
                    : (association.index, association.essential)
            }
            for uri in extra {
                guard let targetItemID = targetSlots[uri] else { continue }
                specs.append(HEIF.ItemSpec(
                    key: uri,
                    uri: uri,
                    reusedProperties: matteReuse,
                    auxiliaryBox: try HEIF.propertyBytes(
                        targetBytes,
                        table: target.properties,
                        itemID: targetItemID,
                        type: "auxC"
                    )
                ))
            }
        }

        let targetDepthItems = target.infos.keys.filter {
            HEIF.auxiliaryURI(target.properties, itemID: $0) == HEIF.depthURI
        }.sorted()
        let donorDepthItems = donorInfos.keys.filter {
            HEIF.auxiliaryURI(donorProperties, itemID: $0) == HEIF.depthURI
        }
        if let depthItemID = targetDepthItems.first, donorDepthItems.isEmpty {
            let current = try HEIF.parseProperties(
                metadata,
                meta: topBox(metadata, type: "meta")
            )
            let rotation = HEIF.property(current, itemID: templateItemID, type: "irot")
            var boxes: [Bytes] = []
            for type in ["ispe", "pixi", "colr", "hvcC"] {
                if let box = try HEIF.propertyBytes(
                    targetBytes,
                    table: target.properties,
                    itemID: depthItemID,
                    type: type
                ) {
                    boxes.append(box)
                }
            }
            specs.append(HEIF.ItemSpec(
                key: HEIF.depthURI,
                uri: HEIF.depthURI,
                reusedProperties: rotation.map { [($0.index, true)] } ?? [],
                boxes: boxes,
                auxiliaryBox: try HEIF.propertyBytes(
                    targetBytes,
                    table: target.properties,
                    itemID: depthItemID,
                    type: "auxC"
                )
            ))
            targetSlots[HEIF.depthURI] = depthItemID
        }

        for index in specs.indices {
            specs[index].referenceType = "auxl"
            specs[index].referenceTargets = auxiliaryTargets
        }
        var assigned: [String: Int] = [:]
        if !specs.isEmpty {
            let added = try HEIF.addItems(to: metadata, specs: specs)
            metadata = added.0
            assigned = added.1
            for (uri, newItemID) in assigned {
                guard let targetItemID = targetSlots[uri] else { continue }
                payloads[newItemID] = try HEIF.extractItem(
                    targetBytes,
                    locations: target.locations,
                    itemID: targetItemID
                )
                let name = uri == HEIF.depthURI ? "depth" : shortURIName(uri)
                report.addedMattes.append("\(name)#\(newItemID)")
            }
        }

        let portMeta = try topBox(metadata, type: "meta")
        let portInfos = try HEIF.parseItemInfo(metadata, meta: portMeta)
        let portReferences = try HEIF.parseReferences(metadata, meta: portMeta)
        var itemMap: [Int: Int] = [target.primary: manifest.donorPrimaryItem]
        if let targetHDR = target.hdrGrid {
            itemMap[targetHDR] = manifest.donorHDRGridItem
        }
        let portTmaps = HEIF.items(ofType: "tmap", in: portInfos)
        for (index, targetTmap) in HEIF.items(ofType: "tmap", in: target.infos).enumerated()
            where portTmaps.indices.contains(index) {
            itemMap[targetTmap] = portTmaps[index]
        }
        for (uri, targetItemID) in targetSlots {
            if let donorItemID = donorSlots[uri] { itemMap[targetItemID] = donorItemID }
            else if let newItemID = assigned[uri] { itemMap[targetItemID] = newItemID }
        }

        var portDescriptions: [Int: [Int]] = [:]
        for reference in portReferences where reference.type == "cdsc" {
            portDescriptions[reference.from] = reference.to
        }
        var described: [String: Int] = [:]
        for (itemID, info) in portInfos where info.type == "mime" {
            if let targets = portDescriptions[itemID] {
                described[targets.map(String.init).joined(separator: ",")] = itemID
            }
        }
        var targetDescriptions: [Int: [Int]] = [:]
        for reference in target.references where reference.type == "cdsc" {
            targetDescriptions[reference.from] = reference.to
        }

        var sidecarSpecs: [HEIF.ItemSpec] = []
        var sidecarPayloads: [String: Bytes] = [:]
        for (targetItemID, info) in target.infos.sorted(by: { $0.key < $1.key }) {
            guard info.type == "mime", let targets = targetDescriptions[targetItemID],
                  targets.allSatisfy({ itemMap[$0] != nil }) else { continue }
            let mapped = targets.compactMap { itemMap[$0] }
            let payload = try HEIF.extractItem(
                targetBytes,
                locations: target.locations,
                itemID: targetItemID
            )
            let mappingKey = mapped.map(String.init).joined(separator: ",")
            if let existingItemID = described[mappingKey] {
                payloads[existingItemID] = payload
            } else {
                let key = "mime\(targetItemID)"
                sidecarSpecs.append(HEIF.ItemSpec(
                    key: key,
                    uri: nil,
                    itemType: "mime",
                    contentType: info.contentType ?? "application/rdf+xml",
                    referenceType: "cdsc",
                    referenceTargets: mapped
                ))
                sidecarPayloads[key] = payload
            }
        }
        if !sidecarSpecs.isEmpty {
            let added = try HEIF.addItems(to: metadata, specs: sidecarSpecs)
            metadata = added.0
            for spec in sidecarSpecs {
                if let itemID = added.1[spec.key], let payload = sidecarPayloads[spec.key] {
                    payloads[itemID] = payload
                }
            }
            report.sidecarsAdded = sidecarSpecs.count
        }
    }

    func rebuild(
        profile: DonorProfile,
        metadata: Bytes,
        payloads: [Int: Bytes]
    ) throws -> Bytes {
        let locations = try HEIF.parseLocations(
            metadata,
            meta: topBox(metadata, type: "meta")
        )
        let externalIDs = locations.items
            .filter { $0.value.constructionMethod == 0 && !$0.value.extents.isEmpty }
            .map(\.key)
            .sorted()
        let missing = externalIDs.filter { payloads[$0] == nil }
        guard missing.isEmpty else {
            throw StylePortError.invalidData(
                "The donor profile is missing payloads: \(missing)."
            )
        }

        let mediaDataStart = profile.fileTypeBox.count + metadata.count
        var cursor = mediaDataStart + 8
        var chunks: [Bytes] = []
        var layout: [Int: (Int, Int)] = [:]
        for itemID in externalIDs {
            guard let payload = payloads[itemID] else { continue }
            layout[itemID] = (cursor, payload.count)
            chunks.append(payload)
            cursor += payload.count
        }

        var outputMetadata = metadata
        let outputLocations = try HEIF.parseLocations(
            outputMetadata,
            meta: topBox(outputMetadata, type: "meta")
        )
        for (itemID, placement) in layout {
            guard let extent = outputLocations.items[itemID]?.extents.first else {
                throw StylePortError.invalidData("Item \(itemID) has no output extent.")
            }
            try writeBytes(
                bigEndianBytes(placement.0, count: outputLocations.offsetSize),
                into: &outputMetadata,
                at: extent.offsetPosition
            )
            try writeBytes(
                bigEndianBytes(placement.1, count: outputLocations.lengthSize),
                into: &outputMetadata,
                at: extent.lengthPosition
            )
        }
        let mediaPayload = concatenated(chunks)
        return concatenated([
            profile.fileTypeBox,
            outputMetadata,
            bigEndianBytes(8 + mediaPayload.count, count: 4),
            Bytes("mdat".utf8),
            mediaPayload
        ])
    }
}
