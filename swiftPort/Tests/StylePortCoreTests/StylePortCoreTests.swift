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
}
