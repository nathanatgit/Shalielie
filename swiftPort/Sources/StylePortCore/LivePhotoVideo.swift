import Foundation

/// The Photographic Style parts of a Live Photo video, added the way
/// `tools/live-photo/mov_style_tracks.py` adds them: tracks cloned from a native iPhone 18 Pro
/// template (`Resources/Profiles/live-photo-video/template.mov`), fitted to the target's own
/// frames. The target's boxes and payloads stay byte for byte; new samples go into a second
/// mdat after moov.
public enum LivePhotoVideo {
    public struct Parts: OptionSet, Sendable {
        public let rawValue: Int
        public init(rawValue: Int) { self.rawValue = rawValue }

        /// `video-map.smart-style-linear-thumbnail`: the video at 128x96, every frame.
        public static let linearThumbnail = Parts(rawValue: 1 << 0)
        /// `video-map.sky` / `.person` / `.skin`: empty mattes, every second frame.
        public static let mattes = Parts(rawValue: 1 << 1)
        /// `smartstyle-info` timed metadata and the moov `smartstyle.*` keys.
        public static let styleInfo = Parts(rawValue: 1 << 2)
        /// `texturestyle-info` timed metadata and the moov `texturestyle.*` keys, which Photos
        /// connects to when the still has Texture/Grain.
        public static let textureInfo = Parts(rawValue: 1 << 3)

        public static let style: Parts = [.linearThumbnail, .mattes, .styleInfo]
    }

    /// The linear thumbnail's samples, encoded by the caller (HEVC Main 10, 128x96, one per
    /// main-video frame in decode order, length-prefixed NAL units).
    public struct LinearThumbnail: Sendable {
        public let samples: [Data]
        /// The sample description's `hvcC` payload, without the box header.
        public let hvcC: Data
        /// Zero-based indices of sync samples.
        public let syncSamples: [Int]

        public init(samples: [Data], hvcC: Data, syncSamples: [Int]) {
            self.samples = samples
            self.hvcC = hvcC
            self.syncSamples = syncSamples
        }
    }

    static let linearThumbnailTag = "com.apple.quicktime.video-map.smart-style-linear-thumbnail"
    static let matteTags = [
        "com.apple.quicktime.video-map.sky",
        "com.apple.quicktime.video-map.person",
        "com.apple.quicktime.video-map.skin"
    ]
    static let styleInfoTag = "com.apple.quicktime.smartstyle-info"
    static let textureInfoTag = "com.apple.quicktime.texturestyle-info"
    static let styleKeyPrefix = "com.apple.quicktime.smartstyle."
    static let textureKeyPrefix = "com.apple.quicktime.texturestyle."

    /// The parts a video has, read from its track names.
    public static func parts(of video: Data) throws -> Parts {
        let movie = try Movie(video.stylePortBytes)
        var parts: Parts = []
        if movie.track(tagged: linearThumbnailTag) != nil { parts.insert(.linearThumbnail) }
        if matteTags.allSatisfy({ movie.track(tagged: $0) != nil }) { parts.insert(.mattes) }
        if movie.track(tagged: styleInfoTag) != nil { parts.insert(.styleInfo) }
        if movie.track(tagged: textureInfoTag) != nil { parts.insert(.textureInfo) }
        return parts
    }

    /// The main video's sample count, which the linear thumbnail has to match.
    public static func frameCount(of video: Data) throws -> Int {
        let movie = try Movie(video.stylePortBytes)
        return try movie.sampleDeltas(movie.mainVideo()).count
    }

