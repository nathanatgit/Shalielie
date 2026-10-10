import Foundation

public struct StylePortOptions: Sendable {
    /// Measure the photo for target scene statistics and light maps instead of keeping the
    /// donor statistics and flat maps.
    public var analyzePhoto: Bool
    /// Add the iOS 27 Texture/Grain set (v0.5+). Off reproduces the v0.4.4 output.
    public var texture: Bool
    /// The photo is the still of a Live Photo whose video carries the style tracks. Photos
    /// then edits the pair only without Texture/Grain (with it, Photos also needs a video
    /// `textureStyle` part no known template has) and with styles schema 16, as native
    /// iOS 27 Live Photos have. Overrides `texture`.
    public var livePhoto: Bool

    public init(analyzePhoto: Bool = true, texture: Bool = true, livePhoto: Bool = false) {
        self.analyzePhoto = analyzePhoto
        self.texture = texture
        self.livePhoto = livePhoto
    }
}

public struct StylePortReport: Sendable {
    public enum Mode: String, Sendable {
        /// The style items were added to the photo's own item graph (v0.6.2+).
        case photoGraph = "photo-graph"
        /// The photo was moved onto a donor item graph (layouts with no known map size).
        case donorGraph = "donor-graph"
        /// A native style photo that only got Texture/Grain.
        case addTexture = "add-texture"
    }

    public let version: String
    public var mode: Mode
    public var warnings: [String]
    public var decodedForPalette: Bool
    public var sceneStatistics: [String]
    public var lightMaps: [String]
    public var transplantedMattes: [String]
    public var addedMattes: [String]
    public var neutralizedMattes: [String]
    public var emptiedMattes: [String]
    public var sidecarsAdded: Int
    public var tmapPayload: String?
    public var styleDeltaMap: [Int]
    public var texture: String

    init(version: String, mode: Mode) {
        self.version = version
        self.mode = mode
        warnings = []
        decodedForPalette = false
        sceneStatistics = []
        lightMaps = []
        transplantedMattes = []
        addedMattes = []
        neutralizedMattes = []
        emptiedMattes = []
        sidecarsAdded = 0
        tmapPayload = nil
        styleDeltaMap = []
        texture = "off"
    }

    /// Whether Texture/Grain (iOS 27) was added.
    public var addedTexture: Bool { texture != "off" }
}

public struct StylePortResult: Sendable {
    public let data: Data
    public let report: StylePortReport
}

public struct StylePorter: Sendable {
    public static let version = "0.6.3-swift"
    /// Styles key `0` of native iOS 27 Live Photos (phone-tested 2026-10-10); the donors carry 14.
    public static let livePhotoStylesSchema: Int64 = 16

    public init() {}

    /// What a photo will get, read from its item graph without porting it.
    public enum Eligibility: Sendable, Equatable {
        case port
        case addTexture
        case alreadyStyled
        case unsupported
    }

    public static func eligibility(of data: Data) -> Eligibility {
        guard let discovery = try? HEIF.discover(data.stylePortBytes) else { return .unsupported }
        if discovery.stylesItem != nil {
            return Texture.hasTexture(discovery.infos) ? .alreadyStyled : .addTexture
        }
        guard discovery.hdrGrid != nil, !discovery.hdrTiles.isEmpty,
              discovery.thumbnail != nil, discovery.exifItem != nil else { return .unsupported }
        return .port
    }

