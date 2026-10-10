import Foundation
import StylePortCore

/// Gives a Live Photo's video the style parts its styled still needs, so Photos can edit the
/// pair: Photos' editor connects the style (and Texture/Grain) steps to parts of the video and
/// aborts when they are missing.
enum LivePhotoStyler {
    /// Writes the video at `source` to `destination` with the parts it lacks: the linear
    /// thumbnail, mattes and style metadata, plus the Texture/Grain metadata when the still
    /// has Texture/Grain. A video that has them all is copied as is.
    static func style(_ source: URL, to destination: URL, texture: Bool) async throws {
        let video = try Data(contentsOf: source, options: .mappedIfSafe)
        var wanted = LivePhotoVideo.Parts.style
        if texture { wanted.insert(.textureInfo) }
        let missing = wanted.subtracting(try LivePhotoVideo.parts(of: video))
        guard !missing.isEmpty else {
            try FileManager.default.copyItem(at: source, to: destination)
            return
        }
        let thumbnail = missing.contains(.linearThumbnail)
            ? try await LinearThumbnailEncoder.encode(videoURL: source)
            : nil
        let styled = try LivePhotoVideo.add(wanted, to: video, linearThumbnail: thumbnail)
        try styled.0.write(to: destination, options: .atomic)
    }
}
