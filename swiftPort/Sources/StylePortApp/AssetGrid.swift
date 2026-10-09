import Photos
import SwiftUI
import UIKit

/// The photos of the library or of one album, sorted, and kept current as the library changes.
@MainActor
final class AssetListModel: NSObject, ObservableObject, PHPhotoLibraryChangeObserver {
    enum Scope {
        case library
        case collection(PHAssetCollection)
    }

    @Published private(set) var assets: [PHAsset] = []
    @Published private(set) var isLoading = true

    let scope: Scope
    private(set) var sort: LibrarySort
    private(set) var ascending: Bool
    private var fetchResult: PHFetchResult<PHAsset>?
    private var filenames: [String: String] = [:]
    private var generation = 0
    private var registered = false

    init(scope: Scope, sort: LibrarySort, ascending: Bool) {
        self.scope = scope
        self.sort = sort
        self.ascending = ascending
        super.init()
    }

    deinit {
        PHPhotoLibrary.shared().unregisterChangeObserver(self)
    }

    func setSort(_ sort: LibrarySort, ascending: Bool) {
        guard sort != self.sort || ascending != self.ascending else { return }
        self.sort = sort
        self.ascending = ascending
        reload()
    }

    func load() {
        if !registered {
            PHPhotoLibrary.shared().register(self)
            registered = true
        }
        reload()
    }

    func reload() {
        generation += 1
        let generation = generation
        let scope = scope
        let sort = sort
        let ascending = ascending
        let cache = filenames
        Task.detached(priority: .userInitiated) {
            let options = PHFetchOptions()
            options.predicate = NSPredicate(format: "mediaType == %d", PHAssetMediaType.image.rawValue)
            if sort == .captured {
                options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: true)]
            }
            // Without a sort descriptor PhotoKit returns the library in the order photos were
            // added, which is "Date Saved"; an album keeps its own order.
            let result: PHFetchResult<PHAsset>
            switch scope {
            case .library: result = PHAsset.fetchAssets(with: options)
            case .collection(let collection): result = PHAsset.fetchAssets(in: collection, options: options)
            }
            var list = result.count == 0 ? [] : result.objects(at: IndexSet(integersIn: 0..<result.count))
            var names = cache
            if sort == .filename {
                for asset in list where names[asset.localIdentifier] == nil {
                    names[asset.localIdentifier] = PhotoLibraryService.filename(of: asset)
                }
                list.sort {
                    (names[$0.localIdentifier] ?? "").localizedStandardCompare(
                        names[$1.localIdentifier] ?? ""
                    ) == .orderedAscending
                }
            }
            if !ascending { list.reverse() }
            await MainActor.run {
                guard generation == self.generation else { return }
                self.fetchResult = result
                self.filenames = names
                self.assets = list
                self.isLoading = false
            }
        }
    }

    nonisolated func photoLibraryDidChange(_ changeInstance: PHChange) {
        Task { @MainActor in
            guard let fetchResult, changeInstance.changeDetails(for: fetchResult) != nil else { return }
            reload()
        }
    }
}

struct AssetRoute: Hashable {
    let identifier: String
}

/// A Photos-like grid with selection and the Add Style action.
struct AssetGridView<Empty: View>: View {
    @ObservedObject var model: AssetListModel
    @ViewBuilder var empty: () -> Empty

    @EnvironmentObject private var queue: PortQueue
    @AppStorage(AppSettings.replaceOriginalsKey) private var replaceOriginals = false
    @State private var selecting = false
    @State private var selection = Set<String>()
    @State private var confirmingReplace = false

    private let columns = [GridItem(.adaptive(minimum: 92, maximum: 150), spacing: 2)]

