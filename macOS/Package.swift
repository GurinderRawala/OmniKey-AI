// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "OmniKeyAI",
    platforms: [
        // gRPC Swift v2 requires macOS 15 or newer.
        .macOS(.v15),
    ],
    products: [
        .executable(name: "OmniKeyAI", targets: ["OmniKeyAI"]),
    ],
    dependencies: [
        // Sparkle framework for macOS app auto-updates
        .package(url: "https://github.com/sparkle-project/Sparkle", from: "2.9.0"),
        // gRPC Swift v2 core + NIO HTTP/2 transport + Protobuf integration
        .package(url: "https://github.com/grpc/grpc-swift.git", from: "1.27.0"),
        .package(url: "https://github.com/apple/swift-protobuf.git", from: "1.26.0"),
    ],
    targets: [
        .executableTarget(
            name: "OmniKeyAI",
            dependencies: [
                .product(name: "Sparkle", package: "Sparkle"),
                .product(name: "GRPC", package: "grpc-swift"),
                .product(name: "SwiftProtobuf", package: "swift-protobuf"),
            ],
            path: "Sources",
            linkerSettings: [
                .linkedFramework("Carbon"),
            ]
        ),
    ]
)
