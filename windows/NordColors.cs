using System.Drawing;

namespace OmniKey.Windows
{
    /// <summary>
    /// Nord colour palette mirroring macOS NordTheme.swift.
    /// Polar Night  : nord0–3  (backgrounds, panels, borders)
    /// Snow Storm   : nord4–6  (text)
    /// Frost        : nord7–10 (accents)
    /// Aurora       : nord11–15 (status colours)
    /// </summary>
    internal static class NordColors
    {
        // ── Polar Night ────────────────────────────────────────────────
        public static readonly Color Nord0 = Color.FromArgb(46, 52, 64);    // window / form background
        public static readonly Color Nord1 = Color.FromArgb(59, 66, 82);    // panel / button background
        public static readonly Color Nord2 = Color.FromArgb(67, 76, 94);    // editor / textarea background, separators
        public static readonly Color Nord3 = Color.FromArgb(76, 86, 106);   // borders, disabled chrome

        // ── Snow Storm ────────────────────────────────────────────────
        public static readonly Color Nord4 = Color.FromArgb(216, 222, 233); // primary text (macOS: primaryText dark)
        public static readonly Color Nord5 = Color.FromArgb(229, 233, 240); // lighter text
        public static readonly Color Nord6 = Color.FromArgb(236, 239, 244); // brightest snow (macOS: primaryText light)

        // ── Frost ─────────────────────────────────────────────────────
        public static readonly Color Nord7  = Color.FromArgb(143, 188, 187); // teal
        public static readonly Color Nord8  = Color.FromArgb(136, 192, 208); // accent in dark mode / section headers
        public static readonly Color Nord9  = Color.FromArgb(129, 161, 193); // step labels
        public static readonly Color Nord10 = Color.FromArgb(94, 129, 172);  // primary action button / accent in light mode

        // ── Aurora ────────────────────────────────────────────────────
        public static readonly Color Nord11 = Color.FromArgb(191, 97, 106);  // red   – error / Cancel button
        public static readonly Color Nord13 = Color.FromArgb(235, 203, 139); // yellow – terminal output header
        public static readonly Color Nord14 = Color.FromArgb(163, 190, 140); // green  – success / Initial input header

        // ── Semantic aliases (map to macOS NordTheme roles) ───────────
        /// <summary>Form / window background (nord0).</summary>
        public static readonly Color WindowBackground = Nord0;

        /// <summary>Panel, button, single-line input background (nord1).</summary>
        public static readonly Color PanelBackground  = Nord1;

        /// <summary>Large text-editor / log area background (nord2). macOS: editorBackground dark.</summary>
        public static readonly Color EditorBackground = Nord2;

        /// <summary>Border colour for inputs, buttons, separators (nord3).</summary>
        public static readonly Color Border           = Nord3;

        /// <summary>Primary body text (nord4). macOS: primaryText dark.</summary>
        public static readonly Color PrimaryText      = Nord4;

        /// <summary>
        /// Secondary / caption text. macOS uses white @ 65% ≈ (166,166,166).
        /// We use a Nord-hued approximation (bluish-grey) that reads well on
        /// the dark polar-night background.
        /// </summary>
        public static readonly Color SecondaryText    = Color.FromArgb(180, 188, 204);

        /// <summary>Primary action button (nord10). macOS: accent light.</summary>
        public static readonly Color Accent           = Nord10;

        /// <summary>Section header tint (nord8). macOS: accent dark / reasoning section.</summary>
        public static readonly Color AccentBlue       = Nord8;

        /// <summary>Success / green status (nord14 – Aurora).</summary>
        public static readonly Color SuccessGreen     = Nord14;

        /// <summary>Error / Cancel red (nord11 – Aurora).</summary>
        public static readonly Color ErrorRed         = Nord11;

        /// <summary>Terminal-output header amber (nord13 – Aurora).</summary>
        public static readonly Color WarningYellow    = Nord13;
    }
}
