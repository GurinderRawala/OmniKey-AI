import AppKit
import SwiftUI

// MARK: - Root

struct ChatView: View {
    @ObservedObject var model: ChatModel
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        ZStack {
            NordTheme.windowBackground(colorScheme).ignoresSafeArea()
            HStack(spacing: 0) {
                ChatSidebarView(model: model)
                    .frame(width: 260)
                Rectangle()
                    .fill(NordTheme.border(colorScheme))
                    .frame(width: 1)
                ChatConversationView(model: model)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .frame(minWidth: 880, minHeight: 600)
        .onAppear {
            model.refreshSessions()
            model.fetchDefaultTaskTemplate()
        }
    }
}

// MARK: - Sidebar

struct ChatSidebarView: View {
    @ObservedObject var model: ChatModel
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Title
            HStack(spacing: 8) {
                Image(systemName: "bubble.left.and.bubble.right.fill")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundColor(NordTheme.accent(colorScheme))
                Text("Chats")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundColor(NordTheme.primaryText(colorScheme))
            }
            .padding(.horizontal, 16)
            .padding(.top, 20)
            .padding(.bottom, 14)

            // New Chat button
            Button(action: model.startNewChat) {
                HStack(spacing: 7) {
                    Image(systemName: "plus")
                        .font(.system(size: 11, weight: .bold))
                    Text("New Chat")
                        .font(.system(size: 13, weight: .medium))
                    Spacer()
                }
                .foregroundColor(NordTheme.accent(colorScheme))
                .padding(.horizontal, 12)
                .padding(.vertical, 9)
                .background(
                    RoundedRectangle(cornerRadius: 9, style: .continuous)
                        .fill(NordTheme.accent(colorScheme).opacity(0.10))
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 9, style: .continuous)
                        .strokeBorder(NordTheme.accent(colorScheme).opacity(0.25), lineWidth: 1)
                )
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 12)

            Rectangle()
                .fill(NordTheme.border(colorScheme))
                .frame(height: 1)
                .padding(.horizontal, 12)
                .padding(.vertical, 12)

            // Session list
            ScrollView {
                LazyVStack(spacing: 2) {
                    if model.sessions.isEmpty {
                        VStack(spacing: 10) {
                            Image(systemName: "bubble.left.and.bubble.right")
                                .font(.system(size: 24))
                                .foregroundColor(NordTheme.secondaryText(colorScheme).opacity(0.4))
                            Text("No chats yet")
                                .font(.system(size: 12))
                                .foregroundColor(NordTheme.secondaryText(colorScheme))
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.top, 36)
                    } else {
                        ForEach(model.sessions) { session in
                            ChatSessionRowView(
                                session: session,
                                isActive: session.id == model.activeSessionId,
                                onTap: { model.openSession(session) },
                                onDelete: { model.deleteSession(session) }
                            )
                        }
                    }
                }
                .padding(.horizontal, 8)
                .padding(.bottom, 16)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(NordTheme.panelBackground(colorScheme))
    }
}

// MARK: - Session Row

struct ChatSessionRowView: View {
    let session: AgentSessionInfo
    let isActive: Bool
    let onTap: () -> Void
    let onDelete: () -> Void

    @Environment(\.colorScheme) private var colorScheme
    @State private var isHovered = false

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: 8) {
                Image(systemName: "message.fill")
                    .font(.system(size: 10))
                    .foregroundColor(
                        isActive ? NordTheme.accent(colorScheme) : NordTheme.secondaryText(colorScheme).opacity(0.5)
                    )

                VStack(alignment: .leading, spacing: 2) {
                    Text(session.title)
                        .font(.system(size: 12, weight: isActive ? .semibold : .regular))
                        .foregroundColor(
                            isActive ? NordTheme.accent(colorScheme) : NordTheme.primaryText(colorScheme)
                        )
                        .lineLimit(1)
                        .truncationMode(.tail)

                    Text("\(session.turns) turn\(session.turns == 1 ? "" : "s")")
                        .font(.system(size: 10))
                        .foregroundColor(NordTheme.secondaryText(colorScheme))
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                if isHovered {
                    Button(action: onDelete) {
                        Image(systemName: "trash")
                            .font(.system(size: 10))
                            .foregroundColor(.red.opacity(0.7))
                    }
                    .buttonStyle(.plain)
                    .transition(.opacity)
                }
            }
            .padding(.horizontal, 9)
            .padding(.vertical, 8)
            .background(
                RoundedRectangle(cornerRadius: 7, style: .continuous)
                    .fill(
                        isActive ? NordTheme.accent(colorScheme).opacity(0.12) :
                        isHovered ? NordTheme.badgeFill(colorScheme) :
                        Color.clear
                    )
            )
            .overlay(
                RoundedRectangle(cornerRadius: 7, style: .continuous)
                    .strokeBorder(
                        isActive ? NordTheme.accent(colorScheme).opacity(0.28) : Color.clear,
                        lineWidth: 1
                    )
            )
        }
        .buttonStyle(.plain)
        .animation(.easeInOut(duration: 0.15), value: isHovered)
        .onHover { isHovered = $0 }
    }
}

// MARK: - Conversation Area

