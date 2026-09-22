import Foundation

/// Presentation-only model for the Agent Chat execution history. The wire and
/// persistence formats intentionally remain `ChatBlock`; this layer groups
/// those lossless blocks into a calmer, desktop-oriented timeline.
enum AgentActivityStatus: Equatable {
    case pending
    case running
    case completed
    case failed
    case cancelled
}

struct AgentCommandActivity: Identifiable, Equatable {
    let id: String
    let blocks: [ChatBlock]
    let status: AgentActivityStatus

    var primaryKind: ChatBlockKind {
        guard let first = blocks.first else { return .toolCall }
        return AgentTimelineSummarizer.classify(kind: first.kind, text: first.text)
    }

    var title: String {
        switch primaryKind {
        case .shellCommand: return "Shell command"
        case .terminalOutput: return "Command output"
        case .webCall: return "Web search"
        case .mcpCall: return "MCP call"
        case .imageRendering: return "Image task"
        case .toolCall:
            guard let tool = blocks.first.flatMap({ AgentTimelineSummarizer.toolName(in: $0.text) })
            else {
                return "Tool call"
            }
            return AgentTimelineSummarizer.friendlyToolName(tool)
        case .agentReasoning: return "Progress"
        case .finalAnswer: return "Answer"
        }
    }

    var fullText: String {
        blocks.map { block in
            let kind = AgentTimelineSummarizer.classify(kind: block.kind, text: block.text)
            let phase = block.activityPhase?.rawValue ?? "detail"
            return "[\(rawLabel(for: kind)) · \(phase)]\n\(block.text)"
        }.joined(separator: "\n\n")
    }

    var timestamp: Date? { blocks.first?.createdAt }

    private func rawLabel(for kind: ChatBlockKind) -> String {
        switch kind {
        case .shellCommand: return "shell_command"
        case .terminalOutput: return "output"
        case .webCall: return "web_search"
        case .mcpCall: return "mcp_call"
        case .imageRendering: return "image"
        case .toolCall: return "tool"
        case .agentReasoning: return "progress"
        case .finalAnswer: return "answer"
        }
    }
}

enum AgentSemanticOutcome: Equatable {
    case usefulResult
    case noResult
    case warning
    case recovered
    case failed
    case actionRequired
}

enum AgentRunOutcome: Equatable {
    case succeeded
    case recovered
    case warning
    case failed
    case cancelled
    case actionRequired
}

struct AgentCompletionRecap: Equatable {
    let outcome: AgentRunOutcome
    let title: String
    let subtitle: String
    let systemImage: String
}

struct AgentTaskStep: Identifiable, Equatable {
    let id: String
    let title: String
    let outcome: String?
    let detail: String?
    let status: AgentActivityStatus
    let semanticOutcome: AgentSemanticOutcome
    let activities: [AgentCommandActivity]
    let evidence: [String]
    let referencedFiles: [String]
    let modifiedFiles: [String]
    let createdAt: Date
}

/// Owned by one timeline view, never shared across sessions. Equality includes
/// text and metadata, so hydration, corrections and lifecycle changes invalidate
/// cached work even if block IDs/counts are unchanged.
final class AgentTimelineCache {
    private struct Entry {
        let blocks: [ChatBlock]
        let summary: ChatBlock?
        let streaming: Bool
        let step: AgentTaskStep
    }
    private var entries: [String: Entry] = [:]
    private var usedKeys: Set<String> = []
    private var previousBlocks: [ChatBlock]?
    private var previousStreaming = false
    private var previousPresentation: AgentTimelinePresentation?
    private(set) var rebuiltStepCount = 0

    func presentation(from blocks: [ChatBlock], isStreaming: Bool) -> AgentTimelinePresentation {
        if previousBlocks == blocks, previousStreaming == isStreaming,
            let previousPresentation
        {
            return previousPresentation
        }
        usedKeys.removeAll(keepingCapacity: true)
        let value = AgentTimelinePresentation.build(
            from: blocks, isStreaming: isStreaming, cache: self)
        entries = entries.filter { usedKeys.contains($0.key) }
        previousBlocks = blocks
        previousStreaming = isStreaming
        previousPresentation = value
        return value
    }

