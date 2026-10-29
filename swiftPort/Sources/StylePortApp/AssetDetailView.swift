import CoreLocation
import ImageIO
import MapKit
import Photos
import PhotosUI
import StylePortCore
import SwiftUI
import UIKit

/// A photo-first viewer. Information slides up without leaving the photo.
struct AssetDetailView: View {
    let identifier: String
    let assets: [PHAsset]
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @EnvironmentObject private var queue: PortQueue
    @AppStorage(AppSettings.replaceOriginalsKey) private var replaceOriginals = false
    @State private var selectedIdentifier: String
    @State private var pagerID: String?
    @State private var heicTick = 0
    @State private var commitTask: Task<Void, Never>?
    /// How far the photo has been pulled down to close the viewer.
    @State private var dismissOffset: CGFloat = 0
    @State private var asset: PHAsset?
    @State private var loaded = false
    @State private var eligibility: StylePorter.Eligibility?
    @State private var eligibilityChecked = false
    @State private var showingInfo = false
    @State private var showingControls = true
    @State private var confirmingReplace = false
    @State private var confirmingDelete = false
    @State private var busy = false
    @State private var message: String?
    @State private var editor: InfoEditor?
    @State private var share: PhotoShare?
    @State private var shareFiles: [URL] = []
    @State private var cameraInfo: PhotoCameraInfo?
    @State private var placeName: String?

    /// Told which photo is showing, so closing zooms back into the right tile.
    var onShow: ((String) -> Void)?

    init(identifier: String, assets: [PHAsset] = [], onShow: ((String) -> Void)? = nil) {
        self.identifier = identifier
        self.assets = assets
        self.onShow = onShow
        _selectedIdentifier = State(initialValue: identifier)
        _pagerID = State(initialValue: identifier)
    }

    private enum InfoEditor: String, Identifiable {
        case date, location
        var id: String { rawValue }
    }
    private var job: PortJob? { queue.job(forAsset: selectedIdentifier) }
    private static var systemZoom: Bool {
        if #available(iOS 18.0, *) { return true }
        return false
    }
    private var motion: Animation? { reduceMotion ? nil : .spring(duration: 0.32, bounce: 0.08) }
    private var running: Bool { job.map { !$0.isFinished } ?? false }
    private var blocked: Bool {
        guard let asset else { return true }
        _ = heicTick
        return !(HEICCache.peek(asset) ?? true) || eligibility == .alreadyStyled || eligibility == .unsupported
    }

    var body: some View {
        Group {
            if let asset { viewer(asset) }
            else if loaded {
                ContentUnavailableView("Photo Unavailable", systemImage: "photo",
                    description: Text("This photo is no longer in your library."))
            } else { ProgressView() }
        }
        .background(Color(uiColor: .systemBackground))
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden()
        .toolbar(.hidden, for: .tabBar)
        .toolbar(showingControls ? .visible : .hidden, for: .navigationBar)
        .toolbarBackground(.hidden, for: .navigationBar)
        .toolbar { viewerToolbar }
        .task(id: "\(selectedIdentifier)-\(jobState)") {
            // Wait for a swipe to settle before reading the original or its info.
            if asset != nil {
                do { try await Task.sleep(for: .milliseconds(250)) } catch { return }
            }
            await refresh()
        }
        .task(id: selectedIdentifier) { await loadPlace() }
        .onChange(of: pagerID) { _, id in
            // The position changes halfway through a swipe. Rebuilding the viewer then would
            // stall the animation, so the new photo is taken once the page has settled.
            commitTask?.cancel()
            commitTask = Task { @MainActor in
                do { try await Task.sleep(for: .milliseconds(160)) } catch { return }
                if let id, id != selectedIdentifier { choose(id) }
            }
        }
        .onChange(of: selectedIdentifier) { _, id in
            if pagerID != id { pagerID = id }
            onShow?(id)
        }
        .task(id: "\(selectedIdentifier)-\(showingInfo)") {
            guard showingInfo, let asset else { return }
            let info = await PhotoCameraInfo.load(asset)
            if !Task.isCancelled { cameraInfo = info }
        }
        .sheet(item: $editor) { editor in
            if let asset {
                switch editor {
                case .date: DateActionSheet(assets: [asset]) { Task { await refresh() } }.formSheetSizing()
                case .location: LocationActionSheet(assets: [asset]) { Task { await refresh(); await loadPlace() } }.formSheetSizing()
                }
            }
        }
        .sheet(item: $share, onDismiss: clearShareFiles) { payload in PhotoShareSheet(urls: payload.urls) }
        .alert("Photo", isPresented: Binding(get: { message != nil }, set: { if !$0 { message = nil } })) {
            Button("OK") { message = nil }
        } message: { Text(message ?? "") }
        .confirmationDialog("Delete this photo?", isPresented: $confirmingDelete, titleVisibility: .visible) {
            Button("Delete Photo", role: .destructive) { deletePhoto() }
        } message: { Text("The photo moves to Recently Deleted in Photos.") }
        .confirmationDialog("Replace this photo with its styled version?", isPresented: $confirmingReplace, titleVisibility: .visible) {
            Button("Replace", role: .destructive) { if let asset { queue.port([asset]) } }
        } message: { Text("The original is kept in the Backup Bin, and iOS asks you to confirm deleting it from your library.") }
    }

