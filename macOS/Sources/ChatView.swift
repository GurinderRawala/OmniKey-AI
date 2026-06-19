import AppKit
import SwiftUI

// MARK: - Root

struct ChatView: View {
    @ObservedObject var model: ChatModel
    @Environment(\.colorScheme) private var colorScheme

    /// Persisted collapse state. The sidebar collapses to a narrow rail
    /// of icons (new chat + recent sessions) so the conversation area
    /// gets more room without losing one-click access to chat history.
    @AppStorage("chatSidebarCollapsed") private var sidebarCollapsed: Bool = false

    private static let sidebarExpandedWidth: CGFloat = 240
    private static let sidebarCollapsedWidth: CGFloat = 52

    private var sidebarWidth: CGFloat {
        sidebarCollapsed ? Self.sidebarCollapsedWidth : Self.sidebarExpandedWidth
    }

    private func toggleSidebar() {
        withAnimation(.spring(response: 0.32, dampingFraction: 0.86)) {
            sidebarCollapsed.toggle()
        }
    }

    var body: some View {
        ZStack {
            NordTheme.windowBackground(colorScheme).ignoresSafeArea()
            HStack(spacing: 0) {
                Group {
                    if sidebarCollapsed {
                        ChatSidebarRailView(model: model, onExpand: toggleSidebar)
                    } else {
                        ChatSidebarView(model: model, onCollapse: toggleSidebar)
                    }
                }
                .frame(width: sidebarWidth)

                Rectangle()
                    .fill(NordTheme.border(colorScheme))
                    .frame(width: 1)
                ChatConversationView(model: model, onToggleSidebar: toggleSidebar)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .frame(minWidth: 880, minHeight: 600)
        .onAppear {
            model.refreshSessions()
            model.fetchDefaultTaskTemplate()
            model.fetchGroups()
        }
    }
}

// MARK: - Sidebar

struct ChatSidebarView: View {
    @ObservedObject var model: ChatModel
    var onCollapse: () -> Void
    @Environment(\.colorScheme) private var colorScheme
    /// Names of groups that are currently collapsed in the sidebar.
    /// Groups are collapsed by default — `seenGroups` tracks which group
    /// names have been initialized so newly discovered groups also start
    /// out collapsed without forcing previously expanded groups closed.
    @State private var collapsedGroups: Set<String> = []
    @State private var seenGroups: Set<String> = []
    @State private var isRefreshing: Bool = false

    private static let ungroupedName = "Other"

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // ── Sidebar header ───────────────────────────────────────────
            HStack(alignment: .center, spacing: 4) {
                Text("OmniAgent")
                    .font(OKFont.bodyEmphasized)
                    .okTighten(-0.15)
                    .foregroundColor(NordTheme.primaryText(colorScheme))
                Spacer()
                // Refresh — spinner replaces the icon while the fetch is in flight.
                // Fixed 28×28 frame keeps all three buttons on the same baseline.
                if isRefreshing {
                    ProgressView()
                        .scaleEffect(0.55)
                        .frame(width: 28, height: 28)
                } else {
                    SidebarIconButton(icon: "arrow.clockwise", help: "Refresh chats") {
                        isRefreshing = true
                        model.refreshSessions { isRefreshing = false }
                        model.fetchGroups()
                    }
                }
                SidebarIconButton(icon: "square.and.pencil", help: "New Chat") {
                    model.startNewChat()
                }
                SidebarIconButton(icon: "sidebar.left", help: "Collapse sidebar") {
                    onCollapse()
                }
            }
            .animation(.easeInOut(duration: 0.15), value: isRefreshing)
            .padding(.horizontal, 12)
            .padding(.top, 14)
            .padding(.bottom, 8)

            // Search field — filters sessions by title, project group,
            // and (lazily fetched) full user-message transcript so the
            // user can find a chat by anything they ever typed in it,
            // not just the first message.
            ChatSidebarSearchField(query: $model.sessionSearchQuery)
                .padding(.horizontal, 10)
                .padding(.bottom, 10)

            Rectangle()
                .fill(NordTheme.border(colorScheme))
                .frame(height: 1)
                .padding(.horizontal, 10)

            // Session list
            ScrollView {
                LazyVStack(spacing: 0) {
                    let visibleSessions = model.filteredSessions

                    // Pending-new-chat placeholder. Shown above all
                    // backend-sourced sessions so the not-yet-persisted
                    // chat is immediately visible after tapping "New
                    // Chat". Hidden while the user is searching to keep
                    // the filtered results clean.
                    if model.hasPendingNewChat && !model.isSessionSearchActive {
                        ChatPendingSessionRowView(
                            isActive: model.activeSessionId == nil,
                            onTap: { /* already on the pending new chat */ }
                        )
                        .id("pending-new-chat")
                        .padding(.top, 6)
                    }

                    if model.sessions.isEmpty && !model.hasPendingNewChat {
                        Text("No chats yet")
                            .font(.system(size: 12))
                            .foregroundColor(NordTheme.secondaryText(colorScheme).opacity(0.55))
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 12)
                            .padding(.top, 24)
                    } else if visibleSessions.isEmpty {
                        ChatSidebarSearchEmptyState(
                            query: model.sessionSearchQuery,
                            onClear: { model.clearSessionSearch() }
                        )
                        .padding(.horizontal, 12)
                        .padding(.top, 20)
                    } else {
                        // While a brand-new session is running, the
                        // backend hasn't yet assigned a `group_name`
                        // — so without special handling the session
                        // would land in the synthetic "Other" bucket
                        // (rendered at the bottom of the sidebar). To
                        // make the actively-running chat easy to find,
                        // pin it above every group while it streams.
                        // Once the final answer arrives, the existing
                        // refresh + `pendingExpandSessionId` flow
                        // moves it into its assigned group and expands
                        // that group, so this pinned row disappears
                        // automatically.
                        let pinnedRunningSession: AgentSessionInfo? = {
                            guard model.isRunning,
                                  let activeId = model.activeSessionId,
                                  let candidate = visibleSessions.first(where: { $0.id == activeId })
                            else { return nil }
                            let hasGroup = candidate.groupName?
                                .trimmingCharacters(in: .whitespacesAndNewlines)
                                .nilIfEmpty != nil
                            return hasGroup ? nil : candidate
                        }()

                        if let pinned = pinnedRunningSession {
                            ChatSessionRowView(
                                session: pinned,
                                isActive: pinned.id == model.activeSessionId,
                                onTap: { model.openSession(pinned) },
                                onDelete: { model.deleteSession(pinned) }
                            )
                            // Distinct identity from the grouped rows below.
                            // Without it, SwiftUI's LazyVStack can recycle
                            // this conditional cell into the grouped ForEach
                            // (or vice-versa) when the pinned row appears /
                            // disappears as the active session starts or stops
                            // running — carrying the stale "active" highlight
                            // onto the previously-selected session.
                            .id("pinned-\(pinned.id)")
                        }

                        // Build ordered groups from visible sessions.
                        // Sessions without an explicit `group_name` from the
                        // backend are bucketed into a synthetic "Other" group
                        // so every session lives under a collapsible header.
                        // The "Other" bucket is always pinned to the bottom
                        // of the list so named projects stay at the top.
                        // The currently-running ungrouped session (if any)
                        // is excluded here because it's already rendered
                        // above as the pinned row.
                        let grouped: [(String, [AgentSessionInfo])] = {
                            var order: [String] = []
                            var map: [String: [AgentSessionInfo]] = [:]
                            let pinnedId = pinnedRunningSession?.id
                            for s in visibleSessions where s.id != pinnedId {
                                let key = s.groupName?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
                                    ?? Self.ungroupedName
                                if map[key] == nil { order.append(key); map[key] = [] }
                                map[key]!.append(s)
                            }
                            let other = Self.ungroupedName
                            if let idx = order.firstIndex(of: other), idx != order.count - 1 {
                                order.remove(at: idx)
                                order.append(other)
                            }
                            return order.map { ($0, map[$0]!) }
                        }()
                        // Keyed by group name so SwiftUI tracks group views by
                        // content rather than position — prevents incorrect view
                        // reuse when a new group is inserted and existing groups
                        // shift positions.
                        let groupedByName: [String: [AgentSessionInfo]] = Dictionary(
                            uniqueKeysWithValues: grouped
                        )
                        let groupNames = grouped.map { $0.0 }

                        ForEach(groupNames, id: \.self) { name in
                            let sessions = groupedByName[name, default: []]
                            let isCollapsed = collapsedGroups.contains(name)

                            Button {
                                withAnimation(.easeInOut(duration: 0.18)) {
                                    if collapsedGroups.contains(name) {
                                        collapsedGroups.remove(name)
                                    } else {
                                        collapsedGroups.insert(name)
                                    }
                                }
                            } label: {
                                HStack(spacing: 5) {
                                    Image(systemName: isCollapsed ? "chevron.right" : "chevron.down")
                                        .font(.system(size: 9, weight: .bold))
                                    Text(name)
                                        .font(.system(size: 11, weight: .semibold))
                                        .tracking(0.1)
                                        .lineLimit(1)
                                    Spacer()
                                    Text("\(sessions.count)")
                                        .font(.system(size: 10, weight: .medium))
                                        .monospacedDigit()
                                }
                                .foregroundColor(NordTheme.secondaryText(colorScheme).opacity(0.45))
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.horizontal, 14)
                                .padding(.top, 12)
                                .padding(.bottom, 3)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .help(isCollapsed ? "Expand \(name)" : "Collapse \(name)")

                            if !isCollapsed {
                                ForEach(sessions) { session in
                                    ChatSessionRowView(
                                        session: session,
                                        isActive: session.id == model.activeSessionId,
                                        onTap: { model.openSession(session) },
                                        onDelete: { model.deleteSession(session) }
                                    )
                                    // Pin each row's identity to its session id
                                    // so the active highlight tracks the session
                                    // and never lingers on a recycled cell.
                                    .id("row-\(session.id)")
                                }
                            }
                        }
                        .onAppear { initializeCollapsedGroups(for: grouped.map { $0.0 }) }
                        .onChange(of: grouped.map { $0.0 }) { _, names in
                            initializeCollapsedGroups(for: names)
                        }
                        // React to one-shot expand requests from the model
                        // (e.g. when a final answer arrives and the backend
                        // updates / assigns the session's `group_name`).
                        // Resolve the session's *current* group from the
                        // freshly-refreshed list, then expand that group and
                        // clear the signal so it can fire again later.
                        .onChange(of: model.pendingExpandSessionId) { _, sessionId in
                            guard let sessionId else { return }
                            // Always read the group name from the live sessions array,
                            // not from visibleSessions (a local let that may have been
                            // captured from the previous render before the refresh that
                            // assigned the group completed).
                            let resolved = model.sessions.first(where: { $0.id == sessionId })
                            let groupName = resolved?.groupName?
                                .trimmingCharacters(in: .whitespacesAndNewlines)
                                .nilIfEmpty
                                ?? Self.ungroupedName
                            // Mark the group as "seen" so a subsequent
                            // initializeCollapsedGroups() pass (triggered
                            // by the same refresh) doesn't treat it as a
                            // newly-discovered group and re-collapse it.
                            seenGroups.insert(groupName)
                            withAnimation(.easeInOut(duration: 0.18)) {
                                _ = collapsedGroups.remove(groupName)
                            }
                            // Clear the signal so unrelated state changes
                            // don't re-trigger the same expansion later.
                            DispatchQueue.main.async {
                                model.pendingExpandSessionId = nil
                            }
                        }
                    }
                }
                .padding(.vertical, 6)
                .padding(.bottom, 16)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(NordTheme.panelBackground(colorScheme))
    }

    /// Ensure newly discovered groups start collapsed without affecting
    /// groups the user has already expanded in this session. Group names
    /// that disappear (e.g. the last session in a group was deleted) are
    /// also pruned from the tracking sets so they collapse cleanly if
    /// they ever reappear.
    private func initializeCollapsedGroups(for names: [String]) {
        let current = Set(names)
        let newNames = current.subtracting(seenGroups)
        if !newNames.isEmpty {
            collapsedGroups.formUnion(newNames)
            seenGroups.formUnion(newNames)
        }
        let removed = seenGroups.subtracting(current)
        if !removed.isEmpty {
            seenGroups.subtract(removed)
            collapsedGroups.subtract(removed)
        }
    }
}

// MARK: - Sidebar Search Field

/// Compact, rounded search field shown at the top of the sidebar. It
/// filters the session list by the session title, the assigned
/// project group, and every user message that has been sent in the
/// thread (the transcript is lazily fetched and cached when the
/// search becomes active so the haystack expands beyond the title).
///
/// UX details:
/// - Magnifying-glass leading icon for affordance.
/// - Inline clear ("x") button appears once the field has any content.
/// - Hover and focus states subtly raise the background / border so
///   the field feels interactive without competing with the chat list.
/// - Esc clears the query (and gives up focus); ⌘F focuses the field
///   from anywhere in the sidebar.
/// - No debouncing is needed because filtering happens in-memory over
///   the already-loaded session list.
private struct ChatSidebarSearchField: View {
    @Binding var query: String
    @Environment(\.colorScheme) private var colorScheme
    @FocusState private var isFocused: Bool
    @State private var isHovered: Bool = false

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 11, weight: .medium))
                .foregroundColor(
                    isFocused
                        ? NordTheme.primaryText(colorScheme).opacity(0.85)
                        : NordTheme.secondaryText(colorScheme).opacity(0.65)
                )
                .frame(width: 14)

            TextField("Search chats and messages", text: $query)
                .textFieldStyle(.plain)
                .font(.system(size: 12))
                .foregroundColor(NordTheme.primaryText(colorScheme))
                .focused($isFocused)
                .submitLabel(.search)
                .onExitCommand {
                    // Esc: clear if there's content, otherwise drop focus.
                    if query.isEmpty {
                        isFocused = false
                    } else {
                        query = ""
                    }
                }
                .accessibilityLabel("Search chats")
                .accessibilityHint("Filter the sidebar by chat title, project, or any user message in the chat")

            if !query.isEmpty {
                Button(action: { query = "" }) {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 12, weight: .regular))
                        .foregroundColor(NordTheme.secondaryText(colorScheme).opacity(0.7))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help("Clear search")
                .accessibilityLabel("Clear search")
                .transition(.opacity)
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .background(
            RoundedRectangle(cornerRadius: 7, style: .continuous)
                .fill(
                    isFocused
                        ? NordTheme.editorBackground(colorScheme)
                        : NordTheme.badgeFill(colorScheme).opacity(isHovered ? 1.0 : 0.75)
                )
        )
        .overlay(
            RoundedRectangle(cornerRadius: 7, style: .continuous)
                .strokeBorder(
                    isFocused
                        ? NordTheme.accent(colorScheme).opacity(0.45)
                        : NordTheme.border(colorScheme),
                    lineWidth: 1
                )
        )
        .onHover { isHovered = $0 }
        .animation(.easeInOut(duration: 0.12), value: isFocused)
        .animation(.easeInOut(duration: 0.12), value: isHovered)
        .animation(.easeInOut(duration: 0.12), value: query.isEmpty)
        // ⌘F focuses the search field from anywhere on the chat page.
        .background(
            Button(action: { isFocused = true }) { EmptyView() }
                .keyboardShortcut("f", modifiers: [.command])
                .frame(width: 0, height: 0)
                .opacity(0)
                .accessibilityHidden(true)
        )
    }
}