    public func patch(
        _ targetData: Data,
        options: StylePortOptions = .init()
    ) throws -> StylePortResult {
        var options = options
        if options.livePhoto { options.texture = false }
        let targetBytes = targetData.stylePortBytes
        let target = try HEIF.discover(targetBytes)

        // A native iPhone 16/17 style photo keeps everything and only gets Texture/Grain.
        if target.stylesItem != nil {
            guard options.texture else { throw StylePortError.alreadyHasTexture }
            let added = try Texture.addTexture(to: targetBytes)
            var report = StylePortReport(version: Self.version, mode: .addTexture)
            report.texture = added.1
            return StylePortResult(data: added.0.stylePortData, report: report)
        }

        guard target.hdrGrid != nil, !target.hdrTiles.isEmpty,
              target.thumbnail != nil, target.exifItem != nil else {
            throw StylePortError.unsupportedPhoto
        }
        let primarySize = HEIF.dimensions(target.properties, itemID: target.primary)
        let graftable = Graft.styleDeltaSize(width: primarySize.0, height: primarySize.1) != nil
        let profile: DonorProfile
        do {
            profile = try DonorProfileLoader.profile(
                primaryTiles: target.primaryTiles.count,
                hdrTiles: target.hdrTiles.count
            )
        } catch StylePortError.unsupportedPhoto where graftable {
            // Only the styles plist and the 0x54 record are used on the photo's own graph.
            profile = try DonorProfileLoader.load(named: "48-12")
        }
        if graftable {
            return try patchOnPhotoGraph(targetBytes, target: target, profile: profile, options: options)
        }
        return try patchOnDonorGraph(targetBytes, target: target, profile: profile, options: options)
    }
}

extension StylePorter {
    func shortURIName(_ uri: String) -> String {
        uri.split(separator: ":").last.map(String.init) ?? uri
    }

    /// patch_with_photo_graph, reuse-thumbnail flavour.
    func patchOnPhotoGraph(
        _ targetBytes: Bytes,
        target: HEIF.Discovery,
        profile: DonorProfile,
        options: StylePortOptions
    ) throws -> StylePortResult {
        var report = StylePortReport(version: Self.version, mode: .photoGraph)
        guard let thumbnail = target.thumbnail else { throw StylePortError.unsupportedPhoto }
        func thumbnailBox(_ type: String) throws -> Bytes {
            guard let box = try HEIF.propertyBytes(
                targetBytes,
                table: target.properties,
                itemID: thumbnail,
                type: type
            ) else { throw StylePortError.unsupportedPhoto }
            return box
        }
        let linearThumbnail = Graft.LinearThumbnail(
            sample: try HEIF.extractItem(targetBytes, locations: target.locations, itemID: thumbnail),
            hvcC: try thumbnailBox("hvcC"),
            ispe: try thumbnailBox("ispe"),
            pixi: try thumbnailBox("pixi")
        )
        guard let donorStyles = profile.retainedPayloads[profile.manifest.donorStylesItem] else {
            throw StylePortError.missingResource("styles payload")
        }
        let hasMattes = target.infos.keys.contains {
            HEIF.auxiliaryURI(target.properties, itemID: $0).map(HEIF.matteURISet.contains) ?? false
        }
        let styles = try applyStyleEdits(
            to: donorStyles,
            targetBytes: targetBytes,
            hasMattes: hasMattes,
            options: options,
            report: &report
        )
        // Same report shape as the donor path: the photo's own mattes and depth stay put.
        for itemID in target.infos.keys.sorted() {
            guard let uri = HEIF.auxiliaryURI(target.properties, itemID: itemID) else { continue }
            if HEIF.matteURISet.contains(uri) { report.transplantedMattes.append(shortURIName(uri)) }
            if uri == HEIF.depthURI { report.addedMattes.append("depth") }
        }
        let grafted = try Graft.graftStyleGraph(
            targetBytes,
            discovery: target,
            styles: styles,
            makerNote54: profile.makerNote54,
            makerNoteType: profile.manifest.smartStyleMakerNoteType,
            linearThumbnail: linearThumbnail,
            texture: options.texture
        )
        report.styleDeltaMap = grafted.1
        report.texture = grafted.2
        return StylePortResult(data: grafted.0.stylePortData, report: report)
    }