    @ToolbarContentBuilder
    private var viewerToolbar: some ToolbarContent {
        ToolbarItem(placement: .topBarLeading) {
            Button { dismiss() } label: { Image(systemName: "chevron.left").font(.headline) }
                .accessibilityLabel("Back")
        }
        ToolbarItem(placement: .principal) {
            if let asset {
                VStack(spacing: 1) {
                    if let placeName { Text(placeName).font(.subheadline.weight(.semibold)).lineLimit(1) }
                    if let date = asset.creationDate {
                        Text(date.formatted(date: .abbreviated, time: .shortened))
                            .font(placeName == nil ? .subheadline.weight(.semibold) : .caption)
                    } else { Text(L("Photo")).font(.subheadline.weight(.semibold)) }
                }
                .padding(.horizontal, 16).padding(.vertical, 6)
                .floatingGlass()
            }
        }
        ToolbarItem(placement: .topBarTrailing) {
            if let asset {
                LibrarySelectionActions(assets: [asset], sourceAlbum: nil) { Task { await refresh() } }
            }
        }
    }

    private func viewer(_ asset: PHAsset) -> some View {
        GeometryReader { geometry in
            // Landscape and iPad put the info beside the photo instead of under it.
            let wide = geometry.size.width > geometry.size.height && geometry.size.width > 600
            Group {
                if wide {
                    HStack(spacing: 0) {
                        media(asset)
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                            .clipped()
                        if showingInfo {
                            ScrollView {
                                infoPanel(asset).padding(16)
                            }
                            .frame(width: min(400, geometry.size.width * 0.4))
                            .transition(.move(edge: .trailing).combined(with: .opacity))
                        }
                    }
                } else {
                    VStack(spacing: 0) {
                        media(asset)
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                            .clipped()
                        if showingInfo {
                            ScrollView {
                                infoPanel(asset).padding(.horizontal, 16).padding(.bottom, 16)
                            }
                            .frame(height: geometry.size.height * 0.53)
                            .transition(.move(edge: .bottom).combined(with: .opacity))
                        }
                    }
                }
            }
            .animation(motion, value: showingInfo)
        }
        .safeAreaInset(edge: .bottom, spacing: 8) {
            if showingControls {
                VStack(spacing: 12) {
                    if !showingInfo, !assets.isEmpty { filmstrip }
                    controls(asset)
                }
                // Sized for a hand, not the screen: on iPad the controls stay together.
                .frame(maxWidth: 560)
                .padding(.horizontal, 16).padding(.bottom, 8)
            }
        }
    }

