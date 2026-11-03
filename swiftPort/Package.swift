// swift-tools-version: 5.10

import PackageDescription

let package = Package(
    name: "StylePort",
    platforms: [
        .iOS(.v17),
        .macOS(.v14)
    ],
    products: [
        .library(name: "StylePortCore", targets: ["StylePortCore"])
    ],
    dependencies: [
        // Find Faces' MediaPipe engine (iOS only; macOS `swift test` skips it).
        .package(url: "https://github.com/google-ai-edge/mediapipe", exact: "1.2.0")
    ],
    targets: [
        .target(
            name: "StylePortCore",
            dependencies: [
                .product(name: "MediaPipeTasksVision", package: "mediapipe", condition: .when(platforms: [.iOS]))
            ],
            path: ".",
            exclude: [
                "README.md",
                "IconSources",
                "project.yml",
                "StylePort.xcodeproj",
                "scripts",
                "tools",
                "Sources/StylePortApp",
                "Tests",
                "Resources/Assets.xcassets",
                "Resources/Localizable.xcstrings",
                "Resources/en.lproj",
                "Resources/zh-Hans.lproj"
            ],
            sources: ["Sources/StylePortCore"],
            resources: [.copy("Resources/Profiles"), .copy("Resources/Models")]
        ),
        .testTarget(
            name: "StylePortCoreTests",
            dependencies: ["StylePortCore"],
            path: "Tests/StylePortCoreTests"
        )
    ]
)