/// Empty state shown in the sidebar when a search query is active but
/// no sessions match it. Keeps the user oriented and gives them a
/// one-click way to reset the filter.
private struct ChatSidebarSearchEmptyState: View {
    let query: String
    let onClear: () -> Void
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundColor(NordTheme.secondaryText(colorScheme).opacity(0.6))
                Text("No matches")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundColor(NordTheme.primaryText(colorScheme).opacity(0.85))
            }

            Text("No chats or messages match \u{201C}\(query)\u{201D}.")
                .font(.system(size: 11))
                .foregroundColor(NordTheme.secondaryText(colorScheme).opacity(0.65))
                .lineLimit(2)
                .truncationMode(.tail)
                .fixedSize(horizontal: false, vertical: true)

            Button(action: onClear) {
                Text("Clear search")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundColor(NordTheme.accent(colorScheme))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Clear search")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct SidebarIconButton: View {
    let icon: String
    let help: String
    let action: () -> Void
    @Environment(\.colorScheme) private var colorScheme
    @State private var hovered = false

    var body: some View {
        Button(action: action) {
            // Render each SF Symbol inside a fixed-size square first so
            // glyphs with different intrinsic widths (e.g.
            // `square.and.pencil` vs. `sidebar.left`) share an identical
            // optical bounding box. Without this, neighbouring icon
            // buttons in the sidebar header look subtly misaligned even
            // though their outer 28×28 hit targets are the same size.
            Image(systemName: icon)
                .font(.system(size: 13, weight: .medium))
                .symbolRenderingMode(.monochrome)
                .frame(width: 16, height: 16, alignment: .center)
                .foregroundColor(
                    hovered
                        ? NordTheme.primaryText(colorScheme)
                        : NordTheme.secondaryText(colorScheme).opacity(0.7)
                )
                .frame(width: 28, height: 28, alignment: .center)
                .background(
                    RoundedRectangle(cornerRadius: 6, style: .continuous)
                        .fill(hovered ? NordTheme.badgeFill(colorScheme) : Color.clear)
                )
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(help)
        .onHover { hovered = $0 }
        .animation(.easeInOut(duration: 0.12), value: hovered)
    }
}

// MARK: - Collapsed Sidebar Rail

struct ChatSidebarRailView: View {
    @ObservedObject var model: ChatModel
    var onExpand: () -> Void
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        VStack(spacing: 0) {
            // Expand button
            Button(action: onExpand) {
                Image(systemName: "sidebar.left")
                    .font(.system(size: 14, weight: .medium))
                    .foregroundColor(NordTheme.secondaryText(colorScheme))
                    .frame(width: 36, height: 36)
                    .background(
                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                            .fill(Color.clear)
                    )
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("Expand sidebar")
            .padding(.top, 16)

            // New chat button
            Button(action: model.startNewChat) {
                Image(systemName: "square.and.pencil")
                    .font(.system(size: 14, weight: .medium))
                    .foregroundColor(NordTheme.accent(colorScheme))
                    .frame(width: 36, height: 36)
                    .background(
                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                            .fill(NordTheme.accent(colorScheme).opacity(0.10))
                    )
            }
            .buttonStyle(.plain)
            .help("New Chat")
            .padding(.top, 4)

            Rectangle()
                .fill(NordTheme.border(colorScheme))
                .frame(height: 1)
                .padding(.horizontal, 10)
                .padding(.vertical, 10)

            // Recent session dots
            ScrollView(.vertical, showsIndicators: false) {
                LazyVStack(spacing: 6) {
                    // Pending-new-chat placeholder dot. Mirrors the
                    // expanded sidebar's placeholder row so the unsaved
                    // chat is also visible while the sidebar is in
                    // collapsed/rail mode.
                    if model.hasPendingNewChat {
                        let isActive = model.activeSessionId == nil
                        ZStack {
                            Circle()
                                .fill(
                                    isActive
                                        ? NordTheme.accent(colorScheme).opacity(0.18)
                                        : NordTheme.badgeFill(colorScheme)
                                )
                                .frame(width: 34, height: 34)
                                .overlay(
                                    Circle()
                                        .strokeBorder(
                                            isActive
                                                ? NordTheme.accent(colorScheme).opacity(0.40)
                                                : NordTheme.border(colorScheme),
                                            lineWidth: 1
                                        )
                                )
                            Image(systemName: "square.and.pencil")
                                .font(.system(size: 11, weight: .medium))
                                .foregroundColor(
                                    isActive
                                        ? NordTheme.accent(colorScheme)
                                        : NordTheme.secondaryText(colorScheme)
                                )
                        }
                        .id("rail-pending-new-chat")
                        .help("New chat (unsaved)")
                    }

                    ForEach(model.sessions.prefix(12)) { session in
                        Button(action: { model.openSession(session) }) {
                            ZStack {
                                Circle()
                                    .fill(
                                        session.id == model.activeSessionId
                                            ? NordTheme.accent(colorScheme).opacity(0.18)
                                            : NordTheme.badgeFill(colorScheme)
                                    )
                                    .frame(width: 34, height: 34)
                                    .overlay(
                                        Circle()
                                            .strokeBorder(
                                                session.id == model.activeSessionId
                                                    ? NordTheme.accent(colorScheme).opacity(0.40)
                                                    : NordTheme.border(colorScheme),
                                                lineWidth: 1
                                            )
                                    )
                                Text(String(session.title.prefix(1)).uppercased())
                                    .font(.system(size: 12, weight: .semibold))
                                    .foregroundColor(
                                        session.id == model.activeSessionId
                                            ? NordTheme.accent(colorScheme)
                                            : NordTheme.secondaryText(colorScheme)
                                    )
                            }
                        }
                        .buttonStyle(.plain)
                        .id("rail-\(session.id)")
                        .help(session.title)
                    }
                }
                .padding(.vertical, 4)
            }

            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
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
            HStack(spacing: 0) {
                // Active indicator bar
                RoundedRectangle(cornerRadius: 1.5)
                    .fill(isActive ? NordTheme.accent(colorScheme) : Color.clear)
                    .frame(width: 3)
                    .padding(.vertical, 8)

                Text(session.title)
                    .font(.system(size: 13, weight: isActive ? .medium : .regular))
                    .foregroundColor(
                        isActive
                            ? NordTheme.primaryText(colorScheme)
                            : isHovered
                                ? NordTheme.primaryText(colorScheme).opacity(0.8)
                                : NordTheme.secondaryText(colorScheme)
                    )
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.leading, 9)

                if isHovered {
                    Button(action: onDelete) {
                        Image(systemName: "xmark")
                            .font(.system(size: 8.5, weight: .semibold))
                            .foregroundColor(NordTheme.secondaryText(colorScheme).opacity(0.55))
                            .frame(width: 17, height: 17)
                            .background(Circle().fill(NordTheme.badgeFill(colorScheme)))
                    }
                    .buttonStyle(.plain)
                    .transition(.opacity.combined(with: .scale(scale: 0.85)))
                    .padding(.trailing, 7)
                }
            }
            .frame(height: 34)
            .padding(.leading, 8)
            .background(
                RoundedRectangle(cornerRadius: 7, style: .continuous)
                    .fill(
                        isActive
                            ? NordTheme.accent(colorScheme).opacity(colorScheme == .dark ? 0.12 : 0.08)
                            : isHovered
                                ? NordTheme.badgeFill(colorScheme)
                                : Color.clear
                    )
            )
            .padding(.horizontal, 7)
        }
        .buttonStyle(.plain)
        .animation(.easeInOut(duration: 0.1), value: isHovered)
        .onHover { isHovered = $0 }
    }
}

