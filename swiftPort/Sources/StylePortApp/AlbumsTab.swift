import Photos
import SwiftUI

struct AlbumItem: Identifiable, Hashable {
    let id: String
    let title: String
    let count: Int
    let keyAsset: PHAsset?
    var startDate: Date? = nil
    var endDate: Date? = nil
    /// Position in PhotoKit's own order, which is the person's arrangement in Photos.
    var order = 0
}

enum AlbumLayout: String {
    case covers, list
}

enum AlbumSort: String, CaseIterable, Identifiable {
    case custom, created, modified, name
    var id: String { rawValue }
}

enum AlbumFilter: String {
    case all, mine, mediaTypes
}

/// The system's albums: the person's own, then the media-type smart albums.
@MainActor
final class AlbumsModel: NSObject, ObservableObject, PHPhotoLibraryChangeObserver {
    @Published private(set) var myAlbums: [AlbumItem] = []
    @Published private(set) var mediaTypes: [AlbumItem] = []
    @Published private(set) var isLoading = true
    private var registered = false
    private var loadTask: Task<Void, Never>?

    nonisolated private static let smartAlbums: [PHAssetCollectionSubtype] = [
        .smartAlbumUserLibrary, .smartAlbumFavorites, .smartAlbumLivePhotos,
        .smartAlbumDepthEffect, .smartAlbumSelfPortraits, .smartAlbumRecentlyAdded
    ]

    deinit {
        loadTask?.cancel()
        PHPhotoLibrary.shared().unregisterChangeObserver(self)
    }

    func load(after delay: Duration = .zero) {
        if !registered {
            PHPhotoLibrary.shared().register(self)
            registered = true
        }
        // Each load fetches every album and counts its photos: run one at a time, and let a
        // burst of library changes end in a single load.
        loadTask?.cancel()
        loadTask = Task { @MainActor [weak self] in
            if delay > .zero {
                do { try await Task.sleep(for: delay) } catch { return }
            }
            let (mine, types) = await Task.detached(priority: .userInitiated) { Self.fetchAll() }.value
            guard !Task.isCancelled, let self else { return }
            self.myAlbums = mine
            self.mediaTypes = types
            self.isLoading = false
        }
    }

    nonisolated private static func fetchAll() -> ([AlbumItem], [AlbumItem]) {
        var mine: [AlbumItem] = []
        let user = PHAssetCollection.fetchAssetCollections(with: .album, subtype: .any, options: nil)
        user.enumerateObjects { collection, _, _ in
            if var item = Self.item(for: collection, keepEmpty: true) {
                item.order = mine.count
                mine.append(item)
            }
        }
        var types: [AlbumItem] = []
        for subtype in Self.smartAlbums {
            let result = PHAssetCollection.fetchAssetCollections(
                with: .smartAlbum,
                subtype: subtype,
                options: nil
            )
            if let collection = result.firstObject,
               let item = Self.item(for: collection, keepEmpty: false) {
                types.append(item)
            }
        }
        return (mine, types)
    }

    nonisolated private static func item(for collection: PHAssetCollection, keepEmpty: Bool) -> AlbumItem? {
        let options = PHFetchOptions()
        options.predicate = NSPredicate(format: "mediaType == %d", PHAssetMediaType.image.rawValue)
        let assets = PHAsset.fetchAssets(in: collection, options: options)
        guard keepEmpty || assets.count > 0 else { return nil }
        return AlbumItem(
            id: collection.localIdentifier,
            title: collection.localizedTitle ?? L("Album"),
            count: assets.count,
            keyAsset: assets.lastObject,
            startDate: collection.startDate,
            endDate: collection.endDate
        )
    }

    nonisolated func photoLibraryDidChange(_ changeInstance: PHChange) {
        Task { @MainActor in load(after: .milliseconds(400)) }
    }
}

struct AlbumsTab: View {
    @StateObject private var model = AlbumsModel()
    @State private var status = PhotoLibraryService.status
    @AppStorage("albumsLayout") private var layout = AlbumLayout.covers
    @AppStorage("albumsSort") private var sort = AlbumSort.custom
    @AppStorage("albumsFilter") private var filter = AlbumFilter.all

    var body: some View {
        NavigationStack {
            Group {
                if status == .authorized || status == .limited {
                    albumList
                } else if status == .notDetermined {
                    ProgressView()
                } else {
                    ContentUnavailableView {
                        Label("No Access to Photos", systemImage: "lock")
                    } description: {
                        Text("Allow access to your photos in Settings to browse your albums.")
                    } actions: {
                        Button("Open Settings") { LimitedLibrary.openSettings() }
                    }
                }
            }
            .navigationTitle("Albums")
            .toolbar {
                if status == .authorized || status == .limited {
                    ToolbarItem(placement: .topBarTrailing) { optionsMenu }
                }
            }
            .navigationDestination(for: AlbumItem.self) { album in
                AlbumScreen(album: album)
            }
        }
        .task {
            status = await PhotoLibraryService.requestAccess()
            if status == .authorized || status == .limited { model.load() }
        }
    }

    @ViewBuilder
    private var albumList: some View {
        Group {
            if layout == .covers { albumGrid } else { albumRows }
        }
        .overlay {
            if model.isLoading {
                ProgressView()
            } else if myAlbums.isEmpty && mediaTypes.isEmpty {
                ContentUnavailableView("No Albums", systemImage: "rectangle.stack")
            }
        }
    }

