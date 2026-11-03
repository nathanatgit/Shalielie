import Photos
import StylePortCore
import SwiftUI

struct SettingsTab: View {
    @EnvironmentObject private var backups: BackupStore
    @AppStorage(AppSettings.replaceOriginalsKey) private var replaceOriginals = false
    @AppStorage(AppSettings.analyzePhotoKey) private var analyzePhoto = true
    @AppStorage(AppSettings.textureKey) private var texture = true
    @AppStorage(AppSettings.anyImageKey) private var anyImage = false
    @AppStorage(AppSettings.detectPeopleKey) private var detectPeople = false
    @AppStorage(AppSettings.notifyWhenDoneKey) private var notifyWhenDone = true
    @AppStorage(AppSettings.backupRetentionKey) private var retentionDays = 0
    @State private var access = PhotoLibraryService.status
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    NavigationLink {
                        AboutView()
                    } label: {
                        HStack(spacing: 14) {
                            Image("AboutIcon")
                                .resizable()
                                .frame(width: 56, height: 56)
                                .clipShape(RoundedRectangle(cornerRadius: 13, style: .continuous))
                                .accessibilityHidden(true)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(AppSettings.displayName).font(.title3.bold())
                                Text(L("Version") + " " + AppSettings.appVersion)
                                    .font(.subheadline)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .padding(.vertical, 4)
                    }
                }

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
                    if replaceOriginals {
                        Text("The styled photo takes the original's place, with its date, location, favorite and albums. The original goes to the Backup Bin, so you can restore it.")
                    } else {
                        Text("The styled photo is saved next to the original as a new photo, named with \"_PhotographicStyle\".")
                    }
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
                    LabeledContent {
                        Text(accessTitle)
                    } label: {
                        Label("Photo Access", systemImage: "photo.on.rectangle")
                    }
                    if access == .limited {
                        Button {
                            LimitedLibrary.presentPicker()
                        } label: {
                            Label("Select More Photos…", systemImage: "photo.badge.plus")
                        }
                    } else if access != .authorized {
                        Button {
                            LimitedLibrary.openSettings()
                        } label: {
                            Label("Open Settings", systemImage: "gearshape")
                        }
                    }
                    LabeledContent {
                        Text(backupSummary)
                    } label: {
                        Label("Backup Bin", systemImage: "archivebox")
                    }
                    Picker(selection: $retentionDays) {
                        Text("Until I Delete Them").tag(0)
                        Text("30 Days").tag(30)
                        Text("90 Days").tag(90)
                        Text("1 Year").tag(365)
                    } label: {
                        Label("Keep Originals", systemImage: "clock.arrow.circlepath")
                    }
                } header: {
                    Text("Photos & Backups")
                } footer: {
                    if retentionDays > 0 {
                        Text("Originals older than this are deleted from the Backup Bin when you open Palettify. They can't be restored afterwards.")
                    }
                }

                Section {
                    Toggle("Notify When Done", isOn: $notifyWhenDone)
                } header: {
                    Text("Background")
                } footer: {
                    Text("Styling keeps going for a while after you leave Palettify, and a notification says when a batch finishes. On iOS 26 a batch can run to the end, with its progress on the Lock Screen.")
                }

                Section {
                    Toggle(isOn: $anyImage) {
                        Label("Any Image", systemImage: "photo.stack")
                    }
                } header: {
                    Text("Experimental")
                } footer: {
                    Text("Also style photos without an HDR gain map, such as photos from older iPhones, and convert JPEG, PNG, screenshots and other pictures to an iPhone-style HEIC first. Works in Photos in tests so far, but still experimental. The Backup Bin keeps the original file.")
                }

                Section {
                    Toggle(isOn: $detectPeople) {
                        Label("Find Faces for Soft Skin", systemImage: "face.smiling")
                    }
                    .disabled(!texture)
                } footer: {
                    Text("For photos without Apple's own people data, Palettify finds faces and people on the device and estimates the skin, so Soft Skin can work. The estimate is not the camera's own data and is untested in Photos. Needs Texture & Grain.")
                }

                Section {
                    Label("The Add Photographic Style action always saves a new photo and never replaces one.", systemImage: "square.2.layers.3d")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    if let url = URL(string: "shortcuts://") {
                        Link(destination: url) {
                            Label("Open Shortcuts", systemImage: "arrow.up.forward.app")
                        }
                    }
                } header: {
                    Text("Shortcuts")
                }

                Section {
                    NavigationLink {
                        FeaturesView()
                    } label: {
                        Label("Features", systemImage: "sparkles")
                    }
                    NavigationLink {
                        PrivacyView()
                    } label: {
                        Label("Privacy", systemImage: "lock.shield")
                    }
                    NavigationLink {
                        AboutView()
                    } label: {
                        Label("About Palettify", systemImage: "info.circle")
                    }
                    Link(destination: AppSettings.repositoryURL) {
                        Label { Text("Source Code on GitHub") } icon: { GitHubMark() }
                    }
                } header: {
                    Text("About")
                }
            }
            .readableWidth()
            .navigationTitle("Palettify")
        }
        .onChange(of: scenePhase) { _, phase in
            // Access can change in Settings while the app is in the background.
            if phase == .active { access = PhotoLibraryService.status }
        }
    }

    private var accessTitle: String {
        switch access {
        case .authorized: return L("Full Access")
        case .limited: return L("Limited Access")
        case .notDetermined: return L("Not Determined")
        default: return L("No Access")
        }
    }

    private var backupSummary: String {
        guard !backups.entries.isEmpty else { return L("No originals") }
        let count = backups.entries.count == 1 ? L("1 original") : L("\(backups.entries.count) originals")
        let size = ByteCountFormatter.string(fromByteCount: backups.totalBytes, countStyle: .file)
        return count + ", " + size
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
                    Text(AppSettings.displayName)
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

            Section {
                Text("Experimental, unofficial software, not affiliated with Apple. Keep your original photos.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                Link(destination: AppSettings.repositoryURL) {
                    Label { Text("github.com/nathanatgit/Shalielie") } icon: { GitHubMark() }
                }
            }
        }
        .readableWidth()
        .navigationTitle("About")
        .navigationBarTitleDisplayMode(.inline)
    }
}

