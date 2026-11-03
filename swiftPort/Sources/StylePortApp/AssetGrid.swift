import Photos
import SwiftUI
import UIKit

/// Prepared off the main thread, so a pinch never rebuilds the date index.
struct GalleryDateSection: Identifiable {
    let id: String
    let title: String
    var assets: [PHAsset]

    static func group(_ assets: [PHAsset], by component: Calendar.Component) -> [GalleryDateSection] {
        let calendar = Calendar.current
        let formatter = DateFormatter()
        formatter.setLocalizedDateFormatFromTemplate(component == .year ? "yyyy" : "yMMMM")
        var groups: [GalleryDateSection] = []
        var indices: [String: Int] = [:]
        for asset in assets {
            let start = asset.creationDate.flatMap { calendar.dateInterval(of: component, for: $0)?.start }
            let id = start.map { String($0.timeIntervalSinceReferenceDate) } ?? "unknown"
            if let index = indices[id] {
                groups[index].assets.append(asset)
            } else {
                indices[id] = groups.count
                groups.append(GalleryDateSection(id: id,
                    title: start.map { formatter.string(from: $0) } ?? L("Unknown Date"), assets: [asset]))
            }
        }
        return groups
    }
}

/// The photos of the library or of one album, sorted, and kept current as the library changes.
@MainActor
final class AssetListModel: NSObject, ObservableObject, PHPhotoLibraryChangeObserver {
    enum Scope {
        case library
        case collection(PHAssetCollection)
    }

    @Published private(set) var assets: [PHAsset] = []
    @Published private(set) var yearSections: [GalleryDateSection] = []
    @Published private(set) var monthSections: [GalleryDateSection] = []
    @Published private(set) var isLoading = true

    let scope: Scope
    private(set) var sort: LibrarySort
    private(set) var ascending: Bool
    private var fetchResult: PHFetchResult<PHAsset>?
    /// Where each photo sits in `assets`, for prefetching the rows ahead of the scroll.
    private var indexByID: [String: Int] = [:]
    private var lastPrefetchBucket = -1
    private var generation = 0
    private var registered = false
    private var searchQuery = ""
    private var reloadTask: Task<Void, Never>?
    private var changeTask: Task<Void, Never>?

    init(scope: Scope, sort: LibrarySort, ascending: Bool) {
        self.scope = scope
        self.sort = sort
        self.ascending = ascending
        super.init()
    }

    deinit {
        reloadTask?.cancel()
        changeTask?.cancel()
        PHPhotoLibrary.shared().unregisterChangeObserver(self)
    }

    func setSort(_ sort: LibrarySort, ascending: Bool) {
        guard sort != self.sort || ascending != self.ascending else { return }
        self.sort = sort
        self.ascending = ascending
        reload()
    }

    func search(_ query: String) {
        let query = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard query != searchQuery else { return }
        searchQuery = query
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
        reloadTask?.cancel()
        generation += 1
        let generation = generation
        let scope = scope
        let sort = sort
        let ascending = ascending
        let query = searchQuery
        let styleFilter = AppSettings.styleFilter
        let styled = StyleRecords.shared.styledIDs
        reloadTask = Task.detached(priority: .userInitiated) {
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
            let names = sort == .filename || !query.isEmpty || styleFilter != .all
                ? FilenameCache.names(for: list) : [:]
            if styleFilter != .all {
                let wanted = styleFilter == .styled
                list = list.filter {
                    StyleFilter.isStyled(identifier: $0.localIdentifier, filename: names[$0.localIdentifier],
                                         known: styled) == wanted
                }
            }
            guard !Task.isCancelled else { return }
            if sort == .filename {
                list.sort {
                    (names[$0.localIdentifier] ?? "").localizedStandardCompare(
                        names[$1.localIdentifier] ?? ""
                    ) == .orderedAscending
                }
            }
            if !ascending { list.reverse() }
            if !query.isEmpty {
                let localDate = DateFormatter()
                localDate.dateStyle = .medium
                let isoDate = DateFormatter()
                isoDate.calendar = Calendar(identifier: .gregorian)
                isoDate.locale = Locale(identifier: "en_US_POSIX")
                isoDate.dateFormat = "yyyy-MM-dd"
                list = list.filter { asset in
                    if (names[asset.localIdentifier] ?? "").localizedStandardContains(query) { return true }
                    guard let date = asset.creationDate else { return false }
                    return localDate.string(from: date).localizedStandardContains(query)
                        || isoDate.string(from: date).localizedStandardContains(query)
                }
            }
            guard !Task.isCancelled else { return }
            let index = Dictionary(list.enumerated().map { ($1.localIdentifier, $0) }) { first, _ in first }
            let years = sort == .captured ? GalleryDateSection.group(list, by: .year) : []
            let months = sort == .captured ? GalleryDateSection.group(list, by: .month) : []
            guard !Task.isCancelled else { return }
            await MainActor.run {
                guard generation == self.generation else { return }
                self.fetchResult = result
                self.indexByID = index
                self.lastPrefetchBucket = -1
                self.yearSections = years
                self.monthSections = months
                self.assets = list
                self.isLoading = false
            }
        }
    }

