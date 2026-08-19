import Foundation

struct ISOBox: Equatable {
    let offset: Int
    let size: Int
    let headerSize: Int
    let type: String
}

func siblingBoxes(_ data: Bytes, from start: Int, to end: Int) throws -> [ISOBox] {
    guard start >= 0, end >= start, end <= data.count else {
        throw StylePortError.invalidData("Invalid ISO box range.")
    }
    var cursor = start
    var result: [ISOBox] = []
    while cursor + 8 <= end {
        var size = try readUInt(data, cursor, 4)
        let type = try fourCC(data, at: cursor + 4)
        var headerSize = 8
        if size == 1 {
            guard cursor + 16 <= end else { break }
            size = try readUInt(data, cursor + 8, 8)
            headerSize = 16
        } else if size == 0 {
            size = end - cursor
        }
        guard size >= headerSize, cursor <= end - size else { break }
        result.append(ISOBox(offset: cursor, size: size, headerSize: headerSize, type: type))
        cursor += size
    }
    return result
}

func topBox(_ data: Bytes, type: String) throws -> ISOBox {
    guard let box = try siblingBoxes(data, from: 0, to: data.count).first(where: { $0.type == type }) else {
        throw StylePortError.invalidData("Missing top-level \(type) box.")
    }
    return box
}

func metaChildren(_ data: Bytes, meta: ISOBox? = nil) throws -> [ISOBox] {
    let parent: ISOBox
    if let meta {
        parent = meta
    } else {
        parent = try topBox(data, type: "meta")
    }
    return try siblingBoxes(
        data,
        from: parent.offset + parent.headerSize + 4,
        to: parent.offset + parent.size
    )
}

func findChild(_ children: [ISOBox], type: String) throws -> ISOBox {
    guard let child = children.first(where: { $0.type == type }) else {
        throw StylePortError.invalidData("Missing child box \(type).")
    }
    return child
}

func makeBox(_ type: String, payload: Bytes) -> Bytes {
    precondition(type.utf8.count == 4)
    return concatenated([
        bigEndianBytes(8 + payload.count, count: 4),
        Bytes(type.utf8),
        payload
    ])
}
