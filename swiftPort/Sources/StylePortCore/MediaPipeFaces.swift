#if canImport(MediaPipeTasksVision) && canImport(UIKit)
import CoreGraphics
import Foundation
import MediaPipeTasksVision
import UIKit

/// Experimental Find Faces engine, the same method as the command line's `--find-faces`
/// (PR #4 by joy-0220-yoj, `photographic_style_vision.py`): MediaPipe's Face Landmarker finds
/// the faces and a six-class selfie segmenter gives the person and skin mattes. Both Google
/// models are pre-fetched by `tools/fetch_models.py` (pinned in `tools/models.json`) and
/// bundled in `Resources/Models`; nothing is downloaded and nothing leaves the device. The
/// data is still estimated, not the camera's. Falls back to Vision (PeopleDetection) when the
/// models are not in the bundle.
enum MediaPipeFaces {
    static let faceModel = "face_landmarker.task"
    static let segmenterModel = "selfie_multiclass_256x256.tflite"

    /// MediaPipe Face Mesh index rings (from PR #4): the face oval, both eyes, the mouth.
    static let faceOval = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400,
                           377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103,
                           67, 109]
    static let eyeOne = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246]
    static let eyeTwo = [362, 382, 381, 380, 374, 373, 390, 249, 263, 466, 388, 387, 386, 385, 384, 398]
    static let mouth = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185]
    /// Where crops are searched for faces besides the whole picture (small faces).
    static let searchRects: [(Double, Double, Double, Double)] = [
        (0, 0, 1, 1), (0, 0, 0.62, 0.62), (0.38, 0, 0.62, 0.62), (0, 0.38, 0.62, 0.62), (0.38, 0.38, 0.62, 0.62)
    ]

    static func modelPath(_ name: String) -> String? {
        DonorProfileLoader.resourceBundle.url(forResource: name, withExtension: nil, subdirectory: "Models")?.path
    }

    static var available: Bool { modelPath(faceModel) != nil && modelPath(segmenterModel) != nil }

    private struct Candidate {
        let points: [(Double, Double)]   // normalized, upright, top-left origin
        let box: (x: Double, y: Double, w: Double, h: Double)
    }

    private static func bounds(_ points: [(Double, Double)], _ indices: [Int]) -> (x: Double, y: Double, w: Double, h: Double) {
        let chosen = indices.filter { $0 < points.count }.map { points[$0] }
        let xs = chosen.map { $0.0 }, ys = chosen.map { $0.1 }
        let minX = xs.min() ?? 0, minY = ys.min() ?? 0
        return (minX, minY, (xs.max() ?? 0) - minX, (ys.max() ?? 0) - minY)
    }

    /// `known`: the photo's own face regions; when there are any they are used and no face is
    /// searched for (only the mattes are estimated).
    static func detect(
        upright: CGImage,
        irot: Int,
        width: Int,
        height: Int,
        known: [Texture.Face]
    ) -> Result<PeopleDetection.Found, PeopleDetection.Failure> {
        guard let facePath = modelPath(faceModel), let segmenterPath = modelPath(segmenterModel) else {
            return .failure(.modelsMissing)
        }
        guard let analysis = scaled(upright, longEdge: 1024) else { return .failure(.unreadable) }
        do {
            // Six confidence planes: 0 background, 1 hair, 2 body skin, 3 face skin, 4 clothes, 5 others.
            let segmenterOptions = ImageSegmenterOptions()
            segmenterOptions.baseOptions.modelAssetPath = segmenterPath
            segmenterOptions.runningMode = .image
            segmenterOptions.shouldOutputConfidenceMasks = true
            segmenterOptions.shouldOutputCategoryMask = false
            let segmenter = try ImageSegmenter(options: segmenterOptions)
            let segmentation = try segmenter.segment(image: MPImage(uiImage: UIImage(cgImage: analysis)))
            guard let masks = segmentation.confidenceMasks, masks.count == 6 else {
                return .failure(.segmentation)
            }
            var planes: [[Float]] = []
            for mask in masks {
                guard let data = mask.float32Data else { return .failure(.segmentation) }
                planes.append(Array(UnsafeBufferPointer(start: data, count: mask.width * mask.height)))
            }
            let planeWidth = masks[0].width, planeHeight = masks[0].height
            let person = planes[0].map { 1 - $0 }
            var skin = [Float](repeating: 0, count: planes[2].count)
            for index in skin.indices { skin[index] = min(1, planes[2][index] + planes[3][index]) }

            var faces = known
            if faces.isEmpty {
                let faceOptions = FaceLandmarkerOptions()
                faceOptions.baseOptions.modelAssetPath = facePath
                faceOptions.runningMode = .image
                faceOptions.numFaces = 5
                faceOptions.minFaceDetectionConfidence = 0.35
                faceOptions.minFacePresenceConfidence = 0.35
                let landmarker = try FaceLandmarker(options: faceOptions)
                let found = try candidates(landmarker, analysis)
                faces = found.prefix(Texture.softSkinInstanceKeys.count).map {
                    storedFace($0, aspect: Double(analysis.width) / Double(analysis.height), irot: irot)
                }
            }
            guard !faces.isEmpty else { return .failure(.noFace) }

            let (matteWidth, matteHeight) = PeopleDetection.matteSize(width: width, height: height)
            let turned = irot % 180 != 0
            let (uprightWidth, uprightHeight) = turned ? (matteHeight, matteWidth) : (matteWidth, matteHeight)
            func stored(_ plane: [Float]) -> [UInt8] {
                PeopleDetection.toStored(
                    resample(plane, planeWidth, planeHeight, uprightWidth, uprightHeight),
                    channels: 1, uprightWidth: uprightWidth, uprightHeight: uprightHeight, irot: irot)
            }
            guard let skinSource = PeopleDetection.encodeMatte(stored(skin), width: matteWidth, height: matteHeight) else {
                return .failure(.skinEncoding)
            }
            guard let personSource = PeopleDetection.encodeMatte(stored(person), width: matteWidth, height: matteHeight) else {
                return .failure(.personEncoding)
            }
            return .success(PeopleDetection.Found(faces: faces, skin: skinSource, person: personSource))
        } catch {
            return .failure(.engine(String(describing: error)))
        }
    }

    // MARK: Faces

    private static func candidates(_ landmarker: FaceLandmarker, _ image: CGImage) throws -> [Candidate] {
        var found: [Candidate] = []
        let fullWidth = Double(image.width), fullHeight = Double(image.height)
        for (rx, ry, rw, rh) in searchRects {
            let rect = CGRect(x: (rx * fullWidth).rounded(), y: (ry * fullHeight).rounded(),
                              width: (rw * fullWidth).rounded(), height: (rh * fullHeight).rounded())
            guard let crop = image.cropping(to: rect) else { continue }
            let target = rw < 1 ? min(1.8 * Double(max(crop.width, crop.height)), 1024) : Double(max(crop.width, crop.height))
            guard let view = scaled(crop, longEdge: Int(target)) else { continue }
            let result = try landmarker.detect(image: MPImage(uiImage: UIImage(cgImage: view)))
            for landmarks in result.faceLandmarks {
                let points = landmarks.map { (rx + Double($0.x) * rw, ry + Double($0.y) * rh) }
                let box = bounds(points, faceOval)
                let isDuplicate = found.contains { other in
                    let distance = hypot(box.x + box.w / 2 - other.box.x - other.box.w / 2,
                                         box.y + box.h / 2 - other.box.y - other.box.h / 2)
                    let size = (hypot(box.w, box.h) + hypot(other.box.w, other.box.h)) / 2
                    return distance < max(0.015, size) * 0.38
                }
                if !isDuplicate { found.append(Candidate(points: points, box: box)) }
            }
        }
        return found.prefix(5).sorted { $0.box.x < $1.box.x }
    }

    /// A face as the photo's MWG region would give it: centre and size in stored orientation.
    /// Its box is PR #4's faceROI (around the eyes and mouth) divided by the ROI-per-region
    /// ratio; the roll is the eye line's tilt (clockwise positive, as the landmark template
    /// is turned) plus the photo's rotation. Yaw is left frontal: no pose matrix is used.
    private static func storedFace(_ candidate: Candidate, aspect: Double, irot: Int) -> Texture.Face {
        let inner = bounds(candidate.points, eyeOne + eyeTwo + mouth)
        let (x, y) = PeopleDetection.storedPoint(inner.x + inner.w / 2, inner.y + inner.h / 2, irot: irot)
        let turned = irot % 180 != 0
        let w = (turned ? inner.h : inner.w) / Texture.softSkinROIPerXMP.0
        let h = (turned ? inner.w : inner.h) / Texture.softSkinROIPerXMP.1
        var tilt = 0.0
        if candidate.points.count > 263 {
            let a = candidate.points[33], b = candidate.points[263]
            tilt = atan2((b.1 - a.1), (b.0 - a.0) * aspect) * 180 / Double.pi
        }
        return Texture.Face(x: x, y: y, w: w, h: h, yaw: 0, roll: Double(irot) + tilt)
    }

    // MARK: Pixels

    static func scaled(_ image: CGImage, longEdge: Int) -> CGImage? {
        let long = max(image.width, image.height)
        let scale = min(1.0, Double(longEdge) / Double(long))
        let width = max(2, Int((Double(image.width) * scale).rounded()))
        let height = max(2, Int((Double(image.height) * scale).rounded()))
        guard let context = CGContext(
            data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return nil }
        context.interpolationQuality = .high
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        return context.makeImage()
    }

    /// A 0...1 plane resampled bilinearly to 8 bits.
    static func resample(_ plane: [Float], _ sourceWidth: Int, _ sourceHeight: Int, _ width: Int, _ height: Int) -> [UInt8] {
        var out = [UInt8](repeating: 0, count: width * height)
        for y in 0..<height {
            let fy = max(0, min(Float(sourceHeight - 1), (Float(y) + 0.5) * Float(sourceHeight) / Float(height) - 0.5))
            let y0 = Int(fy), y1 = min(sourceHeight - 1, y0 + 1), ty = fy - Float(y0)
            for x in 0..<width {
                let fx = max(0, min(Float(sourceWidth - 1), (Float(x) + 0.5) * Float(sourceWidth) / Float(width) - 0.5))
                let x0 = Int(fx), x1 = min(sourceWidth - 1, x0 + 1), tx = fx - Float(x0)
                let top = plane[y0 * sourceWidth + x0] * (1 - tx) + plane[y0 * sourceWidth + x1] * tx
                let bottom = plane[y1 * sourceWidth + x0] * (1 - tx) + plane[y1 * sourceWidth + x1] * tx
                let value = top * (1 - ty) + bottom * ty
                out[y * width + x] = UInt8(max(0, min(255, (value * 255 + 0.5).rounded(.down))))
            }
        }
        return out
    }
}
#endif
