import Foundation

// iOS 27 Texture/Grain and Soft Skin. Port of add_texture_items and its helpers in
// photographic_style_port.py (v0.5.0-v0.6.1) via web/src/texture.js; every step runs in the
// same order with the same bytes, so all three builds write identical files.
//
// Photos offers the controls only when a style photo carries BOTH the texture_styles item
// AND iOS 27's twelve 2026 semantic mattes; the item without the mattes removes the whole
// style palette. For a scene with no people every matte is the same empty 768x576 frame.
enum Texture {
    static let textureStylesURI = "tag:apple.com,2026:photo:metadata:texture_styles"
    static let personInstancesURI = "tag:apple.com,2026:photo:aux:semanticpersoninstances"

    static let matte2026URIs = [
        "semanticnosematte", "semanticskinmattev2", "semanticnonfaceskinmatte",
        "semanticlipsmatte", "semanticteethmattev2", "semanticpersonmatte",
        "semanticglassesmattev2", "semanticeyebrowsmatte", "semantictattoomatte",
        "semantichandsmatte", "semanticearsmatte", "semanticfaceskinmatte"
    ].map { "tag:apple.com,2026:photo:aux:\($0)" }

    static let matteXMP = Bytes("""
    <x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="XMP Core 6.0.0">
       <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
          <rdf:Description rdf:about=""
                xmlns:fsincMattes="http://ns.apple.com/fsinc/1.0/">
             <fsincMattes:FSINCMatteVersion>0</fsincMattes:FSINCMatteVersion>
          </rdf:Description>
       </rdf:RDF>
    </x:xmpmeta>

    """.utf8)

    // v0.6.0 Soft Skin constants; see SOFT_SKIN_* in the Python source.
    static let softSkinSkinURIs = ["semanticskinmattev2", "semanticfaceskinmatte"]
        .map { "tag:apple.com,2026:photo:aux:\($0)" }
    static let softSkinPersonURI = "tag:apple.com,2026:photo:aux:semanticpersonmatte"
    static let softSkinInstanceKeys = ["FSINCInstanceMask9"]
        + (0..<9).map { "FSINCInstanceMask\($0)" }
    static let textureStylesHeader: [(String, BinaryPlistValue)] = [
        ("Preset", .string("Standard")), ("CaptureType", .string("LF")),
        ("CaptureMode", .string("Still")), ("PortType", .string("PortTypeBack")),
        ("HardwareModel", .string("iPhone19,2")),
        ("TextureStylePeopleDataVersion", .integer(3)), ("FilmGrainSeed", .integer(92))
    ]
    // Median face layout of 14 native iOS 27 Soft Skin faces.
    static let softSkinLandmarks: [Double] = [
        -0.3411, -0.1971, -0.1456, -0.1813, -0.2857, -0.1842, -0.2046, -0.183, -0.2917, -0.2316,
        -0.2028, -0.2305, -0.2593, -0.2173, 0.3462, -0.216, 0.1382, -0.1951, 0.2886, -0.1967,
        0.2046, -0.1939, 0.2885, -0.2529, 0.1912, -0.2427, 0.2363, -0.2343, -0.4396, -0.3135,
        -0.2977, -0.3602, -0.1383, -0.3263, -0.1331, -0.3882, -0.3011, -0.4217, -0.4498, -0.3449,
        0.4441, -0.3325, 0.2915, -0.3779, 0.133, -0.3542, 0.1279, -0.4186, 0.2995, -0.4409, 0.4506,
        -0.366, -0.188, 0.3426, -0.1588, 0.2971, -0.1076, 0.2627, -0.0523, 0.2449, -0.0037, 0.253,
        0.045, 0.2402, 0.1087, 0.2598, 0.1666, 0.2991, 0.2101, 0.335, 0.1474, 0.3798, 0.0745,
        0.4022, -0.0015, 0.4111, -0.0758, 0.401, -0.1437, 0.3733, -0.0008, 0.3182, -0.0007, 0.3325,
        -0.0845, 0.3189, 0.0861, 0.3152, -0.0835, 0.3274, 0.0864, 0.3322, -0.0079, -0.2384, -0.0096,
        -0.1509, -0.0097, -0.0697, -0.0126, 0.0174, 0.1254, 0.1286, 0.0584, 0.1219, -0.0088, 0.1251,
        -0.0673, 0.1186, -0.1329, 0.1264, 0.1241, -0.0042, -0.1267, -0.0032, 0.1102, 0.054, -0.1153,
        0.0489, 0.6088, -0.1704, 0.6101, -0.0178, 0.6033, 0.1255, 0.5716, 0.2813, 0.5101, 0.4279,
        0.4194, 0.5368, 0.2905, 0.6203, 0.1554, 0.6812, -0.0025, 0.7043, -0.1426, 0.6773, -0.2791,
        0.6185, -0.384, 0.5307, -0.4829, 0.4244, -0.5531, 0.2924, -0.5871, 0.1388, -0.6052, -0.0192,
        -0.6, -0.1667
    ]
    static let softSkinROIPerXMP = (0.9682, 0.967)
    static let softSkinSkinROI = 1.8
    static let softSkinFaceColor = [0.6843, 0.5275, 0.4353]
    static let softSkinSmoothColor = [0.6651, 0.5179, 0.4315]
    static let softSkinRoughness = 0.0121
    static let softSkinEyeColor = [0.5776, 0.4579, 0.3829]
    static let softSkinEyeVariance = 0.0052

