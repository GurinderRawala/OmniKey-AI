import AppKit
import SwiftUI
import MarkdownEngine
import MarkdownEngineCodeBlocks

// MARK: - Shared Markdown editor

/// AppKit colors matching the SwiftUI NordTheme values used by sent and
/// received Markdown. Dynamic colors keep the editor in sync with appearance
/// changes without replacing its configuration or text view.
private enum ComposerMarkdownPalette {
    static let primaryText = dynamic(
        light: NSColor(red: 15 / 255, green: 21 / 255, blue: 53 / 255, alpha: 1),
        dark: NSColor(red: 220 / 255, green: 220 / 255, blue: 224 / 255, alpha: 1)
    )
    static let secondaryText = dynamic(
        light: NSColor(red: 74 / 255, green: 85 / 255, blue: 120 / 255, alpha: 0.85),
        dark: NSColor(red: 152 / 255, green: 152 / 255, blue: 157 / 255, alpha: 0.85)
    )
    static let accentBlue = dynamic(
        light: NSColor(red: 47 / 255, green: 110 / 255, blue: 220 / 255, alpha: 1),
        dark: NSColor(red: 108 / 255, green: 168 / 255, blue: 255 / 255, alpha: 1)
    )
    static let codeBackgroundLight = NSColor(
        red: 246 / 255, green: 248 / 255, blue: 252 / 255, alpha: 1)
    static let codeBackgroundDark = NSColor(red: 10 / 255, green: 12 / 255, blue: 22 / 255, alpha: 1)
    static let panelBackground = dynamic(
        light: NSColor.white.withAlphaComponent(0.98),
        dark: NSColor(red: 44 / 255, green: 44 / 255, blue: 46 / 255, alpha: 0.97)
    )
    static let border = dynamic(
        light: NSColor(red: 15 / 255, green: 21 / 255, blue: 53 / 255, alpha: 0.09),
        dark: NSColor.white.withAlphaComponent(0.08)
    )

    private static func dynamic(light: NSColor, dark: NSColor) -> NSColor {
        NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? dark : light
        }
    }
}

/// Shared in-place Markdown editor. Without an onSend callback, Return and
/// arrow keys retain normal document-editing behavior. Chat opts into sending
/// and per-session draft selection tracking.
/// MarkdownEngine hides source markers outside the
/// active construct and renders tables, headings, lists, links, and fenced code
/// blocks directly in the editable surface.
struct MarkdownTextEditor: View {
    @Binding var text: String
    let sessionKey: String
    @Binding var isFocused: Bool
    var colorScheme: ColorScheme
    var editorLabel: String = "Message"
    var onSend: (() -> Void)? = nil
    var onRecallHistory: () -> Bool = { false }

    init(
        text: Binding<String>,
        sessionKey: String,
        isFocused: Binding<Bool> = .constant(false),
        colorScheme: ColorScheme,
        editorLabel: String = "Message",
        onSend: (() -> Void)? = nil,
        onRecallHistory: @escaping () -> Bool = { false }
    ) {
        _text = text
        self.sessionKey = sessionKey
        _isFocused = isFocused
        self.colorScheme = colorScheme
        self.editorLabel = editorLabel
        self.onSend = onSend
        self.onRecallHistory = onRecallHistory
    }

    @StateObject private var draftSelection = ChatDraftSelectionTracker()
    @State private var textView: NSTextView?
    @State private var monitoredTextViewId: ObjectIdentifier?
    @State private var keyMonitor: Any?
    @StateObject private var renderedBlockStyler = ComposerRenderedBlockStyler()