struct ChatConversationView: View {
    @ObservedObject var model: ChatModel
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        VStack(spacing: 0) {
            ChatHeaderBar(model: model)

            Rectangle()
                .fill(NordTheme.border(colorScheme))
                .frame(height: 1)

            // Message feed
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 0) {
                        if model.isLoadingSessionHistory {
                            ChatLoadingStateView()
                        } else if model.messages.isEmpty {
                            ChatEmptyStateView()
                        }
                        if model.trimmedOlderMessageCount > 0, !model.messages.isEmpty {
                            ChatTrimmedHistoryNotice(trimmedCount: model.trimmedOlderMessageCount)
                                .padding(.vertical, 8)
                        }
                        ForEach(model.messages) { message in
                            ChatMessageView(message: message)
                                .padding(.vertical, 10)
                        }
                        if model.isRunning {
                            ChatThinkingIndicator()
                                .padding(.bottom, 10)
                        }
                        Color.clear.frame(height: 1).id("bottom")
                    }
                    .padding(.horizontal, 28)
                    .padding(.vertical, 8)
                    .frame(maxWidth: 980, alignment: .leading)
                    .frame(maxWidth: .infinity, alignment: .center)
                }
                .onChange(of: model.messages.count) { _, _ in
                    withAnimation { proxy.scrollTo("bottom", anchor: .bottom) }
                }
                .onChange(of: model.messages.last?.blocks.count ?? 0) { _, _ in
                    withAnimation { proxy.scrollTo("bottom", anchor: .bottom) }
                }
                .onChange(of: model.isRunning) { _, _ in
                    withAnimation { proxy.scrollTo("bottom", anchor: .bottom) }
                }
            }

            if let err = model.lastErrorMessage {
                ChatErrorBanner(message: err) { model.lastErrorMessage = nil }
            }

            Rectangle()
                .fill(NordTheme.border(colorScheme))
                .frame(height: 1)

            ChatInputBar(model: model)
        }
        .background(NordTheme.editorBackground(colorScheme))
    }
}

// MARK: - Header Bar

struct ChatHeaderBar: View {
    @ObservedObject var model: ChatModel
    @Environment(\.colorScheme) private var colorScheme
    @State private var pulse = false

    var body: some View {
        HStack(spacing: 12) {
            Text(model.activeSessionTitle)
                .font(.system(size: 15, weight: .semibold))
                .foregroundColor(NordTheme.primaryText(colorScheme))
                .lineLimit(1)

            Spacer()

            if model.isRunning {
                HStack(spacing: 6) {
                    Circle()
                        .fill(NordTheme.accentGreen(colorScheme))
                        .frame(width: 7, height: 7)
                        .scaleEffect(pulse ? 1.35 : 1.0)
                        .opacity(pulse ? 0.55 : 1.0)
                        .animation(.easeInOut(duration: 0.85).repeatForever(autoreverses: true), value: pulse)
                        .onAppear { pulse = true }
                        .onDisappear { pulse = false }
                    Text("Running")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundColor(NordTheme.accentGreen(colorScheme))
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 5)
                .background(Capsule().fill(NordTheme.badgeFill(colorScheme)))
                .overlay(Capsule().strokeBorder(NordTheme.border(colorScheme), lineWidth: 1))

                Button(action: model.cancelCurrentTurn) {
                    HStack(spacing: 4) {
                        Image(systemName: "stop.circle.fill")
                            .font(.system(size: 11))
                        Text("Stop")
                            .font(.system(size: 11, weight: .medium))
                    }
                    .foregroundColor(.red.opacity(0.9))
                    .padding(.horizontal, 10)
                    .padding(.vertical, 5)
                    .background(Capsule().fill(Color.red.opacity(colorScheme == .dark ? 0.10 : 0.07)))
                    .overlay(Capsule().strokeBorder(Color.red.opacity(0.25), lineWidth: 1))
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 22)
        .padding(.vertical, 14)
        .frame(minHeight: 56)
    }
}

// MARK: - Empty State

struct ChatEmptyStateView: View {
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: "sparkles")
                .font(.system(size: 44))
                .foregroundColor(NordTheme.accent(colorScheme).opacity(0.55))

            Text("Start a conversation")
                .font(.system(size: 17, weight: .semibold))
                .foregroundColor(NordTheme.primaryText(colorScheme))

            Text("Ask anything. Existing chats are in the sidebar.")
                .font(.system(size: 13))
                .foregroundColor(NordTheme.secondaryText(colorScheme))
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: 320)
        .padding(.vertical, 96)
        .frame(maxWidth: .infinity)
    }
}

/// Small banner shown at the top of a long conversation when older
/// messages have been trimmed from the visible window to keep the UI
/// responsive. Tells the user how many earlier messages are not being
/// rendered (they remain persisted on the backend and will return when
/// the session is re-opened).
private struct ChatTrimmedHistoryNotice: View {
    let trimmedCount: Int
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "clock.arrow.circlepath")
                .font(.system(size: 10, weight: .semibold))
                .foregroundColor(NordTheme.secondaryText(colorScheme))
            Text("Showing the latest \(ChatModel.maxVisibleMessages) of \(ChatModel.maxVisibleMessages + trimmedCount) messages")
                .font(.system(size: 11))
                .foregroundColor(NordTheme.secondaryText(colorScheme))
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(Capsule().fill(NordTheme.badgeFill(colorScheme)))
        .overlay(Capsule().strokeBorder(NordTheme.border(colorScheme), lineWidth: 1))
        .frame(maxWidth: .infinity, alignment: .center)
    }
}

private struct ChatLoadingStateView: View {
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        VStack(spacing: 12) {
            ProgressView()
                .scaleEffect(0.75)
            Text("Opening chat…")
                .font(.system(size: 13, weight: .medium))
                .foregroundColor(NordTheme.secondaryText(colorScheme))
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 96)
    }
}

// MARK: - Thinking indicator

struct ChatThinkingIndicator: View {
    @Environment(\.colorScheme) private var colorScheme
    @State private var animating = false

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            agentAvatar
            HStack(spacing: 5) {
                ForEach(0 ..< 3) { i in
                    Circle()
                        .fill(NordTheme.accentPurple(colorScheme))
                        .frame(width: 6, height: 6)
                        .opacity(animating ? 1.0 : 0.25)
                        .animation(
                            .easeInOut(duration: 0.55).repeatForever().delay(Double(i) * 0.18),
                            value: animating
                        )
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .background(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(NordTheme.panelBackground(colorScheme))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .strokeBorder(NordTheme.border(colorScheme), lineWidth: 1)
            )
            Spacer()
        }
        .onAppear { animating = true }
        .onDisappear { animating = false }
    }

