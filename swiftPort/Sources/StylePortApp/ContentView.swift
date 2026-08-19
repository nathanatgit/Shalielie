import Photos
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

#if os(macOS)
import AppKit
#else
import UIKit
#endif

struct ContentView: View {
    @StateObject private var model = AppModel()
    @State private var photoSelection: [PhotosPickerItem] = []
    @State private var isImportingFiles = false

    private let importTypes = [
        UTType(filenameExtension: "heic")!,
        UTType(filenameExtension: "heif")!
    ]

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 22) {
                    hero
                    controls
                    if model.jobs.isEmpty {
                        emptyState
                    } else {
                        LazyVStack(spacing: 12) {
                            ForEach(model.jobs) { job in
                                JobCard(job: job, model: model)
                            }
                        }
                    }
                }
                .frame(maxWidth: 760)
                .padding()
            }
            .background(Color(.stylePortBackground))
            .navigationTitle("StylePort")
            .fileImporter(
                isPresented: $isImportingFiles,
                allowedContentTypes: importTypes,
                allowsMultipleSelection: true
            ) { result in
                if case .success(let urls) = result {
                    model.importFiles(urls)
                }
            }
        }
        .onChange(of: photoSelection) { _, selection in
            guard !selection.isEmpty else { return }
            model.importPhotos(selection)
            photoSelection.removeAll()
        }
    }

    private var hero: some View {
        VStack(spacing: 9) {
            Image(systemName: "camera.filters")
                .font(.system(size: 48, weight: .semibold))
                .foregroundStyle(.tint)
                .accessibilityHidden(true)
            Text("StylePort")
                .font(.largeTitle.bold())
            Text("Photographic Styles Palette for HEIC and Live Photos")
                .font(.headline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Text("The original HEIC stays on device. Photos imports also keep the paired Live Photo video.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding(.vertical, 14)
    }

    private var controls: some View {
        VStack(spacing: 12) {
            ViewThatFits {
                HStack(spacing: 12) { importButtons }
                VStack(spacing: 12) { importButtons }
            }
            Toggle("Analyze each photo for a tailored palette", isOn: $model.analyzePhoto)
                .font(.subheadline)
        }
        .padding(16)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 18))
    }

    @ViewBuilder
    private var importButtons: some View {
        PhotosPicker(
            selection: $photoSelection,
            maxSelectionCount: 20,
            selectionBehavior: .ordered,
            matching: .images,
            preferredItemEncoding: .current,
            photoLibrary: .shared()
        ) {
            Label("Choose from Photos", systemImage: "photo.on.rectangle.angled")
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.borderedProminent)

        Button {
            isImportingFiles = true
        } label: {
            Label("Choose HEIC Files", systemImage: "folder")
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.bordered)
    }

    private var emptyState: some View {
        ContentUnavailableView(
            "No Photos Yet",
            systemImage: "photo.badge.plus",
            description: Text("Choose an original HEIC from Photos or Files to create a StylePort copy.")
        )
        .padding(.top, 24)
    }
}

private struct JobCard: View {
    let job: StylePortJob
    @ObservedObject var model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                Text(job.sourceName)
                    .font(.headline)
                    .lineLimit(1)
                Spacer()
                Button(role: .destructive) {
                    model.remove(job.id)
                } label: {
                    Image(systemName: "xmark.circle.fill")
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .accessibilityLabel("Remove")
            }
            phaseView
        }
        .padding(16)
        .background(.background, in: RoundedRectangle(cornerRadius: 16))
        .overlay {
            RoundedRectangle(cornerRadius: 16)
                .stroke(.quaternary, lineWidth: 1)
        }
    }

    @ViewBuilder
    private var phaseView: some View {
        switch job.phase {
        case .queued:
            status("Waiting", symbol: "clock")
        case .converting:
            HStack {
                ProgressView()
                Text("Reading the original and building the style palette…")
                    .foregroundStyle(.secondary)
            }
        case .ready(let result):
            resultView(result, saved: false, saving: false)
        case .saving(let result):
            resultView(result, saved: false, saving: true)
        case .saved(let result):
            resultView(result, saved: true, saving: false)
        case .saveFailed(let result, let message):
            resultView(result, saved: false, saving: false)
            Label(message, systemImage: "exclamationmark.triangle.fill")
                .foregroundStyle(.red)
                .font(.subheadline)
        case .failed(let message):
            Label(message, systemImage: "exclamationmark.triangle.fill")
                .foregroundStyle(.red)
                .font(.subheadline)
        }
    }

    @ViewBuilder
    private func resultView(_ result: ProcessedPhoto, saved: Bool, saving: Bool) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Label(
                result.isLivePhoto ? "HEIC ready · Live Photo pair retained" : "HEIC ready",
                systemImage: result.isLivePhoto ? "livephoto" : "checkmark.circle.fill"
            )
            .foregroundStyle(.green)

            HStack {
                Button {
                    model.save(result, jobID: job.id)
                } label: {
                    if saving {
                        ProgressView()
                    } else {
                        Label(
                            saved ? "Saved to Photos" : "Save to Photos",
                            systemImage: saved ? "checkmark" : "square.and.arrow.down"
                        )
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(saved || saving)

                ShareLink(item: result.outputURL) {
                    Label("Share HEIC", systemImage: "square.and.arrow.up")
                }
                .buttonStyle(.bordered)
            }

            if !result.report.warnings.isEmpty {
                DisclosureGroup("Conversion notes") {
                    ForEach(result.report.warnings, id: \.self) { warning in
                        Text(warning)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .font(.caption)
            }
        }
    }

    private func status(_ title: String, symbol: String) -> some View {
        Label(title, systemImage: symbol)
            .foregroundStyle(.secondary)
    }
}

#if os(macOS)
private extension NSColor {
    static let stylePortBackground = windowBackgroundColor
}
#else
private extension UIColor {
    static let stylePortBackground = systemGroupedBackground
}
#endif

#Preview {
    ContentView()
}