// MARK: - Pending New Chat Row

/// Synthetic sidebar row representing a "New Chat" that the user has
/// started (via the compose button) but has not yet sent the first
/// message for. Rendered above the grouped session list so the
/// not-yet-persisted chat is immediately visible. Once the user sends
/// the first turn, the real session row replaces this placeholder.
struct ChatPendingSessionRowView: View {
    let isActive: Bool
    let onTap: () -> Void

    @Environment(\.colorScheme) private var colorScheme
    @State private var isHovered = false

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: 0) {
                RoundedRectangle(cornerRadius: 1.5)
                    .fill(isActive ? NordTheme.accent(colorScheme) : Color.clear)
                    .frame(width: 3)
                    .padding(.vertical, 8)

                HStack(spacing: 6) {
                    Image(systemName: "square.and.pencil")
                        .font(.system(size: 10, weight: .medium))
                        .foregroundColor(
                            isActive
                                ? NordTheme.accent(colorScheme)
                                : NordTheme.secondaryText(colorScheme).opacity(0.6)
                        )
                    Text("New Chat")
                        .font(.system(size: 13, weight: isActive ? .medium : .regular))
                        .foregroundColor(
                            isActive
                                ? NordTheme.primaryText(colorScheme)
                                : NordTheme.secondaryText(colorScheme)
                        )
                        .lineLimit(1)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.leading, 9)
            }
            .frame(height: 34)
            .padding(.leading, 8)
            .background(
                RoundedRectangle(cornerRadius: 7, style: .continuous)
                    .fill(
                        isActive
                            ? NordTheme.accent(colorScheme).opacity(colorScheme == .dark ? 0.12 : 0.08)
                            : isHovered
                                ? NordTheme.badgeFill(colorScheme)
                                : Color.clear
                    )
            )
            .padding(.horizontal, 7)
        }
        .buttonStyle(.plain)
        .animation(.easeInOut(duration: 0.1), value: isHovered)
        .onHover { isHovered = $0 }
        .accessibilityLabel("New chat (unsaved)")
    }
}

// MARK: - Conversation Area

struct ChatConversationView: View {
    @ObservedObject var model: ChatModel
    var onToggleSidebar: () -> Void
    @Environment(\.colorScheme) private var colorScheme

    /// The "landing" layout — Codex-style centered composer with
    /// quick-access tiles — is shown for a brand-new chat (no active
    /// session yet, no messages, not currently hydrating history).
    /// Once the user sends a turn or opens an existing session, we
    /// switch to the standard scrolling transcript layout.
    private var showLandingLayout: Bool {
        model.activeSessionId == nil
            && model.messages.isEmpty
            && !model.isLoadingSessionHistory
            && !model.isRunning
    }

    var body: some View {
        VStack(spacing: 0) {
            ChatHeaderBar(model: model, onToggleSidebar: onToggleSidebar)

            Rectangle()
                .fill(NordTheme.border(colorScheme))
                .frame(height: 1)

            if showLandingLayout {
                ChatNewChatLandingView(model: model)
            } else {
                conversationContent
                    .overlay(alignment: .center) {
                        // Show the loading indicator as an overlay so the
                        // ScrollView stays mounted across the open-session
                        // transition. This avoids the "black flash" caused
                        // by tearing the conversation view down and rebuilding
                        // it once the history fetch completes.
                        if model.isLoadingSessionHistory, model.messages.isEmpty {
                            ChatLoadingStateView()
                                .transition(.opacity)
                        }
                    }
                    .animation(.easeInOut(duration: 0.18), value: model.isLoadingSessionHistory)
            }

            if let err = model.lastErrorMessage {
                ChatErrorBanner(message: err) { model.lastErrorMessage = nil }
            }

            if !showLandingLayout {
                LandingInputComposer(model: model)
                    .frame(maxWidth: 980)
                    .frame(maxWidth: .infinity, alignment: .center)
                    .padding(.horizontal, 22)
                    .padding(.vertical, 14)
                    .background(NordTheme.editorBackground(colorScheme))
            }
        }
        .background(NordTheme.editorBackground(colorScheme))
    }

    @ViewBuilder
    private var conversationContent: some View {
        // Switching from `LazyVStack` to `VStack` here is intentional.
        // The transcript is already capped at `ChatModel.maxVisibleMessages`
        // (currently 30), so eager rendering is cheap, and it fixes two
        // bugs in the previous implementation:
        //   1. With the lazy stack nested in a centred 980-pt frame inside
        //      a ScrollView, SwiftUI sometimes failed to materialize rows
        //      until the user scrolled, leaving the view blank.
        //   2. `proxy.scrollTo("bottom")` ran *before* lazy rows had been
        //      laid out, so the animated scroll-on-load fired against
        //      stale geometry and produced a jarring jump.
        //
        // We also drop the `withAnimation { proxy.scrollTo }` cascade and
        // rely on `defaultScrollAnchor(.bottom)`. The scroll view sticks
        // to the bottom as new content streams in, and lands at the
        // bottom immediately when an existing chat is opened — no
        // animated jump, no flash of "top-then-jump-to-bottom".
        ScrollViewReader { proxy in
            ScrollView {
                VStack(spacing: 0) {
                    if model.messages.isEmpty, !model.isLoadingSessionHistory {
                        ChatEmptyStateView()
                    }
                    if model.trimmedOlderMessageCount > 0, !model.messages.isEmpty {
                        ChatTrimmedHistoryNotice(trimmedCount: model.trimmedOlderMessageCount)
                            .padding(.vertical, 8)
                    }
                    ForEach(Array(model.messages.enumerated()), id: \.element.id) { index, message in
                        ChatMessageView(
                            message: message,
                            isStreaming: model.isRunning && message.id == model.messages.last?.id
                        )
                        // `.equatable()` lets SwiftUI short-circuit body
                        // evaluation for messages whose content + streaming
                        // state are unchanged. This avoids re-parsing markdown
                        // and re-laying out historical rows on every token
                        // streamed into the current turn.
                        .equatable()
                        .padding(.top, index == 0 ? 8 : 18)
                        .padding(.bottom, index == model.messages.count - 1 ? 8 : 0)
                    }
                    Color.clear.frame(height: 1).id("bottom")
                }
                .padding(.horizontal, 32)
                .padding(.top, 12)
                .padding(.bottom, 16)
                .frame(maxWidth: 820, alignment: .leading)
                .frame(maxWidth: .infinity, alignment: .center)
            }
            .defaultScrollAnchor(.bottom)
            // Only animate scroll-to-bottom for *live* turn activity. New
            // assistant blocks and the user's own sends should glide into
            // view, but opening an existing chat (where messages.count
            // jumps from 0 to N in a single hydration step) must not —
            // that's the "auto-scroll disrupts loading" bug. The
            // `isRunning` guard keeps the animation scoped to the
            // active turn.
            .onChange(of: model.messages.last?.blocks.count ?? 0) { _, _ in
                guard model.isRunning else { return }
                withAnimation(.easeOut(duration: 0.2)) {
                    proxy.scrollTo("bottom", anchor: .bottom)
                }
            }
            .onChange(of: model.messages.count) { oldCount, newCount in
                // Animate when the user adds a turn (count increments by
                // 1 or 2 during an active run). Skip the initial hydration
                // jump from 0 → N, which is handled by
                // `defaultScrollAnchor(.bottom)`.
                guard model.isRunning, newCount > oldCount, oldCount > 0 else { return }
                withAnimation(.easeOut(duration: 0.2)) {
                    proxy.scrollTo("bottom", anchor: .bottom)
                }
            }
        }
    }
}

// MARK: - Header Bar

struct ChatHeaderBar: View {
    @ObservedObject var model: ChatModel
    var onToggleSidebar: () -> Void
    @Environment(\.colorScheme) private var colorScheme
    @State private var pulse = false

