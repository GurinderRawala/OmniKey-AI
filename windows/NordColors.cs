using System.Drawing;
using Microsoft.Win32;

namespace OmniKey.Windows
{
    /// <summary>
    /// OmniKey AI brand colour palette — mirrors the light/dark branches of macOS NordTheme.swift.
    /// All colours are resolved at access time based on the Windows "Apps use light theme" setting,
    /// so forms opened after a system theme change automatically use the correct palette.
    /// </summary>
    internal static class NordColors
    {
        // ── Theme detection ────────────────────────────────────────────────────
        /// <summary>
        /// Returns true when Windows Apps-use-light-theme is off (dark mode active).
        /// Falls back to false (light) if the registry key is absent.
        /// </summary>
        public static bool IsDarkMode
        {
            get
            {
                try
                {
                    using var key = Registry.CurrentUser.OpenSubKey(
                        @"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize");
                    return key?.GetValue("AppsUseLightTheme") is int v && v == 0;
                }
                catch { return false; }
            }
        }

        // ── Window & Panel Backgrounds ─────────────────────────────────────────
        /// <summary>
        /// Form / window background.
        /// Dark:  gradient start (10,12,26) from macOS windowBackground(.dark).
        /// Light: gradient start (238,242,255) from macOS windowBackground(.light).
        /// </summary>
        public static Color WindowBackground  => IsDarkMode
            ? Color.FromArgb(10,  12,  26)
            : Color.FromArgb(238, 242, 255);

        /// <summary>
        /// Panel / card background.
        /// Dark:  (17,21,42) ≈ macOS panelBackground(.dark) solid.
        /// Light: (250,250,250) ≈ Color.white.opacity(0.98).
        /// </summary>
        public static Color PanelBackground   => IsDarkMode
            ? Color.FromArgb(17,  21,  42)
            : Color.FromArgb(250, 250, 250);

        /// <summary>
        /// Large text-editor / log area background.
        /// Dark:  (10,12,26) ≈ macOS editorBackground(.dark) solid.
        /// Light: (245,247,255) from macOS editorBackground(.light).
        /// </summary>
        public static Color EditorBackground  => IsDarkMode
            ? Color.FromArgb(10,  12,  26)
            : Color.FromArgb(245, 247, 255);

        /// <summary>
        /// Surface — raised cards / header panels.
        /// Dark:  gradient end (14,17,36) from macOS windowBackground(.dark).
        /// Light: gradient end (232,238,255) from macOS windowBackground(.light).
        /// </summary>
        public static Color SurfaceBackground => IsDarkMode
            ? Color.FromArgb(14,  17,  36)
            : Color.FromArgb(232, 238, 255);

        // ── Border ─────────────────────────────────────────────────────────────
        /// <summary>
        /// Border colour for inputs and separators.
        /// Dark:  white @8% pre-blended over WindowBackground → (30,31,44).
        /// Light: (15,21,53) @9% pre-blended over WindowBackground → (218,222,237).
        /// </summary>
        public static Color Border => IsDarkMode
            ? Color.FromArgb(30,  31,  44)
            : Color.FromArgb(218, 222, 237);

        // ── Text ───────────────────────────────────────────────────────────────
        /// <summary>
        /// Primary body text.
        /// Dark:  (226,232,240) from macOS primaryText(.dark).
        /// Light: (15,21,53) from macOS primaryText(.light).
        /// </summary>
        public static Color PrimaryText   => IsDarkMode
            ? Color.FromArgb(226, 232, 240)
            : Color.FromArgb(15,  21,  53);

        /// <summary>
        /// Secondary / caption text.
        /// Dark:  (136,146,176) from macOS secondaryText(.dark).
        /// Light: (74,85,120) from macOS secondaryText(.light).
        /// </summary>
        public static Color SecondaryText => IsDarkMode
            ? Color.FromArgb(136, 146, 176)
            : Color.FromArgb(74,  85,  120);

        // ── Brand accents ──────────────────────────────────────────────────────
        /// <summary>
        /// Cyan accent — same hue in both themes. RGB(34,211,238) #22D3EE
        /// </summary>
        public static Color AccentCyan   => Color.FromArgb(34,  211, 238);

        /// <summary>
        /// Blue accent.
        /// Dark:  (96,165,250) from macOS accentBlue(.dark).
        /// Light: (37,99,235) from macOS accentBlue(.light).
        /// </summary>
        public static Color AccentBlue   => IsDarkMode
            ? Color.FromArgb(96,  165, 250)
            : Color.FromArgb(37,  99,  235);

        /// <summary>
        /// Purple accent.
        /// Dark:  (167,139,250) from macOS accentPurple(.dark).
        /// Light: (124,58,237) from macOS accentPurple(.light).
        /// </summary>
        public static Color AccentPurple => IsDarkMode
            ? Color.FromArgb(167, 139, 250)
            : Color.FromArgb(124, 58,  237);