    var body: some View {
        ScrollView {
            LazyVGrid(columns: columns, spacing: 2) {
                ForEach(model.assets, id: \.localIdentifier) { asset in
                    cell(asset)
                }
            }
            .padding(.bottom, selecting ? 72 : 0)
        }
        .overlay {
            if model.isLoading {
                ProgressView()
            } else if model.assets.isEmpty {
                empty()
            }
        }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                if !model.assets.isEmpty {
                    Button(selecting ? "Cancel" : "Select") {
                        withAnimation {
                            selecting.toggle()
                            selection.removeAll()
                        }
                    }
                }
            }
        }
        .safeAreaInset(edge: .bottom) {
            if selecting { selectionBar }
        }
        .navigationDestination(for: AssetRoute.self) { route in
            AssetDetailView(identifier: route.identifier)
        }
        .confirmationDialog(
            replaceTitle,
            isPresented: $confirmingReplace,
            titleVisibility: .visible
        ) {
            Button("Replace", role: .destructive) { start() }
        } message: {
            Text("Each original is kept in the Backup Bin, and iOS asks you to confirm deleting it from your library.")
        }
    }

    private var replaceTitle: String {
        selection.count == 1 ? "Replace 1 photo with its styled version?"
            : "Replace \(selection.count) photos with their styled versions?"
    }

    @ViewBuilder
    private func cell(_ asset: PHAsset) -> some View {
        let isSelected = selection.contains(asset.localIdentifier)
        let tile = AssetTile(
            asset: asset,
            isSelecting: selecting,
            isSelected: isSelected,
            job: queue.job(forAsset: asset.localIdentifier)
        )
        if selecting {
            tile.onTapGesture {
                guard PhotoLibraryService.isHEIC(asset) else { return }
                if isSelected {
                    selection.remove(asset.localIdentifier)
                } else {
                    selection.insert(asset.localIdentifier)
                }
            }
        } else {
            NavigationLink(value: AssetRoute(identifier: asset.localIdentifier)) { tile }
                .buttonStyle(.plain)
        }
    }

    private var selectionBar: some View {
        HStack {
            Text(selection.isEmpty ? "Select HEIC Photos"
                 : selection.count == 1 ? "1 Photo Selected" : "\(selection.count) Photos Selected")
                .font(.subheadline.weight(.semibold))
            Spacer()
            Button {
                if replaceOriginals { confirmingReplace = true } else { start() }
            } label: {
                Label(
                    replaceOriginals ? "Replace with Style" : "Add Style",
                    systemImage: replaceOriginals ? "arrow.triangle.2.circlepath" : "camera.filters"
                )
            }
            .buttonStyle(.borderedProminent)
            .disabled(selection.isEmpty)
        }
        .padding(.horizontal)
        .padding(.vertical, 10)
        .background(.bar)
    }

    private func start() {
        let chosen = model.assets.filter { selection.contains($0.localIdentifier) }
        queue.port(chosen)
        withAnimation {
            selecting = false
            selection.removeAll()
        }
    }
}

/// One square of the grid: thumbnail, Live Photo and format badges, selection and progress.
struct AssetTile: View {
    let asset: PHAsset
    let isSelecting: Bool
    let isSelected: Bool
    let job: PortJob?

    @State private var isHEIC = true

