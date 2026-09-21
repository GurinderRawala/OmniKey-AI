import AppKit
import SwiftUI

// MARK: - Agent execution history

/// A durable progress timeline with one command disclosure followed by the
/// separate thread of meaningful thinking updates.
struct AgentExecutionHistoryView: View {
    let blocks: [ChatBlock]
    var isStreaming: Bool
    var completionDate: Date? = nil
    var finalAnswer: String? = nil

    @State private var commandTimelineExpanded = AgentCommandDisclosurePolicy.initiallyExpanded
    @State private var completedTimelineExpanded = AgentCompletedTimelinePolicy.initiallyExpanded
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var colorScheme

    private var presentation: AgentTimelinePresentation {
        AgentTimelinePresentation.build(from: blocks, isStreaming: isStreaming)
    }

    private var allActivities: [AgentCommandActivity] {
        presentation.steps.flatMap(\.activities)
    }

    private var milestoneSteps: [AgentTaskStep] {
        presentation.steps.filter { $0.outcome?.isEmpty == false }
    }

    private var timelineExpanded: Bool {
        AgentCompletedTimelinePolicy.isExpanded(
            isStreaming: isStreaming,
            completedExpanded: completedTimelineExpanded
        )
    }

    private var completionLabel: String {
        AgentTimelineDuration.label(
            for: AgentTimelineDuration.elapsed(blocks: blocks, completionDate: completionDate)
        )
    }

    private var completionRecap: AgentCompletionRecap {
        presentation.completionRecap(durationLabel: completionLabel, finalAnswer: finalAnswer)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            if !isStreaming {
                completedDisclosure
            }

            if timelineExpanded {
                timelineContent
                    .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .onChange(of: isStreaming) { _, streaming in
            completedTimelineExpanded = AgentCompletedTimelinePolicy.expansionAfterStreamingChange(
                isStreaming: streaming,
                current: completedTimelineExpanded
            )
            if !streaming { commandTimelineExpanded = false }
        }
        .onChange(of: allActivities.count) { _, count in
            commandTimelineExpanded = AgentCommandDisclosurePolicy.expansion(
                current: commandTimelineExpanded,
                afterActivityCountChangedTo: count
            )
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(
            isStreaming ? "Agent execution in progress" : "Completed agent execution history")
    }

    @ViewBuilder
    private var timelineContent: some View {
        VStack(alignment: .leading, spacing: 14) {
            if !allActivities.isEmpty {
                AgentCommandActivityPanel(
                    activities: allActivities,
                    expanded: $commandTimelineExpanded
                )
            }

            if !milestoneSteps.isEmpty {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(milestoneSteps.enumerated()), id: \.element.id) { index, step in
                        AgentTaskStepRow(
                            step: step,
                            isLast: index == milestoneSteps.count - 1
                        )
                    }
                }
            }

        }
    }

