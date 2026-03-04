// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "OmniKeyAI",
    platforms: [
        .macOS(.v13),
    ],
    products: [
        .executable(name: "OmniKeyAI", targets: ["OmniKeyAI"]),
    ],
    dependencies: [
        // Sparkle framework for macOS app auto-updates
        .package(url: "https://github.com/sparkle-project/Sparkle", from: "2.9.0"),
    ],
    targets: [
        .executableTarget(
            name: "OmniKeyAI",
            dependencies: [
                .product(name: "Sparkle", package: "Sparkle"),
            ],
            path: "Sources",
            linkerSettings: [
                .linkedFramework("Carbon"),
            ]
        ),
    ]
)
