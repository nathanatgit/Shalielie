import SwiftUI

@main
struct StylePortApp: App {
    @StateObject private var queue = PortQueue()
    @StateObject private var backups = BackupStore()

    init() {
        AppSettings.registerDefaults()
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(queue)
                .environmentObject(backups)
                .task { queue.backups = backups }
        }
    }
}

struct RootView: View {
    @EnvironmentObject private var queue: PortQueue
    @State private var showingActivity = false

    var body: some View {
        TabView {
            LibraryTab()
                .tabItem { Label("Library", systemImage: "photo.on.rectangle") }
            AlbumsTab()
                .tabItem { Label("Albums", systemImage: "rectangle.stack") }
            BackupBinTab()
                .tabItem { Label("Backup Bin", systemImage: "archivebox") }
            SettingsTab()
                .tabItem { Label("Settings", systemImage: "gearshape") }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if let status = queue.statusLine {
                Button {
                    showingActivity = true
                    queue.dismissStatus()
                } label: {
                    ActivityCapsule(status: status, isRunning: queue.isRunning)
                }
                .buttonStyle(.plain)
                .padding(.bottom, 56)
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .animation(.spring(duration: 0.3), value: queue.statusLine)
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
        .background(.regularMaterial, in: Capsule())
        .shadow(color: .black.opacity(0.12), radius: 8, y: 2)
    }
}
