import SwiftUI

/// Originals kept by replace mode, to restore or delete.
struct BackupBinTab: View {
    @EnvironmentObject private var store: BackupStore
    @State private var confirmingEmpty = false

    var body: some View {
        NavigationStack {
            List {
                if !store.entries.isEmpty {
                    Section {
                        ForEach(store.entries) { entry in
                            NavigationLink(value: entry.id) { BackupRow(entry: entry) }
                        }
                        .onDelete { offsets in
                            for index in offsets { store.delete(store.entries[index]) }
                        }
                    } footer: {
                        Text("\(store.entries.count == 1 ? "1 original" : "\(store.entries.count) originals"), \(ByteCountFormatter.string(fromByteCount: store.totalBytes, countStyle: .file)). Originals stay here until you restore or delete them.")
                    }
                }
            }
            .overlay {
                if store.entries.isEmpty {
                    ContentUnavailableView {
                        Label("Backup Bin Is Empty", systemImage: "archivebox")
                    } description: {
                        Text("When Replace Original is on in Settings, each photo you style is kept here first, with its Live Photo video, so you can put it back.")
                    }
                }
            }
            .navigationTitle("Backup Bin")
            .navigationDestination(for: UUID.self) { id in
                if let entry = store.entries.first(where: { $0.id == id }) {
                    BackupDetailView(entry: entry)
                } else {
                    ContentUnavailableView("Removed", systemImage: "archivebox")
                }
            }
            .toolbar {
                if !store.entries.isEmpty {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("Empty", role: .destructive) { confirmingEmpty = true }
                    }
                }
            }
            .confirmationDialog(
                "Delete every original in the Backup Bin?",
                isPresented: $confirmingEmpty,
                titleVisibility: .visible
            ) {
                Button("Delete All", role: .destructive) { store.deleteAll() }
            } message: {
                Text("They can't be restored afterwards, except from Recently Deleted in Photos for up to 30 days after they were replaced.")
            }
        }
    }
}

private struct BackupRow: View {
    let entry: BackupEntry
    @EnvironmentObject private var store: BackupStore

    var body: some View {
        HStack(spacing: 14) {
            BackupThumbnail(url: store.photoURL(of: entry), size: 60)
                .frame(width: 60, height: 60)
                .clipShape(RoundedRectangle(cornerRadius: 8))
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 5) {
                    Text(entry.photoFilename)
                    if entry.isLivePhoto {
                        Image(systemName: "livephoto")
                            .foregroundStyle(.secondary)
                            .font(.footnote)
                    }
                }
                Text("Replaced \(entry.replacedAt.formatted(.relative(presentation: .named)))")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        }
    }
}

struct BackupThumbnail: View {
    let url: URL
    let size: CGFloat
    @Environment(\.displayScale) private var displayScale
    @State private var image: UIImage?

    var body: some View {
        ZStack {
            Rectangle().fill(.quaternary)
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
            }
        }
        .task(id: url) {
            let pixels = Int(size * displayScale)
            image = await Task.detached(priority: .userInitiated) {
                BackupStore.thumbnail(of: url, maxPixelSize: pixels)
            }.value
        }
    }
}

private struct BackupDetailView: View {
    let entry: BackupEntry

    @EnvironmentObject private var store: BackupStore
    @Environment(\.dismiss) private var dismiss
    @State private var confirmingRestore = false
    @State private var confirmingDelete = false
    @State private var restoring = false
    @State private var errorMessage: String?

    var body: some View {
        List {
            Section {
                BackupThumbnail(url: store.photoURL(of: entry), size: 600)
                    .aspectRatio(4 / 3, contentMode: .fit)
                    .clipShape(RoundedRectangle(cornerRadius: 10))
                    .listRowInsets(EdgeInsets())
            }
            Section {
                LabeledContent("Captured", value: entry.metadata.creationDate?.formatted(date: .abbreviated, time: .shortened) ?? "Unknown")
                LabeledContent("Replaced", value: entry.replacedAt.formatted(date: .abbreviated, time: .shortened))
                LabeledContent("Live Photo", value: entry.isLivePhoto ? "Yes, with its video" : "No")
                if !entry.metadata.albumIdentifiers.isEmpty {
                    LabeledContent("Albums", value: "\(entry.metadata.albumIdentifiers.count)")
                }
                LabeledContent("Size", value: ByteCountFormatter.string(fromByteCount: entry.byteCount, countStyle: .file))
            }
            Section {
                Button {
                    confirmingRestore = true
                } label: {
                    HStack {
                        Label("Restore to Library", systemImage: "arrow.uturn.backward")
                        if restoring {
                            Spacer()
                            ProgressView()
                        }
                    }
                }
                .disabled(restoring)
                ShareLink(items: store.fileURLs(of: entry)) {
                    Label("Export Original Files", systemImage: "square.and.arrow.up")
                }
                Button(role: .destructive) {
                    confirmingDelete = true
                } label: {
                    Label("Delete from Backup Bin", systemImage: "trash")
                }
            } footer: {
                Text("Restoring puts the original back with its date, location, favorite and albums.")
            }
        }
        .navigationTitle(entry.photoFilename)
        .navigationBarTitleDisplayMode(.inline)
        .confirmationDialog("Restore this original?", isPresented: $confirmingRestore, titleVisibility: .visible) {
            if entry.replacementIdentifier != nil {
                Button("Restore and Delete Styled Version", role: .destructive) { restore(deleteReplacement: true) }
            }
            Button("Restore, Keep Styled Version") { restore(deleteReplacement: false) }
        }
        .confirmationDialog("Delete this original permanently?", isPresented: $confirmingDelete, titleVisibility: .visible) {
            Button("Delete", role: .destructive) {
                store.delete(entry)
                dismiss()
            }
        }
        .alert("Couldn't Restore", isPresented: Binding(
            get: { errorMessage != nil },
            set: { if !$0 { errorMessage = nil } }
        )) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(errorMessage ?? "")
        }
    }

    private func restore(deleteReplacement: Bool) {
        restoring = true
        Task {
            do {
                _ = try await PhotoLibraryService().restore(
                    entry,
                    from: store,
                    deleteReplacement: deleteReplacement
                )
                store.delete(entry)
                dismiss()
            } catch {
                errorMessage = error.localizedDescription
            }
            restoring = false
        }
    }
}
