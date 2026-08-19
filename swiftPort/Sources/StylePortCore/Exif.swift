import Foundation

enum AppleExif {
    private struct MakerNoteLocation {
        let tiffStart: Int
        let tiff: Bytes
        let littleEndian: Bool
        let entryOffset: Int
    }

    private static func tiffUInt(
        _ data: Bytes,
        at offset: Int,
        count: Int,
        littleEndian: Bool
    ) throws -> Int {
        let bytes = try byteSlice(data, offset, count)
        let ordered = littleEndian ? Bytes(bytes.reversed()) : bytes
        var value = 0
        for byte in ordered { value = value * 256 + Int(byte) }
        return value
    }

    private static func tiffBytes(_ value: Int, count: Int, littleEndian: Bool) -> Bytes {
        let bytes = bigEndianBytes(value, count: count)
        return littleEndian ? Bytes(bytes.reversed()) : bytes
    }

    private static func locateMakerNote(in exifPayload: Bytes) throws -> MakerNoteLocation {
        let tiffStart = try tiffUInt(exifPayload, at: 0, count: 4, littleEndian: false) + 4
        guard tiffStart <= exifPayload.count else {
            throw StylePortError.invalidData("Exif TIFF offset is invalid.")
        }
        let tiff = try byteSlice(exifPayload, tiffStart, exifPayload.count - tiffStart)
        guard tiff.count >= 8 else {
            throw StylePortError.invalidData("Exif TIFF offset is invalid.")
        }
        let order = String(bytes: tiff.prefix(2), encoding: .ascii)
        guard order == "II" || order == "MM" else {
            throw StylePortError.invalidData("Unknown TIFF byte order.")
        }
        let littleEndian = order == "II"
        let ifd0 = try tiffUInt(tiff, at: 4, count: 4, littleEndian: littleEndian)
        let ifd0Count = try tiffUInt(tiff, at: ifd0, count: 2, littleEndian: littleEndian)
        var cursor = ifd0 + 2
        var exifIFD: Int?
        for _ in 0..<ifd0Count {
            if try tiffUInt(tiff, at: cursor, count: 2, littleEndian: littleEndian) == 0x8769 {
                exifIFD = try tiffUInt(tiff, at: cursor + 8, count: 4, littleEndian: littleEndian)
                break
            }
            cursor += 12
        }
        guard let exifIFD else {
            throw StylePortError.invalidData("ExifIFD pointer 0x8769 was not found.")
        }
        let exifCount = try tiffUInt(tiff, at: exifIFD, count: 2, littleEndian: littleEndian)
        cursor = exifIFD + 2
        for _ in 0..<exifCount {
            if try tiffUInt(tiff, at: cursor, count: 2, littleEndian: littleEndian) == 0x927c {
                return MakerNoteLocation(
                    tiffStart: tiffStart,
                    tiff: tiff,
                    littleEndian: littleEndian,
                    entryOffset: cursor
                )
            }
            cursor += 12
        }
        throw StylePortError.invalidData("Apple MakerNote tag 0x927c was not found.")
    }

    private static func makerNoteBlob(from exifPayload: Bytes) throws -> Bytes {
        let location = try locateMakerNote(in: exifPayload)
        let type = try tiffUInt(
            location.tiff,
            at: location.entryOffset + 2,
            count: 2,
            littleEndian: location.littleEndian
        )
        let count = try tiffUInt(
            location.tiff,
            at: location.entryOffset + 4,
            count: 4,
            littleEndian: location.littleEndian
        )
        let total = (HEIF.tiffTypeSizes[type] ?? 1) * count
        if total <= 4 {
            return try byteSlice(location.tiff, location.entryOffset + 8, total)
        }
        let offset = try tiffUInt(
            location.tiff,
            at: location.entryOffset + 8,
            count: 4,
            littleEndian: location.littleEndian
        )
        return try byteSlice(location.tiff, offset, total)
    }