    /// Scene statistics, light maps and the person hint, from the photo when it decodes.
    /// Measuring is an enhancement, never a requirement: a failure keeps the donor values.
    func applyStyleEdits(
        to styles: Bytes,
        targetBytes: Bytes,
        hasMattes: Bool,
        options: StylePortOptions,
        report: inout StylePortReport
    ) throws -> Bytes {
        var styles = styles
        var sortedLuma: [Double]?
        if options.analyzePhoto {
            // The embedded thumbnail is the same picture at ~416x312, in stored orientation:
            // decoding the 12-48 MP primary would be wasted work.
            let source = (try? NativeImageAnalyzer.thumbnailHEIC(targetBytes)) ?? targetBytes
            do {
                let rgb = try NativeImageAnalyzer.rgb(from: source, width: 256, height: 192)
                sortedLuma = StyleMaps.linearLuma(fromRGB: rgb).sorted()
                report.decodedForPalette = true
                let scene = try BinaryPlist.applySceneStatistics(
                    to: styles,
                    mode: .target,
                    sortedLuma: sortedLuma
                )
                styles = scene.0
                report.sceneStatistics = scene.1
            } catch {
                report.warnings.append(
                    "Palette analysis failed; donor statistics were kept: "
                    + error.localizedDescription
                )
            }
            if report.decodedForPalette {
                do {
                    let rgb = try NativeImageAnalyzer.rgb(
                        from: source,
                        width: StyleMaps.lightMapSize,
                        height: StyleMaps.lightMapSize
                    )
                    let maps = StyleMaps.buildLightMaps(from: StyleMaps.linearLuma(fromRGB: rgb))
                    let changed = try BinaryPlist.applyLightMaps(to: styles, c: maps.0, d: maps.1)
                    styles = changed.0
                    report.lightMaps = changed.1
                } catch {
                    report.warnings.append(
                        "Light-map analysis failed; flat maps were kept: "
                        + error.localizedDescription
                    )
                }
            }
        }
        if hasMattes {
            styles = try BinaryPlist.setPersonMasksValid(in: styles).0
        }
        if options.livePhoto {
            styles = try BinaryPlist.setStylesSchema(in: styles, to: Self.livePhotoStylesSchema).0
        }
        return styles
    }

    /// The pre-v0.6.2 path: the photo's payloads moved onto the donor's item graph. Used only
    /// for primary sizes with no known StyleDeltaMap size.
    func patchOnDonorGraph(
        _ targetBytes: Bytes,
        target: HEIF.Discovery,
        profile: DonorProfile,
        options: StylePortOptions
    ) throws -> StylePortResult {
        guard let targetThumbnail = target.thumbnail,
              let targetExifItem = target.exifItem else {
            throw StylePortError.unsupportedPhoto
        }
        let manifest = profile.manifest
        guard target.primaryTiles.count == manifest.primaryTileCount,
              target.hdrTiles.count == manifest.hdrTileCount else {
            throw StylePortError.unsupportedPhoto
        }

        var metadata = profile.metadataBox
        var payloads = profile.retainedPayloads
        var report = StylePortReport(version: Self.version, mode: .donorGraph)

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

        // Compressed payloads must travel with their own codec/colour configuration.
        let donorPrimaryTile = manifest.donorPrimaryTiles[0]
        let targetPrimaryTile = target.primaryTiles[0]
        for (donorItem, targetItem, types) in [
            (donorPrimaryTile, targetPrimaryTile, ["hvcC", "colr"]),
            (manifest.donorThumbnailItem, targetThumbnail, ["hvcC", "colr"]),
            (manifest.donorHDRTiles[0], target.hdrTiles[0], ["hvcC"])
        ] {
            for type in types {
                metadata = try HEIF.replaceItemProperty(
                    in: metadata,
                    itemID: donorItem,
                    type: type,
                    sourceBox: HEIF.propertyBytes(
                        targetBytes,
                        table: target.properties,
                        itemID: targetItem,
                        type: type
                    )
                )
            }
        }

        // Orientation: the donor's shared irot drives the whole item graph.
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

        // tmap declares display geometry and carries its own irot, so it must follow the target.
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
            // v0.5.1: the tmap payload holds the gain-map parameters for the target's gain-map
            // tiles, so it must be the target's too. A target without a tmap keeps the donor's.
            report.tmapPayload = "donor"
            if let targetTmap = targetTmaps.first,
               let sourceTmap = try HEIF.idatItemBytes(targetBytes, itemID: targetTmap) {
                metadata = try HEIF.replaceIdatItem(in: metadata, itemID: donorTmap, payload: sourceTmap)
                report.tmapPayload = "target"
            }
        }