    fileprivate func step(
        blocks: [ChatBlock], summary: ChatBlock?, streaming: Bool,
        build: () -> AgentTaskStep
    ) -> AgentTaskStep {
        let key = (blocks.first ?? summary!).id
        usedKeys.insert(key)
        if let entry = entries[key], entry.blocks == blocks,
            entry.summary == summary, entry.streaming == streaming
        {
            return entry.step
        }
        let value = build()
        rebuiltStepCount += 1
        entries[key] = Entry(blocks: blocks, summary: summary, streaming: streaming, step: value)
        return value
    }
}

struct AgentTimelinePresentation {
    let steps: [AgentTaskStep]
    private static let projectFileExpression = try! NSRegularExpression(
        pattern:
            #"(?:^|[\s'\"`])((?:[A-Za-z0-9_.-]+/)*[A-Za-z0-9_.-]+\.(?:swift|ts|tsx|js|jsx|json|md|py|rb|go|rs|java|kt|c|cc|cpp|h|hpp|m|mm|sh|yml|yaml|toml|xml|html|css|sql))\b"#
    )

    var currentActivity: AgentCommandActivity? {
        steps.flatMap(\.activities).last(where: { $0.status == .running || $0.status == .pending })
    }

    var activityCount: Int { steps.reduce(0) { $0 + $1.activities.count } }

    var milestoneCount: Int { steps.filter { $0.outcome?.isEmpty == false }.count }

    var runOutcome: AgentRunOutcome {
        runOutcome(finalAnswer: nil)
    }

    func runOutcome(finalAnswer: String?) -> AgentRunOutcome {
        let normalizedFinal =
            finalAnswer?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
        if normalizedFinal.hasPrefix("**error:**") || normalizedFinal.hasPrefix("error:") {
            return .failed
        }

        // The disclosure summarizes the newest tool call, not the worst status
        // seen anywhere in the timeline. Agents commonly recover from a failed
        // attempt with a later command, so an older failure must not leave the
        // collapsed button stuck in a "Needs attention" state.
        if let latestStep = steps.last(where: { !$0.activities.isEmpty }),
            let latestActivity = latestStep.activities.last
        {
            switch latestActivity.status {
            case .failed:
                return latestStep.semanticOutcome == .actionRequired ? .actionRequired : .failed
            case .cancelled:
                return .cancelled
            case .running, .pending:
                return .warning
            case .completed:
                return latestStep.semanticOutcome == .warning
                    || latestStep.semanticOutcome == .noResult ? .warning : .succeeded
            }
        }

        if steps.contains(where: { $0.semanticOutcome == .actionRequired }) {
            return .actionRequired
        }
        if steps.contains(where: { $0.semanticOutcome == .failed }) { return .failed }
        if steps.contains(where: {
            $0.semanticOutcome == .warning || $0.semanticOutcome == .noResult
        }) {
            return .warning
        }
        if steps.contains(where: { $0.semanticOutcome == .recovered }) { return .recovered }
        return .succeeded
    }

    func completionRecap(durationLabel: String, finalAnswer: String? = nil) -> AgentCompletionRecap
    {
        let activities = steps.flatMap(\.activities)
        let failedCount = activities.filter { $0.status == .failed }.count
        let completedCount = activities.filter { $0.status == .completed }.count
        let warningCount = steps.filter {
            $0.semanticOutcome == .warning || $0.semanticOutcome == .noResult
        }.count
        let blockedCount = steps.filter { $0.semanticOutcome == .actionRequired }.count
        let modifiedCount = Set(steps.flatMap(\.modifiedFiles)).count

        let title: String
        let subtitle: String
        let image: String
        let outcome = runOutcome(finalAnswer: finalAnswer)
        switch outcome {
        case .actionRequired:
            title = "Needs attention · \(durationLabel)"
            subtitle = "\(blockedCount) blocked step\(blockedCount == 1 ? "" : "s")"
            image = "exclamationmark.octagon.fill"
        case .failed:
            title = "Needs attention · \(durationLabel)"
            subtitle =
                failedCount > 0
                ? "\(failedCount) failed activit\(failedCount == 1 ? "y" : "ies")"
                : "Final response reported an error"
            image = "xmark.circle.fill"
        case .cancelled:
            title = "Stopped by user · \(durationLabel)"
            subtitle = "\(completedCount) activit\(completedCount == 1 ? "y" : "ies") completed"
            image = "stop.circle.fill"
        case .warning:
            title = "Completed with warnings · \(durationLabel)"
            subtitle = "\(warningCount) warning\(warningCount == 1 ? "" : "s")"
            image = "exclamationmark.triangle.fill"
        case .recovered:
            title = "Completed with recovery · \(durationLabel)"
            subtitle = "\(failedCount) failed attempt\(failedCount == 1 ? "" : "s") recovered"
            image = "arrow.triangle.2.circlepath.circle.fill"
        case .succeeded:
            title = durationLabel
            if modifiedCount > 0 {
                subtitle =
                    "\(milestoneCount) milestone\(milestoneCount == 1 ? "" : "s") · \(modifiedCount) file\(modifiedCount == 1 ? "" : "s") modified"
            } else {
                subtitle =
                    "\(milestoneCount) milestone\(milestoneCount == 1 ? "" : "s") · \(activityCount) activit\(activityCount == 1 ? "y" : "ies")"
            }
            image = "checkmark.circle.fill"
        }
        return AgentCompletionRecap(
            outcome: outcome, title: title, subtitle: subtitle, systemImage: image)
    }

