import Foundation
import StylePortCore

/// User settings, read by views through @AppStorage and by the queue through these accessors.
enum AppSettings {
    static let replaceOriginalsKey = "replaceOriginals"
    static let analyzePhotoKey = "analyzePhoto"
    static let textureKey = "addTexture"
    static let librarySortKey = "librarySort"
    static let libraryAscendingKey = "libraryAscending"
    static let gridTileSizeKey = "libraryGridTileSize"
    static let sdrKey = "experimentalSDR"
    static let styleFilterKey = "libraryStyleFilter"

    static let repositoryURL = URL(string: "https://github.com/nathanatgit/Shalielie")!

    static func registerDefaults() {
        UserDefaults.standard.register(defaults: [
            replaceOriginalsKey: false,
            analyzePhotoKey: true,
            textureKey: true,
            librarySortKey: LibrarySort.captured.rawValue,
            libraryAscendingKey: false,
            sdrKey: false
        ])
    }

    static var replaceOriginals: Bool { UserDefaults.standard.bool(forKey: replaceOriginalsKey) }
    static var analyzePhoto: Bool { UserDefaults.standard.bool(forKey: analyzePhotoKey) }
    static var texture: Bool { UserDefaults.standard.bool(forKey: textureKey) }
    /// Experimental: port SDR photos too (no HDR gain map).
    static var sdr: Bool { UserDefaults.standard.bool(forKey: sdrKey) }

    static var styleFilter: StyleFilter {
        StyleFilter(rawValue: UserDefaults.standard.string(forKey: styleFilterKey) ?? "") ?? .all
    }

    /// The porter options from the current settings.
    static var portOptions: StylePortOptions {
        StylePortOptions(analyzePhoto: analyzePhoto, texture: texture, sdr: sdr)
    }

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

/// Which photos a grid shows: all, only the ones still to style, or only styled ones.
enum StyleFilter: String, CaseIterable, Identifiable {
    case all, unstyled, styled
    var id: String { rawValue }

    var title: String {
        switch self {
        case .all: return L("All Photos")
        case .unstyled: return L("Not Styled Yet")
        case .styled: return L("Styled")
        }
    }

    /// Styled by this app: recorded, or named with the suffix a save-as-new port adds.
    static func isStyled(identifier: String, filename: String?, known: Set<String>) -> Bool {
        if known.contains(identifier) { return true }
        guard let name = filename.map({ ($0 as NSString).deletingPathExtension }) else { return false }
        return name.hasSuffix("_PhotographicStyle") || name.hasSuffix("_TextureGrain")
    }
}
