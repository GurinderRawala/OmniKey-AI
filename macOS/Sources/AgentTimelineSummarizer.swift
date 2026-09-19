import Foundation

enum AgentTimelineSummarizer {
    /// Converts a user-visible agent update into one safe, readable paragraph.
    /// It deliberately removes command-shaped content, redacts common secret
    /// assignments, and caps the result at 150 words. This is a
    /// progress summary derived only from streamed text, not hidden reasoning.
    static func progressSummary(_ text: String, wordLimit: Int = 150) -> String {
        let prose = reasoningProse(text)
        guard !prose.isEmpty else { return "" }

        let withoutMarkdown =
            prose
            .components(separatedBy: .newlines)
            .map { raw -> String in
                var line = raw.trimmingCharacters(in: .whitespacesAndNewlines)
                while line.hasPrefix("#") { line.removeFirst() }
                for marker in ["- ", "* ", "> "] where line.hasPrefix(marker) {
                    line.removeFirst(marker.count)
                }
                return line.trimmingCharacters(in: .whitespacesAndNewlines)
            }
            .filter { !$0.isEmpty }
            .joined(separator: " ")

        let redacted = redactSensitiveValues(in: withoutMarkdown)
        let words = redacted.split(whereSeparator: { $0.isWhitespace })
        guard words.count > wordLimit else { return words.joined(separator: " ") }
        return words.prefix(wordLimit).joined(separator: " ") + "…"
    }

    static func terminalOutputFailed(_ text: String) -> Bool {
        let first = text.components(separatedBy: .newlines).first?.lowercased() ?? ""
        return first.contains("error") || first.contains("failed") || first.contains("exit code")
    }

    private static func redactSensitiveValues(in text: String) -> String {
        let patterns = [
            #"(?i)\b(api[_-]?key|access[_-]?token|auth[_-]?token|password|secret)\s*[:=]\s*([^\s,;]+)"#,
            #"\b(sk-[A-Za-z0-9_-]{12,})\b"#,
        ]
        return patterns.reduce(text) { value, pattern in
            guard let regex = try? NSRegularExpression(pattern: pattern) else { return value }
            let range = NSRange(value.startIndex..<value.endIndex, in: value)
            if pattern.contains("api[_-]?key") {
                return regex.stringByReplacingMatches(in: value, range: range, withTemplate: "$1=[REDACTED]")
            }
            return regex.stringByReplacingMatches(in: value, range: range, withTemplate: "[REDACTED]")
        }
    }

    static func expandedSummary(kind: TimelineEntryKind, text: String) -> String {
        summarize(kind: displayKind(for: kind), text: text).expanded
    }

    /// Recovers the real kind of a persisted block.
    ///
    /// The server transcript files every unrecognised `role: "tool"` result
    /// under `agentReasoning` (see `toolBlockKind` — its fallback branch), so
    /// replayed timelines label genuine tool calls as "Reasoning". The payload
    /// still carries the `Tool: <name>` header the builder wrote, which is
    /// enough to classify it correctly on the client.
    ///
    /// Blocks that already have a specific kind are returned untouched.
    static func classify(kind: ChatBlockKind, text: String) -> ChatBlockKind {
        guard kind == .agentReasoning else { return kind }
        guard let tool = toolName(in: text) else { return .agentReasoning }

        let lower = tool.lowercased()
        if lower.hasPrefix("mcp_") || lower.hasPrefix("mcp__") { return .mcpCall }
        if lower == "generate_image" { return .imageRendering }
        if lower == "web_search" || lower == "web_fetch" { return .webCall }
        if lower == "shell_script" { return .shellCommand }
        return .toolCall
    }

    /// Extracts `<name>` from a leading `Tool: <name>` header, which is the
    /// exact shape `toolBlockText` writes into persisted history.
    static func toolName(in text: String) -> String? {
        for rawLine in text.components(separatedBy: .newlines) {
            let line = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !line.isEmpty else { continue }

            guard line.lowercased().hasPrefix("tool:") else { return nil }
            let name = line.dropFirst("tool:".count)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            return name.isEmpty ? nil : name
        }
        return nil
    }

