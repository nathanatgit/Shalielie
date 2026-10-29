import SwiftUI

/// One photo of a batch, with what happened to it: the Activity sheet's row, and the share
/// extension's.
struct JobRow: View {
    let job: PortJob

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 10) {
                phaseIcon
                    .frame(width: 22)
                VStack(alignment: .leading, spacing: 2) {
                    Text(job.title)
                        .font(.body)
                        .lineLimit(1)
                    Text(detail)
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

    @ViewBuilder
    private var phaseIcon: some View {
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

    private var detail: String {
        switch job.phase {
        case .waiting: return L("Waiting")
        case .reading: return L("Reading the original")
        case .porting: return L("Adding the style")
        case .saving: return L("Saving to Photos")
        case .failed: return L("Failed")
        case .done:
            guard let report = job.report else { return L("Done") }
            var parts: [String] = []
            switch report.mode {
            case .addTexture: parts.append(L("Texture & Grain added"))
            case .photoGraph, .donorGraph: parts.append(L("Photographic Style added"))
            }
            if report.mode != .addTexture && report.addedTexture { parts.append(L("with Texture & Grain")) }
            if job.isLivePhoto { parts.append(L("Live Photo kept")) }
            return parts.joined(separator: " · ")
        }
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
