import ImageIO
import Photos
import StylePortCore
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// "Palettify" in the Share sheet: adds the Photographic Style to the shared photos and saves
/// each as a new photo, like the Shortcuts action. It never replaces a photo (the Share sheet
/// has no handle on the library asset), and Live Photos are saved as stills: the Share sheet
/// hands over the still only.
///
/// It opens on a review screen: a thumbnail, the file name and whether Palettify can style it
/// for each shared picture, then the switches that apply to this share, then the Style button.
/// The switches start from Palettify's own settings, which the app mirrors into an App Group
/// (`SharedSettings`); changing them here applies to this share only.
final class ShareViewController: UIViewController {
    private let model = ShareModel()

    override func viewDidLoad() {
        super.viewDidLoad()
        let host = UIHostingController(rootView: ShareView(
            model: model,
            cancel: { [weak self] in
                self?.extensionContext?.cancelRequest(withError: NSError(domain: NSCocoaErrorDomain, code: NSUserCancelledError))
            },
            close: { [weak self] in self?.extensionContext?.completeRequest(returningItems: nil) }))
        addChild(host)
        host.view.frame = view.bounds
        host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(host.view)
        host.didMove(toParent: self)
        let items = extensionContext?.inputItems as? [NSExtensionItem] ?? []
        model.load(items.flatMap { $0.attachments ?? [] })
    }
}

/// One shared picture in the review list.
struct ShareItem: Identifiable {
    let id = UUID()
    let provider: NSItemProvider
    let name: String
    let isHEIC: Bool
    var thumbnail: UIImage?
}

@MainActor
final class ShareModel: ObservableObject {
    enum Phase {
        case review
        case working(done: Int, total: Int)
        case finished(saved: Int, failures: [String])
    }

    @Published private(set) var phase = Phase.review
    @Published private(set) var items: [ShareItem] = []
    @Published var analyzePhoto: Bool
    @Published var texture: Bool
    @Published var anyImage: Bool
    @Published var detectPeople: Bool

    init() {
        let options = SharedSettings.porterOptions()
        analyzePhoto = options.analyzePhoto
        texture = options.texture
        anyImage = options.sdr
        detectPeople = options.detectPeople
    }

    /// Pictures Palettify can style with the current switches: HEIC always, anything else only
    /// when Any Image is on.
    func canStyle(_ item: ShareItem) -> Bool { item.isHEIC || anyImage }

    var styleCount: Int { items.filter(canStyle).count }

    func load(_ providers: [NSItemProvider]) {
        let photos = providers.filter { $0.hasItemConformingToTypeIdentifier(UTType.image.identifier) }
        items = photos.map { provider in
            let types = provider.registeredTypeIdentifiers.compactMap(UTType.init)
            let heic = types.contains { $0.conforms(to: .heic) || $0.conforms(to: .heif) }
            return ShareItem(provider: provider, name: provider.suggestedName ?? String(localized: "Photo"),
                             isHEIC: heic, thumbnail: nil)
        }
        Task {
            // One at a time: a share extension has little memory.
            for index in items.indices {
                let image = await Self.thumbnail(of: items[index].provider)
                if index < items.count { items[index].thumbnail = image }
            }
        }
    }

    func run() {
        let chosen = items.filter(canStyle)
        guard !chosen.isEmpty else { return }
        let settings = StylePortOptions(analyzePhoto: analyzePhoto, texture: texture, sdr: anyImage,
                                        detectPeople: texture && detectPeople)
        let convert = anyImage
        phase = .working(done: 0, total: chosen.count)
        Task {
            var saved = 0
            var failures: [String] = []
            // One at a time: a share extension has little memory, and a 48 MP photo is large.
            for (index, item) in chosen.enumerated() {
                do {
                    try await Self.style(item, options: settings, convert: convert)
                    saved += 1
                } catch {
                    failures.append("\(item.name): \(error.localizedDescription)")
                }
                phase = .working(done: index + 1, total: chosen.count)
            }
            phase = .finished(saved: saved, failures: failures)
        }
    }

    // MARK: - Styling