    private func media(_ asset: PHAsset) -> some View {
        GeometryReader { geometry in
            ZStack(alignment: .topLeading) {
                pager(current: asset, size: geometry.size)
                if showingControls, asset.mediaSubtypes.contains(.photoLive) {
                    Label("Live", systemImage: "livephoto")
                        .font(.caption.weight(.semibold))
                        .padding(.horizontal, 10).padding(.vertical, 6)
                        .floatingGlass().padding(12)
                }
            }
            // Pulled down, the photo follows the finger and shrinks a little, as in Photos.
            .offset(y: dismissOffset)
            .scaleEffect(1 - min(dismissOffset, 400) / 1600)
            .contentShape(Rectangle())
            .onTapGesture { withAnimation(motion) { showingControls.toggle(); if !showingControls { showingInfo = false } } }
            // Horizontal paging belongs to the scroll view. Up opens the info; down closes the
            // info, or, with the info closed, goes back to the grid the photo came from.
            .simultaneousGesture(DragGesture(minimumDistance: 28)
                .onChanged { value in
                    // iOS 18+ closes with the system zoom, which follows the finger itself.
                    guard !Self.systemZoom else { return }
                    let delta = value.translation
                    guard !showingInfo, delta.height > 0, delta.height > abs(delta.width) else { return }
                    dismissOffset = delta.height
                }
                .onEnded { value in
                    let delta = value.translation
                    let vertical = abs(delta.height) > abs(delta.width)
                    if vertical, delta.height < -45 {
                        withAnimation(motion) { showingControls = true; showingInfo = true }
                    } else if vertical, delta.height > 60, showingInfo {
                        withAnimation(motion) { showingInfo = false }
                    } else if !Self.systemZoom, vertical, !showingInfo,
                              delta.height > 110 || value.predictedEndTranslation.height > 300 {
                        dismiss()
                        return
                    }
                    if dismissOffset != 0 {
                        withAnimation(reduceMotion ? nil : .spring(duration: 0.3)) { dismissOffset = 0 }
                    }
                })
            .task(id: selectedIdentifier) { prefetchNeighbors(size: geometry.size) }
        }
    }

    @ViewBuilder
    private func pager(current: PHAsset, size: CGSize) -> some View {
        if assets.isEmpty {
            PhotoPage(asset: current, playsLive: true, size: size)
        } else {
            PhotoPager(assets: assets, liveID: selectedIdentifier, size: size, position: $pagerID)
        }
    }

    private func prefetchNeighbors(size: CGSize) {
        guard let index = assets.firstIndex(where: { $0.localIdentifier == selectedIdentifier }) else { return }
        let range = max(0, index - 2)...min(assets.count - 1, index + 2)
        let scale = UIScreen.main.scale
        let neighbours = range.filter { $0 != index }.map { assets[$0] }
        ThumbnailLoader.prefetch(neighbours, size: CGSize(width: size.width * scale, height: size.height * scale), contentMode: .fit)
    }

    private var filmstrip: some View {
        Filmstrip(assets: assets, selectedID: selectedIdentifier, motion: motion) { choose($0) }
    }

    private func controls(_ asset: PHAsset) -> some View {
        VStack(spacing: 10) {
            styleButton
            HStack(spacing: 12) {
                Button { prepareShare(asset) } label: {
                    if busy { ProgressView().frame(width: 44, height: 48) }
                    else { controlIcon("square.and.arrow.up") }
                }
                .floatingGlass().accessibilityLabel("Share").disabled(busy)
                Spacer(minLength: 0)
                HStack(spacing: 4) {
                    Button { favorite(asset) } label: { controlIcon(asset.isFavorite ? "heart.fill" : "heart") }
                        .foregroundStyle(asset.isFavorite ? .red : .primary)
                        .accessibilityLabel(asset.isFavorite ? L("Remove from Favorites") : L("Favorite"))
                    Button { withAnimation(motion) { showingInfo.toggle() } } label: {
                        controlIcon(showingInfo ? "info.circle.fill" : "info.circle")
                    }.accessibilityLabel("Info")
                    Menu {
                        Button("Adjust Date & Time…") { editor = .date }
                        Button("Adjust Location…") { editor = .location }
                    } label: { controlIcon("slider.horizontal.3") }.accessibilityLabel("Adjust Info")
                }
                .padding(.horizontal, 8).floatingGlass()
                Spacer(minLength: 0)
                Button { confirmingDelete = true } label: { controlIcon("trash") }
                    .floatingGlass().accessibilityLabel("Delete Photo").disabled(busy || running)
            }
            .foregroundStyle(.primary)
        }
    }