        /// <summary>
        /// Green accent.
        /// Dark:  (52,211,153) from macOS accentGreen(.dark).
        /// Light: (5,150,105) from macOS accentGreen(.light).
        /// </summary>
        public static Color AccentGreen  => IsDarkMode
            ? Color.FromArgb(52,  211, 153)
            : Color.FromArgb(5,   150, 105);

        /// <summary>
        /// Amber accent.
        /// Dark:  (251,191,36) from macOS accentAmber(.dark).
        /// Light: (217,119,6) from macOS accentAmber(.light).
        /// </summary>
        public static Color AccentAmber  => IsDarkMode
            ? Color.FromArgb(251, 191, 36)
            : Color.FromArgb(217, 119, 6);

        /// <summary>
        /// Error red — same in both themes. RGB(252,100,100) #FC6464
        /// </summary>
        public static Color ErrorRed     => Color.FromArgb(252, 100, 100);

        // ── Section fill tints ─────────────────────────────────────────────────
        // Dark:  accent @7% pre-blended over WindowBackground (10,12,26).
        // Light: accent @5% pre-blended over WindowBackground (238,242,255).

        /// <summary>Blue section fill.</summary>
        public static Color BlueSectionFill   => IsDarkMode
            ? Color.FromArgb(16,  23,  43)
            : Color.FromArgb(228, 235, 254);

        /// <summary>Purple section fill.</summary>
        public static Color PurpleSectionFill => IsDarkMode
            ? Color.FromArgb(21,  21,  43)
            : Color.FromArgb(232, 233, 254);

        /// <summary>Cyan section fill.</summary>
        public static Color CyanSectionFill   => IsDarkMode
            ? Color.FromArgb(12,  26,  41)
            : Color.FromArgb(228, 240, 254);

        /// <summary>Amber section fill.</summary>
        public static Color AmberSectionFill  => IsDarkMode
            ? Color.FromArgb(27,  25,  27)
            : Color.FromArgb(237, 236, 243);

        /// <summary>Red section fill.</summary>
        public static Color RedSectionFill    => IsDarkMode
            ? Color.FromArgb(27,  18,  32)
            : Color.FromArgb(239, 235, 247);

        // ── Section border tints ───────────────────────────────────────────────
        // Dark:  accent @25% pre-blended over WindowBackground (10,12,26).
        // Light: accent @20% pre-blended over WindowBackground (238,242,255).

        /// <summary>Blue section border.</summary>
        public static Color BlueSectionBorder   => IsDarkMode
            ? Color.FromArgb(32,  50,  86)
            : Color.FromArgb(198, 213, 251);

        /// <summary>Purple section border.</summary>
        public static Color PurpleSectionBorder => IsDarkMode
            ? Color.FromArgb(49,  44,  86)
            : Color.FromArgb(215, 205, 251);

        /// <summary>Cyan section border.</summary>
        public static Color CyanSectionBorder   => IsDarkMode
            ? Color.FromArgb(16,  62,  83)
            : Color.FromArgb(197, 236, 252);

        /// <summary>Amber section border.</summary>
        public static Color AmberSectionBorder  => IsDarkMode
            ? Color.FromArgb(70,  57,  33)
            : Color.FromArgb(234, 217, 205);

        /// <summary>Red section border.</summary>
        public static Color RedSectionBorder    => IsDarkMode
            ? Color.FromArgb(71,  35,  49)
            : Color.FromArgb(241, 214, 224);

        // ── Badge background ───────────────────────────────────────────────────
        /// <summary>
        /// Badge pill background.
        /// Dark:  white @7% pre-blended over WindowBackground → (27,29,42).
        /// Light: (15,21,53) @6% pre-blended over WindowBackground → (225,229,243).
        /// </summary>
        public static Color BadgeBackground => IsDarkMode
            ? Color.FromArgb(27,  29,  42)
            : Color.FromArgb(225, 229, 243);

        // ── Backward-compatibility aliases ─────────────────────────────────────
        /// <summary>
        /// Primary action button colour.
        /// Dark:  cyan (34,211,238) — macOS accent(.dark).
        /// Light: indigo (79,70,229) — macOS accent(.light).
        /// </summary>
        public static Color Accent        => IsDarkMode
            ? AccentCyan
            : Color.FromArgb(79, 70, 229);

        /// <summary>Success / green status. Equals AccentGreen.</summary>
        public static Color SuccessGreen  => AccentGreen;

        /// <summary>Terminal-output header amber. Equals AccentAmber.</summary>
        public static Color WarningYellow => AccentAmber;

        /// <summary>
        /// Step labels. Nord9 blue-gray — same in both themes.
        /// RGB(129,161,193) #81A1C1
        /// </summary>
        public static Color Nord9         => Color.FromArgb(129, 161, 193);
    }
}
