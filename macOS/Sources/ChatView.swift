import AppKit
import Combine
import MarkdownEngine
import MarkdownEngineCodeBlocks
import SwiftUI
import Textual

// MARK: - Root

enum ChatLayoutMetrics {
    static let sidebarExpandedWidth: CGFloat = 264
    static let sidebarCollapsedWidth: CGFloat = 52
}

struct ChatView: View {
    @ObservedObject var model: ChatModel
    @Environment(\.colorScheme) private var colorScheme

    /// Persisted collapse state. The sidebar collapses to a narrow rail
    /// of icons (new chat + recent sessions) so the conversation area
    /// gets more room without losing one-click access to chat history.
    @AppStorage("chatSidebarCollapsed") private var sidebarCollapsed: Bool = false

    // Give project names and session titles a little more breathing room.
    // 264 pt is exactly 10% wider than the previous 240 pt sidebar while
    // remaining compact enough for the minimum supported chat window.
    private var sidebarWidth: CGFloat {
        sidebarCollapsed
            ? ChatLayoutMetrics.sidebarCollapsedWidth
            : ChatLayoutMetrics.sidebarExpandedWidth
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
        .onAppear {
            model.refreshSessions()
            model.fetchDefaultTaskTemplate()
            model.fetchGroups()
            model.fetchAgentModelOptions()
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
    /// Number of rows currently revealed per group. Groups begin with ten and
    /// advance in ten-row pages so large histories do not overwhelm the sidebar.
    @State private var visibleSessionCounts: [String: Int] = [:]
    fileprivate static let sessionPageSize = 10
    /// Drives the "Update available" button that appears above the sidebar
    /// header when a newer app version is on the Sparkle appcast. The
    /// button hides itself when there is nothing to update to.
    @ObservedObject private var updateChecker: AppUpdateChecker = .shared
    @ObservedObject private var cliUpdateChecker: CLIUpdateChecker = .shared

    private static let ungroupedName = "Other"

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // ── Update available banner (only when the appcast shows a
            //    newer version than what is currently installed) ─────────
            if updateChecker.isUpdateAvailable {
                ChatSidebarUpdateBanner(
                    title: "Update desktop app",
                    subtitle: updateChecker.latestShortVersion.map { "Version \($0)" },
                    systemImage: "arrow.down.circle.fill",
                    help: updateChecker.latestShortVersion.map { "Install OmniKey \($0)" }
                        ?? "Install the latest OmniKey update",
                    onUpdate: { AppDelegate.shared?.checkForUpdates() }
                )
                .padding(.horizontal, 10)
                .padding(.top, 10)
                .transition(.opacity.combined(with: .move(edge: .top)))
            }

            if cliUpdateChecker.isUpdateAvailable {
                ChatSidebarUpdateBanner(
                    title: cliUpdateChecker.isUpdating ? "Updating omnikey-cli" : "Update omnikey-cli",
                    subtitle: cliUpdateChecker.isUpdating
                        ? (cliUpdateChecker.statusMessage ?? "Updating...")
                        : (cliUpdateChecker.statusMessage
                            ?? cliUpdateChecker.latestVersion.map { "Version \($0)" }),
                    systemImage: "terminal.fill",
                    isWorking: cliUpdateChecker.isUpdating,
                    help: "Update omnikey-cli and restart the local daemon",
                    onUpdate: { cliUpdateChecker.updateAndRestartDaemon() }
                )
                .padding(.horizontal, 10)
                .padding(.top, updateChecker.isUpdateAvailable ? 6 : 10)
                .transition(.opacity.combined(with: .move(edge: .top)))
            }

            // ── Sidebar header ───────────────────────────────────────────
            HStack(alignment: .center, spacing: 4) {
                Text("OmniAgent")
                    .font(OKFont.bodyEmphasized)
                    .okTighten(-0.15)
                    .foregroundColor(NordTheme.primaryText(colorScheme))

                // Global "N running" pill. Turns stream in parallel across
                // sessions, so this is the only place the user can see that
                // background work is still happening after switching chats.
                if !model.runningSessionIds.isEmpty {
                    let running = model.runningSessionIds.count
                    HStack(spacing: 3) {
                        Circle()
                            .fill(NordTheme.accentGreen(colorScheme))
                            .frame(width: 5, height: 5)
                        Text("\(running)")
                            .font(.system(size: 10, weight: .semibold))
                            .monospacedDigit()
                    }
                    .foregroundColor(NordTheme.accentGreen(colorScheme))
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(
                        Capsule().fill(NordTheme.accentGreen(colorScheme).opacity(0.14))
                    )
                    .help("\(running) chat\(running == 1 ? "" : "s") running")
                    .transition(.opacity.combined(with: .scale(scale: 0.85)))
                }

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
                        // Also revalidate the "Update available" state
                        // — the refresh button doubles as a manual
                        // check for a newer app version.
                        updateChecker.refreshNow()
                        cliUpdateChecker.refreshNow()
                    }
                }
                SidebarIconButton(icon: "square.and.pencil", help: "New Chat (\u{2318}N)") {
                    model.startNewChat()
                }
                SidebarIconButton(icon: "sidebar.left", help: "Collapse sidebar (\u{2318}\u{2325}S)") {
                    onCollapse()
                }
            }
            .animation(.easeInOut(duration: 0.15), value: isRefreshing)
            .animation(.easeInOut(duration: 0.18), value: model.runningSessionIds.isEmpty)
            // Hidden shortcut host for sidebar collapse. ⌘N is intentionally
            // *not* registered here — `AppMainMenu` already owns it via the
            // File ▸ New Chat item, and a second binding would double-fire.
            .background(
                Button(action: onCollapse) { EmptyView() }
                    .keyboardShortcut("s", modifiers: [.command, .option])
                    .frame(width: 0, height: 0)
                    .opacity(0)
                    .accessibilityHidden(true)
            )
            .padding(.horizontal, 12)
            .padding(.top, 14)
            .padding(.bottom, 8)

            // Search field — filters sessions by title, project group,
            // and (lazily fetched) full user-message transcript so the
            // user can find a chat by anything they ever typed in it,
            // not just the first message.
            ChatSidebarSearchField(query: $model.sessionSearchQuery)
                .padding(.horizontal, 10)
                .padding(.bottom, model.isSessionSearchActive ? 6 : 10)