    /// Adds the `wanted` parts the video lacks. `linearThumbnail` is required when that part
    /// is wanted and missing. Returns the new video and the parts added.
    public static func add(
        _ wanted: Parts,
        to video: Data,
        linearThumbnail: LinearThumbnail?
    ) throws -> (Data, Parts) {
        let target = try Movie(video.stylePortBytes)
        let template = try Movie(LivePhotoVideoTemplate.bytes())
        let have = try parts(of: video)
        let adding = wanted.subtracting(have)
        guard !adding.isEmpty else { return (video, []) }
        guard target.boxes.last?.type == "moov" else {
            throw StylePortError.invalidData("The Live Photo video's moov box is not last.")
        }

        let mainVideo = try target.mainVideo()
        let deltas = try target.sampleDeltas(mainVideo)
        let frames = deltas.count
        var nextID = try target.nextTrackID()
        var auxTracks: [PendingTrack] = []
        var metadataTracks: [PendingTrack] = []

        if adding.contains(.linearThumbnail) {
            guard let linearThumbnail else {
                throw StylePortError.invalidData("The linear thumbnail was not encoded.")
            }
            guard linearThumbnail.samples.count == frames else {
                throw StylePortError.invalidData(
                    "The linear thumbnail has \(linearThumbnail.samples.count) frames, the video \(frames)."
                )
            }
            auxTracks.append(PendingTrack(
                template: try template.requiredTrack(tagged: linearThumbnailTag),
                samples: linearThumbnail.samples.map(\.stylePortBytes),
                deltas: deltas,
                hvcC: makeBox("hvcC", payload: linearThumbnail.hvcC.stylePortBytes),
                syncSamples: linearThumbnail.syncSamples
            ))
        }
        if adding.contains(.mattes) {
            // Every second frame, each sample spanning two main frames, like native videos.
            let pairDeltas = stride(from: 0, to: frames, by: 2).map {
                deltas[$0..<min($0 + 2, frames)].reduce(0, +)
            }
            for tag in matteTags where target.track(tagged: tag) == nil {
                let track = try template.requiredTrack(tagged: tag)
                guard let black = try template.samples(track).first else {
                    throw StylePortError.missingResource("live-photo-video template matte sample")
                }
                // The template's matte is one all-intra picture, so every copy is a sync sample.
                auxTracks.append(PendingTrack(
                    template: track,
                    samples: Array(repeating: black, count: pairDeltas.count),
                    deltas: pairDeltas,
                    hvcC: nil,
                    syncSamples: nil
                ))
            }
        }
        for (part, tag) in [(Parts.styleInfo, styleInfoTag), (.textureInfo, textureInfoTag)]
        where adding.contains(part) {
            // The template's per-frame samples, spread over the target's frames.
            let track = try template.requiredTrack(tagged: tag)
            let native = try template.samples(track)
            guard !native.isEmpty else {
                throw StylePortError.missingResource("live-photo-video template \(tag) samples")
            }
            metadataTracks.append(PendingTrack(
                template: track,
                samples: (0..<frames).map { native[min(native.count - 1, $0 * native.count / frames)] },
                deltas: deltas,
                hvcC: nil,
                syncSamples: nil
            ))
        }

        var prefixes: [String] = []
        if wanted.contains(.styleInfo) { prefixes.append(styleKeyPrefix) }
        if wanted.contains(.textureInfo) { prefixes.append(textureKeyPrefix) }
        let pending = auxTracks + metadataTracks
        for index in pending.indices { pending[index].trackID = nextID; nextID += 1 }

        // Offsets don't change moov's size, so build it once to measure and once for real.
        func buildMoov(firstSampleOffset: Int) throws -> Bytes {
            var cursor = firstSampleOffset
            var built: [Bytes] = []
            for track in pending {
                built.append(try cloneTrack(track, template: template, target: target,
                                            mainVideo: mainVideo, chunkOffset: cursor))
                cursor += track.samples.reduce(0) { $0 + $1.count }
            }
            var parts: [Bytes] = []
            for child in try target.moovChildren() {
                var chunk = try byteSlice(target.data, child.offset, child.size)
                if child.type == "mvhd" {
                    try writeBytes(bigEndianBytes(nextID, count: 4), into: &chunk, at: chunk.count - 4)
                } else if child.type == "meta", let templateMeta = try template.moovChild("meta") {
                    chunk = try mergedMeta(target: target, meta: child, template: template,
                                           templateMeta: templateMeta, prefixes: prefixes)
                }
                parts.append(chunk)
                if child == mainVideo { parts += built.prefix(auxTracks.count) }
            }
            parts += built.suffix(metadataTracks.count)
            return makeBox("moov", payload: concatenated(parts))
        }

        let moov = target.boxes.last!
        let head = Array(target.data[..<moov.offset])
        let measured = try buildMoov(firstSampleOffset: 0)
        let finalMoov = try buildMoov(firstSampleOffset: head.count + measured.count + 8)
        guard finalMoov.count == measured.count else {
            throw StylePortError.invalidData("The rebuilt moov changed size.")
        }
        let payload = concatenated(pending.flatMap(\.samples))
        let output = concatenated([head, finalMoov, makeBox("mdat", payload: payload)])
        return (Data(output), adding)
    }
}

/// A new track: a template track rebuilt around new samples and timing.
private final class PendingTrack {
    let template: ISOBox
    let samples: [Bytes]
    let deltas: [Int]
    let hvcC: Bytes?
    /// Zero-based; nil when every sample is a sync sample.
    let syncSamples: [Int]?
    var trackID = 0

