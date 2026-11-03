#if canImport(Vision)
import CoreGraphics
import CoreVideo
import Foundation
import ImageIO
import UniformTypeIdentifiers
import Vision

/// Experimental, off by default (`StylePortOptions.detectPeople`): what Soft Skin needs, for a
/// photo that lacks Apple's own people data. Apple's Vision framework finds the faces and the
/// person matte on the device, and a skin matte is estimated from each face's colour inside the
/// person matte. Nothing leaves the device, but none of it comes from the camera: it is
/// estimated, which is why it stays experimental. Whatever the photo has itself (face regions,
/// skin matte, Portrait matte) is used instead of an estimate.
enum PeopleDetection {
    struct Found {
        let faces: [Texture.Face]
        let skin: Texture.MatteSource
        let person: Texture.MatteSource
    }

    /// The long edge of a generated matte; iOS 27's own 2026 mattes are 768x576.
    static let matteLongEdge = 768
    /// Vision works on a downscaled, upright copy of the photo.
    static let analysisEdge = 1536

    /// Why nothing was estimated; shown in the Texture summary so a skipped estimate is not silent.
    enum Failure: Error {
        case unreadable
        case visionFailed
        case noFace
        case segmentation
        case mattePixels
        case skinEncoding
        case personEncoding
        case modelsMissing
        case engine(String)

        var message: String {
            switch self {
            case .unreadable: return "could not read the picture"
            case .visionFailed: return "Vision could not analyse the picture"
            case .noFace: return "no face found"
            case .segmentation: return "person segmentation failed"
            case .mattePixels: return "could not prepare the mattes"
            case .skinEncoding: return "this iOS would not write the skin matte"
            case .personEncoding: return "this iOS would not write the person matte"
            case .modelsMissing: return "the Find Faces models are not in the app"
            case .engine(let detail): return "MediaPipe failed: \(detail)"
            }
        }
    }

    /// `faces`: the photo's own face regions, if it has any (then no faces are detected).
    static func detect(
        _ data: Bytes,
        irot: Int,
        width: Int,
        height: Int,
        faces knownFaces: [Texture.Face]
    ) -> Result<Found, Failure> {
        guard [0, 90, 180, 270].contains(irot), width > 0, height > 0,
              let upright = uprightImage(data) else { return .failure(.unreadable) }
        #if canImport(MediaPipeTasksVision) && canImport(UIKit)
        // The same method as the command line's --find-faces, when its models are bundled.
        if MediaPipeFaces.available {
            return MediaPipeFaces.detect(upright: upright, irot: irot, width: width, height: height,
                                         known: knownFaces)
        }
        #endif
        let handler = VNImageRequestHandler(cgImage: upright, options: [:])
        var faces = knownFaces
        if faces.isEmpty {
            let request = VNDetectFaceRectanglesRequest()
            request.revision = VNDetectFaceRectanglesRequestRevision3
            guard (try? handler.perform([request])) != nil else { return .failure(.visionFailed) }
            faces = (request.results ?? [])
                .filter { $0.confidence >= 0.5 && min($0.boundingBox.width, $0.boundingBox.height) >= 0.03 }
                .sorted { $0.boundingBox.width * $0.boundingBox.height > $1.boundingBox.width * $1.boundingBox.height }
                .prefix(Texture.softSkinInstanceKeys.count)
                .map { storedFace(box: $0.boundingBox, yaw: $0.yaw?.doubleValue, roll: $0.roll?.doubleValue, irot: irot) }
        }
        guard !faces.isEmpty else { return .failure(.noFace) }

        let segmentation = VNGeneratePersonSegmentationRequest()
        segmentation.qualityLevel = .accurate
        segmentation.outputPixelFormat = kCVPixelFormatType_OneComponent8
        guard (try? handler.perform([segmentation])) != nil,
              let mask = segmentation.results?.first?.pixelBuffer else { return .failure(.segmentation) }

        let (matteWidth, matteHeight) = matteSize(width: width, height: height)
        let turned = irot % 180 != 0
        let (uprightWidth, uprightHeight) = turned ? (matteHeight, matteWidth) : (matteWidth, matteHeight)
        guard let uprightPerson = grayPixels(of: mask, width: uprightWidth, height: uprightHeight),
              let uprightColour = pixels(of: upright, width: uprightWidth, height: uprightHeight, channels: 4)
        else { return .failure(.mattePixels) }
        let person = toStored(uprightPerson, channels: 1, uprightWidth: uprightWidth,
                              uprightHeight: uprightHeight, irot: irot)
        let colour = toStored(uprightColour, channels: 4, uprightWidth: uprightWidth,
                              uprightHeight: uprightHeight, irot: irot)
        let skin = skinMatte(colour: colour, person: person, width: matteWidth, height: matteHeight, faces: faces)
        guard let skinSource = encodeMatte(skin, width: matteWidth, height: matteHeight) else {
            return .failure(.skinEncoding)
        }
        guard let personSource = encodeMatte(person, width: matteWidth, height: matteHeight) else {
            return .failure(.personEncoding)
        }
        return .success(Found(faces: faces, skin: skinSource, person: personSource))
    }

