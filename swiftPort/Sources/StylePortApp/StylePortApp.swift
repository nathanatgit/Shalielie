import StylePortCore
import SwiftUI

@main
struct StylePortApp: App {
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var queue = PortQueue()
    @StateObject private var backups = BackupStore()

    init() {
        AppSettings.registerDefaults()
        // Keep the Share extension's copy of the settings current.
        NotificationCenter.default.addObserver(
            forName: UserDefaults.didChangeNotification, object: nil, queue: .main
        ) { _ in AppSettings.mirrorToShared() }
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(queue)
                .environment(\.portQueue, queue)
                .environmentObject(backups)
                .task { queue.backups = backups }
                .onReceive(backups.$entries) { StyleRecords.shared.sync(with: $0) }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { backups.purgeExpired() }
        }
    }
}

private struct PortQueueKey: EnvironmentKey {
    static let defaultValue: PortQueue? = nil
}

extension EnvironmentValues {
    /// The queue without observing it, for views that start jobs but don't show progress.
    var portQueue: PortQueue? {
        get { self[PortQueueKey.self] }
        set { self[PortQueueKey.self] = newValue }
    }
}

enum AppTab: Int, CaseIterable {
    case library, albums, backups, me
}

struct RootView: View {
    @EnvironmentObject private var queue: PortQueue
    @State private var showingActivity = false
    @State private var tab = AppTab.library

    /// "Me" sits apart from the other tabs, at the bottom right, on iOS 26 (the search role is
    /// the system's detached trailing tab); earlier systems show it as a normal tab.
    @ViewBuilder
    private var tabs: some View {
        if #available(iOS 18.0, *) {
            TabView(selection: $tab) {
                Tab("Library", systemImage: "photo.on.rectangle", value: AppTab.library) { LibraryTab() }
                Tab("Albums", systemImage: "rectangle.stack", value: AppTab.albums) { AlbumsTab() }
                Tab("Backup Bin", systemImage: "archivebox", value: AppTab.backups) { BackupBinTab() }
                Tab("Palettify", systemImage: "person.crop.circle", value: AppTab.me, role: .search) { SettingsTab() }
            }
        } else {
            TabView(selection: $tab) {
                LibraryTab()
                    .tabItem { Label("Library", systemImage: "photo.on.rectangle") }
                    .tag(AppTab.library)
                AlbumsTab()
                    .tabItem { Label("Albums", systemImage: "rectangle.stack") }
                    .tag(AppTab.albums)
                BackupBinTab()
                    .tabItem { Label("Backup Bin", systemImage: "archivebox") }
                    .tag(AppTab.backups)
                SettingsTab()
                    .tabItem { Label("Palettify", systemImage: "person.crop.circle") }
                    .tag(AppTab.me)
            }
        }
    }

    var body: some View {
        tabs
        .modernTabBar()
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if let status = queue.statusLine {
                HStack(spacing: 8) {
                    Button {
                        showingActivity = true
                        queue.dismissStatus()
                    } label: {
                        ActivityCapsule(status: status, isRunning: queue.isRunning)
                    }
                    .buttonStyle(.plain)
                    if !queue.undoable.isEmpty {
                        Button {
                            queue.undoReplace()
                        } label: {
                            Label("Undo", systemImage: "arrow.uturn.backward")
                                .font(.subheadline.weight(.semibold))
                                .padding(.horizontal, 16)
                                .padding(.vertical, 10)
                                .floatingGlass()
                        }
                        .buttonStyle(.plain)
                        .transition(.scale.combined(with: .opacity))
                    }
                }
                .padding(.bottom, 56)
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .animation(.spring(duration: 0.3), value: queue.statusLine)
        .animation(.spring(duration: 0.3), value: queue.undoable.isEmpty)
        .alert("Couldn't Undo", isPresented: Binding(
            get: { queue.undoError != nil },
            set: { if !$0 { queue.undoError = nil } }
        )) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(queue.undoError ?? "")
        }
        .sheet(isPresented: $showingActivity) {
            ActivitySheet()
        }
    }
}

private struct ActivityCapsule: View {
    let status: String
    let isRunning: Bool

    var body: some View {
        HStack(spacing: 10) {
            if isRunning {
                ProgressView()
            } else {
                Image(systemName: "checkmark.circle.fill")
                    .foregroundStyle(.green)
            }
            Text(status)
                .font(.subheadline.weight(.medium))
                .lineLimit(1)
            Image(systemName: "chevron.up")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .floatingGlass()
        .shadow(color: .black.opacity(0.12), radius: 8, y: 2)
    }
}