    static func injectMakerNoteTag(
        into exifPayload: Bytes,
        payload: Bytes,
        tag wantedTag: Int = 0x54,
        type: Int = 7
    ) throws -> Bytes {
        let location = try locateMakerNote(in: exifPayload)
        let oldMakerNote = try makerNoteBlob(from: exifPayload)
        guard oldMakerNote.count >= 20,
              String(bytes: oldMakerNote.prefix(9), encoding: .ascii) == "Apple iOS" else {
            throw StylePortError.invalidData("Unsupported Apple MakerNote.")
        }
        let makerLittleEndian = String(
            bytes: oldMakerNote[12..<14],
            encoding: .ascii
        ) == "II"
        let entryCount = try tiffUInt(
            oldMakerNote,
            at: 14,
            count: 2,
            littleEndian: makerLittleEndian
        )
        let tableStart = 16
        let oldDataStart = tableStart + entryCount * 12 + 4
        guard oldDataStart <= oldMakerNote.count else {
            throw StylePortError.invalidData("Truncated Apple MakerNote table.")
        }

        struct Entry {
            let tag: Int
            var raw: Bytes
            let total: Int
        }
        var entries: [Entry] = []
        var found = false
        for index in 0..<entryCount {
            let position = tableStart + index * 12
            let raw = try byteSlice(oldMakerNote, position, 12)
            let tag = try tiffUInt(raw, at: 0, count: 2, littleEndian: makerLittleEndian)
            let entryType = try tiffUInt(raw, at: 2, count: 2, littleEndian: makerLittleEndian)
            let count = try tiffUInt(raw, at: 4, count: 4, littleEndian: makerLittleEndian)
            let total = (HEIF.tiffTypeSizes[entryType] ?? 0) * count
            if tag == wantedTag {
                found = true
                continue
            }
            entries.append(Entry(tag: tag, raw: raw, total: total))
        }

        let growth = found ? 0 : 12
        if growth > 0 {
            for index in entries.indices where entries[index].total > 4 {
                let offset = try tiffUInt(
                    entries[index].raw,
                    at: 8,
                    count: 4,
                    littleEndian: makerLittleEndian
                )
                if offset >= oldDataStart {
                    try writeBytes(
                        tiffBytes(offset + growth, count: 4, littleEndian: makerLittleEndian),
                        into: &entries[index].raw,
                        at: 8
                    )
                }
            }
        }

        let oldNextPosition = tableStart + entryCount * 12
        let oldNext = try tiffUInt(
            oldMakerNote,
            at: oldNextPosition,
            count: 4,
            littleEndian: makerLittleEndian
        )
        let newNext = growth > 0 && oldNext >= oldDataStart && oldNext != 0
            ? oldNext + growth
            : oldNext
        let oldData = try byteSlice(
            oldMakerNote,
            oldDataStart,
            oldMakerNote.count - oldDataStart
        )
        let newCount = found ? entryCount : entryCount + 1
        let newDataStart = tableStart + newCount * 12 + 4
        let payloadOffset = newDataStart + oldData.count
        var newEntry = Bytes(repeating: 0, count: 12)
        try writeBytes(
            tiffBytes(wantedTag, count: 2, littleEndian: makerLittleEndian),
            into: &newEntry,
            at: 0
        )
        try writeBytes(
            tiffBytes(type, count: 2, littleEndian: makerLittleEndian),
            into: &newEntry,
            at: 2
        )
        try writeBytes(
            tiffBytes(payload.count, count: 4, littleEndian: makerLittleEndian),
            into: &newEntry,
            at: 4
        )
        if payload.count <= 4 {
            try writeBytes(payload, into: &newEntry, at: 8)
        } else {
            try writeBytes(
                tiffBytes(payloadOffset, count: 4, littleEndian: makerLittleEndian),
                into: &newEntry,
                at: 8
            )
        }
        entries.append(Entry(tag: wantedTag, raw: newEntry, total: payload.count))
        entries.sort { $0.tag < $1.tag }

        let rebuilt = concatenated([
            try byteSlice(oldMakerNote, 0, 14),
            tiffBytes(newCount, count: 2, littleEndian: makerLittleEndian)
        ] + entries.map(\.raw) + [
            tiffBytes(newNext, count: 4, littleEndian: makerLittleEndian),
            oldData,
            payload.count > 4 ? payload : []
        ])

        let newMakerNoteOffset = location.tiff.count
        var newTIFF = location.tiff + rebuilt
        try writeBytes(
            tiffBytes(7, count: 2, littleEndian: location.littleEndian),
            into: &newTIFF,
            at: location.entryOffset + 2
        )
        try writeBytes(
            tiffBytes(rebuilt.count, count: 4, littleEndian: location.littleEndian),
            into: &newTIFF,
            at: location.entryOffset + 4
        )
        try writeBytes(
            tiffBytes(newMakerNoteOffset, count: 4, littleEndian: location.littleEndian),
            into: &newTIFF,
            at: location.entryOffset + 8
        )
        return concatenated([
            try byteSlice(exifPayload, 0, location.tiffStart),
            newTIFF
        ])
    }
}
