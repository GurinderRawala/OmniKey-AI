import SwiftUI

// MARK: - Model

@MainActor
final class JobRunHistoryModel: ObservableObject {
    @Published var messages: [SessionHistoryEntry] = []
    @Published var isLoading = true
    @Published var errorMessage: String? = nil

    func load(sessionId: String) {
        guard let token = SubscriptionManager.shared.jwtToken, !token.isEmpty else {
            errorMessage = "Not authenticated"
            isLoading = false
            return
        }
        let url = APIClient.baseURL
            .appendingPathComponent("api/agent/sessions")
            .appendingPathComponent(sessionId)
            .appendingPathComponent("messages")
        var request = URLRequest(url: url)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        URLSession.shared.dataTask(with: request) { [weak self] data, _, err in
            DispatchQueue.main.async {
                guard let self else { return }
                self.isLoading = false
                guard let data else {
                    self.errorMessage = err?.localizedDescription ?? "Network error"
                    return
                }
                struct Envelope: Decodable { let messages: [SessionHistoryEntry] }
                if let body = try? JSONDecoder().decode(Envelope.self, from: data) {
                    self.messages = body.messages
                } else {
                    self.errorMessage = "Could not load session data"
                }
            }
        }.resume()
    }
}

// MARK: - View

struct JobRunHistoryView: View {
    let jobLabel: String
    let sessionId: String