    // MARK: Geometry (stored orientation is the photo's pixels before irot)

    /// A matte at the photo's aspect with the long edge native mattes have; even sides.
    static func matteSize(width: Int, height: Int) -> (Int, Int) {
        let long = matteLongEdge
        let short = max(2, Int((Double(long) * Double(min(width, height)) / Double(max(width, height)) / 2).rounded()) * 2)
        return width >= height ? (long, short) : (short, long)
    }

    /// An upright (displayed) normalized point, top-left origin, in stored orientation. irot
    /// turns the stored pixels anticlockwise into the displayed picture.
    static func storedPoint(_ x: Double, _ y: Double, irot: Int) -> (Double, Double) {
        switch irot {
        case 90: return (1 - y, x)
        case 180: return (1 - x, 1 - y)
        case 270: return (y, 1 - x)
        default: return (x, y)
        }
    }

    /// A Vision face (normalized, bottom-left origin, upright) as the photo's MWG face region
    /// would give it: centre and size in stored orientation, angles in degrees as Apple's
    /// AngleInfoYaw / AngleInfoRoll, whose roll includes the photo's rotation.
    static func storedFace(box: CGRect, yaw: Double?, roll: Double?, irot: Int) -> Texture.Face {
        let (x, y) = storedPoint(Double(box.midX), 1 - Double(box.midY), irot: irot)
        let turned = irot % 180 != 0
        let w = Double(turned ? box.height : box.width)
        let h = Double(turned ? box.width : box.height)
        let degrees = 180 / Double.pi
        return Texture.Face(
            x: x, y: y, w: w, h: h,
            yaw: (yaw ?? 0) * degrees,
            roll: Double(irot) - (roll ?? 0) * degrees
        )
    }

    /// Upright pixels turned back into stored orientation.
    static func toStored(
        _ pixels: [UInt8],
        channels: Int,
        uprightWidth: Int,
        uprightHeight: Int,
        irot: Int
    ) -> [UInt8] {
        guard irot != 0 else { return pixels }
        let turned = irot % 180 != 0
        let width = turned ? uprightHeight : uprightWidth
        let height = turned ? uprightWidth : uprightHeight
        var out = [UInt8](repeating: 0, count: pixels.count)
        for y in 0..<height {
            for x in 0..<width {
                let (dx, dy): (Int, Int)
                switch irot {
                case 90: (dx, dy) = (y, width - 1 - x)
                case 180: (dx, dy) = (width - 1 - x, height - 1 - y)
                default: (dx, dy) = (height - 1 - y, x)
                }
                let from = (dy * uprightWidth + dx) * channels
                let to = (y * width + x) * channels
                for channel in 0..<channels { out[to + channel] = pixels[from + channel] }
            }
        }
        return out
    }

    // MARK: Skin