    /// Human-readable form of a raw tool identifier: `mcp_github__list_repos`
    /// becomes `github › list repos`, `web_search` becomes `web search`.
    static func friendlyToolName(_ raw: String) -> String {
        var name = raw
        for prefix in ["mcp__", "mcp_"] where name.lowercased().hasPrefix(prefix) {
            name = String(name.dropFirst(prefix.count))
            break
        }
        return
            name
            .components(separatedBy: "__")
            .map { $0.replacingOccurrences(of: "_", with: " ") }
            .filter { !$0.isEmpty }
            .joined(separator: " \u{203A} ")
    }

    /// Strips command noise out of a reasoning block, leaving only the prose
    /// the agent actually wrote.
    ///
    /// Persisted reasoning blocks are polluted from two directions: the
    /// transcript builder files unrecognised `role: "tool"` results under
    /// `agentReasoning` with a raw `Tool: <name>` payload, and the prose that
    /// accompanies a `<shell_script>` is stored verbatim — often restating
    /// the command it is about to run. Replaying that in the timeline shows
    /// commands twice (once here, once in the adjacent `shellCommand` row)
    /// and reads as a dump rather than reasoning.
    ///
    /// Returns an empty string when nothing but noise remains, which the
    /// timeline uses as the signal to drop the step entirely.
    static func reasoningProse(_ text: String) -> String {
        var kept: [String] = []
        var inFence = false

        for rawLine in text.components(separatedBy: .newlines) {
            let line = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)

            // Fenced blocks in reasoning are always command/output dumps here;
            // the real script lives in its own `shellCommand` block.
            if line.hasPrefix("```") {
                inFence.toggle()
                continue
            }
            if inFence { continue }

            if line.isEmpty {
                // Collapse runs of blank lines instead of leaving gaps behind
                // removed content.
                if kept.last?.isEmpty == false { kept.append("") }
                continue
            }

            if isCommandNoise(line) { continue }

            kept.append(rawLine)
        }

        while kept.last?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == true {
            kept.removeLast()
        }

        return kept.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// True for lines that are machinery rather than reasoning: tool-result
    /// headers, stream markers, and bare shell invocations.
    private static func isCommandNoise(_ line: String) -> Bool {
        let lower = line.lowercased()

        if lower.hasPrefix("tool:") || lower == "tool result" { return true }
        // Placeholder the transcript builder emits for an empty tool result.
        if lower == "no result text." || lower == "no result text" { return true }
        if line == "TERMINAL OUTPUT:" || line == "COMMAND ERROR:" { return true }
        if line.hasPrefix("[terminal ") { return true }
        if line.hasPrefix("$ ") || line.hasPrefix("% ") { return true }
        if isShellBoilerplate(line) { return true }

        // A line that is nothing but a shell invocation. Anchored to the start
        // so prose that merely mentions a tool ("I'll use git to check the
        // history") is preserved.
        //
        // The prefix alone is not sufficient: several starters are also common
        // English sentence openers ("Find the root cause first.", "Which
        // approach is better?", "Sort the results by date."). A line must
        // therefore also *look* like a command — see `looksLikeShellInvocation`.
        let commandStarters = [
            "cd ", "ls ", "cat ", "sed ", "rg ", "grep ", "find ", "git ",
            "npm ", "yarn ", "pnpm ", "swift ", "xcodebuild ", "python ",
            "python3 ", "node ", "echo ", "mkdir ", "cp ", "mv ", "rm ",
            "touch ", "chmod ", "curl ", "wget ", "sqlite3 ", "awk ", "sort ",
            "head ", "tail ", "wc ", "which ", "export ", "brew ", "docker ",
        ]
        for starter in commandStarters where lower.hasPrefix(starter) {
            return looksLikeShellInvocation(line)
        }

        return false
    }

    /// Second gate for lines that begin with a known command word. Rejects
    /// anything shaped like prose and requires positive evidence of a shell
    /// invocation, so sentences that merely start with `find`, `which`,
    /// `sort`, or `head` survive.
    private static func looksLikeShellInvocation(_ line: String) -> Bool {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)

