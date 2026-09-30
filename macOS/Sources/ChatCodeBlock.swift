import AppKit
import SwiftUI
import Textual

// MARK: - Language Label

/// Normalises a fenced code block's info string into a short, lowercase
/// display label for the code-block header.
///
/// Markdown info strings are free-form: they can carry attributes
/// (```` ```swift title="Foo.swift" ````), be empty, or use an alias
/// (`js`, `sh`, `yml`). Only the leading token identifies the language,
/// so everything after the first separator is dropped and a small alias
/// table maps the common short forms onto their canonical names.
enum CodeBlockLanguageLabel {
    static let fallback = "code"

    private static let aliases: [String: String] = [
        "sh": "shell",
        "zsh": "shell",
        "bash": "bash",
        "js": "javascript",
        "jsx": "javascript",
        "ts": "typescript",
        "tsx": "typescript",
        "py": "python",
        "rb": "ruby",
        "yml": "yaml",
        "md": "markdown",
        "objc": "objective-c",
        "cs": "c#",
        "kt": "kotlin",
        "rs": "rust",
        "ps1": "powershell",
        "plaintext": fallback,
        "text": fallback,
        "txt": fallback,
    ]

    static func display(for hint: String?) -> String {
        let raw = (hint ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !raw.isEmpty else { return fallback }
        let separators = CharacterSet(charactersIn: " \t,;:{}")
        let token = raw.components(separatedBy: separators).first(where: { !$0.isEmpty }) ?? raw
        guard !token.isEmpty else { return fallback }
        return aliases[token] ?? token
    }
}

// MARK: - Copy Button

/// Icon-only copy affordance used in the code-block header.
///
/// The glyph animates from `doc.on.doc` to `checkmark` on success and
/// reverts after a short delay. The pending revert is held in a
/// cancellable `Task` so rapid consecutive clicks restart the window
/// instead of stacking timers, and so the animation never fires after
/// the view has gone away.
struct CodeBlockCopyButton: View {
    /// Performs the actual pasteboard write. Kept as a closure so both
    /// the SwiftUI renderer (plain `String`) and the Textual renderer
    /// (`CodeBlockProxy`, which also writes an HTML flavour) can share
    /// this control.
    let copy: () -> Void

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var copied = false
    @State private var hovered = false
    @State private var resetTask: Task<Void, Never>?

    private static let confirmationDuration: Duration = .milliseconds(1600)

    var body: some View {
        NativeCodeBlockCopyButton(
            copied: copied,
            tint: NSColor(copied
                ? NordTheme.accentGreen(colorScheme)
                : NordTheme.secondaryText(colorScheme).opacity(hovered ? 1 : 0.7)),
            action: performCopy
        )
        .frame(width: 22, height: 20)
        .background(
            RoundedRectangle(cornerRadius: 5, style: .continuous)
                .fill(hovered && !copied ? NordTheme.badgeFill(colorScheme) : Color.clear)
        )
        .onHover { hovered = $0 }
        .animation(motion, value: copied)
        .animation(motion, value: hovered)
        .help(copied ? "Copied" : "Copy code")
        .accessibilityLabel(copied ? "Code copied" : "Copy code")
        .onDisappear {
            // Cancelling the pending revert must also clear the
            // confirmation, otherwise a block that disappears during
            // the 1.6s window (transcript scrolling, collapsing the
            // execution history) keeps a stale checkmark if SwiftUI
            // preserves this `@State` and reuses the view.
            resetTask?.cancel()
            resetTask = nil
            copied = false
        }
    }

    private var motion: Animation? {
        AgentTimelineMotionPolicy.shouldAnimate(reduceMotion: reduceMotion)
            ? .easeInOut(duration: 0.16)
            : nil
    }

    private func performCopy() {
        copy()
        copied = true
        resetTask?.cancel()
        resetTask = Task { @MainActor in
            try? await Task.sleep(for: Self.confirmationDuration)
            guard !Task.isCancelled else { return }
            copied = false
            resetTask = nil
        }
    }
}

/// Keep pointer, keyboard, and accessibility activation on the same native
/// control. Textual controls are placed above its selection overlay below.
private struct NativeCodeBlockCopyButton: NSViewRepresentable {
    let copied: Bool
    let tint: NSColor
    let action: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(action: action) }