    private var agentAvatar: some View {
        ZStack {
            Circle()
                .fill(NordTheme.accentPurple(colorScheme).opacity(0.14))
                .frame(width: 30, height: 30)
            Image(systemName: "sparkles")
                .font(.system(size: 13))
                .foregroundColor(NordTheme.accentPurple(colorScheme))
        }
    }
}

// MARK: - Message View (dispatcher)

struct ChatMessageView: View {
    let message: ChatMessage
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        switch message.role {
        case .user:
            UserBubbleView(text: message.text)
        case .assistant:
            AssistantMessageView(message: message)
        case .system:
            EmptyView()
        }
    }
}

// MARK: - User Bubble

struct UserBubbleView: View {
    let text: String
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        HStack(alignment: .top) {
            Spacer(minLength: 80)
            Text(text)
                .font(.system(size: 13))
                .foregroundColor(bubbleTextColor)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: 620, alignment: .leading)
                .padding(.horizontal, 14)
                .padding(.vertical, 11)
                .background(
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .fill(bubbleFillColor)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .strokeBorder(bubbleBorderColor, lineWidth: 1)
                )
        }
        .frame(maxWidth: .infinity)
    }

    // In dark mode the user-bubble uses a muted tinted surface instead of
    // a saturated accent fill so it reads as a soft chip rather than a
    // bright blue block. Light mode keeps the existing accent fill.
    private var bubbleFillColor: Color {
        switch colorScheme {
        case .dark:
            return NordTheme.accent(colorScheme).opacity(0.22)
        default:
            return NordTheme.accent(colorScheme)
        }
    }

    private var bubbleTextColor: Color {
        switch colorScheme {
        case .dark:
            return NordTheme.primaryText(colorScheme)
        default:
            return .white
        }
    }

    private var bubbleBorderColor: Color {
        switch colorScheme {
        case .dark:
            return NordTheme.accent(colorScheme).opacity(0.35)
        default:
            return Color.clear
        }
    }
}

// MARK: - Assistant Message

struct AssistantMessageView: View {
    let message: ChatMessage
    @Environment(\.colorScheme) private var colorScheme

    private var thinkingBlocks: [ChatBlock] {
        message.blocks.filter { $0.kind != .finalAnswer }
    }

    private var finalBlock: ChatBlock? {
        message.blocks.first { $0.kind == .finalAnswer }
    }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            // Avatar
            ZStack {
                Circle()
                    .fill(NordTheme.accentPurple(colorScheme).opacity(0.13))
                    .frame(width: 30, height: 30)
                Image(systemName: "sparkles")
                    .font(.system(size: 13))
                    .foregroundColor(NordTheme.accentPurple(colorScheme))
            }

            VStack(alignment: .leading, spacing: 8) {
                if !thinkingBlocks.isEmpty {
                    ThinkingSectionView(blocks: thinkingBlocks)
                }

                // Final answer — rendered as markdown
                if let final = finalBlock {
                    FinalAnswerView(text: final.text)
                } else if message.blocks.isEmpty {
                    Text("…")
                        .font(.system(size: 13))
                        .foregroundColor(NordTheme.secondaryText(colorScheme))
                }
            }
            .frame(maxWidth: 760, alignment: .leading)

            Spacer(minLength: 24)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - Thinking Section

private struct ThinkingSectionView: View {
    let blocks: [ChatBlock]
    @Environment(\.colorScheme) private var colorScheme
    @State private var expanded = false

    private var stepCountText: String {
        "\(blocks.count) step\(blocks.count == 1 ? "" : "s")"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                withAnimation(.easeInOut(duration: 0.2)) { expanded.toggle() }
            } label: {
                HStack(spacing: 7) {
                    Image(systemName: expanded ? "chevron.down" : "chevron.right")
                        .font(.system(size: 9, weight: .semibold))
                    Image(systemName: "brain")
                        .font(.system(size: 10, weight: .semibold))
                    Text("Thinking")
                        .font(.system(size: 11, weight: .medium))
                    Text(stepCountText)
                        .font(.system(size: 10))
                        .foregroundColor(NordTheme.secondaryText(colorScheme).opacity(0.72))
                    Spacer()
                }
                .foregroundColor(NordTheme.secondaryText(colorScheme))
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(
                    RoundedRectangle(cornerRadius: 7, style: .continuous)
                        .fill(NordTheme.badgeFill(colorScheme).opacity(colorScheme == .dark ? 0.62 : 0.55))
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 7, style: .continuous)
                        .strokeBorder(NordTheme.border(colorScheme).opacity(0.85), lineWidth: 1)
                )
            }
            .buttonStyle(.plain)
            .help(expanded ? "Hide thinking" : "Show thinking")

            if expanded {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(blocks.indices, id: \.self) { index in
                        ThinkingStepView(block: blocks[index])
                        if index < blocks.count - 1 {
                            Rectangle()
                                .fill(NordTheme.border(colorScheme).opacity(0.65))
                                .frame(height: 1)
                        }
                    }
                }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(
                        RoundedRectangle(cornerRadius: 7, style: .continuous)
                            .fill(NordTheme.badgeFill(colorScheme).opacity(colorScheme == .dark ? 0.45 : 0.35))
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: 7, style: .continuous)
                            .strokeBorder(NordTheme.border(colorScheme).opacity(0.65), lineWidth: 1)
                    )
                    .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct ThinkingStepView: View {
    let block: ChatBlock
    @Environment(\.colorScheme) private var colorScheme

    private var meta: (icon: String, label: String) {
        switch block.kind {
        case .agentReasoning:
            return ("brain", "Reasoning")
        case .shellCommand:
            return ("terminal", "Command")
        case .terminalOutput:
            return ("terminal", "Terminal")
        case .webCall:
            return ("globe", "Web Search")
        case .mcpCall:
            return ("server.rack", "MCP Call")
        case .imageRendering:
            return ("photo", "Image")
        case .finalAnswer:
            return ("checkmark.circle", "Answer")
        }
    }

    var body: some View {
        let (icon, label) = meta

        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Image(systemName: icon)
                    .font(.system(size: 10, weight: .semibold))
                Text(label)
                    .font(.system(size: 10, weight: .medium))
                Spacer()
            }
            .foregroundColor(NordTheme.secondaryText(colorScheme).opacity(0.86))

            expandedContent
                .opacity(0.72)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private var expandedContent: some View {
        switch block.kind {
        case .shellCommand, .terminalOutput:
            ScrollView(.horizontal, showsIndicators: false) {
                Text(block.text)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundColor(NordTheme.secondaryText(colorScheme))
                    .textSelection(.enabled)
                    .fixedSize(horizontal: true, vertical: true)
            }
        case .agentReasoning, .webCall, .mcpCall, .imageRendering:
            ChatMarkdownView(text: block.text, baseFontSize: 12)
        case .finalAnswer:
            ChatMarkdownView(text: block.text)
        }
    }
}

