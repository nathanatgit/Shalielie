import Foundation

indirect enum BinaryPlistValue {
    case null
    case bool(Bool)
    case integer(Int64)
    case real(Double)
    case data(Bytes)
    case string(String)
    case array([BinaryPlistValue])
    case dictionary([(String, BinaryPlistValue)])

    var doubleValue: Double? {
        switch self {
        case .real(let value): return value
        case .integer(let value): return Double(value)
        default: return nil
        }
    }
}

private extension Array where Element == (String, BinaryPlistValue) {
    func value(for key: String) -> BinaryPlistValue? {
        first(where: { $0.0 == key })?.1
    }

    mutating func set(_ value: BinaryPlistValue, for key: String) {
        if let index = firstIndex(where: { $0.0 == key }) {
            self[index] = (key, value)
        } else {
            append((key, value))
        }
    }

    func contains(_ key: String) -> Bool {
        contains(where: { $0.0 == key })
    }
}

enum BinaryPlist {
    static func parse(_ data: Bytes) throws -> BinaryPlistValue {
        guard data.count >= 40, String(bytes: data.prefix(6), encoding: .ascii) == "bplist" else {
            throw StylePortError.invalidData("Not a binary property list.")
        }
        let trailer = data.count - 32
        let offsetSize = Int(data[trailer + 6])
        let referenceSize = Int(data[trailer + 7])
        let objectCount = try readUInt(data, trailer + 8, 8)
        let topObject = try readUInt(data, trailer + 16, 8)
        let offsetTableStart = try readUInt(data, trailer + 24, 8)
        guard offsetSize > 0, referenceSize > 0, objectCount > 0 else {
            throw StylePortError.invalidData("Invalid binary property-list trailer.")
        }

        var offsets: [Int] = []
        offsets.reserveCapacity(objectCount)
        for index in 0..<objectCount {
            offsets.append(try readUInt(data, offsetTableStart + index * offsetSize, offsetSize))
        }

        func sizedCount(at position: Int) throws -> (Int, Int) {
            guard position < data.count else {
                throw StylePortError.invalidData("Truncated binary property-list object.")
            }
            let marker = data[position]
            var count = Int(marker & 0x0f)
            var cursor = position + 1
            if count == 0x0f {
                guard cursor < data.count else {
                    throw StylePortError.invalidData("Truncated binary property-list length.")
                }
                let integerMarker = data[cursor]
                let byteCount = 1 << Int(integerMarker & 0x0f)
                count = try readUInt(data, cursor + 1, byteCount)
                cursor += 1 + byteCount
            }
            return (count, cursor)
        }

        func parseFloat32(at offset: Int) throws -> Double {
            let raw = UInt32(try readUInt(data, offset, 4))
            return Double(Float(bitPattern: raw))
        }

        func parseFloat64(at offset: Int) throws -> Double {
            let bytes = try byteSlice(data, offset, 8)
            var raw: UInt64 = 0
            for byte in bytes { raw = (raw << 8) | UInt64(byte) }
            return Double(bitPattern: raw)
        }

        func readObject(_ index: Int) throws -> BinaryPlistValue {
            guard index >= 0, index < offsets.count, offsets[index] < data.count else {
                throw StylePortError.invalidData("Invalid binary property-list object reference.")
            }
            let position = offsets[index]
            let marker = data[position]
            let high = marker & 0xf0
            let low = marker & 0x0f
            switch high {
            case 0x00:
                switch low {
                case 0: return .null
                case 8: return .bool(false)
                case 9: return .bool(true)
                default:
                    throw StylePortError.invalidData(
                        String(format: "Unsupported binary-plist primitive 0x%02x.", marker)
                    )
                }
            case 0x10:
                let byteCount = 1 << Int(low)
                if byteCount == 8 {
                    let bytes = try byteSlice(data, position + 1, 8)
                    var raw: UInt64 = 0
                    for byte in bytes { raw = (raw << 8) | UInt64(byte) }
                    return .integer(Int64(bitPattern: raw))
                }
                return .integer(Int64(try readUInt(data, position + 1, byteCount)))
            case 0x20:
                if low == 2 { return .real(try parseFloat32(at: position + 1)) }
                if low == 3 { return .real(try parseFloat64(at: position + 1)) }
                throw StylePortError.invalidData("Unsupported binary-plist real width.")
            case 0x40:
                let (count, cursor) = try sizedCount(at: position)
                return .data(try byteSlice(data, cursor, count))
            case 0x50:
                let (count, cursor) = try sizedCount(at: position)
                let bytes = try byteSlice(data, cursor, count)
                return .string(String(decoding: bytes, as: UTF8.self))
            case 0x60:
                let (count, cursor) = try sizedCount(at: position)
                var codeUnits: [UInt16] = []
                codeUnits.reserveCapacity(count)
                for unit in 0..<count {
                    codeUnits.append(UInt16(try readUInt(data, cursor + unit * 2, 2)))
                }
                return .string(String(decoding: codeUnits, as: UTF16.self))
            case 0xa0:
                let (count, cursor) = try sizedCount(at: position)
                var values: [BinaryPlistValue] = []
                values.reserveCapacity(count)
                for item in 0..<count {
                    let reference = try readUInt(data, cursor + item * referenceSize, referenceSize)
                    values.append(try readObject(reference))
                }
                return .array(values)
            case 0xd0:
                let (count, cursor) = try sizedCount(at: position)
                var values: [(String, BinaryPlistValue)] = []
                values.reserveCapacity(count)
                for item in 0..<count {
                    let keyReference = try readUInt(
                        data,
                        cursor + item * referenceSize,
                        referenceSize
                    )
                    let valueReference = try readUInt(
                        data,
                        cursor + count * referenceSize + item * referenceSize,
                        referenceSize
                    )
                    guard case .string(let key) = try readObject(keyReference) else {
                        throw StylePortError.invalidData("A binary-plist dictionary key is not a string.")
                    }
                    values.append((key, try readObject(valueReference)))
                }
                return .dictionary(values)
            default:
                throw StylePortError.invalidData(
                    String(format: "Unsupported binary-plist marker 0x%02x.", marker)
                )
            }
        }

        return try readObject(topObject)
    }