    private func controlIcon(_ name: String) -> some View {
        Image(systemName: name).font(.title3).frame(width: 44, height: 48).contentShape(Rectangle())
    }

    private var styleButton: some View {
        Button {
            guard let asset else { return }
            if replaceOriginals { confirmingReplace = true } else { queue.port([asset]) }
        } label: {
            HStack(spacing: 8) {
                if running { ProgressView() }
                else { Image(systemName: "camera.filters") }
                Text(running ? progressText : actionTitle).lineLimit(1)
            }
            .font(.subheadline.weight(.semibold)).padding(.horizontal, 16).padding(.vertical, 10)
        }
        .modernProminentButton().disabled(running || blocked)
    }

    private func infoPanel(_ asset: PHAsset) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            Capsule().fill(.tertiary).frame(width: 34, height: 4).frame(maxWidth: .infinity).padding(.top, 6)
                .accessibilityHidden(true)
                .onTapGesture { withAnimation(motion) { showingInfo = false } }
            VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(asset.creationDate?.formatted(date: .complete, time: .shortened) ?? L("Unknown"))
                            .font(.subheadline.weight(.medium))
                        Text(PhotoLibraryService.filename(of: asset)).font(.subheadline).foregroundStyle(.secondary).textSelection(.enabled)
                    }
                    Spacer()
                    Button("Adjust") { editor = .date }.font(.subheadline)
                }
                Divider()
                HStack {
                    Text(cameraInfo?.camera ?? L("Photo")).font(.subheadline.weight(.medium))
                    Spacer()
                    Text((HEICCache.peek(asset) ?? true) ? "HEIF" : L("Image")).font(.caption)
                        .padding(.horizontal, 8).padding(.vertical, 4).background(.quaternary, in: Capsule())
                }
                if let lens = cameraInfo?.lens { Text(lens).font(.subheadline).foregroundStyle(.secondary) }
                Text(resolution(asset)).font(.subheadline).foregroundStyle(.secondary)
                if let exposure = cameraInfo?.exposure { Divider(); Text(exposure).font(.caption).foregroundStyle(.secondary) }
                Divider()
                HStack {
                    Label("Live Photo", systemImage: "livephoto")
                    Spacer(); Text(asset.mediaSubtypes.contains(.photoLive) ? L("Yes") : L("No"))
                }.font(.subheadline)
                HStack(alignment: .top) {
                    Text("Photographic Style"); Spacer(); Text(styleStatus(asset)).multilineTextAlignment(.trailing)
                }.font(.subheadline)
            }
            .padding(16).background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 22))
            if let location = asset.location {
                VStack(alignment: .leading, spacing: 8) {
                    Map(initialPosition: .region(MKCoordinateRegion(center: location.coordinate, span: MKCoordinateSpan(latitudeDelta: 0.008, longitudeDelta: 0.008)))) {
                        Marker(placeName ?? L("Photo"), coordinate: location.coordinate)
                    }
                    .frame(height: 180).clipShape(RoundedRectangle(cornerRadius: 22))
                    .id(selectedIdentifier)
                    HStack {
                        Text(placeName ?? L("Location")).font(.subheadline)
                        Spacer(); Button("Adjust") { editor = .location }.font(.subheadline)
                    }.padding(.horizontal, 4)
                }
            } else {
                Button { editor = .location } label: { Label("Add Location…", systemImage: "mappin.and.ellipse") }
            }
            if let job, !job.warnings.isEmpty || job.isFailed { JobNotes(job: job) }
        }
    }

    private var jobState: String {
        guard let job else { return "none" }
        switch job.phase { case .done: return "done"; case .failed: return "failed"; default: return "running" }
    }

    private func refresh() async {
        let id = selectedIdentifier
        asset = PHAsset.fetchAssets(withLocalIdentifiers: [id], options: nil).firstObject
        loaded = true
        if let asset, HEICCache.peek(asset) == nil {
            _ = await HEICCache.isHEIC(asset)
            heicTick += 1
        }
        if let asset, !eligibilityChecked || jobState == "done" {
            let result = await PhotoLibraryService().eligibility(of: asset)
            guard !Task.isCancelled, id == selectedIdentifier else { return }
            eligibility = result; eligibilityChecked = true
        }
    }

    private func choose(_ id: String) {
        guard id != selectedIdentifier else { return }
        eligibility = nil; eligibilityChecked = false; cameraInfo = nil; placeName = nil
        asset = PHAsset.fetchAssets(withLocalIdentifiers: [id], options: nil).firstObject
        selectedIdentifier = id
    }

    private func movePhoto(_ offset: Int) {
        guard let index = assets.firstIndex(where: { $0.localIdentifier == selectedIdentifier }), assets.indices.contains(index + offset) else { return }
        choose(assets[index + offset].localIdentifier)
    }

    private func loadPlace() async {
        placeName = nil
        let id = selectedIdentifier
        do { try await Task.sleep(for: .milliseconds(300)) } catch { return }
        guard let location = PHAsset.fetchAssets(withLocalIdentifiers: [id], options: nil).firstObject?.location else { return }
        let places = try? await CLGeocoder().reverseGeocodeLocation(location)
        guard !Task.isCancelled, id == selectedIdentifier else { return }
        placeName = places?.first?.name ?? places?.first?.locality
    }

    private func favorite(_ asset: PHAsset) {
        let value = !asset.isFavorite
        Task { @MainActor in
            do { try await LibraryActions.update([asset]) { request, _ in request.isFavorite = value }; await refresh() }
            catch { message = error.localizedDescription }
        }
    }

    private func deletePhoto() {
        guard let asset else { return }
        busy = true
        Task { @MainActor in
            defer { busy = false }
            do {
                try await PhotoLibraryService().requireReadWriteAccess()
                try await PHPhotoLibrary.shared().performChanges { PHAssetChangeRequest.deleteAssets([asset] as NSArray) }
                dismiss()
            } catch { message = error.localizedDescription }
        }
    }

    private func prepareShare(_ asset: PHAsset) {
        busy = true
        Task { @MainActor in
            defer { busy = false }
            var files: [URL] = []
            do {
                let resources = PHAssetResource.assetResources(for: asset)
                guard let photo = resources.first(where: { $0.type == .fullSizePhoto }) ?? resources.first(where: { $0.type == .photo }) else { throw LibraryError.assetUnavailable }
                files.append(try await PhotoLibraryService.temporaryCopy(of: photo))
                if let video = resources.first(where: { $0.type == .fullSizePairedVideo }) ?? resources.first(where: { $0.type == .pairedVideo }) {
                    files.append(try await PhotoLibraryService.temporaryCopy(of: video))
                }
                shareFiles = files; share = PhotoShare(urls: files)
            } catch {
                for file in files { try? FileManager.default.removeItem(at: file.deletingLastPathComponent()) }
                message = error.localizedDescription
            }
        }
    }

    private func clearShareFiles() {
        for file in shareFiles { try? FileManager.default.removeItem(at: file.deletingLastPathComponent()) }
        shareFiles = []
    }

    private func resolution(_ asset: PHAsset) -> String {
        let mp = Double(asset.pixelWidth) * Double(asset.pixelHeight) / 1_000_000
        let size = cameraInfo?.bytes.map { " · " + ByteCountFormatter.string(fromByteCount: $0, countStyle: .file) } ?? ""
        return L("\(mp.formatted(.number.precision(.fractionLength(0)))) MP · \(asset.pixelWidth) × \(asset.pixelHeight)") + size
    }
    private func styleStatus(_ asset: PHAsset) -> String {
        if !(HEICCache.peek(asset) ?? true) { return L("Not available: not a HEIC") }
        switch eligibility {
        case .port: return L("Can be added")
        case .addTexture: return L("Has a style; Texture & Grain can be added")
        case .alreadyStyled: return L("Already has a style and Texture & Grain")
        case .unsupported: return L("This HEIC isn't supported yet")
        case nil: return eligibilityChecked ? L("Checked when you add it (in iCloud)") : L("Checking…")
        }
    }
    private var actionTitle: String {
        let texture = eligibility == .addTexture
        if case .done = job?.phase {
            return replaceOriginals ? L("Replace Again")
                : texture ? L("Add Texture & Grain Again") : L("Add Photographic Style Again")
        }
        if replaceOriginals { return texture ? L("Replace with Texture & Grain") : L("Replace with Photographic Style") }
        return texture ? L("Add Texture & Grain") : L("Add Photographic Style")
    }
    private var progressText: String {
        switch job?.phase {
        case .reading: return L("Reading original…")
        case .porting: return L("Adding style…")
        case .saving: return L("Saving…")
        default: return L("Waiting…")
        }
    }
}