// MARK: - Final Answer

struct FinalAnswerView: View {
    let text: String
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "checkmark.circle.fill")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundColor(NordTheme.accentGreen(colorScheme))
                Text("Final Answer")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundColor(NordTheme.secondaryText(colorScheme))
                Spacer()
                ChatCopyButton(text: text, title: "Copy final answer")
            }

            ChatMarkdownView(text: text)
        }
        .padding(12)
        .background(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(NordTheme.panelBackground(colorScheme))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .strokeBorder(NordTheme.border(colorScheme), lineWidth: 1)
        )
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - Copy Button

private struct ChatCopyButton: View {
    let text: String
    var title: String = "Copy"
    @Environment(\.colorScheme) private var colorScheme
    @State private var copied = false

    var body: some View {
        Button(action: copy) {
            HStack(spacing: 4) {
                Image(systemName: copied ? "checkmark" : "doc.on.doc")
                    .font(.system(size: 10, weight: .semibold))
                Text(copied ? "Copied" : "Copy")
                    .font(.system(size: 10, weight: .medium))
            }
            .foregroundColor(
                copied ? NordTheme.accentGreen(colorScheme) : NordTheme.secondaryText(colorScheme)
            )
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(Capsule().fill(NordTheme.badgeFill(colorScheme)))
            .overlay(Capsule().strokeBorder(NordTheme.border(colorScheme), lineWidth: 1))
        }
        .buttonStyle(.plain)
        .help(title)
    }

    private func copy() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        withAnimation { copied = true }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
            withAnimation { copied = false }
        }
    }
}

// MARK: - Markdown View

