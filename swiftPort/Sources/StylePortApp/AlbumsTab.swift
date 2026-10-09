import Photos
import SwiftUI

struct AlbumItem: Identifiable, Hashable {
    let id: String
    let title: String
    let count: Int
    let keyAsset: PHAsset?
}

/// The system's albums: the person's own, then the media-type smart albums.
@MainActor
final class AlbumsModel: NSObject, ObservableObject, PHPhotoLibraryChangeObserver {
    @Published private(set) var myAlbums: [AlbumItem] = []
    @Published private(set) var mediaTypes: [AlbumItem] = []
    @Published private(set) var isLoading = true
    private var registered = false

    nonisolated private static let smartAlbums: [PHAssetCollectionSubtype] = [
        .smartAlbumUserLibrary, .smartAlbumFavorites, .smartAlbumLivePhotos,
        .smartAlbumDepthEffect, .smartAlbumSelfPortraits, .smartAlbumRecentlyAdded
    ]

    deinit {
        PHPhotoLibrary.shared().unregisterChangeObserver(self)
    }

    func load() {
        if !registered {
            PHPhotoLibrary.shared().register(self)
            registered = true
        }
        Task.detached(priority: .userInitiated) {
            var mine: [AlbumItem] = []
            let user = PHAssetCollection.fetchAssetCollections(with: .album, subtype: .any, options: nil)
            user.enumerateObjects { collection, _, _ in
                if let item = Self.item(for: collection, keepEmpty: true) { mine.append(item) }
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
            await MainActor.run {
                self.myAlbums = mine
                self.mediaTypes = types
                self.isLoading = false
            }
        }
    }

    nonisolated private static func item(for collection: PHAssetCollection, keepEmpty: Bool) -> AlbumItem? {
        let options = PHFetchOptions()
        options.predicate = NSPredicate(format: "mediaType == %d", PHAssetMediaType.image.rawValue)
        let assets = PHAsset.fetchAssets(in: collection, options: options)
        guard keepEmpty || assets.count > 0 else { return nil }
        return AlbumItem(
            id: collection.localIdentifier,
            title: collection.localizedTitle ?? "Album",
            count: assets.count,
            keyAsset: assets.lastObject
        )
    }

    nonisolated func photoLibraryDidChange(_ changeInstance: PHChange) {
        Task { @MainActor in load() }
    }
}

struct AlbumsTab: View {
    @StateObject private var model = AlbumsModel()
    @State private var status = PhotoLibraryService.status

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
            .navigationDestination(for: AlbumItem.self) { album in
                AlbumScreen(album: album)
            }
        }
        .task {
            status = await PhotoLibraryService.requestAccess()
            if status == .authorized || status == .limited { model.load() }
        }
    }

    private var albumList: some View {
        List {
            if !model.myAlbums.isEmpty {
                Section("My Albums") {
                    ForEach(model.myAlbums) { AlbumRow(album: $0) }
                }
            }
            if !model.mediaTypes.isEmpty {
                Section("Media Types") {
                    ForEach(model.mediaTypes) { AlbumRow(album: $0) }
                }
            }
        }
        .overlay {
            if model.isLoading {
                ProgressView()
            } else if model.myAlbums.isEmpty && model.mediaTypes.isEmpty {
                ContentUnavailableView("No Albums", systemImage: "rectangle.stack")
            }
        }
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
                    Text(album.count == 1 ? "1 photo" : "\(album.count) photos")
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
    @AppStorage(AppSettings.libraryAscendingKey) private var ascending = false

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
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) { SortMenu() }
        }
        .onAppear { model.load() }
        .onChange(of: sort) { _, sort in model.setSort(sort, ascending: ascending) }
        .onChange(of: ascending) { _, ascending in model.setSort(sort, ascending: ascending) }
    }
}
