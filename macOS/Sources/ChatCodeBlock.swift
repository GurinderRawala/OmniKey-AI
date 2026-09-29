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
        Button(action: performCopy) {
            Image(systemName: copied ? "checkmark" : "doc.on.doc")
                .font(.system(size: 10.5, weight: .semibold))
                .contentTransition(.symbolEffect(.replace))
                .foregroundColor(
                    copied
                        ? NordTheme.accentGreen(colorScheme)
                        : NordTheme.secondaryText(colorScheme).opacity(hovered ? 1.0 : 0.7)
                )
                .frame(width: 22, height: 20)
                .background(
                    RoundedRectangle(cornerRadius: 5, style: .continuous)
                        .fill(hovered && !copied ? NordTheme.badgeFill(colorScheme) : Color.clear)
                )
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
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

// MARK: - Container

/// Shared chrome for rendered code blocks: a header strip carrying the
/// language label and the copy button, a hairline separator, and the
/// rounded surface that clips the horizontally scrollable body.
///
/// The stack is clipped to the rounded shape *before* the background
/// and border are drawn so the header's rectangular fill and the
/// separator cannot bleed into the carved-out corners.
struct ChatCodeBlockContainer<Content: View>: View {
    let languageLabel: String
    let copy: () -> Void
    /// Set when hosted inside Textual's `StructuredText`. Textual lays a
    /// text-selection view over the whole document that swallows every
    /// click except inside `Overflow` regions, so the header (and its
    /// copy button) must live in one to stay clickable.
    var hostedInStructuredText = false
    @ViewBuilder var content: Content

    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if hostedInStructuredText {
                // Sized to the scroll container so it never actually
                // scrolls; the `Overflow` only exists to exclude the
                // header from Textual's selection hit-testing.
                //
                // `Overflow` also installs its own selection overlay for
                // any selectable text inside it, which would swallow the
                // click again — so selection is disabled for the header.
                Overflow { state in
                    header.frame(width: state.containerWidth)
                }
                .scrollDisabled(true)
                .textual.textSelection(.disabled)
            } else {
                header
            }

            Rectangle()
                .fill(NordTheme.border(colorScheme))
                .frame(height: 1)

            content
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        .background(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(ChatCodeBlockPalette.surface(colorScheme))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .strokeBorder(NordTheme.border(colorScheme), lineWidth: 1)
        )
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var header: some View {
        HStack(spacing: 8) {
            Text(languageLabel)
                .font(OKFont.eyebrow)
                .foregroundColor(NordTheme.secondaryText(colorScheme))
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer(minLength: 8)
            CodeBlockCopyButton(copy: copy)
        }
        .padding(.leading, 12)
        .padding(.trailing, 6)
        .padding(.vertical, 5)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(NordTheme.badgeFill(colorScheme))
    }
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
    func makeBody(configuration: Configuration) -> some View {
        ChatCodeBlockContainer(
            languageLabel: CodeBlockLanguageLabel.display(for: configuration.languageHint),
            copy: { configuration.codeBlock.copyToPasteboard() },
            hostedInStructuredText: true
        ) {
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
        .textual.blockSpacing(.init(top: 4, bottom: 14))
    }
}

extension StructuredText.CodeBlockStyle where Self == ChatStructuredCodeBlockStyle {
    static var chat: Self { .init() }
}

extension View {
    /// The `.gitHub` preset with the app's code-block chrome.
    ///
    /// Order matters: both modifiers write the same environment key and
    /// SwiftUI resolves the innermost value, so `.codeBlockStyle(.chat)`
    /// has to be applied *before* (inside) `.structuredTextStyle(.gitHub)`
    /// or the preset's bare code slab silently wins.
    func chatStructuredTextStyle() -> some View {
        self
            .textual.codeBlockStyle(.chat)
            .textual.structuredTextStyle(.gitHub)
    }
}
