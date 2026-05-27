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
        /// Dark:  gradient start (28,28,30) from macOS windowBackground(.dark).
        /// Light: gradient start (238,242,255) from macOS windowBackground(.light).
        /// </summary>
        public static Color WindowBackground  => IsDarkMode
            ? Color.FromArgb(28,  28,  30)
            : Color.FromArgb(238, 242, 255);

        /// <summary>
        /// Panel / card background.
        /// Dark:  (44,44,46) ≈ macOS panelBackground(.dark) solid.
        /// Light: (250,250,250) ≈ Color.white.opacity(0.98).
        /// </summary>
        public static Color PanelBackground   => IsDarkMode
            ? Color.FromArgb(44,  44,  46)
            : Color.FromArgb(250, 250, 250);

        /// <summary>
        /// Large text-editor / log area background.
        /// Dark:  (30,30,32) ≈ macOS editorBackground(.dark) solid.
        /// Light: (245,247,255) from macOS editorBackground(.light).
        /// </summary>
        public static Color EditorBackground  => IsDarkMode
            ? Color.FromArgb(30,  30,  32)
            : Color.FromArgb(245, 247, 255);

        /// <summary>
        /// Surface — raised cards / header panels.
        /// Dark:  gradient end (38,38,40) from macOS windowBackground(.dark).
        /// Light: gradient end (232,238,255) from macOS windowBackground(.light).
        /// </summary>
        public static Color SurfaceBackground => IsDarkMode
            ? Color.FromArgb(38,  38,  40)
            : Color.FromArgb(232, 238, 255);

        // ── Border ─────────────────────────────────────────────────────────────
        /// <summary>
        /// Border colour for inputs and separators.
        /// Dark:  white @8% pre-blended over WindowBackground (28,28,30) → (46,46,48).
        /// Light: (15,21,53) @9% pre-blended over WindowBackground (238,242,255) → (218,222,237).
        /// </summary>
        public static Color Border => IsDarkMode
            ? Color.FromArgb(46,  46,  48)
            : Color.FromArgb(218, 222, 237);

        // ── Text ───────────────────────────────────────────────────────────────
        /// <summary>
        /// Primary body text.
        /// Dark:  (220,220,224) from macOS primaryText(.dark).
        /// Light: (15,21,53) from macOS primaryText(.light).
        /// </summary>
        public static Color PrimaryText   => IsDarkMode
            ? Color.FromArgb(220, 220, 224)
            : Color.FromArgb(15,  21,  53);

        /// <summary>
        /// Secondary / caption text.
        /// Dark:  (152,152,157) from macOS secondaryText(.dark).
        /// Light: (74,85,120) from macOS secondaryText(.light).
        /// </summary>
        public static Color SecondaryText => IsDarkMode
            ? Color.FromArgb(152, 152, 157)
            : Color.FromArgb(74,  85,  120);

        // ── Brand accents ──────────────────────────────────────────────────────
        /// <summary>
        /// Cyan accent — same hue in both themes. RGB(34,211,238) #22D3EE
        /// </summary>
        public static Color AccentCyan   => Color.FromArgb(34,  211, 238);

        /// <summary>
        /// Blue accent.
        /// Dark:  (94,140,210) from macOS accentBlue(.dark).
        /// Light: (37,99,235) from macOS accentBlue(.light).
        /// </summary>
        public static Color AccentBlue   => IsDarkMode
            ? Color.FromArgb(94,  140, 210)
            : Color.FromArgb(37,  99,  235);

        /// <summary>
        /// Purple accent.
        /// Dark:  (170,140,220) from macOS accentPurple(.dark).
        /// Light: (124,58,237) from macOS accentPurple(.light).
        /// </summary>
        public static Color AccentPurple => IsDarkMode
            ? Color.FromArgb(170, 140, 220)
            : Color.FromArgb(124, 58,  237);

        /// <summary>
        /// Green accent.
        /// Dark:  (110,200,140) from macOS accentGreen(.dark).
        /// Light: (5,150,105) from macOS accentGreen(.light).
        /// </summary>
        public static Color AccentGreen  => IsDarkMode
            ? Color.FromArgb(110, 200, 140)
            : Color.FromArgb(5,   150, 105);

        /// <summary>
        /// Amber accent.
        /// Dark:  (230,200,110) from macOS accentAmber(.dark).
        /// Light: (217,119,6) from macOS accentAmber(.light).
        /// </summary>
        public static Color AccentAmber  => IsDarkMode
            ? Color.FromArgb(230, 200, 110)
            : Color.FromArgb(217, 119, 6);

        /// <summary>
        /// Error red — same in both themes. RGB(252,100,100) #FC6464
        /// </summary>
        public static Color ErrorRed     => Color.FromArgb(252, 100, 100);

        // ── Section fill tints ─────────────────────────────────────────────────
        // Dark:  accent @7% pre-blended over WindowBackground (28,28,30).
        // Light: accent @5% pre-blended over WindowBackground (238,242,255).

        /// <summary>Blue section fill — AccentBlue tint.</summary>
        public static Color BlueSectionFill   => IsDarkMode
            ? Color.FromArgb(34,  36,  43)
            : Color.FromArgb(228, 235, 254);

        /// <summary>Purple section fill — AccentPurple tint.</summary>
        public static Color PurpleSectionFill => IsDarkMode
            ? Color.FromArgb(38,  36,  43)
            : Color.FromArgb(232, 233, 254);

        /// <summary>Cyan section fill — AccentCyan tint.</summary>
        public static Color CyanSectionFill   => IsDarkMode
            ? Color.FromArgb(28,  41,  45)
            : Color.FromArgb(228, 240, 254);

        /// <summary>Amber section fill — AccentAmber tint.</summary>
        public static Color AmberSectionFill  => IsDarkMode
            ? Color.FromArgb(42,  40,  36)
            : Color.FromArgb(237, 236, 243);

        /// <summary>Red section fill — ErrorRed tint.</summary>
        public static Color RedSectionFill    => IsDarkMode
            ? Color.FromArgb(44,  33,  35)
            : Color.FromArgb(239, 235, 247);

        /// <summary>Green section fill — AccentGreen tint (MCP tool calls).</summary>
        public static Color GreenSectionFill  => IsDarkMode
            ? Color.FromArgb(34,  40,  38)
            : Color.FromArgb(226, 237, 248);

        // ── Section border tints ───────────────────────────────────────────────
        // Dark:  accent @25% pre-blended over WindowBackground (28,28,30).
        // Light: accent @20% pre-blended over WindowBackground (238,242,255).

        /// <summary>Blue section border — AccentBlue tint.</summary>
        public static Color BlueSectionBorder   => IsDarkMode
            ? Color.FromArgb(45,  56,  75)
            : Color.FromArgb(198, 213, 251);

        /// <summary>Purple section border — AccentPurple tint.</summary>
        public static Color PurpleSectionBorder => IsDarkMode
            ? Color.FromArgb(64,  56,  78)
            : Color.FromArgb(215, 205, 251);

        /// <summary>Cyan section border — AccentCyan tint.</summary>
        public static Color CyanSectionBorder   => IsDarkMode
            ? Color.FromArgb(30,  74,  82)
            : Color.FromArgb(197, 236, 252);

        /// <summary>Amber section border — AccentAmber tint.</summary>
        public static Color AmberSectionBorder  => IsDarkMode
            ? Color.FromArgb(79,  71,  50)
            : Color.FromArgb(234, 217, 205);

        /// <summary>Red section border — ErrorRed tint.</summary>
        public static Color RedSectionBorder    => IsDarkMode
            ? Color.FromArgb(84,  46,  48)
            : Color.FromArgb(241, 214, 224);

        /// <summary>Green section border — AccentGreen tint (MCP tool calls).</summary>
        public static Color GreenSectionBorder  => IsDarkMode
            ? Color.FromArgb(49,  71,  58)
            : Color.FromArgb(191, 224, 225);

        // ── Badge background ───────────────────────────────────────────────────
        /// <summary>
        /// Badge pill background.
        /// Dark:  white @7% pre-blended over WindowBackground (28,28,30) → (44,44,46).
        /// Light: (15,21,53) @6% pre-blended over WindowBackground (238,242,255) → (226,231,243).
        /// </summary>
        public static Color BadgeBackground => IsDarkMode
            ? Color.FromArgb(44,  44,  46)
            : Color.FromArgb(226, 231, 243);

        // ── Backward-compatibility aliases ─────────────────────────────────────
        /// <summary>
        /// Primary action / chat send button colour. Equals AccentBlue per macOS NordTheme.accent.
        /// Dark:  (94,140,210). Light: (79,70,229).
        /// </summary>
        public static Color Accent        => IsDarkMode
            ? AccentBlue
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
