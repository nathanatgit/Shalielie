import Foundation

typealias Bytes = [UInt8]

@inline(__always)
func readUInt(_ data: Bytes, _ offset: Int, _ count: Int) throws -> Int {
    guard offset >= 0, count >= 0, offset <= data.count - count else {
        throw StylePortError.invalidData("Unexpected end of binary data.")
    }
    var value: UInt64 = 0
    for index in offset..<(offset + count) {
        let (shifted, overflowA) = value.multipliedReportingOverflow(by: 256)
        let (next, overflowB) = shifted.addingReportingOverflow(UInt64(data[index]))
        guard !overflowA, !overflowB, next <= UInt64(Int.max) else {
            throw StylePortError.invalidData("Integer in binary data is too large.")
        }
        value = next
    }
    return Int(value)
}

@inline(__always)
func bigEndianBytes(_ value: Int, count: Int) -> Bytes {
    precondition(value >= 0 && count >= 0)
    var output = Bytes(repeating: 0, count: count)
    var remaining = UInt64(value)
    for index in output.indices.reversed() {
        output[index] = UInt8(remaining & 0xff)
        remaining >>= 8
    }
    return output
}

@inline(__always)
func bigEndianBytes(_ value: Int64, count: Int) -> Bytes {
    var output = Bytes(repeating: 0, count: count)
    var remaining = UInt64(bitPattern: value)
    for index in output.indices.reversed() {
        output[index] = UInt8(remaining & 0xff)
        remaining >>= 8
    }
    return output
}

@inline(__always)
func byteSlice(_ data: Bytes, _ offset: Int, _ length: Int) throws -> Bytes {
    guard offset >= 0, length >= 0, offset <= data.count - length else {
        throw StylePortError.invalidData("Invalid binary slice.")
    }
    return Array(data[offset..<(offset + length)])
}

@inline(__always)
func concatenated(_ parts: [Bytes]) -> Bytes {
    let total = parts.reduce(0) { $0 + $1.count }
    var output = Bytes()
    output.reserveCapacity(total)
    for part in parts { output.append(contentsOf: part) }
    return output
}

@inline(__always)
func writeBytes(_ replacement: Bytes, into data: inout Bytes, at offset: Int) throws {
    guard offset >= 0, offset <= data.count - replacement.count else {
        throw StylePortError.invalidData("Invalid binary write.")
    }
    data.replaceSubrange(offset..<(offset + replacement.count), with: replacement)
}

@inline(__always)
func bytesEqual(_ lhs: Bytes?, _ rhs: Bytes?) -> Bool {
    lhs == rhs
}

func fourCC(_ data: Bytes, at offset: Int) throws -> String {
    let bytes = try byteSlice(data, offset, 4)
    guard let value = String(bytes: bytes, encoding: .isoLatin1) else {
        throw StylePortError.invalidData("Invalid four-character code.")
    }
    return value
}

func cString(_ data: Bytes, from start: Int, to end: Int) throws -> (String, Int) {
    guard start >= 0, end >= start, end <= data.count else {
        throw StylePortError.invalidData("Invalid string range.")
    }
    var cursor = start
    while cursor < end && data[cursor] != 0 { cursor += 1 }
    let value = String(bytes: data[start..<cursor], encoding: .utf8)
        ?? String(decoding: data[start..<cursor], as: UTF8.self)
    return (value, min(cursor + 1, end))
}

extension Data {
    var stylePortBytes: Bytes { Bytes(self) }
}

extension Array where Element == UInt8 {
    var stylePortData: Data { Data(self) }
}