    static func build(from blocks: [ChatBlock], isStreaming: Bool, cache: AgentTimelineCache? = nil)
        -> AgentTimelinePresentation
    {
        var steps: [AgentTaskStep] = []
        var activityBlocks: [ChatBlock] = []

        func flush(summaryBlock: ChatBlock? = nil, streaming: Bool = false) {
            guard summaryBlock != nil || !activityBlocks.isEmpty else { return }
            let buildStep = { () -> AgentTaskStep in
                let activities = makeActivities(from: activityBlocks, isStreaming: streaming)
                let first = activityBlocks.first ?? summaryBlock!
                let explicitSummary = summaryBlock.flatMap { block -> String? in
                    let text = AgentTimelineSummarizer.progressSummary(block.text)
                    return text.isEmpty ? nil : text
                }
                let status = stepStatus(activities: activities, hasSummary: explicitSummary != nil)
                let modifiedFiles = modifiedFiles(in: activities)
                let modifiedSet = Set(modifiedFiles)
                let referencedFiles = referencedFiles(in: activities).filter {
                    !modifiedSet.contains($0)
                }
                return
                    AgentTaskStep(
                        id: first.id,
                        title: taskTitle(summary: explicitSummary, activities: activities),
                        outcome: explicitSummary,
                        detail: nil,
                        status: status,
                        semanticOutcome: semanticOutcome(
                            summary: explicitSummary,
                            status: status,
                            activities: activities
                        ),
                        activities: activities,
                        evidence: evidence(
                            for: activities,
                            referencedFileCount: referencedFiles.count,
                            modifiedFileCount: modifiedFiles.count
                        ),
                        referencedFiles: referencedFiles,
                        modifiedFiles: modifiedFiles,
                        createdAt: first.createdAt
                    )
            }
            steps.append(
                cache?.step(
                    blocks: activityBlocks, summary: summaryBlock, streaming: streaming,
                    build: buildStep)
                    ?? buildStep())
            activityBlocks = []
        }

        for block in blocks {
            let kind = AgentTimelineSummarizer.classify(kind: block.kind, text: block.text)
            guard kind != .finalAnswer else { continue }
            if kind == .agentReasoning {
                // A milestone describes the work that preceded it. Closing the step
                // here avoids attaching the next tool call to the previous outcome.
                flush(summaryBlock: block)
            } else {
                activityBlocks.append(block)
            }
        }
        flush(streaming: isStreaming)

        return AgentTimelinePresentation(steps: steps)
    }

    private static func stepStatus(
        activities: [AgentCommandActivity],
        hasSummary: Bool
    ) -> AgentActivityStatus {
        guard !activities.isEmpty else { return hasSummary ? .completed : .pending }
        return aggregateStatus(for: activities)
    }

