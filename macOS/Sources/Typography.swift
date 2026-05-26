import SwiftUI

/// Centralised typography for OmniKey-AI.
///
/// We deliberately stay on the system stack so the app stays in step
/// with macOS UI defaults and the user's Dynamic Type / accessibility
/// preferences, but we route every call site through `OKFont` so the
/// hierarchy is consistent across views.
///
/// Two design families are used:
///
/// - `.default` — SF Pro Text / SF Pro Display (system rounded sans for
///   product chrome and prose). On macOS this is the cleanest, most
///   professional typeface available without bundling a custom font.
/// - `.monospaced` — SF Mono for code, identifiers and metric values
///   (token counts, durations, etc.).
///
/// All sizes are expressed in points and roughly one step apart so the
/// scale composes well at the standard window sizes used by the chat
/// view (880×600 minimum).
enum OKFont {

    // MARK: - Display & Title (used sparingly)

    /// Large landing headline — e.g. "What should we build?".
    static var display: Font {
        .system(size: 26, weight: .semibold, design: .default)
    }

    /// Page / window title.
    static var title: Font {
        .system(size: 19, weight: .semibold, design: .default)
    }

    /// Header bar / section titles.
    static var headline: Font {
        .system(size: 14, weight: .semibold, design: .default)
    }

    // MARK: - Body Text

    /// Default conversation prose size. Trimmed a step relative to
    /// the original spec so prose feels lighter at the centred reading
    /// column without losing legibility.
    static var body: Font {
        .system(size: 13, weight: .regular, design: .default)
    }

    /// Slightly tighter body used inside dense UI chrome (sidebar rows,
    /// input composer, etc.).
    static var bodyCompact: Font {
        .system(size: 12, weight: .regular, design: .default)
    }

    /// Emphasised body — semibold weight, same size as `.body`.
    static var bodyEmphasized: Font {
        .system(size: 13, weight: .semibold, design: .default)
    }

    // MARK: - Secondary / Metadata

    /// Secondary labels, timestamps, captions.
    static var caption: Font {
        .system(size: 12, weight: .regular, design: .default)
    }

    /// Smallest legible label — used for badge counts and tiny chips.
    /// Anything below 10pt becomes hard to read on Retina + dim modes.
    static var captionSmall: Font {
        .system(size: 11, weight: .medium, design: .default)
    }

    /// Uppercase eyebrow used to label sections (e.g. "PROJECTS").
    static var eyebrow: Font {
        .system(size: 10, weight: .semibold, design: .default)
    }

    // MARK: - Monospaced

    /// Inline code / identifiers.
    static var monoInline: Font {
        .system(size: 12.5, weight: .regular, design: .monospaced)
    }

    /// Fenced code block body.
    static var monoBlock: Font {
        .system(size: 12.5, weight: .regular, design: .monospaced)
    }

    /// Tiny monospaced label — e.g. token counters.
    static var monoCaption: Font {
        .system(size: 10.5, weight: .medium, design: .monospaced)
    }

    // MARK: - Generic builder

    /// Escape hatch for one-off sizes that should still flow through
    /// the same design family.
    static func custom(_ size: CGFloat, weight: Font.Weight = .regular, monospaced: Bool = false) -> Font {
        .system(size: size, weight: weight, design: monospaced ? .monospaced : .default)
    }
}

extension View {
    /// Tightens letter-spacing slightly to give SF Pro a more polished,
    /// "designed" feel in headings and bold callouts. Call sites that
    /// want default tracking simply omit this modifier.
    func okTighten(_ amount: CGFloat = -0.2) -> some View {
        self.tracking(amount)
    }
}