    nonisolated func photoLibraryDidChange(_ changeInstance: PHChange) {
        Task { @MainActor in
            guard let fetchResult, let details = changeInstance.changeDetails(for: fetchResult) else { return }
            // A favorite, hide or edit only changes objects in place: swap those in instead of
            // reloading the library.
            if details.hasIncrementalChanges, details.insertedIndexes?.count ?? 0 == 0,
               details.removedIndexes?.count ?? 0 == 0, !details.hasMoves,
               applyInPlace(details.changedObjects) {
                self.fetchResult = details.fetchResultAfterChanges
                return
            }
            // A save or an iCloud sync arrives as a burst of changes; reload once it settles.
            changeTask?.cancel()
            changeTask = Task { @MainActor [weak self] in
                do { try await Task.sleep(for: .milliseconds(300)) } catch { return }
                self?.reload()
            }
        }
    }
}

extension AssetListModel {
    /// Replace changed photos where they are. Returns false when the change could move a
    /// photo (its date changed) and the list needs a full reload.
    fileprivate func applyInPlace(_ changed: [PHAsset]) -> Bool {
        guard !changed.isEmpty else { return true }
        var updated: [String: PHAsset] = [:]
        for asset in changed {
            guard let index = indexByID[asset.localIdentifier] else { continue }
            if assets[index].creationDate != asset.creationDate { return false }
            updated[asset.localIdentifier] = asset
        }
        guard !updated.isEmpty else { return true }
        assets = assets.map { updated[$0.localIdentifier] ?? $0 }
        func swap(_ sections: [GalleryDateSection]) -> [GalleryDateSection] {
            sections.map { section in
                var section = section
                section.assets = section.assets.map { updated[$0.localIdentifier] ?? $0 }
                return section
            }
        }
        yearSections = swap(yearSections)
        monthSections = swap(monthSections)
        return true
    }

    /// Start loading the thumbnails a few screens ahead of the one at `identifier`.
    func prefetch(around identifier: String, columns: Int, size: CGSize) {
        guard let index = indexByID[identifier], columns > 0 else { return }
        let bucket = index / (columns * 4)
        guard bucket != lastPrefetchBucket else { return }
        lastPrefetchBucket = bucket
        let lower = max(0, index - columns * 6)
        let upper = min(assets.count, index + columns * 12)
        guard lower < upper else { return }
        ThumbnailLoader.prefetch(Array(assets[lower..<upper]), size: size, contentMode: .fill)
    }
}

/// Original filenames, shared by every grid and read in parallel: each one is a separate
/// PhotoKit query, so a first filename sort of a large library is otherwise slow.
enum FilenameCache {
    private static let lock = NSLock()
    private static var known: [String: String] = [:]

    static func names(for assets: [PHAsset]) -> [String: String] {
        lock.lock()
        let cached = known
        lock.unlock()
        let missing = assets.filter { cached[$0.localIdentifier] == nil }
        guard !missing.isEmpty else { return cached }
        var found = [String](repeating: "", count: missing.count)
        found.withUnsafeMutableBufferPointer { buffer in
            let slots = buffer
            DispatchQueue.concurrentPerform(iterations: missing.count) { index in
                slots[index] = PhotoLibraryService.filename(of: missing[index])
            }
        }
        lock.lock()
        for (asset, name) in zip(missing, found) { known[asset.localIdentifier] = name }
        let result = known
        lock.unlock()
        return result
    }
}