    /// A matte the photo already has, reused for a 2026 matte or a person instance.
    final class MatteSource {
        let payload: Bytes
        let ispe: Bytes
        let pixi: Bytes
        let hvcC: Bytes

        init(payload: Bytes, ispe: Bytes, pixi: Bytes, hvcC: Bytes) {
            self.payload = payload
            self.ispe = ispe
            self.pixi = pixi
            self.hvcC = hvcC
        }
    }

    struct People {
        let faces: Int
        let entries: [BinaryPlistValue]
        let mattes: [String: MatteSource]
        let instances: [(String, MatteSource)]
    }

    struct Face {
        let x: Double
        let y: Double
        let w: Double
        let h: Double
        let yaw: Double
        let roll: Double
    }

    // CRC-32 (IEEE), equal to Python's zlib.crc32.
    private static let crcTable: [UInt32] = (0..<256).map { value in
        var c = UInt32(value)
        for _ in 0..<8 { c = c & 1 != 0 ? 0xedb8_8320 ^ (c >> 1) : c >> 1 }
        return c
    }

    static func crc32(_ bytes: Bytes) -> UInt32 {
        var c: UInt32 = 0xffff_ffff
        for byte in bytes { c = crcTable[Int((c ^ UInt32(byte)) & 0xff)] ^ (c >> 8) }
        return c ^ 0xffff_ffff
    }

    /// v0.6.1: the per-photo FilmGrainSeed, the CRC-32 of the first primary tile mod 256.
    static func filmGrainSeed(_ data: Bytes, _ discovery: HEIF.Discovery) throws -> Int {
        let tile = try HEIF.extractItem(
            data,
            locations: discovery.locations,
            itemID: discovery.primaryTiles[0]
        )
        return Int(crc32(tile) % 256)
    }

    private static func firstMatch(_ pattern: String, in text: String) -> String? {
        guard let regex = try? NSRegularExpression(pattern: pattern),
              let match = regex.firstMatch(
                in: text,
                range: NSRange(text.startIndex..., in: text)
              ),
              let range = Range(match.range(at: 1), in: text) else { return nil }
        return String(text[range])
    }

