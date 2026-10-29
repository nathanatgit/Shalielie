import Foundation

/// User settings, read by views through @AppStorage and by the queue through these accessors.
enum AppSettings {
    static let replaceOriginalsKey = "replaceOriginals"
    static let analyzePhotoKey = "analyzePhoto"
    static let textureKey = "addTexture"
    static let librarySortKey = "librarySort"
    static let libraryAscendingKey = "libraryAscending"
    static let gridTileSizeKey = "libraryGridTileSize"
    /// The share extension's "Keep Live Photo Motion"; the extension keeps its own settings.
    static let shareKeepsMotionKey = "shareKeepsMotion"

    static let repositoryURL = URL(string: "https://github.com/nathanatgit/Shalielie")!

    static func registerDefaults() {
        UserDefaults.standard.register(defaults: [
            replaceOriginalsKey: false,
            analyzePhotoKey: true,
            textureKey: true,
            librarySortKey: LibrarySort.captured.rawValue,
            libraryAscendingKey: false,
            shareKeepsMotionKey: true
        ])
    }

    static var replaceOriginals: Bool { UserDefaults.standard.bool(forKey: replaceOriginalsKey) }
    static var analyzePhoto: Bool { UserDefaults.standard.bool(forKey: analyzePhotoKey) }
    static var texture: Bool { UserDefaults.standard.bool(forKey: textureKey) }

    static var displayName: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String ?? "Palettify"
    }

    static var appVersion: String {
        let info = Bundle.main.infoDictionary
        let version = info?["CFBundleShortVersionString"] as? String ?? "?"
        let build = info?["CFBundleVersion"] as? String ?? "?"
        return "\(version) (\(build))"
    }
}

enum LibrarySort: String, CaseIterable, Identifiable {
    case filename
    case captured
    case saved

    var id: String { rawValue }

    var title: String {
        switch self {
        case .filename: return L("Filename")
        case .captured: return L("Date Captured")
        case .saved: return L("Date Saved")
        }
    }
}