    private var optionsMenu: some View {
        Menu {
            Picker("View", selection: $layout) {
                Label("Album Covers", systemImage: "photo").tag(AlbumLayout.covers)
                Label("List View", systemImage: "list.bullet").tag(AlbumLayout.list)
            }
            .pickerStyle(.palette)
            Divider()
            Picker("Sort", selection: $sort) {
                Text("Sort by Creation Date").tag(AlbumSort.created)
                Text("Sort by Modification Date").tag(AlbumSort.modified)
                Text("Sort by Name").tag(AlbumSort.name)
                Text("Sort by Custom Order").tag(AlbumSort.custom)
            }
            .pickerStyle(.inline)
            Divider()
            Menu("Filter") {
                Picker("Filter", selection: $filter) {
                    Text("All Albums").tag(AlbumFilter.all)
                    Text("My Albums").tag(AlbumFilter.mine)
                    Text("Media Types").tag(AlbumFilter.mediaTypes)
                }
                .pickerStyle(.inline)
            }
        } label: {
            Label("Options", systemImage: "ellipsis.circle")
        }
    }

    /// PhotoKit has no album creation or modification date, so these use the dates of the
    /// photos inside: the oldest photo for creation, the newest for modification.
    private var myAlbums: [AlbumItem] {
        guard filter != .mediaTypes else { return [] }
        switch sort {
        case .custom: return model.myAlbums.sorted { $0.order < $1.order }
        case .name:
            return model.myAlbums.sorted { $0.title.localizedStandardCompare($1.title) == .orderedAscending }
        case .created:
            return model.myAlbums.sorted { ($0.startDate ?? .distantPast) > ($1.startDate ?? .distantPast) }
        case .modified:
            return model.myAlbums.sorted { ($0.endDate ?? .distantPast) > ($1.endDate ?? .distantPast) }
        }
    }

    private var mediaTypes: [AlbumItem] { filter == .mine ? [] : model.mediaTypes }

    private var albumRows: some View {
        List {
            if !myAlbums.isEmpty {
                Section("My Albums") {
                    ForEach(myAlbums) { AlbumRow(album: $0) }
                }
            }
            if !mediaTypes.isEmpty {
                Section("Media Types") {
                    ForEach(mediaTypes) { AlbumRow(album: $0) }
                }
            }
        }
        .readableWidth()
    }

    private var albumGrid: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                if !myAlbums.isEmpty { gridSection("My Albums", myAlbums) }
                if !mediaTypes.isEmpty { gridSection("Media Types", mediaTypes) }
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 16)
        }
    }

    private func gridSection(_ title: LocalizedStringKey, _ albums: [AlbumItem]) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title)
                .font(.title3.weight(.semibold))
                .padding(.top, 12)
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), spacing: 14)], spacing: 18) {
                ForEach(albums) { AlbumCard(album: $0) }
            }
        }
    }
}

private func albumCountText(_ count: Int) -> String {
    count == 1 ? L("1 photo") : L("\(count) photos")
}

private struct AlbumCard: View {
    let album: AlbumItem

    var body: some View {
        NavigationLink(value: album) {
            VStack(alignment: .leading, spacing: 6) {
                Color.clear
                    .aspectRatio(1, contentMode: .fit)
                    .overlay {
                        if let asset = album.keyAsset {
                            AssetImage(asset: asset)
                        } else {
                            Rectangle().fill(.quaternary)
                                .overlay { Image(systemName: "photo").foregroundStyle(.secondary) }
                        }
                    }
                    .clipShape(RoundedRectangle(cornerRadius: 10))
                Text(album.title)
                    .font(.subheadline.weight(.medium))
                    .lineLimit(1)
                Text(albumCountText(album.count))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .buttonStyle(.plain)
    }
}

private struct AlbumRow: View {
    let album: AlbumItem

    var body: some View {
        NavigationLink(value: album) {
            HStack(spacing: 14) {
                Group {
                    if let asset = album.keyAsset {
                        AssetImage(asset: asset)
                    } else {
                        Rectangle().fill(.quaternary)
                            .overlay { Image(systemName: "photo").foregroundStyle(.secondary) }
                    }
                }
                .frame(width: 60, height: 60)
                .clipShape(RoundedRectangle(cornerRadius: 8))
                VStack(alignment: .leading, spacing: 3) {
                    Text(album.title)
                        .font(.body)
                    Text(albumCountText(album.count))
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }
}

/// One album's photos, in the same grid as the library.
private struct AlbumScreen: View {
    let album: AlbumItem
    @StateObject private var model: AssetListModel
    @AppStorage(AppSettings.librarySortKey) private var sort = LibrarySort.captured
    @AppStorage(AppSettings.libraryAscendingKey) private var ascending = true
    @AppStorage(AppSettings.styleFilterKey) private var styleFilter = StyleFilter.all

    init(album: AlbumItem) {
        self.album = album
        let collection = PHAssetCollection.fetchAssetCollections(
            withLocalIdentifiers: [album.id],
            options: nil
        ).firstObject
        _model = StateObject(wrappedValue: AssetListModel(
            scope: collection.map { AssetListModel.Scope.collection($0) } ?? AssetListModel.Scope.library,
            sort: LibrarySort(rawValue: UserDefaults.standard.string(forKey: AppSettings.librarySortKey) ?? "")
                ?? .captured,
            ascending: UserDefaults.standard.bool(forKey: AppSettings.libraryAscendingKey)
        ))
    }

    var body: some View {
        AssetGridView(model: model) {
            ContentUnavailableView("No Photos", systemImage: "photo")
        }
        .navigationTitle(album.title)
        .toolbarTitleDisplayMode(.inlineLarge)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) { SortMenu() }
        }
        .onAppear { model.load() }
        .onChange(of: sort) { _, sort in model.setSort(sort, ascending: ascending) }
        .onChange(of: ascending) { _, ascending in model.setSort(sort, ascending: ascending) }
        .onChange(of: styleFilter) { _, _ in model.reload() }
    }
}