    init(template: ISOBox, samples: [Bytes], deltas: [Int], hvcC: Bytes?, syncSamples: [Int]?) {
        self.template = template
        self.samples = samples
        self.deltas = deltas
        self.hvcC = hvcC
        self.syncSamples = syncSamples
    }
}

enum LivePhotoVideoTemplate {
    static func bytes() throws -> Bytes {
        let subdirectory = "Profiles/live-photo-video"
        guard let url = DonorProfileLoader.resourceBundle.url(
            forResource: "template",
            withExtension: "mov",
            subdirectory: subdirectory
        ) else {
            throw StylePortError.missingResource("\(subdirectory)/template.mov")
        }
        return try Data(contentsOf: url).stylePortBytes
    }
}

/// Just enough QuickTime reading for the style tracks.
struct Movie {
    let data: Bytes
    let boxes: [ISOBox]
    let moov: ISOBox

    init(_ data: Bytes) throws {
        self.data = data
        boxes = try siblingBoxes(data, from: 0, to: data.count)
        guard let moov = boxes.first(where: { $0.type == "moov" }) else {
            throw StylePortError.invalidData("The Live Photo video has no moov box.")
        }
        self.moov = moov
    }

    func children(_ box: ISOBox) throws -> [ISOBox] {
        try siblingBoxes(data, from: box.offset + box.headerSize, to: box.offset + box.size)
    }

    func child(_ box: ISOBox, _ path: String...) throws -> ISOBox? {
        var current = box
        for type in path {
            guard let next = try children(current).first(where: { $0.type == type }) else { return nil }
            current = next
        }
        return current
    }

    func moovChildren() throws -> [ISOBox] { try children(moov) }

    func moovChild(_ type: String) throws -> ISOBox? { try moovChildren().first { $0.type == type } }

    func tracks() throws -> [ISOBox] { try moovChildren().filter { $0.type == "trak" } }

    func handler(_ track: ISOBox) throws -> String? {
        guard let hdlr = try child(track, "mdia", "hdlr") else { return nil }
        return try fourCC(data, at: hdlr.offset + hdlr.headerSize + 8)
    }

    func mainVideo() throws -> ISOBox {
        guard let track = try tracks().first(where: { try handler($0) == "vide" }) else {
            throw StylePortError.invalidData("The Live Photo video has no video track.")
        }
        return track
    }

    /// The track whose bytes name `tag`: a trak-level `udta` name or a `mebx` key.
    func track(tagged tag: String) -> ISOBox? {
        let needle = Bytes(tag.utf8)
        return (try? tracks())?.first { track in
            let bytes = data[track.offset..<(track.offset + track.size)]
            return bytes.firstRange(of: needle) != nil
        }
    }

    func requiredTrack(tagged tag: String) throws -> ISOBox {
        guard let track = track(tagged: tag) else {
            throw StylePortError.missingResource("live-photo-video template track \(tag)")
        }
        return track
    }

    func nextTrackID() throws -> Int {
        guard let mvhd = try moovChild("mvhd") else {
            throw StylePortError.invalidData("The Live Photo video has no mvhd box.")
        }
        return try readUInt(data, mvhd.offset + mvhd.size - 4, 4)
    }

    func trackID(_ track: ISOBox) throws -> Int {
        guard let tkhd = try child(track, "tkhd") else {
            throw StylePortError.invalidData("A Live Photo video track has no tkhd box.")
        }
        let version = data[tkhd.offset + tkhd.headerSize]
        return try readUInt(data, tkhd.offset + tkhd.headerSize + 4 + (version == 1 ? 16 : 8), 4)
    }

    func sampleTables(_ track: ISOBox) throws -> [String: ISOBox] {
        guard let stbl = try child(track, "mdia", "minf", "stbl") else {
            throw StylePortError.invalidData("A Live Photo video track has no sample table.")
        }
        return Dictionary(try children(stbl).map { ($0.type, $0) }) { first, _ in first }
    }

    /// Each sample's duration, in decode order.
    func sampleDeltas(_ track: ISOBox) throws -> [Int] {
        guard let stts = try sampleTables(track)["stts"] else {
            throw StylePortError.invalidData("A Live Photo video track has no stts box.")
        }
        let body = stts.offset + stts.headerSize
        var deltas: [Int] = []
        for entry in 0..<(try readUInt(data, body + 4, 4)) {
            let count = try readUInt(data, body + 8 + 8 * entry, 4)
            let delta = try readUInt(data, body + 12 + 8 * entry, 4)
            deltas += Array(repeating: delta, count: count)
        }
        return deltas
    }