    @StateObject private var model = JobRunHistoryModel()
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dismiss) private var dismiss

    private var userMessages: [String] {
        model.messages.filter { $0.role == "user" }.map(\.text).filter { !$0.isEmpty }
    }

    private var assistantMessages: [String] {
        model.messages.filter { $0.role == "assistant" }.map(\.text).filter { !$0.isEmpty }
    }

    /// The final answer the agent produced for this run, if any. We prefer the
    /// last assistant message that contains an explicit `<final_answer>` block
    /// (mirroring `AgentRunner.extractFinalAnswer`), and fall back to the last
    /// assistant message overall when no tags are present — matching the
    /// "Previous Final Answer" behavior in `AgentThinkingView`.
    private var finalAnswer: String? {
        for text in assistantMessages.reversed() {
            if let extracted = extractFinalAnswer(from: text), !extracted.isEmpty {
                return extracted
            }
        }
        return assistantMessages.last?.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Reasoning steps to display: every assistant message except the one we
    /// surface as the final answer, so the same text isn't shown twice.
    private var reasoningMessages: [String] {
        guard let finalIndex = assistantMessages.lastIndex(where: {
            let stripped = extractFinalAnswer(from: $0) ?? $0.trimmingCharacters(in: .whitespacesAndNewlines)
            return stripped == finalAnswer
        }) else {
            return assistantMessages
        }
        var copy = assistantMessages
        copy.remove(at: finalIndex)
        return copy
    }

    var body: some View {
        ZStack {
            NordTheme.windowBackground(colorScheme).ignoresSafeArea()

            VStack(alignment: .leading, spacing: 0) {
                headerBar
                    .padding(.bottom, 16)

                Rectangle()
                    .fill(NordTheme.border(colorScheme))
                    .frame(height: 1)
                    .padding(.bottom, 16)

                contentArea
            }
            .padding(.horizontal, 20)
            .padding(.top, 22)
            .padding(.bottom, 32)
        }
        .frame(minWidth: 700, minHeight: 504, maxHeight: 504)
        .onAppear { model.load(sessionId: sessionId) }
    }

    // MARK: - Sub-views

    private var headerBar: some View {
        HStack(alignment: .top, spacing: 10) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Last Run Details")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundColor(NordTheme.primaryText(colorScheme))

                HStack(spacing: 4) {
                    Image(systemName: "clock.fill")
                        .font(.system(size: 10))
                        .foregroundColor(NordTheme.accentBlue(colorScheme))
                    Text(jobLabel)
                        .font(.system(size: 12, weight: .medium))
                        .foregroundColor(NordTheme.accentBlue(colorScheme))
                        .lineLimit(1)
                        .truncationMode(.tail)
                }

                Text("Steps the agent took during the last scheduled run.")
                    .font(.system(size: 12))
                    .foregroundColor(NordTheme.secondaryText(colorScheme))
            }

            Spacer()

            Button { dismiss() } label: {
                Image(systemName: "xmark.circle.fill")
                    .font(.system(size: 18))
                    .foregroundColor(NordTheme.secondaryText(colorScheme))
            }
            .buttonStyle(.plain)
        }
    }

    @ViewBuilder
    private var contentArea: some View {
        if model.isLoading {
            Spacer()
            HStack { Spacer(); ProgressView(); Spacer() }
            Spacer()
        } else if let err = model.errorMessage {
            Spacer()
            VStack(spacing: 10) {
                Image(systemName: "exclamationmark.triangle")
                    .font(.system(size: 28))
                    .foregroundColor(NordTheme.secondaryText(colorScheme))
                Text(err)
                    .font(.system(size: 13))
                    .foregroundColor(NordTheme.secondaryText(colorScheme))
            }
            .frame(maxWidth: .infinity)
            Spacer()
        } else if model.messages.isEmpty {
            Spacer()
            VStack(spacing: 10) {
                Image(systemName: "tray")
                    .font(.system(size: 28))
                    .foregroundColor(NordTheme.secondaryText(colorScheme))
                Text("No messages found for this run.")
                    .font(.system(size: 13))
                    .foregroundColor(NordTheme.secondaryText(colorScheme))
            }
            .frame(maxWidth: .infinity)
            Spacer()
        } else {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    // Final answer (surfaced first so it's easy to copy).
                    if let answer = finalAnswer, !answer.isEmpty {
                        finalAnswerCard(answer)
                    }

                    // Job prompt (first user message)
                    if let prompt = userMessages.first {
                        sectionCard(icon: "text.quote", title: "Job Prompt",
                                    accentColor: NordTheme.accentBlue(colorScheme)) {
                            historyText(prompt, accent: NordTheme.accentBlue(colorScheme))
                        }
                    }

                    // Agent reasoning steps
                    if !reasoningMessages.isEmpty {
                        let purple = NordTheme.accentPurple(colorScheme)
                        sectionCard(icon: "brain", title: "Agent Reasoning", accentColor: purple) {
                            VStack(alignment: .leading, spacing: 8) {
                                ForEach(Array(reasoningMessages.enumerated()), id: \.offset) { index, msg in
                                    HStack(alignment: .top, spacing: 8) {
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
                                        historyText(msg, accent: purple)
                                    }
                                }
                            }
                        }
                    }

                    // Follow-up user messages (tool outputs fed back to the agent)
                    let followUps = Array(userMessages.dropFirst())
                    if !followUps.isEmpty {
                        let amber = NordTheme.accentAmber(colorScheme)
                        sectionCard(icon: "terminal", title: "Tool Outputs", accentColor: amber) {
                            VStack(alignment: .leading, spacing: 6) {
                                ForEach(Array(followUps.enumerated()), id: \.offset) { _, text in
                                    historyText(text,
                                                font: .system(size: 12, design: .monospaced),
                                                accent: amber)
                                }
                            }
                        }
                    }

                    Color.clear.frame(height: 1)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(12)
            }
            .background(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(NordTheme.editorBackground(colorScheme))
                    .shadow(color: Color.black.opacity(colorScheme == .dark ? 0.45 : 0.10),
                            radius: 16, x: 0, y: 12)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .strokeBorder(NordTheme.border(colorScheme), lineWidth: 1)
            )
        }
    }

    // MARK: - Layout helpers

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

    /// Highlighted "Final Answer" card with an inline copy button — mirrors the
    /// "Final Result" and "Previous Final Answer" styling in `AgentThinkingView`.
    @ViewBuilder
    private func finalAnswerCard(_ answer: String) -> some View {
        let green = NordTheme.accentGreen(colorScheme)
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "star.fill")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundColor(green)
                Text("Final Answer")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundColor(NordTheme.secondaryText(colorScheme))
                Spacer()
                JobHistoryCopyButton(text: answer)
                    .help("Copy final answer")
            }

            ExpandableHistoryText(
                text: answer,
                font: .system(size: 13),
                foregroundColor: NordTheme.primaryText(colorScheme),
                accentColor: green
            )
            .padding(10)
            .background(
                RoundedRectangle(cornerRadius: 6)
                    .fill(NordTheme.sectionFill(accent: green, scheme: colorScheme))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 6)
                    .strokeBorder(NordTheme.sectionBorder(accent: green, scheme: colorScheme), lineWidth: 1)
            )
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    @ViewBuilder
    private func historyText(
        _ text: String,
        font: Font = .system(size: 13),
        accent: Color
    ) -> some View {
        ExpandableHistoryText(
            text: text,
            font: font,
            foregroundColor: NordTheme.primaryText(colorScheme),
            accentColor: accent
        )
        .padding(8)
        .background(
            RoundedRectangle(cornerRadius: 6)
                .fill(NordTheme.sectionFill(accent: accent, scheme: colorScheme))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 6)
                .strokeBorder(NordTheme.sectionBorder(accent: accent, scheme: colorScheme), lineWidth: 1)
        )
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - Parsing helpers

    /// Extracts the content of a `<final_answer>…</final_answer>` block, if
    /// present. Kept in sync with `AgentRunner.extractFinalAnswer` so the
    /// scheduled-job view surfaces the same final answer the live runner does.
    private func extractFinalAnswer(from text: String) -> String? {
        guard let startRange = text.range(of: "<final_answer>") else { return nil }
        guard let endRange = text.range(of: "</final_answer>", range: startRange.upperBound..<text.endIndex) else {
            return nil
        }
        let inner = text[startRange.upperBound..<endRange.lowerBound]
        return String(inner).trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

// MARK: - Copy button

/// Local copy button mirroring the `CopyButton` used in `AgentThinkingView`
/// (which is `private` to that file).
private struct JobHistoryCopyButton: View {
    let text: String
    var font: Font = .system(size: 11)

    @Environment(\.colorScheme) private var colorScheme
    @State private var copied = false

    var body: some View {
        Button {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(text, forType: .string)
            withAnimation(.easeInOut(duration: 0.15)) { copied = true }
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
                withAnimation(.easeInOut(duration: 0.15)) { copied = false }
            }
        } label: {
            Image(systemName: copied ? "checkmark" : "doc.on.doc")
                .font(font)
                .foregroundColor(copied ? NordTheme.accentGreen(colorScheme) : NordTheme.secondaryText(colorScheme))
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Expandable text helper

private struct ExpandableHistoryText: View {
    let text: String
    let font: Font
    let foregroundColor: Color
    let accentColor: Color

    @State private var isExpanded = false
    private let wordLimit = 60

    private var words: [Substring] { text.split(whereSeparator: \.isWhitespace) }
    private var isLong: Bool { words.count > wordLimit }
    private var preview: String {
        guard isLong else { return text }
        return words.prefix(wordLimit).joined(separator: " ") + "…"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(isExpanded ? text : preview)
                .font(font)
                .foregroundColor(foregroundColor)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)

            if isLong {
                Button {
                    withAnimation(.easeInOut(duration: 0.2)) { isExpanded.toggle() }
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
