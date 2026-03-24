using System.Drawing;

namespace OmniKey.Windows
{
    /// <summary>
    /// OmniKey AI brand colour palette mirroring macOS NordTheme.swift.
    /// Deep navy backgrounds with cyan, blue, and purple accents.
    /// </summary>
    internal static class NordColors
    {
        // ── Dark backgrounds (deep navy) ───────────────────────────────────
        /// <summary>Form / window background. RGB(10, 12, 26) #0A0C1A</summary>
        public static readonly Color WindowBackground  = Color.FromArgb(10, 12, 26);

        /// <summary>Panel / button background. RGB(17, 21, 42) #11152A</summary>
        public static readonly Color PanelBackground   = Color.FromArgb(17, 21, 42);

        /// <summary>Large text-editor / log area background. Solid approx of 90% opacity navy.</summary>
        public static readonly Color EditorBackground  = Color.FromArgb(11, 14, 28);

        /// <summary>Surface — slightly lighter than panel. RGB(22, 28, 54) #161C36</summary>
        public static readonly Color SurfaceBackground = Color.FromArgb(22, 28, 54);

        // ── Border ─────────────────────────────────────────────────────────
        /// <summary>Border colour for inputs, separators. White @ 8% opacity → RGB(38, 42, 64) #262A40</summary>
        public static readonly Color Border            = Color.FromArgb(38, 42, 64);

        // ── Text ───────────────────────────────────────────────────────────
        /// <summary>Primary body text. RGB(226, 232, 240) #E2E8F0</summary>
        public static readonly Color PrimaryText       = Color.FromArgb(226, 232, 240);

        /// <summary>Secondary / caption text. RGB(136, 146, 176) #8892B0</summary>
        public static readonly Color SecondaryText     = Color.FromArgb(136, 146, 176);

        // ── Brand accents ──────────────────────────────────────────────────
        /// <summary>Cyan accent. RGB(34, 211, 238) #22D3EE</summary>
        public static readonly Color AccentCyan        = Color.FromArgb(34, 211, 238);

        /// <summary>Blue accent. RGB(96, 165, 250) #60A5FA</summary>
        public static readonly Color AccentBlue        = Color.FromArgb(96, 165, 250);  // NOTE: see Accent alias below

        /// <summary>Purple accent. RGB(167, 139, 250) #A78BFA</summary>
        public static readonly Color AccentPurple      = Color.FromArgb(167, 139, 250);

        /// <summary>Green accent. RGB(52, 211, 153) #34D399</summary>
        public static readonly Color AccentGreen       = Color.FromArgb(52, 211, 153);

        /// <summary>Amber accent. RGB(251, 191, 36) #FBBF24</summary>
        public static readonly Color AccentAmber       = Color.FromArgb(251, 191, 36);

        /// <summary>Error red. RGB(252, 100, 100) #FC6464</summary>
        public static readonly Color ErrorRed          = Color.FromArgb(252, 100, 100);

        // ── Section fill tints (very subtle backgrounds) ───────────────────
        /// <summary>Blue section fill. RGB(96, 165, 250) @ ~7% — blend: RGB(19, 27, 50)</summary>
        public static readonly Color BlueSectionFill   = Color.FromArgb(19, 27, 50);

        /// <summary>Purple section fill. RGB(167, 139, 250) @ ~7% — blend: RGB(22, 19, 48)</summary>
        public static readonly Color PurpleSectionFill = Color.FromArgb(22, 19, 48);

        /// <summary>Cyan section fill. RGB(34, 211, 238) @ ~7% — blend: RGB(12, 30, 45)</summary>
        public static readonly Color CyanSectionFill   = Color.FromArgb(12, 30, 45);

        /// <summary>Amber section fill. RGB(251, 191, 36) @ ~7% — blend: RGB(30, 25, 13)</summary>
        public static readonly Color AmberSectionFill  = Color.FromArgb(30, 25, 13);

        /// <summary>Red section fill. RGB(252, 100, 100) @ ~7% — blend: RGB(35, 16, 16)</summary>
        public static readonly Color RedSectionFill    = Color.FromArgb(35, 16, 16);

        // ── Section border tints ───────────────────────────────────────────
        /// <summary>Blue section border. RGB(96, 165, 250) @ 25% — RGB(38, 56, 90)</summary>
        public static readonly Color BlueSectionBorder   = Color.FromArgb(38, 56, 90);

        /// <summary>Purple section border. RGB(167, 139, 250) @ 25% — RGB(55, 47, 87)</summary>
        public static readonly Color PurpleSectionBorder = Color.FromArgb(55, 47, 87);

        /// <summary>Cyan section border. RGB(34, 211, 238) @ 25% — RGB(20, 62, 74)</summary>
        public static readonly Color CyanSectionBorder   = Color.FromArgb(20, 62, 74);

        /// <summary>Amber section border. RGB(251, 191, 36) @ 25% — RGB(75, 57, 11)</summary>
        public static readonly Color AmberSectionBorder  = Color.FromArgb(75, 57, 11);

        /// <summary>Red section border. RGB(252, 100, 100) @ 25% — RGB(75, 30, 30)</summary>
        public static readonly Color RedSectionBorder    = Color.FromArgb(75, 30, 30);

        // ── Badge background ───────────────────────────────────────────────
        /// <summary>Badge pill background. White @ ~7% — RGB(34, 38, 62)</summary>
        public static readonly Color BadgeBackground = Color.FromArgb(34, 38, 62);

        // ── Backward-compatibility aliases ─────────────────────────────────
        // These names are used throughout the existing Windows forms code.

        /// <summary>Primary action button colour (AccentBlue value). RGB(96, 165, 250)</summary>
        public static readonly Color Accent        = Color.FromArgb(96, 165, 250);   // = AccentBlue

        /// <summary>Section header tint (AccentCyan value). RGB(34, 211, 238) — mirrors macOS accent dark.</summary>
        // NOTE: Named "AccentBlue" in old code but mapped to cyan in new brand palette.
        // AccentBlue field above holds the true blue (96, 165, 250).
        // Keeping this alias so callers that use NordColors.AccentBlue for section headers
        // get the cyan value as requested by the spec (AccentBlue old → AccentCyan new).
        // Because the field AccentBlue is already defined above, we cannot redefine it here.
        // Instead callers should use AccentCyan for the cyan role and Accent/AccentBlue for blue.

        /// <summary>Success / green status. Equals AccentGreen. RGB(52, 211, 153)</summary>
        public static readonly Color SuccessGreen  = Color.FromArgb(52, 211, 153);  // = AccentGreen

        /// <summary>Terminal-output header amber. Equals AccentAmber. RGB(251, 191, 36)</summary>
        public static readonly Color WarningYellow = Color.FromArgb(251, 191, 36);  // = AccentAmber

        /// <summary>Step labels. RGB(129, 161, 193) — kept for AgentThinkingForm backward compat.</summary>
        public static readonly Color Nord9         = Color.FromArgb(129, 161, 193);
    }
}