struct AssetRoute: Hashable {
    let identifier: String
}

/// A Photos-like grid with selection and the Add Style action.
struct AssetGridView<Empty: View>: View {
    @ObservedObject var model: AssetListModel
    @ViewBuilder var empty: () -> Empty

    // Not an observed object: job progress must not re-render the grid. Tiles watch it.
    @Environment(\.portQueue) private var queue
    @Environment(\.displayScale) private var displayScale
    @AppStorage(AppSettings.replaceOriginalsKey) private var replaceOriginals = false
    @AppStorage(AppSettings.anyImageKey) private var anyImage = false
    @State private var selecting = false
    @State private var selection = Set<String>()
    @State private var confirmingReplace = false
    @State private var searchText = ""
    @State private var searchPresented = false
    @State private var previewRoute: AssetRoute?
    /// The photo the viewer shows now; closing zooms back into its tile.
    @State private var zoomID: String?
    @Namespace private var zoomNamespace

    @AppStorage(AppSettings.gridTileSizeKey) private var tileSize = 100.0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @GestureState private var isPinching = false
    @State private var pinchStartSize: Double?
    @State private var zoomSize: Double?
    @State private var layoutRevision = 0
    @State private var scrollAnchor = ScrollAnchorBox()
    @State private var tileTapsBlocked = false
    @State private var tapUnlockTask: Task<Void, Never>?
    @State private var gridWidth = UIScreen.main.bounds.width

    private func boundedTileSize(_ size: Double) -> Double { min(320, max(32, size)) }

    // The column layout stays committed until fingers lift. Only the entire viewport scales.
    private var displayedTileSize: Double { boundedTileSize(tileSize) }
    private var liveZoomScale: CGFloat {
        guard let zoomSize, let pinchStartSize else { return 1 }
        return CGFloat(zoomSize / pinchStartSize)
    }

    private func columnCount(for width: CGFloat) -> Int {
        max(1, Int((max(0, width) + 2) / (displayedTileSize + 2)))
    }