    private var completedDisclosure: some View {
        Button {
            withAnimation(
                AgentTimelineMotionPolicy.shouldAnimate(reduceMotion: reduceMotion)
                    ? .easeInOut(duration: 0.18) : nil
            ) {
                completedTimelineExpanded.toggle()
            }
        } label: {
            HStack(spacing: 7) {
                Image(systemName: completionRecap.systemImage)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundColor(completionColor)
                VStack(alignment: .leading, spacing: 1) {
                    Text(completionRecap.title)
                        .font(.system(size: 11.5, weight: .semibold))
                        .foregroundColor(NordTheme.primaryText(colorScheme).opacity(0.9))
                    Text(completionRecap.subtitle)
                        .font(.system(size: 9.5))
                        .foregroundColor(NordTheme.secondaryText(colorScheme).opacity(0.68))
                }
                Spacer(minLength: 6)
                Image(systemName: completedTimelineExpanded ? "chevron.down" : "chevron.right")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundColor(NordTheme.secondaryText(colorScheme).opacity(0.58))
            }
            .padding(.horizontal, 9)
            .padding(.vertical, 7)
            .background(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(NordTheme.badgeFill(colorScheme).opacity(0.62))
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(completedTimelineExpanded ? "Hide completed work" : "Show completed work")
        .accessibilityLabel("\(completionRecap.title), \(completionRecap.subtitle)")
        .accessibilityHint("Press to \(completedTimelineExpanded ? "collapse" : "expand") the reasoning timeline.")
    }

    private var completionColor: Color {
        switch completionRecap.outcome {
        case .succeeded: return NordTheme.accentGreen(colorScheme)
        case .recovered: return NordTheme.accentBlue(colorScheme)
        case .warning: return NordTheme.accentAmber(colorScheme)
        case .failed, .actionRequired: return Color(red: 0.92, green: 0.33, blue: 0.35)
        case .cancelled: return NordTheme.secondaryText(colorScheme)
        }
    }
}

private struct AgentTaskStepRow: View {
    let step: AgentTaskStep
    let isLast: Bool

    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        if let outcome = step.outcome, !outcome.isEmpty {
            HStack(alignment: .top, spacing: 10) {
                VStack(spacing: 0) {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundColor(NordTheme.accentBlue(colorScheme))
                        .frame(width: 16, height: 16)
                        .frame(width: 18, height: 18)

                    if !isLast {
                        Rectangle()
                            .fill(NordTheme.border(colorScheme))
                            .frame(width: 1)
                            .frame(maxHeight: .infinity)
                    }
                }
                .frame(width: 18)

                VStack(alignment: .leading, spacing: 5) {
                    Text(step.title)
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundColor(NordTheme.primaryText(colorScheme).opacity(0.92))

                    Text(outcome)
                        .font(.system(size: 13))
                        .foregroundColor(NordTheme.primaryText(colorScheme).opacity(0.91))
                        .lineSpacing(3)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)

                    if !step.evidence.isEmpty {
                        HStack(spacing: 5) {
                            ForEach(step.evidence, id: \.self) { evidence in
                                Text(evidence)
                                    .font(.system(size: 9.5, weight: .medium))
                                    .foregroundColor(NordTheme.secondaryText(colorScheme))
                                    .padding(.horizontal, 6)
                                    .padding(.vertical, 3)
                                    .background(Capsule().fill(NordTheme.badgeFill(colorScheme)))
                            }
                        }
                    }

                    if !step.modifiedFiles.isEmpty {
                        VStack(alignment: .leading, spacing: 3) {
                            Label("Modified files", systemImage: "doc.badge.ellipsis")
                                .font(.system(size: 9.5, weight: .semibold))
                            Text(step.modifiedFiles.joined(separator: " · "))
                                .font(.system(size: 10.5).monospaced())
                                .lineLimit(2)
                                .textSelection(.enabled)
                        }
                        .foregroundColor(NordTheme.secondaryText(colorScheme).opacity(0.72))
                    }

                    if !step.referencedFiles.isEmpty {
                        VStack(alignment: .leading, spacing: 3) {
                            Label("Referenced files", systemImage: "doc.text.magnifyingglass")
                                .font(.system(size: 9.5, weight: .semibold))
                            Text(step.referencedFiles.joined(separator: " · "))
                                .font(.system(size: 10.5).monospaced())
                                .lineLimit(2)
                                .textSelection(.enabled)
                        }
                        .foregroundColor(NordTheme.secondaryText(colorScheme).opacity(0.72))
                    }
                }
                .padding(.bottom, isLast ? 2 : 16)
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityElement(children: .combine)
                .accessibilityLabel("\(step.title): \(outcome)")
            }
        }
    }
}

private struct AgentCommandActivityPanel: View {
    let activities: [AgentCommandActivity]
    @Binding var expanded: Bool

    @State private var visibleActivityCount = AgentActivityPagination.pageSize

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var status: AgentActivityStatus {
        AgentTimelinePresentation.aggregateStatus(for: activities)
    }

    private var displayTitle: String {
        if let current = activities.last(where: { $0.status == .running || $0.status == .pending }) {
            return "Using \(current.title)"
        }
        return "Command activity"
    }

    private var activitySummary: String {
        AgentTimelinePresentation.compactActivityTitle(for: activities)
    }

    private var visibleActivities: [AgentCommandActivity] {
        let range = AgentActivityPagination.visibleRange(
            totalCount: activities.count,
            visibleCount: visibleActivityCount
        )
        return Array(activities[range])
    }

