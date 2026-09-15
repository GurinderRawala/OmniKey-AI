// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "OmniKeyAI",
    platforms: [
        .macOS(.v15),
    ],
    products: [
        .executable(name: "OmniKeyAI", targets: ["OmniKeyAI"]),
    ],
    dependencies: [
        // Sparkle framework for macOS app auto-updates
        .package(url: "https://github.com/sparkle-project/Sparkle", from: "2.9.0"),
        // Textual: SwiftUI-native rich markdown renderer with proper
        // cross-block text selection. Used to render the assistant's
        // final answer inside the chat page.
        .package(url: "https://github.com/gonzalezreal/textual", from: "0.5.0"),
        // Native WYSIWYG-style Markdown editing for the chat composer,
        // including rendered GFM tables and fenced code blocks.
        .package(path: "Vendor/MarkdownEngine"),
    ],
    targets: [
        .executableTarget(
            name: "OmniKeyAI",
            dependencies: [
                .product(name: "Sparkle", package: "Sparkle"),
                .product(name: "Textual", package: "textual"),
                .product(name: "MarkdownEngine", package: "MarkdownEngine"),
                .product(name: "MarkdownEngineCodeBlocks", package: "MarkdownEngine"),
            ],
            path: "Sources",
            linkerSettings: [
                .linkedFramework("Carbon"),
                // Add `@executable_path` to the executable's rpath so
                // `@rpath/Sparkle.framework/...` resolves when the
                // binary is run directly from Xcode's Run action.
                //
                // Background: Xcode's SwiftPM integration builds
                // executable targets that depend on binary
                // frameworks (Sparkle) into `Build/Products/Debug/`
                // and drops `Sparkle.framework` in the same folder,
                // but the linker only emits an rpath pointing at
                // `Build/Products/Debug/PackageFrameworks/` — which
                // Xcode never populates for executable targets. The
                // result is a `dyld: Library not loaded:
                // @rpath/Sparkle.framework/...` at launch. Adding
                // `@executable_path` (Sparkle is a sibling of the
                // executable) fixes that scenario without touching
                // the shipped `.app` layout.
                //
                // `@loader_path` is intentionally NOT added here —
                // SwiftPM already emits it automatically, and
                // re-adding it produces a
                // `ld: warning: duplicate -rpath '@loader_path'`.
                .unsafeFlags([
                    "-Xlinker", "-rpath", "-Xlinker", "@executable_path",
                ]),
            ]
        ),
    ]
)