/// Renders LLM markdown output. Fenced code blocks get a styled `CodeBlockView`;
/// all other text is parsed with `AttributedString` for inline formatting (bold,
/// italic, links, inline code, etc.).
struct ChatMarkdownView: View {
    let text: String
    var baseFontSize: CGFloat = 13
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                switch block {
                case let .code(language, code):
                    ChatCodeBlockView(language: language, code: code)
                case let .heading(level, content):
                    markdownText(content, size: headingSize(level), weight: .semibold)
                        .padding(.top, level == 1 ? 4 : 2)
                case let .paragraph(content):
                    markdownText(content)
                case let .unorderedList(items):
                    listView(items: items, ordered: false)
                case let .orderedList(items):
                    listView(items: items, ordered: true)
                case let .quote(content):
                    HStack(alignment: .top, spacing: 9) {
                        RoundedRectangle(cornerRadius: 1)
                            .fill(NordTheme.accent(colorScheme).opacity(0.35))
                            .frame(width: 3)
                        markdownText(content, size: baseFontSize - 1)
                            .foregroundColor(NordTheme.secondaryText(colorScheme))
                    }
                case .divider:
                    Rectangle()
                        .fill(NordTheme.border(colorScheme))
                        .frame(height: 1)
                        .padding(.vertical, 3)
                case let .table(header, rows):
                    MarkdownTableView(header: header, rows: rows)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func markdownText(
        _ prose: String,
        size: CGFloat? = nil,
        weight: Font.Weight = .regular
    ) -> some View {
        let opts = AttributedString.MarkdownParsingOptions(
            allowsExtendedAttributes: true,
            interpretedSyntax: .inlineOnlyPreservingWhitespace,
            failurePolicy: .returnPartiallyParsedIfPossible
        )
        let attributed = (try? AttributedString(markdown: prose, options: opts)) ?? AttributedString(prose)
        Text(attributed)
            .font(.system(size: size ?? baseFontSize, weight: weight))
            .foregroundColor(NordTheme.primaryText(colorScheme))
            .textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func listView(items: [String], ordered: Bool) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                HStack(alignment: .top, spacing: 8) {
                    Text(ordered ? "\(index + 1)." : "•")
                        .font(.system(size: baseFontSize, weight: .medium))
                        .foregroundColor(NordTheme.secondaryText(colorScheme))
                        .frame(width: ordered ? 24 : 14, alignment: .trailing)
                    markdownText(item)
                }
            }
        }
    }

    private func headingSize(_ level: Int) -> CGFloat {
        switch level {
        case 1:
            return baseFontSize + 5
        case 2:
            return baseFontSize + 3
        case 3:
            return baseFontSize + 1
        default:
            return baseFontSize
        }
    }

    private enum MarkdownBlock {
        case paragraph(String)
        case heading(Int, String)
        case unorderedList([String])
        case orderedList([String])
        case quote(String)
        case code(String?, String)
        case divider
        case table([String], [[String]])
    }

    private var blocks: [MarkdownBlock] {
        var result: [MarkdownBlock] = []
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        var i = 0

        while i < lines.count {
            let line = lines[i]
            let trimmed = line.trimmingCharacters(in: .whitespaces)

            if trimmed.isEmpty {
                i += 1
                continue
            }

            if line.hasPrefix("```") {
                let lang = String(line.dropFirst(3)).trimmingCharacters(in: .whitespaces)
                var codeLines: [String] = []
                i += 1
                while i < lines.count && !lines[i].hasPrefix("```") {
                    codeLines.append(lines[i])
                    i += 1
                }
                result.append(.code(lang.isEmpty ? nil : lang, codeLines.joined(separator: "\n")))
                i += 1
                continue
            }

            if let heading = parseHeading(trimmed) {
                result.append(.heading(heading.level, heading.text))
                i += 1
                continue
            }

            if isDivider(trimmed) {
                result.append(.divider)
                i += 1
                continue
            }

            if isTableStart(at: i, lines: lines) {
                let table = parseTable(startingAt: i, lines: lines)
                result.append(.table(table.header, table.rows))
                i = table.nextIndex
                continue
            }

            if isUnorderedListLine(trimmed) {
                var items: [String] = []
                while i < lines.count {
                    let current = lines[i].trimmingCharacters(in: .whitespaces)
                    guard isUnorderedListLine(current) else { break }
                    items.append(String(current.dropFirst(2)).trimmingCharacters(in: .whitespaces))
                    i += 1
                }
                result.append(.unorderedList(items))
                continue
            }

            if let firstOrdered = orderedListText(trimmed) {
                var items = [firstOrdered]
                i += 1
                while i < lines.count {
                    let current = lines[i].trimmingCharacters(in: .whitespaces)
                    guard let item = orderedListText(current) else { break }
                    items.append(item)
                    i += 1
                }
                result.append(.orderedList(items))
                continue
            }

            if trimmed.hasPrefix(">") {
                var quoteLines: [String] = []
                while i < lines.count {
                    let current = lines[i].trimmingCharacters(in: .whitespaces)
                    guard current.hasPrefix(">") else { break }
                    quoteLines.append(String(current.dropFirst()).trimmingCharacters(in: .whitespaces))
                    i += 1
                }
                result.append(.quote(quoteLines.joined(separator: "\n")))
                continue
            }

            var paragraphLines = [line]
            i += 1
            while i < lines.count {
                let current = lines[i]
                let currentTrimmed = current.trimmingCharacters(in: .whitespaces)
                if currentTrimmed.isEmpty ||
                    current.hasPrefix("```") ||
                    parseHeading(currentTrimmed) != nil ||
                    isDivider(currentTrimmed) ||
                    isTableStart(at: i, lines: lines) ||
                    isUnorderedListLine(currentTrimmed) ||
                    orderedListText(currentTrimmed) != nil ||
                    currentTrimmed.hasPrefix(">")
                {
                    break
                }
                paragraphLines.append(current)
                i += 1
            }
            result.append(.paragraph(paragraphLines.joined(separator: "\n")))
        }

        return result
    }

    private func parseHeading(_ line: String) -> (level: Int, text: String)? {
        let count = line.prefix { $0 == "#" }.count
        guard count > 0, count <= 4, line.dropFirst(count).first == " " else { return nil }
        return (count, String(line.dropFirst(count + 1)).trimmingCharacters(in: .whitespaces))
    }

    private func isDivider(_ line: String) -> Bool {
        line.count >= 3 && (
            line.allSatisfy { $0 == "-" } ||
            line.allSatisfy { $0 == "*" } ||
            line.allSatisfy { $0 == "_" }
        )
    }

    private func isUnorderedListLine(_ line: String) -> Bool {
        line.hasPrefix("- ") || line.hasPrefix("* ") || line.hasPrefix("• ")
    }

    private func orderedListText(_ line: String) -> String? {
        guard let dotIndex = line.firstIndex(where: { $0 == "." || $0 == ")" }) else { return nil }
        let prefix = line[..<dotIndex]
        guard !prefix.isEmpty, prefix.allSatisfy(\.isNumber) else { return nil }
        let after = line.index(after: dotIndex)
        guard after < line.endIndex, line[after] == " " else { return nil }
        return String(line[line.index(after: after)...]).trimmingCharacters(in: .whitespaces)
    }

    private func isTableStart(at index: Int, lines: [String]) -> Bool {
        guard index + 1 < lines.count else { return false }
        let header = lines[index].trimmingCharacters(in: .whitespaces)
        let separator = lines[index + 1].trimmingCharacters(in: .whitespaces)
        return header.contains("|") && isMarkdownTableSeparator(separator)
    }

    private func isMarkdownTableSeparator(_ line: String) -> Bool {
        let cells = tableCells(line)
        guard !cells.isEmpty else { return false }
        return cells.allSatisfy { cell in
            let stripped = cell.replacingOccurrences(of: ":", with: "")
            return stripped.count >= 3 && stripped.allSatisfy { $0 == "-" }
        }
    }

    private func parseTable(
        startingAt index: Int,
        lines: [String]
    ) -> (header: [String], rows: [[String]], nextIndex: Int) {
        let header = tableCells(lines[index])
        var rows: [[String]] = []
        var i = index + 2

        while i < lines.count {
            let line = lines[i].trimmingCharacters(in: .whitespaces)
            guard line.contains("|"), !line.isEmpty else { break }
            rows.append(tableCells(line))
            i += 1
        }

        return (header, rows, i)
    }

    private func tableCells(_ line: String) -> [String] {
        var trimmed = line.trimmingCharacters(in: .whitespaces)
        if trimmed.hasPrefix("|") { trimmed.removeFirst() }
        if trimmed.hasSuffix("|") { trimmed.removeLast() }
        return trimmed.split(separator: "|", omittingEmptySubsequences: false)
            .map { String($0).trimmingCharacters(in: .whitespaces) }
    }
}

// MARK: - Markdown Table