    private var hiddenActivityCount: Int {
        max(0, activities.count - visibleActivities.count)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(
                    AgentTimelineMotionPolicy.shouldAnimate(reduceMotion: reduceMotion)
                        ? .easeInOut(duration: 0.18) : nil
                ) { expanded.toggle() }
            } label: {
                HStack(spacing: 7) {
                    ZStack {
                        Circle()
                            .fill(statusColor.opacity(status == .running ? 0.18 : 0.10))
                            .frame(width: 18, height: 18)
                        activityStatusIcon
                    }
                    VStack(alignment: .leading, spacing: 1) {
                        Text(displayTitle)
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundColor(NordTheme.primaryText(colorScheme).opacity(0.88))
                            .lineLimit(1)
                        Text(activitySummary)
                            .font(.system(size: 9.5))
                            .foregroundColor(NordTheme.secondaryText(colorScheme).opacity(0.68))
                            .lineLimit(1)
                    }
                    Spacer(minLength: 5)
                    Text(statusLabel.capitalized)
                        .font(.system(size: 9.5, weight: .semibold))
                        .foregroundColor(statusColor)
                    Text("\(activities.count)")
                        .font(.system(size: 9.5, weight: .semibold).monospacedDigit())
                        .foregroundColor(NordTheme.secondaryText(colorScheme).opacity(0.58))
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Capsule().fill(NordTheme.badgeFill(colorScheme)))
                    Image(systemName: expanded ? "chevron.up" : "chevron.down")
                        .font(.system(size: 8.5, weight: .semibold))
                        .foregroundColor(NordTheme.secondaryText(colorScheme).opacity(0.48))
                }
                .padding(.horizontal, 9)
                .padding(.vertical, 7)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help(expanded ? "Hide command details" : "Show command details")
            .accessibilityLabel("\(displayTitle), \(statusLabel)")
            .accessibilityHint(
                "Press to \(expanded ? "hide" : "show") command inputs, outputs, logs, and metadata.")

            if expanded {
                Divider().opacity(0.55)
                LazyVStack(alignment: .leading, spacing: 8) {
                    if AgentActivityPagination.hasMore(
                        totalCount: activities.count,
                        visibleCount: visibleActivityCount
                    ) {
                        Button(action: showMoreActivities) {
                            HStack(spacing: 6) {
                                Image(systemName: "chevron.up")
                                    .font(.system(size: 8.5, weight: .semibold))
                                Text("Show more")
                                    .font(.system(size: 10.5, weight: .semibold))
                                Spacer()
                                Text("\(min(AgentActivityPagination.pageSize, hiddenActivityCount)) earlier")
                                    .font(.system(size: 9.5).monospacedDigit())
                                    .foregroundColor(NordTheme.secondaryText(colorScheme).opacity(0.62))
                            }
                            .foregroundColor(NordTheme.accentBlue(colorScheme))
                            .padding(.horizontal, 8)
                            .padding(.vertical, 6)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Show more activity")
                        .accessibilityHint(
                            "Loads up to \(AgentActivityPagination.pageSize) earlier command activities."
                        )
                    }

                    ForEach(Array(visibleActivities.enumerated()), id: \.element.id) { index, activity in
                        AgentCommandTimelineRow(
                            activity: activity,
                            isLast: index == visibleActivities.count - 1
                        )
                    }
                }
                .padding(9)
                .transition(.opacity)
            }
        }
        .background(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(NordTheme.badgeFill(colorScheme).opacity(colorScheme == .dark ? 0.45 : 0.62))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .strokeBorder(statusColor.opacity(status == .running ? 0.30 : 0.16), lineWidth: 1)
        )
        .onChange(of: expanded) { _, isExpanded in
            if isExpanded {
                visibleActivityCount = AgentActivityPagination.initialVisibleCount(
                    totalCount: activities.count
                )
            }
        }
    }

    private func showMoreActivities() {
        withAnimation(
            AgentTimelineMotionPolicy.shouldAnimate(reduceMotion: reduceMotion)
                ? .easeInOut(duration: 0.18) : nil
        ) {
            visibleActivityCount = AgentActivityPagination.nextVisibleCount(
                totalCount: activities.count,
                currentVisibleCount: visibleActivityCount
            )
        }
    }

    @ViewBuilder
    private var activityStatusIcon: some View {
        if status == .running {
            if reduceMotion {
                Image(systemName: "circle.dotted")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundColor(statusColor)
                    .frame(width: 12, height: 12)
            } else {
                ProgressView()
                    .controlSize(.mini)
                    .frame(width: 12, height: 12)
            }
        } else {
            Image(systemName: statusIcon)
                .font(.system(size: 10, weight: .semibold))
                .foregroundColor(statusColor)
                .frame(width: 12)
        }
    }

    private var statusIcon: String {
        switch status {
        case .pending: return "clock"
        case .running: return "circle.dotted"
        case .completed: return "checkmark.circle.fill"
        case .failed: return "exclamationmark.triangle.fill"
        case .cancelled: return "stop.circle.fill"
        }
    }

    private var statusLabel: String {
        switch status {
        case .pending: return "pending"
        case .running: return "running"
        case .completed: return "completed"
        case .failed: return "failed"
        case .cancelled: return "cancelled"
        }
    }

    private var statusColor: Color {
        switch status {
        case .pending: return NordTheme.secondaryText(colorScheme)
        case .running: return NordTheme.accentPurple(colorScheme)
        case .completed: return NordTheme.accentGreen(colorScheme)
        case .failed: return Color(red: 0.92, green: 0.33, blue: 0.35)
        case .cancelled: return NordTheme.accentAmber(colorScheme)
        }
    }
}

