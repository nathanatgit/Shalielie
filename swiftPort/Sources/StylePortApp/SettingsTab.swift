import StylePortCore
import SwiftUI

struct SettingsTab: View {
    @AppStorage(AppSettings.replaceOriginalsKey) private var replaceOriginals = false
    @AppStorage(AppSettings.analyzePhotoKey) private var analyzePhoto = true
    @AppStorage(AppSettings.textureKey) private var texture = true

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("When Styling a Photo", selection: $replaceOriginals) {
                        Text("Save as New").tag(false)
                        Text("Replace Original").tag(true)
                    }
                    .pickerStyle(.segmented)
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets())
                } header: {
                    Text("Mode")
                } footer: {
                    Text(replaceOriginals
                         ? "The styled photo takes the original's place, with its date, location, favorite and albums. The original goes to the Backup Bin, so you can restore it."
                         : "The styled photo is saved next to the original as a new photo, named with \"_PhotographicStyle\". Live Photos stay Live Photos.")
                }

                Section {
                    Toggle("Analyze Each Photo", isOn: $analyzePhoto)
                    Toggle("Add Texture & Grain", isOn: $texture)
                } header: {
                    Text("Style")
                } footer: {
                    Text("Analyzing measures the photo's own tones for the palette instead of using the reference photo's. Texture & Grain adds the iOS 27 controls, and Soft Skin when the photo has the face data for it.")
                }

                Section {
                    Label("The Add Photographic Style action always saves a new photo and never replaces one.", systemImage: "square.2.layers.3d")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                } header: {
                    Text("Shortcuts")
                }

                Section {
                    NavigationLink {
                        AboutView()
                    } label: {
                        Label("About Shalielie", systemImage: "info.circle")
                    }
                    Link(destination: AppSettings.repositoryURL) {
                        Label("Source Code on GitHub", systemImage: "chevron.left.forwardslash.chevron.right")
                    }
                    LabeledContent("Version", value: AppSettings.appVersion)
                }
            }
            .navigationTitle("Settings")
        }
    }
}

struct AboutView: View {
    var body: some View {
        List {
            Section {
                VStack(spacing: 10) {
                    Image("AboutIcon")
                        .resizable()
                        .frame(width: 96, height: 96)
                        .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
                        .accessibilityHidden(true)
                    Text("Shalielie")
                        .font(.title.bold())
                    Text("Photographic Styles for every iPhone photo")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    Text("Version \(AppSettings.appVersion) · porter \(StylePorter.version)")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 8)
                .listRowBackground(Color.clear)
            }

            Section("Features") {
                Feature(
                    symbol: "camera.filters",
                    title: "Photographic Styles palette",
                    text: "Adds the style palette introduced with iPhone 16 to HEIC photos from earlier iPhones, so you can change the style in Photos and change it back."
                )
                Feature(
                    symbol: "circle.grid.3x3",
                    title: "Texture & Grain",
                    text: "Adds the iOS 27 Texture and Grain controls, and Soft Skin for portraits with face data. Photos from iPhone 16 and 17 that already have a style get just these."
                )
                Feature(
                    symbol: "livephoto",
                    title: "Live Photos stay live",
                    text: "The original video is kept and saved with the styled photo, so it still plays."
                )
                Feature(
                    symbol: "arrow.triangle.2.circlepath",
                    title: "Save as new or replace",
                    text: "Keep both versions, or replace the original with its date, location, favorite and albums carried over."
                )
                Feature(
                    symbol: "archivebox",
                    title: "Backup Bin",
                    text: "Every replaced original is kept, with its video, until you restore or delete it."
                )
                Feature(
                    symbol: "square.2.layers.3d",
                    title: "Shortcuts",
                    text: "Add a style from any shortcut with the Add Photographic Style action."
                )
            }

            Section("Privacy") {
                Feature(
                    symbol: "iphone",
                    title: "Everything stays on this device",
                    text: "Photos are processed on your iPhone or iPad and never uploaded. Shalielie has no servers, no accounts, no analytics and no ads."
                )
                Feature(
                    symbol: "photo.on.rectangle",
                    title: "Only the photos you allow",
                    text: "With limited access Shalielie sees only the photos you select. Photos stored in iCloud are downloaded by iOS when you style them."
                )
                Feature(
                    symbol: "lock.shield",
                    title: "Backups are yours",
                    text: "The Backup Bin lives in the app's own storage on this device and is deleted with the app."
                )
            }

            Section {
                Text("Experimental, unofficial software, not affiliated with Apple. Keep your original photos.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                Link(destination: AppSettings.repositoryURL) {
                    Label("github.com/nathanatgit/Shalielie", systemImage: "link")
                }
            }
        }
        .navigationTitle("About")
        .navigationBarTitleDisplayMode(.inline)
    }
}

private struct Feature: View {
    let symbol: String
    let title: String
    let text: String

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            Image(systemName: symbol)
                .font(.title3)
                .foregroundStyle(.tint)
                .frame(width: 28)
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.headline)
                Text(text)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 4)
    }
}