    var body: some View {
        HStack(spacing: 8) {
            Button(action: { model.startNewChat() }) {
                Image(systemName: "square.and.pencil")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundColor(NordTheme.secondaryText(colorScheme).opacity(0.75))
                    .frame(width: 30, height: 30)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("New Chat")

            Text(model.activeSessionTitle)
                .font(.system(size: 14, weight: .semibold))
                .foregroundColor(NordTheme.primaryText(colorScheme))
                .lineLimit(1)
                .truncationMode(.tail)

            Spacer()

            if model.isRunning {
                // Pulsing dot + label
                HStack(spacing: 5) {
                    Circle()
                        .fill(NordTheme.accentGreen(colorScheme))
                        .frame(width: 6, height: 6)
                        .scaleEffect(pulse ? 1.4 : 1.0)
                        .opacity(pulse ? 0.5 : 1.0)
                        .animation(
                            .easeInOut(duration: 0.9).repeatForever(autoreverses: true),
                            value: pulse
                        )
                        .onAppear { pulse = true }
                        .onDisappear { pulse = false }
                    Text("Running")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundColor(NordTheme.accentGreen(colorScheme))
                }
                .padding(.horizontal, 9)
                .padding(.vertical, 4)
                .background(
                    Capsule()
                        .fill(NordTheme.accentGreen(colorScheme).opacity(
                            colorScheme == .dark ? 0.10 : 0.08
                        ))
                )
                .overlay(
                    Capsule().strokeBorder(
                        NordTheme.accentGreen(colorScheme).opacity(0.25),
                        lineWidth: 1
                    )
                )
                .transition(.opacity.combined(with: .scale(scale: 0.92)))

                // Stop button
                Button(action: model.cancelCurrentTurn) {
                    HStack(spacing: 4) {
                        Image(systemName: "stop.fill")
                            .font(.system(size: 9, weight: .bold))
                        Text("Stop")
                            .font(.system(size: 11, weight: .medium))
                    }
                    .foregroundColor(.red.opacity(0.85))
                    .padding(.horizontal, 9)
                    .padding(.vertical, 4)
                    .background(
                        Capsule()
                            .fill(Color.red.opacity(colorScheme == .dark ? 0.10 : 0.07))
                    )
                    .overlay(
                        Capsule().strokeBorder(Color.red.opacity(0.22), lineWidth: 1)
                    )
                }
                .buttonStyle(.plain)
                .transition(.opacity.combined(with: .scale(scale: 0.92)))
            }
        }
        .animation(.easeInOut(duration: 0.18), value: model.isRunning)
        .padding(.horizontal, 20)
        .padding(.vertical, 12)
        .frame(minHeight: 52)
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
                .font(OKFont.title)
                .foregroundColor(NordTheme.primaryText(colorScheme))

            Text("Ask anything. Existing chats are in the sidebar.")
                .font(OKFont.bodyCompact)
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
                .font(OKFont.eyebrow)
                .foregroundColor(NordTheme.secondaryText(colorScheme))
            Text("Showing the latest \(ChatModel.maxVisibleMessages) of \(ChatModel.maxVisibleMessages + trimmedCount) messages")
                .font(OKFont.captionSmall)
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
                .font(OKFont.bodyCompact)
                .foregroundColor(NordTheme.secondaryText(colorScheme))
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 96)
    }
}

// MARK: - New Chat Landing

struct ChatNewChatLandingView: View {
    @ObservedObject var model: ChatModel
    @Environment(\.colorScheme) private var colorScheme

    private let tileColumns = [
        GridItem(.adaptive(minimum: 160, maximum: 260), spacing: 10)
    ]

    var body: some View {
        GeometryReader { geo in
            ScrollView {
                VStack(spacing: 0) {
                    // Greeting + composer, vertically centered
                    VStack(spacing: 20) {
                        // Greeting
                        VStack(spacing: 7) {
                            Image(systemName: "sparkles")
                                .font(.system(size: 26, weight: .light))
                                .foregroundColor(NordTheme.accentPurple(colorScheme).opacity(0.65))
                            Text("What can I help with?")
                                .font(.system(size: 19, weight: .semibold))
                                .foregroundColor(NordTheme.primaryText(colorScheme))
                        }
                        .frame(maxWidth: .infinity)

                        // Split input composer (no background fill)
                        LandingInputComposer(model: model)
                    }
                    .padding(.bottom, 28)

                    // ── Tiles grid ──────────────────────────────────────
                    VStack(alignment: .leading, spacing: 20) {

                        // Task Instructions — top 2 recent + "New", all in one row
                        VStack(alignment: .leading, spacing: 9) {
                            HStack(alignment: .firstTextBaseline) {
                                Text("TASK INSTRUCTIONS")
                                    .font(.system(size: 10, weight: .semibold))
                                    .foregroundColor(NordTheme.secondaryText(colorScheme).opacity(0.7))
                                    .tracking(0.6)
                                Spacer()
                                Button("Manage") {
                                    AppDelegate.shared?.showTaskInstructionsWindow()
                                }
                                .font(.system(size: 11, weight: .medium))
                                .foregroundColor(NordTheme.accent(colorScheme))
                                .buttonStyle(.plain)
                            }

                            HStack(spacing: 10) {
                                ForEach(Array(model.availableTaskTemplates.suffix(2).reversed())) { template in
                                    TaskInstructionTile(template: template, model: model)
                                        .frame(maxWidth: 200)
                                }
                                LandingAddTile(
                                    icon: "plus",
                                    label: "New",
                                    help: "Add a task instruction"
                                ) {
                                    AppDelegate.shared?.showTaskInstructionsWindow()
                                }
                                .frame(width: 72)
                                Spacer(minLength: 0)
                            }
                        }

                        // Tools
                        LandingTileSection(title: "Tools", actionLabel: nil, action: nil) {
                            FeatureTile(
                                icon: "server.rack",
                                title: "MCP Servers",
                                description: "Connect external tools and APIs via Model Context Protocol"
                            ) { AppDelegate.shared?.showMCPServersWindow() }

                            FeatureTile(
                                icon: "calendar.badge.clock",
                                title: "Scheduled Jobs",
                                description: "Run agent tasks automatically on a recurring schedule"
                            ) { AppDelegate.shared?.showScheduledJobsWindow() }
                        }
                    }
                }
                .padding(.horizontal, 44)
                .frame(maxWidth: 680)
                .frame(maxWidth: .infinity)
                // Centre vertically when content is shorter than the view;
                // scroll naturally when tiles overflow.
                .frame(minHeight: geo.size.height, alignment: .center)
                .padding(.vertical, 36)
            }
        }
    }
}

// MARK: - Context Window Indicator

/// Compact circular gauge shown next to the send button. Mirrors the
/// "tokens left" badge from the Omni Agent thinking view, but in a
/// minimal ring form so it fits inline with the composer's footer
/// row. Visible whenever the active session exposes a non-zero
/// `contextBudget`. The arc represents the *used* portion of the
/// budget; hover for the exact remaining / total figures.
struct ContextWindowIndicator: View {
    let remaining: Int
    let budget: Int
    let colorScheme: ColorScheme

    /// Fraction of the context window that has already been consumed,
    /// clamped to `0...1` so a backend mismatch (e.g. `remaining` ever
    /// briefly exceeding `budget`) can't draw an oversized arc.
    private var usedFraction: Double {
        guard budget > 0 else { return 0 }
        let used = Double(max(0, budget - remaining))
        return min(1, max(0, used / Double(budget)))
    }

    /// Tint follows how *close to full* the context window is, so the
    /// ring nudges the user toward starting a new chat before the
    /// backend forcibly truncates older turns.
    private var tint: Color {
        switch usedFraction {
        case ..<0.6: return NordTheme.accentGreen(colorScheme)
        case ..<0.85: return NordTheme.accentAmber(colorScheme)
        default: return Color.red
        }
    }

    private var tooltip: String {
        "\(remaining.formatted()) of \(budget.formatted()) context tokens left"
    }

    var body: some View {
        ZStack {
            Circle()
                .stroke(
                    NordTheme.border(colorScheme).opacity(0.9),
                    lineWidth: 1.8
                )
            Circle()
                .trim(from: 0, to: CGFloat(usedFraction))
                .stroke(
                    tint,
                    style: StrokeStyle(lineWidth: 1.8, lineCap: .round)
                )
                .rotationEffect(.degrees(-90))
                .animation(.easeInOut(duration: 0.25), value: usedFraction)
        }
        .frame(width: 14, height: 14)
        .help(tooltip)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Context window")
        .accessibilityValue(tooltip)
    }
}

// MARK: - Landing Input Composer

/// Polished, single-card chat composer used at the bottom of the
/// conversation view: an expanding text area on top and a borderless
/// footer row underneath with project / task-instruction menus, the
/// context-window indicator, a keyboard-hint, and a circular send /
/// stop button. The whole surface uses a real fill + soft drop shadow
/// so it reads as a self-contained card lifted above the transcript.
private struct LandingInputComposer: View {
    @ObservedObject var model: ChatModel
    @Environment(\.colorScheme) private var colorScheme
    @State private var isFocused = false
    @State private var inputHeight: CGFloat = 88
    @State private var isSendHovered = false