    func makeNSView(context: Context) -> NSButton {
        let button = NSButton()
        button.isBordered = false
        button.setButtonType(.momentaryChange)
        button.imagePosition = .imageOnly
        button.controlSize = .small
        button.target = context.coordinator
        button.action = #selector(Coordinator.copyCode)
        button.setAccessibilityIdentifier("chat-code-block-copy")
        return button
    }

    func updateNSView(_ button: NSButton, context: Context) {
        context.coordinator.action = action
        button.isEnabled = context.environment.isEnabled
        button.image = NSImage(systemSymbolName: copied ? "checkmark" : "doc.on.doc", accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: 10.5, weight: .semibold))
        button.contentTintColor = tint
        button.toolTip = copied ? "Copied" : "Copy code"
        button.setAccessibilityLabel(copied ? "Code copied" : "Copy code")
    }

    func sizeThatFits(_ proposal: ProposedViewSize, nsView: NSButton, context: Context) -> CGSize? {
        CGSize(width: 22, height: 20)
    }

    final class Coordinator: NSObject {
        var action: () -> Void
        init(action: @escaping () -> Void) { self.action = action }
        @objc func copyCode() { action() }
    }
}

// MARK: - Container

/// Shared chrome for code blocks rendered outside Textual, such as user
/// messages. Textual uses the same header and surface, but publishes a
/// copy-button anchor so its control can sit above document text selection.
///
/// The stack is clipped to the rounded shape *before* the background
/// and border are drawn so the header's rectangular fill and the
/// separator cannot bleed into the carved-out corners.
struct ChatCodeBlockContainer<Content: View>: View {
    let languageLabel: String
    let copy: () -> Void
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ChatCodeBlockHeader(languageLabel: languageLabel, copy: copy)
            ChatCodeBlockDivider()

            content
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .modifier(ChatCodeBlockSurface())
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct ChatCodeBlockHeader: View {
    let languageLabel: String
    let copy: () -> Void
    var overlaysCopyControl = false

    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        HStack(spacing: 8) {
            Text(languageLabel)
                .font(OKFont.eyebrow)
                .foregroundColor(NordTheme.secondaryText(colorScheme))
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer(minLength: 8)
            if overlaysCopyControl {
                Color.clear
                    .frame(width: 22, height: 20)
                    .anchorPreference(key: CodeBlockCopyAnchorKey.self, value: .bounds) {
                        [CodeBlockCopyAnchor(bounds: $0, copy: copy)]
                    }
            } else {
                CodeBlockCopyButton(copy: copy)
            }
        }
        .padding(.leading, 12)
        .padding(.trailing, 6)
        .frame(maxWidth: .infinity, minHeight: ChatCodeBlockMetrics.headerHeight, alignment: .leading)
        .background(NordTheme.badgeFill(colorScheme))
    }
}

private struct ChatCodeBlockDivider: View {
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        Rectangle()
            .fill(NordTheme.border(colorScheme))
            .frame(height: ChatCodeBlockMetrics.dividerHeight)
    }
}

private struct ChatCodeBlockSurface: ViewModifier {
    @Environment(\.colorScheme) private var colorScheme

    func body(content: Content) -> some View {
        content
            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            .background(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(ChatCodeBlockPalette.surface(colorScheme))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .strokeBorder(NordTheme.border(colorScheme), lineWidth: 1)
            )
    }
}

private enum ChatCodeBlockMetrics {
    static let headerHeight: CGFloat = 30
    static let dividerHeight: CGFloat = 1
}

/// Single place where code-block copy actions touch the pasteboard, so
/// the plain-text write stays identical across renderers and is
/// verifiable without driving the SwiftUI button.
enum ChatCodeBlockPasteboard {
    static func write(_ code: String, to pasteboard: NSPasteboard = .general) {
        pasteboard.clearContents()
        pasteboard.setString(code, forType: .string)
    }
}

private struct ChatCodeBlockPasteboardNameKey: EnvironmentKey {
    static let defaultValue = NSPasteboard.Name.general
}

extension EnvironmentValues {
    var chatCodeBlockPasteboardName: NSPasteboard.Name {
        get { self[ChatCodeBlockPasteboardNameKey.self] }
        set { self[ChatCodeBlockPasteboardNameKey.self] = newValue }
    }
}

extension View {
    /// Redirects plain-text code-block copies to a named pasteboard.
    /// Production uses the general pasteboard; tests provide a private name
    /// so click simulation never clears or reads the user's clipboard.
    func chatCodeBlockPasteboard(_ name: NSPasteboard.Name) -> some View {
        environment(\.chatCodeBlockPasteboardName, name)
    }
}

