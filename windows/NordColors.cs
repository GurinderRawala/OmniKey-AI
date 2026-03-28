using System.Drawing;

namespace OmniKey.Windows
{
    /// <summary>
    /// OmniKey AI brand colour palette — light theme, mirroring the light-mode
    /// branches of macOS NordTheme.swift.
    /// Soft lavender-white backgrounds with deep-navy text and saturated accents.
    /// </summary>
    internal static class NordColors
    {
        // ── Light backgrounds ──────────────────────────────────────────────────
        /// <summary>
        /// Form / window background.
        /// macOS: windowBackground(.light) gradient start Color(238,242,255).
        /// Windows uses a solid colour; the gradient start value is chosen as the
        /// representative solid.  RGB(238, 242, 255) #EEF2FF
        /// </summary>
        public static readonly Color WindowBackground  = Color.FromArgb(238, 242, 255);

        /// <summary>
        /// Panel / card background.
        /// macOS: panelBackground(.light) = Color.white.opacity(0.98) ≈ RGB(250,250,250).
        /// RGB(250, 250, 250) #FAFAFA
        /// </summary>
        public static readonly Color PanelBackground   = Color.FromArgb(250, 250, 250);

        /// <summary>
        /// Large text-editor / log area background.
        /// macOS: editorBackground(.light) = Color(245,247,255).
        /// RGB(245, 247, 255) #F5F7FF
        /// </summary>
        public static readonly Color EditorBackground  = Color.FromArgb(245, 247, 255);

        /// <summary>
        /// Surface — slightly bluer than PanelBackground; used for raised cards.
        /// Approximated as the windowBackground gradient end Color(232,238,255).
        /// RGB(232, 238, 255) #E8EEFF
        /// </summary>
        public static readonly Color SurfaceBackground = Color.FromArgb(232, 238, 255);

        // ── Border ────────────────────────────────────────────────────────────
        /// <summary>
        /// Border colour for inputs, separators.
        /// macOS: border(.light) = Color(15,21,53).opacity(0.09) blended over
        /// WindowBackground (238,242,255) → RGB(218, 222, 237) #DADEED
        /// </summary>
        public static readonly Color Border            = Color.FromArgb(218, 222, 237);

        // ── Text ──────────────────────────────────────────────────────────────
        /// <summary>
        /// Primary body text.
        /// macOS: primaryText(.light) = Color(15,21,53).
        /// RGB(15, 21, 53) #0F1535
        /// </summary>
        public static readonly Color PrimaryText       = Color.FromArgb(15, 21, 53);

        /// <summary>
        /// Secondary / caption text.
        /// macOS: secondaryText(.light) = Color(74,85,120).opacity(0.85).
        /// Stored as the solid base colour; the 0.85 opacity is a Swift rendering
        /// artefact that blends against the background at paint time.
        /// RGB(74, 85, 120) #4A5578
        /// </summary>
        public static readonly Color SecondaryText     = Color.FromArgb(74, 85, 120);

        // ── Brand accents (light-theme variants from NordTheme.swift) ─────────
        /// <summary>
        /// Cyan accent — same hue as dark theme; no explicit light override in
        /// NordTheme.swift for "accentCyan", so the brand cyan is kept.
        /// RGB(34, 211, 238) #22D3EE
        /// </summary>
        public static readonly Color AccentCyan        = Color.FromArgb(34, 211, 238);

        /// <summary>
        /// Blue accent.
        /// macOS: accentBlue(.light) = Color(37,99,235).
        /// RGB(37, 99, 235) #2563EB
        /// </summary>
        public static readonly Color AccentBlue        = Color.FromArgb(37, 99, 235);

        /// <summary>
        /// Purple accent.
        /// macOS: accentPurple(.light) = Color(124,58,237).
        /// RGB(124, 58, 237) #7C3AED
        /// </summary>
        public static readonly Color AccentPurple      = Color.FromArgb(124, 58, 237);

        /// <summary>
        /// Green accent.
        /// macOS: accentGreen(.light) = Color(5,150,105).
        /// RGB(5, 150, 105) #059669
        /// </summary>
        public static readonly Color AccentGreen       = Color.FromArgb(5, 150, 105);

        /// <summary>
        /// Amber accent.
        /// macOS: accentAmber(.light) = Color(217,119,6).
        /// RGB(217, 119, 6) #D97706
        /// </summary>
        public static readonly Color AccentAmber       = Color.FromArgb(217, 119, 6);