/// The photos side by side: the one being swiped to moves with the finger. Its own view, so
/// changes elsewhere in the viewer don't re-diff the whole library during a swipe.
private struct PhotoPager: View {
    let assets: [PHAsset]
    /// The settled photo: the only page that runs a Live Photo player.
    let liveID: String
    let size: CGSize
    @Binding var position: String?

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            LazyHStack(spacing: 0) {
                ForEach(assets, id: \.localIdentifier) { item in
                    PhotoPage(asset: item, playsLive: item.localIdentifier == liveID, size: size)
                        .id(item.localIdentifier)
                }
            }
            .scrollTargetLayout()
        }
        .scrollTargetBehavior(.paging)
        .scrollPosition(id: $position)
    }
}

/// One page. A Live Photo shows its still while it slides past; the player, which loads the
/// video, starts only once the page has settled, over the still so nothing flashes.
private struct PhotoPage: View {
    let asset: PHAsset
    let playsLive: Bool
    let size: CGSize

    var body: some View {
        let ratio = CGFloat(max(asset.pixelWidth, 1)) / CGFloat(max(asset.pixelHeight, 1))
        let width = min(size.width, size.height * ratio)
        ZStack {
            AssetImage(asset: asset, contentMode: .fit)
                .frame(width: width, height: width / ratio)
            if playsLive, asset.mediaSubtypes.contains(.photoLive) {
                // Full page, so a press-and-hold in the blank area around the photo plays it.
                LivePhotoPlayer(asset: asset)
            }
        }
        .frame(width: size.width, height: size.height)
    }
}