    // HighlighterSwiftBridge owns a JavaScriptCore highlighter, caches, and an
    // appearance observer. Constructing it from `body` recreated all of those
    // resources on every binding update (every keystroke), forcing the editor
    // to repeatedly refresh layout and causing the visible flicker.
    private static let configuration: MarkdownEditorConfiguration = {
        var configuration = MarkdownEditorConfiguration.default
        configuration.theme = MarkdownEditorTheme(
            bodyText: ComposerMarkdownPalette.primaryText,
            mutedText: ComposerMarkdownPalette.secondaryText,
            disabledText: ComposerMarkdownPalette.secondaryText.withAlphaComponent(0.55),
            headingMarker: ComposerMarkdownPalette.secondaryText,
            link: ComposerMarkdownPalette.accentBlue,
            incompleteLink: ComposerMarkdownPalette.accentBlue.withAlphaComponent(0.75),
            strikethroughColor: ComposerMarkdownPalette.primaryText
        )
        configuration.services = MarkdownEditorServices(
            syntaxHighlighter: HighlighterSwiftBridge(
                lightBackground: ComposerMarkdownPalette.codeBackgroundLight,
                darkBackground: ComposerMarkdownPalette.codeBackgroundDark
            )
        )
        configuration.codeBlock = CodeBlockStyle(
            fontSizeScale: 0.98,
            paragraphSpacing: 6,
            horizontalIndent: 12
        )
        // Chat input is literal user intent: do not synthesize a trailing
        // code fence that survives sending or changes the next typed block.
        configuration.lists.autoCloseCodeFencesEnabled = false
        configuration.inlineCode = InlineCodeStyle(fontSizeScale: 0.95)
        configuration.paragraph = ParagraphStyle(
            spacingFactor: 0.22,
            lineHeightExtraSpacing: 4
        )
        configuration.spellChecking = SpellCheckingPolicy(
            continuousSpellChecking: false,
            grammarChecking: false,
            automaticSpellingCorrection: false
        )
        // Configure padding through MarkdownEngine itself. Setting the
        // NSTextView inset imperatively is overwritten by updateNSView, whose
        // default TextInsets are zero, leaving text flush against the card.
        configuration.textInsets = TextInsets(horizontal: 12, vertical: 10)
        return configuration
    }()

    var body: some View {
        NativeTextViewWrapper(
            text: $text,
            configuration: Self.configuration,
            fontSize: ChatComposerMetrics.fontSize,
            documentId: sessionKey,
            isEditable: true
        )
        .background(
            MarkdownEditorIntrospector { resolvedTextView in
                if onSend != nil { draftSelection.attach(resolvedTextView, session: sessionKey) }
                guard textView !== resolvedTextView else { return }
                configure(resolvedTextView)
                renderedBlockStyler.attach(to: resolvedTextView)
                textView = resolvedTextView
                if onSend != nil { installKeyMonitor(for: resolvedTextView) }
            }
        )
        .onChange(of: sessionKey) { _, session in
            if onSend != nil, let textView { draftSelection.attach(textView, session: session) }
        }
        .onChange(of: colorScheme) { _, _ in
            if let textView { configure(textView) }
        }
        .onDisappear {
            removeKeyMonitor()
            draftSelection.detach()
        }
        .accessibilityLabel(editorLabel)
        .accessibilityHint(onSend == nil
            ? "Edit Markdown text. Press Return for a new line."
            : "Type a message. Press Return to send or Shift-Return for a new line.")
    }

    private func configure(_ textView: NSTextView) {
        textView.backgroundColor = .clear
        textView.drawsBackground = false
        textView.insertionPointColor = colorScheme == .dark ? .white : .black
        textView.isAutomaticQuoteSubstitutionEnabled = false
        textView.isAutomaticTextReplacementEnabled = false
        textView.isAutomaticSpellingCorrectionEnabled = false
    }

    private func installKeyMonitor(for textView: NSTextView) {
        let textViewId = ObjectIdentifier(textView)
        guard monitoredTextViewId != textViewId else { return }
        removeKeyMonitor()
        monitoredTextViewId = textViewId
        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
            guard event.window === textView.window,
                textView.window?.firstResponder === textView
            else { return event }
            isFocused = true

            if let onSend, event.keyCode == 36 || event.keyCode == 76 {
                if event.modifierFlags.contains(.shift) { return event }
                DispatchQueue.main.async { onSend() }
                return nil
            }

            if onSend != nil, event.keyCode == 126, textView.string.isEmpty, onRecallHistory() {
                DispatchQueue.main.async {
                    textView.setSelectedRange(
                        NSRange(location: (textView.string as NSString).length, length: 0))
                }
                return nil
            }
            return event
        }
    }

    private func removeKeyMonitor() {
        if let keyMonitor { NSEvent.removeMonitor(keyMonitor) }
        keyMonitor = nil
        monitoredTextViewId = nil
    }
}