            // Live result count — confirms the filter is applied and how
            // much of the list is hidden, instead of leaving the user to
            // count rows.
            if model.isSessionSearchActive {
                let matches = model.filteredSessions.count
                HStack(spacing: 4) {
                    Text("\(matches) of \(model.sessions.count)")
                        .font(.system(size: 10, weight: .medium))
                        .monospacedDigit()
                    Text(matches == 1 ? "chat matches" : "chats match")
                        .font(.system(size: 10))
                    Spacer(minLength: 0)
                    Button(action: { model.clearSessionSearch() }) {
                        Text("Clear")
                            .font(.system(size: 10, weight: .medium))
                            .foregroundColor(NordTheme.accent(colorScheme))
                    }
                    .buttonStyle(.plain)
                    .help("Clear search")
                }
                .foregroundColor(NordTheme.secondaryText(colorScheme).opacity(0.6))
                .padding(.horizontal, 13)
                .padding(.bottom, 8)
                .transition(.opacity)
            }

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
                            onTap: { /* already on the pending new chat */  }
                        )
                        .id("pending-new-chat")
                        .padding(.top, 6)
                    }

                    if model.sessions.isEmpty && !model.hasPendingNewChat {
                        ChatSidebarEmptyState(onStart: { model.startNewChat() })
                            .padding(.horizontal, 14)
                            .padding(.top, 28)
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
                            let hasGroup =
                                candidate.groupName?
                                .trimmingCharacters(in: .whitespacesAndNewlines)
                                .nilIfEmpty != nil
                            return hasGroup || candidate.isPinned ? nil : candidate
                        }()

                        if let pinned = pinnedRunningSession {
                            ChatSessionRowView(
                                session: pinned,
                                isActive: pinned.id == model.activeSessionId,
                                isRunning: model.runningSessionIds.contains(pinned.id),
                                searchQuery: model.sessionSearchQuery,
                                onTap: { model.openSession(pinned) },
                                onRename: { model.renameSession(pinned, to: $0) },
                                onTogglePin: { model.setSessionPinned(pinned, isPinned: !pinned.isPinned) },
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

                        let pinnedSessions = visibleSessions.filter(\.isPinned)
                        ForEach(
                            pinnedSessions.map {
                                ChatSessionRowItem(session: $0, activeSessionId: model.activeSessionId)
                            }
                        ) { item in
                            ChatSessionRowView(
                                session: item.session,
                                isActive: item.isActive,
                                isRunning: model.runningSessionIds.contains(item.session.id),
                                searchQuery: model.sessionSearchQuery,
                                onTap: { model.openSession(item.session) },
                                onRename: { model.renameSession(item.session, to: $0) },
                                onTogglePin: { model.setSessionPinned(item.session, isPinned: false) },
                                onDelete: { model.deleteSession(item.session) }
                            )
                            .id("user-pinned-\(item.id)")
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

                            // Keep projects with no sessions visible so their
                            // Add New control can create the first chat. During
                            // search, only groups containing matches are shown.
                            if !model.isSessionSearchActive {
                                for group in model.availableGroups {
                                    let name = group.groupName.trimmingCharacters(in: .whitespacesAndNewlines)
                                    guard !name.isEmpty, map[name] == nil else { continue }
                                    order.append(name)
                                    map[name] = []
                                }
                            }

                            let pinnedId = pinnedRunningSession?.id
                            for s in visibleSessions where s.id != pinnedId && !s.isPinned {
                                let key =
                                    s.groupName?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
                                    ?? Self.ungroupedName
                                if map[key] == nil {
                                    order.append(key)
                                    map[key] = []
                                }
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
                            // While searching, force every group open. Groups
                            // start collapsed by default, so otherwise a match
                            // inside a collapsed group would be invisible and
                            // the search would look broken.
                            let isCollapsed =
                                model.isSessionSearchActive
                                ? false
                                : collapsedGroups.contains(name)

                            ChatSidebarGroupHeader(
                                name: name,
                                count: sessions.count,
                                runningCount: sessions.filter { model.runningSessionIds.contains($0.id) }.count,
                                isCollapsed: isCollapsed,
                                containsActiveSession: sessions.contains { $0.id == model.activeSessionId },
                                onAddNew: {
                                    let group = model.availableGroups.first { $0.groupName == name }
                                    model.startNewChat(in: group)
                                    seenGroups.insert(name)
                                    collapsedGroups.remove(name)
                                },
                                onToggle: {
                                    // While searching, every group is force-expanded
                                    // above, so `isCollapsed` no longer reflects
                                    // `collapsedGroups`. Toggling here would mutate
                                    // the real set with no visible effect and then
                                    // surface as a surprise inversion once the query
                                    // is cleared. Ignore the tap instead so search
                                    // never silently rewrites collapse state.
                                    guard !model.isSessionSearchActive else { return }
                                    withAnimation(.easeInOut(duration: 0.18)) {
                                        if collapsedGroups.contains(name) {
                                            collapsedGroups.remove(name)
                                        } else {
                                            collapsedGroups.insert(name)
                                        }
                                    }
                                }
                            )

                            if !isCollapsed {
                                let visibleCount = min(
                                    visibleSessionCounts[name, default: Self.sessionPageSize],
                                    sessions.count
                                )
                                ForEach(
                                    sessions.prefix(visibleCount).map {
                                        ChatSessionRowItem(session: $0, activeSessionId: model.activeSessionId)
                                    }
                                ) { item in
                                    ChatSessionRowView(
                                        session: item.session,
                                        isActive: item.isActive,
                                        isRunning: model.runningSessionIds.contains(item.session.id),
                                        searchQuery: model.sessionSearchQuery,
                                        onTap: { model.openSession(item.session) },
                                        onRename: { model.renameSession(item.session, to: $0) },
                                        onTogglePin: {
                                            model.setSessionPinned(item.session, isPinned: !item.session.isPinned)
                                        },
                                        onDelete: { model.deleteSession(item.session) }
                                    )
                                    // Include the active flag in the identity so
                                    // SwiftUI recreates the row that gained or
                                    // lost selection instead of reusing a stale
                                    // button/background drawing from a prior row.
                                    .id("row-\(item.id)")
                                }

                                if visibleCount < sessions.count {
                                    ChatSidebarShowMoreButton(
                                        remainingCount: sessions.count - visibleCount,
                                        onShowMore: {
                                            withAnimation(.easeInOut(duration: 0.16)) {
                                                visibleSessionCounts[name] = visibleCount + Self.sessionPageSize
                                            }
                                        }
                                    )
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
                            let groupName =
                                resolved?.groupName?
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

// MARK: - Sidebar Empty State

/// Zero-state for a brand-new account. Replaces the bare "No chats yet"
/// label with an icon, a one-line explanation, and a primary action, so
/// the empty sidebar teaches the next step instead of just reporting a
/// void.
private struct ChatSidebarEmptyState: View {
    let onStart: () -> Void
    @Environment(\.colorScheme) private var colorScheme
    @State private var hovered = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Image(systemName: "bubble.left.and.bubble.right")
                .font(.system(size: 20, weight: .light))
                .foregroundColor(NordTheme.secondaryText(colorScheme).opacity(0.35))

            VStack(alignment: .leading, spacing: 3) {
                Text("No chats yet")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundColor(NordTheme.primaryText(colorScheme).opacity(0.8))
                Text("Start a conversation and it will appear here, grouped by project.")
                    .font(.system(size: 11))
                    .foregroundColor(NordTheme.secondaryText(colorScheme).opacity(0.6))
                    .fixedSize(horizontal: false, vertical: true)
            }

            Button(action: onStart) {
                HStack(spacing: 5) {
                    Image(systemName: "square.and.pencil")
                        .font(.system(size: 10, weight: .semibold))
                    Text("New Chat")
                        .font(.system(size: 11, weight: .medium))
                }
                .foregroundColor(NordTheme.accent(colorScheme))
                .padding(.horizontal, 9)
                .padding(.vertical, 5)
                .background(
                    RoundedRectangle(cornerRadius: 6, style: .continuous)
                        .fill(NordTheme.accent(colorScheme).opacity(hovered ? 0.18 : 0.10))
                )
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .onHover { hovered = $0 }
            .animation(.easeInOut(duration: 0.12), value: hovered)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - Sidebar Group Header

/// Collapsible project-group header. Adds three things the previous inline
/// header lacked: a hover affordance so it reads as interactive, a running
/// badge that survives collapse (so a busy chat is discoverable without
/// expanding the group), and an accent dot marking the group that holds the
/// currently open chat.
private struct ChatSidebarGroupHeader: View {
    let name: String
    let count: Int
    let runningCount: Int
    let isCollapsed: Bool
    let containsActiveSession: Bool
    let onAddNew: () -> Void
    let onToggle: () -> Void

    @Environment(\.colorScheme) private var colorScheme
    @State private var hovered = false

    var body: some View {
        HStack(spacing: 5) {
            Button(action: onToggle) {
                HStack(spacing: 5) {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 9, weight: .bold))
                        .rotationEffect(.degrees(isCollapsed ? 0 : 90))

                    Text(name)
                        .font(.system(size: 11, weight: .semibold))
                        .tracking(0.1)
                        .lineLimit(1)
                        .truncationMode(.middle)

                    if containsActiveSession, isCollapsed {
                        Circle()
                            .fill(NordTheme.accent(colorScheme))
                            .frame(width: 4, height: 4)
                    }

                    Spacer(minLength: 4)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help(isCollapsed ? "Expand \(name)" : "Collapse \(name)")
            .accessibilityLabel(accessibilityLabelText)

            Button(action: onAddNew) {
                Image(systemName: "plus")
                    .font(.system(size: 9, weight: .bold))
                    .frame(width: 18, height: 18)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("Add New in \(name)")
            .accessibilityLabel("Add New chat in \(name)")

            if runningCount > 0 {
                HStack(spacing: 3) {
                    Circle()
                        .fill(NordTheme.accentGreen(colorScheme))
                        .frame(width: 4, height: 4)
                    Text("\(runningCount)")
                        .font(.system(size: 9.5, weight: .semibold))
                        .monospacedDigit()
                }
                .foregroundColor(NordTheme.accentGreen(colorScheme))
                .padding(.horizontal, 5)
                .padding(.vertical, 1.5)
                .background(Capsule().fill(NordTheme.accentGreen(colorScheme).opacity(0.14)))
                .help("\(runningCount) chat\(runningCount == 1 ? "" : "s") running")
            }

            Text("\(count)")
                .font(.system(size: 10, weight: .medium))
                .monospacedDigit()
        }
        .foregroundColor(NordTheme.secondaryText(colorScheme).opacity(hovered ? 0.75 : 0.45))
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(
            RoundedRectangle(cornerRadius: 5, style: .continuous)
                .fill(hovered ? NordTheme.badgeFill(colorScheme).opacity(0.7) : Color.clear)
        )
        .padding(.horizontal, 6)
        .padding(.top, 12)
        .padding(.bottom, 3)
        .onHover { hovered = $0 }
        .animation(.easeInOut(duration: 0.12), value: hovered)
        .animation(.easeInOut(duration: 0.18), value: isCollapsed)
    }

    /// Spoken description of the header. The running badge and the chevron
    /// are purely visual, so both are folded in here — otherwise VoiceOver
    /// users get neither the in-flight count nor the disclosure state.
    /// Wording matches the badge tooltip and the `isCollapsed` help text.
    private var accessibilityLabelText: String {
        var parts = ["\(name), \(count) chat\(count == 1 ? "" : "s")"]
        if runningCount > 0 {
            parts.append("\(runningCount) chat\(runningCount == 1 ? "" : "s") running")
        }
        parts.append(isCollapsed ? "Collapsed" : "Expanded")
        return parts.joined(separator: ", ")
    }
}

// MARK: - Sidebar Update Banner

/// Compact update pill shown above the sidebar header. The same visual
/// affordance is used for app updates and omnikey-cli updates so users
/// learn one place to look for required maintenance.
private struct ChatSidebarUpdateBanner: View {
    let title: String
    let subtitle: String?
    let systemImage: String
    var isWorking: Bool = false
    let help: String
    let onUpdate: () -> Void
    @Environment(\.colorScheme) private var colorScheme
    @State private var isHovering: Bool = false

    var body: some View {
        Button(action: onUpdate) {
            HStack(spacing: 8) {
                ZStack {
                    Image(systemName: systemImage)
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundColor(NordTheme.accentAmber(colorScheme))
                        .opacity(isWorking ? 0 : 1)
                    if isWorking {
                        ProgressView()
                            .scaleEffect(0.48)
                            .frame(width: 14, height: 14)
                    }
                }
                .frame(width: 14, height: 14)
                VStack(alignment: .leading, spacing: 1) {
                    Text(title)
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundColor(NordTheme.primaryText(colorScheme))
                    if let subtitle, !subtitle.isEmpty {
                        Text(subtitle)
                            .font(.system(size: 10))
                            .foregroundColor(NordTheme.secondaryText(colorScheme))
                    }
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundColor(NordTheme.secondaryText(colorScheme).opacity(0.7))
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(NordTheme.accentAmber(colorScheme).opacity(isHovering ? 0.16 : 0.10))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .strokeBorder(NordTheme.accentAmber(colorScheme).opacity(0.35), lineWidth: 1)
            )
            .contentShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        }
        .buttonStyle(.plain)
        .disabled(isWorking)
        .onHover { isHovering = $0 }
        .help(help)
        .accessibilityLabel(title)
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
                .accessibilityHint(
                    "Filter the sidebar by chat title, project, or any user message in the chat")

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

/// Stable view-data for one sidebar session row. Keeping the active
/// flag in the row identity fixes a SwiftUI reuse edge case where the
/// conversation changed after selecting another chat but the sidebar
/// highlight remained visually attached to the previously-selected row.
private struct ChatSessionRowItem: Identifiable, Equatable {
    let session: AgentSessionInfo
    let activeSessionId: String?

    var id: String { "\(session.id)-active-\(activeSessionId == session.id)" }
    var isActive: Bool { session.id == activeSessionId }
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
    /// Mirrors the expanded sidebar's update signal so a small amber
    /// dot appears over the expand button when a new version is
    /// available — the affordance survives sidebar collapse without
    /// consuming a dedicated row.
    @ObservedObject private var updateChecker: AppUpdateChecker = .shared
    @ObservedObject private var cliUpdateChecker: CLIUpdateChecker = .shared

    private var hasUpdateAvailable: Bool {
        updateChecker.isUpdateAvailable || cliUpdateChecker.isUpdateAvailable
    }

    var body: some View {
        VStack(spacing: 0) {
            // Expand button
            Button(action: onExpand) {
                ZStack(alignment: .topTrailing) {
                    Image(systemName: "sidebar.left")
                        .font(.system(size: 14, weight: .medium))
                        .foregroundColor(NordTheme.secondaryText(colorScheme))
                        .frame(width: 36, height: 36)
                        .background(
                            RoundedRectangle(cornerRadius: 8, style: .continuous)
                                .fill(Color.clear)
                        )
                        .contentShape(Rectangle())
                    if hasUpdateAvailable {
                        // Amber dot in the corner of the expand
                        // button — non-interactive, purely a hint
                        // to expand the sidebar and click "Update".
                        Circle()
                            .fill(NordTheme.accentAmber(colorScheme))
                            .frame(width: 7, height: 7)
                            .overlay(
                                Circle().strokeBorder(NordTheme.panelBackground(colorScheme), lineWidth: 1)
                            )
                            .offset(x: -6, y: 6)
                            .accessibilityHidden(true)
                    }
                }
            }
            .buttonStyle(.plain)
            .help(hasUpdateAvailable ? "Update available — expand sidebar" : "Expand sidebar")
            .padding(.top, 16)

            // New chat button
            Button(action: { model.startNewChat() }) {
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

                    ForEach(
                        model.sessions.prefix(12).map {
                            ChatSessionRowItem(session: $0, activeSessionId: model.activeSessionId)
                        }
                    ) { item in
                        let session = item.session
                        let isRunning = model.runningSessionIds.contains(session.id)
                        Button(action: { model.openSession(session) }) {
                            ZStack(alignment: .topTrailing) {
                                ZStack {
                                    Circle()
                                        .fill(
                                            item.isActive
                                                ? NordTheme.accent(colorScheme).opacity(0.18)
                                                : NordTheme.badgeFill(colorScheme)
                                        )
                                        .frame(width: 34, height: 34)
                                        .overlay(
                                            Circle()
                                                .strokeBorder(
                                                    item.isActive
                                                        ? NordTheme.accent(colorScheme).opacity(0.40)
                                                        : NordTheme.border(colorScheme),
                                                    lineWidth: 1
                                                )
                                        )
                                    Text(String(session.title.prefix(1)).uppercased())
                                        .font(.system(size: 12, weight: .semibold))
                                        .foregroundColor(
                                            item.isActive
                                                ? NordTheme.accent(colorScheme)
                                                : NordTheme.secondaryText(colorScheme)
                                        )
                                }

                                // Green corner dot mirrors the expanded row's
                                // running indicator so collapsing the sidebar
                                // does not hide in-flight work.
                                if isRunning {
                                    Circle()
                                        .fill(NordTheme.accentGreen(colorScheme))
                                        .frame(width: 8, height: 8)
                                        .overlay(
                                            Circle().strokeBorder(
                                                NordTheme.panelBackground(colorScheme),
                                                lineWidth: 1.5
                                            )
                                        )
                                        .offset(x: 1, y: -1)
                                        .accessibilityHidden(true)
                                }
                            }
                            .frame(width: 34, height: 34)
                        }
                        .buttonStyle(.plain)
                        .id("rail-\(item.id)")
                        .help(isRunning ? "\(session.title) — running" : session.title)
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

/// Reveals one additional ten-thread page for a single sidebar group.
private struct ChatSidebarShowMoreButton: View {
    let remainingCount: Int
    let onShowMore: () -> Void

    @Environment(\.colorScheme) private var colorScheme

    private var nextPageCount: Int {
        min(remainingCount, ChatSidebarView.sessionPageSize)
    }

    var body: some View {
        Button(action: onShowMore) {
            HStack(spacing: 5) {
                Image(systemName: "chevron.down")
                    .font(.system(size: 8.5, weight: .semibold))
                Text("Show \(nextPageCount) more")
                    .font(.system(size: 10.5, weight: .medium))
            }
            .foregroundColor(NordTheme.accentBlue(colorScheme))
            .frame(maxWidth: .infinity)
            .frame(height: 28)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 15)
        .help("Show the next \(nextPageCount) chats")
        .accessibilityLabel("Show \(nextPageCount) more chats")
    }
}

// MARK: - Session Row

/// Relative "last active" formatting for sidebar rows. Kept terse
/// (`now`, `14m`, `3h`, `Yesterday`, `Mar 4`) so it fits the narrow
/// trailing gutter without truncating the chat title.
@MainActor
enum ChatSidebarRelativeDate {
    private static let parser: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private static let fallbackParser: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    // Localized templates rather than fixed `dateFormat` strings: a
    // hard-coded "MMM d" forces US ordering on locales that write the day
    // first. Matches the approach in `ChatMessageTimestamp`.
    private static let monthDay: DateFormatter = {
        let f = DateFormatter()
        f.setLocalizedDateFormatFromTemplate("MMMd")
        return f
    }()

    private static let monthDayYear: DateFormatter = {
        let f = DateFormatter()
        f.setLocalizedDateFormatFromTemplate("MMMdyyyy")
        return f
    }()

    private static let full: DateFormatter = {
        let f = DateFormatter()
        f.dateStyle = .medium
        f.timeStyle = .short
        return f
    }()

    static func date(from iso: String) -> Date? {
        parser.date(from: iso) ?? fallbackParser.date(from: iso)
    }

    static func shortLabel(for iso: String, now: Date = Date()) -> String? {
        guard let date = date(from: iso) else { return nil }
        let seconds = now.timeIntervalSince(date)

        // Clock skew between client and server can make a just-created
        // session look slightly in the future — clamp instead of showing
        // a negative age.
        if seconds < 60 { return "now" }
        if seconds < 3600 { return "\(Int(seconds / 60))m" }

        let calendar = Calendar.current
        if calendar.isDateInToday(date) { return "\(Int(seconds / 3600))h" }
        if calendar.isDateInYesterday(date) { return "Yesterday" }

        if seconds < 7 * 24 * 3600 { return "\(Int(seconds / 86_400))d" }
        if calendar.isDate(date, equalTo: now, toGranularity: .year) {
            return monthDay.string(from: date)
        }
        return monthDayYear.string(from: date)
    }

    /// Full, unabbreviated timestamp used for the row tooltip.
    static func fullLabel(for iso: String) -> String? {
        guard let date = date(from: iso) else { return nil }
        return full.string(from: date)
    }
}

struct ChatSessionRowView: View {
    let session: AgentSessionInfo
    let isActive: Bool
    /// True while a turn for this session is streaming. Rendered as a pulsing
    /// dot so parallel background chats are visible without opening them.
    var isRunning: Bool = false
    /// Query currently typed in the sidebar search field. When non-empty the
    /// matching run in the title is highlighted so the user can see *why* a
    /// row matched.
    var searchQuery: String = ""
    let onTap: () -> Void
    let onRename: (String) -> Void
    let onTogglePin: () -> Void
    let onDelete: () -> Void

    @Environment(\.colorScheme) private var colorScheme
    @State private var isHovered = false
    @State private var runPulse = false
    @State private var isRenaming = false
    @State private var renameText = ""
    @FocusState private var renameFocused: Bool

    private var timestampLabel: String? {
        ChatSidebarRelativeDate.shortLabel(for: session.lastActiveAt)
    }

    private var tooltip: String {
        var parts: [String] = [session.title]
        if session.turns > 0 {
            parts.append("\(session.turns) turn\(session.turns == 1 ? "" : "s")")
        }
        if let full = ChatSidebarRelativeDate.fullLabel(for: session.lastActiveAt) {
            parts.append("Last active \(full)")
        }
        return parts.joined(separator: " · ")
    }

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: 0) {
                // Active indicator bar
                RoundedRectangle(cornerRadius: 1.5)
                    .fill(isActive ? NordTheme.accent(colorScheme) : Color.clear)
                    .frame(width: 3)
                    .padding(.vertical, 8)

                VStack(alignment: .leading, spacing: 1) {
                    HStack(spacing: 5) {
                        if isRunning {
                            Circle()
                                .fill(NordTheme.accentGreen(colorScheme))
                                .frame(width: 5, height: 5)
                                .opacity(runPulse ? 1.0 : 0.3)
                                .accessibilityLabel("Running")
                        }

                        if isRenaming {
                            TextField("Chat name", text: $renameText)
                                .textFieldStyle(.plain)
                                .font(.system(size: 13, weight: .medium))
                                .focused($renameFocused)
                                .onSubmit { commitRename() }
                                .onExitCommand { cancelRename() }
                                .accessibilityLabel("Rename chat")
                        } else {
                            clippedTitle
                        }

                        if session.isPinned && !isRenaming {
                            Image(systemName: "pin.fill")
                                .font(.system(size: 8.5, weight: .medium))
                                .foregroundColor(NordTheme.secondaryText(colorScheme).opacity(0.55))
                                .accessibilityLabel("Pinned")
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)

                    // Secondary metadata line. Hidden while the delete
                    // confirmation is showing so the row does not grow.
                    if let subtitle = subtitleText {
                        Text(subtitle)
                            .font(.system(size: 10))
                            .foregroundColor(NordTheme.secondaryText(colorScheme).opacity(0.5))
                            .lineLimit(1)
                    }
                }
                .padding(.leading, 9)

                trailingAccessory
            }
            .frame(height: subtitleText == nil ? 34 : 42)
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
        .onHover { hovering in
            isHovered = hovering
            // Reset an unconfirmed delete when the pointer leaves, so the
            // row never stays armed after the user moves on.
        }
        .onAppear { if isRunning { startRunPulse() } }
        .onChange(of: isRunning) { _, running in
            if running {
                startRunPulse()
            } else {
                // Ease the dot out instead of snapping it, and wrap the reset
                // in an explicit transaction so the repeating animation is
                // replaced rather than left mid-cycle.
                withAnimation(.easeOut(duration: 0.3)) { runPulse = false }
            }
        }
        .help(tooltip)
        .contextMenu {
            Button("Open") { onTap() }
            Button("Rename…") { beginRename() }
                .accessibilityLabel("Rename \(session.title)")
            Button(session.isPinned ? "Unpin" : "Pin") { onTogglePin() }
                .accessibilityLabel(session.isPinned ? "Unpin \(session.title)" : "Pin \(session.title)")
            Button("Copy Title") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(session.title, forType: .string)
            }
            Divider()
            Button("Delete Chat", role: .destructive) { onDelete() }
        }
        .accessibilityLabel(tooltip)
    }

    private func beginRename() {
        renameText = session.title
        isRenaming = true
        DispatchQueue.main.async { renameFocused = true }
    }

    private func commitRename() {
        let title = renameText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty else {
            renameFocused = true
            return
        }
        onRename(title)
        isRenaming = false
    }

    private func cancelRename() {
        renameText = session.title
        isRenaming = false
    }

    /// Clips long generated titles at the row boundary instead of adding a
    /// typographic ellipsis that can be mistaken for the adjacent actions menu.
    private var clippedTitle: some View {
        GeometryReader { geometry in
            highlightedTitle
                .font(.system(size: 13, weight: isActive ? .medium : .regular))
                .fixedSize(horizontal: true, vertical: false)
                .frame(width: geometry.size.width, alignment: .leading)
                .clipped()
        }
        .frame(height: 17)
        .accessibilityLabel(session.title)
    }

    /// Title with the search match highlighted. Falls back to plain text when
    /// no query is active or the query does not appear in the title (it may
    /// have matched the transcript instead).
    private var highlightedTitle: Text {
        let base = NordTheme.secondaryText(colorScheme)
        let color: Color =
            isActive
            ? NordTheme.primaryText(colorScheme)
            : isHovered ? NordTheme.primaryText(colorScheme).opacity(0.8) : base

        let query = searchQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty,
            let range = session.title.range(
                of: query,
                options: [.caseInsensitive, .diacriticInsensitive]
            )
        else {
            return Text(session.title).foregroundColor(color)
        }

        return Text(String(session.title[session.title.startIndex..<range.lowerBound]))
            .foregroundColor(color)
            + Text(String(session.title[range]))
            .foregroundColor(NordTheme.accent(colorScheme))
            .fontWeight(.semibold)
            + Text(String(session.title[range.upperBound...]))
            .foregroundColor(color)
    }

    /// "12 turns · 3h". Omitted entirely when the backend has not reported
    /// either value, so brand-new placeholder rows stay compact.
    private var subtitleText: String? {
        var parts: [String] = []
        if session.turns > 0 {
            parts.append("\(session.turns) turn\(session.turns == 1 ? "" : "s")")
        }
        if let timestampLabel { parts.append(timestampLabel) }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    /// Native action menu for discoverable thread management. It remains visible
    /// for the selected row and appears on hover for other rows.
    @ViewBuilder
    private var trailingAccessory: some View {
        if isActive || isHovered {
            Menu {
                Button {
                    beginRename()
                } label: {
                    Label("Rename Chat…", systemImage: "pencil")
                }

                Button {
                    onTogglePin()
                } label: {
                    Label(
                        session.isPinned ? "Unpin Chat" : "Pin Chat",
                        systemImage: session.isPinned ? "pin.slash" : "pin"
                    )
                }

                Divider()

                Button {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(session.title, forType: .string)
                } label: {
                    Label("Copy Title", systemImage: "doc.on.doc")
                }

                Divider()

                Button(role: .destructive) {
                    onDelete()
                } label: {
                    Label("Delete Chat", systemImage: "trash")
                }
            } label: {
                Image(systemName: "ellipsis")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundColor(NordTheme.accentBlue(colorScheme))
                    .frame(width: 22, height: 22)
                    .background(Circle().fill(NordTheme.accentBlue(colorScheme).opacity(0.12)))
                    .contentShape(Circle())
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .fixedSize()
            .help("Chat actions")
            .accessibilityLabel("Actions for \(session.title)")
            .transition(.opacity.combined(with: .scale(scale: 0.9)))
            .padding(.trailing, 7)
            .padding(.leading, 6)
        }
    }

    private func startRunPulse() {
        runPulse = false
        withAnimation(.easeInOut(duration: 0.7).repeatForever(autoreverses: true)) {
            runPulse = true
        }
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
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var isNearConversationBottom = true

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
        // Switching from `LazyVStack` to `VStack` here is intentional. History
        // arrives in bounded pages, so eager rendering remains predictable and
        // fixes two
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
                    if (model.hasMoreHistory || model.isLoadingOlderHistory || model.olderHistoryError != nil),
                       !model.messages.isEmpty
                    {
                        ChatHistoryTopLoader(
                            visibleCount: model.messages.count,
                            isLoading: model.isLoadingOlderHistory,
                            error: model.olderHistoryError,
                            action: model.loadOlderMessages
                        )
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
                        .id(message.id)
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
            .background(
                ConversationScrollPositionObserver { nearBottom, nearTop in
                    isNearConversationBottom = nearBottom
                    if nearTop { model.loadOlderMessages() }
                }
            )
            .defaultScrollAnchor(.bottom)
            .onChange(of: model.activeSessionId) { previousSessionID, sessionID in
                guard
                    ChatSessionScrollPolicy.shouldResetForSessionChange(
                        previousSessionID: previousSessionID,
                        sessionID: sessionID
                    )
                else { return }
                isNearConversationBottom = true
                scrollToConversationBottom(proxy)
            }
            .onChange(of: model.isLoadingSessionHistory) { wasLoading, isLoading in
                guard
                    ChatSessionScrollPolicy.shouldResetAfterHydration(
                        wasLoading: wasLoading,
                        isLoading: isLoading,
                        sessionID: model.activeSessionId
                    )
                else { return }
                isNearConversationBottom = true
                scrollToConversationBottom(proxy)
            }
            // Only animate scroll-to-bottom for *live* turn activity. New
            // assistant blocks and the user's own sends should glide into
            // view, but opening an existing chat (where messages.count
            // jumps from 0 to N in a single hydration step) must not —
            // that's the "auto-scroll disrupts loading" bug. The
            // `isRunning` guard keeps the animation scoped to the
            // active turn.
            .onChange(of: model.messages.last?.blocks.count ?? 0) { _, _ in
                guard
                    ChatAutoScrollPolicy.shouldFollow(
                        wasNearBottom: isNearConversationBottom,
                        isLiveUpdate: model.isRunning
                    )
                else { return }
                followLiveScroll(proxy)
            }
            .onChange(of: model.messages.count) { oldCount, newCount in
                // Animate when the user adds a turn (count increments by
                // 1 or 2 during an active run). Skip the initial hydration
                // jump from 0 → N, which is handled by
                // `defaultScrollAnchor(.bottom)`.
                guard newCount > oldCount,
                    oldCount > 0,
                    model.historyPrependAnchorID == nil,
                    ChatAutoScrollPolicy.shouldFollow(
                        wasNearBottom: isNearConversationBottom,
                        isLiveUpdate: model.isRunning
                    )
                else { return }
                followLiveScroll(proxy)
            }
            .onChange(of: model.historyPrependAnchorID) { _, anchor in
                guard let anchor else { return }
                DispatchQueue.main.async {
                    var transaction = Transaction()
                    transaction.animation = nil
                    withTransaction(transaction) {
                        proxy.scrollTo(anchor, anchor: .top)
                    }
                    model.clearHistoryPrependAnchor()
                }
            }
        }
    }

    private func scrollToConversationBottom(_ proxy: ScrollViewProxy) {
        // Wait one main-loop turn so cached, hydrated, and background-running
        // transcripts have installed their rows. Suppressing animation prevents
        // the previous session's retained offset from visibly sweeping downward.
        DispatchQueue.main.async {
            var transaction = Transaction()
            transaction.animation = nil
            withTransaction(transaction) {
                proxy.scrollTo("bottom", anchor: .bottom)
            }
        }
    }

    private func followLiveScroll(_ proxy: ScrollViewProxy) {
        if ChatAutoScrollPolicy.shouldAnimate(reduceMotion: reduceMotion) {
            withAnimation(.easeOut(duration: 0.2)) {
                proxy.scrollTo("bottom", anchor: .bottom)
            }
        } else {
            proxy.scrollTo("bottom", anchor: .bottom)
        }
    }
}

/// Reports whether the user is currently close enough to the end of the
/// transcript to follow streaming updates. It observes user scrolling only;
/// content growth therefore cannot flip the flag to false before the update's
/// `scrollTo` decision is made.
@MainActor
private struct ConversationScrollPositionObserver: NSViewRepresentable {
    let onChange: (Bool, Bool) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onChange: onChange) }

    func makeNSView(context: Context) -> NSView {
        let view = NSView(frame: .zero)
        DispatchQueue.main.async { context.coordinator.attach(from: view) }
        return view
    }

    func updateNSView(_ view: NSView, context: Context) {
        context.coordinator.onChange = onChange
        DispatchQueue.main.async { context.coordinator.attach(from: view) }
    }

    @MainActor
    final class Coordinator: NSObject {
        var onChange: (Bool, Bool) -> Void
        private weak var scrollView: NSScrollView?

        init(onChange: @escaping (Bool, Bool) -> Void) {
            self.onChange = onChange
            super.init()
        }

        deinit {
            NotificationCenter.default.removeObserver(self)
        }

        func attach(from view: NSView) {
            guard let candidate = enclosingScrollView(from: view) else { return }
            if candidate === scrollView {
                publishPosition()
                return
            }
            NotificationCenter.default.removeObserver(self)
            scrollView = candidate
            candidate.contentView.postsBoundsChangedNotifications = true
            NotificationCenter.default.addObserver(
                self,
                selector: #selector(scrollBoundsDidChange),
                name: NSView.boundsDidChangeNotification,
                object: candidate.contentView
            )
            publishPosition()
        }

        @objc private func scrollBoundsDidChange(_ notification: Notification) {
            publishPosition()
        }

        private func enclosingScrollView(from view: NSView) -> NSScrollView? {
            var ancestor: NSView? = view
            while let current = ancestor {
                if let scrollView = current as? NSScrollView { return scrollView }
                if let enclosing = current.enclosingScrollView { return enclosing }
                ancestor = current.superview
            }
            return nil
        }

        private func publishPosition() {
            guard let scrollView, let documentView = scrollView.documentView else { return }
            let visibleBottom = scrollView.contentView.bounds.maxY
            let contentBottom = documentView.bounds.maxY
            onChange(
                ConversationScrollGeometry.isNearBottom(
                    visibleBottom: visibleBottom,
                    contentBottom: contentBottom
                ),
                ConversationScrollGeometry.isNearTop(
                    visibleTop: scrollView.contentView.bounds.minY
                )
            )
        }
    }
}

// MARK: - Header Bar

struct ChatHeaderBar: View {
    @ObservedObject var model: ChatModel
    var onToggleSidebar: () -> Void
    @Environment(\.colorScheme) private var colorScheme

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
                .layoutPriority(1)

            Spacer()

            if let session = model.activeSession {
                ChatSessionInfoCard(
                    session: session,
                    visibleTurnCount: model.messages.filter { $0.role == .user }.count,
                    projectName: model.displayedProjectName
                )
                .transition(.opacity.combined(with: .scale(scale: 0.97)))
            }

        }
        .animation(.easeInOut(duration: 0.18), value: model.activeSessionId)
        .padding(.horizontal, 20)
        .padding(.vertical, 12)
        .frame(minHeight: 52)
    }
}

struct ChatSessionInfoPresentation: Equatable {
    let project: String
    let turns: String

    init(session: AgentSessionInfo, visibleTurnCount: Int, projectName: String) {
        project = projectName == "Select project" ? "No project" : projectName
        let count = max(session.turns, visibleTurnCount)
        turns = "\(count) \(count == 1 ? "turn" : "turns")"
    }
}

private struct ChatSessionInfoCard: View {
    let presentation: ChatSessionInfoPresentation
    @Environment(\.colorScheme) private var colorScheme

    init(session: AgentSessionInfo, visibleTurnCount: Int, projectName: String) {
        presentation = ChatSessionInfoPresentation(
            session: session,
            visibleTurnCount: visibleTurnCount,
            projectName: projectName
        )
    }

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 10) {
                infoItem(icon: "folder", text: presentation.project)
                divider
                infoItem(icon: "bubble.left", text: presentation.turns)
            }
            .fixedSize(horizontal: true, vertical: false)

            infoItem(icon: "bubble.left", text: presentation.turns)
                .fixedSize(horizontal: true, vertical: false)
        }
        .font(OKFont.captionSmall)
        .foregroundColor(NordTheme.secondaryText(colorScheme))
        .padding(.horizontal, 10)
        .frame(height: 30)
        .background(
            RoundedRectangle(cornerRadius: 9, style: .continuous)
                .fill(NordTheme.badgeFill(colorScheme).opacity(0.72))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 9, style: .continuous)
                .strokeBorder(NordTheme.border(colorScheme), lineWidth: 1)
        )
        .accessibilityElement(children: .combine)
        .accessibilityLabel(
            [presentation.project, presentation.turns].joined(separator: ", ")
        )
    }

    private func infoItem(icon: String, text: String) -> some View {
        Label(text, systemImage: icon)
            .lineLimit(1)
    }

    private var divider: some View {
        Rectangle()
            .fill(NordTheme.border(colorScheme))
            .frame(width: 1, height: 13)
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

/// Accessible top sentinel for cursor-paged history. It auto-loads when it
/// enters the viewport and remains clickable for retry or keyboard users.
enum ChatHistoryTopLoadPolicy {
    static func shouldLoad(isLoading: Bool, error: String?) -> Bool {
        !isLoading && error == nil
    }
}

private struct ChatHistoryTopLoader: View {
    let visibleCount: Int
    let isLoading: Bool
    let error: String?
    let action: () -> Void
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        Button(action: action) {
            HStack(spacing: 7) {
                if isLoading {
                    ProgressView().controlSize(.small)
                } else {
                    Image(systemName: error == nil ? "clock.arrow.circlepath" : "arrow.clockwise")
                        .font(OKFont.eyebrow)
                }
                VStack(alignment: .leading, spacing: 1) {
                    Text(isLoading ? "Loading earlier messages…" : (error == nil ? "Load earlier messages" : "Retry earlier messages"))
                        .font(OKFont.captionSmall)
                    Text(error ?? "Showing \(visibleCount) newest messages")
                        .font(OKFont.captionSmall)
                        .opacity(0.72)
                }
            }
            .foregroundColor(error == nil ? NordTheme.secondaryText(colorScheme) : .red)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(Capsule().fill(NordTheme.badgeFill(colorScheme)))
            .overlay(Capsule().strokeBorder(NordTheme.border(colorScheme), lineWidth: 1))
        }
        .buttonStyle(.plain)
        .disabled(isLoading)
        .accessibilityLabel(error == nil ? "Load earlier messages" : "Retry loading earlier messages")
        .frame(maxWidth: .infinity, alignment: .center)
        .onAppear {
            if ChatHistoryTopLoadPolicy.shouldLoad(isLoading: isLoading, error: error) {
                action()
            }
        }
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
                // Centre vertically when content is shorter than the view;
                // scroll naturally when tiles overflow.
                .frame(maxWidth: .infinity, minHeight: geo.size.height, alignment: .center)
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
    @State private var inputHeight: CGFloat = ChatComposerMetrics.minimumHeight
    @State private var isSendHovered = false

    private var inputIsEmpty: Bool {
        model.inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var isStopState: Bool {
        model.isRunning && inputIsEmpty
    }

    private var isSteeringState: Bool {
        model.isRunning && !inputIsEmpty
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
                    Text(model.isRunning ? "Steer the current task…" : "Ask OmniAgent anything…")
                        .font(.system(size: ChatComposerMetrics.fontSize))
                        .foregroundColor(NordTheme.secondaryText(colorScheme).opacity(0.45))
                        .padding(.horizontal, 16)
                        .padding(.vertical, 10)
                        .allowsHitTesting(false)
                }
                ChatMarkdownInput(
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
                    inputHeight = ChatComposerMetrics.height(for: newValue)
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
            //
            // Each pill's `Menu` is still `.fixedSize()`, but the
            // title text inside `ComposerPillLabel` is now capped at
            // `maxTitleWidth` and truncates with an ellipsis. Before
            // that cap, a long task-instruction heading, project
            // name, or custom agent-model label would inflate the
            // menus enough to push the send button and other
            // dropdowns off the right edge of the composer at the
            // window's default (non-maximised) width — the user could
            // not click those controls until they resized the window
            // wider. See `ComposerPillLabel.maxTitleWidth`.
            HStack(spacing: 8) {
                // Task instruction dropdown
                if !model.availableTaskTemplates.isEmpty || !model.canChangeSessionSetup {
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
                            icon: model.canChangeSessionSetup ? "text.badge.star" : "lock.fill",
                            title: model.displayedTaskInstructionTitle,
                            isActive: model.hasDisplayedTaskInstruction,
                            activeColor: NordTheme.accent(colorScheme),
                            colorScheme: colorScheme,
                            showsChevron: model.canChangeSessionSetup
                        )
                    }
                    .menuStyle(.borderlessButton)
                    .fixedSize()
                    .disabled(model.isUpdatingDefaultTaskTemplate || !model.canChangeSessionSetup)
                    .help(
                        model.canChangeSessionSetup
                            ? "Choose task instructions" : "Task instructions are locked after a session starts")
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
                    .disabled(!model.canChangeSessionSetup)
                    .help(
                        model.canChangeSessionSetup
                            ? "Add instruction" : "Task instructions are locked after a session starts")
                }

                // Project path / group dropdown
                Menu {
                    Button {
                        guard model.canChangeSessionSetup else { return }
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
                                guard model.canChangeSessionSetup else { return }
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
                        icon: model.canChangeSessionSetup ? "folder" : "lock.fill",
                        title: model.displayedProjectName,
                        isActive: model.hasDisplayedProject,
                        activeColor: NordTheme.accentGreen(colorScheme),
                        colorScheme: colorScheme,
                        showsChevron: model.canChangeSessionSetup
                    )
                }
                .menuStyle(.borderlessButton)
                .fixedSize()
                .disabled(!model.canChangeSessionSetup)
                .help(
                    model.canChangeSessionSetup
                        ? "Choose project" : "Project is locked after a session starts")

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

                AgentModelMenu(model: model)

                // Send / Steer / Stop
                // • Has text + idle → start a new turn
                // • Has text + running → steer the active turn over its existing socket
                // • No text + running → stop button
                // • No text + idle → disabled send button
                Button {
                    if !inputIsEmpty {
                        model.sendCurrentInput()
                    } else if model.isRunning {
                        model.cancelCurrentTurn()
                    }
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
                        Image(systemName: sendButtonIconName)
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
                .help(sendButtonHelp)
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
        if isSteeringState { return NordTheme.accentGreen(colorScheme) }
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
        if isSteeringState { return NordTheme.accentGreen(colorScheme).opacity(0.35) }
        return NordTheme.accent(colorScheme).opacity(0.35)
    }

    private var sendButtonIconName: String {
        if isStopState { return "stop.fill" }
        if isSteeringState { return "arrow.up.right" }
        return "arrow.up"
    }

    private var sendButtonHelp: String {
        if isStopState { return "Stop current turn" }
        if isSteeringState { return "Steer current task  ·  ⏎" }
        return "Send message  ·  ⏎"
    }
}

// MARK: - Agent Model Menu

private struct AgentModelMenu: View {
    @ObservedObject var model: ChatModel
    @Environment(\.colorScheme) private var colorScheme
    @State private var showsCustomModelPopover = false
    @State private var customModelInput = ""

    private var menuOptions: [APIClient.AgentModelOptionDTO] {
        var options = model.activeAgentModelOptions
        if !model.activeAgentModel.isEmpty,
            !options.contains(where: { $0.id == model.activeAgentModel })
        {
            options.insert(
                APIClient.AgentModelOptionDTO(
                    id: model.activeAgentModel,
                    label: "Custom: \(model.activeAgentModel)"
                ),
                at: 0
            )
        }
        return options
    }

    var body: some View {
        if !menuOptions.isEmpty {
            Menu {
                ForEach(menuOptions) { option in
                    Button {
                        model.setAgentModel(option.id)
                    } label: {
                        if option.id == model.activeAgentModel {
                            Label(option.label, systemImage: "checkmark")
                        } else {
                            Text(option.label)
                        }
                    }
                }
                Divider()
                Button("Custom model…") {
                    customModelInput = model.activeAgentModel
                    showsCustomModelPopover = true
                }
            } label: {
                ComposerPillLabel(
                    icon: model.isUpdatingAgentModel ? "hourglass" : "cpu",
                    title: model.activeAgentModelLabel,
                    isActive: true,
                    activeColor: NordTheme.accentPurple(colorScheme),
                    colorScheme: colorScheme
                )
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
            .disabled(model.isRunning || model.isUpdatingAgentModel)
            .help(model.isRunning ? "Model is locked while a turn is running" : "Choose agent model")
            .popover(isPresented: $showsCustomModelPopover) {
                VStack(alignment: .leading, spacing: 12) {
                    Text("Custom model")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundColor(NordTheme.primaryText(colorScheme))

                    TextField("provider-model-id", text: $customModelInput)
                        .textFieldStyle(.roundedBorder)
                        .frame(width: 280)

                    Text("Use the exact model ID for \(model.activeAIProvider).")
                        .font(.system(size: 11))
                        .foregroundColor(NordTheme.secondaryText(colorScheme))

                    HStack {
                        Button("Cancel") {
                            showsCustomModelPopover = false
                        }
                        .buttonStyle(.bordered)

                        Spacer()

                        Button("Apply") {
                            let trimmed = customModelInput.trimmingCharacters(in: .whitespacesAndNewlines)
                            if !trimmed.isEmpty {
                                showsCustomModelPopover = false
                                model.setAgentModel(trimmed)
                            }
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(NordTheme.accent(colorScheme))
                        .disabled(customModelInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }
                .padding(16)
            }
        }
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
    /// Upper bound on the width of the title label. Very long titles
    /// (e.g. a task-instruction heading, a long project name, or a
    /// custom model ID) used to expand the enclosing `Menu` so far
    /// that the send / stop button and other dropdowns were pushed
    /// off the right edge of the composer at the chat window's
    /// default width. Constraining the title width forces truncation
    /// with an ellipsis instead so every control stays clickable.
    var maxTitleWidth: CGFloat = 140

    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: icon)
                .font(.system(size: 10, weight: .semibold))
            Text(title)
                .font(.system(size: 11.5, weight: .medium))
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(maxWidth: maxTitleWidth, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
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
            UserBubbleView(
                text: message.text,
                sentAt: message.sentAt,
                steeringState: message.steeringState
            )
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

/// Formats the "sent at" label under a user message.
///
/// - Today: `2:41 PM`
/// - Yesterday: `Yesterday 2:41 PM`
/// - Earlier this year: `Mar 4, 2:41 PM`
/// - Earlier years: `Mar 4, 2024, 2:41 PM`
///
/// Uses locale-aware templates rather than hard-coded patterns so 24-hour
/// locales render `14:41` instead of a forced AM/PM string.
@MainActor
enum ChatMessageTimestamp {
    private static let time: DateFormatter = {
        let f = DateFormatter()
        f.setLocalizedDateFormatFromTemplate("j:mm")
        return f
    }()

    // Date and time are formatted separately and joined with a comma.
    // Combining them in one template yields the verbose connector form
    // ("Jul 23 at 12:43 PM"), which is too long for this small label.
    private static let sameYearDate: DateFormatter = {
        let f = DateFormatter()
        f.setLocalizedDateFormatFromTemplate("MMMd")
        return f
    }()

    private static let otherYearDate: DateFormatter = {
        let f = DateFormatter()
        f.setLocalizedDateFormatFromTemplate("MMMdyyyy")
        return f
    }()

    private static let full: DateFormatter = {
        let f = DateFormatter()
        f.dateStyle = .full
        f.timeStyle = .short
        return f
    }()

    static func label(for date: Date, now: Date = Date()) -> String {
        let calendar = Calendar.current

        if calendar.isDateInToday(date) {
            return time.string(from: date)
        }
        if calendar.isDateInYesterday(date) {
            return "Yesterday \(time.string(from: date))"
        }
        if calendar.isDate(date, equalTo: now, toGranularity: .year) {
            return "\(sameYearDate.string(from: date)), \(time.string(from: date))"
        }
        return "\(otherYearDate.string(from: date)), \(time.string(from: date))"
    }

    /// Unabbreviated timestamp for the tooltip, so the exact moment is always
    /// recoverable even when the label says "Yesterday".
    static func fullLabel(for date: Date) -> String {
        full.string(from: date)
    }
}

struct UserBubbleView: View {
    let text: String
    /// When the user sent the message. `nil` for messages hydrated from
    /// server history, where no send time is available.
    var sentAt: Date? = nil
    var steeringState: SteeringDeliveryState? = nil
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

                // Footer: send time on the left, copy action on the right.
                // Sharing one row keeps the bubble's vertical rhythm
                // unchanged from before the timestamp was added.
                HStack(spacing: 8) {
                    if let steeringState {
                        HStack(spacing: 4) {
                            Image(systemName: steeringIcon(for: steeringState))
                                .font(.system(size: 10, weight: .semibold))
                            Text(steeringLabel(for: steeringState))
                                .font(.system(size: 10, weight: .medium))
                                .lineLimit(2)
                        }
                        .foregroundColor(steeringColor(for: steeringState).opacity(0.82))
                        .help(steeringHelp(for: steeringState))
                    }
                    if let sentAt {
                        Text(ChatMessageTimestamp.label(for: sentAt))
                            .font(.system(size: 10))
                            .monospacedDigit()
                            .foregroundColor(NordTheme.secondaryText(colorScheme).opacity(0.55))
                            .help(ChatMessageTimestamp.fullLabel(for: sentAt))
                            .accessibilityLabel("Sent \(ChatMessageTimestamp.fullLabel(for: sentAt))")
                    }
                    Spacer(minLength: 0)
                    ChatCopyButton(text: text, title: "Copy message")
                }
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
        let structuralPrefixes = [
            "# ", "## ", "### ", "#### ", "##### ", "###### ", "- ", "* ", "+ ", "• ", "> ",
        ]
        for prefix in structuralPrefixes where trimmed.hasPrefix(prefix) { return true }
        if trimmed.range(of: #"^\d+[\.\)]\s+"#, options: .regularExpression) != nil { return true }
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
        if let steeringState {
            return steeringColor(for: steeringState).opacity(colorScheme == .dark ? 0.16 : 0.09)
        }
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
        if let steeringState {
            return steeringColor(for: steeringState).opacity(colorScheme == .dark ? 0.30 : 0.24)
        }
        switch colorScheme {
        case .dark:
            return NordTheme.accent(colorScheme).opacity(0.32)
        default:
            return NordTheme.accent(colorScheme).opacity(0.22)
        }
    }

    private func steeringLabel(for state: SteeringDeliveryState) -> String {
        switch state {
        case .pending: return "Sending update…"
        case let .received(pendingCount):
            guard let pendingCount, pendingCount > 1 else { return "Update queued for current task" }
            return "Update queued · \(pendingCount) pending"
        case .applied: return "Applied to current task"
        case let .failed(reason): return "Update not applied · \(reason)"
        }
    }

    private func steeringIcon(for state: SteeringDeliveryState) -> String {
        switch state {
        case .pending: return "clock"
        case .received: return "tray.and.arrow.down.fill"
        case .applied: return "checkmark.circle.fill"
        case .failed: return "exclamationmark.triangle.fill"
        }
    }

    private func steeringColor(for state: SteeringDeliveryState) -> Color {
        switch state {
        case .pending, .received: return NordTheme.accentBlue(colorScheme)
        case .applied: return NordTheme.accentGreen(colorScheme)
        case .failed: return Color(red: 0.92, green: 0.33, blue: 0.35)
        }
    }

    private func steeringHelp(for state: SteeringDeliveryState) -> String {
        switch state {
        case .pending: return "Waiting for the server to acknowledge this update"
        case .received: return "The server queued this update for the running task"
        case .applied: return "The running task received this update"
        case let .failed(reason): return reason
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
        message.blocks.filter { block in
            guard block.kind != .finalAnswer else { return false }
            // Only genuine reasoning is subject to the noise filter. A block
            // that reclassifies to a tool kind is a real step and must be
            // kept — it is shown as that tool, not as reasoning.
            let effective = AgentTimelineSummarizer.classify(kind: block.kind, text: block.text)
            guard effective == .agentReasoning else { return true }
            // Drop reasoning steps that are nothing but command noise:
            // rendering them produces empty, meaningless timeline rows.
            return !AgentTimelineSummarizer.reasoningProse(block.text).isEmpty
        }
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
                    AgentExecutionHistoryView(
                        blocks: thinkingBlocks,
                        isStreaming: isStreaming && finalBlock == nil,
                        completionDate: finalBlock?.createdAt,
                        finalAnswer: finalBlock?.text
                    )
                }
                if let final = finalBlock {
                    FinalAnswerView(block: final)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - Final Answer

struct FinalAnswerView: View {
    let block: ChatBlock
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ObservedObject private var model = ChatModel.shared
    @State private var showFullContent = false

    private var displayedText: String {
        ProgressiveBlockContent.displayedText(for: block, showFullContent: showFullContent)
    }

    private var hasProgressiveContent: Bool { block.previewText != nil }
    private var isLoading: Bool {
        block.fullContentID.map { model.fullContentLoadingIDs.contains($0) } ?? false
    }

    var body: some View {
        // Soft "paper" surface: a low-contrast lift on top of the
        // editor background so the final answer reads as its own
        // container without ever feeling bright. The copy icon stays
        // permanently anchored bottom-right.
        VStack(alignment: .trailing, spacing: 6) {
            // The final answer is rendered by Textual's
            // `StructuredText`, which builds on SwiftUI's own text
            // rendering pipeline but ships a proper multi-block text
            // selection implementation. That gives users native
            // click-and-drag selection across headings, paragraphs,
            // lists, block quotes, and tables — the single biggest
            // gap in every previous rendering approach we tried
            // (per-`Text` `.textSelection(.enabled)`, NSTextView with
            // hand-built NSAttributedString spacing, MarkdownUI).
            //
            // We start from the `.gitHub` preset for typography +
            // spacing (which fixes the paragraph-alignment issues
            // the ad-hoc NSParagraphStyle helper produced) and
            // overlay a Nord-flavoured `InlineStyle` so code spans,
            // links, and strong text match the rest of the app.
            // A slightly larger base font makes the answer easier to
            // read at typical chat window widths — the `.gitHub`
            // preset's default of ~13pt looked cramped against the
            // surrounding chrome. `.font(...)` sets the body size;
            // headings scale off it proportionally through Textual's
            // font-scale system.
            StructuredText(markdown: displayedText)
                .textual.structuredTextStyle(.gitHub)
                .textual.inlineStyle(nordInlineStyle)
                .textual.textSelection(.enabled)
                .font(.system(size: 14.5))
                .frame(maxWidth: .infinity, alignment: .leading)

            HStack(spacing: 10) {
                if hasProgressiveContent {
                    Button(action: toggleFullContent) {
                        HStack(spacing: 5) {
                            if isLoading { ProgressView().controlSize(.small) }
                            Text(fullContentButtonLabel)
                        }
                    }
                    .buttonStyle(.plain)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundColor(NordTheme.accentBlue(colorScheme))
                    .disabled(isLoading)
                }
                Spacer()
                ChatCopyButton(
                    text: block.text,
                    title: hasProgressiveContent ? "Copy complete answer" : "Copy answer",
                    copyProvider: block.isContentTruncated ? { completion in
                        model.loadFullBlockContent(block, completion: completion)
                    } : nil
                )
            }
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

    private var fullContentButtonLabel: String {
        if isLoading { return "Loading complete answer…" }
        if showFullContent { return "Collapse long answer" }
        return "Show complete answer · \(ProgressiveBlockContent.sizeLabel(for: block))"
    }

    private func toggleFullContent() {
        if block.isContentTruncated {
            model.loadFullBlockContent(block) { text in
                guard text != nil else { return }
                withAnimation(
                    AgentTimelineMotionPolicy.shouldAnimate(reduceMotion: reduceMotion)
                        ? .easeInOut(duration: 0.18) : nil
                ) { showFullContent = true }
            }
        } else {
            withAnimation(
                AgentTimelineMotionPolicy.shouldAnimate(reduceMotion: reduceMotion)
                    ? .easeInOut(duration: 0.18) : nil
            ) { showFullContent.toggle() }
        }
    }

    /// Inline styling shared across the final answer. Applied on top
    /// of `.gitHub`, this only overrides the runs whose default look
    /// (blue link colour, red inline-code chip, plain strikethrough)
    /// would clash with the Nord palette used elsewhere in the chat.
    ///
    /// Backticks (`.code`) get a heavier semibold weight and a
    /// slightly larger relative size (0.92 vs the previous 0.85) so
    /// inline code reads as a strong, scannable chip against
    /// surrounding prose rather than shrinking away from it.
    private var nordInlineStyle: InlineStyle {
        InlineStyle()
            .link(
                .foregroundColor(NordTheme.accentBlue(colorScheme)),
                .underlineStyle(.single)
            )
            .code(
                .monospaced,
                .fontScale(0.92),
                .fontWeight(.semibold),
                .foregroundColor(NordTheme.primaryText(colorScheme)),
                .backgroundColor(NordTheme.badgeFill(colorScheme))
            )
            .strong(.fontWeight(.semibold))
            .strikethrough(
                .foregroundColor(NordTheme.secondaryText(colorScheme))
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

struct ChatCopyButton: View {
    let text: String
    var title: String = "Copy"
    var copyProvider: ((@escaping (String?) -> Void) -> Void)? = nil
    /// When true (the default), the button renders as a compact
    /// icon-only square — used for the persistent affordances on the
    /// final answer and user bubble. Set to false to get the original
    /// "icon + Copy" label (e.g. inside the code-block toolbar).
    var iconOnly: Bool = true
    @Environment(\.colorScheme) private var colorScheme
    @State private var copied = false
    @State private var hovered = false
    @State private var isLoading = false

    var body: some View {
        Button(action: copy) {
            Group {
                if iconOnly {
                    Image(systemName: copied ? "checkmark" : (isLoading ? "hourglass" : "doc.on.doc"))
                        .font(.system(size: 11, weight: .semibold))
                        .frame(width: 22, height: 22)
                } else {
                    HStack(spacing: 4) {
                        Image(systemName: copied ? "checkmark" : (isLoading ? "hourglass" : "doc.on.doc"))
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
        .disabled(isLoading)
        .onHover { hovered = $0 }
        .animation(.easeInOut(duration: 0.12), value: hovered)
        .help(copied ? "Copied" : title)
    }

    private func copy() {
        if let copyProvider {
            isLoading = true
            copyProvider { value in
                DispatchQueue.main.async {
                    isLoading = false
                    guard let value else { return }
                    writeToPasteboard(value)
                }
            }
            return
        }
        writeToPasteboard(text)
    }

    private func writeToPasteboard(_ value: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(value, forType: .string)
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
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(parsed.enumerated()), id: \.offset) { _, block in
                switch block {
                case .code(let language, let code):
                    ChatCodeBlockView(language: language, code: code, baseFontSize: baseFontSize)
                case .heading(let level, let content):
                    markdownText(content, size: headingSize(level), weight: .semibold)
                        .padding(.top, level == 1 ? 5 : 2)
                        .padding(.bottom, level <= 2 ? 1 : 0)
                case .paragraph(let content):
                    markdownText(content)
                case .list(let items):
                    listView(items: items)
                case .quote(let content):
                    HStack(alignment: .top, spacing: 9) {
                        RoundedRectangle(cornerRadius: 1)
                            .fill(NordTheme.accent(colorScheme).opacity(0.35))
                            .frame(width: 3)
                        ChatMarkdownView(text: content, baseFontSize: max(baseFontSize - 0.5, 10.5))
                            .foregroundColor(NordTheme.secondaryText(colorScheme))
                            .padding(.vertical, 1)
                    }
                    .padding(.vertical, 1)
                case .divider:
                    Rectangle()
                        .fill(NordTheme.border(colorScheme))
                        .frame(height: 1)
                        .padding(.vertical, 4)
                case .table(let header, let rows):
                    MarkdownTableView(header: header, rows: rows, baseFontSize: baseFontSize)
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
        let resolvedSize = size ?? baseFontSize
        let attributed = ChatMarkdownCache.shared.inlineAttributed(
            prose,
            baseFontSize: resolvedSize,
            colorScheme: colorScheme
        )
        Text(attributed)
            .font(.system(size: resolvedSize, weight: weight))
            .foregroundColor(NordTheme.primaryText(colorScheme))
            .tint(NordTheme.accentBlue(colorScheme))
            .lineSpacing(2)
            .textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func listView(items: [MarkdownListItem]) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                HStack(alignment: .top, spacing: 8) {
                    listMarker(item, fallbackIndex: index)
                    markdownText(item.text)
                }
                .padding(.leading, CGFloat(item.level) * 18)
            }
        }
        .padding(.vertical, 1)
    }

    @ViewBuilder
    private func listMarker(_ item: MarkdownListItem, fallbackIndex: Int) -> some View {
        if let checked = item.checked {
            Image(systemName: checked ? "checkmark.square.fill" : "square")
                .font(.system(size: max(baseFontSize - 0.5, 10), weight: .medium))
                .foregroundColor(
                    checked ? NordTheme.accentGreen(colorScheme) : NordTheme.secondaryText(colorScheme)
                )
                .frame(width: 17, alignment: .trailing)
                .padding(.top, 1)
        } else {
            Text(item.marker ?? "\(fallbackIndex + 1).")
                .font(.system(size: baseFontSize, weight: .medium))
                .foregroundColor(NordTheme.secondaryText(colorScheme))
                .frame(width: item.markerWidth, alignment: .trailing)
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
        case list([MarkdownListItem])
        case quote(String)
        case code(String?, String)
        case divider
        case table([String], [[String]])
    }

    fileprivate struct MarkdownListItem: Equatable {
        let level: Int
        let marker: String?
        let checked: Bool?
        let text: String

        var markerWidth: CGFloat {
            guard let marker else { return 17 }
            return min(max(CGFloat(marker.count) * 7, 17), 36)
        }
    }

    fileprivate static func parseBlocks(from text: String) -> [MarkdownBlock] {
        var result: [MarkdownBlock] = []
        let normalizedText =
            text
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
        let lines = normalizedText.split(separator: "\n", omittingEmptySubsequences: false).map(
            String.init)
        var i = 0

        while i < lines.count {
            let line = lines[i]
            let trimmed = line.trimmingCharacters(in: .whitespaces)

            if trimmed.isEmpty {
                i += 1
                continue
            }

            if let fence = parseFenceStart(trimmed) {
                let lang = fence.info.trimmingCharacters(in: .whitespaces)
                var codeLines: [String] = []
                i += 1
                while i < lines.count
                    && !isFenceEnd(lines[i].trimmingCharacters(in: .whitespaces), marker: fence.marker)
                {
                    codeLines.append(lines[i])
                    i += 1
                }
                result.append(.code(lang.isEmpty ? nil : lang, codeLines.joined(separator: "\n")))
                if i < lines.count { i += 1 }
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

            if parseListLine(line) != nil {
                let list = parseList(startingAt: i, lines: lines)
                result.append(.list(list.items))
                i = list.nextIndex
                continue
            }

            if trimmed.hasPrefix(">") {
                var quoteLines: [String] = []
                while i < lines.count {
                    let current = lines[i].trimmingCharacters(in: .whitespaces)
                    guard current.hasPrefix(">") else {
                        if current.isEmpty {
                            quoteLines.append("")
                            i += 1
                            continue
                        }
                        break
                    }
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
                if currentTrimmed.isEmpty || parseFenceStart(currentTrimmed) != nil
                    || parseHeading(currentTrimmed) != nil || isDivider(currentTrimmed)
                    || isTableStart(at: i, lines: lines) || parseListLine(current) != nil
                    || currentTrimmed.hasPrefix(">")
                {
                    break
                }
                paragraphLines.append(current)
                i += 1
            }
            result.append(.paragraph(paragraphText(from: paragraphLines)))
        }

        return result
    }

    fileprivate static func paragraphText(from lines: [String]) -> String {
        var rendered = ""
        for rawLine in lines {
            let backslashBreak = rawLine.hasSuffix("\\")
            let hardBreak = rawLine.hasSuffix("  ") || backslashBreak
            var line = rawLine.trimmingCharacters(in: .whitespaces)
            if backslashBreak, line.hasSuffix("\\") {
                line.removeLast()
            }
            if rendered.isEmpty {
                rendered = hardBreak ? line + "\n" : line
            } else if rendered.hasSuffix("\n") {
                rendered += hardBreak ? line + "\n" : line
            } else {
                rendered += hardBreak ? " " + line + "\n" : " " + line
            }
        }
        return rendered.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    fileprivate static func parseFenceStart(_ line: String) -> (marker: String, info: String)? {
        guard let first = line.first, first == "`" || first == "~" else { return nil }
        let count = line.prefix { $0 == first }.count
        guard count >= 3 else { return nil }
        let marker = String(repeating: String(first), count: count)
        let info = String(line.dropFirst(count))
        return (marker, info)
    }

    fileprivate static func isFenceEnd(_ line: String, marker: String) -> Bool {
        guard let first = marker.first, line.first == first else { return false }
        let count = line.prefix { $0 == first }.count
        guard count >= marker.count else { return false }
        return line.dropFirst(count).trimmingCharacters(in: .whitespaces).isEmpty
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
        let compact = line.replacingOccurrences(of: " ", with: "")
        return compact.count >= 3
            && (compact.allSatisfy { $0 == "-" } || compact.allSatisfy { $0 == "*" }
                || compact.allSatisfy { $0 == "_" })
    }

    fileprivate static func parseList(
        startingAt index: Int,
        lines: [String]
    ) -> (items: [MarkdownListItem], nextIndex: Int) {
        struct Builder {
            let indent: Int
            let level: Int
            let marker: String?
            let checked: Bool?
            var text: String
        }

        var items: [MarkdownListItem] = []
        var current: Builder?
        var i = index

        func flushCurrent() {
            guard let item = current else { return }
            let rendered = paragraphText(from: item.text.components(separatedBy: "\n"))
            items.append(
                MarkdownListItem(
                    level: item.level,
                    marker: item.marker,
                    checked: item.checked,
                    text: rendered
                ))
            current = nil
        }

        while i < lines.count {
            let line = lines[i]
            let trimmed = line.trimmingCharacters(in: .whitespaces)

            if trimmed.isEmpty {
                break
            }

            if let parsed = parseListLine(line) {
                flushCurrent()
                current = Builder(
                    indent: parsed.indent,
                    level: parsed.level,
                    marker: parsed.marker,
                    checked: parsed.checked,
                    text: parsed.text
                )
                i += 1
                continue
            }

            if let existing = current,
                leadingWhitespaceColumn(line) > existing.indent,
                parseFenceStart(trimmed) == nil,
                parseHeading(trimmed) == nil,
                !isDivider(trimmed),
                !isTableStart(at: i, lines: lines),
                !trimmed.hasPrefix(">")
            {
                var updated = existing
                updated.text += "\n" + trimmed
                current = updated
                i += 1
                continue
            }

            break
        }

        flushCurrent()
        return (items, i)
    }

    fileprivate static func parseListLine(
        _ line: String
    ) -> (indent: Int, level: Int, marker: String?, checked: Bool?, text: String)? {
        let indent = leadingWhitespaceColumn(line)
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return nil }

        let markerAndText: (marker: String?, body: String)?
        if let first = trimmed.first,
            Set<Character>(["-", "*", "+", "•"]).contains(first),
            trimmed.dropFirst().first == " "
        {
            markerAndText = ("•", String(trimmed.dropFirst(2)))
        } else if let ordered = orderedListMarkerAndText(trimmed) {
            markerAndText = ordered
        } else {
            markerAndText = nil
        }

        guard let markerAndText else { return nil }
        let task = taskStateAndText(markerAndText.body)
        return (
            indent,
            min(indent / 2, 5),
            markerAndText.marker,
            task.checked,
            task.text.trimmingCharacters(in: .whitespaces)
        )
    }

    fileprivate static func orderedListMarkerAndText(_ line: String) -> (
        marker: String?, body: String
    )? {
        guard let delimiterIndex = line.firstIndex(where: { $0 == "." || $0 == ")" }) else {
            return nil
        }
        let prefix = line[..<delimiterIndex]
        guard !prefix.isEmpty, prefix.allSatisfy(\.isNumber) else { return nil }
        let after = line.index(after: delimiterIndex)
        guard after < line.endIndex, line[after] == " " else { return nil }
        let marker = String(prefix) + String(line[delimiterIndex])
        let body = String(line[line.index(after: after)...])
        return (marker, body)
    }

    fileprivate static func taskStateAndText(_ raw: String) -> (checked: Bool?, text: String) {
        let trimmed = raw.trimmingCharacters(in: .whitespaces)
        let lower = trimmed.lowercased()
        if lower.hasPrefix("[x] ") {
            return (true, String(trimmed.dropFirst(4)))
        }
        if lower == "[x]" {
            return (true, "")
        }
        if lower.hasPrefix("[ ] ") {
            return (false, String(trimmed.dropFirst(4)))
        }
        if lower == "[ ]" {
            return (false, "")
        }
        return (nil, raw)
    }

    fileprivate static func leadingWhitespaceColumn(_ line: String) -> Int {
        var count = 0
        for character in line {
            if character == " " {
                count += 1
            } else if character == "\t" {
                count += 4
            } else {
                break
            }
        }
        return count
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
        var cells: [String] = []
        var current = ""
        var isEscaped = false
        var inCodeSpan = false
        var index = trimmed.startIndex

        while index < trimmed.endIndex {
            let character = trimmed[index]
            if isEscaped {
                current.append(character)
                isEscaped = false
                index = trimmed.index(after: index)
                continue
            }

            if character == "\\" {
                isEscaped = true
                index = trimmed.index(after: index)
                continue
            }

            if character == "`" {
                inCodeSpan.toggle()
                while index < trimmed.endIndex, trimmed[index] == "`" {
                    current.append(trimmed[index])
                    index = trimmed.index(after: index)
                }
                continue
            }

            if character == "|", !inCodeSpan {
                cells.append(current.trimmingCharacters(in: .whitespaces))
                current = ""
            } else {
                current.append(character)
            }
            index = trimmed.index(after: index)
        }

        cells.append(current.trimmingCharacters(in: .whitespaces))
        return cells
    }
}

// MARK: - Markdown Table

private struct MarkdownTableView: View {
    let header: [String]
    let rows: [[String]]
    let baseFontSize: CGFloat
    @Environment(\.colorScheme) private var colorScheme

    /// Pre-computed column layout. Building the table used to walk every
    /// cell on every SwiftUI layout pass (O(rows × cols²)), which became
    /// the dominant cost during live window resize — especially when the
    /// chat window moved from a large external display to a smaller one.
    /// Computing this once at init time keeps per-frame work constant.
    private let layout: TableLayout

    init(header: [String], rows: [[String]], baseFontSize: CGFloat = 13) {
        self.header = header
        self.rows = rows
        self.baseFontSize = baseFontSize
        layout = TableLayout(header: header, rows: rows, baseFontSize: baseFontSize)
    }

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
        let lastColumnIndex = layout.columnCount - 1
        return HStack(spacing: 0) {
            ForEach(0..<layout.columnCount, id: \.self) { index in
                tableCellText(index < cells.count ? cells[index] : "", isHeader: isHeader)
                    .foregroundColor(
                        isHeader ? NordTheme.primaryText(colorScheme) : NordTheme.secondaryText(colorScheme)
                    )
                    .frame(width: layout.widths[index], alignment: .leading)
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

    private func tableCellText(_ raw: String, isHeader: Bool) -> some View {
        let attributed = ChatMarkdownCache.shared.inlineAttributed(
            raw,
            baseFontSize: max(baseFontSize - 1, 10.5),
            colorScheme: colorScheme
        )
        return Text(attributed)
            .font(.system(size: max(baseFontSize - 1, 10.5), weight: isHeader ? .semibold : .regular))
            .tint(NordTheme.accentBlue(colorScheme))
            .lineSpacing(1.5)
            .textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
    }

    /// Immutable layout descriptor — column count plus pre-computed widths
    /// for each column. Computing widths once (instead of inside `body`)
    /// keeps `MarkdownTableView` cheap to redraw during window resize.
    private struct TableLayout {
        let columnCount: Int
        let widths: [CGFloat]

        init(header: [String], rows: [[String]], baseFontSize: CGFloat) {
            let count = max(header.count, rows.map(\.count).max() ?? 0)
            columnCount = count
            guard count > 0 else {
                widths = []
                return
            }
            let allRows = [header] + rows
            var widths: [CGFloat] = []
            widths.reserveCapacity(count)
            for index in 0..<count {
                var longest = 8
                for row in allRows where index < row.count {
                    if row[index].count > longest { longest = row[index].count }
                }
                let characterWidth = max(baseFontSize * 0.54, 6.2)
                widths.append(min(max(CGFloat(longest) * characterWidth + 24, 96), 260))
            }
            self.widths = widths
        }
    }
}

// MARK: - Code Block

struct ChatCodeBlockView: View {
    let language: String?
    let code: String
    var baseFontSize: CGFloat = 13
    @Environment(\.colorScheme) private var colorScheme
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Top bar: language + copy button
            HStack {
                Text(languageLabel)
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
                .help(copied ? "Copied" : "Copy code")
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
            .background(NordTheme.badgeFill(colorScheme))

            Rectangle()
                .fill(NordTheme.border(colorScheme))
                .frame(height: 1)

            ScrollView(.horizontal, showsIndicators: true) {
                Text(code)
                    .font(
                        .system(size: max(baseFontSize - 0.25, 10.5), weight: .regular, design: .monospaced)
                    )
                    .foregroundColor(NordTheme.primaryText(colorScheme))
                    .lineSpacing(2)
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

    private var languageLabel: String {
        let raw = language?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !raw.isEmpty else { return "code" }
        return raw.lowercased()
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

// MARK: - Markdown composer input

/// AppKit colors matching the SwiftUI NordTheme values used by sent and
/// received Markdown. Dynamic colors keep the editor in sync with appearance
/// changes without replacing its configuration or text view.
private enum ComposerMarkdownPalette {
    static let primaryText = dynamic(
        light: NSColor(red: 15 / 255, green: 21 / 255, blue: 53 / 255, alpha: 1),
        dark: NSColor(red: 220 / 255, green: 220 / 255, blue: 224 / 255, alpha: 1)
    )
    static let secondaryText = dynamic(
        light: NSColor(red: 74 / 255, green: 85 / 255, blue: 120 / 255, alpha: 0.85),
        dark: NSColor(red: 152 / 255, green: 152 / 255, blue: 157 / 255, alpha: 0.85)
    )
    static let accentBlue = dynamic(
        light: NSColor(red: 47 / 255, green: 110 / 255, blue: 220 / 255, alpha: 1),
        dark: NSColor(red: 108 / 255, green: 168 / 255, blue: 255 / 255, alpha: 1)
    )
    static let codeBackgroundLight = NSColor(
        red: 246 / 255, green: 248 / 255, blue: 252 / 255, alpha: 1)
    static let codeBackgroundDark = NSColor(red: 10 / 255, green: 12 / 255, blue: 22 / 255, alpha: 1)
    static let panelBackground = dynamic(
        light: NSColor.white.withAlphaComponent(0.98),
        dark: NSColor(red: 44 / 255, green: 44 / 255, blue: 46 / 255, alpha: 0.97)
    )
    static let border = dynamic(
        light: NSColor(red: 15 / 255, green: 21 / 255, blue: 53 / 255, alpha: 0.09),
        dark: NSColor.white.withAlphaComponent(0.08)
    )

    private static func dynamic(light: NSColor, dark: NSColor) -> NSColor {
        NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? dark : light
        }
    }
}

/// In-place Markdown editor. MarkdownEngine hides source markers outside the
/// active construct and renders tables, headings, lists, links, and fenced code
/// blocks directly in the editable surface.
private struct ChatMarkdownInput: View {
    @Binding var text: String
    @Binding var isFocused: Bool
    var colorScheme: ColorScheme
    var onSend: () -> Void
    var onRecallHistory: () -> Bool

    @State private var textView: NSTextView?
    @State private var monitoredTextViewId: ObjectIdentifier?
    @State private var keyMonitor: Any?
    @StateObject private var renderedBlockStyler = ComposerRenderedBlockStyler()

    // HighlighterSwiftBridge owns a JavaScriptCore highlighter, caches, and an
    // appearance observer. Constructing it from `body` recreated all of those
    // resources on every binding update (every keystroke), forcing the editor
    // to repeatedly refresh layout and causing the visible flicker.
    private static let configuration: MarkdownEditorConfiguration = {
        var configuration = MarkdownEditorConfiguration.default
        configuration.theme = MarkdownEditorTheme(
            bodyText: ComposerMarkdownPalette.primaryText,
            mutedText: ComposerMarkdownPalette.secondaryText,
            disabledText: ComposerMarkdownPalette.secondaryText.withAlphaComponent(0.55),
            headingMarker: ComposerMarkdownPalette.secondaryText,
            link: ComposerMarkdownPalette.accentBlue,
            incompleteLink: ComposerMarkdownPalette.accentBlue.withAlphaComponent(0.75),
            strikethroughColor: ComposerMarkdownPalette.primaryText
        )
        configuration.services = MarkdownEditorServices(
            syntaxHighlighter: HighlighterSwiftBridge(
                lightBackground: ComposerMarkdownPalette.codeBackgroundLight,
                darkBackground: ComposerMarkdownPalette.codeBackgroundDark
            )
        )
        configuration.codeBlock = CodeBlockStyle(
            fontSizeScale: 0.98,
            paragraphSpacing: 6,
            horizontalIndent: 12
        )
        configuration.inlineCode = InlineCodeStyle(fontSizeScale: 0.95)
        configuration.paragraph = ParagraphStyle(
            spacingFactor: 0.22,
            lineHeightExtraSpacing: 4
        )
        configuration.spellChecking = SpellCheckingPolicy(
            continuousSpellChecking: false,
            grammarChecking: false,
            automaticSpellingCorrection: false
        )
        // Configure padding through MarkdownEngine itself. Setting the
        // NSTextView inset imperatively is overwritten by updateNSView, whose
        // default TextInsets are zero, leaving text flush against the card.
        configuration.textInsets = TextInsets(horizontal: 12, vertical: 10)
        return configuration
    }()

    var body: some View {
        NativeTextViewWrapper(
            text: $text,
            configuration: Self.configuration,
            fontSize: ChatComposerMetrics.fontSize,
            documentId: "chat-composer",
            isEditable: true
        )
        .background(
            MarkdownEditorIntrospector { resolvedTextView in
                guard textView !== resolvedTextView else { return }
                configure(resolvedTextView)
                renderedBlockStyler.attach(to: resolvedTextView)
                textView = resolvedTextView
                installKeyMonitor(for: resolvedTextView)
            }
        )
        .onChange(of: isFocused) { _, focused in
            guard focused, let textView else { return }
            DispatchQueue.main.async {
                textView.window?.makeFirstResponder(textView)
            }
        }
        .onChange(of: colorScheme) { _, _ in
            if let textView { configure(textView) }
        }
        .onDisappear { removeKeyMonitor() }
        .accessibilityLabel("Message")
        .accessibilityHint("Type a message. Press Return to send or Shift-Return for a new line.")
    }

    private func configure(_ textView: NSTextView) {
        textView.backgroundColor = .clear
        textView.drawsBackground = false
        textView.insertionPointColor = colorScheme == .dark ? .white : .black
        textView.isAutomaticQuoteSubstitutionEnabled = false
        textView.isAutomaticTextReplacementEnabled = false
        textView.isAutomaticSpellingCorrectionEnabled = false
    }

    private func installKeyMonitor(for textView: NSTextView) {
        let textViewId = ObjectIdentifier(textView)
        guard monitoredTextViewId != textViewId else { return }
        removeKeyMonitor()
        monitoredTextViewId = textViewId
        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
            guard event.window === textView.window,
                textView.window?.firstResponder === textView
            else { return event }
            isFocused = true

            if event.keyCode == 36 || event.keyCode == 76 {
                if event.modifierFlags.contains(.shift) { return event }
                DispatchQueue.main.async { onSend() }
                return nil
            }

            if event.keyCode == 126, textView.string.isEmpty, onRecallHistory() {
                DispatchQueue.main.async {
                    textView.setSelectedRange(
                        NSRange(location: (textView.string as NSString).length, length: 0))
                }
                return nil
            }
            return event
        }
    }

    private func removeKeyMonitor() {
        if let keyMonitor { NSEvent.removeMonitor(keyMonitor) }
        keyMonitor = nil
        monitoredTextViewId = nil
    }
}

/// MarkdownEngine rasterizes inactive tables into attributed-string images.
/// Its table renderer currently draws square outer corners, so finish those
/// images with the same 8-point continuous corner treatment as
/// `MarkdownTableView` in sent and received messages.
@MainActor
private final class ComposerRenderedBlockStyler: ObservableObject {
    private static let renderedImageKey = NSAttributedString.Key("LatexRenderedImage")
    private weak var storage: NSTextStorage?
    private nonisolated(unsafe) var observer: NSObjectProtocol?
    private var isApplyingStyle = false
    private let cache = NSCache<NSImage, NSImage>()
    private var styledImageIds: Set<ObjectIdentifier> = []

    func attach(to textView: NSTextView) {
        guard storage !== textView.textStorage, let textStorage = textView.textStorage else { return }
        detach()
        storage = textStorage
        observer = NotificationCenter.default.addObserver(
            forName: NSTextStorage.didProcessEditingNotification,
            object: textStorage,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.roundRenderedTables() }
        }
        roundRenderedTables()
    }

    deinit {
        if let observer { NotificationCenter.default.removeObserver(observer) }
    }

    private func detach() {
        if let observer { NotificationCenter.default.removeObserver(observer) }
        observer = nil
        storage = nil
    }

    private func roundRenderedTables() {
        guard !isApplyingStyle, let storage, storage.length > 0 else { return }
        let fullRange = NSRange(location: 0, length: storage.length)
        var replacements: [(NSRange, NSImage)] = []

        storage.enumerateAttribute(Self.renderedImageKey, in: fullRange) { value, range, _ in
            guard let image = value as? NSImage,
                !self.styledImageIds.contains(ObjectIdentifier(image)),
                self.isMarkdownTable(around: range, in: storage.string)
            else { return }
            if let cached = self.cache.object(forKey: image) {
                replacements.append((range, cached))
            } else if let rounded = self.roundedImage(image) {
                self.cache.setObject(rounded, forKey: image)
                self.styledImageIds.insert(ObjectIdentifier(rounded))
                replacements.append((range, rounded))
            }
        }

        guard !replacements.isEmpty else { return }
        isApplyingStyle = true
        storage.beginEditing()
        for (range, image) in replacements {
            storage.addAttribute(Self.renderedImageKey, value: image, range: range)
        }
        storage.endEditing()
        isApplyingStyle = false
    }

    private func isMarkdownTable(around range: NSRange, in text: String) -> Bool {
        let nsText = text as NSString
        let lineRange = nsText.lineRange(for: range)
        let sample = nsText.substring(with: lineRange)
        return sample.contains("|")
    }

    private func roundedImage(_ image: NSImage) -> NSImage? {
        guard image.size.width > 0, image.size.height > 0 else { return nil }
        let size = image.size
        return NSImage(size: size, flipped: false) { rect in
            NSGraphicsContext.current?.imageInterpolation = .high
            let shape = NSBezierPath(roundedRect: rect.insetBy(dx: 0.5, dy: 0.5), xRadius: 8, yRadius: 8)
            ComposerMarkdownPalette.panelBackground.setFill()
            shape.fill()

            NSGraphicsContext.saveGraphicsState()
            shape.addClip()
            image.draw(in: rect, from: .zero, operation: .sourceOver, fraction: 1)
            NSGraphicsContext.restoreGraphicsState()

            ComposerMarkdownPalette.border.setStroke()
            shape.lineWidth = 1
            shape.stroke()
            return true
        }
    }
}

/// Locates MarkdownEngine's internal NSTextView without depending on its
/// private implementation types.
private struct MarkdownEditorIntrospector: NSViewRepresentable {
    let onResolve: (NSTextView) -> Void

    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        DispatchQueue.main.async { resolve(from: view) }
        return view
    }

    func updateNSView(_ view: NSView, context: Context) {
        DispatchQueue.main.async { resolve(from: view) }
    }

    private func resolve(from view: NSView) {
        var ancestor = view.superview
        while let current = ancestor {
            if let textView = findTextView(in: current) {
                onResolve(textView)
                return
            }
            ancestor = current.superview
        }
    }

    private func findTextView(in view: NSView) -> NSTextView? {
        if let textView = view as? NSTextView { return textView }
        for child in view.subviews {
            if let textView = findTextView(in: child) { return textView }
        }
        return nil
    }
}

// MARK: - String helpers

extension String {
    /// Returns `nil` when the string is empty so callers can use the
    /// nil-coalescing operator to fall through to a default value.
    fileprivate var nilIfEmpty: String? { isEmpty ? nil : self }
}

// MARK: - Markdown Parse Cache

/// Process-wide cache for parsed markdown. Stores both the block list for a
/// full message body and the per-paragraph `AttributedString` result. Inline
/// strings are cached with their visual style key because links and code spans
/// carry theme-specific colors.
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
        c.totalCostLimit = 24 * 1_024 * 1_024
        return c
    }()

    private let attrCache: NSCache<NSString, AttrBox> = {
        let c = NSCache<NSString, AttrBox>()
        c.countLimit = 1024
        c.totalCostLimit = 24 * 1_024 * 1_024
        return c
    }()

    func blocks(for text: String) -> [ChatMarkdownView.MarkdownBlock] {
        let key = text as NSString
        if let hit = blockCache.object(forKey: key) {
            return hit.value
        }
        let parsed = ChatMarkdownView.parseBlocks(from: text)
        blockCache.setObject(BlockBox(parsed), forKey: key, cost: text.utf8.count)
        return parsed
    }

    func inlineAttributed(
        _ prose: String,
        baseFontSize: CGFloat,
        colorScheme: ColorScheme
    ) -> AttributedString {
        let styleKey =
            "\(colorScheme == .dark ? "dark" : "light")|\(Int((baseFontSize * 10).rounded()))|"
        let key = (styleKey + prose) as NSString
        if let hit = attrCache.object(forKey: key) {
            return hit.value
        }
        let opts = AttributedString.MarkdownParsingOptions(
            allowsExtendedAttributes: true,
            interpretedSyntax: .inlineOnlyPreservingWhitespace,
            failurePolicy: .returnPartiallyParsedIfPossible
        )
        var attributed =
            (try? AttributedString(markdown: prose, options: opts)) ?? AttributedString(prose)
        let codeFill = NordTheme.badgeFill(colorScheme)
        let codeText = NordTheme.primaryText(colorScheme)
        let linkColor = NordTheme.accentBlue(colorScheme)

        for run in attributed.runs {
            if let intent = run.inlinePresentationIntent, intent.contains(.code) {
                attributed[run.range].font = .system(
                    size: max(baseFontSize - 0.25, 10.5),
                    weight: .regular,
                    design: .monospaced
                )
                attributed[run.range].foregroundColor = codeText
                attributed[run.range].backgroundColor = codeFill
            }

            if run.link != nil {
                attributed[run.range].foregroundColor = linkColor
                attributed[run.range].underlineStyle = .single
            }
        }

        attrCache.setObject(
            AttrBox(attributed),
            forKey: key,
            cost: max(prose.utf8.count, attributed.characters.count * 2)
        )
        return attributed
    }
}