    private static func taskTitle(
        summary: String?,
        activities: [AgentCommandActivity]
    ) -> String {
        guard let summary, !summary.isEmpty else {
            if let current = activities.last(where: {
                $0.status == .running || $0.status == .pending
            }) {
                return "Running \(current.title)"
            }
            return activities.contains(where: { $0.status == .failed })
                ? "Command Needs Attention" : "Command Activity"
        }

        let sentence =
            summary.split(whereSeparator: { ".!?".contains($0) }).first.map(String.init)
            ?? summary
        var words = sentence.split(whereSeparator: { $0.isWhitespace }).map(String.init)
        if let first = words.first?.lowercased(), first == "i" || first == "we" {
            words.removeFirst()
        }
        let titleWords = Array(words.prefix(8))
        return titleWords.isEmpty ? "Progress Update" : titleWords.joined(separator: " ")
    }

    private static func semanticOutcome(
        summary: String?,
        status: AgentActivityStatus,
        activities: [AgentCommandActivity]
    ) -> AgentSemanticOutcome {
        let lower = summary?.lowercased() ?? ""
        let hasFailure = status == .failed || activities.contains(where: { $0.status == .failed })
        let hasSuccessfulActivity = activities.contains(where: { $0.status == .completed })
        let isBlocked = containsAny(
            lower,
            [
                "action required", "requires user", "need your input", "needs your input",
                "credentials required", "permission required", "cannot continue", "blocked",
            ]
        )
        let isResolved = containsAny(
            lower,
            [
                "recovered", "fallback succeeded", "retrieved successfully",
                "completed successfully",
                "resolved", "fixed", "succeeded after", "using the fallback", "using the open",
            ]
        )
        let hasPositiveOutcome = containsAny(
            lower,
            ["success", "completed", "retrieved", "found", "validated", "working", "passed"]
        )

        if hasFailure {
            if isBlocked { return .actionRequired }
            if summary == nil { return status == .running ? .warning : .failed }
            if isResolved || (hasSuccessfulActivity && hasPositiveOutcome) { return .recovered }
            return status == .running ? .warning : .failed
        }
        if status == .cancelled { return .warning }

        let resolvedNegation = containsAny(
            lower,
            [
                "no remaining issues", "risk was removed", "risk has been removed",
                "warnings were resolved", "warning was resolved", "without warnings",
                "missing file was found", "previously missing file was found",
                "fallback succeeded",
            ]
        )
        if !resolvedNegation
            && containsAny(
                lower,
                [
                    "no result", "no results", "found nothing", "could not find", "was not found",
                    "not found.",
                ]
            )
        {
            return .noResult
        }
        if !resolvedNegation
            && containsAny(
                lower,
                [
                    "unresolved warning", "warning remains", "remaining risk", "risk remains",
                    "remaining issue",
                ]
            )
        {
            return .warning
        }
        return .usefulResult
    }

    private static func containsAny(_ text: String, _ phrases: [String]) -> Bool {
        phrases.contains(where: text.contains)
    }

    private static func evidence(
        for activities: [AgentCommandActivity],
        referencedFileCount: Int,
        modifiedFileCount: Int
    ) -> [String] {
        let completed = activities.filter { $0.status == .completed }.count
        let failed = activities.filter { $0.status == .failed }.count
        let running = activities.filter { $0.status == .running || $0.status == .pending }.count
        var values: [String] = []
        if completed > 0 { values.append("\(completed) completed") }
        if failed > 0 { values.append("\(failed) failed") }
        if running > 0 { values.append("\(running) running") }
        if modifiedFileCount > 0 {
            values.append("\(modifiedFileCount) modified")
        }
        if referencedFileCount > 0 {
            values.append("\(referencedFileCount) referenced")
        }
        return values
    }

    private static func referencedFiles(in activities: [AgentCommandActivity]) -> [String] {
        uniqueProjectFiles(in: activities.flatMap(\.blocks).map(\.text).joined(separator: "\n"))
    }

    private static func modifiedFiles(in activities: [AgentCommandActivity]) -> [String] {
        var candidates: [String] = []

        for activity in activities {
            guard activity.status == .completed else { continue }
            guard let input = activity.blocks.first?.text else { continue }
            let toolName = activity.blocks.first.flatMap {
                AgentTimelineSummarizer.toolName(in: $0.text)
            }?
            .lowercased()
            if let toolName,
                ["edit_file", "write_file", "str_replace_based_edit_tool"].contains(toolName)
            {
                candidates.append(contentsOf: structuredEditPaths(in: input))
            } else if toolName == "apply_patch" {
                candidates.append(contentsOf: patchPaths(in: input))
            }

            guard activity.primaryKind == .shellCommand else {
                continue
            }
            if input.contains("*** Update File:") || input.contains("*** Add File:") {
                candidates.append(contentsOf: patchPaths(in: input))
            }
            if input.contains("git diff --name-only") || input.contains("git status --short") {
                let output = activity.blocks.dropFirst().map(\.text).joined(separator: "\n")
                candidates.append(contentsOf: versionControlPaths(in: output))
            }
        }

        return orderedUnique(candidates).prefix(5).map { $0 }
    }