    /// Skin inside the person matte: how close each pixel's chroma is to the faces' own skin
    /// colour, sampled from the middle of each face.
    static func skinMatte(colour: [UInt8], person: [UInt8], width: Int, height: Int, faces: [Texture.Face]) -> [UInt8] {
        func chroma(_ index: Int) -> (luma: Double, cb: Double, cr: Double) {
            let r = Double(colour[index * 4]), g = Double(colour[index * 4 + 1]), b = Double(colour[index * 4 + 2])
            return (0.299 * r + 0.587 * g + 0.114 * b,
                    128 - 0.168736 * r - 0.331264 * g + 0.5 * b,
                    128 + 0.5 * r - 0.418688 * g - 0.081312 * b)
        }
        struct Model { let cb: Double; let cr: Double; let sb: Double; let sr: Double }
        var models: [Model] = []
        for face in faces {
            // The middle of the box (nose and cheeks) in any orientation.
            let x0 = max(0, Int((face.x - face.w * 0.18) * Double(width)))
            let x1 = min(width, Int((face.x + face.w * 0.18) * Double(width)))
            let y0 = max(0, Int((face.y - face.h * 0.18) * Double(height)))
            let y1 = min(height, Int((face.y + face.h * 0.18) * Double(height)))
            var n = 0.0, sb = 0.0, sr = 0.0, qb = 0.0, qr = 0.0
            for y in y0..<max(y0, y1) {
                for x in x0..<max(x0, x1) {
                    let index = y * width + x
                    let c = chroma(index)
                    guard c.luma > 30, c.luma < 245 else { continue }
                    n += 1; sb += c.cb; sr += c.cr; qb += c.cb * c.cb; qr += c.cr * c.cr
                }
            }
            guard n >= 16 else { continue }
            let mb = sb / n, mr = sr / n
            models.append(Model(
                cb: mb, cr: mr,
                sb: max(4, (max(0, qb / n - mb * mb)).squareRoot() * 1.5),
                sr: max(4, (max(0, qr / n - mr * mr)).squareRoot() * 1.5)
            ))
        }
        var skin = [UInt8](repeating: 0, count: width * height)
        guard !models.isEmpty else { return skin }
        for index in 0..<(width * height) where person[index] > 0 {
            let c = chroma(index)
            guard c.luma > 20 else { continue }
            var best = 0.0
            for model in models {
                let db = (c.cb - model.cb) / model.sb, dr = (c.cr - model.cr) / model.sr
                best = max(best, exp(-0.5 * (db * db + dr * dr)))
            }
            let likelihood = min(1, max(0, (best - 0.1) / 0.5))
            skin[index] = UInt8((likelihood * Double(person[index])).rounded())
        }
        return blurred(skin, width: width, height: height)
    }

    /// A 3x3 box blur, which softens the per-pixel colour decision.
    static func blurred(_ pixels: [UInt8], width: Int, height: Int) -> [UInt8] {
        var out = pixels
        for y in 0..<height {
            for x in 0..<width {
                var sum = 0, count = 0
                for dy in -1...1 {
                    let yy = y + dy
                    guard yy >= 0, yy < height else { continue }
                    for dx in -1...1 {
                        let xx = x + dx
                        guard xx >= 0, xx < width else { continue }
                        sum += Int(pixels[yy * width + xx])
                        count += 1
                    }
                }
                out[y * width + x] = UInt8(sum / count)
            }
        }
        return out
    }

    // MARK: Pixels

    /// The photo upright (irot applied), downscaled for Vision.
    static func uprightImage(_ data: Bytes) -> CGImage? {
        guard let source = CGImageSourceCreateWithData(Data(data) as CFData, nil) else { return nil }
        return CGImageSourceCreateThumbnailAtIndex(source, CGImageSourceGetPrimaryImageIndex(source), [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: analysisEdge,
            kCGImageSourceShouldCacheImmediately: true
        ] as CFDictionary)
    }

    /// `image` drawn at the given size, 8 bits per channel: grey (1) or RGBX (4).
    static func pixels(of image: CGImage, width: Int, height: Int, channels: Int) -> [UInt8]? {
        var buffer = [UInt8](repeating: 0, count: width * height * channels)
        let drawn = buffer.withUnsafeMutableBytes { raw -> Bool in
            let space = channels == 1 ? CGColorSpaceCreateDeviceGray() : CGColorSpace(name: CGColorSpace.sRGB)
            guard let space, let context = CGContext(
                data: raw.baseAddress, width: width, height: height, bitsPerComponent: 8,
                bytesPerRow: width * channels, space: space,
                bitmapInfo: channels == 1 ? CGImageAlphaInfo.none.rawValue : CGImageAlphaInfo.noneSkipLast.rawValue
            ) else { return false }
            context.interpolationQuality = .medium
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
            return true
        }
        return drawn ? buffer : nil
    }