private struct Filmstrip: View {
    let assets: [PHAsset]
    let selectedID: String
    let motion: Animation?
    let select: (String) -> Void

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(spacing: 4) {
                    ForEach(assets, id: \.localIdentifier) { item in
                        let selected = item.localIdentifier == selectedID
                        Button { select(item.localIdentifier) } label: {
                            AssetImage(asset: item)
                                .frame(width: selected ? 40 : 25, height: 46)
                                .clipped().clipShape(RoundedRectangle(cornerRadius: 4))
                                .overlay { if selected {
                                    RoundedRectangle(cornerRadius: 4).strokeBorder(Color.accentColor, lineWidth: 2)
                                } }
                        }
                        .buttonStyle(.plain)
                        // A date, not the filename: reading a filename is a synchronous query.
                        .accessibilityLabel(item.creationDate?.formatted(date: .abbreviated, time: .shortened) ?? L("Photo"))
                        .accessibilityAddTraits(selected ? .isSelected : [])
                        .id(item.localIdentifier)
                    }
                }
                .padding(.horizontal, 8)
            }
            .frame(height: 48)
            .onAppear { proxy.scrollTo(selectedID, anchor: .center) }
            .onChange(of: selectedID) { _, id in withAnimation(motion) { proxy.scrollTo(id, anchor: .center) } }
        }
    }
}