private struct AgentCommandTimelineRow: View {
    let activity: AgentCommandActivity
    let isLast: Bool

    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            VStack(spacing: 0) {
                Circle()
                    .fill(markerColor)
                    .frame(width: 6, height: 6)
                    .frame(width: 14, height: 18)
                if !isLast {
                    Rectangle()
                        .fill(NordTheme.border(colorScheme))
                        .frame(width: 1)
                        .frame(maxHeight: .infinity)
                }
            }
            .frame(width: 14)

            AgentCommandActivityDetail(activity: activity)
                .padding(.bottom, isLast ? 0 : 8)
        }
    }

    private var markerColor: Color {
        switch activity.status {
        case .pending: return NordTheme.secondaryText(colorScheme)
        case .running: return NordTheme.accentPurple(colorScheme)
        case .completed: return NordTheme.accentGreen(colorScheme)
        case .failed: return Color(red: 0.92, green: 0.33, blue: 0.35)
        case .cancelled: return NordTheme.accentAmber(colorScheme)
        }
    }
}

private struct AgentCommandActivityDetail: View {
    let activity: AgentCommandActivity

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ObservedObject private var model = ChatModel.shared
    @State private var showFullContent = false

    private var isTruncated: Bool {
        hasProgressiveContent
            || activity.fullText.count > AgentActivityDetailContent.previewCharacterLimit
    }

    private var hasProgressiveContent: Bool {
        activity.blocks.contains { $0.previewText != nil }
    }

    private var hasUnloadedContent: Bool {
        activity.blocks.contains { $0.isContentTruncated }
    }

    private var isLoadingContent: Bool {
        activity.blocks.compactMap(\.fullContentID)
            .contains { model.fullContentLoadingIDs.contains($0) }
    }

    private var displayedText: String {
        AgentActivityDetailContent.displayedText(
            activity.fullText,
            showFullContent: showFullContent
        )
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Text(activity.title)
                    .font(.system(size: 10.5, weight: .semibold))
                    .foregroundColor(NordTheme.primaryText(colorScheme).opacity(0.86))
                Text(activityStatusText)
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundColor(activityStatusColor)
                Spacer()
                if let timestamp = activity.timestamp {
                    Text(timestamp.formatted(date: .omitted, time: .standard))
                        .font(.system(size: 9).monospacedDigit())
                        .foregroundColor(NordTheme.secondaryText(colorScheme).opacity(0.50))
                }
                ChatCopyButton(
                    text: activity.fullText,
                    title: "Copy full activity details",
                    copyProvider: hasUnloadedContent ? { completion in
                        model.loadFullBlockContents(activity.blocks) { blocks in
                            completion(blocks.map(\.text).joined(separator: "\n\n"))
                        }
                    } : nil
                )
            }