enum ChatCodeBlockPalette {
    /// Deep, low-chroma surface shared by every code block so the
    /// SwiftUI and Textual renderers stay visually identical.
    static func surface(_ scheme: ColorScheme) -> Color {
        scheme == .dark
            ? Color(red: 10 / 255, green: 12 / 255, blue: 22 / 255)
            : Color(red: 246 / 255, green: 248 / 255, blue: 252 / 255)
    }
}

// MARK: - Textual Style

/// Code block style for Textual's `StructuredText`, used by the
/// assistant's final answer.
///
/// Textual's bundled `.gitHub` style renders a bare scrollable slab with
/// no language label and no copy affordance. This style keeps Textual's
/// syntax highlighting and — critically — its `Overflow` container
/// (a plain horizontal `ScrollView` would swallow the cross-block text
/// selection gestures) while wrapping it in the same chrome the SwiftUI
/// renderer uses.
struct ChatStructuredCodeBlockStyle: StructuredText.CodeBlockStyle {
    var copy: ((StructuredText.CodeBlockProxy) -> Void)?

    init(copy: ((StructuredText.CodeBlockProxy) -> Void)? = nil) {
        self.copy = copy
    }

    func makeBody(configuration: Configuration) -> some View {
        // Overflow is Textual's supported horizontal-scroll container. The
        // header has its own fixed-width region so scrolling code cannot move
        // the copy anchor. The actual control is outside StructuredText's
        // selection/hover overlay, not merely inside its exclusion rectangle.
        VStack(spacing: 0) {
            Overflow { state in
                ChatCodeBlockHeader(
                    languageLabel: CodeBlockLanguageLabel.display(for: configuration.languageHint),
                    copy: {
                        if let copy {
                            copy(configuration.codeBlock)
                        } else {
                            configuration.codeBlock.copyToPasteboard()
                        }
                    },
                    overlaysCopyControl: true
                )
                .frame(width: state.containerWidth)
            }
            .scrollDisabled(true)
            .textual.textSelection(.disabled)
            ChatCodeBlockDivider()
            Overflow {
                configuration.label
                    .textual.lineSpacing(.fontScaled(0.225))
                    .textual.fontScale(0.85)
                    .fixedSize(horizontal: false, vertical: true)
                    .monospaced()
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)
            }
        }
        .modifier(ChatCodeBlockSurface())
        .textual.blockSpacing(.init(top: 4, bottom: 14))
    }
}

extension StructuredText.CodeBlockStyle where Self == ChatStructuredCodeBlockStyle {
    static var chat: Self { .init() }
}

private struct CodeBlockCopyAnchor {
    let bounds: Anchor<CGRect>
    let copy: () -> Void
}

private enum CodeBlockCopyAnchorKey: PreferenceKey {
    static var defaultValue: [CodeBlockCopyAnchor] { [] }

    static func reduce(value: inout [CodeBlockCopyAnchor], nextValue: () -> [CodeBlockCopyAnchor]) {
        value.append(contentsOf: nextValue())
    }
}

extension View {
    /// The `.gitHub` preset with the app's code-block chrome.
    ///
    /// Order matters: both modifiers write the same environment key and
    /// SwiftUI resolves the innermost value, so `.codeBlockStyle(.chat)`
    /// has to be applied *before* (inside) `.structuredTextStyle(.gitHub)`
    /// or the preset's bare code slab silently wins.
    func chatStructuredTextStyle(
        copyCodeBlock: ((StructuredText.CodeBlockProxy) -> Void)? = nil
    ) -> some View {
        self
            .textual.codeBlockStyle(ChatStructuredCodeBlockStyle(copy: copyCodeBlock))
            .textual.structuredTextStyle(.gitHub)
            // Textual's native selection view excludes Overflow rectangles,
            // but its enclosing SwiftUI hover layer can still intercept clicks
            // on controls inside those regions in a running app. Anchor the
            // controls here, above the entire renderer, without disabling
            // selection for prose or code. Each closure retains its own proxy.
            .overlayPreferenceValue(CodeBlockCopyAnchorKey.self) { controls in
                GeometryReader { geometry in
                    ForEach(Array(controls.enumerated()), id: \.offset) { _, control in
                        let rect = geometry[control.bounds]
                        CodeBlockCopyButton(copy: control.copy)
                            .frame(width: rect.width, height: rect.height)
                            .position(x: rect.midX, y: rect.midY)
                    }
                }
            }
    }
}