private struct PhotoShare: Identifiable { let id = UUID(); let urls: [URL] }
private struct PhotoShareSheet: UIViewControllerRepresentable {
    let urls: [URL]
    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: urls, applicationActivities: nil)
    }
    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}

private struct PhotoCameraInfo {
    let camera: String?
    let lens: String?
    let exposure: String?
    let bytes: Int64?
    static func load(_ asset: PHAsset) async -> PhotoCameraInfo? {
        let options = PHContentEditingInputRequestOptions()
        options.isNetworkAccessAllowed = false
        let input: PHContentEditingInput? = await withCheckedContinuation { continuation in
            asset.requestContentEditingInput(with: options) { input, _ in continuation.resume(returning: input) }
        }
        guard !Task.isCancelled, let url = input?.fullSizeImageURL else { return nil }
        return await Task.detached(priority: .utility) { () -> PhotoCameraInfo? in
            guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
                  let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [String: Any] else { return nil }
            let tiff = props[kCGImagePropertyTIFFDictionary as String] as? [String: Any] ?? [:]
            let exif = props[kCGImagePropertyExifDictionary as String] as? [String: Any] ?? [:]
            let model = tiff[kCGImagePropertyTIFFModel as String] as? String
            let make = tiff[kCGImagePropertyTIFFMake as String] as? String
            let camera = [make, model].compactMap { $0 }.joined(separator: " ")
            let lens = exif[kCGImagePropertyExifLensModel as String] as? String
            var exposure: [String] = []
            if let iso = (exif[kCGImagePropertyExifISOSpeedRatings as String] as? [NSNumber])?.first { exposure.append("ISO \(iso)") }
            if let focal = exif[kCGImagePropertyExifFocalLength as String] as? NSNumber { exposure.append("\(focal) mm") }
            if let aperture = exif[kCGImagePropertyExifFNumber as String] as? NSNumber { exposure.append("ƒ/\(aperture)") }
            if let time = exif[kCGImagePropertyExifExposureTime as String] as? NSNumber {
                exposure.append(time.doubleValue > 0 && time.doubleValue < 1 ? "1/\(Int((1 / time.doubleValue).rounded())) s" : "\(time) s")
            }
            let bytes = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size]) as? NSNumber
            return PhotoCameraInfo(camera: camera.isEmpty ? nil : camera, lens: lens,
                                   exposure: exposure.isEmpty ? nil : exposure.joined(separator: "   ·   "), bytes: bytes?.int64Value)
        }.value
    }
}

private struct LivePhotoPlayer: UIViewRepresentable {
    let asset: PHAsset

    func makeUIView(context: Context) -> PHLivePhotoView {
        let view = PHLivePhotoView()
        view.contentMode = .scaleAspectFit
        return view
    }

    func updateUIView(_ view: PHLivePhotoView, context: Context) {
        guard context.coordinator.identifier != asset.localIdentifier else { return }
        if let request = context.coordinator.request {
            PHImageManager.default().cancelImageRequest(request)
        }
        context.coordinator.identifier = asset.localIdentifier
        view.livePhoto = nil
        let id = asset.localIdentifier
        let coordinator = context.coordinator
        let options = PHLivePhotoRequestOptions()
        options.deliveryMode = .opportunistic
        options.isNetworkAccessAllowed = true
        let scale = view.window?.screen.scale ?? 3
        let size = CGSize(width: max(view.bounds.width, 400) * scale, height: max(view.bounds.height, 400) * scale)
        context.coordinator.request = PHImageManager.default().requestLivePhoto(
            for: asset,
            targetSize: size,
            contentMode: .aspectFit,
            options: options
        ) { [weak view, weak coordinator] livePhoto, _ in
            guard coordinator?.identifier == id else { return }
            if let livePhoto { view?.livePhoto = livePhoto }
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    static func dismantleUIView(_ view: PHLivePhotoView, coordinator: Coordinator) {
        coordinator.identifier = nil
        if let request = coordinator.request { PHImageManager.default().cancelImageRequest(request) }
        view.livePhoto = nil
    }

    final class Coordinator {
        var identifier: String?
        var request: PHImageRequestID?
    }
}