/// MarkdownEngine rasterizes inactive tables into attributed-string images.
/// Its table renderer currently draws square outer corners, so finish those
/// images with the same 8-point continuous corner treatment as
/// `MarkdownTableView` in sent and received messages.
@MainActor
private final class ComposerRenderedBlockStyler: ObservableObject {
    private static let renderedImageKey = NSAttributedString.Key("LatexRenderedImage")
    private weak var storage: NSTextStorage?
    private nonisolated(unsafe) var observer: NSObjectProtocol?
    private var isApplyingStyle = false
    private let cache = NSCache<NSImage, NSImage>()
    private var styledImageIds: Set<ObjectIdentifier> = []

    func attach(to textView: NSTextView) {
        guard storage !== textView.textStorage, let textStorage = textView.textStorage else { return }
        detach()
        storage = textStorage
        observer = NotificationCenter.default.addObserver(
            forName: NSTextStorage.didProcessEditingNotification,
            object: textStorage,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.roundRenderedTables() }
        }
        roundRenderedTables()
    }

    deinit {
        if let observer { NotificationCenter.default.removeObserver(observer) }
    }

    private func detach() {
        if let observer { NotificationCenter.default.removeObserver(observer) }
        observer = nil
        storage = nil
    }

    private func roundRenderedTables() {
        guard !isApplyingStyle, let storage, storage.length > 0 else { return }
        let fullRange = NSRange(location: 0, length: storage.length)
        var replacements: [(NSRange, NSImage)] = []

        storage.enumerateAttribute(Self.renderedImageKey, in: fullRange) { value, range, _ in
            guard let image = value as? NSImage,
                !self.styledImageIds.contains(ObjectIdentifier(image)),
                self.isMarkdownTable(around: range, in: storage.string)
            else { return }
            if let cached = self.cache.object(forKey: image) {
                replacements.append((range, cached))
            } else if let rounded = self.roundedImage(image) {
                self.cache.setObject(rounded, forKey: image)
                self.styledImageIds.insert(ObjectIdentifier(rounded))
                replacements.append((range, rounded))
            }
        }

        guard !replacements.isEmpty else { return }
        isApplyingStyle = true
        storage.beginEditing()
        for (range, image) in replacements {
            storage.addAttribute(Self.renderedImageKey, value: image, range: range)
        }
        storage.endEditing()
        isApplyingStyle = false
    }

    private func isMarkdownTable(around range: NSRange, in text: String) -> Bool {
        let nsText = text as NSString
        let lineRange = nsText.lineRange(for: range)
        let sample = nsText.substring(with: lineRange)
        return sample.contains("|")
    }

    private func roundedImage(_ image: NSImage) -> NSImage? {
        guard image.size.width > 0, image.size.height > 0 else { return nil }
        let size = image.size
        return NSImage(size: size, flipped: false) { rect in
            NSGraphicsContext.current?.imageInterpolation = .high
            let shape = NSBezierPath(roundedRect: rect.insetBy(dx: 0.5, dy: 0.5), xRadius: 8, yRadius: 8)
            ComposerMarkdownPalette.panelBackground.setFill()
            shape.fill()

            NSGraphicsContext.saveGraphicsState()
            shape.addClip()
            image.draw(in: rect, from: .zero, operation: .sourceOver, fraction: 1)
            NSGraphicsContext.restoreGraphicsState()

            ComposerMarkdownPalette.border.setStroke()
            shape.lineWidth = 1
            shape.stroke()
            return true
        }
    }
}

/// Locates MarkdownEngine's internal NSTextView without depending on its
/// private implementation types.
struct MarkdownEditorIntrospector: NSViewRepresentable {
    let onResolve: (NSTextView) -> Void

    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        DispatchQueue.main.async { resolve(from: view) }
        return view
    }

    func updateNSView(_ view: NSView, context: Context) {
        DispatchQueue.main.async { resolve(from: view) }
    }

    private func resolve(from view: NSView) {
        var ancestor = view.superview
        while let current = ancestor {
            if let textView = findTextView(in: current) {
                onResolve(textView)
                return
            }
            ancestor = current.superview
        }
    }

    func findTextView(in view: NSView) -> NSTextView? {
        if let textView = view as? NSTextView {
            return textView.isFieldEditor ? nil : textView
        }
        for child in view.subviews {
            if let textView = findTextView(in: child) { return textView }
        }
        return nil
    }
}