    private func finishZoom() {
        if let zoomSize {
            // Replace the frozen, scaled layout once, using only a short crossfade.
            withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.16)) {
                tileSize = zoomSize
                self.zoomSize = nil
                // The rebuilt grid starts where the old one was; at no other time is the
                // remembered position handed back.
                scrollAnchor.restoring = true
                layoutRevision += 1
            }
        }
        pinchStartSize = nil
        guard tileTapsBlocked else { return }
        // A finger lifting after the pinch must not become a photo/selection tap.
        tapUnlockTask?.cancel()
        tapUnlockTask = Task { @MainActor in
            do { try await Task.sleep(for: .milliseconds(250)) } catch { return }
            guard !Task.isCancelled, !isPinching else { return }
            tileTapsBlocked = false
        }
    }

    private var gridZoom: some Gesture {
        MagnificationGesture()
            .updating($isPinching) { _, active, _ in active = true }
            .onChanged { value in
                tapUnlockTask?.cancel()
                tileTapsBlocked = true
                if pinchStartSize == nil { pinchStartSize = tileSize }
                zoomSize = boundedTileSize((pinchStartSize ?? tileSize) * value)
            }
            .onEnded { _ in finishZoom() }
    }

    var body: some View {
        // No GeometryReader or ZStack around the scroll view: wrapped, it is no longer the
        // navigation bar's scroll view, and the large title stops collapsing as you swipe up.
        let count = columnCount(for: gridWidth)
        let width = max(0, gridWidth - CGFloat(count - 1) * 2) / CGFloat(count)
        gallery(columns: count, compact: width < 80, tile: width)
            .scaleEffect(liveZoomScale, anchor: .center)
            // Never animate grid positions, thumbnail sizes or finger movement.
            .transaction { $0.animation = nil }
            .id(layoutRevision)
            .transition(.opacity.animation(reduceMotion ? nil : .easeInOut(duration: 0.16)))
            // Clip only while a pinch scales the grid. Clipped all the time, the photos stop
            // at the bars instead of running under the title and tab bar as in Photos.
            .clipShape(Rectangle().inset(by: zoomSize == nil ? -10_000 : 0))
            .simultaneousGesture(gridZoom)
            .background {
                GeometryReader { geometry in
                    Color.clear
                        .onAppear { gridWidth = geometry.size.width }
                        .onChange(of: geometry.size.width) { _, new in gridWidth = new }
                }
            }
            .immersiveBars()
        .onChange(of: isPinching) { _, active in
            // Cancellation resets gesture state too; commit the last visible size.
            if !active { finishZoom() }
        }
        .searchable(
            text: $searchText,
            isPresented: $searchPresented,
            placement: .navigationBarDrawer(displayMode: .automatic),
            prompt: "Filename or date"
        )
        .task(id: searchText) {
            do { try await Task.sleep(for: .milliseconds(200)) } catch { return }
            guard !Task.isCancelled else { return }
            model.search(searchText)
        }
        .onChange(of: searchPresented) { _, presented in
            if !presented { searchText = "" }
        }
        .onReceive(model.$assets) { assets in
            selection.formIntersection(Set(assets.map(\.localIdentifier)))
        }
        .overlay {
            if model.isLoading {
                ProgressView()
            } else if model.assets.isEmpty {
                if searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    empty()
                } else {
                    ContentUnavailableView.search(text: searchText)
                }
            }
        }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    searchPresented = true
                } label: {
                    Label("Search", systemImage: "magnifyingglass")
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                if !model.assets.isEmpty {
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
        .navigationDestination(item: $previewRoute) { route in
            AssetDetailView(identifier: route.identifier, assets: model.assets) { zoomID = $0 }
                .zoomTransition(id: zoomID ?? route.identifier, in: zoomNamespace)
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

    private func gallery(columns: Int, compact: Bool, tile: CGFloat) -> some View {
        let pixels = CGSize(width: tile * displayScale, height: tile * displayScale)
        return gallery(columns: columns, compact: compact) { asset in
            model.prefetch(around: asset.localIdentifier, columns: columns, size: pixels)
        }
    }

    private func gallery(columns: Int, compact: Bool, appeared: @escaping (PHAsset) -> Void) -> some View {
        ScrollView {
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 2), count: columns), spacing: 2) {
                if model.sort == .captured {
                    ForEach(compact ? model.yearSections : model.monthSections) { group in
                        Section {
                            ForEach(group.assets, id: \.localIdentifier) { asset in cell(asset).onAppear { appeared(asset) } }
                        } header: {
                            Text(group.title)
                                .font(.title3.weight(.semibold))
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.horizontal, 12)
                                .padding(.top, 18)
                                .padding(.bottom, 8)
                                .accessibilityAddTraits(.isHeader)
                        }
                    }
                } else {
                    // Capture-date grouping must not override a filename or saved-date sort.
                    ForEach(model.assets, id: \.localIdentifier) { asset in cell(asset).onAppear { appeared(asset) } }
                }
            }
            .scrollTargetLayout()
            .padding(.bottom, selecting ? 72 : 0)
        }
        .scrollPosition(id: Binding(get: { scrollAnchor.restoring ? scrollAnchor.id : nil },
                                    set: { scrollAnchor.id = $0 }), anchor: .top)
        .task(id: layoutRevision) {
            // Long enough for the new grid to read the position, then stop handing it back.
            do { try await Task.sleep(for: .milliseconds(400)) } catch { return }
            scrollAnchor.restoring = false
        }
        .scrollDisabled(isPinching)
    }

    private var replaceTitle: String {
        selection.count == 1 ? L("Replace 1 photo with its styled version?")
            : L("Replace \(selection.count) photos with their styled versions?")
    }

    @ViewBuilder
    private func cell(_ asset: PHAsset) -> some View {
        let isSelected = selection.contains(asset.localIdentifier)
        let tile = AssetTile(
            asset: asset,
            isSelecting: selecting,
            isSelected: isSelected
        )
        if selecting {
            tile.onTapGesture {
                guard !isPinching, !tileTapsBlocked else { return }
                if isSelected {
                    selection.remove(asset.localIdentifier)
                } else {
                    selection.insert(asset.localIdentifier)
                }
            }
        } else {
            Button {
                guard !isPinching, !tileTapsBlocked else { return }
                zoomID = asset.localIdentifier
                previewRoute = AssetRoute(identifier: asset.localIdentifier)
            } label: { tile }
            .buttonStyle(GalleryTileButtonStyle())
            .zoomSource(id: asset.localIdentifier, in: zoomNamespace)
        }
    }

    private var selectionBar: some View {
        HStack {
            Text(selection.isEmpty ? L("Select Photos")
                 : selection.count == 1 ? L("1 Photo Selected") : L("\(selection.count) Photos Selected"))
                .font(.subheadline.weight(.semibold))
            Spacer()
            LibrarySelectionActions(assets: selectedAssets, sourceAlbum: sourceAlbum) { model.reload() }
            Button {
                if replaceOriginals { confirmingReplace = true } else { start() }
            } label: {
                Label(
                    replaceOriginals ? L("Replace with Style") : L("Add Style"),
                    systemImage: replaceOriginals ? "arrow.triangle.2.circlepath" : "camera.filters"
                )
            }
            .modernProminentButton()
            .disabled(selectedAssets.isEmpty || !anyImage && !selectedAssets.contains { HEICCache.peek($0) ?? true })
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .floatingBar()
        .frame(maxWidth: 640)
        .padding(.horizontal, 12)
        .padding(.bottom, 8)
    }

    private var selectedAssets: [PHAsset] {
        model.assets.filter { selection.contains($0.localIdentifier) }
    }

    private var sourceAlbum: PHAssetCollection? {
        if case .collection(let album) = model.scope, album.canPerform(.removeContent) { return album }
        return nil
    }

    private func start() {
        // Any Image converts the rest; otherwise only HEIC photos can be styled.
        let chosen = anyImage ? selectedAssets : selectedAssets.filter(PhotoLibraryService.isHEIC)
        queue?.port(chosen)
        withAnimation {
            selecting = false
            selection.removeAll()
        }
    }
}