    /// Vision's one-channel mask scaled to the given size.
    static func grayPixels(of mask: CVPixelBuffer, width: Int, height: Int) -> [UInt8]? {
        CVPixelBufferLockBaseAddress(mask, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(mask, .readOnly) }
        guard CVPixelBufferGetPixelFormatType(mask) == kCVPixelFormatType_OneComponent8,
              let base = CVPixelBufferGetBaseAddress(mask),
              let context = CGContext(
                data: base, width: CVPixelBufferGetWidth(mask), height: CVPixelBufferGetHeight(mask),
                bitsPerComponent: 8, bytesPerRow: CVPixelBufferGetBytesPerRow(mask),
                space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue
              ),
              let image = context.makeImage() else { return nil }
        return pixels(of: image, width: width, height: height, channels: 1)
    }

    // MARK: Encoding

    /// One matte as a single monochrome HEVC image, the way Apple stores its mattes: ImageIO
    /// writes it as a skin matte next to a tiny primary, and its item is taken from there.
    /// nil when this system writes it any other way (a grid, or no hvcC).
    static func encodeMatte(_ pixels: [UInt8], width: Int, height: Int) -> Texture.MatteSource? {
        guard let primary = grayImage([UInt8](repeating: 0, count: 64 * 48), width: 64, height: 48),
              let skinURI = HEIF.matteURIs["semanticskinmatte"] else { return nil }
        let output = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(
            output, UTType.heic.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(destination, primary, nil)
        let description: [CFString: Any] = [
            kCGImagePropertyWidth: width,
            kCGImagePropertyHeight: height,
            kCGImagePropertyBytesPerRow: width,
            kCGImagePropertyPixelFormat: kCVPixelFormatType_OneComponent8
        ]
        CGImageDestinationAddAuxiliaryDataInfo(destination, kCGImageAuxiliaryDataTypeSemanticSegmentationSkinMatte, [
            kCGImageAuxiliaryDataInfoData: Data(pixels),
            kCGImageAuxiliaryDataInfoDataDescription: description
        ] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { return nil }
        let bytes = (output as Data).stylePortBytes
        guard let meta = try? topBox(bytes, type: "meta"),
              let infos = try? HEIF.parseItemInfo(bytes, meta: meta),
              let properties = try? HEIF.parseProperties(bytes, meta: meta),
              let locations = try? HEIF.parseLocations(bytes, meta: meta),
              let item = infos.keys.sorted().first(where: { HEIF.auxiliaryURI(properties, itemID: $0) == skinURI }),
              infos[item]?.type == "hvc1",
              let ispe = try? HEIF.propertyBytes(bytes, table: properties, itemID: item, type: "ispe"),
              ispe.count >= 20, (try? readUInt(ispe, 12, 4)) == width, (try? readUInt(ispe, 16, 4)) == height,
              let hvcC = try? HEIF.propertyBytes(bytes, table: properties, itemID: item, type: "hvcC"),
              let payload = try? HEIF.extractItem(bytes, locations: locations, itemID: item) else { return nil }
        let pixi = (try? HEIF.propertyBytes(bytes, table: properties, itemID: item, type: "pixi")) ?? AppleBytes.mattePixi
        return Texture.MatteSource(payload: payload, ispe: ispe, pixi: pixi, hvcC: hvcC)
    }

    static func grayImage(_ pixels: [UInt8], width: Int, height: Int) -> CGImage? {
        guard let provider = CGDataProvider(data: Data(pixels) as CFData) else { return nil }
        return CGImage(
            width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 8, bytesPerRow: width,
            space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.none.rawValue),
            provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent
        )
    }
}
#endif