    private var inputIsEmpty: Bool {
        model.inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var isStopState: Bool {
        model.isRunning && inputIsEmpty
    }

    // The composer surface gets a real fill (not `Color.clear`) so the
    // input visually lifts above the conversation transcript and the
    // border/shadow read as a single layered card rather than a thin
    // outline floating over the editor background.
    private var surfaceFill: Color {
        switch colorScheme {
        case .dark:
            return Color(red: 30 / 255, green: 32 / 255, blue: 38 / 255)
        default:
            return Color(red: 252 / 255, green: 252 / 255, blue: 254 / 255)
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            // ── Top: text area ───────────────────────────────────────
            ZStack(alignment: .topLeading) {
                if model.inputText.isEmpty {
                    Text("Ask OmniAgent anything…")
                        .font(.system(size: 13))
                        .foregroundColor(NordTheme.secondaryText(colorScheme).opacity(0.45))
                        .padding(.horizontal, 16)
                        .padding(.vertical, 12)
                        .allowsHitTesting(false)
                }
                ChatNSTextInput(
                    text: $model.inputText,
                    isFocused: $isFocused,
                    colorScheme: colorScheme,
                    onSend: {
                        guard !inputIsEmpty else { return }
                        model.sendCurrentInput()
                    },
                    onRecallHistory: { model.recallLastUserMessage() }
                )
                .frame(height: inputHeight)
                .padding(.horizontal, 4)
                .onChange(of: model.inputText) { _, newValue in
                    let lineCount = max(1, newValue.components(separatedBy: "\n").count)
                    inputHeight = max(88, min(CGFloat(lineCount) * 20 + 40, 220))
                }
            }
            .padding(.top, 4)
            .contentShape(Rectangle())
            .onTapGesture { isFocused = true }

            // ── Bottom: task instruction + send/stop ─────────────────
            // The toolbar is intentionally borderless — the divider
            // line we used to draw between the input and the controls
            // pinched the rounded outer card and made the composer
            // look cramped. Vertical padding alone gives plenty of
            // breathing room and keeps the whole surface feeling like
            // one connected control.
            HStack(spacing: 8) {
                // Task instruction dropdown
                if !model.availableTaskTemplates.isEmpty {
                    Menu {
                        ForEach(model.availableTaskTemplates) { tpl in
                            Button {
                                model.setDefaultTaskTemplate(id: tpl.id)
                            } label: {
                                if tpl.id == model.defaultTaskTemplate?.id {
                                    Label(tpl.heading, systemImage: "checkmark")
                                } else {
                                    Text(tpl.heading)
                                }
                            }
                        }
                        Divider()
                        Button("No instruction") {
                            model.setDefaultTaskTemplate(id: nil)
                        }
                    } label: {
                        ComposerPillLabel(
                            icon: "text.badge.star",
                            title: model.defaultTaskTemplate?.heading ?? "No instruction",
                            isActive: model.defaultTaskTemplate != nil,
                            activeColor: NordTheme.accent(colorScheme),
                            colorScheme: colorScheme
                        )
                    }
                    .menuStyle(.borderlessButton)
                    .fixedSize()
                    .disabled(model.isUpdatingDefaultTaskTemplate)
                } else {
                    Button {
                        AppDelegate.shared?.showTaskInstructionsWindow()
                    } label: {
                        ComposerPillLabel(
                            icon: "plus",
                            title: "Add instruction",
                            isActive: false,
                            activeColor: NordTheme.accent(colorScheme),
                            colorScheme: colorScheme,
                            showsChevron: false
                        )
                    }
                    .buttonStyle(.plain)
                }

                // Project path / group dropdown
                Menu {
                    Button {
                        model.selectedGroup = nil
                    } label: {
                        if model.selectedGroup == nil {
                            Label("Select project", systemImage: "checkmark")
                        } else {
                            Text("Select project")
                        }
                    }

                    let distinctGroups: [AgentGroupInfo] = {
                        var seen = Set<String>()
                        return model.availableGroups.filter { seen.insert($0.groupName).inserted }
                    }()
                    if !distinctGroups.isEmpty {
                        Divider()
                        ForEach(distinctGroups) { group in
                            Button {
                                model.selectedGroup = group
                            } label: {
                                if model.selectedGroup?.groupName == group.groupName {
                                    Label(group.groupName, systemImage: "checkmark")
                                } else {
                                    Text(group.groupName)
                                }
                            }
                        }
                    }
                } label: {
                    ComposerPillLabel(
                        icon: "folder",
                        title: model.selectedGroup?.groupName ?? "Select project",
                        isActive: model.selectedGroup != nil,
                        activeColor: NordTheme.accentGreen(colorScheme),
                        colorScheme: colorScheme
                    )
                }
                .menuStyle(.borderlessButton)
                .fixedSize()

                Spacer()

                // Context window indicator (shown when the active
                // session has a known token budget). Sits to the left
                // of Send so the spinner mirrors the "tokens left"
                // badge from the Omni Agent session view.
                if let session = model.activeSession, session.contextBudget > 0 {
                    ContextWindowIndicator(
                        remaining: session.remainingContextTokens,
                        budget: session.contextBudget,
                        colorScheme: colorScheme
                    )
                    .transition(.opacity)
                }

                // Subtle keyboard hint (`⏎` / `⇧⏎`) — only visible when
                // the composer has focus and content, mirroring the
                // hints surfaced by other production AI chat inputs.
                if isFocused, !inputIsEmpty {
                    HStack(spacing: 3) {
                        Text("⇧⏎")
                            .font(.system(size: 9, weight: .semibold, design: .rounded))
                        Text("newline")
                            .font(.system(size: 9, weight: .medium))
                    }
                    .foregroundColor(NordTheme.secondaryText(colorScheme).opacity(0.55))
                    .padding(.horizontal, 6)
                    .transition(.opacity)
                }

                // Send / Stop
                // • Has text → always send (even mid-run; server queues it)
                // • No text + running → stop button
                // • No text + idle → disabled send button
                Button {
                    if !inputIsEmpty { model.sendCurrentInput() }
                    else if model.isRunning { model.cancelCurrentTurn() }
                } label: {
                    ZStack {
                        Circle()
                            .fill(sendButtonFill)
                            .frame(width: 32, height: 32)
                            .shadow(
                                color: sendButtonShadowColor,
                                radius: isSendHovered && !inputIsEmpty ? 6 : 0,
                                x: 0, y: 1
                            )
                        Image(systemName: isStopState ? "stop.fill" : "arrow.up")
                            .font(.system(size: 13, weight: .bold))
                            .foregroundColor(sendButtonIconColor)
                    }
                    .scaleEffect(isSendHovered && !inputIsEmpty ? 1.05 : 1.0)
                    .animation(.easeInOut(duration: 0.14), value: model.isRunning)
                    .animation(.easeInOut(duration: 0.12), value: isSendHovered)
                    .animation(.easeInOut(duration: 0.12), value: inputIsEmpty)
                    .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .disabled(inputIsEmpty && !model.isRunning)
                .onHover { isSendHovered = $0 }
                .help(isStopState ? "Stop current turn" : "Send message  ·  ⏎")
            }
            .padding(.horizontal, 10)
            .padding(.top, 6)
            .padding(.bottom, 8)
            .animation(.easeInOut(duration: 0.12), value: isFocused)
            .animation(.easeInOut(duration: 0.12), value: inputIsEmpty)
        }
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(surfaceFill)
        )
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(
                    isFocused
                        ? NordTheme.accent(colorScheme).opacity(0.55)
                        : NordTheme.border(colorScheme),
                    lineWidth: isFocused ? 1.4 : 1
                )
        )
        .shadow(
            color: .black.opacity(
                colorScheme == .dark
                    ? (isFocused ? 0.30 : 0.20)
                    : (isFocused ? 0.10 : 0.06)
            ),
            radius: isFocused ? 14 : 9,
            x: 0,
            y: isFocused ? 4 : 2
        )
        .animation(.easeInOut(duration: 0.16), value: isFocused)
    }

    // MARK: - Send button styling

    private var sendButtonFill: Color {
        if isStopState { return Color.red }
        if inputIsEmpty { return NordTheme.border(colorScheme).opacity(1.8) }
        return NordTheme.accent(colorScheme)
    }

    private var sendButtonIconColor: Color {
        if inputIsEmpty, !model.isRunning {
            return NordTheme.secondaryText(colorScheme).opacity(0.45)
        }
        return .white
    }

    private var sendButtonShadowColor: Color {
        if isStopState { return Color.red.opacity(0.35) }
        return NordTheme.accent(colorScheme).opacity(0.35)
    }
}

// MARK: - Composer Pill Label

/// Reusable label used by the dropdowns inside `LandingInputComposer`.
/// Centralising the styling keeps the project/instruction/add buttons
/// visually consistent and gives the composer a tighter, more
/// production-ready look.
private struct ComposerPillLabel: View {
    let icon: String
    let title: String
    let isActive: Bool
    let activeColor: Color
    let colorScheme: ColorScheme
    var showsChevron: Bool = true

    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: icon)
                .font(.system(size: 10, weight: .semibold))
            Text(title)
                .font(.system(size: 11.5, weight: .medium))
                .lineLimit(1)
            if showsChevron {
                Image(systemName: "chevron.down")
                    .font(.system(size: 8, weight: .semibold))
                    .opacity(0.65)
            }
        }
        .foregroundColor(
            isActive
                ? activeColor
                : NordTheme.secondaryText(colorScheme).opacity(0.65)
        )
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(
            Capsule()
                .fill(
                    isActive
                        ? activeColor.opacity(0.10)
                        : NordTheme.badgeFill(colorScheme).opacity(0.85)
                )
        )
        .overlay(
            Capsule()
                .strokeBorder(
                    isActive
                        ? activeColor.opacity(0.25)
                        : NordTheme.border(colorScheme).opacity(0.6),
                    lineWidth: 0.5
                )
        )
    }
}

// MARK: - Tile Section Header

private struct LandingTileSection<Content: View>: View {
    let title: String
    let actionLabel: String?
    let action: (() -> Void)?
    @ViewBuilder let content: () -> Content
    @Environment(\.colorScheme) private var colorScheme

    private let columns = [GridItem(.adaptive(minimum: 154, maximum: 260), spacing: 10)]

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            // Section header
            HStack(alignment: .firstTextBaseline) {
                Text(title.uppercased())
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundColor(NordTheme.secondaryText(colorScheme).opacity(0.7))
                    .tracking(0.6)
                Spacer()
                if let label = actionLabel, let action = action {
                    Button(action: action) {
                        Text(label)
                            .font(.system(size: 11, weight: .medium))
                            .foregroundColor(NordTheme.accent(colorScheme))
                    }
                    .buttonStyle(.plain)
                }
            }

            LazyVGrid(columns: columns, spacing: 10) {
                content()
            }
        }
    }
}

// MARK: - Tile Components

private struct TaskInstructionTile: View {
    let template: APIClient.TaskTemplateDTO
    @ObservedObject var model: ChatModel
    @Environment(\.colorScheme) private var colorScheme
    @State private var hovered = false

    private var isDefault: Bool { template.id == model.defaultTaskTemplate?.id }

