import SwiftUI

/// Originals kept by replace mode, to restore or delete. Laid out like Photos' Recently
/// Deleted: a grid with each original's age, a filter menu, and Select with Delete and Restore.
struct BackupBinTab: View {
    @EnvironmentObject private var store: BackupStore
    @AppStorage("backupFilter") private var filter = BackupFilter.all
    @AppStorage("backupMedia") private var media = BackupMedia.all
    @AppStorage("backupAspectRatio") private var aspectRatio = false
    @State private var selecting = false
    @State private var selection = Set<UUID>()
    @State private var confirming: BulkAction?
    @State private var working = false
    @State private var errorMessage: String?

    private enum BulkAction: Identifiable {
        case delete([BackupEntry])
        case restore([BackupEntry])
        var id: String {
            switch self {
            case .delete(let entries): return "delete-\(entries.count)"
            case .restore(let entries): return "restore-\(entries.count)"
            }
        }
    }

    private var visible: [BackupEntry] {
        store.entries.filter { entry in
            switch filter {
            case .all: break
            case .favorites: if !entry.metadata.isFavorite { return false }
            case .notInAlbums: if !entry.metadata.albumIdentifiers.isEmpty { return false }
            }
            switch media {
            case .all: return true
            case .live: return entry.isLivePhoto
            case .still: return !entry.isLivePhoto
            }
        }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    if !store.entries.isEmpty {
                        Label(summary, systemImage: "archivebox")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 16)
                    }
                    // Three columns on a portrait iPhone, more in landscape and on iPad.
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 110), spacing: 2)], spacing: 2) {
                        ForEach(visible) { entry in tile(entry) }
                    }
                }
                .padding(.bottom, selecting ? 80 : 0)
            }
            .immersiveBars()
            .overlay {
                if store.entries.isEmpty {
                    ContentUnavailableView {
                        Label("Backup Bin Is Empty", systemImage: "archivebox")
                    } description: {
                        Text("When Replace Original is on in Settings, each photo you style is kept here first, with its Live Photo video, so you can put it back.")
                    }
                } else if visible.isEmpty {
                    ContentUnavailableView("No Matching Originals", systemImage: "line.3.horizontal.decrease.circle")
                }
            }
            .navigationTitle("Backup Bin")
            .toolbarTitleDisplayMode(.inlineLarge)
            .navigationDestination(for: UUID.self) { id in
                if let entry = store.entries.first(where: { $0.id == id }) {
                    BackupDetailView(entry: entry)
                } else {
                    ContentUnavailableView("Removed", systemImage: "archivebox")
                }
            }
            .toolbar {
                if !store.entries.isEmpty {
                    ToolbarItem(placement: .topBarTrailing) { filterMenu }
                    ToolbarItem(placement: .topBarTrailing) {
                        Button(selecting ? L("Cancel") : L("Select")) {
                            withAnimation {
                                selecting.toggle()
                                selection.removeAll()
                            }
                        }
                    }
                }
            }
            .safeAreaInset(edge: .bottom) {
                if selecting {
                    selectionBar.transition(.move(edge: .bottom).combined(with: .opacity))
                }
            }
            .onReceive(store.$entries) { entries in
                selection.formIntersection(Set(entries.map(\.id)))
            }
            .confirmationDialog(confirmTitle, isPresented: Binding(
                get: { confirming != nil },
                set: { if !$0 { confirming = nil } }
            ), titleVisibility: .visible, presenting: confirming) { action in
                switch action {
                case .delete(let entries):
                    Button(entries.count == 1 ? L("Delete") : L("Delete All"), role: .destructive) { delete(entries) }
                case .restore(let entries):
                    Button(entries.count == 1 ? L("Restore") : L("Restore All")) { restore(entries) }
                }
            } message: { action in
                switch action {
                case .delete: Text("They can't be restored afterwards, except from Recently Deleted in Photos for up to 30 days after they were replaced.")
                case .restore: Text("Each original goes back with its date, location, favorite and albums. The styled versions stay in your library.")
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
    }

    private var summary: String {
        let count = store.entries.count == 1 ? L("1 original") : L("\(store.entries.count) originals")
        let size = ByteCountFormatter.string(fromByteCount: store.totalBytes, countStyle: .file)
        return count + " · " + size
    }

    private var filterMenu: some View {
        Menu {
            Section("Filter:") {
                Picker("Filter", selection: $filter) {
                    Label("All Items", systemImage: "square.grid.3x3").tag(BackupFilter.all)
                    Label("Favorites", systemImage: "heart").tag(BackupFilter.favorites)
                    Label("Not in Albums", systemImage: "rectangle.stack.badge.minus").tag(BackupFilter.notInAlbums)
                }
                .pickerStyle(.inline)
                Menu {
                    Picker("Media Types", selection: $media) {
                        Text("All Types").tag(BackupMedia.all)
                        Label("Live Photos", systemImage: "livephoto").tag(BackupMedia.live)
                        Label("Still Photos", systemImage: "photo").tag(BackupMedia.still)
                    }
                    .pickerStyle(.inline)
                } label: {
                    Label("Media Types", systemImage: "photo.on.rectangle")
                }
            }
            Section {
                Menu("Display Options") {
                    Toggle(isOn: $aspectRatio) {
                        Label("Aspect Ratio Grid", systemImage: "rectangle.grid.3x2")
                    }
                }
            }
        } label: {
            Label("Filter", systemImage: filter == .all && media == .all
                  ? "line.3.horizontal.decrease.circle" : "line.3.horizontal.decrease.circle.fill")
        }
    }

    @ViewBuilder
    private func tile(_ entry: BackupEntry) -> some View {
        let selected = selection.contains(entry.id)
        let content = Color.clear
            .aspectRatio(1, contentMode: .fit)
            .overlay {
                GeometryReader { geometry in
                    BackupThumbnail(url: store.photoURL(of: entry), size: geometry.size.width, fit: aspectRatio)
                        .frame(width: geometry.size.width, height: geometry.size.height)
                }
            }
            .clipped()
            .overlay(alignment: .topLeading) {
                if entry.isLivePhoto {
                    Image(systemName: "livephoto")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.white)
                        .shadow(color: .black.opacity(0.5), radius: 2)
                        .padding(6)
                }
            }
            .overlay(alignment: .bottomLeading) {
                Text(age(of: entry))
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.white)
                    .shadow(color: .black.opacity(0.6), radius: 3)
                    .padding(6)
            }
            .overlay(alignment: .bottomTrailing) {
                if selecting {
                    Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                        .font(.title3)
                        .symbolRenderingMode(.palette)
                        .foregroundStyle(.white, selected ? Color.accentColor : .black.opacity(0.2))
                        .shadow(radius: 2)
                        .padding(5)
                }
            }
            .overlay { if selected { Color.white.opacity(0.2) } }
            .contentShape(Rectangle())
            .accessibilityElement(children: .combine)
            .accessibilityLabel(entry.photoFilename)
            .accessibilityAddTraits(selected ? .isSelected : [])
        if selecting {
            content.onTapGesture {
                if selected { selection.remove(entry.id) } else { selection.insert(entry.id) }
            }
        } else {
            NavigationLink(value: entry.id) { content }.buttonStyle(.plain)
        }
    }

    /// How long the original has been kept. Unlike Recently Deleted there is no time limit.
    private func age(of entry: BackupEntry) -> String {
        let days = Calendar.current.dateComponents([.day], from: entry.replacedAt, to: Date()).day ?? 0
        return days < 1 ? L("Today") : L("\(days) days")
    }

    private var selectionBar: some View {
        let chosen = visible.filter { selection.contains($0.id) }
        let targets = chosen.isEmpty ? visible : chosen
        return HStack {
            Button(chosen.isEmpty ? L("Delete All") : L("Delete"), role: .destructive) {
                confirming = .delete(targets)
            }
            .disabled(targets.isEmpty || working)
            Spacer()
            if working {
                ProgressView()
            } else {
                Text(chosen.isEmpty ? L("Select Items") : L("\(chosen.count) Selected"))
                    .font(.subheadline.weight(.semibold))
            }
            Spacer()
            Button(chosen.isEmpty ? L("Restore All") : L("Restore")) {
                confirming = .restore(targets)
            }
            .disabled(targets.isEmpty || working)
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 12)
        .floatingBar()
        .frame(maxWidth: 560)
        .padding(.horizontal, 12)
        .padding(.bottom, 8)
    }

    private var confirmTitle: String {
        switch confirming {
        case .delete(let entries):
            if entries.count == store.entries.count && entries.count > 1 { return L("Delete every original in the Backup Bin?") }
            return entries.count == 1 ? L("Delete this original permanently?")
                : L("Delete \(entries.count) originals permanently?")
        case .restore(let entries):
            return entries.count == 1 ? L("Restore this original?")
                : L("Restore \(entries.count) originals to your library?")
        case nil:
            return ""
        }
    }

    private func delete(_ entries: [BackupEntry]) {
        for entry in entries { store.delete(entry) }
        withAnimation { selecting = false; selection.removeAll() }
    }

    /// All in one change, keeping the styled versions.
    private func restore(_ entries: [BackupEntry]) {
        working = true
        Task {
            defer { working = false }
            do {
                _ = try await PhotoLibraryService().restore(entries, from: store, deleteReplacements: false)
                for entry in entries { store.delete(entry) }
            } catch {
                errorMessage = error.localizedDescription
                return
            }
            withAnimation { selecting = false; selection.removeAll() }
        }
    }
}