private struct MarkdownTableView: View {
    let header: [String]
    let rows: [[String]]
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        ScrollView(.horizontal, showsIndicators: true) {
            VStack(alignment: .leading, spacing: 0) {
                tableRow(header, isHeader: true)
                ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                    tableRow(row, isHeader: false)
                }
            }
            .background(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(NordTheme.panelBackground(colorScheme))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .strokeBorder(NordTheme.border(colorScheme), lineWidth: 1)
            )
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func tableRow(_ cells: [String], isHeader: Bool) -> some View {
        HStack(spacing: 0) {
            ForEach(0 ..< maxColumnCount, id: \.self) { index in
                Text(index < cells.count ? cells[index] : "")
                    .font(.system(size: 12, weight: isHeader ? .semibold : .regular))
                    .foregroundColor(
                        isHeader ? NordTheme.primaryText(colorScheme) : NordTheme.secondaryText(colorScheme)
                    )
                    .lineLimit(3)
                    .frame(width: columnWidth(for: index), alignment: .leading)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 7)
                    .background(isHeader ? NordTheme.badgeFill(colorScheme) : Color.clear)
                    .overlay(alignment: .trailing) {
                        Rectangle()
                            .fill(NordTheme.border(colorScheme))
                            .frame(width: 1)
                    }
            }
        }
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(NordTheme.border(colorScheme))
                .frame(height: 1)
        }
    }

    private var maxColumnCount: Int {
        max(header.count, rows.map(\.count).max() ?? 0)
    }

    private func columnWidth(for index: Int) -> CGFloat {
        let values = [header] + rows
        let longest = values.compactMap { index < $0.count ? $0[index].count : nil }.max() ?? 8
        return min(max(CGFloat(longest) * 7 + 24, 96), 220)
    }
}

// MARK: - Code Block

struct ChatCodeBlockView: View {
    let language: String?
    let code: String
    @Environment(\.colorScheme) private var colorScheme
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Top bar: language + copy button
            HStack {
                Text(language ?? "code")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundColor(NordTheme.secondaryText(colorScheme))
                Spacer()
                Button(action: doCopy) {
                    HStack(spacing: 4) {
                        Image(systemName: copied ? "checkmark" : "doc.on.doc")
                            .font(.system(size: 10))
                        Text(copied ? "Copied" : "Copy")
                            .font(.system(size: 10, weight: .medium))
                    }
                    .foregroundColor(
                        copied ? NordTheme.accentGreen(colorScheme) : NordTheme.secondaryText(colorScheme)
                    )
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
            .background(NordTheme.badgeFill(colorScheme))

            Rectangle()
                .fill(NordTheme.border(colorScheme))
                .frame(height: 1)

            ScrollView(.horizontal, showsIndicators: false) {
                Text(code)
                    .font(.system(size: 12, design: .monospaced))
                    .foregroundColor(NordTheme.primaryText(colorScheme))
                    .textSelection(.enabled)
                    .fixedSize(horizontal: true, vertical: true)
                    .padding(12)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(
                    colorScheme == .dark
                        ? Color(red: 10 / 255, green: 12 / 255, blue: 22 / 255)
                        : Color(red: 246 / 255, green: 248 / 255, blue: 252 / 255)
                )
        )
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .strokeBorder(NordTheme.border(colorScheme), lineWidth: 1)
        )
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func doCopy() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(code, forType: .string)
        withAnimation { copied = true }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
            withAnimation { copied = false }
        }
    }
}

// MARK: - Error Banner

private struct ChatErrorBanner: View {
    let message: String
    let onDismiss: () -> Void
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 12))
                .foregroundColor(.red)
            Text(message)
                .font(.system(size: 12))
                .foregroundColor(NordTheme.primaryText(colorScheme))
                .lineLimit(2)
            Spacer()
            Button(action: onDismiss) {
                Image(systemName: "xmark")
                    .font(.system(size: 10, weight: .bold))
                    .foregroundColor(NordTheme.secondaryText(colorScheme))
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 10)
        .background(Color.red.opacity(colorScheme == .dark ? 0.10 : 0.07))
    }
}

// MARK: - Input Bar

struct ChatInputBar: View {
    @ObservedObject var model: ChatModel
    @Environment(\.colorScheme) private var colorScheme
    @State private var isFocused = false
    @State private var inputHeight: CGFloat = 76

    private var inputIsEmpty: Bool {
        model.inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        VStack(spacing: 0) {
            VStack(spacing: 0) {
                HStack(alignment: .bottom, spacing: 10) {
                    // Text input
                    ZStack(alignment: .topLeading) {
                        if model.inputText.isEmpty {
                            Text("Message OmniAgent…")
                                .font(.system(size: 13))
                                .foregroundColor(NordTheme.secondaryText(colorScheme).opacity(0.5))
                                .padding(.horizontal, 14)
                                .padding(.top, 12)
                                .allowsHitTesting(false)
                        }
                        ChatNSTextInput(
                            text: $model.inputText,
                            isFocused: $isFocused,
                            colorScheme: colorScheme,
                            onSend: {
                                guard !model.isRunning, !inputIsEmpty else { return }
                                model.sendCurrentInput()
                            },
                            onRecallHistory: {
                                model.recallLastUserMessage()
                            }
                        )
                        .frame(height: inputHeight)
                        .onChange(of: model.inputText) { _, newValue in
                            let lines = max(1, newValue.components(separatedBy: "\n").count)
                            inputHeight = max(76, min(CGFloat(lines) * 20 + 36, 180))
                        }
                    }
                    .contentShape(Rectangle())
                    .onTapGesture { isFocused = true }
                    .background(
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .fill(NordTheme.panelBackground(colorScheme))
                            .shadow(color: .black.opacity(colorScheme == .dark ? 0.20 : 0.05), radius: 4, x: 0, y: 2)
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .strokeBorder(
                                isFocused
                                    ? NordTheme.accent(colorScheme).opacity(0.5)
                                    : NordTheme.border(colorScheme),
                                lineWidth: isFocused ? 1.5 : 1
                            )
                    )

                    // Send / Stop button
                    Button {
                        if model.isRunning { model.cancelCurrentTurn() } else { model.sendCurrentInput() }
                    } label: {
                        Image(systemName: model.isRunning ? "stop.circle.fill" : "arrow.up.circle.fill")
                            .font(.system(size: 32))
                            .foregroundColor(
                                model.isRunning ? .red :
                                    inputIsEmpty ? NordTheme.secondaryText(colorScheme).opacity(0.28) :
                                    NordTheme.accent(colorScheme)
                            )
                            .animation(.easeInOut(duration: 0.15), value: model.isRunning)
                    }
                    .buttonStyle(.plain)
                    .disabled(!model.isRunning && inputIsEmpty)
                }

                // Bottom meta-row: default task chip on the left, context
                // window indicator on the right. Both are informational and
                // tucked under the input box so they don't compete with the
                // send button.
                ChatInputFooterView(model: model)
                    .padding(.top, 8)
            }
            .frame(maxWidth: 980)
            .frame(maxWidth: .infinity, alignment: .center)
            .padding(.horizontal, 22)
            .padding(.top, 12)
            .padding(.bottom, 12)
        }
        .background(
            NordTheme.panelBackground(colorScheme)
                .shadow(color: .black.opacity(colorScheme == .dark ? 0.20 : 0.06), radius: 8, x: 0, y: -4)
        )
    }
}