    private static func sizedHeader(base: UInt8, count: Int) -> Bytes {
        if count < 15 { return [base | UInt8(count)] }
        if count < 0x100 { return [base | 0x0f, 0x10, UInt8(count)] }
        if count < 0x10000 {
            return concatenated([[base | 0x0f, 0x11], bigEndianBytes(count, count: 2)])
        }
        return concatenated([[base | 0x0f, 0x12], bigEndianBytes(count, count: 4)])
    }

    static func build(_ root: BinaryPlistValue) throws -> Bytes {
        enum Entry {
            case null
            case bool(Bool)
            case integer(Int64)
            case real(Double)
            case data(Bytes)
            case string(String)
            case array([Int])
            case dictionary(keys: [Int], values: [Int])
        }

        var objects: [Entry] = []
        var stringIndices: [String: Int] = [:]

        func add(_ value: BinaryPlistValue) throws -> Int {
            switch value {
            case .null:
                objects.append(.null)
            case .bool(let bool):
                objects.append(.bool(bool))
            case .integer(let integer):
                objects.append(.integer(integer))
            case .real(let real):
                objects.append(.real(real))
            case .data(let bytes):
                objects.append(.data(bytes))
            case .string(let string):
                if let existing = stringIndices[string] { return existing }
                let index = objects.count
                objects.append(.string(string))
                stringIndices[string] = index
                return index
            case .array(let array):
                let index = objects.count
                objects.append(.array([]))
                let references = try array.map { try add($0) }
                objects[index] = .array(references)
                return index
            case .dictionary(let dictionary):
                let index = objects.count
                objects.append(.dictionary(keys: [], values: []))
                var keys: [Int] = []
                var values: [Int] = []
                for (key, value) in dictionary {
                    keys.append(try add(.string(key)))
                    values.append(try add(value))
                }
                objects[index] = .dictionary(keys: keys, values: values)
                return index
            }
            return objects.count - 1
        }

        let rootIndex = try add(root)
        let referenceSize = objects.count < 0x100 ? 1 : objects.count < 0x10000 ? 2 : 4

        func encode(_ entry: Entry) throws -> Bytes {
            switch entry {
            case .null:
                return [0x00]
            case .bool(let value):
                return [value ? 0x09 : 0x08]
            case .integer(let value):
                if value >= 0 && value < 0x100 {
                    return [0x10, UInt8(value)]
                }
                if value >= 0 && value < 0x10000 {
                    return concatenated([[0x11], bigEndianBytes(Int(value), count: 2)])
                }
                if value >= 0 && value < 0x1_0000_0000 {
                    return concatenated([[0x12], bigEndianBytes(Int(value), count: 4)])
                }
                return concatenated([[0x13], bigEndianBytes(value, count: 8)])
            case .real(let value):
                let bits = value.bitPattern
                var bytes = Bytes(repeating: 0, count: 8)
                var remaining = bits
                for index in bytes.indices.reversed() {
                    bytes[index] = UInt8(remaining & 0xff)
                    remaining >>= 8
                }
                return [0x23] + bytes
            case .data(let bytes):
                return sizedHeader(base: 0x40, count: bytes.count) + bytes
            case .string(let value):
                if value.unicodeScalars.allSatisfy({ $0.value <= 0x7f }) {
                    let bytes = Bytes(value.utf8)
                    return sizedHeader(base: 0x50, count: bytes.count) + bytes
                }
                let units = Array(value.utf16)
                var bytes = Bytes()
                bytes.reserveCapacity(units.count * 2)
                for unit in units { bytes += bigEndianBytes(Int(unit), count: 2) }
                return sizedHeader(base: 0x60, count: units.count) + bytes
            case .array(let references):
                return concatenated(
                    [sizedHeader(base: 0xa0, count: references.count)]
                    + references.map { bigEndianBytes($0, count: referenceSize) }
                )
            case .dictionary(let keys, let values):
                return concatenated(
                    [sizedHeader(base: 0xd0, count: keys.count)]
                    + keys.map { bigEndianBytes($0, count: referenceSize) }
                    + values.map { bigEndianBytes($0, count: referenceSize) }
                )
            }
        }

        let header = Bytes("bplist00".utf8)
        let encoded = try objects.map { try encode($0) }
        var offsets: [Int] = []
        var position = header.count
        for bytes in encoded {
            offsets.append(position)
            position += bytes.count
        }
        let offsetTableStart = position
        let offsetSize = offsetTableStart < 0x100 ? 1 : offsetTableStart < 0x10000 ? 2 : 4
        let table = concatenated(offsets.map { bigEndianBytes($0, count: offsetSize) })
        let trailer = concatenated([
            Bytes(repeating: 0, count: 6),
            [UInt8(offsetSize), UInt8(referenceSize)],
            bigEndianBytes(objects.count, count: 8),
            bigEndianBytes(rootIndex, count: 8),
            bigEndianBytes(offsetTableStart, count: 8)
        ])
        return concatenated([header] + encoded + [table, trailer])
    }

