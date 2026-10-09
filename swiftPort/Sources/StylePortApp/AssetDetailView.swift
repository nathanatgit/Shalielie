import Photos
import PhotosUI
import StylePortCore
import SwiftUI

/// One photo: the picture (playing as a Live Photo when it is one), what the port would do
/// with it, and the Add Style action.
struct AssetDetailView: View {
    let identifier: String

    @EnvironmentObject private var queue: PortQueue
    @AppStorage(AppSettings.replaceOriginalsKey) private var replaceOriginals = false
    @State private var asset: PHAsset?
    @State private var loaded = false
    @State private var eligibility: StylePorter.Eligibility?
    @State private var eligibilityChecked = false
    @State private var confirmingReplace = false

    private var job: PortJob? { queue.job(forAsset: identifier) }

    var body: some View {
        Group {
            if let asset {
                details(asset)
            } else if loaded {
                ContentUnavailableView {
                    Label(
                        job.map { _ in "Replaced" } ?? "Photo Unavailable",
                        systemImage: job == nil ? "photo" : "checkmark.seal"
                    )
                } description: {
                    Text(job == nil
                         ? "This photo is no longer in your library."
                         : "The styled version took its place. The original is in the Backup Bin.")
                }
            } else {
                ProgressView()
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .task(id: jobState) { await refresh() }
    }

    /// Changes whenever the job for this photo moves on, so the view re-reads the asset.
    private var jobState: String {
        guard let job else { return "none" }
        switch job.phase {
        case .done: return "done"
        case .failed: return "failed"
        default: return "running"
        }
    }

    private func refresh() async {
        asset = PHAsset.fetchAssets(withLocalIdentifiers: [identifier], options: nil).firstObject
        loaded = true
        if let asset, !eligibilityChecked || jobState == "done" {
            eligibility = await PhotoLibraryService().eligibility(of: asset)
            eligibilityChecked = true
        }
    }

    private func details(_ asset: PHAsset) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                AssetMedia(asset: asset)
                    .aspectRatio(
                        CGFloat(max(asset.pixelWidth, 1)) / CGFloat(max(asset.pixelHeight, 1)),
                        contentMode: .fit
                    )
                    .frame(maxWidth: .infinity)
                    .clipShape(RoundedRectangle(cornerRadius: 12))

                infoList(asset)
                    .padding(.horizontal)

                if let job, !job.warnings.isEmpty || job.isFailed {
                    JobNotes(job: job)
                        .padding(.horizontal)
                }
            }
            .padding(.vertical)
            .padding(.bottom, 80)
        }
        .navigationTitle(PhotoLibraryService.filename(of: asset))
        .safeAreaInset(edge: .bottom) { actionBar(asset) }
        .confirmationDialog(
            "Replace this photo with its styled version?",
            isPresented: $confirmingReplace,
            titleVisibility: .visible
        ) {
            Button("Replace", role: .destructive) { queue.port([asset]) }
        } message: {
            Text("The original is kept in the Backup Bin, and iOS asks you to confirm deleting it from your library.")
        }
    }

    private func infoList(_ asset: PHAsset) -> some View {
        VStack(spacing: 0) {
            InfoRow(title: "Captured", value: asset.creationDate?.formatted(date: .abbreviated, time: .shortened) ?? "Unknown")
            Divider()
            InfoRow(title: "Size", value: "\(asset.pixelWidth) × \(asset.pixelHeight)")
            Divider()
            InfoRow(title: "Live Photo", value: asset.mediaSubtypes.contains(.photoLive) ? "Yes, the motion is kept" : "No")
            Divider()
            InfoRow(title: "Photographic Style", value: styleStatus(asset))
        }
        .background(.background.secondary, in: RoundedRectangle(cornerRadius: 12))
    }

    private func styleStatus(_ asset: PHAsset) -> String {
        if !PhotoLibraryService.isHEIC(asset) { return "Not available: not a HEIC" }
        switch eligibility {
        case .port: return "Can be added"
        case .addTexture: return "Has a style; Texture & Grain can be added"
        case .alreadyStyled: return "Already has a style and Texture & Grain"
        case .unsupported: return "This HEIC isn't supported yet"
        case nil: return eligibilityChecked ? "Checked when you add it (in iCloud)" : "Checking…"
        }
    }

    @ViewBuilder
    private func actionBar(_ asset: PHAsset) -> some View {
        let running = job.map { !$0.isFinished } ?? false
        let blocked = !PhotoLibraryService.isHEIC(asset)
            || eligibility == .alreadyStyled || eligibility == .unsupported
        Button {
            if replaceOriginals { confirmingReplace = true } else { queue.port([asset]) }
        } label: {
            HStack {
                if running {
                    ProgressView().tint(.white)
                    Text(progressText)
                } else {
                    Label(actionTitle, systemImage: replaceOriginals ? "arrow.triangle.2.circlepath" : "camera.filters")
                }
            }
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.large)
        .disabled(running || blocked)
        .padding()
        .background(.bar)
    }

    private var actionTitle: String {
        let what = eligibility == .addTexture ? "Texture & Grain" : "Photographic Style"
        if case .done = job?.phase { return replaceOriginals ? "Replace Again" : "Add \(what) Again" }
        return replaceOriginals ? "Replace with \(what)" : "Add \(what)"
    }

    private var progressText: String {
        switch job?.phase {
        case .reading: return "Reading original…"
        case .porting: return "Adding style…"
        case .saving: return "Saving…"
        default: return "Waiting…"
        }
    }
}

