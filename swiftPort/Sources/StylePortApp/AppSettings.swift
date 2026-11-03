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
    /// Retired: its setting moved into Any Image (see registerDefaults).
    static let sdrKey = "experimentalSDR"
    static let anyImageKey = "experimentalAnyImage"
    static let detectPeopleKey = "experimentalDetectPeople"
    static let styleFilterKey = "libraryStyleFilter"
    static let notifyWhenDoneKey = "notifyWhenDone"
    /// Days the Backup Bin keeps an original; 0 keeps it until deleted by hand.
    static let backupRetentionKey = "backupRetentionDays"

    static let repositoryURL = URL(string: "https://github.com/nathanatgit/Shalielie")!

    static func registerDefaults() {
        // SDR Photos was folded into Any Image: keep it on for anyone who had it on.
        let defaults = UserDefaults.standard
        if defaults.object(forKey: sdrKey) != nil {
            if defaults.bool(forKey: sdrKey) { defaults.set(true, forKey: anyImageKey) }
            defaults.removeObject(forKey: sdrKey)
        }
        defaults.register(defaults: [
            replaceOriginalsKey: false,
            analyzePhotoKey: true,
            textureKey: true,
            librarySortKey: LibrarySort.captured.rawValue,
            // Oldest at the top, newest at the bottom, as in Photos.
            libraryAscendingKey: true,
            anyImageKey: false,
            detectPeopleKey: false,
            notifyWhenDoneKey: true,
            backupRetentionKey: 0
        ])
    }

    static var replaceOriginals: Bool { UserDefaults.standard.bool(forKey: replaceOriginalsKey) }
    static var analyzePhoto: Bool { UserDefaults.standard.bool(forKey: analyzePhotoKey) }
    static var texture: Bool { UserDefaults.standard.bool(forKey: textureKey) }
    static var notifyWhenDone: Bool { UserDefaults.standard.bool(forKey: notifyWhenDoneKey) }
    static var backupRetentionDays: Int { UserDefaults.standard.integer(forKey: backupRetentionKey) }
    /// Experimental: port SDR photos too (no HDR gain map). Part of Any Image.
    static var sdr: Bool { anyImage }
    /// Experimental: style SDR photos as they are, and convert any other picture to an
    /// iPhone-shaped HEIC, then style it.
    static var anyImage: Bool { UserDefaults.standard.bool(forKey: anyImageKey) }
    /// Experimental: find faces and people with Vision, on the device, so Soft Skin works on
    /// photos without Apple's own people data.
    static var detectPeople: Bool { UserDefaults.standard.bool(forKey: detectPeopleKey) }

    static var styleFilter: StyleFilter {
        StyleFilter(rawValue: UserDefaults.standard.string(forKey: styleFilterKey) ?? "") ?? .all
    }

    /// The porter options from the current settings.
    static var portOptions: StylePortOptions {
        StylePortOptions(analyzePhoto: analyzePhoto, texture: texture, sdr: sdr, detectPeople: detectPeople)
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
