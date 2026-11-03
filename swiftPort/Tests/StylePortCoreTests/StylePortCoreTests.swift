import XCTest
@testable import StylePortCore

final class StylePortCoreTests: XCTestCase {
    func testBundledProfilesLoad() throws {
        let profile45 = try DonorProfileLoader.load(named: "45-15")
        XCTAssertEqual(profile45.manifest.primaryTileCount, 45)
        XCTAssertEqual(profile45.manifest.hdrTileCount, 15)
        XCTAssertFalse(profile45.retainedPayloads.isEmpty)
        XCTAssertEqual(try topBox(profile45.fileTypeBox, type: "ftyp").type, "ftyp")
        XCTAssertEqual(try topBox(profile45.metadataBox, type: "meta").type, "meta")

        let profile48 = try DonorProfileLoader.load(named: "48-12")
        XCTAssertEqual(profile48.manifest.primaryTileCount, 48)
        XCTAssertEqual(profile48.manifest.hdrTileCount, 12)
        XCTAssertFalse(profile48.retainedPayloads.isEmpty)
    }

    func testBinaryPlistRoundTrip() throws {
        let source: BinaryPlistValue = .dictionary([
            ("name", .string("StylePort")),
            ("count", .integer(42)),
            ("enabled", .bool(true)),
            ("samples", .array([.real(0.25), .real(0.75)])),
            ("bytes", .data([0xde, 0xad, 0xbe, 0xef]))
        ])
        let rebuilt = try BinaryPlist.build(source)
        guard case .dictionary(let root) = try BinaryPlist.parse(rebuilt) else {
            return XCTFail("Expected a dictionary root.")
        }
        guard case .string(let name)? = root.first(where: { $0.0 == "name" })?.1,
              case .integer(let count)? = root.first(where: { $0.0 == "count" })?.1,
              case .bool(let enabled)? = root.first(where: { $0.0 == "enabled" })?.1 else {
            return XCTFail("Round-tripped fields were missing.")
        }
        XCTAssertEqual(name, "StylePort")
        XCTAssertEqual(count, 42)
        XCTAssertTrue(enabled)
    }

    func testLivePhotoStylesSchema() throws {
        for name in ["45-15", "48-12"] {
            let profile = try DonorProfileLoader.load(named: name)
            let styles = try XCTUnwrap(profile.retainedPayloads[profile.manifest.donorStylesItem])
            let changed = try BinaryPlist.setStylesSchema(in: styles, to: StylePorter.livePhotoStylesSchema)
            XCTAssertEqual(changed.1, 14)
            guard case .dictionary(let root) = try BinaryPlist.parse(changed.0),
                  case .dictionary(let before) = try BinaryPlist.parse(styles),
                  case .integer(let schema)? = root.first(where: { $0.0 == "0" })?.1 else {
                return XCTFail("Styles key 0 was missing.")
            }
            XCTAssertEqual(schema, 16)
            XCTAssertEqual(root.map(\.0), before.map(\.0))
        }
    }

    func testISOBoxParsing() throws {
        let fileType = makeBox("ftyp", payload: Array("heic\0\0\0\0".utf8))
        let mediaData = makeBox("mdat", payload: [1, 2, 3, 4])
        let bytes = fileType + mediaData
        let boxes = try siblingBoxes(bytes, from: 0, to: bytes.count)
        XCTAssertEqual(boxes.map(\.type), ["ftyp", "mdat"])
        XCTAssertEqual(boxes.map(\.size), [fileType.count, mediaData.count])
    }

    func testUnsupportedTileLayoutIsRejected() {
        XCTAssertThrowsError(try DonorProfileLoader.profile(primaryTiles: 1, hdrTiles: 1)) {
            XCTAssertEqual($0 as? StylePortError, .unsupportedPhoto)
        }
    }

    func testLivePhotoVideoTemplateHasEveryPart() throws {
        let template = try Movie(LivePhotoVideoTemplate.bytes())
        let parts = try LivePhotoVideo.parts(of: Data(template.data))
        XCTAssertEqual(parts, [.linearThumbnail, .mattes, .styleInfo, .textureInfo])
        for tag in LivePhotoVideo.matteTags {
            XCTAssertEqual(try template.samples(template.requiredTrack(tagged: tag)).count, 1)
        }
    }