    private static func structuredEditPaths(in input: String) -> [String] {
        let pattern = #"\"(?:path|file_path)\"\s*:\s*\"([^\"]+)\""#
        guard let expression = try? NSRegularExpression(pattern: pattern) else { return [] }
        let range = NSRange(input.startIndex..<input.endIndex, in: input)
        return orderedUnique(
            expression.matches(in: input, range: range).compactMap { match in
                guard let swiftRange = Range(match.range(at: 1), in: input) else { return nil }
                let path = String(input[swiftRange])
                return isProjectFile(path) ? path : nil
            })
    }

    private static func patchPaths(in input: String) -> [String] {
        let pattern = #"\*\*\* (?:Update|Add) File:\s*([^\r\n]+)"#
        guard let expression = try? NSRegularExpression(pattern: pattern) else { return [] }
        let range = NSRange(input.startIndex..<input.endIndex, in: input)
        return orderedUnique(
            expression.matches(in: input, range: range).compactMap { match in
                guard let swiftRange = Range(match.range(at: 1), in: input) else { return nil }
                let path = String(input[swiftRange]).trimmingCharacters(in: .whitespacesAndNewlines)
                return isProjectFile(path) ? path : nil
            })
    }

    private static func uniqueProjectFiles(in text: String) -> [String] {
        var files: [String] = []
        var seen: Set<String> = []
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        projectFileExpression.enumerateMatches(in: text, range: range) { match, _, stop in
            guard let match, let swiftRange = Range(match.range(at: 1), in: text) else { return }
            let path = String(text[swiftRange])
            guard isProjectFile(path), seen.insert(path).inserted else { return }
            files.append(path)
            if files.count == 5 { stop.pointee = true }
        }
        return files
    }

    private static func versionControlPaths(in text: String) -> [String] {
        let files = text.components(separatedBy: .newlines).compactMap { rawLine -> String? in
            var line = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !line.isEmpty, !line.hasPrefix("[") else { return nil }
            if line.count > 3 {
                let prefix = String(line.prefix(2))
                if prefix.range(of: #"[ MADRCU?]{2}"#, options: .regularExpression) != nil {
                    line = String(line.dropFirst(2)).trimmingCharacters(in: .whitespaces)
                }
            }
            return isProjectFile(line) ? line : nil
        }
        return orderedUnique(files)
    }

    private static func isProjectFile(_ path: String) -> Bool {
        guard !path.contains("://"), !path.hasPrefix("/") else { return false }
        let excludedPrefixes = ["node_modules/", "Vendor/", "Pods/", ".build/", "DerivedData/"]
        return !excludedPrefixes.contains(where: path.hasPrefix)
    }

    private static func orderedUnique(_ values: [String]) -> [String] {
        var seen: Set<String> = []
        return values.filter { seen.insert($0).inserted }
    }

