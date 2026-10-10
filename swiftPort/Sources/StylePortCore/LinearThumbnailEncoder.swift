#if canImport(AVFoundation) && canImport(VideoToolbox)
import AVFoundation
import VideoToolbox

/// Encodes a Live Photo video's linear thumbnail on the device: every frame of the main
/// video, in stored orientation, at 128x96 as HEVC Main 10 without frame reordering and a key
/// frame at least every 30 frames, as `mov_style_tracks.py` does with ffmpeg.
public enum LinearThumbnailEncoder {
    public static let width = 128
    public static let height = 96

    public static func encode(videoURL: URL) async throws -> LivePhotoVideo.LinearThumbnail {
        let asset = AVURLAsset(url: videoURL)
        guard let track = try await asset.loadTracks(withMediaType: .video).first else {
            throw StylePortError.invalidData("The Live Photo video has no video track.")
        }
        let reader = try AVAssetReader(asset: asset)
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr10BiPlanarVideoRange
        ])
        output.alwaysCopiesSampleData = false
        guard reader.canAdd(output) else {
            throw StylePortError.invalidData("The Live Photo video can't be decoded.")
        }
        reader.add(output)

        let encoder = try Encoder()
        defer { encoder.invalidate() }
        guard reader.startReading() else {
            throw reader.error ?? StylePortError.invalidData("The Live Photo video can't be read.")
        }
        while let sample = output.copyNextSampleBuffer() {
            guard let image = CMSampleBufferGetImageBuffer(sample) else { continue }
            try encoder.encode(
                image,
                presentationTime: CMSampleBufferGetPresentationTimeStamp(sample),
                duration: CMSampleBufferGetDuration(sample)
            )
        }
        if reader.status == .failed {
            throw reader.error ?? StylePortError.invalidData("The Live Photo video can't be read.")
        }
        return try encoder.finish()
    }

    private final class Encoder: @unchecked Sendable {
        private let session: VTCompressionSession
        private let transfer: VTPixelTransferSession
        private let pool: CVPixelBufferPool
        private let lock = NSLock()
        /// Frames handed to the encoder, and what came back for each, by input index.
        private var pendingCount = 0
        private var collected: [Int: (Data, Bool)] = [:]
        private var hvcC: Data?
        private var failure: OSStatus = noErr

        init() throws {
            var session: VTCompressionSession?
            try check(VTCompressionSessionCreate(
                allocator: nil,
                width: Int32(LinearThumbnailEncoder.width),
                height: Int32(LinearThumbnailEncoder.height),
                codecType: kCMVideoCodecType_HEVC,
                encoderSpecification: nil,
                imageBufferAttributes: nil,
                compressedDataAllocator: nil,
                outputCallback: nil,
                refcon: nil,
                compressionSessionOut: &session
            ), "create the HEVC encoder")
            guard let session else { throw StylePortError.invalidData("No HEVC encoder.") }
            self.session = session
            try check(VTSessionSetProperty(session, key: kVTCompressionPropertyKey_ProfileLevel,
                                           value: kVTProfileLevel_HEVC_Main10_AutoLevel), "select Main 10")
            try check(VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AllowFrameReordering,
                                           value: kCFBooleanFalse), "turn off frame reordering")
            try check(VTSessionSetProperty(session, key: kVTCompressionPropertyKey_MaxKeyFrameInterval,
                                           value: 30 as CFNumber), "set the key frame interval")
            try check(VTSessionSetProperty(session, key: kVTCompressionPropertyKey_RealTime,
                                           value: kCFBooleanFalse), "turn off real-time encoding")

            var transfer: VTPixelTransferSession?
            try check(VTPixelTransferSessionCreate(allocator: nil, pixelTransferSessionOut: &transfer),
                      "create the scaler")
            guard let transfer else { throw StylePortError.invalidData("No scaler.") }
            self.transfer = transfer

            var pool: CVPixelBufferPool?
            let attributes: [String: Any] = [
                kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr10BiPlanarVideoRange,
                kCVPixelBufferWidthKey as String: LinearThumbnailEncoder.width,
                kCVPixelBufferHeightKey as String: LinearThumbnailEncoder.height,
                kCVPixelBufferIOSurfacePropertiesKey as String: [String: Any]()
            ]
            try check(CVPixelBufferPoolCreate(nil, nil, attributes as CFDictionary, &pool),
                      "create the frame pool")
            guard let pool else { throw StylePortError.invalidData("No frame pool.") }
            self.pool = pool
        }

        func encode(_ image: CVImageBuffer, presentationTime: CMTime, duration: CMTime) throws {
            var scaled: CVPixelBuffer?
            try check(CVPixelBufferPoolCreatePixelBuffer(nil, pool, &scaled), "allocate a frame")
            guard let scaled else { throw StylePortError.invalidData("No frame.") }
            try check(VTPixelTransferSessionTransferImage(transfer, from: image, to: scaled), "scale a frame")
            let index = lock.withLock {
                defer { pendingCount += 1 }
                return pendingCount
            }
            try check(VTCompressionSessionEncodeFrame(
                session,
                imageBuffer: scaled,
                presentationTimeStamp: presentationTime,
                duration: duration,
                frameProperties: nil,
                infoFlagsOut: nil
            ) { [self] status, _, sample in
                self.collect(status: status, sample: sample, index: index)
            }, "encode a frame")
        }

        private func collect(status: OSStatus, sample: CMSampleBuffer?, index: Int) {
            lock.lock()
            defer { lock.unlock() }
            guard status == noErr, let sample, let block = CMSampleBufferGetDataBuffer(sample) else {
                if failure == noErr { failure = status == noErr ? -1 : status }
                return
            }
            var bytes = Data(count: CMBlockBufferGetDataLength(block))
            let copied = bytes.withUnsafeMutableBytes {
                CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: $0.count, destination: $0.baseAddress!)
            }
            guard copied == noErr else {
                if failure == noErr { failure = copied }
                return
            }
            let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false)
                as? [[CFString: Any]]
            let notSync = attachments?.first?[kCMSampleAttachmentKey_NotSync] as? Bool ?? false
            collected[index] = (bytes, !notSync)
            if hvcC == nil, let format = CMSampleBufferGetFormatDescription(sample),
               let atoms = CMFormatDescriptionGetExtension(
                   format, extensionKey: kCMFormatDescriptionExtension_SampleDescriptionExtensionAtoms
               ) as? [String: Any] {
                hvcC = atoms["hvcC"] as? Data
            }
        }

        func finish() throws -> LivePhotoVideo.LinearThumbnail {
            try check(VTCompressionSessionCompleteFrames(session, untilPresentationTimeStamp: .invalid),
                      "finish encoding")
            return try lock.withLock {
                guard failure == noErr else { throw encoderError(failure, "encode a frame") }
                guard let hvcC else { throw StylePortError.invalidData("The HEVC encoder gave no hvcC.") }
                guard collected.count == pendingCount else {
                    throw StylePortError.invalidData(
                        "The HEVC encoder returned \(collected.count) of \(pendingCount) frames."
                    )
                }
                let ordered = (0..<pendingCount).map { collected[$0]! }
                return LivePhotoVideo.LinearThumbnail(
                    samples: ordered.map(\.0),
                    hvcC: hvcC,
                    syncSamples: ordered.indices.filter { ordered[$0].1 }
                )
            }
        }

        func invalidate() {
            VTCompressionSessionInvalidate(session)
            VTPixelTransferSessionInvalidate(transfer)
        }
    }
}

private func check(_ status: OSStatus, _ action: String) throws {
    guard status == noErr else { throw encoderError(status, action) }
}

private func encoderError(_ status: OSStatus, _ action: String) -> StylePortError {
    .invalidData("Couldn't \(action) for the Live Photo video (\(status)).")
}
#endif
