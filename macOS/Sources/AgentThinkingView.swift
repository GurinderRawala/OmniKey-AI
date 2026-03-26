import SwiftUI

struct AgentThinkingView: View {
    @ObservedObject var model: AgentThinkingModel
    @Environment(\.colorScheme) private var colorScheme
    @State private var pulseAnimation = false

    var body: some View {
        ZStack {
            NordTheme.windowBackground(colorScheme)
                .ignoresSafeArea()

            VStack(alignment: .leading, spacing: 0) {
                // Header
                HStack(alignment: .center, spacing: 10) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text("OmniAgent Session")
                            .font(.system(size: 18, weight: .semibold))
                            .foregroundColor(NordTheme.primaryText(colorScheme))

                        Text("You can keep working while the agent plans and runs any commands it needs.")
                            .font(.system(size: 12))
                            .foregroundColor(NordTheme.secondaryText(colorScheme))
                    }

                    Spacer()

                    // Live status badge
                    HStack(spacing: 6) {
                        if model.isRunning {
                            Circle()
                                .fill(NordTheme.accent(colorScheme))
                                .frame(width: 8, height: 8)
                                .scaleEffect(pulseAnimation ? 1.3 : 1.0)
                                .opacity(pulseAnimation ? 0.6 : 1.0)
                                .animation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true), value: pulseAnimation)
                                .onAppear { pulseAnimation = true }

                            Text("Running")
                                .font(.system(size: 11, weight: .medium))
                                .foregroundColor(NordTheme.accent(colorScheme))
                        } else {
                            Image(systemName: "checkmark.circle.fill")
                                .font(.system(size: 11))
                                .foregroundColor(NordTheme.accentGreen(colorScheme))

                            Text("Finished")
                                .font(.system(size: 11, weight: .medium))
                                .foregroundColor(NordTheme.accentGreen(colorScheme))
                        }
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 5)
                    .background(
                        Capsule()
                            .fill(NordTheme.badgeFill(colorScheme))
                    )
                    .overlay(
                        Capsule()
                            .strokeBorder(NordTheme.border(colorScheme), lineWidth: 1)
                    )
                }
                .padding(.bottom, 14)

                Rectangle()
                    .fill(NordTheme.border(colorScheme))
                    .frame(height: 1)
                    .padding(.bottom, 14)

                // Scrollable content
                ScrollViewReader { proxy in
                    ScrollView {
                        VStack(alignment: .leading, spacing: 16) {
                            if model.log.isEmpty {
                                VStack(spacing: 12) {
                                    Image(systemName: "sparkles")
                                        .font(.system(size: 28))
                                        .foregroundColor(NordTheme.secondaryText(colorScheme))

                                    Text("Waiting for the agent to respond...")
                                        .font(.system(size: 13))
                                        .foregroundColor(NordTheme.secondaryText(colorScheme))
                                }
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 48)
                            } else {
                                // Your Request
                                if !model.initialRequest.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                                    sectionCard(
                                        icon: "text.quote",
                                        title: "Your Request",
                                        accentColor: NordTheme.accentBlue(colorScheme)
                                    ) {
                                        CollapsibleText(
                                            text: model.initialRequest,
                                            font: .system(size: 13),
                                            foregroundColor: NordTheme.primaryText(colorScheme),
                                            accentColor: NordTheme.accentBlue(colorScheme)
                                        )
                                        .padding(10)
                                        .background(
                                            RoundedRectangle(cornerRadius: 6)
                                                .fill(NordTheme.sectionFill(accent: NordTheme.accentBlue(colorScheme), scheme: colorScheme))
                                        )
                                        .overlay(
                                            RoundedRectangle(cornerRadius: 6)
                                                .strokeBorder(NordTheme.sectionBorder(accent: NordTheme.accentBlue(colorScheme), scheme: colorScheme), lineWidth: 1)
                                        )
                                    }
                                }

                                // Agent Reasoning
                                if !model.agentMessages.isEmpty {
                                    let purple = NordTheme.accentPurple(colorScheme)
                                    sectionCard(
                                        icon: "brain",
                                        title: "Agent Reasoning",
                                        accentColor: purple
                                    ) {
                                        VStack(alignment: .leading, spacing: 8) {
                                            ForEach(Array(model.agentMessages.enumerated()), id: \.offset) { index, message in
                                                HStack(alignment: .top, spacing: 8) {
                                                    // Step badge
                                                    Text("\(index + 1)")
                                                        .font(.system(size: 10, weight: .semibold, design: .rounded))
                                                        .foregroundColor(purple)
                                                        .frame(width: 20, height: 20)
                                                        .background(
                                                            RoundedRectangle(cornerRadius: 5)
                                                                .fill(NordTheme.sectionFill(accent: purple, scheme: colorScheme))
                                                        )
                                                        .overlay(
                                                            RoundedRectangle(cornerRadius: 5)
                                                                .strokeBorder(NordTheme.sectionBorder(accent: purple, scheme: colorScheme), lineWidth: 1)
                                                        )

                                                    CollapsibleText(
                                                        text: message,
                                                        font: .system(size: 12),
                                                        foregroundColor: NordTheme.primaryText(colorScheme),
                                                        accentColor: purple
                                                    )
                                                    .padding(8)
                                                    .background(
                                                        RoundedRectangle(cornerRadius: 6)
                                                            .fill(NordTheme.sectionFill(accent: purple, scheme: colorScheme))
                                                    )
                                                    .overlay(
                                                        RoundedRectangle(cornerRadius: 6)
                                                            .strokeBorder(NordTheme.sectionBorder(accent: purple, scheme: colorScheme), lineWidth: 1)
                                                    )
                                                }
                                            }
                                        }
                                    }
                                }

                                // Web Searches
                                if !model.webCalls.isEmpty {
                                    let cyan = NordTheme.accent(colorScheme)
                                    sectionCard(
                                        icon: "globe",
                                        title: "Web Searches",
                                        accentColor: cyan
                                    ) {
                                        VStack(alignment: .leading, spacing: 6) {
                                            ForEach(Array(model.webCalls.enumerated()), id: \.offset) { _, entry in
                                                CollapsibleText(
                                                    text: entry,
                                                    font: .system(size: 12, design: .monospaced),
                                                    foregroundColor: NordTheme.primaryText(colorScheme),
                                                    accentColor: cyan
                                                )
                                                .padding(8)
                                                .background(
                                                    RoundedRectangle(cornerRadius: 6)
                                                        .fill(NordTheme.sectionFill(accent: cyan, scheme: colorScheme))
                                                )
                                                .overlay(
                                                    RoundedRectangle(cornerRadius: 6)
                                                        .strokeBorder(NordTheme.sectionBorder(accent: cyan, scheme: colorScheme), lineWidth: 1)
                                                )
                                            }
                                        }
                                    }
                                }

                                // Terminal Output
                                if !model.terminalOutputs.isEmpty {
                                    let amber = NordTheme.accentAmber(colorScheme)
                                    sectionCard(
                                        icon: "terminal",
                                        title: "Terminal Output",
                                        accentColor: amber
                                    ) {
                                        VStack(alignment: .leading, spacing: 8) {
                                            ForEach(Array(model.terminalOutputs.enumerated()), id: \.offset) { _, entry in
                                                let lines = entry.components(separatedBy: "\n")
                                                let header = lines.first ?? ""
                                                let body = lines.dropFirst().joined(separator: "\n")

                                                VStack(alignment: .leading, spacing: 4) {
                                                    if !header.isEmpty {
                                                        Text(header)
                                                            .font(.system(size: 11, weight: .medium))
                                                            .foregroundColor(amber)
                                                    }

                                                    if !body.isEmpty {
                                                        CollapsibleText(
                                                            text: body,
                                                            font: .system(size: 12, design: .monospaced),
                                                            foregroundColor: NordTheme.primaryText(colorScheme),
                                                            accentColor: amber
                                                        )
                                                        .padding(8)
                                                        .background(
                                                            RoundedRectangle(cornerRadius: 6)
                                                                .fill(NordTheme.sectionFill(accent: amber, scheme: colorScheme))
                                                        )
                                                        .overlay(
                                                            RoundedRectangle(cornerRadius: 6)
                                                                .strokeBorder(NordTheme.sectionBorder(accent: amber, scheme: colorScheme), lineWidth: 1)
                                                        )
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }

                            // Scroll anchor
                            Color.clear
                                .frame(height: 1)
                                .id("bottom")
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(12)
                    }
                    .background(
                        RoundedRectangle(cornerRadius: 10)
                            .fill(NordTheme.editorBackground(colorScheme))
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: 10)
                            .strokeBorder(NordTheme.border(colorScheme), lineWidth: 1)
                    )
                    .onChange(of: model.log) { _ in
                        withAnimation { proxy.scrollTo("bottom", anchor: .bottom) }
                    }
                    .onChange(of: model.agentMessages.count) { _ in
                        withAnimation { proxy.scrollTo("bottom", anchor: .bottom) }
                    }
                    .onChange(of: model.webCalls.count) { _ in
                        withAnimation { proxy.scrollTo("bottom", anchor: .bottom) }
                    }
                    .onChange(of: model.terminalOutputs.count) { _ in
                        withAnimation { proxy.scrollTo("bottom", anchor: .bottom) }
                    }
                }

                // Bottom status bar
                HStack(spacing: 10) {
                    if model.isRunning {
                        Button(role: .destructive) {
                            AgentRunner.shared.cancelCurrentSession()
                            model.isRunning = false
                        } label: {
                            HStack(spacing: 5) {
                                Image(systemName: "stop.circle")
                                    .font(.system(size: 11))
                                Text("Cancel")
                                    .font(.system(size: 12))
                            }
                        }
                        .buttonStyle(.plain)
                        .foregroundColor(Color(red: 252 / 255, green: 100 / 255, blue: 100 / 255))
                        .padding(.horizontal, 10)
                        .padding(.vertical, 5)
                        .background(
                            RoundedRectangle(cornerRadius: 6)
                                .fill(Color(red: 252 / 255, green: 100 / 255, blue: 100 / 255).opacity(colorScheme == .dark ? 0.10 : 0.07))
                        )
                        .overlay(
                            RoundedRectangle(cornerRadius: 6)
                                .strokeBorder(Color(red: 252 / 255, green: 100 / 255, blue: 100 / 255).opacity(0.25), lineWidth: 1)
                        )
                    }

                    Spacer()

                    if model.isRunning {
                        HStack(spacing: 6) {
                            Circle()
                                .fill(NordTheme.accent(colorScheme))
                                .frame(width: 7, height: 7)
                                .scaleEffect(pulseAnimation ? 1.3 : 1.0)
                                .opacity(pulseAnimation ? 0.6 : 1.0)
                                .animation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true), value: pulseAnimation)

                            Text("Running...")
                                .font(.system(size: 12, weight: .medium))
                                .foregroundColor(NordTheme.accent(colorScheme))
                        }
                    } else {
                        HStack(spacing: 6) {
                            Image(systemName: "checkmark.circle.fill")
                                .font(.system(size: 13))
                                .foregroundColor(NordTheme.accentGreen(colorScheme))

                            Text("Finished")
                                .font(.system(size: 12, weight: .medium))
                                .foregroundColor(NordTheme.accentGreen(colorScheme))
                        }
                    }
                }
                .padding(.top, 12)
            }
            .padding(20)
            .frame(minWidth: 560, minHeight: 420)
        }
    }

    // MARK: - Section Card Builder

    @ViewBuilder
    private func sectionCard<Content: View>(
        icon: String,
        title: String,
        accentColor: Color,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: icon)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundColor(accentColor)

                Text(title)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundColor(NordTheme.secondaryText(colorScheme))
            }

            content()
        }
    }
}

// MARK: - Collapsible Text

private struct CollapsibleText: View {
    let text: String
    let font: Font
    let foregroundColor: Color
    let accentColor: Color
    var wordLimit: Int = 10

    @State private var isExpanded = false

    private static let previewWordCount = 60

    private var words: [Substring] { text.split(whereSeparator: \.isWhitespace) }
    private var isLong: Bool { words.count > wordLimit }

    private var previewText: String {
        guard isLong else { return text }
        return words.prefix(Self.previewWordCount).joined(separator: " ") + "…"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(isExpanded ? text : previewText)
                .font(font)
                .foregroundColor(foregroundColor)
                .frame(maxWidth: .infinity, alignment: .leading)

            if isLong {
                Button {
                    withAnimation(.easeInOut(duration: 0.2)) {
                        isExpanded.toggle()
                    }
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                            .font(.system(size: 10, weight: .semibold))
                        Text(isExpanded ? "Show less" : "Show more (\(words.count) words)")
                            .font(.system(size: 11, weight: .medium))
                    }
                    .foregroundColor(accentColor)
                }
                .buttonStyle(.plain)
                .padding(.top, 2)
            }
        }
    }
}