            AgentActivityRawTextView(text: displayedText, colorScheme: colorScheme)
                .frame(height: showFullContent ? 240 : 148)
                .background(
                    RoundedRectangle(cornerRadius: 6, style: .continuous)
                        .fill(colorScheme == .dark ? Color.black.opacity(0.24) : Color.white.opacity(0.62))
                )

            if isTruncated {
                Button(
                    isLoadingContent ? "Loading full details…" : (showFullContent ? "Show less" : "Show full details"),
                    action: toggleFullContent
                )
                .buttonStyle(.plain)
                .disabled(isLoadingContent)
                .font(.system(size: 10, weight: .medium))
                .foregroundColor(NordTheme.accentBlue(colorScheme))
                .accessibilityHint("The full details can also be copied without expanding them.")
            }
        }
        .padding(8)
        .background(
            RoundedRectangle(cornerRadius: 7, style: .continuous)
                .fill(NordTheme.editorBackground(colorScheme).opacity(0.70))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 7, style: .continuous)
                .strokeBorder(NordTheme.border(colorScheme), lineWidth: 1)
        )
    }

    private func toggleFullContent() {
        let animation = AgentTimelineMotionPolicy.shouldAnimate(reduceMotion: reduceMotion)
            ? Animation.easeInOut(duration: 0.18) : nil
        if hasUnloadedContent {
            model.loadFullBlockContents(activity.blocks) { _ in
                withAnimation(animation) { showFullContent = true }
            }
        } else {
            withAnimation(animation) { showFullContent.toggle() }
        }
    }

    private var activityStatusText: String {
        switch activity.status {
        case .pending: return "Pending"
        case .running: return "Running"
        case .completed: return "Completed"
        case .failed: return "Failed"
        case .cancelled: return "Cancelled"
        }
    }

    private var activityStatusColor: Color {
        switch activity.status {
        case .pending: return NordTheme.secondaryText(colorScheme)
        case .running: return NordTheme.accentPurple(colorScheme)
        case .completed: return NordTheme.accentGreen(colorScheme)
        case .failed: return Color(red: 0.92, green: 0.33, blue: 0.35)
        case .cancelled: return NordTheme.accentAmber(colorScheme)
        }
    }
}

/// AppKit-backed, read-only log surface. A fixed viewport and native text
/// container prevent long command/output lines from escaping their card or
/// overlapping adjacent timeline rows while preserving selection and copying.
private struct AgentActivityRawTextView: NSViewRepresentable {
    let text: String
    let colorScheme: ColorScheme

    func makeNSView(context: Context) -> NSScrollView {
        let scrollView = NSScrollView()
        scrollView.drawsBackground = false
        scrollView.borderType = .noBorder
        scrollView.hasVerticalScroller = true
        scrollView.hasHorizontalScroller = false
        scrollView.autohidesScrollers = true

        let textView = NSTextView()
        textView.isEditable = false
        textView.isSelectable = true
        textView.drawsBackground = false
        textView.isRichText = false
        textView.font = .monospacedSystemFont(ofSize: 10.5, weight: .regular)
        textView.textContainerInset = NSSize(width: 8, height: 8)
        textView.isHorizontallyResizable = false
        textView.isVerticallyResizable = true
        textView.autoresizingMask = [.width]
        textView.textContainer?.widthTracksTextView = true
        textView.textContainer?.containerSize = NSSize(
            width: 0,
            height: CGFloat.greatestFiniteMagnitude
        )
        scrollView.documentView = textView
        update(textView)
        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        guard let textView = scrollView.documentView as? NSTextView else { return }
        update(textView)
    }

    private func update(_ textView: NSTextView) {
        if textView.string != text { textView.string = text }
        textView.textColor =
            colorScheme == .dark
            ? NSColor.white.withAlphaComponent(0.78)
            : NSColor.black.withAlphaComponent(0.74)
        textView.insertionPointColor = colorScheme == .dark ? .white : .black
        textView.setAccessibilityLabel("Command input and output")
    }
}