    static func applySceneStatistics(
        to blob: Bytes,
        mode: SceneStatisticsMode,
        sortedLuma: [Double]?
    ) throws -> (Bytes, [String]) {
        if mode == .donor { return (blob, []) }
        guard case .dictionary(var root) = try parse(blob),
              let sectionSixValue = root.value(for: "6"),
              case .dictionary(var sectionSix) = sectionSixValue else {
            return (blob, [])
        }

        let scaled = sortedLuma?.map { $0 * StyleMaps.linearImageScale }
        var changed: [String] = []
        for (name, values) in [("ToneMappedImage", sortedLuma), ("LinearImage", scaled)] {
            guard let currentValue = sectionSix.value(for: name),
                  case .dictionary(let current) = currentValue else { continue }
            if mode == .toneOnly && name == "LinearImage" { continue }
            let replacement: [(String, BinaryPlistValue)]
            if mode == .neutral {
                replacement = StyleMaps.sceneStatisticFields.map {
                    ($0, .real($0 == "highKey" ? 1 : 0))
                }
            } else if let values {
                let highKey = current.value(for: "highKey")?.doubleValue ?? 1
                replacement = StyleMaps.statisticsBlock(sorted: values, highKey: highKey)
            } else {
                continue
            }
            sectionSix.set(.dictionary(replacement), for: name)
            changed.append(name)
        }
        root.set(.dictionary(sectionSix), for: "6")
        return (try build(.dictionary(root)), changed)
    }

    static func applyLightMaps(to blob: Bytes, c: Bytes, d: Bytes) throws -> (Bytes, [String]) {
        guard case .dictionary(var root) = try parse(blob),
              root.value(for: "e")?.doubleValue == Double(StyleMaps.lightMapSize),
              root.value(for: "f")?.doubleValue == Double(StyleMaps.lightMapSize) else {
            return (blob, [])
        }
        var changed: [String] = []
        for (key, replacement) in [("c", c), ("d", d)] {
            if let currentValue = root.value(for: key),
               case .data(let current) = currentValue,
               current.count == replacement.count {
                root.set(.data(replacement), for: key)
                changed.append(key)
            }
        }
        return (try build(.dictionary(root)), changed)
    }

    static func setPersonMasksValid(in blob: Bytes, value: Double = 1) throws -> (Bytes, Double?) {
        guard case .dictionary(var root) = try parse(blob),
              let sectionSevenValue = root.value(for: "7"),
              case .dictionary(var sectionSeven) = sectionSevenValue,
              sectionSeven.contains("PersonMasksValidHint") else {
            return (blob, nil)
        }
        let before = sectionSeven.value(for: "PersonMasksValidHint")?.doubleValue
        sectionSeven.set(.real(value), for: "PersonMasksValidHint")
        root.set(.dictionary(sectionSeven), for: "7")
        return (try build(.dictionary(root)), before)
    }
}
