import SwiftUI

enum NordTheme {

    // MARK: - Window & Panel Backgrounds

    static func windowBackground(_ scheme: ColorScheme) -> LinearGradient {
        switch scheme {
        case .dark:
            return LinearGradient(
                gradient: Gradient(colors: [
                    Color(red: 28 / 255, green: 28 / 255, blue: 30 / 255),
                    Color(red: 38 / 255, green: 38 / 255, blue: 40 / 255),
                ]),
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
        default:
            return LinearGradient(
                gradient: Gradient(colors: [
                    Color(red: 238 / 255, green: 242 / 255, blue: 255 / 255),
                    Color(red: 232 / 255, green: 238 / 255, blue: 255 / 255),
                ]),
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
        }
    }

    static func panelBackground(_ scheme: ColorScheme) -> Color {
        switch scheme {
        case .dark:
            return Color(red: 44 / 255, green: 44 / 255, blue: 46 / 255).opacity(0.97)
        default:
            return Color.white.opacity(0.98)
        }
    }

    static func editorBackground(_ scheme: ColorScheme) -> Color {
        switch scheme {
        case .dark:
            return Color(red: 30 / 255, green: 30 / 255, blue: 32 / 255).opacity(0.90)
        default:
            return Color(red: 245 / 255, green: 247 / 255, blue: 255 / 255)
        }
    }

    // MARK: - Borders

    static func border(_ scheme: ColorScheme) -> Color {
        switch scheme {
        case .dark:
            return Color.white.opacity(0.08)
        default:
            return Color(red: 15 / 255, green: 21 / 255, blue: 53 / 255).opacity(0.09)
        }
    }

    // MARK: - Text

    static func primaryText(_ scheme: ColorScheme) -> Color {
        switch scheme {
        case .dark:
            return Color(red: 220 / 255, green: 220 / 255, blue: 224 / 255)
        default:
            return Color(red: 15 / 255, green: 21 / 255, blue: 53 / 255)
        }
    }

    static func secondaryText(_ scheme: ColorScheme) -> Color {
        switch scheme {
        case .dark:
            return Color(red: 152 / 255, green: 152 / 255, blue: 157 / 255).opacity(0.85)
        default:
            return Color(red: 74 / 255, green: 85 / 255, blue: 120 / 255).opacity(0.85)
        }
    }

    // MARK: - Accent Colors

    static func accent(_ scheme: ColorScheme) -> Color {
        switch scheme {
        case .dark:
            return Color(red: 94 / 255, green: 140 / 255, blue: 210 / 255)
        default:
            return Color(red: 79 / 255, green: 70 / 255, blue: 229 / 255)
        }
    }

    static func accentPurple(_ scheme: ColorScheme) -> Color {
        switch scheme {
        case .dark:
            return Color(red: 170 / 255, green: 140 / 255, blue: 220 / 255)
        default:
            return Color(red: 124 / 255, green: 58 / 255, blue: 237 / 255)
        }
    }

    static func accentBlue(_ scheme: ColorScheme) -> Color {
        switch scheme {
        case .dark:
            return Color(red: 94 / 255, green: 140 / 255, blue: 210 / 255)
        default:
            return Color(red: 37 / 255, green: 99 / 255, blue: 235 / 255)
        }
    }

    static func accentGreen(_ scheme: ColorScheme) -> Color {
        switch scheme {
        case .dark:
            return Color(red: 110 / 255, green: 200 / 255, blue: 140 / 255)
        default:
            return Color(red: 5 / 255, green: 150 / 255, blue: 105 / 255)
        }
    }

    static func accentAmber(_ scheme: ColorScheme) -> Color {
        switch scheme {
        case .dark:
            return Color(red: 230 / 255, green: 200 / 255, blue: 110 / 255)
        default:
            return Color(red: 217 / 255, green: 119 / 255, blue: 6 / 255)
        }
    }

    // MARK: - Section Helpers

    static func sectionFill(accent: Color, scheme: ColorScheme) -> Color {
        accent.opacity(scheme == .dark ? 0.07 : 0.05)
    }

    static func sectionBorder(accent: Color, scheme: ColorScheme) -> Color {
        accent.opacity(scheme == .dark ? 0.25 : 0.20)
    }

    static func badgeFill(_ scheme: ColorScheme) -> Color {
        switch scheme {
        case .dark:
            return Color.white.opacity(0.07)
        default:
            return Color(red: 15 / 255, green: 21 / 255, blue: 53 / 255).opacity(0.06)
        }
    }
}