    private static func number(_ text: String) -> Double? {
        Double(text.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    /// Face regions from the photo's MWG region XMP, in stored orientation.
    static func xmpFaceRegions(_ data: Bytes, _ discovery: HEIF.Discovery) -> [Face] {
        for itemID in discovery.infos.keys.sorted() where discovery.infos[itemID]?.type == "mime" {
            guard let payload = try? HEIF.extractItem(
                data,
                locations: discovery.locations,
                itemID: itemID
            ) else { continue }
            let xmp = String(decoding: payload, as: UTF8.self)
            guard xmp.contains("mwg-rs:Regions"),
                  let items = try? NSRegularExpression(
                    pattern: #"<rdf:li rdf:parseType="Resource">(.*?)</rdf:li>"#,
                    options: [.dotMatchesLineSeparators]
                  ) else { continue }
            var faces: [Face] = []
            for match in items.matches(in: xmp, range: NSRange(xmp.startIndex..., in: xmp)) {
                guard let range = Range(match.range(at: 1), in: xmp) else { continue }
                let item = String(xmp[range])
                guard item.contains("<mwg-rs:Type>Face</mwg-rs:Type>") else { continue }
                var area: [String: Double] = [:]
                for tag in ["x", "y", "w", "h"] {
                    guard let text = firstMatch("<stArea:\(tag)>([^<]+)</stArea:\(tag)>", in: item),
                          let value = number(text) else { break }
                    area[tag] = value
                }
                guard let x = area["x"], let y = area["y"], let w = area["w"], let h = area["h"] else {
                    continue
                }
                func angle(_ tag: String) -> Double {
                    firstMatch("<apple-fi:\(tag)>([^<]+)</apple-fi:\(tag)>", in: item)
                        .flatMap(number) ?? 0
                }
                faces.append(Face(
                    x: x, y: y, w: w, h: h,
                    yaw: angle("AngleInfoYaw"),
                    roll: angle("AngleInfoRoll")
                ))
            }
            return faces
        }
        return []
    }

    /// Round to 1e-6 with the same IEEE steps as the Python and web builds.
    private static func r6(_ value: Double) -> Double { (value * 1e6 + 0.5).rounded(.down) / 1e6 }
    private static func radians(_ degrees: Double) -> Double { degrees * (Double.pi / 180) }
    /// Python's floored float %, which Swift's truncatingRemainder is not.
    private static func wrap(_ degrees: Double) -> Double {
        let shifted = degrees + 180
        return shifted - 360 * (shifted / 360).rounded(.down) - 180
    }
    private static func clamp(_ value: Double) -> Double { min(1, max(0, value)) }

    /// One TextureStylePostProcessedPeopleData entry, keyed and ordered as iOS 27 writes it.
    static func peopleEntry(
        _ face: Face,
        index: Int,
        irot: Int,
        width: Int,
        height: Int
    ) -> BinaryPlistValue {
        let width = Double(width)
        let height = Double(height)
        func box(_ x: Double, _ y: Double, _ w: Double, _ h: Double) -> BinaryPlistValue {
            let x0 = clamp(x), y0 = clamp(y), x1 = clamp(x + w), y1 = clamp(y + h)
            return .dictionary([
                ("y", .real(r6(y0))), ("x", .real(r6(x0))),
                ("width", .real(r6(x1 - x0))), ("height", .real(r6(y1 - y0)))
            ])
        }
        func reals(_ values: [Double]) -> BinaryPlistValue { .array(values.map { .real($0) }) }
        let full: BinaryPlistValue = .dictionary([
            ("y", .real(0)), ("x", .real(0)), ("width", .real(1)), ("height", .real(1))
        ])

        let fw = face.w * softSkinROIPerXMP.0
        let fh = face.h * softSkinROIPerXMP.1
        let scale = fw * width
        let theta = radians(face.roll)
        let c = cos(theta), s = sin(theta)
        var marks: [BinaryPlistValue] = []
        for k in stride(from: 0, to: softSkinLandmarks.count, by: 2) {
            let u = softSkinLandmarks[k], v = softSkinLandmarks[k + 1]
            marks.append(.dictionary([
                ("point", .dictionary([
                    ("x", .real(r6(clamp((face.x * width + (u * c - v * s) * scale) / width)))),
                    ("y", .real(r6(clamp((face.y * height + (u * s + v * c) * scale) / height))))
                ])),
                ("error", .real(0.02))
            ]))
        }
        let side = softSkinSkinROI * scale
        let faceID = BinaryPlistValue.integer(Int64(index))
        return .dictionary([
            ("faceSkinROI", box(
                face.x - side / 2 / width, face.y - side / 2 / height,
                side / width, side / height
            )),
            ("faceID", faceID),
            ("faceYaw", .real(r6(radians(wrap(face.yaw))))),
            ("faceROI", box(face.x - fw / 2, face.y - fh / 2, fw, fh)),
            ("imageStats", .dictionary([
                ("Mattify", .dictionary([
                    ("SkipPerson", .bool(false)), ("HighlightsToMaskRatio", .real(0)),
                    ("faceID", faceID), ("AverageFaceColor", reals(softSkinFaceColor))
                ])),
                ("SkinSmoothingStandalone", .dictionary([
                    ("faceID", faceID),
                    ("SkinSmoothAverageFaceColour", reals(softSkinSmoothColor)),
                    ("SkinSmoothSkipPerson", .bool(false)),
                    ("SkinSmoothFaceRoughness", .real(softSkinRoughness))
                ])),
                ("UnderEyeBrightening", .dictionary([
                    ("faceID", faceID), ("RightEyeIsBiModal", .bool(false)),
                    ("LeftEyeLumaVariance", .real(softSkinEyeVariance)),
                    ("LeftEyeIsBiModal", .bool(false)),
                    ("LeftEyeAverageColor", reals(softSkinEyeColor)),
                    ("RightEyeAverageColor", reals(softSkinEyeColor)),
                    ("RightEyeLumaVariance", .real(softSkinEyeVariance))
                ]))
            ])),
            ("faceLandmarkType", .integer(1)),
            ("faceUnitOfAngle", .integer(1)),
            ("instanceROI", full),
            ("instanceMaskReferenceKey", .string(softSkinInstanceKeys[index])),
            ("faceROIAndLandmarksROIRelativeScalingROI", full),
            ("facePitch", .real(0)),
            ("faceRoll", .real(r6(-radians(wrap(face.roll - Double(irot)))))),
            ("faceLandmarks", .array(marks))
        ])
    }

    /// Everything Soft Skin needs, taken from the photo, or nil when the photo lacks any of
    /// it (face regions, semanticskinmatte, portraiteffectsmatte). nil keeps the v0.5 output.
    static func softSkinPeople(_ data: Bytes, _ discovery: HEIF.Discovery) throws -> People? {
        let faces = xmpFaceRegions(data, discovery)
        guard !faces.isEmpty, faces.count <= softSkinInstanceKeys.count,
              let skinURI = HEIF.matteURIs["semanticskinmatte"],
              let personURI = HEIF.matteURIs["portraiteffectsmatte"] else { return nil }
        var found: [String: Int] = [:]
        for itemID in discovery.infos.keys.sorted() {
            let uri = HEIF.auxiliaryURI(discovery.properties, itemID: itemID)
            if let uri, uri == skinURI || uri == personURI, found[uri] == nil {
                found[uri] = itemID
            }
        }
        var sources: [String: MatteSource] = [:]
        for (uri, itemID) in found {
            func box(_ type: String) throws -> Bytes? {
                try HEIF.propertyBytes(
                    data,
                    table: discovery.properties,
                    itemID: itemID,
                    type: type
                )
            }
            guard let ispe = try box("ispe"), let pixi = try box("pixi"),
                  let hvcC = try box("hvcC") else { return nil }
            sources[uri] = MatteSource(
                payload: try HEIF.extractItem(data, locations: discovery.locations, itemID: itemID),
                ispe: ispe,
                pixi: pixi,
                hvcC: hvcC
            )
        }
        guard let skin = sources[skinURI], let person = sources[personURI] else { return nil }
        let dimensions = HEIF.dimensions(discovery.properties, itemID: discovery.primary)
        guard let width = dimensions.0, let height = dimensions.1 else { return nil }
        let irot = try HEIF.rotationAngle(
            data,
            table: discovery.properties,
            itemID: discovery.primary
        )
        var mattes: [String: MatteSource] = [softSkinPersonURI: person]
        for uri in softSkinSkinURIs { mattes[uri] = skin }
        return People(
            faces: faces.count,
            entries: faces.enumerated().map {
                peopleEntry($0.element, index: $0.offset, irot: irot, width: width, height: height)
            },
            mattes: mattes,
            instances: faces.indices.map { (softSkinInstanceKeys[$0], person) }
        )
    }

    /// The texture_styles plist: the native header with the photo's grain seed, plus the
    /// people entries when there are any. Without either it is the native 216-byte record.
    static func stylesPayload(people: People?, grainSeed: Int?) throws -> Bytes {
        if people == nil && grainSeed == nil { return AppleBytes.textureStylesBlob }
        var root: [(String, BinaryPlistValue)] = []
        for (key, value) in textureStylesHeader {
            if key == "FilmGrainSeed", let grainSeed {
                root.append((key, .integer(Int64(grainSeed))))
            } else {
                root.append((key, value))
            }
            if key == "CaptureMode", let people {
                root.append(("TextureStylePostProcessedPeopleData", .array(people.entries)))
            }
        }
        return try BinaryPlist.build(.dictionary(root))
    }

    static func instanceXMP(key: String) -> Bytes {
        let xmp = String(decoding: matteXMP, as: UTF8.self)
        let marker = "         <fsincMattes:FSINCMatteVersion>"
        return Bytes(xmp.replacingOccurrences(
            of: marker,
            with: "         <fsincMattes:InstanceMaskReferenceKey>\(key)"
                + "</fsincMattes:InstanceMaskReferenceKey>\n" + marker
        ).utf8)
    }

    static func hasTexture(_ infos: [Int: HEIF.ItemInfo]) -> Bool {
        infos.values.contains { $0.uri == textureStylesURI }
    }

    /// Add every missing 2026 matte (with its XMP sidecar) and the texture_styles item; with
    /// people, also what Soft Skin needs. Returns the new meta, the new payloads and a summary.
    static func addItems(
        to meta: Bytes,
        primary: Int,
        people: People?,
        grainSeed: Int?
    ) throws -> (Bytes, [Int: Bytes], String) {
        var meta = meta
        let initial = try HEIF.parseProperties(meta, meta: topBox(meta, type: "meta"))
        guard initial.flags & 1 == 0 else {
            throw StylePortError.invalidData(
                "Wide ipma is not supported for adding Texture/Grain items."
            )
        }
        let infos = try HEIF.parseItemInfo(meta, meta: topBox(meta, type: "meta"))
        let present = Set(infos.keys.compactMap { HEIF.auxiliaryURI(initial, itemID: $0) })
        let missing = matte2026URIs.filter { !present.contains($0) }
        let targets = [primary] + HEIF.items(ofType: "tmap", in: infos).prefix(1)
        let irot = HEIF.property(initial, itemID: primary, type: "irot")
        var payloads: [Int: Bytes] = [:]

        // A source matte's ispe/pixi/hvcC are appended once, then shared by every item using it.
        var sourceProperties: [ObjectIdentifier: [Int]] = [:]
        func sourceAssociations(_ source: MatteSource) throws -> [Int] {
            if let existing = sourceProperties[ObjectIdentifier(source)] { return existing }
            var indices: [Int] = []
            for box in [source.ispe, source.pixi, source.hvcC] {
                let appended = try HEIF.appendProperty(in: meta, box: box)
                meta = appended.0
                indices.append(appended.1)
            }
            sourceProperties[ObjectIdentifier(source)] = indices
            return indices
        }
        func associations(_ ispe: Int, _ pixi: Int, _ auxC: Int, _ hvcC: Int) -> [(Int, Bool)] {
            // auxC (descriptive) must precede irot (transformative): native order.
            var result = [(ispe, false), (pixi, false), (auxC, true), (hvcC, true)]
            if let irot { result.append((irot.index, true)) }
            return result
        }

        if !missing.isEmpty {
            var appended = try HEIF.appendProperty(in: meta, box: AppleBytes.matteIspe)
            meta = appended.0
            let ispeIndex = appended.1
            appended = try HEIF.appendProperty(in: meta, box: AppleBytes.mattePixi)
            meta = appended.0
            let pixiIndex = appended.1
            appended = try HEIF.appendProperty(in: meta, box: AppleBytes.matteHvcc)
            meta = appended.0
            let hvccIndex = appended.1

            var specs: [HEIF.ItemSpec] = []
            var filled: [String: Bytes] = [:]
            for uri in missing {
                var indices = [ispeIndex, pixiIndex, hvccIndex]
                if let source = people?.mattes[uri] {
                    indices = try sourceAssociations(source)
                    filled[uri] = source.payload
                }
                appended = try HEIF.appendProperty(in: meta, box: HEIF.auxiliaryTypeBox(uri))
                meta = appended.0
                specs.append(HEIF.ItemSpec(
                    key: uri,
                    uri: nil,
                    referenceType: "auxl",
                    referenceTargets: targets,
                    reusedProperties: associations(indices[0], indices[1], appended.1, indices[2])
                ))
            }
            let mattes = try HEIF.addItems(to: meta, specs: specs)
            meta = mattes.0
            for (uri, itemID) in mattes.1 {
                payloads[itemID] = filled[uri] ?? AppleBytes.matteEmpty
            }
            let sidecars = try HEIF.addItems(to: meta, specs: missing.map { uri in
                HEIF.ItemSpec(
                    key: "xmp:\(uri)",
                    uri: nil,
                    itemType: "mime",
                    contentType: "application/rdf+xml",
                    referenceType: "cdsc",
                    referenceTargets: [mattes.1[uri]!]
                )
            })
            meta = sidecars.0
            for itemID in sidecars.1.values { payloads[itemID] = matteXMP }
        }

        let texture = try HEIF.addItems(to: meta, specs: [HEIF.ItemSpec(
            key: "texture",
            uri: nil,
            itemType: "uri ",
            itemName: "metadata",
            contentType: textureStylesURI,
            referenceType: "cdsc",
            referenceTargets: targets
        )])
        meta = texture.0
        let textureItem = texture.1["texture"]!
        payloads[textureItem] = try stylesPayload(people: people, grainSeed: grainSeed)
        var summary = "added #\(textureItem) -> \(targets), \(missing.count) 2026 mattes"

        if let people {
            let appended = try HEIF.appendProperty(
                in: meta,
                box: HEIF.auxiliaryTypeBox(personInstancesURI)
            )
            meta = appended.0
            var specs: [HEIF.ItemSpec] = []
            for (index, instance) in people.instances.enumerated() {
                let indices = try sourceAssociations(instance.1)
                specs.append(HEIF.ItemSpec(
                    key: "instance\(index)",
                    uri: nil,
                    referenceType: "auxl",
                    referenceTargets: targets,
                    reusedProperties: associations(indices[0], indices[1], appended.1, indices[2])
                ))
            }
            let instances = try HEIF.addItems(to: meta, specs: specs)
            meta = instances.0
            let sidecars = try HEIF.addItems(to: meta, specs: people.instances.indices.map {
                HEIF.ItemSpec(
                    key: "xmp\($0)",
                    uri: nil,
                    itemType: "mime",
                    contentType: "application/rdf+xml",
                    referenceType: "cdsc",
                    referenceTargets: [instances.1["instance\($0)"]!]
                )
            })
            meta = sidecars.0
            for (index, instance) in people.instances.enumerated() {
                payloads[instances.1["instance\(index)"]!] = instance.1.payload
                payloads[sidecars.1["xmp\(index)"]!] = instanceXMP(key: instance.0)
            }
            summary += ", Soft Skin for \(people.faces) face(s)"
        }
        return (meta, payloads, summary)
    }

    /// Native iPhone 16/17 style photo -> the same photo plus Texture/Grain. Nothing is
    /// ported: existing payloads stay byte-identical, meta grows and every extent offset
    /// moves with it, and the new payloads go into one mdat appended at the end.
    static func addTexture(to data: Bytes) throws -> (Bytes, String) {
        let discovery = try HEIF.discover(data)
        guard discovery.stylesItem != nil else {
            throw StylePortError.invalidData("The photo has no native Photographic Style.")
        }
        guard !hasTexture(discovery.infos) else { throw StylePortError.alreadyHasTexture }
        let locations = discovery.locations
        guard locations.version == 1, locations.offsetSize == 4, locations.lengthSize == 4,
              locations.baseOffsetSize == 0, locations.indexSize == 0 else {
            throw StylePortError.invalidData("Unsupported iloc layout.")
        }
        let iref = try findChild(metaChildren(data, meta: discovery.meta), type: "iref")
        guard data[iref.offset + iref.headerSize] == 0 else {
            throw StylePortError.invalidData("Unsupported iref version.")
        }
        let metaOffset = discovery.meta.offset
        let metaSize = discovery.meta.size
        let external = locations.items.filter {
            $0.value.constructionMethod == 0 && !$0.value.extents.isEmpty
        }
        for location in external.values {
            for extent in location.extents where extent.offset < metaOffset + metaSize {
                throw StylePortError.invalidData("An item payload sits before the end of meta.")
            }
        }

        let added = try addItems(
            to: byteSlice(data, metaOffset, metaSize),
            primary: discovery.primary,
            people: softSkinPeople(data, discovery),
            grainSeed: filmGrainSeed(data, discovery)
        )
        let newMeta = added.0
        let delta = newMeta.count - metaSize
        var outputMeta = newMeta
        let newLocations = try HEIF.parseLocations(outputMeta, meta: topBox(outputMeta, type: "meta"))
        let tail = Array(data[(metaOffset + metaSize)...])
        let cursor = metaOffset + newMeta.count + tail.count + 8
        var extra = Bytes()
        for itemID in added.1.keys.sorted() {
            guard let extent = newLocations.items[itemID]?.extents.first,
                  let payload = added.1[itemID] else { continue }
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
        }
        guard cursor + extra.count < 1 << 32 else {
            throw StylePortError.invalidData("File too large for 32-bit offsets.")
        }
        for (itemID, location) in newLocations.items where external[itemID] != nil {
            for extent in location.extents {
                try writeBytes(
                    bigEndianBytes(extent.offset + delta, count: 4),
                    into: &outputMeta,
                    at: extent.offsetPosition
                )
            }
        }
        let result = concatenated([
            Array(data[0..<metaOffset]),
            outputMeta,
            tail,
            bigEndianBytes(8 + extra.count, count: 4),
            Bytes("mdat".utf8),
            extra
        ])

        // Self-check: every original payload byte-identical, every new one readable.
        let check = try HEIF.discover(result)
        for itemID in external.keys {
            guard try HEIF.extractItem(result, locations: check.locations, itemID: itemID)
                    == HEIF.extractItem(data, locations: locations, itemID: itemID) else {
                throw StylePortError.invalidData("Self-check failed: item \(itemID) changed.")
            }
        }
        for (itemID, payload) in added.1 {
            guard try HEIF.extractItem(result, locations: check.locations, itemID: itemID)
                    == payload else {
                throw StylePortError.invalidData("Self-check failed: item \(itemID) unreadable.")
            }
        }
        return (result, added.2)
    }
}