    var body: some View {
        Button {
            model.setDefaultTaskTemplate(id: isDefault ? nil : template.id)
        } label: {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 5) {
                    Image(systemName: isDefault ? "checkmark.circle.fill" : "circle")
                        .font(.system(size: 11))
                        .foregroundColor(
                            isDefault
                                ? NordTheme.accent(colorScheme)
                                : NordTheme.secondaryText(colorScheme).opacity(0.35)
                        )
                    Text(template.heading)
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundColor(NordTheme.primaryText(colorScheme))
                        .lineLimit(1)
                }
                Text(template.instructions)
                    .font(.system(size: 11))
                    .foregroundColor(NordTheme.secondaryText(colorScheme))
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity, minHeight: 66, alignment: .topLeading)
            .background(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(
                        isDefault
                            ? NordTheme.accent(colorScheme).opacity(colorScheme == .dark ? 0.12 : 0.08)
                            : hovered
                                ? NordTheme.badgeFill(colorScheme)
                                : NordTheme.panelBackground(colorScheme)
                    )
            )
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .strokeBorder(
                        isDefault
                            ? NordTheme.accent(colorScheme).opacity(0.38)
                            : NordTheme.border(colorScheme),
                        lineWidth: 1
                    )
            )
        }
        .buttonStyle(.plain)
        .onHover { hovered = $0 }
        .animation(.easeInOut(duration: 0.12), value: hovered)
        .help(isDefault ? "Active — click to deselect" : "Set as default instruction")
    }
}

private struct LandingAddTile: View {
    let icon: String
    let label: String
    let help: String
    let action: () -> Void
    @Environment(\.colorScheme) private var colorScheme
    @State private var hovered = false

    var body: some View {
        Button(action: action) {
            VStack(spacing: 5) {
                Image(systemName: icon)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundColor(NordTheme.accent(colorScheme).opacity(0.75))
                Text(label)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundColor(NordTheme.secondaryText(colorScheme))
                    .multilineTextAlignment(.center)
                    .lineLimit(2)
            }
            .frame(maxWidth: .infinity, minHeight: 66)
            .background(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(hovered ? NordTheme.badgeFill(colorScheme) : Color.clear)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .strokeBorder(
                        NordTheme.border(colorScheme),
                        style: StrokeStyle(lineWidth: 1, dash: [4, 3])
                    )
            )
        }
        .buttonStyle(.plain)
        .help(help)
        .onHover { hovered = $0 }
        .animation(.easeInOut(duration: 0.12), value: hovered)
    }
}

private struct FeatureTile: View {
    let icon: String
    let title: String
    let description: String
    let action: () -> Void
    @Environment(\.colorScheme) private var colorScheme
    @State private var hovered = false

    var body: some View {
        Button(action: action) {
            HStack(alignment: .top, spacing: 11) {
                Image(systemName: icon)
                    .font(.system(size: 15))
                    .foregroundColor(NordTheme.accent(colorScheme).opacity(0.85))
                    .frame(width: 20, alignment: .top)
                    .padding(.top, 1)
                VStack(alignment: .leading, spacing: 3) {
                    Text(title)
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundColor(NordTheme.primaryText(colorScheme))
                    Text(description)
                        .font(.system(size: 11))
                        .foregroundColor(NordTheme.secondaryText(colorScheme))
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .padding(.horizontal, 13)
            .padding(.vertical, 11)
            .frame(maxWidth: .infinity, minHeight: 66, alignment: .topLeading)
            .background(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(hovered ? NordTheme.badgeFill(colorScheme) : NordTheme.panelBackground(colorScheme))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .strokeBorder(NordTheme.border(colorScheme), lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
        .onHover { hovered = $0 }
        .animation(.easeInOut(duration: 0.12), value: hovered)
        .help("Open \(title)")
    }
}

// MARK: - Message View (dispatcher)

struct ChatMessageView: View, @MainActor Equatable {
    let message: ChatMessage
    var isStreaming: Bool = false
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        switch message.role {
        case .user:
            UserBubbleView(text: message.text)
        case .assistant:
            AssistantMessageView(message: message, isStreaming: isStreaming)
        case .system:
            EmptyView()
        }
    }

    // SwiftUI uses this when the view is wrapped in `.equatable()`. Skipping
    // body re-evaluation for unchanged messages is the single biggest win for
    // long transcripts: ChatModel republishes on every streaming token, but
    // only the streaming row actually changes — all prior rows can be reused
    // as-is. `ChatMessage` is itself Equatable (id + role + text + blocks).
    static func == (lhs: ChatMessageView, rhs: ChatMessageView) -> Bool {
        return lhs.isStreaming == rhs.isStreaming && lhs.message == rhs.message
    }
}

// MARK: - User Bubble

struct UserBubbleView: View {
    let text: String
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        // The user message now lives inside its own rounded "paper"
        // container, mirroring the assistant's final-answer surface.
        // The copy icon is tucked into the bottom-right corner of the
        // same container so the affordance is always one click away
        // without sitting outside the bubble.
        HStack(alignment: .top) {
            Spacer(minLength: 60)
            VStack(alignment: .trailing, spacing: 4) {
                // Render user input as Markdown so prompts that paste in
                // code fences, lists, or inline formatting display
                // structurally the same as the assistant's answer.
                // Falls back to plain `Text` when the message is short
                // single-line prose so very simple inputs avoid the
                // extra parse work and keep their original spacing.
                if Self.shouldRenderAsMarkdown(text) {
                    ChatMarkdownView(text: text, baseFontSize: 13)
                        .equatable()
                        .frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    Text(text)
                        .font(OKFont.body)
                        .foregroundColor(bubbleTextColor)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }

                ChatCopyButton(text: text, title: "Copy message")
            }
            .padding(.horizontal, 14)
            .padding(.top, 10)
            .padding(.bottom, 6)
            .frame(maxWidth: 560, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(bubbleFillColor)
            )
            // Clip first so any wide child (code blocks, tables) honours
            // the rounded bubble corners instead of poking past them.
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .strokeBorder(bubbleBorderColor, lineWidth: 1)
            )
        }
        .frame(maxWidth: .infinity)
    }

    /// Heuristic that decides whether a user message benefits from the
    /// full Markdown renderer. Short single-line messages stay on the
    /// lightweight `Text` path so they keep their original tight
    /// spacing; anything that looks structured (code fences, lists,
    /// headings, blockquotes, inline code, bold/italic markers,
    /// multiple lines) is sent through `ChatMarkdownView`.
    fileprivate static func shouldRenderAsMarkdown(_ raw: String) -> Bool {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return false }
        if trimmed.contains("\n") { return true }
        if trimmed.contains("```") { return true }
        if trimmed.contains("`") { return true }
        let structuralPrefixes = ["# ", "## ", "### ", "#### ", "##### ", "###### ", "- ", "* ", "> "]
        for prefix in structuralPrefixes where trimmed.hasPrefix(prefix) { return true }
        if trimmed.contains("**") || trimmed.contains("__") { return true }
        // Inline links: [text](url)
        if trimmed.contains("](") { return true }
        return false
    }

    // In dark mode the user-bubble uses a muted tinted surface instead of
    // a saturated accent fill so it reads as a soft chip rather than a
    // bright blue block. Light mode keeps the existing accent fill.
    // The user bubble uses a tinted accent surface in both light and
    // dark mode (Codex-style) instead of a saturated fill. This keeps
    // the conversation visually quiet so the assistant prose — which is
    // where the actual answer lives — remains the focal point.
    private var bubbleFillColor: Color {
        switch colorScheme {
        case .dark:
            return NordTheme.accent(colorScheme).opacity(0.18)
        default:
            return NordTheme.accent(colorScheme).opacity(0.10)
        }
    }

    private var bubbleTextColor: Color {
        NordTheme.primaryText(colorScheme)
    }

    private var bubbleBorderColor: Color {
        switch colorScheme {
        case .dark:
            return NordTheme.accent(colorScheme).opacity(0.32)
        default:
            return NordTheme.accent(colorScheme).opacity(0.22)
        }
    }
}

// MARK: - Typing Dots

/// Animated three-dot indicator shown while the assistant hasn't yet produced
/// any content block. Disappears the moment the first thinking block arrives.
private struct TypingDotsView: View {
    @Environment(\.colorScheme) private var colorScheme
    @State private var animating = false
    @State private var iconPulse = false

    var body: some View {
        // A subtly-pulsing sparkles glyph sits to the left of the
        // dots as the assistant-is-thinking cue. It uses the accent
        // purple shared with the thinking section so the visual
        // language is consistent across the two states.
        HStack(spacing: 8) {
            Image(systemName: "sparkles")
                .font(.system(size: 12, weight: .semibold))
                .foregroundColor(NordTheme.accentPurple(colorScheme))
                .scaleEffect(iconPulse ? 1.08 : 0.94)
                .opacity(iconPulse ? 1.0 : 0.75)
                .animation(
                    .easeInOut(duration: 0.9).repeatForever(autoreverses: true),
                    value: iconPulse
                )

            HStack(spacing: 5) {
                dotView(delay: 0.00)
                dotView(delay: 0.18)
                dotView(delay: 0.36)
            }
        }
        .onAppear {
            animating = true
            iconPulse = true
        }
    }

    private func dotView(delay: Double) -> some View {
        Circle()
            .fill(NordTheme.secondaryText(colorScheme).opacity(0.55))
            .frame(width: 5, height: 5)
            .scaleEffect(animating ? 1.0 : 0.55)
            .opacity(animating ? 1.0 : 0.30)
            .animation(
                .easeInOut(duration: 0.5)
                    .repeatForever(autoreverses: true)
                    .delay(delay),
                value: animating
            )
    }
}

// MARK: - Assistant Message

struct AssistantMessageView: View {
    let message: ChatMessage
    var isStreaming: Bool = false
    @Environment(\.colorScheme) private var colorScheme

    private var thinkingBlocks: [ChatBlock] {
        message.blocks.filter { $0.kind != .finalAnswer }
    }

    private var finalBlock: ChatBlock? {
        message.blocks.first { $0.kind == .finalAnswer }
    }