private struct InfoRow: View {
    let title: String
    let value: String

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title)
                .foregroundStyle(.secondary)
            Spacer(minLength: 16)
            Text(value)
                .multilineTextAlignment(.trailing)
        }
        .font(.subheadline)
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
    }
}

/// Warnings and errors for a finished job.
struct JobNotes: View {
    let job: PortJob

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if case .failed(let message) = job.phase {
                Label(message, systemImage: "exclamationmark.triangle.fill")
                    .foregroundStyle(.red)
            }
            ForEach(job.warnings, id: \.self) { warning in
                Label(warning, systemImage: "info.circle")
                    .foregroundStyle(.secondary)
            }
        }
        .font(.footnote)
    }
}

/// The photo, played as a Live Photo when it is one.
private struct AssetMedia: View {
    let asset: PHAsset

    var body: some View {
        if asset.mediaSubtypes.contains(.photoLive) {
            LivePhotoPlayer(asset: asset)
        } else {
            AssetImage(asset: asset, contentMode: .fit)
        }
    }
}

private struct LivePhotoPlayer: UIViewRepresentable {
    let asset: PHAsset

    func makeUIView(context: Context) -> PHLivePhotoView {
        let view = PHLivePhotoView()
        view.contentMode = .scaleAspectFit
        let badge = UIImageView(image: PHLivePhotoView.livePhotoBadgeImage(options: .overContent))
        badge.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(badge)
        NSLayoutConstraint.activate([
            badge.topAnchor.constraint(equalTo: view.topAnchor, constant: 8),
            badge.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 8)
        ])
        return view
    }

    func updateUIView(_ view: PHLivePhotoView, context: Context) {
        guard context.coordinator.identifier != asset.localIdentifier else { return }
        context.coordinator.identifier = asset.localIdentifier
        let options = PHLivePhotoRequestOptions()
        options.deliveryMode = .opportunistic
        options.isNetworkAccessAllowed = true
        let scale = view.window?.screen.scale ?? 3
        let size = CGSize(width: max(view.bounds.width, 400) * scale, height: max(view.bounds.height, 400) * scale)
        PHImageManager.default().requestLivePhoto(
            for: asset,
            targetSize: size,
            contentMode: .aspectFit,
            options: options
        ) { livePhoto, _ in
            if let livePhoto { view.livePhoto = livePhoto }
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator {
        var identifier: String?
    }
}