private struct GalleryTileButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View { configuration.label }
}

/// One square of the grid: thumbnail, Live Photo and format badges, selection and progress.
struct AssetTile: View {
    let asset: PHAsset
    let isSelecting: Bool
    let isSelected: Bool

    @State private var isHEIC = true

    var body: some View {
        Color.clear
            .aspectRatio(1, contentMode: .fit)
            .overlay {
                GeometryReader { geometry in
                    thumbnail(compact: geometry.size.width < 80)
                }
            }
            .clipped()
            .contentShape(Rectangle())
            .task(id: asset.localIdentifier) {
                // Reading a photo's resources is a synchronous database query: cache it and keep
                // it off the main thread so scrolling never waits on it.
                isHEIC = await HEICCache.isHEIC(asset)
            }
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    private func thumbnail(compact: Bool) -> some View {
        AssetImage(asset: asset, contentMode: .fill)
            .clipped()
            .overlay(alignment: .topLeading) {
                if asset.mediaSubtypes.contains(.photoLive) {
                    badge("livephoto", compact: compact)
                }
            }
            .overlay(alignment: .bottomLeading) {
                if !compact, isHEIC {
                    StyledBadge(identifier: asset.localIdentifier)
                } else if !compact, !isHEIC {
                    Text("Not HEIC")
                        .font(.caption2.weight(.semibold))
                        .padding(.horizontal, 5)
                        .padding(.vertical, 2)
                        .background(.black.opacity(0.55), in: Capsule())
                        .foregroundStyle(.white)
                        .padding(4)
                }
            }
            .overlay(alignment: .bottomTrailing) {
                if !compact {
                    status
                } else if isSelecting, isSelected {
                    // Small tiles have no room for the empty circles, but a selected one still
                    // needs a mark: the tint alone is easy to miss.
                    Image(systemName: "checkmark.circle.fill")
                        .font(.system(size: 12, weight: .semibold))
                        .symbolRenderingMode(.palette)
                        .foregroundStyle(.white, Color.accentColor)
                        .shadow(color: .black.opacity(0.4), radius: 1)
                        .padding(2)
                }
            }
            .overlay {
                if isSelected { Color.white.opacity(0.2) }
            }
    }

    @ViewBuilder
    private var status: some View {
        if isSelecting {
            Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                .font(.title3)
                .symbolRenderingMode(.palette)
                .foregroundStyle(.white, isSelected ? Color.accentColor : .black.opacity(0.2))
                // A symbol effect, not a transition: the grid switches transaction animations off.
                .symbolEffect(.bounce, value: isSelected)
                .shadow(radius: 2)
                .padding(5)
        } else {
            TileJobStatus(identifier: asset.localIdentifier)
        }
    }

    private func badge(_ symbol: String, compact: Bool = false) -> some View {
        TileBadge(symbol: symbol, compact: compact)
    }
}

private struct TileBadge: View {
    let symbol: String
    var compact = false

