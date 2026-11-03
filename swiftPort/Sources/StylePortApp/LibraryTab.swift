import Photos
import SwiftUI
import UniformTypeIdentifiers

/// Every photo the app may see: the whole library with full access, or the person's
/// selection with limited access.
struct LibraryTab: View {
    @Environment(\.portQueue) private var queue
    @AppStorage(AppSettings.librarySortKey) private var sort = LibrarySort.captured
    @AppStorage(AppSettings.libraryAscendingKey) private var ascending = true
    @AppStorage(AppSettings.styleFilterKey) private var styleFilter = StyleFilter.all
    @AppStorage(AppSettings.anyImageKey) private var anyImage = false
    @StateObject private var model = AssetListModel(
        scope: .library,
        sort: LibrarySort(rawValue: UserDefaults.standard.string(forKey: AppSettings.librarySortKey) ?? "")
            ?? .captured,
        ascending: UserDefaults.standard.bool(forKey: AppSettings.libraryAscendingKey)
    )
    @State private var status = PhotoLibraryService.status
    @State private var importingFiles = false
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        NavigationStack {
            content
                .navigationTitle("Library")
                // Large title in the button row, as in Photos, instead of a band of its own.
                .toolbarTitleDisplayMode(.inlineLarge)
                .toolbar {
                    ToolbarItemGroup(placement: .topBarTrailing) {
                        if status == .authorized || status == .limited {
                            SortMenu()
                        }
                        Menu {
                            if status == .limited {
                                Button {
                                    LimitedLibrary.presentPicker()
                                } label: {
                                    Label("Select More Photos…", systemImage: "photo.badge.plus")
                                }
                            }
                            Button {
                                importingFiles = true
                            } label: {
                                Label(anyImage ? L("Import Images…") : L("Import HEIC (and MOV) Files…"), systemImage: "folder")
                            }
                        } label: {
                            Label("Add", systemImage: "plus")
                        }
                    }
                }
                .fileImporter(
                    isPresented: $importingFiles,
                    allowedContentTypes: anyImage ? [.image, .quickTimeMovie] : [.heic, .heif, .quickTimeMovie],
                    allowsMultipleSelection: true
                ) { result in
                    if case .success(let urls) = result { queue?.port(files: urls) }
                }
        }
        .task {
            status = await PhotoLibraryService.requestAccess()
            if status == .authorized || status == .limited { model.load() }
        }
        .onChange(of: scenePhase) { _, phase in
            // Access can change in Settings while the app is in the background.
            guard phase == .active else { return }
            let now = PhotoLibraryService.status
            if now != status {
                status = now
                if now == .authorized || now == .limited { model.load() }
            }
        }
        .onChange(of: sort) { _, sort in model.setSort(sort, ascending: ascending) }
        .onChange(of: ascending) { _, ascending in model.setSort(sort, ascending: ascending) }
        .onChange(of: styleFilter) { _, _ in model.reload() }
    }

    @ViewBuilder
    private var content: some View {
        switch status {
        case .authorized, .limited:
            AssetGridView(model: model) {
                if status == .limited {
                    ContentUnavailableView {
                        Label("No Photos Selected", systemImage: "photo.badge.plus")
                    } description: {
                        Text("Palettify only sees the photos you choose. Select the photos you want to style.")
                    } actions: {
                        Button("Select Photos…") { LimitedLibrary.presentPicker() }
                            .buttonStyle(.borderedProminent)
                    }
                } else {
                    ContentUnavailableView(
                        "No Photos",
                        systemImage: "photo",
                        description: Text("Photos you take or save appear here.")
                    )
                }
            }
        case .notDetermined:
            ProgressView()
        default:
            ContentUnavailableView {
                Label("No Access to Photos", systemImage: "lock")
            } description: {
                Text("Palettify reads each original HEIC and its Live Photo video, and saves the styled result. Allow access in Settings.")
            } actions: {
                Button("Open Settings") { LimitedLibrary.openSettings() }
                    .buttonStyle(.borderedProminent)
            }
        }
    }
}