struct FeaturesView: View {
    var body: some View {
        List {
            Section {
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
                    title: "Live Photos",
                    text: "Live Photos keep their motion when their video can be styled. Cropped videos are re-encoded to prevent blurred edges. If video processing fails, the job explains why a still was saved; the original keeps its motion."
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
        }
        .readableWidth()
        .navigationTitle("Features")
        .navigationBarTitleDisplayMode(.inline)
    }
}

struct PrivacyView: View {
    var body: some View {
        List {
            Section {
                Feature(
                    symbol: "iphone",
                    title: "Everything stays on this device",
                    text: "Photos are processed on your iPhone or iPad and never uploaded. Palettify has no servers, no accounts, no analytics and no ads."
                )
                Feature(
                    symbol: "photo.on.rectangle",
                    title: "Only the photos you allow",
                    text: "With limited access Palettify sees only the photos you select. Photos stored in iCloud are downloaded by iOS when you style them."
                )
                Feature(
                    symbol: "lock.shield",
                    title: "Backups are yours",
                    text: "The Backup Bin lives in the app's own storage on this device and is deleted with the app."
                )
            }
        }
        .readableWidth()
        .navigationTitle("Privacy")
        .navigationBarTitleDisplayMode(.inline)
    }
}

/// GitHub's mark (from Primer Octicons), tinted like the SF Symbols beside it.
private struct GitHubMark: View {
    var body: some View {
        Image("GitHubMark")
            .resizable()
            .scaledToFit()
            .frame(width: 20, height: 20)
            .accessibilityHidden(true)
    }
}

private struct Feature: View {
    let symbol: String
    let title: LocalizedStringKey
    let text: LocalizedStringKey

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