// MARK: - NSTextView wrapper (Return-to-send, Shift-Return-for-newline)

/// Wraps `NSTextView` so that Return sends the current message and
/// Shift+Return inserts a newline — the standard behaviour for AI chat inputs.
struct ChatNSTextInput: NSViewRepresentable {
    @Binding var text: String
    @Binding var isFocused: Bool
    var colorScheme: ColorScheme
    var onSend: () -> Void
    /// Called when the user presses the Up Arrow while the input is empty.
    /// Should populate `text` with a prior message (or return `false` to
    /// fall through to default cursor behaviour). Optional — defaults to
    /// a no-op so existing call sites don't have to opt in.
    var onRecallHistory: () -> Bool = { false }

    func makeNSView(context: Context) -> NSScrollView {
        let scrollView = NSScrollView()
        scrollView.drawsBackground = false
        scrollView.borderType = .noBorder
        scrollView.hasVerticalScroller = true
        scrollView.autohidesScrollers = true

        let tv = ChatTextView()
        tv.delegate = context.coordinator
        tv.isEditable = true
        tv.isSelectable = true
        tv.isRichText = false
        tv.allowsUndo = true
        tv.importsGraphics = false
        tv.isAutomaticQuoteSubstitutionEnabled = false
        tv.isAutomaticTextReplacementEnabled = false
        tv.isAutomaticSpellingCorrectionEnabled = false
        tv.textContainerInset = NSSize(width: 10, height: 10)
        tv.textContainer?.lineFragmentPadding = 0
        tv.textContainer?.widthTracksTextView = true
        tv.textContainer?.containerSize = NSSize(
            width: scrollView.contentSize.width,
            height: CGFloat.greatestFiniteMagnitude
        )
        tv.minSize = NSSize(width: 0, height: scrollView.contentSize.height)
        tv.maxSize = NSSize(
            width: CGFloat.greatestFiniteMagnitude,
            height: CGFloat.greatestFiniteMagnitude
        )
        tv.isVerticallyResizable = true
        tv.isHorizontallyResizable = false
        tv.autoresizingMask = [.width]
        tv.backgroundColor = .clear
        tv.drawsBackground = false
        tv.insertionPointColor = colorScheme == .dark ? .white : .black
        setStyle(tv, colorScheme: colorScheme)

        scrollView.documentView = tv
        context.coordinator.textView = tv
        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        // Keep the coordinator's parent reference current so its onSend closure
        // sees the latest model state after every SwiftUI update cycle.
        context.coordinator.parent = self

        guard let tv = context.coordinator.textView ?? scrollView.documentView as? NSTextView else {
            return
        }

        if tv.string != text {
            let saved = tv.selectedRange()
            tv.string = text
            // Reapply attributes — setting .string clears the NSTextStorage.
            setStorageStyle(tv, colorScheme: colorScheme)
            let safeLocation = min(saved.location, (text as NSString).length)
            let safeLength = min(saved.length, max(0, (text as NSString).length - safeLocation))
            tv.setSelectedRange(NSRange(location: safeLocation, length: safeLength))
        }
        // Always refresh typing attributes so new characters match the theme.
        tv.insertionPointColor = colorScheme == .dark ? .white : .black
        setTypingAttributes(tv, colorScheme: colorScheme)

        if isFocused, tv.window?.firstResponder !== tv {
            DispatchQueue.main.async {
                tv.window?.makeFirstResponder(tv)
            }
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    // MARK: - Styling helpers

    private func setStyle(_ tv: NSTextView, colorScheme: ColorScheme) {
        setStorageStyle(tv, colorScheme: colorScheme)
        setTypingAttributes(tv, colorScheme: colorScheme)
    }

    private func setStorageStyle(_ tv: NSTextView, colorScheme: ColorScheme) {
        guard let storage = tv.textStorage, storage.length > 0 else { return }
        let attrs = baseAttributes(colorScheme: colorScheme)
        storage.beginEditing()
        storage.setAttributes(attrs, range: NSRange(location: 0, length: storage.length))
        storage.endEditing()
    }

    private func setTypingAttributes(_ tv: NSTextView, colorScheme: ColorScheme) {
        tv.typingAttributes = baseAttributes(colorScheme: colorScheme)
    }

    private func baseAttributes(colorScheme: ColorScheme) -> [NSAttributedString.Key: Any] {
        let color: NSColor = colorScheme == .dark
            ? NSColor(red: 226 / 255, green: 232 / 255, blue: 240 / 255, alpha: 1)
            : NSColor(red: 15 / 255, green: 21 / 255, blue: 53 / 255, alpha: 1)
        return [
            .font: NSFont.systemFont(ofSize: 13),
            .foregroundColor: color,
        ]
    }

    // MARK: Coordinator

    final class ChatTextView: NSTextView {
        override var acceptsFirstResponder: Bool { true }

        override func mouseDown(with event: NSEvent) {
            window?.makeFirstResponder(self)
            super.mouseDown(with: event)
        }
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: ChatNSTextInput
        weak var textView: NSTextView?

        init(_ p: ChatNSTextInput) { parent = p }

        func textDidChange(_ n: Notification) {
            guard let tv = n.object as? NSTextView else { return }
            parent.text = tv.string
        }

        func textDidBeginEditing(_: Notification) {
            parent.isFocused = true
        }

        func textDidEndEditing(_: Notification) {
            parent.isFocused = false
        }

        // Intercept Return (send / newline) and Up Arrow (recall last message).
        func textView(_ textView: NSTextView, doCommandBy sel: Selector) -> Bool {
            // Plain Return → send; Shift+Return → newline.
            if sel == #selector(NSResponder.insertNewline(_:)) {
                let mods = NSApp.currentEvent?.modifierFlags ?? []
                if mods.contains(.shift) { return false }
                DispatchQueue.main.async { self.parent.onSend() }
                return true
            }

            // Up Arrow on an empty input → pull the last user message
            // into the field for quick editing/resending. When the input
            // already has content we fall through so the caret can move
            // through multi-line text normally.
            if sel == #selector(NSResponder.moveUp(_:)) {
                guard textView.string.isEmpty else { return false }
                let handled = parent.onRecallHistory()
                if handled {
                    // Place the caret at the end of the freshly inserted
                    // text so the user can immediately keep typing.
                    DispatchQueue.main.async {
                        let length = (textView.string as NSString).length
                        textView.setSelectedRange(NSRange(location: length, length: 0))
                    }
                }
                return handled
            }

            return false
        }
    }
}