enum BackupFilter: String {
    case all, favorites, notInAlbums
}

enum BackupMedia: String {
    case all, live, still
}

struct BackupThumbnail: View {
    let url: URL
    let size: CGFloat
    var fit = false
    @Environment(\.displayScale) private var displayScale
    @State private var image: UIImage?
    private static let cache: NSCache<NSString, UIImage> = {
        let cache = NSCache<NSString, UIImage>()
        cache.countLimit = 200
        return cache
    }()

    var body: some View {
        ZStack {
            Rectangle().fill(.quaternary)
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .aspectRatio(contentMode: fit ? .fit : .fill)
            }
        }
        .task(id: url) {
            let pixels = Int(size * displayScale)
            // Decoding a full-size HEIC is slow; scrolling back shouldn't do it again.
            let key = "\(url.path)-\(pixels)" as NSString
            if let cached = Self.cache.object(forKey: key) {
                image = cached
                return
            }
            let loaded = await Task.detached(priority: .userInitiated) {
                BackupStore.thumbnail(of: url, maxPixelSize: pixels)
            }.value
            if let loaded { Self.cache.setObject(loaded, forKey: key) }
            image = loaded
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
                LabeledContent("Captured", value: entry.metadata.creationDate?.formatted(date: .abbreviated, time: .shortened) ?? L("Unknown"))
                LabeledContent("Replaced", value: entry.replacedAt.formatted(date: .abbreviated, time: .shortened))
                LabeledContent("Live Photo", value: entry.isLivePhoto ? L("Yes, with its video") : L("No"))
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
        .readableWidth()
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
