import CoreGraphics
import Foundation
import ImageIO

enum SceneStatisticsMode: Equatable {
    case donor
    case target
    case toneOnly
    case neutral
}

enum StyleMaps {
    static let lightMapSize = 32
    static let lightMapFloor = 0.040741
    static let linearImageScale = 0.166
    static let cMapSlope = 0.7774
    static let cMapIntercept = 0.0294
    static let dMapSlope = 0.6542
    static let dMapIntercept = -0.0128
    static let sceneStatisticFields = [
        "blackPoint", "highKey", "p02", "p10", "p25",
        "p50", "p75", "p98", "whitePoint"
    ]

    static func sRGBToLinear(_ component: Double) -> Double {
        component <= 0.04045
            ? component / 12.92
            : pow((component + 0.055) / 1.055, 2.4)
    }

    static func percentile(_ sorted: [Double], _ quantile: Double) -> Double {
        guard !sorted.isEmpty else { return 0 }
        let position = quantile * Double(sorted.count - 1)
        let lower = Int(floor(position))
        let upper = min(lower + 1, sorted.count - 1)
        let fraction = position - Double(lower)
        return sorted[lower] * (1 - fraction) + sorted[upper] * fraction
    }

    static func statisticsBlock(
        sorted: [Double],
        highKey: Double
    ) -> [(String, BinaryPlistValue)] {
        [
            ("blackPoint", .real(percentile(sorted, 0.001))),
            ("highKey", .real(highKey)),
            ("p02", .real(percentile(sorted, 0.02))),
            ("p10", .real(percentile(sorted, 0.10))),
            ("p25", .real(percentile(sorted, 0.25))),
            ("p50", .real(percentile(sorted, 0.50))),
            ("p75", .real(percentile(sorted, 0.75))),
            ("p98", .real(percentile(sorted, 0.98))),
            ("whitePoint", .real(percentile(sorted, 0.999)))
        ]
    }

    static func linearLuma(fromRGB rgb: Bytes) -> [Double] {
        var lookup = [Double](repeating: 0, count: 256)
        for value in 0..<256 { lookup[value] = sRGBToLinear(Double(value) / 255) }
        var output = [Double](repeating: 0, count: rgb.count / 3)
        var source = 0
        for index in output.indices {
            output[index] = 0.2126 * lookup[Int(rgb[source])]
                + 0.7152 * lookup[Int(rgb[source + 1])]
                + 0.0722 * lookup[Int(rgb[source + 2])]
            source += 3
        }
        return output
    }

    private static func halfBits(_ value: Double) -> UInt16 {
        let float = Float(value)
        let bits = float.bitPattern
        let sign = UInt16((bits >> 16) & 0x8000)
        let exponent = Int((bits >> 23) & 0xff) - 127 + 15
        let mantissa = UInt16((bits & 0x7fffff) >> 13)
        if exponent <= 0 { return sign }
        if exponent >= 0x1f { return sign | 0x7c00 }
        return sign | UInt16(exponent << 10) | mantissa
    }

    static func packFloat16LittleEndian(_ values: [Double]) -> Bytes {
        var output = Bytes()
        output.reserveCapacity(values.count * 2)
        for value in values {
            let bits = halfBits(value)
            output.append(UInt8(bits & 0xff))
            output.append(UInt8(bits >> 8))
        }
        return output
    }

    static func buildLightMaps(from linearGrid: [Double]) -> (Bytes, Bytes) {
        let reversed = linearGrid.reversed()
        func make(slope: Double, intercept: Double) -> Bytes {
            packFloat16LittleEndian(reversed.map {
                max(lightMapFloor, min(1, slope * $0 + intercept))
            })
        }
        return (
            make(slope: cMapSlope, intercept: cMapIntercept),
            make(slope: dMapSlope, intercept: dMapIntercept)
        )
    }
}

enum NativeImageAnalyzer {
    static func rgb(from data: Bytes, width: Int, height: Int) throws -> Bytes {
        guard width > 0, height > 0,
              let source = CGImageSourceCreateWithData(Data(data) as CFData, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, [
                kCGImageSourceShouldCacheImmediately: true
              ] as CFDictionary) else {
            throw StylePortError.invalidData("ImageIO could not decode the HEIC primary image.")
        }

        let bytesPerRow = width * 4
        var rgba = Bytes(repeating: 0, count: bytesPerRow * height)
        guard let colorSpace = CGColorSpace(name: CGColorSpace.sRGB) else {
            throw StylePortError.invalidData("Core Graphics could not create an sRGB space.")
        }
        let bitmapInfo = CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue
        let drewImage = rgba.withUnsafeMutableBytes { storage -> Bool in
            guard let base = storage.baseAddress,
                  let context = CGContext(
                    data: base,
                    width: width,
                    height: height,
                    bitsPerComponent: 8,
                    bytesPerRow: bytesPerRow,
                    space: colorSpace,
                    bitmapInfo: bitmapInfo
                  ) else { return false }
            context.interpolationQuality = .high
            context.translateBy(x: 0, y: CGFloat(height))
            context.scaleBy(x: 1, y: -1)
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
            return true
        }
        guard drewImage else {
            throw StylePortError.invalidData("Core Graphics could not create a decode buffer.")
        }

        var rgb = Bytes(repeating: 0, count: width * height * 3)
        var destination = 0
        for source in stride(from: 0, to: rgba.count, by: 4) {
            rgb[destination] = rgba[source]
            rgb[destination + 1] = rgba[source + 1]
            rgb[destination + 2] = rgba[source + 2]
            destination += 3
        }
        return rgb
    }
}