    private static func makeActivities(from blocks: [ChatBlock], isStreaming: Bool)
        -> [AgentCommandActivity]
    {
        var result: [AgentCommandActivity] = []
        var consumedActivityIDs: Set<String> = []
        var blocksByActivityID: [String: [ChatBlock]] = [:]
        for block in blocks {
            if let id = block.activityId { blocksByActivityID[id, default: []].append(block) }
        }
        var index = 0

        while index < blocks.count {
            let block = blocks[index]
            let kind = AgentTimelineSummarizer.classify(kind: block.kind, text: block.text)

            if let activityID = block.activityId {
                if consumedActivityIDs.contains(activityID) {
                    index += 1
                    continue
                }
                consumedActivityIDs.insert(activityID)
                let grouped = blocksByActivityID[activityID] ?? [block]
                result.append(
                    AgentCommandActivity(
                        id: block.id,
                        blocks: grouped,
                        status: activityStatus(for: grouped, isStreaming: isStreaming)
                    )
                )
                index += 1
                continue
            }

            if kind == .shellCommand {
                var grouped = [block]
                if index + 1 < blocks.count {
                    let next = blocks[index + 1]
                    let nextKind = AgentTimelineSummarizer.classify(
                        kind: next.kind, text: next.text)
                    if nextKind == .terminalOutput {
                        grouped.append(next)
                        index += 1
                    }
                }
                let output = grouped.dropFirst().first
                let failed =
                    output.map { AgentTimelineSummarizer.terminalOutputFailed($0.text) } ?? false
                let status: AgentActivityStatus =
                    failed
                    ? .failed
                    : (output != nil
                        ? .completed
                        : (isStreaming && index == blocks.count - 1 ? .running : .cancelled))
                result.append(AgentCommandActivity(id: block.id, blocks: grouped, status: status))
            } else {
                let isLast = index == blocks.count - 1
                let status: AgentActivityStatus = isStreaming && isLast ? .running : .completed
                result.append(AgentCommandActivity(id: block.id, blocks: [block], status: status))
            }
            index += 1
        }

        return result
    }

    private static func activityStatus(for blocks: [ChatBlock], isStreaming: Bool)
        -> AgentActivityStatus
    {
        let phases = blocks.compactMap(\.activityPhase)
        if phases.contains(.failed) { return .failed }
        if phases.contains(.cancelled) { return .cancelled }
        if phases.contains(.completed) { return .completed }
        if phases.contains(.started) { return isStreaming ? .running : .cancelled }
        if phases.contains(.pending) { return .pending }
        return isStreaming ? .running : .completed
    }

    static func compactActivityTitle(for activities: [AgentCommandActivity]) -> String {
        guard !activities.isEmpty else { return "No command activity" }

        var scripts = 0
        var web = 0
        var mcp = 0
        var images = 0
        var tools = 0
        var standaloneOutputs = 0

        for activity in activities {
            switch activity.primaryKind {
            case .shellCommand: scripts += 1
            case .terminalOutput: standaloneOutputs += 1
            case .webCall: web += 1
            case .mcpCall: mcp += 1
            case .imageRendering: images += 1
            case .toolCall: tools += 1
            case .agentReasoning, .finalAnswer: break
            }
        }

        var parts: [String] = []
        if scripts > 0 { parts.append("\(scripts) script\(scripts == 1 ? "" : "s") run") }
        if web > 0 { parts.append("\(web) web search\(web == 1 ? "" : "es")") }
        if mcp > 0 { parts.append("\(mcp) MCP call\(mcp == 1 ? "" : "s")") }
        if images > 0 { parts.append("\(images) image task\(images == 1 ? "" : "s")") }
        if tools > 0 { parts.append("\(tools) tool call\(tools == 1 ? "" : "s")") }
        if standaloneOutputs > 0 {
            parts.append("\(standaloneOutputs) command output\(standaloneOutputs == 1 ? "" : "s")")
        }
        return parts.isEmpty
            ? "\(activities.count) activit\(activities.count == 1 ? "y" : "ies")"
            : parts.joined(separator: " · ")
    }

    static func aggregateStatus(for activities: [AgentCommandActivity]) -> AgentActivityStatus {
        activities.last?.status ?? .completed
    }
}

enum ChatComposerMetrics {
    static let fontSize: CGFloat = 14
    static let lineHeight: CGFloat = 22
    static let minimumHeight: CGFloat = 88

    static func height(for text: String) -> CGFloat {
        let lineCount = max(1, text.components(separatedBy: "\n").count)
        return max(minimumHeight, min(CGFloat(lineCount) * lineHeight + 40, 232))
    }
}

enum AgentActivityPagination {
    static let pageSize = 10

    static func initialVisibleCount(totalCount: Int) -> Int {
        min(max(totalCount, 0), pageSize)
    }

    static func nextVisibleCount(totalCount: Int, currentVisibleCount: Int) -> Int {
        let total = max(totalCount, 0)
        let current = max(initialVisibleCount(totalCount: total), currentVisibleCount)
        return min(total, current + pageSize)
    }