    var body: some View {
        Color.clear
            .aspectRatio(1, contentMode: .fit)
            .overlay { AssetImage(asset: asset, contentMode: .fill) }
            .clipped()
            .overlay(alignment: .topLeading) {
                if asset.mediaSubtypes.contains(.photoLive) {
                    badge("livephoto")
                }
            }
            .overlay(alignment: .bottomLeading) {
                if !isHEIC {
                    Text("Not HEIC")
                        .font(.caption2.weight(.semibold))
                        .padding(.horizontal, 5)
                        .padding(.vertical, 2)
                        .background(.black.opacity(0.55), in: Capsule())
                        .foregroundStyle(.white)
                        .padding(4)
                }
            }
            .overlay(alignment: .bottomTrailing) { status }
            .opacity(isSelecting && !isHEIC ? 0.4 : 1)
            .overlay {
                if isSelected { Color.white.opacity(0.2) }
            }
            .contentShape(Rectangle())
            .task(id: asset.localIdentifier) {
                isHEIC = PhotoLibraryService.isHEIC(asset)
            }
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    @ViewBuilder
    private var status: some View {
        if isSelecting {
            Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                .font(.title3)
                .symbolRenderingMode(.palette)
                .foregroundStyle(.white, isSelected ? Color.accentColor : .black.opacity(0.2))
                .shadow(radius: 2)
                .padding(5)
        } else if let job {
            switch job.phase {
            case .done:
                badge("checkmark.seal.fill")
            case .failed:
                badge("exclamationmark.triangle.fill")
            default:
                ProgressView()
                    .tint(.white)
                    .padding(6)
                    .background(.black.opacity(0.45), in: Circle())
                    .padding(4)
            }
        }
    }

    private func badge(_ symbol: String) -> some View {
        Image(systemName: symbol)
            .font(.footnote.weight(.semibold))
            .foregroundStyle(.white)
            .shadow(color: .black.opacity(0.5), radius: 2)
            .padding(6)
    }
}

/// A PhotoKit image sized to its frame.
struct AssetImage: View {
    let asset: PHAsset
    var contentMode: ContentMode = .fill

    @Environment(\.displayScale) private var displayScale
    @State private var image: UIImage?

    var body: some View {
        GeometryReader { geometry in
            ZStack {
                Rectangle().fill(.quaternary)
                if let image {
                    Image(uiImage: image)
                        .resizable()
                        .aspectRatio(contentMode: contentMode)
                        .frame(width: geometry.size.width, height: geometry.size.height)
                }
            }
            .task(id: asset.localIdentifier) {
                let size = CGSize(
                    width: geometry.size.width * displayScale,
                    height: geometry.size.height * displayScale
                )
                image = await ThumbnailLoader.image(for: asset, size: size, contentMode: contentMode)
            }
        }
    }
}

enum ThumbnailLoader {
    private static let manager = PHCachingImageManager()

    @MainActor
    static func image(for asset: PHAsset, size: CGSize, contentMode: ContentMode) async -> UIImage? {
        let options = PHImageRequestOptions()
        options.deliveryMode = .highQualityFormat
        options.resizeMode = .fast
        options.isNetworkAccessAllowed = true
        return await withCheckedContinuation { continuation in
            manager.requestImage(
                for: asset,
                targetSize: size,
                contentMode: contentMode == .fill ? .aspectFill : .aspectFit,
                options: options
            ) { image, _ in
                continuation.resume(returning: image)
            }
        }
    }
}

enum LimitedLibrary {
    /// Let the person change which photos the app can see.
    @MainActor
    static func presentPicker() {
        guard let scene = UIApplication.shared.connectedScenes
                .compactMap({ $0 as? UIWindowScene })
                .first(where: { $0.activationState == .foregroundActive })
                ?? UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first,
              var top = scene.keyWindow?.rootViewController else { return }
        while let presented = top.presentedViewController { top = presented }
        PHPhotoLibrary.shared().presentLimitedLibraryPicker(from: top)
    }

    @MainActor
    static func openSettings() {
        if let url = URL(string: UIApplication.openSettingsURLString) {
            UIApplication.shared.open(url)
        }
    }
}

/// The Sort menu shared by the library and album grids.
struct SortMenu: View {
    @AppStorage(AppSettings.librarySortKey) private var sort = LibrarySort.captured
    @AppStorage(AppSettings.libraryAscendingKey) private var ascending = false

    var body: some View {
        Menu {
            Picker("Sort By", selection: $sort) {
                ForEach(LibrarySort.allCases) { Text($0.title).tag($0) }
            }
            Picker("Order", selection: $ascending) {
                Label("Ascending", systemImage: "arrow.up").tag(true)
                Label("Descending", systemImage: "arrow.down").tag(false)
            }
        } label: {
            Label("Sort", systemImage: "arrow.up.arrow.down")
        }
    }
}