    var body: some View {
        Image(systemName: symbol)
            .font(compact ? .system(size: 10, weight: .semibold) : .footnote.weight(.semibold))
            .foregroundStyle(.white)
            .shadow(color: .black.opacity(0.5), radius: 2)
            .padding(compact ? 3 : 6)
    }
}

/// Only this small view watches the queue, so job progress never re-renders the whole grid.
private struct TileJobStatus: View {
    let identifier: String
    @EnvironmentObject private var queue: PortQueue

    var body: some View {
        if let job = queue.job(forAsset: identifier) {
            switch job.phase {
            case .done:
                TileBadge(symbol: "checkmark.seal.fill")
            case .failed:
                TileBadge(symbol: "exclamationmark.triangle.fill")
            default:
                ProgressView()
                    .tint(.white)
                    .padding(6)
                    .background(.black.opacity(0.45), in: Circle())
                    .padding(4)
            }
        }
    }
}

/// Remembers the scroll position without invalidating the grid on every scroll step.
/// The position is offered back only while a pinch rebuilds the grid: offered at every
/// redraw, a selection tap made the grid snap the top row into place, one row up.
final class ScrollAnchorBox {
    var id: String?
    var restoring = false
}

/// Whether an asset's original is a HEIC, computed once and off the main thread.
enum HEICCache {
    private static let cache = NSCache<NSString, NSNumber>()

    /// The cached answer, if known; safe to call while a view builds its body.
    static func peek(_ asset: PHAsset) -> Bool? {
        cache.object(forKey: asset.localIdentifier as NSString)?.boolValue
    }

    static func isHEIC(_ asset: PHAsset) async -> Bool {
        let key = asset.localIdentifier as NSString
        if let known = cache.object(forKey: key) { return known.boolValue }
        let value = await Task.detached(priority: .utility) { PhotoLibraryService.isHEIC(asset) }.value
        cache.setObject(NSNumber(value: value), forKey: key)
        return value
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
                if let displayed = image ?? ThumbnailLoader.cachedImage(for: asset, contentMode: contentMode) {
                    Image(uiImage: displayed)
                        .resizable()
                        .aspectRatio(contentMode: contentMode)
                        .frame(width: geometry.size.width, height: geometry.size.height)
                }
            }
            .task(id: "\(asset.localIdentifier)-\(Int(ceil(geometry.size.width * displayScale / 128)))-\(Int(ceil(geometry.size.height * displayScale / 128)))") {
                let size = CGSize(
                    width: geometry.size.width * displayScale,
                    height: geometry.size.height * displayScale
                )
                let loaded = await ThumbnailLoader.image(
                    for: asset, size: size, contentMode: contentMode
                ) { preview in
                    if image == nil { image = preview }
                }
                if !Task.isCancelled, let loaded { image = loaded }
            }
        }
    }
}

