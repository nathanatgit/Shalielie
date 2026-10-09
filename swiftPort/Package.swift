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
    targets: [
        .target(
            name: "StylePortCore",
            path: ".",
            exclude: [
                "README.md",
                "project.yml",
                "StylePort.xcodeproj",
                "scripts",
                "tools",
                "Sources/StylePortApp",
                "Tests",
                "Resources/Assets.xcassets",
                "Resources/en.lproj",
                "Resources/zh-Hans.lproj"
            ],
            sources: ["Sources/StylePortCore"],
            resources: [.copy("Resources/Profiles")]
        ),
        .testTarget(
            name: "StylePortCoreTests",
            dependencies: ["StylePortCore"],
            path: "Tests/StylePortCoreTests"
        )
    ]
)