    /// Every sample's bytes, in decode order, from stsz/stsc/stco (co64).
    func samples(_ track: ISOBox) throws -> [Bytes] {
        let tables = try sampleTables(track)
        guard let stsz = tables["stsz"], let stsc = tables["stsc"],
              let offsets = tables["stco"] ?? tables["co64"] else {
            throw StylePortError.invalidData("A Live Photo video track has an incomplete sample table.")
        }
        var body = stsz.offset + stsz.headerSize
        let fixedSize = try readUInt(data, body + 4, 4)
        let count = try readUInt(data, body + 8, 4)
        let sizes = try fixedSize != 0
            ? Array(repeating: fixedSize, count: count)
            : (0..<count).map { try readUInt(data, body + 12 + 4 * $0, 4) }
        body = stsc.offset + stsc.headerSize
        let runs = try (0..<(try readUInt(data, body + 4, 4))).map {
            (first: try readUInt(data, body + 8 + 12 * $0, 4), perChunk: try readUInt(data, body + 12 + 12 * $0, 4))
        }
        body = offsets.offset + offsets.headerSize
        let width = offsets.type == "co64" ? 8 : 4
        let chunkOffsets = try (0..<(try readUInt(data, body + 4, 4))).map {
            try readUInt(data, body + 8 + width * $0, width)
        }
        var output: [Bytes] = []
        for (index, start) in chunkOffsets.enumerated() {
            let perChunk = runs.last { $0.first <= index + 1 }?.perChunk ?? 0
            var offset = start
            for _ in 0..<perChunk where output.count < count {
                output.append(try byteSlice(data, offset, sizes[output.count]))
                offset += sizes[output.count - 1]
            }
        }
        guard output.count == count else {
            throw StylePortError.invalidData("A Live Photo video track's sample table doesn't add up.")
        }
        return output
    }
}

private func fullBoxHeader() -> Bytes { [0, 0, 0, 0] }

private func uint32(_ value: Int) -> Bytes { bigEndianBytes(value, count: 4) }

private func sttsBox(_ deltas: [Int]) -> Bytes {
    var runs: [(count: Int, delta: Int)] = []
    for delta in deltas {
        if let last = runs.last, last.delta == delta {
            runs[runs.count - 1].count += 1
        } else {
            runs.append((1, delta))
        }
    }
    return makeBox("stts", payload: concatenated(
        [fullBoxHeader(), uint32(runs.count)] + runs.map { uint32($0.count) + uint32($0.delta) }
    ))
}

/// The template track rebuilt around new samples, the target's timing and one chunk at
/// `chunkOffset`.
private func cloneTrack(
    _ track: PendingTrack,
    template: Movie,
    target: Movie,
    mainVideo: ISOBox,
    chunkOffset: Int
) throws -> Bytes {
    let mainID = try target.trackID(mainVideo)
    let source = template.data

    func rebuild(_ start: Int, _ end: Int) throws -> Bytes {
        var output: [Bytes] = []
        for box in try siblingBoxes(source, from: start, to: end) {
            let body = box.offset + box.headerSize
            switch box.type {
            case "trak", "mdia", "minf", "stbl", "tref", "dinf":
                output.append(makeBox(box.type, payload: try rebuild(body, box.offset + box.size)))
            case "edts":
                if let edts = try target.child(mainVideo, "edts") {
                    output.append(try byteSlice(target.data, edts.offset, edts.size))
                }
            case "vmap", "cdsc", "cdep":
                let references = (box.size - box.headerSize) / 4
                output.append(makeBox(box.type, payload: concatenated(
                    Array(repeating: uint32(mainID), count: references)
                )))
            case "tkhd":
                var tkhd = try byteSlice(source, box.offset, box.size)
                let version = tkhd[box.headerSize]
                let idOffset = box.headerSize + 4 + (version == 1 ? 16 : 8)
                guard let mainTkhd = try target.child(mainVideo, "tkhd") else {
                    throw StylePortError.invalidData("The Live Photo video track has no tkhd box.")
                }
                let mainVersion = target.data[mainTkhd.offset + mainTkhd.headerSize]
                let durationOffset = mainTkhd.headerSize + 4 + (mainVersion == 1 ? 16 : 8) + 8
                let duration = try readUInt(target.data, mainTkhd.offset + durationOffset,
                                            mainVersion == 1 ? 8 : 4)
                try writeBytes(uint32(track.trackID), into: &tkhd, at: idOffset)
                try writeBytes(bigEndianBytes(duration, count: version == 1 ? 8 : 4),
                               into: &tkhd, at: idOffset + 8)
                output.append(tkhd)
            case "mdhd":
                guard let mdhd = try target.child(mainVideo, "mdia", "mdhd") else {
                    throw StylePortError.invalidData("The Live Photo video track has no mdhd box.")
                }
                output.append(try byteSlice(target.data, mdhd.offset, mdhd.size))
            case "stsd" where track.hvcC != nil:
                // One visual sample entry: an 86-byte head, then child boxes; swap its hvcC.
                let entry = body + 8
                let entrySize = try readUInt(source, entry, 4)
                let head = try byteSlice(source, entry + 4, 82)
                let extras = try siblingBoxes(source, from: entry + 86, to: entry + entrySize).map {
                    $0.type == "hvcC" ? track.hvcC! : try byteSlice(source, $0.offset, $0.size)
                }
                let newEntry = concatenated([head] + extras)
                output.append(makeBox("stsd", payload: concatenated(
                    [fullBoxHeader(), uint32(1), uint32(4 + newEntry.count), newEntry]
                )))
            case "stts":
                output.append(sttsBox(track.deltas))
            case "stss":
                break
            case "stsc":
                output.append(makeBox("stsc", payload: concatenated(
                    [fullBoxHeader(), uint32(1), uint32(1), uint32(track.samples.count), uint32(1)]
                )))
            case "stsz":
                output.append(makeBox("stsz", payload: concatenated(
                    [fullBoxHeader(), uint32(0), uint32(track.samples.count)]
                        + track.samples.map { uint32($0.count) }
                )))
                if let sync = track.syncSamples, sync.count < track.samples.count {
                    output.append(makeBox("stss", payload: concatenated(
                        [fullBoxHeader(), uint32(sync.count)] + sync.map { uint32($0 + 1) }
                    )))
                }
            case "stco", "co64":
                output.append(makeBox("stco", payload: concatenated(
                    [fullBoxHeader(), uint32(1), uint32(chunkOffset)]
                )))
            case "sdtp", "ctts", "sgpd", "sbgp", "cslg":
                break
            default:
                output.append(try byteSlice(source, box.offset, box.size))
            }
        }
        return concatenated(output)
    }

    let box = track.template
    return makeBox("trak", payload: try rebuild(box.offset + box.headerSize, box.offset + box.size))
}

