import Photos
import StylePortCore
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// "Palettify" in the Share sheet: adds the Photographic Style to the shared photos and saves
/// each as a new photo, like the Shortcuts action. It never replaces a photo, and Live Photos
/// are saved as stills: the Share sheet hands over the still only. The app mirrors Analyze Each
/// Photo, Texture & Grain and Any Image into an App Group (`SharedSettings`), which this follows;
/// with Any Image on, JPEGs, PNGs and other pictures are converted to HEIC first.
final class ShareViewController: UIViewController {
    private let model = ShareModel()

    override func viewDidLoad() {
        super.viewDidLoad()
        let host = UIHostingController(rootView: ShareView(model: model) { [weak self] in
            self?.extensionContext?.completeRequest(returningItems: nil)
        })
        addChild(host)
        host.view.frame = view.bounds
        host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(host.view)
        host.didMove(toParent: self)
        let items = extensionContext?.inputItems as? [NSExtensionItem] ?? []
        model.start(items.flatMap { $0.attachments ?? [] })
    }
}

@MainActor
final class ShareModel: ObservableObject {
    enum State {
        case working(done: Int, total: Int)
        case finished(saved: Int, failures: [String])
    }

    @Published private(set) var state = State.working(done: 0, total: 0)

    func start(_ providers: [NSItemProvider]) {
        let photos = providers.filter { $0.hasItemConformingToTypeIdentifier(UTType.image.identifier) }
        state = .working(done: 0, total: photos.count)
        Task {
            var saved = 0
            var failures: [String] = []
            // One at a time: a share extension has little memory, and a 48 MP photo is large.
            for (index, provider) in photos.enumerated() {
                do {
                    try await Self.style(provider)
                    saved += 1
                } catch {
                    failures.append("\(provider.suggestedName ?? String(localized: "Photo")): \(error.localizedDescription)")
                }
                state = .working(done: index + 1, total: photos.count)
            }
            state = .finished(saved: saved, failures: failures)
        }
    }

    private static func style(_ provider: NSItemProvider) async throws {
        var settings = SharedSettings.porterOptions()
        let anyImage = settings.sdr
        let original = try await loadImage(provider, anyImage: anyImage)
        var converted: Data?
        if anyImage {
            converted = try RasterImport.convertedForPort(original, captureDate: nil, allowSDR: true)
        }
        settings.converted = converted != nil
        let options = settings
        let data = converted ?? original
        let result = try await Task.detached(priority: .userInitiated) {
            try StylePorter().patch(data, options: options)
        }.value
        let base = ((provider.suggestedName ?? "Photo") as NSString).deletingPathExtension
        let suffix = result.report.mode == .addTexture ? "_TextureGrain" : "_PhotographicStyle"
        try await save(result.data, filename: base + suffix + ".HEIC")
    }

    /// The shared picture's file. HEIC only, unless Any Image is on: then any image type.
    private static func loadImage(_ provider: NSItemProvider, anyImage: Bool) async throws -> Data {
        let types = provider.registeredTypeIdentifiers.compactMap(UTType.init)
        let heic = types.first { $0.conforms(to: .heic) || $0.conforms(to: .heif) }
        guard let type = heic ?? (anyImage ? types.first { $0.conforms(to: .image) } : nil) else {
            throw ShareError.notHEIC
        }
        return try await withCheckedThrowingContinuation { continuation in
            _ = provider.loadFileRepresentation(forTypeIdentifier: type.identifier) { url, error in
                // The file only exists during this callback.
                if let url, let data = try? Data(contentsOf: url) {
                    continuation.resume(returning: data)
                } else {
                    continuation.resume(throwing: error ?? ShareError.unreadable)
                }
            }
        }
    }

    private static func save(_ data: Data, filename: String) async throws {
        let status = await PHPhotoLibrary.requestAuthorization(for: .addOnly)
        guard status == .authorized || status == .limited else { throw ShareError.noAddAccess }
        try await PHPhotoLibrary.shared().performChanges {
            let options = PHAssetResourceCreationOptions()
            options.originalFilename = filename
            options.uniformTypeIdentifier = UTType.heic.identifier
            PHAssetCreationRequest.forAsset().addResource(with: .photo, data: data, options: options)
        }
    }
}

enum ShareError: LocalizedError {
    case notHEIC, unreadable, noAddAccess

    var errorDescription: String? {
        switch self {
        case .notHEIC: return String(localized: "This photo's original isn't a HEIC.")
        case .unreadable: return String(localized: "The photo couldn't be read.")
        case .noAddAccess: return String(localized: "Allow adding to your photo library in Settings to save the result.")
        }
    }
}

struct ShareView: View {
    @ObservedObject var model: ShareModel
    let close: () -> Void

    var body: some View {
        NavigationStack {
            VStack(spacing: 16) {
                switch model.state {
                case .working(let done, let total):
                    ProgressView(value: Double(done), total: Double(max(total, 1)))
                        .frame(maxWidth: 240)
                    Text("Styling \(min(done + 1, max(total, 1))) of \(max(total, 1))…")
                        .font(.headline)
                case .finished(let saved, let failures):
                    Image(systemName: failures.isEmpty ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
                        .font(.system(size: 44))
                        .foregroundStyle(failures.isEmpty ? .green : .orange)
                    Text(saved == 1 ? String(localized: "1 photo saved to Photos")
                         : String(localized: "\(saved) photos saved to Photos"))
                        .font(.headline)
                    Text("Saved as new photos; the originals are unchanged. Live Photos are saved as stills.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                    if !failures.isEmpty {
                        ScrollView {
                            VStack(alignment: .leading, spacing: 6) {
                                ForEach(failures, id: \.self) { Text($0).font(.footnote) }
                            }
                        }
                        .frame(maxHeight: 160)
                    }
                }
            }
            .padding(24)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .navigationTitle("Palettify")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done", action: close)
                }
            }
        }
    }
}