    #if canImport(AVFoundation) && canImport(VideoToolbox)
    /// Adds every style part to the Live Photo video STYLEPORT_LIVE_VIDEO and writes it to
    /// STYLEPORT_OUT, for checking with movdump.py and on a phone. Skipped unless both are set.
    func testWriteStyledLivePhotoVideo() async throws {
        let environment = ProcessInfo.processInfo.environment
        guard let input = environment["STYLEPORT_LIVE_VIDEO"],
              let output = environment["STYLEPORT_OUT"] else {
            throw XCTSkip("Set STYLEPORT_LIVE_VIDEO and STYLEPORT_OUT to style a video.")
        }
        let url = URL(fileURLWithPath: input)
        let video = try Data(contentsOf: url)
        let thumbnail = try await LinearThumbnailEncoder.encode(videoURL: url)
        XCTAssertEqual(thumbnail.samples.count, try LivePhotoVideo.frameCount(of: video))
        XCTAssertEqual(thumbnail.syncSamples.first, 0)
        let styled = try LivePhotoVideo.add(
            [.linearThumbnail, .mattes, .styleInfo, .textureInfo],
            to: video,
            linearThumbnail: thumbnail
        )
        XCTAssertEqual(styled.1, [.linearThumbnail, .mattes, .styleInfo, .textureInfo])
        XCTAssertEqual(try LivePhotoVideo.parts(of: styled.0), [.linearThumbnail, .mattes, .styleInfo, .textureInfo])
        let moov = try Movie(video.stylePortBytes).moov.offset
        XCTAssertEqual(styled.0.prefix(moov), video.prefix(moov), "the payloads before moov stay as they are")
        // Adding again changes nothing.
        XCTAssertEqual(try LivePhotoVideo.add(.style, to: styled.0, linearThumbnail: nil).1, [])
        try styled.0.write(to: URL(fileURLWithPath: output).appendingPathComponent(url.lastPathComponent))
    }
    #endif

    /// Writes the port of every HEIC in STYLEPORT_FIXTURES to STYLEPORT_OUT, for comparing
    /// with photographic_style_port.py byte for byte. Skipped unless both are set.
    func testWriteReferenceComparisons() throws {
        let environment = ProcessInfo.processInfo.environment
        guard let input = environment["STYLEPORT_FIXTURES"],
              let output = environment["STYLEPORT_OUT"] else {
            throw XCTSkip("Set STYLEPORT_FIXTURES and STYLEPORT_OUT to compare with Python.")
        }
        let porter = StylePorter()
        let options = StylePortOptions(analyzePhoto: false, texture: true)
        let files = try FileManager.default.contentsOfDirectory(atPath: input)
            .filter { $0.lowercased().hasSuffix(".heic") }
        for name in files.sorted() {
            let data = try Data(contentsOf: URL(fileURLWithPath: input).appendingPathComponent(name))
            let base = URL(fileURLWithPath: output).appendingPathComponent(name)
            do {
                let result = try porter.patch(data, options: options)
                try result.data.write(to: base.appendingPathExtension("swift.heic"))
                if result.report.mode == .photoGraph {
                    let bytes = [UInt8](data)
                    let target = try HEIF.discover(bytes)
                    let profile = try DonorProfileLoader.profile(
                        primaryTiles: target.primaryTiles.count,
                        hdrTiles: target.hdrTiles.count
                    )
                    let donor = try porter.patchOnDonorGraph(
                        bytes,
                        target: target,
                        profile: profile,
                        options: options
                    )
                    try donor.data.write(to: base.appendingPathExtension("swift-donor.heic"))
                }
            } catch {
                try Data("\(error)".utf8).write(to: base.appendingPathExtension("swift-error.txt"))
            }
        }
    }