// MARK: - Input Footer (default-task chip + context window indicator)

/// Footer row tucked beneath the chat input. Shows the user's default
/// task instruction (left, informational chip with hover-tooltip) and
/// the remaining context window for the active session (right, a small
/// circular gauge — similar to the indicators standard AI chat tools
/// show under their input fields).
struct ChatInputFooterView: View {
    @ObservedObject var model: ChatModel
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        // Both chips live on the left edge of the input footer. The task
        // instruction chip only appears when a default exists; the context
        // gauge only appears once the active session has been hydrated.
        HStack(spacing: 8) {
            if let template = model.defaultTaskTemplate {
                DefaultTaskChip(template: template)
            }
            if let session = model.activeSession, session.contextBudget > 0 {
                ContextWindowIndicator(session: session)
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        // Reserve a tiny minimum height so the input bar layout doesn't
        // jitter on first render when neither chip nor gauge is present.
        .frame(minHeight: 18)
    }
}

/// Small pill showing "Using <heading>" with a tooltip on hover
/// exposing the full template name and instructions preview.
private struct DefaultTaskChip: View {
    let template: APIClient.TaskTemplateDTO
    @Environment(\.colorScheme) private var colorScheme

    private var tooltip: String {
        let trimmedInstructions = template.instructions
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmedInstructions.isEmpty {
            return "Default task instruction: \(template.heading)"
        }
        // Cap the preview so the tooltip stays readable.
        let preview: String
        if trimmedInstructions.count > 320 {
            let idx = trimmedInstructions.index(trimmedInstructions.startIndex, offsetBy: 320)
            preview = String(trimmedInstructions[..<idx]) + "…"
        } else {
            preview = trimmedInstructions
        }
        return "Default task instruction: \(template.heading)\n\n\(preview)"
    }

    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: "text.justify.left")
                .font(.system(size: 9, weight: .semibold))
                .foregroundColor(NordTheme.accentPurple(colorScheme))
            Text("Using \(template.heading)")
                .font(.system(size: 10, weight: .medium))
                .foregroundColor(NordTheme.accentPurple(colorScheme))
                .lineLimit(1)
                .truncationMode(.tail)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(
            Capsule()
                .fill(NordTheme.accentPurple(colorScheme).opacity(0.12))
        )
        .overlay(
            Capsule()
                .strokeBorder(NordTheme.accentPurple(colorScheme).opacity(0.30), lineWidth: 1)
        )
        .help(tooltip)
        .accessibilityLabel(Text("Default task instruction \(template.heading)"))
    }
}

/// Circular gauge showing the percentage of context window remaining
/// for the active session. Hover reveals the exact "X / Y tokens left".
private struct ContextWindowIndicator: View {
    let session: AgentSessionInfo
    @Environment(\.colorScheme) private var colorScheme

    private var fraction: Double {
        guard session.contextBudget > 0 else { return 0 }
        let raw = Double(session.remainingContextTokens) / Double(session.contextBudget)
        return min(max(raw, 0.0), 1.0)
    }

    /// Colour bands mirror common chat-tool conventions:
    /// green when plenty remains, amber once you've burnt through more
    /// than ~70% of the window, red once you're below 15%.
    private var gaugeColor: Color {
        if fraction <= 0.15 {
            return .red
        } else if fraction <= 0.30 {
            return NordTheme.accentAmber(colorScheme)
        } else {
            return NordTheme.accentGreen(colorScheme)
        }
    }

    private var percentLabel: String {
        "\(Int((fraction * 100).rounded()))%"
    }

    private var tooltip: String {
        let remaining = session.remainingContextTokens.formatted()
        let budget = session.contextBudget.formatted()
        return "Context window: \(remaining) of \(budget) tokens left (\(percentLabel))"
    }

    var body: some View {
        HStack(spacing: 6) {
            ZStack {
                Circle()
                    .stroke(NordTheme.border(colorScheme), lineWidth: 2)
                Circle()
                    .trim(from: 0, to: CGFloat(fraction))
                    .stroke(gaugeColor, style: StrokeStyle(lineWidth: 2, lineCap: .round))
                    .rotationEffect(.degrees(-90))
                    .animation(.easeOut(duration: 0.25), value: fraction)
            }
            .frame(width: 14, height: 14)

            Text(percentLabel)
                .font(.system(size: 10, weight: .medium))
                .foregroundColor(NordTheme.secondaryText(colorScheme))
                .monospacedDigit()
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(Capsule().fill(NordTheme.badgeFill(colorScheme)))
        .overlay(Capsule().strokeBorder(NordTheme.border(colorScheme), lineWidth: 1))
        .help(tooltip)
        .accessibilityLabel(Text(tooltip))
    }
}