    private static func style(_ item: ShareItem, options: StylePortOptions, convert: Bool) async throws {
        let original = try await loadImage(item.provider, anyImage: convert)
        var settings = options
        var converted: Data?
        if convert {
            converted = try RasterImport.convertedForPort(original, captureDate: nil, allowSDR: true)
        }
        settings.converted = converted != nil
        let run = settings
        let data = converted ?? original
        let result = try await Task.detached(priority: .userInitiated) {
            try StylePorter().patch(data, options: run)
        }.value
        let base = (item.name as NSString).deletingPathExtension
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

    /// A small square-ish preview, decoded from the file without loading the whole picture.
    private static func thumbnail(of provider: NSItemProvider) async -> UIImage? {
        guard let type = provider.registeredTypeIdentifiers.compactMap(UTType.init)
            .first(where: { $0.conforms(to: .image) }) else { return nil }
        return await withCheckedContinuation { continuation in
            _ = provider.loadFileRepresentation(forTypeIdentifier: type.identifier) { url, _ in
                guard let url, let source = CGImageSourceCreateWithURL(url as CFURL, nil),
                      let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                        kCGImageSourceCreateThumbnailFromImageAlways: true,
                        kCGImageSourceCreateThumbnailWithTransform: true,
                        kCGImageSourceThumbnailMaxPixelSize: 192
                      ] as CFDictionary) else {
                    continuation.resume(returning: nil)
                    return
                }
                continuation.resume(returning: UIImage(cgImage: image))
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
    let cancel: () -> Void
    let close: () -> Void

    var body: some View {
        NavigationStack {
            Group {
                switch model.phase {
                case .review: review
                case .working(let done, let total): working(done: done, total: total)
                case .finished(let saved, let failures): finished(saved: saved, failures: failures)
                }
            }
            .navigationTitle("Palettify")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if case .review = model.phase {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel", action: cancel) }
                }
                if case .finished = model.phase {
                    ToolbarItem(placement: .confirmationAction) { Button("Done", action: close) }
                }
            }
        }
    }

    // MARK: - Review: the pictures, the switches, the button

    private var review: some View {
        Form {
            Section {
                ForEach(model.items) { item in
                    HStack(spacing: 12) {
                        Thumbnail(image: item.thumbnail)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(item.name)
                                .font(.subheadline.weight(.semibold))
                                .lineLimit(1)
                                .truncationMode(.middle)
                            status(of: item)
                        }
                    }
                }
            }

            Section {
                Toggle("Analyze Each Photo", isOn: $model.analyzePhoto)
                Toggle("Add Texture & Grain", isOn: $model.texture)
                Toggle("Any Image", isOn: $model.anyImage)
                Toggle("Find Faces for Soft Skin", isOn: $model.detectPeople)
                    .disabled(!model.texture)
            } footer: {
                Text("These settings come from Palettify and apply to this share. Photos are saved as new photos; originals are never replaced.")
            }

            Section {
                Button {
                    model.run()
                } label: {
                    Text(String(localized: "Style \(model.styleCount) Photos"))
                        .font(.headline)
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(model.styleCount == 0)
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets())
            }
        }
    }

    @ViewBuilder
    private func status(of item: ShareItem) -> some View {
        if item.isHEIC {
            Label("Ready", systemImage: "checkmark.circle.fill")
                .foregroundStyle(.green)
                .font(.footnote)
        } else if model.anyImage {
            Label("Converted to HEIC first (experimental)", systemImage: "arrow.triangle.2.circlepath")
                .foregroundStyle(.secondary)
                .font(.footnote)
        } else {
            Label("Not available: not a HEIC", systemImage: "exclamationmark.triangle.fill")
                .foregroundStyle(.orange)
                .font(.footnote)
        }
    }

    // MARK: - Working and finished

    private func working(done: Int, total: Int) -> some View {
        VStack(spacing: 16) {
            ProgressView(value: Double(done), total: Double(max(total, 1)))
                .frame(maxWidth: 240)
            Text("Styling \(min(done + 1, max(total, 1))) of \(max(total, 1))…")
                .font(.headline)
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func finished(saved: Int, failures: [String]) -> some View {
        VStack(spacing: 16) {
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
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

private struct Thumbnail: View {
    let image: UIImage?

    var body: some View {
        ZStack {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
            } else {
                Color.secondary.opacity(0.15)
                Image(systemName: "photo")
                    .foregroundStyle(.secondary)
            }
        }
        .frame(width: 52, height: 52)
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
    }
}