    /// Any Image keeps the source's own Exif (camera, dates, location) in either byte order, makes
    /// it upright at the new size, and gives it an Apple MakerNote the style record can go into.
    func testConversionCarriesSourceExif() throws {
        for little in [true, false] {
            func put(_ value: Int, _ count: Int) -> [UInt8] {
                let big = (0..<count).map { UInt8((value >> (8 * (count - 1 - $0))) & 0xFF) }
                return little ? big.reversed() : big
            }
            let make = Array("Canon\0".utf8)
            let date = Array("2024:05:01 10:20:30\0".utf8)
            let ifd0 = 8
            let makeAt = ifd0 + 2 + 3 * 12 + 4
            let exifAt = makeAt + make.count
            let dateAt = exifAt + 2 + 12 + 4
            var tiff = Array((little ? "II" : "MM").utf8) + put(42, 2) + put(ifd0, 4) + put(3, 2)
            tiff += put(0x010F, 2) + put(2, 2) + put(make.count, 4) + put(makeAt, 4)
            tiff += put(0x0112, 2) + put(3, 2) + put(1, 4) + put(6, 2) + [0, 0]
            tiff += put(0x8769, 2) + put(4, 2) + put(1, 4) + put(exifAt, 4) + put(0, 4) + make
            tiff += put(1, 2) + put(0x9003, 2) + put(2, 2) + put(date.count, 4) + put(dateAt, 4) + put(0, 4)
            tiff += date

            let carried = try XCTUnwrap(RasterImport.carryExif(tiff: tiff, width: 1024, height: 768))
            XCTAssertEqual(Array(carried.prefix(10)), [0, 0, 0, 6] + Array("Exif".utf8) + [0, 0])
            let out = Array(carried.dropFirst(10))
            func get(_ offset: Int, _ count: Int) -> Int {
                let bytes = Array(out[offset..<(offset + count)])
                return (little ? bytes.reversed() : bytes).reduce(0) { $0 << 8 | Int($1) }
            }
            func entries(_ offset: Int) -> [Int: Int] {
                Dictionary(uniqueKeysWithValues: (0..<get(offset, 2)).map {
                    (get(offset + 2 + 12 * $0, 2), offset + 2 + 12 * $0)
                })
            }
            let root = entries(get(4, 4))
            XCTAssertEqual(get(try XCTUnwrap(root[0x0112]) + 8, 2), 1)
            let makeOffset = get(try XCTUnwrap(root[0x010F]) + 8, 4)
            XCTAssertEqual(Array(out[makeOffset..<(makeOffset + 5)]), Array("Canon".utf8))
            let exif = entries(get(try XCTUnwrap(root[0x8769]) + 8, 4))
            XCTAssertEqual(get(try XCTUnwrap(exif[0xA002]) + 8, 4), 1024)
            XCTAssertEqual(get(try XCTUnwrap(exif[0xA003]) + 8, 4), 768)
            let dateOffset = get(try XCTUnwrap(exif[0x9003]) + 8, 4)
            XCTAssertEqual(Array(out[dateOffset..<(dateOffset + date.count)]), date)

            XCTAssertNil(try AppleExif.makerNoteTag(in: carried, tag: 0x54))
            let styled = try AppleExif.injectMakerNoteTag(into: carried, payload: [1, 2, 3, 4, 5, 6])
            XCTAssertEqual(try AppleExif.makerNoteTag(in: styled, tag: 0x54), [1, 2, 3, 4, 5, 6])

            let jpeg: [UInt8] = [0xFF, 0xD8, 0xFF, 0xE1] + bigEndianBytes(2 + 6 + tiff.count, count: 2)
                + Array("Exif".utf8) + [0, 0] + tiff + [0xFF, 0xDA, 0, 2, 0xFF, 0xD9]
            XCTAssertEqual(RasterImport.sourceTIFF(in: jpeg), tiff)
        }
        XCTAssertNil(RasterImport.carryExif(tiff: Array("not a tiff".utf8), width: 8, height: 8))
    }

    #if canImport(Vision)
    /// Faces and masks found on the upright picture land on the photo's own (stored) pixels for
    /// every irot, and the generated mattes have the native 768x576 shape.
    func testDetectedPeopleGeometry() {
        XCTAssertTrue(PeopleDetection.matteSize(width: 4032, height: 3024) == (768, 576))
        XCTAssertTrue(PeopleDetection.matteSize(width: 3024, height: 4032) == (576, 768))
        XCTAssertTrue(PeopleDetection.matteSize(width: 1920, height: 1080) == (768, 432))

        // Stored 3x2 pixels 0...5, turned anticlockwise by irot into the upright picture.
        let stored: [UInt8] = [0, 1, 2, 3, 4, 5]
        let upright: [Int: (Int, Int, [UInt8])] = [
            0: (3, 2, [0, 1, 2, 3, 4, 5]),
            90: (2, 3, [2, 5, 1, 4, 0, 3]),
            180: (3, 2, [5, 4, 3, 2, 1, 0]),
            270: (2, 3, [3, 0, 4, 1, 5, 2])
        ]
        for (irot, (width, height, pixels)) in upright {
            XCTAssertEqual(PeopleDetection.toStored(pixels, channels: 1, uprightWidth: width,
                                                    uprightHeight: height, irot: irot), stored, "irot \(irot)")
            for y in 0..<height {
                for x in 0..<width {
                    let point = PeopleDetection.storedPoint((Double(x) + 0.5) / Double(width),
                                                            (Double(y) + 0.5) / Double(height), irot: irot)
                    let index = Int(point.1 * 2) * 3 + Int(point.0 * 3)
                    XCTAssertEqual(stored[index], pixels[y * width + x], "irot \(irot) at \(x),\(y)")
                }
            }
            let face = PeopleDetection.storedFace(box: CGRect(x: 0.1, y: 0.2, width: 0.3, height: 0.4),
                                                  yaw: nil, roll: 0, irot: irot)
            XCTAssertEqual(face.roll, Double(irot))
            XCTAssertEqual(face.w, irot % 180 == 0 ? 0.3 : 0.4, accuracy: 1e-9)
        }

        // Whether this system's ImageIO writes a matte as one image, as Photos stores them.
        let gradient = (0..<(768 * 576)).map { UInt8($0 % 768 / 3) }
        if let matte = PeopleDetection.encodeMatte(gradient, width: 768, height: 576) {
            XCTAssertEqual(Array(matte.ispe.suffix(8)), bigEndianBytes(768, count: 4) + bigEndianBytes(576, count: 4))
            print("encodeMatte: hvcC", matte.hvcC.prefix(32).map { String(format: "%02x", $0) }.joined(),
                  "pixi", matte.pixi.map { String(format: "%02x", $0) }.joined(), "bytes", matte.payload.count)
        } else {
            print("encodeMatte: no single-image matte from ImageIO on this system")
        }
    }
    #endif
}
