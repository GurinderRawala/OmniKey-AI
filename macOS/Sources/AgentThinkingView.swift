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
                // ── Header ────────────────────────────────────────────────────
                HStack(alignment: .top, spacing: 10) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("OmniAgent Session")
                            .font(.system(size: 18, weight: .semibold))
                            .foregroundColor(NordTheme.primaryText(colorScheme))

                        // Current session name
                        HStack(spacing: 4) {
                            Image(systemName: "bubble.left.and.bubble.right")
                                .font(.system(size: 10))
                                .foregroundColor(NordTheme.accentBlue(colorScheme))
                            Text(model.currentSessionTitle)
                                .font(.system(size: 12, weight: .medium))
                                .foregroundColor(NordTheme.accentBlue(colorScheme))
                                .lineLimit(1)
                                .truncationMode(.tail)
                        }

                        Text("You can keep working while the agent plans and runs any commands it needs.")
                            .font(.system(size: 12))
                            .foregroundColor(NordTheme.secondaryText(colorScheme))
                    }

                    Spacer()

                    VStack(alignment: .trailing, spacing: 6) {
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
                            } else if !model.log.isEmpty {
                                Image(systemName: "checkmark.circle.fill")
                                    .font(.system(size: 11))
                                    .foregroundColor(NordTheme.accentGreen(colorScheme))

                                Text("Finished")
                                    .font(.system(size: 11, weight: .medium))
                                    .foregroundColor(NordTheme.accentGreen(colorScheme))
                            } else {
                                Image(systemName: "circle.dotted")
                                    .font(.system(size: 11))
                                    .foregroundColor(NordTheme.secondaryText(colorScheme))

                                Text("Ready")
                                    .font(.system(size: 11, weight: .medium))
                                    .foregroundColor(NordTheme.secondaryText(colorScheme))
                            }
                        }
                        .padding(.horizontal, 10)
                        .padding(.vertical, 5)
                        .background(Capsule().fill(NordTheme.badgeFill(colorScheme)))
                        .overlay(Capsule().strokeBorder(NordTheme.border(colorScheme), lineWidth: 1))

                        // Context budget badge
                        if model.remainingContextTokens > 0 || model.selectedSessionId != nil {
                            HStack(spacing: 4) {
                                Image(systemName: "brain.head.profile")
                                    .font(.system(size: 9))
                                    .foregroundColor(NordTheme.accentAmber(colorScheme))
                                Text("\(model.remainingContextTokens.formatted()) tokens left")
                                    .font(.system(size: 10, weight: .medium))
                                    .foregroundColor(NordTheme.accentAmber(colorScheme))
                            }
                            .padding(.horizontal, 8)
                            .padding(.vertical, 4)
                            .background(Capsule().fill(NordTheme.badgeFill(colorScheme)))
                            .overlay(Capsule().strokeBorder(NordTheme.border(colorScheme), lineWidth: 1))
                        }
                    }
                }
                .padding(.bottom, 16)

                Rectangle()
                    .fill(NordTheme.border(colorScheme))
                    .frame(height: 1)
                    .padding(.bottom, 16)

                // Scrollable content
                ScrollViewReader { proxy in
                    ScrollView {
                        VStack(alignment: .leading, spacing: 16) {
                            if model.log.isEmpty {
                                VStack(spacing: 12) {
                                    Image(systemName: model.isRunning ? "sparkles" : "sparkle")
                                        .font(.system(size: 28))
                                        .foregroundColor(NordTheme.secondaryText(colorScheme))

                                    Text(model.isRunning ? "Waiting for the agent to respond..." : "No active session")
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
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .fill(NordTheme.editorBackground(colorScheme))
                            .shadow(color: Color.black.opacity(colorScheme == .dark ? 0.45 : 0.10), radius: 16, x: 0, y: 12)
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
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

                // Bottom action bar — Cancel only (status lives in the header badge)
                if model.isRunning {
                    HStack(spacing: 10) {
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

                        Spacer()
                    }
                    .padding(.top, 12)
                    .padding(.horizontal, 2)
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, 22)
            .padding(.bottom, 32)
            .frame(minWidth: 800, minHeight: 620)
        }
        // ── Session picker sheet ──────────────────────────────────────────────
        .sheet(isPresented: $model.isShowingSessionPicker) {
            SessionPickerView(model: model)
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

// MARK: - Session Picker Sheet

struct SessionPickerView: View {
    @ObservedObject var model: AgentThinkingModel
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Title bar
            HStack {
                Text("Choose Session")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundColor(NordTheme.primaryText(colorScheme))
                Spacer()
                Button {
                    dismiss()
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 16))
                        .foregroundColor(NordTheme.secondaryText(colorScheme))
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 20)
            .padding(.top, 18)
            .padding(.bottom, 12)

            Divider()

            // "Start a new session" option always present at the top
            Button {
                model.selectedSessionId = nil
                model.currentSessionTitle = "New Session"
                model.remainingContextTokens = 0
                model.isShowingSessionPicker = false
                dismiss()
            } label: {
                HStack(spacing: 10) {
                    Image(systemName: "plus.circle")
                        .font(.system(size: 14))
                        .foregroundColor(NordTheme.accentGreen(colorScheme))
                        .frame(width: 20)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Start a New Session")
                            .font(.system(size: 13, weight: .medium))
                            .foregroundColor(NordTheme.primaryText(colorScheme))
                        Text("Begin a fresh conversation with the agent")
                            .font(.system(size: 11))
                            .foregroundColor(NordTheme.secondaryText(colorScheme))
                    }
                    Spacer()
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 10)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .background(
                model.selectedSessionId == nil
                    ? NordTheme.sectionFill(accent: NordTheme.accentGreen(colorScheme), scheme: colorScheme)
                    : Color.clear
            )

            Divider()
                .padding(.bottom, 4)

            if model.availableSessions.isEmpty {
                Text("No previous sessions found.")
                    .font(.system(size: 12))
                    .foregroundColor(NordTheme.secondaryText(colorScheme))
                    .padding(.horizontal, 20)
                    .padding(.vertical, 12)
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(model.availableSessions) { session in
                            HStack(spacing: 0) {
                                // ── Select button ──────────────────────────
                                Button {
                                    model.selectedSessionId = session.id
                                    model.currentSessionTitle = session.title
                                    model.remainingContextTokens = session.remainingContextTokens
                                    model.isShowingSessionPicker = false
                                    dismiss()
                                } label: {
                                    HStack(spacing: 10) {
                                        Image(systemName: "bubble.left.and.bubble.right")
                                            .font(.system(size: 13))
                                            .foregroundColor(NordTheme.accentBlue(colorScheme))
                                            .frame(width: 20)
                                        VStack(alignment: .leading, spacing: 3) {
                                            Text(session.title)
                                                .font(.system(size: 13, weight: .medium))
                                                .foregroundColor(NordTheme.primaryText(colorScheme))
                                                .lineLimit(1)
                                                .truncationMode(.tail)

                                            HStack(spacing: 8) {
                                                Label("\(session.turns) turn\(session.turns == 1 ? "" : "s")", systemImage: "arrow.2.circlepath")
                                                Label("\(session.remainingContextTokens.formatted()) tokens left", systemImage: "brain.head.profile")
                                            }
                                            .font(.system(size: 10))
                                            .foregroundColor(NordTheme.secondaryText(colorScheme))
                                        }
                                        Spacer()
                                        if model.selectedSessionId == session.id {
                                            Image(systemName: "checkmark")
                                                .font(.system(size: 11, weight: .semibold))
                                                .foregroundColor(NordTheme.accentBlue(colorScheme))
                                        }
                                    }
                                    .padding(.leading, 20)
                                    .padding(.trailing, 8)
                                    .padding(.vertical, 10)
                                    .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)

                                // ── Delete button ──────────────────────────
                                Button {
                                    model.deleteSession(id: session.id)
                                } label: {
                                    Image(systemName: "trash")
                                        .font(.system(size: 11))
                                        .foregroundColor(Color(red: 252 / 255, green: 100 / 255, blue: 100 / 255))
                                        .padding(.horizontal, 12)
                                        .padding(.vertical, 10)
                                        .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                                .help("Delete this session")
                            }
                            .background(
                                model.selectedSessionId == session.id
                                    ? NordTheme.sectionFill(accent: NordTheme.accentBlue(colorScheme), scheme: colorScheme)
                                    : Color.clear
                            )

                            Divider()
                        }
                    }
                }
                .frame(maxHeight: 340)
            }

            Spacer(minLength: 0)
        }
        .frame(width: 420)
        .background(NordTheme.windowBackground(colorScheme))
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