        /// <summary>
        /// Error red. No light-specific override in NordTheme.swift; the brand red
        /// is retained (visible against the light background).
        /// RGB(252, 100, 100) #FC6464
        /// </summary>
        public static readonly Color ErrorRed          = Color.FromArgb(252, 100, 100);

        // ── Section fill tints ── accent @ 5% opacity over WindowBackground ──
        // Formula: round(accent * 0.05 + WindowBackground * 0.95)
        // per NordTheme.swift sectionFill(accent:scheme:) → opacity 0.05 for light.

        /// <summary>Blue section fill. AccentBlue(37,99,235)@5% → RGB(228, 235, 254)</summary>
        public static readonly Color BlueSectionFill   = Color.FromArgb(228, 235, 254);

        /// <summary>Purple section fill. AccentPurple(124,58,237)@5% → RGB(232, 233, 254)</summary>
        public static readonly Color PurpleSectionFill = Color.FromArgb(232, 233, 254);

        /// <summary>Cyan section fill. AccentCyan(34,211,238)@5% → RGB(228, 240, 254)</summary>
        public static readonly Color CyanSectionFill   = Color.FromArgb(228, 240, 254);

        /// <summary>Amber section fill. AccentAmber(217,119,6)@5% → RGB(237, 236, 243)</summary>
        public static readonly Color AmberSectionFill  = Color.FromArgb(237, 236, 243);

        /// <summary>Red section fill. ErrorRed(252,100,100)@5% → RGB(239, 235, 247)</summary>
        public static readonly Color RedSectionFill    = Color.FromArgb(239, 235, 247);

        // ── Section border tints ── accent @ 20% opacity over WindowBackground ─
        // Formula: round(accent * 0.20 + WindowBackground * 0.80)
        // per NordTheme.swift sectionBorder(accent:scheme:) → opacity 0.20 for light.

        /// <summary>Blue section border. AccentBlue(37,99,235)@20% → RGB(198, 213, 251)</summary>
        public static readonly Color BlueSectionBorder   = Color.FromArgb(198, 213, 251);

        /// <summary>Purple section border. AccentPurple(124,58,237)@20% → RGB(215, 205, 251)</summary>
        public static readonly Color PurpleSectionBorder = Color.FromArgb(215, 205, 251);

        /// <summary>Cyan section border. AccentCyan(34,211,238)@20% → RGB(197, 236, 252)</summary>
        public static readonly Color CyanSectionBorder   = Color.FromArgb(197, 236, 252);

        /// <summary>Amber section border. AccentAmber(217,119,6)@20% → RGB(234, 217, 205)</summary>
        public static readonly Color AmberSectionBorder  = Color.FromArgb(234, 217, 205);

        /// <summary>Red section border. ErrorRed(252,100,100)@20% → RGB(241, 214, 224)</summary>
        public static readonly Color RedSectionBorder    = Color.FromArgb(241, 214, 224);

        // ── Badge background ──────────────────────────────────────────────────
        /// <summary>
        /// Badge pill background.
        /// macOS: badgeFill(.light) = Color(15,21,53).opacity(0.06) blended over
        /// WindowBackground (238,242,255) → RGB(225, 229, 243) #E1E5F3
        /// </summary>
        public static readonly Color BadgeBackground = Color.FromArgb(225, 229, 243);

        // ── Backward-compatibility aliases ────────────────────────────────────
        // These names are used throughout the existing Windows forms code.

        /// <summary>
        /// Primary action button colour.
        /// macOS: accent(.light) = Color(79,70,229) — indigo.
        /// RGB(79, 70, 229) #4F46E5
        /// </summary>
        public static readonly Color Accent        = Color.FromArgb(79, 70, 229);

        /// <summary>Success / green status. Equals AccentGreen. RGB(5, 150, 105)</summary>
        public static readonly Color SuccessGreen  = Color.FromArgb(5, 150, 105);   // = AccentGreen

        /// <summary>Terminal-output header amber. Equals AccentAmber. RGB(217, 119, 6)</summary>
        public static readonly Color WarningYellow = Color.FromArgb(217, 119, 6);   // = AccentAmber

        /// <summary>
        /// Step labels. Nord9 blue-gray — kept for AgentThinkingForm backward compat.
        /// The classic Nord9 value (129,161,193) has sufficient contrast on the light
        /// background; kept as-is.  RGB(129, 161, 193) #81A1C1
        /// </summary>
        public static readonly Color Nord9         = Color.FromArgb(129, 161, 193);
    }
}
