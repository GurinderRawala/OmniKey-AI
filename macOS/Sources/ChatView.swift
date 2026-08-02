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
    /// Drives the "Update available" button that appears above the sidebar
    /// header when a newer app version is on the Sparkle appcast. The
    /// button hides itself when there is nothing to update to.
    @ObservedObject private var updateChecker: AppUpdateChecker = .shared

    private static let ungroupedName = "Other"

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // ── Update available banner (only when the appcast shows a
            //    newer version than what is currently installed) ─────────
            if updateChecker.isUpdateAvailable {
                ChatSidebarUpdateBanner(
                    latestVersion: updateChecker.latestShortVersion,
                    onUpdate: { AppDelegate.shared?.checkForUpdates() }
                )
                .padding(.horizontal, 10)
                .padding(.top, 10)
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
                            onTap: { /* already on the pending new chat */ }
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
                            let hasGroup = candidate.groupName?
                                .trimmingCharacters(in: .whitespacesAndNewlines)
                                .nilIfEmpty != nil
                            return hasGroup ? nil : candidate
                        }()

                        if let pinned = pinnedRunningSession {
                            ChatSessionRowView(
                                session: pinned,
                                isActive: pinned.id == model.activeSessionId,
                                isRunning: model.runningSessionIds.contains(pinned.id),
                                searchQuery: model.sessionSearchQuery,
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
                            // While searching, force every group open. Groups
                            // start collapsed by default, so otherwise a match
                            // inside a collapsed group would be invisible and
                            // the search would look broken.
                            let isCollapsed = model.isSessionSearchActive
                                ? false
                                : collapsedGroups.contains(name)

                            ChatSidebarGroupHeader(
                                name: name,
                                count: sessions.count,
                                runningCount: sessions.filter { model.runningSessionIds.contains($0.id) }.count,
                                isCollapsed: isCollapsed,
                                containsActiveSession: sessions.contains { $0.id == model.activeSessionId },
                                onToggle: {
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
                                ForEach(sessions.map { ChatSessionRowItem(session: $0, activeSessionId: model.activeSessionId) }) { item in
                                    ChatSessionRowView(
                                        session: item.session,
                                        isActive: item.isActive,
                                        isRunning: model.runningSessionIds.contains(item.session.id),
                                        searchQuery: model.sessionSearchQuery,
                                        onTap: { model.openSession(item.session) },
                                        onDelete: { model.deleteSession(item.session) }
                                    )
                                    // Include the active flag in the identity so
                                    // SwiftUI recreates the row that gained or
                                    // lost selection instead of reusing a stale
                                    // button/background drawing from a prior row.
                                    .id("row-\(item.id)")
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
    let onToggle: () -> Void

    @Environment(\.colorScheme) private var colorScheme
    @State private var hovered = false

    var body: some View {
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

                // Marks the group holding the open chat while collapsed, so
                // the user can still see where they are.
                if containsActiveSession, isCollapsed {
                    Circle()
                        .fill(NordTheme.accent(colorScheme))
                        .frame(width: 4, height: 4)
                }

                Spacer(minLength: 4)

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
                    .background(
                        Capsule().fill(NordTheme.accentGreen(colorScheme).opacity(0.14))
                    )
                    .help("\(runningCount) chat\(runningCount == 1 ? "" : "s") running")
                }

                Text("\(count)")
                    .font(.system(size: 10, weight: .medium))
                    .monospacedDigit()
            }
            .foregroundColor(
                NordTheme.secondaryText(colorScheme).opacity(hovered ? 0.75 : 0.45)
            )
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
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovered = $0 }
        .animation(.easeInOut(duration: 0.12), value: hovered)
        .animation(.easeInOut(duration: 0.18), value: isCollapsed)
        .help(isCollapsed ? "Expand \(name)" : "Collapse \(name)")
        .accessibilityLabel(accessibilityLabelText)
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

/// Compact "Update available" pill shown above the sidebar header when
/// `AppUpdateChecker` detects that a newer app version is published on
/// the Sparkle appcast. Tapping the pill hands off to Sparkle's
/// standard update flow (`AppDelegate.checkForUpdates`), which shows
/// the familiar release-notes dialog and drives the download +
/// install. Hidden entirely when there is nothing to update to — the
/// view is only rendered when `isUpdateAvailable` is true, so no idle
/// space is reserved.
private struct ChatSidebarUpdateBanner: View {
    let latestVersion: String?
    let onUpdate: () -> Void
    @Environment(\.colorScheme) private var colorScheme
    @State private var isHovering: Bool = false

    var body: some View {
        Button(action: onUpdate) {
            HStack(spacing: 8) {
                Image(systemName: "arrow.down.circle.fill")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundColor(NordTheme.accentAmber(colorScheme))
                VStack(alignment: .leading, spacing: 1) {
                    Text("Update available")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundColor(NordTheme.primaryText(colorScheme))
                    if let v = latestVersion, !v.isEmpty {
                        Text("Version \(v)")
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
        .onHover { isHovering = $0 }
        .help(latestVersion.map { "Install OmniKey \($0)" } ?? "Install the latest OmniKey update")
        .accessibilityLabel(latestVersion.map { "Update to version \($0)" } ?? "Update available")
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
                    if updateChecker.isUpdateAvailable {
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
            .help(updateChecker.isUpdateAvailable ? "Update available — expand sidebar" : "Expand sidebar")
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

                    ForEach(model.sessions.prefix(12).map { ChatSessionRowItem(session: $0, activeSessionId: model.activeSessionId) }) { item in
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
    let onDelete: () -> Void

    @Environment(\.colorScheme) private var colorScheme
    @State private var isHovered = false
    @State private var runPulse = false
    @State private var confirmingDelete = false

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

                        highlightedTitle
                            .font(.system(size: 13, weight: isActive ? .medium : .regular))
                            .lineLimit(1)
                            .truncationMode(.tail)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)

                    // Secondary metadata line. Hidden while the delete
                    // confirmation is showing so the row does not grow.
                    if let subtitle = subtitleText, !confirmingDelete {
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
        .animation(.easeInOut(duration: 0.12), value: confirmingDelete)
        .onHover { hovering in
            isHovered = hovering
            // Reset an unconfirmed delete when the pointer leaves, so the
            // row never stays armed after the user moves on.
            if !hovering { confirmingDelete = false }
        }
        .onAppear { if isRunning { startRunPulse() } }
        .onChange(of: isRunning) { _, running in
            if running {
                startRunPulse()
            } else {
                // Ease the dot out instead of snapping it, and wrap the reset
                // in an explicit transaction so the repeating animation is
                // replaced rather than left mid-cycle. Mirrors the halo stop
                // in `ThinkingTimelineRow`.
                withAnimation(.easeOut(duration: 0.3)) { runPulse = false }
            }
        }
        .help(tooltip)
        .contextMenu {
            Button("Open") { onTap() }
            Button("Copy Title") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(session.title, forType: .string)
            }
            Divider()
            Button("Delete Chat", role: .destructive) { onDelete() }
        }
        .accessibilityLabel(tooltip)
    }

    /// Title with the search match highlighted. Falls back to plain text when
    /// no query is active or the query does not appear in the title (it may
    /// have matched the transcript instead).
    private var highlightedTitle: Text {
        let base = NordTheme.secondaryText(colorScheme)
        let color: Color = isActive
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

    /// Hover reveals a two-step delete affordance; otherwise the gutter stays
    /// empty so the title has the full row width.
    @ViewBuilder
    private var trailingAccessory: some View {
        if isHovered {
            Button {
                if confirmingDelete {
                    onDelete()
                } else {
                    confirmingDelete = true
                }
            } label: {
                Group {
                    if confirmingDelete {
                        Text("Delete?")
                            .font(.system(size: 9.5, weight: .semibold))
                            .foregroundColor(NordTheme.accentAmber(colorScheme))
                            .padding(.horizontal, 6)
                            .frame(height: 17)
                            .background(
                                Capsule().fill(NordTheme.accentAmber(colorScheme).opacity(0.14))
                            )
                    } else {
                        Image(systemName: "xmark")
                            .font(.system(size: 8.5, weight: .semibold))
                            .foregroundColor(NordTheme.secondaryText(colorScheme).opacity(0.55))
                            .frame(width: 17, height: 17)
                            .background(Circle().fill(NordTheme.badgeFill(colorScheme)))
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help(confirmingDelete ? "Click again to delete" : "Delete chat")
            .transition(.opacity.combined(with: .scale(scale: 0.85)))
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
                    .help(model.canChangeSessionSetup ? "Choose task instructions" : "Task instructions are locked after a session starts")
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
                    .help(model.canChangeSessionSetup ? "Add instruction" : "Task instructions are locked after a session starts")
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
                .help(model.canChangeSessionSetup ? "Choose project" : "Project is locked after a session starts")

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

// MARK: - Agent Model Menu

private struct AgentModelMenu: View {
    @ObservedObject var model: ChatModel
    @Environment(\.colorScheme) private var colorScheme
    @State private var showsCustomModelPopover = false
    @State private var customModelInput = ""

    private var menuOptions: [APIClient.AgentModelOptionDTO] {
        var options = model.activeAgentModelOptions
        if !model.activeAgentModel.isEmpty,
           !options.contains(where: { $0.id == model.activeAgentModel }) {
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
            UserBubbleView(text: message.text, sentAt: message.sentAt)
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
        let structuralPrefixes = ["# ", "## ", "### ", "#### ", "##### ", "###### ", "- ", "* ", "+ ", "• ", "> "]
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

// MARK: - Timeline timing helpers

/// Formatting + derivation helpers for the Codex-style thinking timeline.
/// Kept separate from the views so the timing rules are testable and the
/// view bodies stay declarative.
enum AgentTimelineTiming {
    /// Below this threshold we assume the blocks were hydrated from history
    /// (all stamped at load time) rather than streamed, and suppress timings.
    static let minimumMeaningfulSpan: TimeInterval = 0.75

    static func span(of blocks: [ChatBlock], now: Date) -> TimeInterval {
        guard let first = blocks.first else { return 0 }
        let end = max(blocks.last?.createdAt ?? first.createdAt, now)
        return max(0, end.timeIntervalSince(first.createdAt))
    }

    /// Duration attributable to `blocks[index]` — the gap until the next
    /// block, or until `now` for the block still in flight.
    static func duration(of blocks: [ChatBlock], at index: Int, now: Date) -> TimeInterval {
        guard index >= 0, index < blocks.count else { return 0 }
        let start = blocks[index].createdAt
        let end = (index + 1 < blocks.count) ? blocks[index + 1].createdAt : now
        return max(0, end.timeIntervalSince(start))
    }

    /// "8s", "1m 04s", "1h 02m". Sub-second values round up to "1s" so a
    /// step never renders as "0s".
    static func format(_ interval: TimeInterval) -> String {
        let total = Int(interval.rounded())
        if total < 60 { return "\(max(1, total))s" }
        let minutes = total / 60
        let seconds = total % 60
        if minutes < 60 { return String(format: "%dm %02ds", minutes, seconds) }
        return String(format: "%dh %02dm", minutes / 60, minutes % 60)
    }
}

// MARK: - Thinking Section (Timeline)

private struct ThinkingSectionView: View {
    let blocks: [ChatBlock]
    var isStreaming: Bool = false
    @Environment(\.colorScheme) private var colorScheme

    /// `nil` means "follow the stream" — auto-expanded while the turn runs and
    /// auto-collapsed once it finishes, matching the Codex transcript. As soon
    /// as the user toggles the header the explicit choice wins for this turn.
    @State private var userExpanded: Bool? = nil
    @State private var expandedSteps: Set<Int> = []
    @State private var now = Date()
    @State private var headlinePhase = false

    /// 1 Hz tick drives the live "Thinking… 12s" counter and the in-flight
    /// step duration. Only consumed while `isStreaming`.
    private let ticker = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    private var expanded: Bool { userExpanded ?? isStreaming }

    private var latestBlock: ChatBlock? { blocks.last }

    /// Headline of the step currently in flight — surfaced next to the header
    /// so the reasoning is visible without expanding the timeline.
    private var liveHeadline: String? {
        guard isStreaming, let block = latestBlock else { return nil }
        let kind = AgentTimelineSummarizer.classify(kind: block.kind, text: block.text)
        let headline = AgentTimelineSummarizer.stepHeadline(kind: kind, text: block.text)
        return headline.isEmpty ? nil : headline
    }

    private var showsTimings: Bool {
        AgentTimelineTiming.span(of: blocks, now: isStreaming ? now : (blocks.last?.createdAt ?? now))
            >= AgentTimelineTiming.minimumMeaningfulSpan
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            headerPill
            if isStreaming, !expanded, let headline = liveHeadline {
                liveActivityLine(headline)
            }
            if expanded {
                timelineBody
                    .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .onAppear { if isStreaming { startHeadlinePulse() } }
        .onReceive(ticker) { tick in
            guard isStreaming else { return }
            now = tick
        }
        .onChange(of: isStreaming) { _, streaming in
            if streaming {
                now = Date()
                startHeadlinePulse()
            } else {
                // Freeze the clock at the last block so the finished header
                // reports the real turn duration instead of drifting.
                now = blocks.last?.createdAt ?? now
                headlinePulse(false)
                // Auto-collapse back to the summary pill, but only when the
                // user never expressed a preference for this turn.
                if userExpanded == nil {
                    withAnimation(.spring(response: 0.34, dampingFraction: 0.86)) {
                        expandedSteps.removeAll()
                    }
                }
            }
        }
    }

    private var headerPill: some View {
        Button {
            withAnimation(.spring(response: 0.3, dampingFraction: 0.82)) {
                userExpanded = !expanded
            }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: isStreaming ? "sparkles" : "brain")
                    .font(.system(size: 12.5, weight: .semibold))
                    .foregroundColor(
                        isStreaming
                            ? NordTheme.accentPurple(colorScheme)
                            : NordTheme.secondaryText(colorScheme).opacity(0.85)
                    )
                // Sized locally rather than via `OKFont.captionSmall` (11pt):
                // this is the turn's primary status line, so it needs more
                // presence than the badge-sized token, which is shared with
                // other chips and should not grow with it.
                Text(thinkingHeaderTitle)
                    .font(.system(size: 12.5, weight: .semibold))
                    .foregroundColor(NordTheme.secondaryText(colorScheme))
                Image(systemName: expanded ? "chevron.up" : "chevron.down")
                    .font(.system(size: 10, weight: .semibold))
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

    /// Collapsed-state live line: the current reasoning headline, gently
    /// pulsing, so the user sees *what* the agent is doing without opening
    /// the timeline — the core of the Codex "live reasoning" feel.
    private func liveActivityLine(_ headline: String) -> some View {
        HStack(alignment: .top, spacing: 6) {
            Circle()
                .fill(NordTheme.accentPurple(colorScheme))
                .frame(width: 5, height: 5)
                .padding(.top, 4)
                .opacity(headlinePhase ? 1.0 : 0.35)
                .animation(.easeInOut(duration: 0.85).repeatForever(autoreverses: true), value: headlinePhase)

            Text(headline)
                .font(.system(size: 11.5))
                .foregroundColor(NordTheme.secondaryText(colorScheme).opacity(headlinePhase ? 0.92 : 0.62))
                .animation(.easeInOut(duration: 0.85).repeatForever(autoreverses: true), value: headlinePhase)
                .lineLimit(2)
                .multilineTextAlignment(.leading)
                .fixedSize(horizontal: false, vertical: true)
                .id(headline)
                .transition(.opacity)
        }
        .padding(.leading, 2)
        .animation(.easeInOut(duration: 0.2), value: headline)
    }

    /// Codex shows "Thinking… 12s" while the turn runs and
    /// "Worked for 2m 37s · 9 steps" once it lands. Timings are omitted for
    /// transcripts hydrated from history, where no real timing exists.
    private var thinkingHeaderTitle: String {
        let steps = blocks.count
        let stepText = "\(steps) step\(steps == 1 ? "" : "s")"

        if isStreaming {
            guard showsTimings else { return "Thinking…" }
            let elapsed = AgentTimelineTiming.span(of: blocks, now: now)
            return "Thinking… \(AgentTimelineTiming.format(elapsed))"
        }

        guard steps > 0 else { return "Thought" }
        guard showsTimings else { return "Thought for \(stepText)" }
        let total = AgentTimelineTiming.span(of: blocks, now: blocks.last?.createdAt ?? now)
        return "Worked for \(AgentTimelineTiming.format(total)) · \(stepText)"
    }

    private var timelineBody: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(blocks.indices, id: \.self) { i in
                ThinkingTimelineRow(
                    block: blocks[i],
                    isLast: i == blocks.count - 1,
                    isActive: isStreaming && i == blocks.count - 1,
                    isExpanded: expandedSteps.contains(i),
                    duration: showsTimings
                        ? AgentTimelineTiming.duration(of: blocks, at: i, now: isStreaming ? now : (blocks.last?.createdAt ?? now))
                        : nil,
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

    private func startHeadlinePulse() {
        headlinePulse(true)
    }

    private func headlinePulse(_ on: Bool) {
        headlinePhase = on
    }
}

// MARK: - Timeline Row

private struct ThinkingTimelineRow: View {
    let block: ChatBlock
    let isLast: Bool
    let isActive: Bool
    let isExpanded: Bool
    /// Wall-clock time spent on this step. `nil` hides the badge (history).
    var duration: TimeInterval? = nil
    let onToggle: () -> Void

    @Environment(\.colorScheme) private var colorScheme
    @State private var hovered = false
    @State private var haloPulse = false

    // Per-kind visual metadata
    /// The block's *effective* kind. Persisted history mislabels unrecognised
    /// tool results as `agentReasoning`, so recover the real kind before
    /// choosing an icon, label, or detail renderer.
    private var kind: ChatBlockKind {
        AgentTimelineSummarizer.classify(kind: block.kind, text: block.text)
    }

    private var meta: (icon: String, label: String, accent: Color) {
        switch kind {
        case .agentReasoning:  return ("brain",             "Reasoning",  NordTheme.accentPurple(colorScheme))
        case .shellCommand:    return ("terminal.fill",     "Command",    NordTheme.accent(colorScheme))
        case .terminalOutput:  return ("terminal",          "Output",     NordTheme.secondaryText(colorScheme))
        case .webCall:         return ("globe",             "Web Search", NordTheme.accentBlue(colorScheme))
        case .mcpCall:         return ("server.rack",       "MCP Call",   NordTheme.accentAmber(colorScheme))
        case .imageRendering:  return ("photo",             "Image",      NordTheme.accentGreen(colorScheme))
        case .toolCall:        return ("wrench.and.screwdriver", toolLabel, NordTheme.accentBlue(colorScheme))
        case .finalAnswer:     return ("checkmark.circle.fill", "Answer", NordTheme.accentGreen(colorScheme))
        }
    }

    /// Names the specific tool in the row label ("Tool · web search") so the
    /// step says what actually ran instead of a generic placeholder.
    private var toolLabel: String {
        guard let raw = AgentTimelineSummarizer.toolName(in: block.text) else { return "Tool" }
        return "Tool · \(AgentTimelineSummarizer.friendlyToolName(raw))"
    }

    /// Terse title for the step, shown in place of the raw prose so the
    /// collapsed timeline reads as a list of actions.
    private var headline: String {
        AgentTimelineSummarizer.stepHeadline(kind: kind, text: block.text)
    }

    private var durationLabel: String? {
        guard let duration, duration >= 1 else { return nil }
        return AgentTimelineTiming.format(duration)
    }

    /// Reasoning text minus the headline, so the expanded prose does not
    /// repeat the title rendered directly above it.
    private var reasoningBody: String {
        // Use the sanitized prose, not the raw block: persisted reasoning
        // often carries `Tool: ...` headers and bare shell lines that add no
        // meaning and duplicate the adjacent Command row.
        let prose = AgentTimelineSummarizer.reasoningProse(block.text)
        guard !prose.isEmpty, prose != headline else { return "" }
        if prose.hasPrefix(headline) {
            return String(prose.dropFirst(headline.count))
                .trimmingCharacters(in: CharacterSet(charactersIn: " \n\t:.-*#"))
        }
        return prose
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

                        if !headline.isEmpty {
                            Text("·")
                                .font(.system(size: 11))
                                .foregroundColor(NordTheme.secondaryText(colorScheme).opacity(0.3))
                            Text(headline)
                                .font(.system(size: 11))
                                .foregroundColor(NordTheme.secondaryText(colorScheme).opacity(0.58))
                                .lineLimit(1)
                                .truncationMode(.tail)
                        }

                        Spacer(minLength: 4)

                        if let durationLabel {
                            Text(durationLabel)
                                .font(.system(size: 9.5, weight: .medium).monospacedDigit())
                                .foregroundColor(NordTheme.secondaryText(colorScheme).opacity(isActive ? 0.7 : 0.4))
                        }

                        // Chevron is always visible now that expanding is the
                        // only way to reach a step's detail — hiding it until
                        // hover left the disclosure undiscoverable.
                        Image(systemName: "chevron.down")
                            .font(.system(size: 8, weight: .medium))
                            .rotationEffect(.degrees(isExpanded ? 180 : 0))
                            .foregroundColor(
                                NordTheme.secondaryText(colorScheme)
                                    .opacity(hovered ? 0.6 : 0.3)
                            )
                    }
                    .padding(.vertical, 5)
                    .padding(.trailing, 6)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .onHover { hovered = $0 }

                // Detail is disclosure-only — nothing is rendered until the
                // step is opened, so the collapsed timeline stays a scannable
                // list of one-line steps.

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
        switch kind {
        case .shellCommand, .terminalOutput, .webCall, .mcpCall, .toolCall, .imageRendering:
            ChatMarkdownView(
                text: AgentTimelineSummarizer.expandedSummary(kind: kind, text: trimmed),
                baseFontSize: 11.5
            )
            .opacity(0.88)
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
            // Reasoning expands to the cleaned prose. Falling back to the raw
            // text would reintroduce exactly the command noise the collapsed
            // row filtered out.
            let prose = AgentTimelineSummarizer.reasoningProse(trimmed)
            ChatMarkdownView(
                text: prose.isEmpty ? "_No additional detail._" : prose,
                baseFontSize: 11.5
            )
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
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(parsed.enumerated()), id: \.offset) { _, block in
                switch block {
                case let .code(language, code):
                    ChatCodeBlockView(language: language, code: code, baseFontSize: baseFontSize)
                case let .heading(level, content):
                    markdownText(content, size: headingSize(level), weight: .semibold)
                        .padding(.top, level == 1 ? 5 : 2)
                        .padding(.bottom, level <= 2 ? 1 : 0)
                case let .paragraph(content):
                    markdownText(content)
                case let .list(items):
                    listView(items: items)
                case let .quote(content):
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
                case let .table(header, rows):
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
                .foregroundColor(checked ? NordTheme.accentGreen(colorScheme) : NordTheme.secondaryText(colorScheme))
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
        let normalizedText = text
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
        let lines = normalizedText.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
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
                while i < lines.count && !isFenceEnd(lines[i].trimmingCharacters(in: .whitespaces), marker: fence.marker) {
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
                if currentTrimmed.isEmpty ||
                    parseFenceStart(currentTrimmed) != nil ||
                    parseHeading(currentTrimmed) != nil ||
                    isDivider(currentTrimmed) ||
                    isTableStart(at: i, lines: lines) ||
                    parseListLine(current) != nil ||
                    currentTrimmed.hasPrefix(">")
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
        return compact.count >= 3 && (
            compact.allSatisfy { $0 == "-" } ||
            compact.allSatisfy { $0 == "*" } ||
            compact.allSatisfy { $0 == "_" }
        )
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
            items.append(MarkdownListItem(
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

    fileprivate static func orderedListMarkerAndText(_ line: String) -> (marker: String?, body: String)? {
        guard let delimiterIndex = line.firstIndex(where: { $0 == "." || $0 == ")" }) else { return nil }
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
            ForEach(0 ..< layout.columnCount, id: \.self) { index in
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
            for index in 0 ..< count {
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
                    .font(.system(size: max(baseFontSize - 0.25, 10.5), weight: .regular, design: .monospaced))
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

    func inlineAttributed(
        _ prose: String,
        baseFontSize: CGFloat,
        colorScheme: ColorScheme
    ) -> AttributedString {
        let styleKey = "\(colorScheme == .dark ? "dark" : "light")|\(Int((baseFontSize * 10).rounded()))|"
        let key = (styleKey + prose) as NSString
        if let hit = attrCache.object(forKey: key) {
            return hit.value
        }
        let opts = AttributedString.MarkdownParsingOptions(
            allowsExtendedAttributes: true,
            interpretedSyntax: .inlineOnlyPreservingWhitespace,
            failurePolicy: .returnPartiallyParsedIfPossible
        )
        var attributed = (try? AttributedString(markdown: prose, options: opts)) ?? AttributedString(prose)
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

        attrCache.setObject(AttrBox(attributed), forKey: key)
        return attributed
    }
}