enum ThumbnailLoader {
    private static let manager: PHCachingImageManager = {
        let manager = PHCachingImageManager()
        // Grid thumbnails only; this keeps the caching manager from holding full-size renders.
        manager.allowsCachingHighQualityImages = false
        return manager
    }()
    // Retain recent images across the release crossfade, while larger requests complete.
    private static let images: NSCache<NSString, UIImage> = {
        let cache = NSCache<NSString, UIImage>()
        cache.countLimit = 256
        cache.totalCostLimit = 96 * 1024 * 1024
        return cache
    }()
    /// Under memory pressure, drop cached thumbnails and PhotoKit's prefetched ones rather than
    /// let iOS end the app; visible tiles simply load again.
    private static let memoryWarning: NSObjectProtocol = NotificationCenter.default.addObserver(
        forName: UIApplication.didReceiveMemoryWarningNotification, object: nil, queue: .main
    ) { _ in
        images.removeAllObjects()
        manager.stopCachingImagesForAllAssets()
    }

    private static func key(for asset: PHAsset, contentMode: ContentMode) -> NSString {
        "\(asset.localIdentifier)-\(asset.modificationDate?.timeIntervalSinceReferenceDate ?? 0)-\(contentMode == .fill ? "fill" : "fit")" as NSString
    }

    static func cachedImage(for asset: PHAsset, contentMode: ContentMode) -> UIImage? {
        images.object(forKey: key(for: asset, contentMode: contentMode))
    }

    private final class Request: @unchecked Sendable {
        var id: PHImageRequestID = PHInvalidImageRequestID
        var finished = false
    }

    /// Photos' own thumbnail, delivered fast first (`preview`) and sharp after. The PhotoKit
    /// request is cancelled with the task, so tiles scrolled past never queue stale work.
    /// Warm the cache for photos the person is about to swipe to.
    @MainActor
    static func prefetch(_ assets: [PHAsset], size: CGSize, contentMode: ContentMode) {
        _ = memoryWarning
        guard !assets.isEmpty, size.width > 0, size.height > 0 else { return }
        let options = PHImageRequestOptions()
        options.deliveryMode = .opportunistic
        options.resizeMode = .fast
        options.isNetworkAccessAllowed = true
        manager.startCachingImages(
            for: assets,
            targetSize: size,
            contentMode: contentMode == .fill ? .aspectFill : .aspectFit,
            options: options
        )
    }

    @MainActor
    static func image(
        for asset: PHAsset,
        size: CGSize,
        contentMode: ContentMode,
        preview: ((UIImage) -> Void)? = nil
    ) async -> UIImage? {
        let options = PHImageRequestOptions()
        options.deliveryMode = .opportunistic
        options.resizeMode = .fast
        options.isNetworkAccessAllowed = true
        let request = Request()
        let final: UIImage? = await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                request.id = manager.requestImage(
                    for: asset,
                    targetSize: size,
                    contentMode: contentMode == .fill ? .aspectFill : .aspectFit,
                    options: options
                ) { image, info in
                    let degraded = (info?[PHImageResultIsDegradedKey] as? Bool) ?? false
                    if degraded {
                        if let image { preview?(image) }
                        return
                    }
                    guard !request.finished else { return }
                    request.finished = true
                    continuation.resume(returning: image)
                }
            }
        } onCancel: {
            manager.cancelImageRequest(request.id)
        }
        guard let final else { return nil }
        // Decode off the main thread so the first frame it appears in doesn't stutter.
        let ready = await final.byPreparingForDisplay() ?? final
        let cost = ready.cgImage.map { $0.bytesPerRow * $0.height } ?? 0
        images.setObject(ready, forKey: key(for: asset, contentMode: contentMode), cost: cost)
        return ready
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
/// A small mark on photos this app styled.
private struct StyledBadge: View {
    let identifier: String
    @ObservedObject private var records = StyleRecords.shared

    var body: some View {
        if records.isStyled(identifier) {
            Image(systemName: "camera.filters")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.white)
                .shadow(color: .black.opacity(0.5), radius: 2)
                .padding(6)
                .accessibilityLabel("Styled")
        }
    }
}

struct SortMenu: View {
    @AppStorage(AppSettings.librarySortKey) private var sort = LibrarySort.captured
    @AppStorage(AppSettings.libraryAscendingKey) private var ascending = false
    @AppStorage(AppSettings.styleFilterKey) private var styleFilter = StyleFilter.all

    var body: some View {
        Menu {
            Picker("Show", selection: $styleFilter) {
                ForEach(StyleFilter.allCases) { Text($0.title).tag($0) }
            }
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