    var body: some View {
        // Codex-style: no avatar, no boxed bubble. The assistant turn
        // is rendered as a flush-left column of clean prose, with the
        // collapsible thinking row sitting above the final answer as a
        // slim pill — matching the reference design while keeping the
        // existing Nord palette.
        VStack(alignment: .leading, spacing: 10) {
            if message.blocks.isEmpty {
                // No blocks yet — show animated dots until the first block arrives.
                TypingDotsView()
                    .padding(.vertical, 6)
            } else {
                if !thinkingBlocks.isEmpty {
                    ThinkingSectionView(blocks: thinkingBlocks, isStreaming: isStreaming)
                }
                if let final = finalBlock {
                    FinalAnswerView(text: final.text)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - Thinking Section (Timeline)

private struct ThinkingSectionView: View {
    let blocks: [ChatBlock]
    var isStreaming: Bool = false
    @Environment(\.colorScheme) private var colorScheme
    @State private var expanded = false
    @State private var glowPulse = false
    @State private var expandedSteps: Set<Int> = []

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            headerPill
            if expanded {
                timelineBody
                    .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .onAppear { if isStreaming { startGlow() } }
        .onChange(of: isStreaming) { _, streaming in
            if streaming { startGlow() }
            else { withAnimation(.easeOut(duration: 0.4)) { glowPulse = false } }
        }
    }

    private var headerPill: some View {
        Button {
            withAnimation(.spring(response: 0.3, dampingFraction: 0.82)) { expanded.toggle() }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: isStreaming ? "sparkles" : "brain")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundColor(
                        isStreaming
                            ? NordTheme.accentPurple(colorScheme)
                            : NordTheme.secondaryText(colorScheme).opacity(0.85)
                    )
                Text(thinkingHeaderTitle)
                    .font(OKFont.captionSmall)
                    .foregroundColor(NordTheme.secondaryText(colorScheme))
                Image(systemName: expanded ? "chevron.up" : "chevron.down")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundColor(NordTheme.secondaryText(colorScheme).opacity(0.55))
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 0)
            .padding(.vertical, 2)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(expanded ? "Collapse thinking" : "Expand thinking")
    }

    /// Codex shows "Worked for 2m 37s" / "Thinking…" instead of a
    /// terse "Thinking" label. We don't have per-block timing in
    /// `ChatBlock` yet, so for now we surface the step count when not
    /// streaming and keep the live label when streaming.
    private var thinkingHeaderTitle: String {
        if isStreaming {
            return "Thinking…"
        }
        let steps = blocks.count
        if steps <= 0 { return "Thought" }
        return "Thought for \(steps) step\(steps == 1 ? "" : "s")"
    }

    private var timelineBody: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(blocks.indices, id: \.self) { i in
                ThinkingTimelineRow(
                    block: blocks[i],
                    isLast: i == blocks.count - 1,
                    isActive: isStreaming && i == blocks.count - 1,
                    isExpanded: expandedSteps.contains(i),
                    onToggle: {
                        withAnimation(.easeInOut(duration: 0.18)) {
                            if expandedSteps.contains(i) { expandedSteps.remove(i) }
                            else { expandedSteps.insert(i) }
                        }
                    }
                )
            }
        }
        .padding(.leading, 2)
        .padding(.top, 2)
    }

    private func startGlow() {
        withAnimation(.easeInOut(duration: 1.1).repeatForever(autoreverses: true)) {
            glowPulse = true
        }
    }
}

// MARK: - Timeline Row

private struct ThinkingTimelineRow: View {
    let block: ChatBlock
    let isLast: Bool
    let isActive: Bool
    let isExpanded: Bool
    let onToggle: () -> Void

    @Environment(\.colorScheme) private var colorScheme
    @State private var hovered = false
    @State private var haloPulse = false

    // Per-kind visual metadata
    private var meta: (icon: String, label: String, accent: Color) {
        switch block.kind {
        case .agentReasoning:  return ("brain",             "Reasoning",  NordTheme.accentPurple(colorScheme))
        case .shellCommand:    return ("terminal.fill",     "Command",    NordTheme.accent(colorScheme))
        case .terminalOutput:  return ("terminal",          "Output",     NordTheme.secondaryText(colorScheme))
        case .webCall:         return ("globe",             "Web Search", NordTheme.accentBlue(colorScheme))
        case .mcpCall:         return ("server.rack",       "MCP Call",   NordTheme.accentAmber(colorScheme))
        case .imageRendering:  return ("photo",             "Image",      NordTheme.accentGreen(colorScheme))
        case .finalAnswer:     return ("checkmark.circle.fill", "Answer", NordTheme.accentGreen(colorScheme))
        }
    }

    // First non-empty line of block text, capped at 120 chars
    private var summary: String {
        let raw = block.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !raw.isEmpty else { return "" }
        let line = raw.components(separatedBy: "\n")
            .first(where: { !$0.trimmingCharacters(in: .whitespaces).isEmpty }) ?? ""
        let s = line.trimmingCharacters(in: .whitespaces)
        return s.isEmpty ? String(raw.prefix(120)) : s
    }

    var body: some View {
        let (icon, label, accent) = meta
        HStack(alignment: .top, spacing: 0) {

            // ── Left: dot + vertical connector ──────────────────────
            VStack(spacing: 0) {
                ZStack {
                    if isActive {
                        Circle()
                            .fill(accent.opacity(haloPulse ? 0.42 : 0.10))
                            .frame(width: 14, height: 14)
                            .scaleEffect(haloPulse ? 1.0 : 0.82)
                    }
                    Circle()
                        .fill(isActive ? accent : NordTheme.secondaryText(colorScheme).opacity(0.22))
                        .frame(width: isActive ? 7 : 5, height: isActive ? 7 : 5)
                }
                // Square frame ensures the halo circle is round and centred.
                .frame(width: 20, height: 20)

                if !isLast {
                    Rectangle()
                        .fill(NordTheme.border(colorScheme))
                        .frame(width: 1)
                        .frame(maxHeight: .infinity)
                }
            }
            .frame(width: 20)
            .onAppear {
                if isActive { startHaloPulse() }
            }
            .onChange(of: isActive) { _, active in
                if active {
                    startHaloPulse()
                } else {
                    withAnimation(.easeOut(duration: 0.3)) { haloPulse = false }
                }
            }

            // ── Right: label row + optional expanded detail ──────────
            VStack(alignment: .leading, spacing: 0) {
                // Label row — always visible, tap to expand
                Button(action: onToggle) {
                    HStack(spacing: 5) {
                        Image(systemName: icon)
                            .font(.system(size: 9.5, weight: .semibold))
                            .foregroundColor(accent)
                            .frame(width: 13, alignment: .center)

                        Text(label)
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundColor(NordTheme.primaryText(colorScheme).opacity(0.82))

                        if !isExpanded, !summary.isEmpty {
                            Text("·")
                                .font(.system(size: 11))
                                .foregroundColor(NordTheme.secondaryText(colorScheme).opacity(0.3))
                            Text(summary)
                                .font(.system(size: 11))
                                .foregroundColor(NordTheme.secondaryText(colorScheme).opacity(0.58))
                                .lineLimit(1)
                                .truncationMode(.tail)
                        }

                        Spacer(minLength: 4)

                        // Chevron — only visible on hover
                        Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                            .font(.system(size: 8, weight: .medium))
                            .foregroundColor(
                                hovered
                                    ? NordTheme.secondaryText(colorScheme).opacity(0.45)
                                    : .clear
                            )
                    }
                    .padding(.vertical, 5)
                    .padding(.trailing, 6)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .onHover { hovered = $0 }

                // Expanded full content
                if isExpanded {
                    expandedDetail
                        .padding(.top, 4)
                        .padding(.bottom, 10)
                        .transition(.opacity.combined(with: .move(edge: .top)))
                }
            }
            .padding(.leading, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        // Bottom gap between rows (the connector fills this space)
        .padding(.bottom, isLast ? 4 : 0)
    }

    private func startHaloPulse() {
        withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) {
            haloPulse = true
        }
    }

    @ViewBuilder
    private var expandedDetail: some View {
        let trimmed = block.text.trimmingCharacters(in: .whitespacesAndNewlines)
        switch block.kind {
        case .shellCommand, .terminalOutput:
            ScrollView(.horizontal, showsIndicators: false) {
                Text(trimmed)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundColor(NordTheme.primaryText(colorScheme).opacity(0.82))
                    .textSelection(.enabled)
                    .fixedSize(horizontal: true, vertical: true)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .fill(
                        colorScheme == .dark
                            ? Color(red: 16 / 255, green: 18 / 255, blue: 26 / 255)
                            : Color(red: 248 / 255, green: 249 / 255, blue: 253 / 255)
                    )
            )
            .overlay(
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .strokeBorder(NordTheme.border(colorScheme), lineWidth: 1)
            )
            .padding(.trailing, 6)

        default:
            ChatMarkdownView(text: trimmed, baseFontSize: 11.5)
                .opacity(0.85)
                .padding(.trailing, 6)
        }
    }
}

// MARK: - Final Answer

struct FinalAnswerView: View {
    let text: String
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        // Soft "paper" surface: a low-contrast lift on top of the
        // editor background so the final answer reads as its own
        // container without ever feeling bright. The copy icon stays
        // permanently anchored bottom-right.
        VStack(alignment: .trailing, spacing: 6) {
            ChatMarkdownView(text: text)
                .frame(maxWidth: .infinity, alignment: .leading)

            ChatCopyButton(text: text, title: "Copy answer")
        }
        .padding(.horizontal, 16)
        .padding(.top, 14)
        .padding(.bottom, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(paperFill)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(NordTheme.border(colorScheme), lineWidth: 1)
        )
    }

    /// Subtle, never-bright paper colour:
    /// - dark mode → a small lift above the window background
    /// - light mode → a near-white tint, kept noticeably below pure white
    /// Both tones sit comfortably next to the existing Nord palette.
    private var paperFill: Color {
        switch colorScheme {
        case .dark:
            return Color(red: 50 / 255, green: 50 / 255, blue: 54 / 255).opacity(0.85)
        default:
            return Color(red: 252 / 255, green: 252 / 255, blue: 254 / 255)
        }
    }
}

// MARK: - Copy Button

private struct ChatCopyButton: View {
    let text: String
    var title: String = "Copy"
    /// When true (the default), the button renders as a compact
    /// icon-only square — used for the persistent affordances on the
    /// final answer and user bubble. Set to false to get the original
    /// "icon + Copy" label (e.g. inside the code-block toolbar).
    var iconOnly: Bool = true
    @Environment(\.colorScheme) private var colorScheme
    @State private var copied = false
    @State private var hovered = false

    var body: some View {
        Button(action: copy) {
            Group {
                if iconOnly {
                    Image(systemName: copied ? "checkmark" : "doc.on.doc")
                        .font(.system(size: 11, weight: .semibold))
                        .frame(width: 22, height: 22)
                } else {
                    HStack(spacing: 4) {
                        Image(systemName: copied ? "checkmark" : "doc.on.doc")
                            .font(.system(size: 10, weight: .semibold))
                        Text(copied ? "Copied" : "Copy")
                            .font(.system(size: 10, weight: .medium))
                    }
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                }
            }
            .foregroundColor(
                copied
                    ? NordTheme.accentGreen(colorScheme)
                    : NordTheme.secondaryText(colorScheme).opacity(hovered ? 1.0 : 0.75)
            )
            .background(
                Group {
                    if iconOnly {
                        RoundedRectangle(cornerRadius: 6, style: .continuous)
                            .fill(hovered ? NordTheme.badgeFill(colorScheme) : Color.clear)
                    } else {
                        Capsule().fill(NordTheme.badgeFill(colorScheme))
                    }
                }
            )
            .overlay(
                Group {
                    if !iconOnly {
                        Capsule().strokeBorder(NordTheme.border(colorScheme), lineWidth: 1)
                    }
                }
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovered = $0 }
        .animation(.easeInOut(duration: 0.12), value: hovered)
        .help(copied ? "Copied" : title)
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
struct ChatMarkdownView: View, @MainActor Equatable {
    let text: String
    var baseFontSize: CGFloat = 13
    @Environment(\.colorScheme) private var colorScheme

    // SwiftUI re-evaluates `body` whenever the parent view republishes —
    // during streaming, that's once per token, for every message in the
    // transcript. Equatable conformance lets `.equatable()` short-circuit
    // the work when neither the source text nor the font size has changed.
    static func == (lhs: ChatMarkdownView, rhs: ChatMarkdownView) -> Bool {
        return lhs.baseFontSize == rhs.baseFontSize && lhs.text == rhs.text
    }

    var body: some View {
        let parsed = ChatMarkdownCache.shared.blocks(for: text)
        VStack(alignment: .leading, spacing: 9) {
            ForEach(Array(parsed.enumerated()), id: \.offset) { _, block in
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
        // Inline markdown is parsed via the OS attributed-string parser,
        // which is non-trivial. Cache the result so repeated body
        // evaluations for the same prose (extremely common during streaming
        // — most historical paragraphs never change) reuse the same value.
        let attributed = ChatMarkdownCache.shared.inlineAttributed(prose)
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
            return baseFontSize + 4
        case 2:
            return baseFontSize + 2
        case 3:
            return baseFontSize + 1
        case 4:
            return baseFontSize
        default:
            // Levels 5 and 6 (e.g. "##### TL;DR") render slightly smaller
            // than body text and slightly subdued. Keeping them visually
            // distinct from a paragraph avoids the "looks identical to
            // surrounding prose" complaint while still respecting the
            // semantic depth chosen by the model.
            return max(baseFontSize - 1, 11)
        }
    }

    fileprivate enum MarkdownBlock {
        case paragraph(String)
        case heading(Int, String)
        case unorderedList([String])
        case orderedList([String])
        case quote(String)
        case code(String?, String)
        case divider
        case table([String], [[String]])
    }

    fileprivate static func parseBlocks(from text: String) -> [MarkdownBlock] {
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

    fileprivate static func parseHeading(_ line: String) -> (level: Int, text: String)? {
        // Full ATX-heading support (levels 1–6). Some LLMs emit deeper
        // section markers such as `##### TL;DR` for callouts — clamping
        // at 4 levels caused those lines to render as literal hash marks
        // in the assistant's final answer (the "TL;DR symbol" bug).
        let count = line.prefix { $0 == "#" }.count
        guard count > 0, count <= 6, line.dropFirst(count).first == " " else { return nil }
        var text = String(line.dropFirst(count + 1))
        // Strip optional ATX closing markers ("## Heading ##") so the
        // trailing hashes don't bleed into the rendered title.
        text = text.trimmingCharacters(in: .whitespaces)
        while text.hasSuffix("#") {
            text.removeLast()
        }
        return (min(count, 6), text.trimmingCharacters(in: .whitespaces))
    }

    fileprivate static func isDivider(_ line: String) -> Bool {
        line.count >= 3 && (
            line.allSatisfy { $0 == "-" } ||
            line.allSatisfy { $0 == "*" } ||
            line.allSatisfy { $0 == "_" }
        )
    }

    fileprivate static func isUnorderedListLine(_ line: String) -> Bool {
        line.hasPrefix("- ") || line.hasPrefix("* ") || line.hasPrefix("• ")
    }

    fileprivate static func orderedListText(_ line: String) -> String? {
        guard let dotIndex = line.firstIndex(where: { $0 == "." || $0 == ")" }) else { return nil }
        let prefix = line[..<dotIndex]
        guard !prefix.isEmpty, prefix.allSatisfy(\.isNumber) else { return nil }
        let after = line.index(after: dotIndex)
        guard after < line.endIndex, line[after] == " " else { return nil }
        return String(line[line.index(after: after)...]).trimmingCharacters(in: .whitespaces)
    }

    fileprivate static func isTableStart(at index: Int, lines: [String]) -> Bool {
        guard index + 1 < lines.count else { return false }
        let header = lines[index].trimmingCharacters(in: .whitespaces)
        let separator = lines[index + 1].trimmingCharacters(in: .whitespaces)
        return header.contains("|") && isMarkdownTableSeparator(separator)
    }

    fileprivate static func isMarkdownTableSeparator(_ line: String) -> Bool {
        let cells = tableCells(line)
        guard !cells.isEmpty else { return false }
        return cells.allSatisfy { cell in
            let stripped = cell.replacingOccurrences(of: ":", with: "")
            return stripped.count >= 3 && stripped.allSatisfy { $0 == "-" }
        }
    }

    fileprivate static func parseTable(
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

    fileprivate static func tableCells(_ line: String) -> [String] {
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
        // Wrap the table in the rounded shape *and* clip its contents
        // to it, so the header band's fill and the per-cell separators
        // stop at the rounded edge instead of poking into square
        // corners. The outer scroll view sits outside the clip so
        // horizontal overflow still works as before.
        ScrollView(.horizontal, showsIndicators: true) {
            VStack(alignment: .leading, spacing: 0) {
                tableRow(header, isHeader: true, isLastRow: rows.isEmpty)
                ForEach(Array(rows.enumerated()), id: \.offset) { offset, row in
                    tableRow(row, isHeader: false, isLastRow: offset == rows.count - 1)
                }
            }
            .background(NordTheme.panelBackground(colorScheme))
            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .strokeBorder(NordTheme.border(colorScheme), lineWidth: 1)
            )
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func tableRow(_ cells: [String], isHeader: Bool, isLastRow: Bool) -> some View {
        let lastColumnIndex = maxColumnCount - 1
        return HStack(spacing: 0) {
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
                        // Skip the trailing vertical separator on the
                        // rightmost cell — it would otherwise sit
                        // flush against the rounded right edge.
                        if index < lastColumnIndex {
                            Rectangle()
                                .fill(NordTheme.border(colorScheme))
                                .frame(width: 1)
                        }
                    }
            }
        }
        .overlay(alignment: .bottom) {
            // Skip the horizontal separator under the final row so the
            // bottom rounded edge stays clean.
            if !isLastRow {
                Rectangle()
                    .fill(NordTheme.border(colorScheme))
                    .frame(height: 1)
            }
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
                    .font(OKFont.eyebrow)
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
                    .font(OKFont.monoBlock)
                    .foregroundColor(NordTheme.primaryText(colorScheme))
                    .textSelection(.enabled)
                    .fixedSize(horizontal: true, vertical: true)
                    .padding(12)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        // Clip the entire stack to the rounded outer shape *before*
        // drawing the background and border. Without this, the
        // top-bar's rectangular `.background(badgeFill)` fill and the
        // separator rectangle paint into the four corners that should
        // be carved out by the rounded rectangle — producing the
        // "shadowed corner" artifact reported on the chat page.
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
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
        // Rounded, self-contained alert pill. The original banner drew a
        // square-cornered red wash that ran flush against the input
        // composer below, producing the "shadow on the corners" look
        // the user reported next to the new ready-state alert. Adding
        // a proper rounded background + matching clip mirrors the
        // styling we use on `FinalAnswerView` / `UserBubbleView`.
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 12))
                .foregroundColor(.red)
            Text(message)
                .font(OKFont.caption)
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
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(Color.red.opacity(colorScheme == .dark ? 0.14 : 0.08))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(Color.red.opacity(colorScheme == .dark ? 0.30 : 0.22), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .padding(.horizontal, 22)
        .padding(.vertical, 6)
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


// MARK: - String helpers

private extension String {
    /// Returns `nil` when the string is empty so callers can use the
    /// nil-coalescing operator to fall through to a default value.
    var nilIfEmpty: String? { isEmpty ? nil : self }
}

// MARK: - Markdown Parse Cache

/// Process-wide cache for parsed markdown. Stores both the block list for a
/// full message body and the per-paragraph `AttributedString` result, keyed
/// by the source string. `NSCache` evicts entries automatically under memory
/// pressure, so this never holds onto stale strings beyond the system's
/// comfort threshold.
@MainActor
private final class ChatMarkdownCache {
    static let shared = ChatMarkdownCache()

    private final class BlockBox {
        let value: [ChatMarkdownView.MarkdownBlock]
        init(_ value: [ChatMarkdownView.MarkdownBlock]) { self.value = value }
    }

    private final class AttrBox {
        let value: AttributedString
        init(_ value: AttributedString) { self.value = value }
    }

    private let blockCache: NSCache<NSString, BlockBox> = {
        let c = NSCache<NSString, BlockBox>()
        c.countLimit = 256
        return c
    }()

    private let attrCache: NSCache<NSString, AttrBox> = {
        let c = NSCache<NSString, AttrBox>()
        c.countLimit = 1024
        return c
    }()

    func blocks(for text: String) -> [ChatMarkdownView.MarkdownBlock] {
        let key = text as NSString
        if let hit = blockCache.object(forKey: key) {
            return hit.value
        }
        let parsed = ChatMarkdownView.parseBlocks(from: text)
        blockCache.setObject(BlockBox(parsed), forKey: key)
        return parsed
    }

    func inlineAttributed(_ prose: String) -> AttributedString {
        let key = prose as NSString
        if let hit = attrCache.object(forKey: key) {
            return hit.value
        }
        let opts = AttributedString.MarkdownParsingOptions(
            allowsExtendedAttributes: true,
            interpretedSyntax: .inlineOnlyPreservingWhitespace,
            failurePolicy: .returnPartiallyParsedIfPossible
        )
        let attributed = (try? AttributedString(markdown: prose, options: opts)) ?? AttributedString(prose)
        attrCache.setObject(AttrBox(attributed), forKey: key)
        return attributed
    }
}