    static func visibleRange(totalCount: Int, visibleCount: Int) -> Range<Int> {
        let total = max(totalCount, 0)
        let count = min(total, max(initialVisibleCount(totalCount: total), visibleCount))
        return (total - count)..<total
    }

    static func hasMore(totalCount: Int, visibleCount: Int) -> Bool {
        visibleRange(totalCount: totalCount, visibleCount: visibleCount).lowerBound > 0
    }
}

enum ChatAutoScrollPolicy {
    static let nearBottomThreshold: CGFloat = 120

    static func shouldFollow(wasNearBottom: Bool, isLiveUpdate: Bool) -> Bool {
        wasNearBottom && isLiveUpdate
    }

    static func shouldAnimate(reduceMotion: Bool) -> Bool {
        !reduceMotion
    }
}

enum ConversationScrollGeometry {
    static func isNearBottom(
        visibleBottom: CGFloat,
        contentBottom: CGFloat,
        threshold: CGFloat = ChatAutoScrollPolicy.nearBottomThreshold
    ) -> Bool {
        max(0, contentBottom - visibleBottom) <= threshold
    }

    static func isNearTop(visibleTop: CGFloat, threshold: CGFloat = 120) -> Bool {
        visibleTop <= threshold
    }
}

enum ChatSessionScrollPolicy {
    static func shouldResetForSessionChange(previousSessionID: String?, sessionID: String?) -> Bool
    {
        previousSessionID != sessionID
    }

    static func shouldResetAfterHydration(
        wasLoading: Bool,
        isLoading: Bool,
        sessionID: String?
    ) -> Bool {
        wasLoading && !isLoading && sessionID != nil
    }
}

enum AgentCommandDisclosurePolicy {
    static let initiallyExpanded = false

    static func expansion(current: Bool, afterActivityCountChangedTo _: Int) -> Bool {
        current
    }
}

enum AgentTimelineMotionPolicy {
    static func shouldAnimate(reduceMotion: Bool) -> Bool { !reduceMotion }
}

enum AgentCompletedTimelinePolicy {
    static let initiallyExpanded = false

    static func shouldShowDisclosure(isStreaming: Bool, hasFinalAnswer: Bool) -> Bool {
        !isStreaming && hasFinalAnswer
    }

    static func isExpanded(
        isStreaming: Bool,
        hasFinalAnswer: Bool,
        completedExpanded: Bool
    ) -> Bool {
        isStreaming || !hasFinalAnswer || completedExpanded
    }

    static func expansionAfterStreamingChange(
        isStreaming: Bool,
        hasFinalAnswer: Bool,
        current: Bool
    ) -> Bool {
        isStreaming || !hasFinalAnswer ? current : false
    }
}

enum AgentTimelineDuration {
    static let minimumMeaningfulSpan: TimeInterval = 0.75

    static func elapsed(blocks: [ChatBlock], completionDate: Date?) -> TimeInterval? {
        guard let first = blocks.first?.createdAt else { return nil }
        let end = completionDate ?? blocks.last?.createdAt ?? first
        let elapsed = end.timeIntervalSince(first)
        return elapsed >= minimumMeaningfulSpan ? elapsed : nil
    }

    static func label(for elapsed: TimeInterval?) -> String {
        guard let elapsed else { return "Worked" }
        let seconds = max(1, Int(elapsed.rounded()))
        if seconds < 60 { return "Worked for \(seconds)s" }
        let minutes = seconds / 60
        let remainder = seconds % 60
        if minutes < 60 { return "Worked for \(minutes)m \(remainder)s" }
        return "Worked for \(minutes / 60)h \(minutes % 60)m"
    }
}

enum AgentActivityDetailContent {
    static let previewCharacterLimit = 12_000

    static func displayedText(_ text: String, showFullContent: Bool) -> String {
        guard text.count > previewCharacterLimit, !showFullContent else { return text }
        return String(text.prefix(previewCharacterLimit))
            + "\n\n… Output truncated in the timeline. Use Show full or Copy full details."
    }
}

enum ProgressiveBlockContent {
    static func displayedText(for block: ChatBlock, showFullContent: Bool) -> String {
        showFullContent ? block.text : (block.previewText ?? block.text)
    }

    static func sizeLabel(for block: ChatBlock) -> String {
        let count = block.contentLength ?? block.text.count
        return "\(max(1, count / 1_024)) KB"
    }
}
