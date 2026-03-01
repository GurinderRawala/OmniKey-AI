// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "OmniKeyAI",
    platforms: [
        .macOS(.v13)
    ],
    products: [
        .executable(name: "OmniKeyAI", targets: ["OmniKeyAI"])
    ],
    targets: [
        .executableTarget(
            name: "OmniKeyAI",
            dependencies: [],
            path: "Sources",
            resources: [
                // Bundle assets like MenuBarIcon.png for use at runtime
                .process("assets")
            ],
            linkerSettings: [
                .linkedFramework("Carbon")
            ]
        )
    ]
)