        let donorSlots = try transplantAuxiliaryItems(
            targetBytes: targetBytes,
            target: target,
            manifest: manifest,
            profile: profile,
            metadata: &metadata,
            payloads: &payloads,
            report: &report
        )

        // v0.6.1: every matte slot the photo does not fill gets an exactly empty frame, not
        // the donor's near-empty matte. Only slots on the shared matte hvcC qualify.
        let nowProperties = try HEIF.parseProperties(metadata, meta: topBox(metadata, type: "meta"))
        for (uri, itemID) in donorSlots.sorted(by: { $0.key < $1.key })
            where !report.transplantedMattes.contains(shortURIName(uri)) {
            if try HEIF.propertyBytes(metadata, table: nowProperties, itemID: itemID, type: "hvcC")
                == AppleBytes.classicMatteHvcc {
                payloads[itemID] = AppleBytes.classicMatteEmpty
                report.emptiedMattes.append(shortURIName(uri))
            }
        }

        // iOS 27 Texture/Grain. Appending keeps every existing property index, so the
        // manifest's linear-thumbnail hvcC index below still holds.
        if options.texture {
            let infos = try HEIF.parseItemInfo(metadata, meta: topBox(metadata, type: "meta"))
            if Texture.hasTexture(infos) {
                report.texture = "from profile"
            } else {
                let added = try Texture.addItems(
                    to: metadata,
                    primary: manifest.donorPrimaryItem,
                    people: Texture.softSkinPeople(targetBytes, target),
                    grainSeed: Texture.filmGrainSeed(targetBytes, target)
                )
                metadata = added.0
                payloads.merge(added.1) { _, new in new }
                report.texture = added.2
            }
        }

        // Linear thumbnail: reuse the target's own thumbnail, no encoder needed.
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
                // pixi is shared with the delta grid and tmap, so append rather than overwrite.
                let appended = try HEIF.appendProperty(in: metadata, box: sourcePixelInfo)
                metadata = try HEIF.repointProperty(
                    in: appended.0,
                    itemID: donorLinearThumbnail,
                    oldIndex: currentPixelInfo.index,
                    newIndex: appended.1
                )
            }
        }

        if let styles = payloads[manifest.donorStylesItem] {
            payloads[manifest.donorStylesItem] = try applyStyleEdits(
                to: styles,
                targetBytes: targetBytes,
                hasMattes: !report.transplantedMattes.isEmpty,
                options: options,
                report: &report
            )
        }

        let rebuilt = try rebuild(
            profile: profile,
            metadata: metadata,
            payloads: payloads
        )
        return StylePortResult(data: rebuilt.stylePortData, report: report)
    }

    /// Semantic mattes, depth and their XMP sidecars. Returns the donor's matte slots.
    func transplantAuxiliaryItems(
        targetBytes: Bytes,
        target: HEIF.Discovery,
        manifest: DonorManifest,
        profile: DonorProfile,
        metadata: inout Bytes,
        payloads: inout [Int: Bytes],
        report: inout StylePortReport
    ) throws -> [String: Int] {
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
            return donorSlots
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

        // Depth is independent of the mattes: a Portrait photo of a non-person subject
        // carries depth with no mattes at all.
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

        // XMP sidecars: every auxiliary is interpreted through a mime item pointed at it
        // by cdsc. The depth sidecar carries the Portrait blur parameters.
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
        return donorSlots
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
