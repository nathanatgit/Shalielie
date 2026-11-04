import Foundation

/// The few settings the Share extension needs, mirrored by the app into an App Group so the
/// extension follows them. The extension is a separate process with its own storage and cannot
/// read the app's UserDefaults. Without the App Group (an install that was signed without it)
/// the suite is private to each process and the extension simply uses the defaults.
public enum SharedSettings {
    public static let groupID = "group.com.nathanhanapps.styleport"
    static let analyzePhotoKey = "analyzePhoto"
    static let textureKey = "addTexture"
    static let anyImageKey = "experimentalAnyImage"
    static let detectPeopleKey = "experimentalDetectPeople"

    /// Sideloading tools may rename the group to make it unique to the signing account; they
    /// list the real names in the Info.plist (AltStore: ALTAppGroups).
    static var suite: UserDefaults? {
        let renamed = (Bundle.main.object(forInfoDictionaryKey: "ALTAppGroups") as? [String])?.first
        return UserDefaults(suiteName: renamed ?? groupID)
    }

    /// Called by the app whenever its own settings change. A value is only written when it
    /// differs, so an unchanged setting never touches the suite.
    public static func mirror(analyzePhoto: Bool, texture: Bool, anyImage: Bool, detectPeople: Bool) {
        guard let suite else { return }
        for (key, value) in [(analyzePhotoKey, analyzePhoto), (textureKey, texture),
                             (anyImageKey, anyImage), (detectPeopleKey, detectPeople)]
        where suite.object(forKey: key) == nil || suite.bool(forKey: key) != value {
            suite.set(value, forKey: key)
        }
    }

    /// The options the extension starts from: the app's, or the app's defaults before it has
    /// ever mirrored them.
    public static func porterOptions() -> StylePortOptions {
        let suite = suite
        func flag(_ key: String, default value: Bool) -> Bool {
            suite?.object(forKey: key) == nil ? value : (suite?.bool(forKey: key) ?? value)
        }
        let anyImage = flag(anyImageKey, default: false)
        return StylePortOptions(
            analyzePhoto: flag(analyzePhotoKey, default: true),
            texture: flag(textureKey, default: true),
            sdr: anyImage,
            detectPeople: flag(detectPeopleKey, default: false))
    }

}
