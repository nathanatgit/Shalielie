import SwiftUI

/// Every photo in the current and last batch, with what happened to it.
struct ActivitySheet: View {
    @EnvironmentObject private var queue: PortQueue
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                ForEach(queue.jobs) { job in
                    VStack(alignment: .leading, spacing: 6) {
                        HStack(spacing: 10) {
                            phaseIcon(job)
                                .frame(width: 22)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(job.title)
                                    .font(.body)
                                    .lineLimit(1)
                                Text(detail(job))
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            if let url = job.outputURL, case .done = job.phase {
                                ShareLink(item: url) {
                                    Image(systemName: "square.and.arrow.up")
                                }
                                .buttonStyle(.borderless)
                            }
                        }
                        if !job.warnings.isEmpty || job.isFailed {
                            JobNotes(job: job)
                                .padding(.leading, 32)
                        }
                    }
                    .padding(.vertical, 2)
                }
            }
            .overlay {
                if queue.jobs.isEmpty {
                    ContentUnavailableView("Nothing in Progress", systemImage: "checkmark.circle")
                }
            }
            .navigationTitle("Activity")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Clear") { queue.clearFinished() }
                        .disabled(queue.jobs.allSatisfy { !$0.isFinished })
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    @ViewBuilder
    private func phaseIcon(_ job: PortJob) -> some View {
        switch job.phase {
        case .waiting:
            Image(systemName: "clock").foregroundStyle(.secondary)
        case .done:
            Image(systemName: job.isLivePhoto ? "livephoto" : "checkmark.circle.fill")
                .foregroundStyle(.green)
        case .failed:
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.red)
        default:
            ProgressView()
        }
    }

    private func detail(_ job: PortJob) -> String {
        switch job.phase {
        case .waiting: return "Waiting"
        case .reading: return "Reading the original"
        case .porting: return "Adding the style"
        case .saving: return "Saving to Photos"
        case .failed: return "Failed"
        case .done:
            guard let report = job.report else { return "Done" }
            var parts: [String] = []
            switch report.mode {
            case .addTexture: parts.append("Texture & Grain added")
            case .photoGraph, .donorGraph: parts.append("Photographic Style added")
            }
            if report.mode != .addTexture && report.addedTexture { parts.append("with Texture & Grain") }
            if job.isLivePhoto { parts.append("Live Photo kept") }
            return parts.joined(separator: " · ")
        }
    }
}
