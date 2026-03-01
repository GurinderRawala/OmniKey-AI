import SwiftUI

struct NordTheme {
    // Base Nord colors
    static let nord0 = Color(red: 46/255, green: 52/255, blue: 64/255)
    static let nord1 = Color(red: 59/255, green: 66/255, blue: 82/255)
    static let nord2 = Color(red: 67/255, green: 76/255, blue: 94/255)
    static let nord3 = Color(red: 76/255, green: 86/255, blue: 106/255)
    static let nord4 = Color(red: 216/255, green: 222/255, blue: 233/255)
    static let nord5 = Color(red: 229/255, green: 233/255, blue: 240/255)
    static let nord6 = Color(red: 236/255, green: 239/255, blue: 244/255)
    static let nord7 = Color(red: 143/255, green: 188/255, blue: 187/255)
    static let nord8 = Color(red: 136/255, green: 192/255, blue: 208/255)
    static let nord9 = Color(red: 129/255, green: 161/255, blue: 193/255)
    static let nord10 = Color(red: 94/255, green: 129/255, blue: 172/255)

    static func windowBackground(_ scheme: ColorScheme) -> LinearGradient {
        switch scheme {
        case .dark:
            return LinearGradient(
                gradient: Gradient(colors: [nord0, nord1]),
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
        default:
            return LinearGradient(
                gradient: Gradient(colors: [nord6, nord5]),
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
        }
    }

    static func panelBackground(_ scheme: ColorScheme) -> Color {
        switch scheme {
        case .dark:
            return nord1.opacity(0.96)
        default:
            return Color.white.opacity(0.98)
        }
    }

    static func editorBackground(_ scheme: ColorScheme) -> Color {
        switch scheme {
        case .dark:
            return nord2.opacity(0.9)
        default:
            return nord6
        }
    }

    static func border(_ scheme: ColorScheme) -> Color {
        switch scheme {
        case .dark:
            return nord3
        default:
            return Color.black.opacity(0.08)
        }
    }

    static func primaryText(_ scheme: ColorScheme) -> Color {
        switch scheme {
        case .dark:
            return nord4
        default:
            return Color.black.opacity(0.85)
        }
    }

    static func secondaryText(_ scheme: ColorScheme) -> Color {
        switch scheme {
        case .dark:
            return Color.white.opacity(0.65)
        default:
            return Color.black.opacity(0.6)
        }
    }

    static func accent(_ scheme: ColorScheme) -> Color {
        switch scheme {
        case .dark:
            return nord8
        default:
            return nord10
        }
    }
}