        let tokens = trimmed.split(separator: " ", omittingEmptySubsequences: true)

        // Prose ends in sentence punctuation; commands effectively never do.
        // A bare `.` final token is exempt — that is a path argument, as in
        // `grep -r pattern .`, not the end of a sentence.
        if let last = trimmed.last, ".?!:,;".contains(last), tokens.last != "." {
            return false
        }

        // Strong syntax that prose does not use: flags, paths, globs,
        // redirects, pipes, variables, or assignments.
        //
        // Quotes and apostrophes are deliberately excluded — they appear in
        // ordinary prose ("Find the file's path") far too often to be evidence.
        let evidence: [String] = [" -", " --", "/", "|", ">", "<", "&&", "~", "$", "*", "="]
        for marker in evidence where trimmed.contains(marker) { return true }

        // No syntax evidence left, so only accept a terse invocation such as
        // `swift build`, `npm ci`, or `docker compose up`. Anything longer
        // reads as a sentence.
        guard tokens.count <= 3 else { return false }

        // Every argument must be lowercase (subcommands) or a filename.
        // A capitalised word signals prose ("which React"), while a dotted
        // token is a file (`cat Package.swift`).
        return tokens.dropFirst().allSatisfy { token in
            token.first?.isUppercase == false || token.contains(".")
        }
    }

    private enum DisplayKind {
        case agentReasoning
        case shellCommand
        case toolCall
        case terminalOutput
        case webCall
        case mcpCall
        case imageRendering
        case finalAnswer
    }

    private struct Summary {
        let collapsed: String
        let expanded: String
    }

    private static func displayKind(for kind: TimelineEntryKind) -> DisplayKind {
        switch kind {
        case .agentMessage: return .agentReasoning
        case .terminalOutput: return .terminalOutput
        case .webCall: return .webCall
        case .imageRendering: return .imageRendering
        case .mcpCall: return .mcpCall
        }
    }

    private static func summarize(kind: DisplayKind, text: String) -> Summary {
        switch kind {
        case .shellCommand:
            return summarizeShellCommand(text)
        case .terminalOutput:
            return summarizeTerminalOutput(text)
        case .mcpCall:
            return summarizeMCP(text)
        case .webCall:
            return summarizeWebCall(text)
        case .imageRendering:
            return summarizeGeneric(text, fallback: "Image task updated")
        case .toolCall:
            return summarizeToolCall(text)
        case .agentReasoning, .finalAnswer:
            return summarizeGeneric(text, fallback: "")
        }
    }

    private static func summarizeShellCommand(_ text: String) -> Summary {
        let lines = meaningfulLines(text)
        let commandLines =
            lines
            .filter { !isShellBoilerplate($0) }
            .prefix(4)
            .map(commandDescription)

        if commandLines.isEmpty {
            return Summary(
                collapsed: "Running a shell script",
                expanded: "Running a shell script. No concise command preview is available."
            )
        }

        let collapsed = truncate(commandLines.first ?? "Running a shell script", max: 160)
        let bullets = commandLines.map { "- \($0)" }.joined(separator: "\n")
        let suffix =
            lines.count > commandLines.count
            ? "\n- Plus \(lines.count - commandLines.count) additional script line(s)." : ""
        return Summary(
            collapsed: collapsed,
            expanded: "Running shell script:\n\(bullets)\(suffix)"
        )
    }

    private static func summarizeTerminalOutput(_ text: String) -> Summary {
        let parts = terminalParts(text)
        let body = parts.body.trimmingCharacters(in: .whitespacesAndNewlines)
        let lines = meaningfulLines(body)
        let status = parts.isError ? "Command failed" : "Command finished"
        let statusText = parts.statusLabel.map { "\(status) (\($0))" } ?? status

        if body.isEmpty {
            return Summary(
                collapsed: "\(statusText) with no output",
                expanded: "\(statusText).\n- Output: no text was produced."
            )
        }

        let preview = previewText(from: lines, fallback: body)
        let collapsed = truncate("\(statusText): \(preview)", max: 180)
        let expanded = [
            "\(statusText).",
            "- Output size: \(lines.count) line\(lines.count == 1 ? "" : "s"), \(body.count) characters.",
            "- Key output: \(preview)",
        ].joined(separator: "\n")

        return Summary(collapsed: collapsed, expanded: expanded)
    }

    /// Summary for a generic tool invocation recovered from a mislabelled
    /// reasoning block. Mirrors `summarizeMCP` so tool steps read consistently
    /// with the MCP rows beside them.
    private static func summarizeToolCall(_ text: String) -> Summary {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let raw = toolName(in: trimmed)
        let label = raw.map(friendlyToolName) ?? "tool"
        let body = resultBody(from: trimmed)

        if body.isEmpty {
            let text = "Called \(label)"
            return Summary(collapsed: text, expanded: text)
        }

        let result = resultSummary(body)
        return Summary(
            collapsed: truncate("\(label): \(result.collapsed)", max: 180),
            expanded: "Called `\(label)`.\n\(result.expanded)"
        )
    }

    private static func summarizeMCP(_ text: String) -> Summary {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let toolName = extractToolName(from: trimmed, prefixes: ["Calling MCP tool:", "Tool:"])
        let body = resultBody(from: trimmed)

        if let toolName, body.isEmpty {
            let label = "Calling MCP tool \(toolName)"
            return Summary(collapsed: label, expanded: label)
        }

        let target = toolName.map { "MCP tool \($0)" } ?? "MCP tool"
        let result = resultSummary(body.isEmpty ? trimmed : body)
        return Summary(
            collapsed: truncate("\(target): \(result.collapsed)", max: 180),
            expanded: "\(target) returned a result.\n\(result.expanded)"
        )
    }

    private static func summarizeWebCall(_ text: String) -> Summary {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let toolName = extractToolName(from: trimmed, prefixes: ["Tool:"])
        let body = resultBody(from: trimmed)

        if let toolName {
            let result = resultSummary(body)
            return Summary(
                collapsed: truncate("\(toolName): \(result.collapsed)", max: 180),
                expanded: "Web tool \(toolName) returned a result.\n\(result.expanded)"
            )
        }

        return summarizeGeneric(trimmed, fallback: "Web activity updated")
    }

    private static func summarizeGeneric(_ text: String, fallback: String) -> Summary {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            return Summary(collapsed: fallback, expanded: fallback)
        }
        let preview = previewText(from: meaningfulLines(trimmed), fallback: trimmed)
        return Summary(collapsed: truncate(preview, max: 180), expanded: truncate(preview, max: 600))
    }

    private static func resultSummary(_ text: String) -> Summary {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            return Summary(collapsed: "No result text", expanded: "- Result: no text was returned.")
        }

        if let jsonDescription = describeJSON(trimmed) {
            let preview = previewText(from: meaningfulLines(trimmed), fallback: trimmed)
            return Summary(
                collapsed: jsonDescription,
                expanded: "- Result shape: \(jsonDescription).\n- Preview: \(preview)"
            )
        }

        let lines = meaningfulLines(trimmed)
        let preview = previewText(from: lines, fallback: trimmed)
        return Summary(
            collapsed: preview,
            expanded:
                "- Result size: \(lines.count) line\(lines.count == 1 ? "" : "s"), \(trimmed.count) characters.\n- Preview: \(preview)"
        )
    }

    private static func terminalParts(_ text: String) -> (statusLabel: String?, isError: Bool, body: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        var lines = trimmed.components(separatedBy: .newlines)
        let first = lines.first?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""

        if first.hasPrefix("[terminal ") {
            lines.removeFirst()
            let status =
                first
                .replacingOccurrences(of: "[terminal ", with: "")
                .replacingOccurrences(of: "]", with: "")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            return (status, status.lowercased().contains("error"), lines.joined(separator: "\n"))
        }

        if first.lowercased() == "command error" {
            lines.removeFirst()
            return ("error", true, lines.joined(separator: "\n"))
        }

        return (nil, false, trimmed)
    }

    private static func resultBody(from text: String) -> String {
        let parts = text.components(separatedBy: "\n\n")
        guard parts.count > 1 else { return "" }
        return parts.dropFirst().joined(separator: "\n\n").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func extractToolName(from text: String, prefixes: [String]) -> String? {
        let firstLine =
            text.components(separatedBy: .newlines)
            .first?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""

        for prefix in prefixes where firstLine.hasPrefix(prefix) {
            let name =
                firstLine
                .dropFirst(prefix.count)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            return name.isEmpty ? nil : String(name)
        }
        return nil
    }

    private static func meaningfulLines(_ text: String) -> [String] {
        text.components(separatedBy: .newlines)
            .map { normalizeInlineWhitespace($0) }
            .filter { line in
                guard !line.isEmpty else { return false }
                if line == "TERMINAL OUTPUT:" || line == "COMMAND ERROR:" { return false }
                return true
            }
    }

    private static func isShellBoilerplate(_ line: String) -> Bool {
        let lower = line.lowercased()
        return lower == "set -e" || lower == "set -eu" || lower == "set -euo pipefail" || lower == "set -o pipefail"
            || lower == "then" || lower == "do" || lower == "done" || lower == "fi" || lower.hasPrefix("#")
    }

    private static func commandDescription(_ line: String) -> String {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        let lower = trimmed.lowercased()

        if lower.hasPrefix("cd ") { return "Change directory to \(truncate(String(trimmed.dropFirst(3)), max: 80))" }
        if lower.hasPrefix("git ") { return "Run git \(truncate(String(trimmed.dropFirst(4)), max: 100))" }
        if lower.hasPrefix("rg ") { return "Search files with ripgrep" }
        if lower.hasPrefix("grep ") { return "Search text with grep" }
        if lower.hasPrefix("find ") { return "Find matching files" }
        if lower.hasPrefix("sed ") { return "Read a selected range of a file" }
        if lower.hasPrefix("cat ") { return "Read file contents" }
        if lower.hasPrefix("sqlite3 ") { return "Query the local SQLite database" }
        if lower.hasPrefix("npm ") || lower.hasPrefix("yarn ") || lower.hasPrefix("pnpm ") {
            return "Run package script: \(truncate(trimmed, max: 120))"
        }
        if lower.hasPrefix("swift ") || lower.hasPrefix("xcodebuild ") {
            return "Run macOS build command: \(truncate(trimmed, max: 120))"
        }
        if lower.hasPrefix("python ") || lower.hasPrefix("python3 ") { return "Run Python helper script" }
        if lower.hasPrefix("node ") { return "Run Node.js helper script" }

        return truncate(trimmed, max: 140)
    }

    private static func previewText(from lines: [String], fallback: String) -> String {
        let candidates = lines.isEmpty ? meaningfulLines(fallback) : lines
        let preview =
            candidates
            .prefix(3)
            .map { truncate($0, max: 120) }
            .joined(separator: "; ")

        if !preview.isEmpty { return truncate(preview, max: 260) }
        return truncate(normalizeInlineWhitespace(fallback), max: 260)
    }

    private static func describeJSON(_ text: String) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("{") || trimmed.hasPrefix("[") else { return nil }
        guard let data = trimmed.data(using: .utf8),
            let value = try? JSONSerialization.jsonObject(with: data)
        else { return nil }

        if let dict = value as? [String: Any] {
            return "JSON object with \(dict.count) field\(dict.count == 1 ? "" : "s")"
        }
        if let array = value as? [Any] {
            return "JSON array with \(array.count) item\(array.count == 1 ? "" : "s")"
        }
        return "JSON value"
    }

    private static func normalizeInlineWhitespace(_ text: String) -> String {
        text
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .components(separatedBy: .whitespacesAndNewlines)
            .filter { !$0.isEmpty }
            .joined(separator: " ")
    }

    private static func truncate(_ text: String, max: Int) -> String {
        guard text.count > max else { return text }
        let end = text.index(text.startIndex, offsetBy: max)
        return String(text[..<end]).trimmingCharacters(in: .whitespacesAndNewlines) + "..."
    }
}