/// (key, item body) pairs of a QuickTime `mdta` meta box: keys are full `keys` entries
/// (namespace + name), items are `ilst` children keyed by 1-based key index.
private func metaItems(_ movie: Movie, _ meta: ISOBox) throws -> (keys: [Bytes], items: [(Int, Bytes)]) {
    var keys: [Bytes] = []
    var items: [(Int, Bytes)] = []
    for box in try movie.children(meta) {
        let body = box.offset + box.headerSize
        if box.type == "keys" {
            var cursor = body + 8
            for _ in 0..<(try readUInt(movie.data, body + 4, 4)) {
                let size = try readUInt(movie.data, cursor, 4)
                keys.append(try byteSlice(movie.data, cursor, size))
                cursor += size
            }
        } else if box.type == "ilst" {
            for item in try movie.children(box) {
                items.append((
                    try readUInt(movie.data, item.offset + 4, 4),
                    try byteSlice(movie.data, item.offset + item.headerSize, item.size - item.headerSize)
                ))
            }
        }
    }
    return (keys, items)
}

/// The target's moov `meta` with the template's keys under `prefixes` that it lacks.
private func mergedMeta(
    target: Movie,
    meta: ISOBox,
    template: Movie,
    templateMeta: ISOBox,
    prefixes: [String]
) throws -> Bytes {
    var (keys, items) = try metaItems(target, meta)
    let (templateKeys, templateItems) = try metaItems(template, templateMeta)
    // A keys entry is size (4) + namespace (4) + name.
    let name = { (entry: Bytes) in Array(entry.dropFirst(8)) }
    let have = Set(keys.map(name))
    for (index, body) in templateItems where index >= 1 && index <= templateKeys.count {
        let key = templateKeys[index - 1]
        let keyName = name(key)
        guard !have.contains(keyName),
              prefixes.contains(where: { keyName.starts(with: Bytes($0.utf8)) }) else { continue }
        keys.append(key)
        items.append((keys.count, body))
    }
    var parts: [Bytes] = []
    for box in try target.children(meta) {
        switch box.type {
        case "keys":
            parts.append(makeBox("keys", payload: concatenated(
                [fullBoxHeader(), uint32(keys.count)] + keys
            )))
        case "ilst":
            parts.append(makeBox("ilst", payload: concatenated(
                items.map { uint32(8 + $0.1.count) + uint32($0.0) + $0.1 }
            )))
        default:
            parts.append(try byteSlice(target.data, box.offset, box.size))
        }
    }
    return makeBox("meta", payload: concatenated(parts))
}
