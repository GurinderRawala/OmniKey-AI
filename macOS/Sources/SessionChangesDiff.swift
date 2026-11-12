import Foundation

/// One rendered row of a unified diff.
struct SessionDiffLine: Equatable, Sendable {
    enum Kind: Equatable, Sendable {
        case hunkHeader
        case context
        case added
        case removed
        /// "\ No newline at end of file" marker for the preceding line.
        case noNewline
    }

    var kind: Kind
    var oldNumber: Int?
    var newNumber: Int?
    /// Line text without its terminator. A CRLF terminator is kept as a
    /// trailing "\r" so line-ending-only changes are visible and exact.
    var text: String
}

struct SessionFileDiff: Equatable, Sendable {
    var lines: [SessionDiffLine]
    var added: Int
    var removed: Int
    /// Rendering was cut at the preview bounds (lines or line length).
    var previewTruncated: Bool
    /// The edit script exceeded the complexity bound; the changed middle
    /// region is shown as a whole replacement rather than a minimal diff.
    var approximate: Bool

    static let empty = SessionFileDiff(lines: [], added: 0, removed: 0, previewTruncated: false, approximate: false)
}

enum SessionTextDecoding {
    /// Text = valid UTF-8 without NUL bytes. Anything else is shown as a
    /// binary card with sizes/hashes and no invented line counts.
    static func text(from data: Data) -> String? {
        if data.contains(0) { return nil }
        return String(data: data, encoding: .utf8)
    }

    /// Splits into lines keeping "\r" of CRLF. Returns whether the last line
    /// had a trailing newline. Empty content has zero lines.
    static func lines(_ text: String) -> (lines: [String], finalNewline: Bool) {
        if text.isEmpty { return ([], true) }
        var parts = text.components(separatedBy: "\n")
        let finalNewline = parts.last == ""
        if finalNewline { parts.removeLast() }
        return (parts, finalNewline)
    }
}

enum SessionDiffEngine {
    static let contextLines = 3
    static let maxEditDistance = 512
    static let previewMaxLines = 5_000
    static let previewMaxLineLength = 1_000

    private enum Op { case equal, insert, delete }

    /// Full (unbounded-preview) diff of two texts. `old == nil` means the
    /// file did not exist (add); `new == nil` means deleted.
    static func diff(old: String?, new: String?, isCancelled: () -> Bool = { false }) -> SessionFileDiff {
        let (a, aFinal) = SessionTextDecoding.lines(old ?? "")
        let (b, bFinal) = SessionTextDecoding.lines(new ?? "")
        // A line's terminator is part of its identity. In particular an EOF
        // line cannot be matched as context against a now-terminated line.
        var comparedA = a, comparedB = b
        if !aFinal, !comparedA.isEmpty { comparedA[comparedA.count - 1] += "\u{0}EOF" }
        if !bFinal, !comparedB.isEmpty { comparedB[comparedB.count - 1] += "\u{0}EOF" }
        let (ops, approximate) = editScript(comparedA, comparedB, isCancelled: isCancelled)
        return buildHunks(a: a, b: b, ops: ops, aFinal: aFinal, bFinal: bFinal, approximate: approximate)
    }

    /// Bounds a full diff for on-screen preview, disclosing truncation.
    static func preview(_ diff: SessionFileDiff, maxLines: Int = previewMaxLines,
                        maxLineLength: Int = previewMaxLineLength) -> SessionFileDiff {
        var truncated = diff.lines.count > maxLines
        var lines = Array(diff.lines.prefix(maxLines))
        for index in lines.indices where lines[index].text.count > maxLineLength {
            let extra = lines[index].text.count - maxLineLength
            lines[index].text = String(lines[index].text.prefix(maxLineLength)) + " … [\(extra) more characters]"
            truncated = true
        }
        return SessionFileDiff(lines: lines, added: diff.added, removed: diff.removed,
                               previewTruncated: truncated, approximate: diff.approximate)
    }

    /// Exact unified patch text (git-style headers) for export/copy.
    static func unifiedPatch(path: String, diff: SessionFileDiff, oldExists: Bool, newExists: Bool) -> String {
        var out = "--- \(oldExists ? "a/" + path : "/dev/null")\n+++ \(newExists ? "b/" + path : "/dev/null")\n"
        for line in diff.lines {
            switch line.kind {
            case .hunkHeader: out += line.text + "\n"
            case .context: out += " " + line.text + "\n"
            case .added: out += "+" + line.text + "\n"
            case .removed: out += "-" + line.text + "\n"
            case .noNewline: out += "\\ No newline at end of file\n"
            }
        }
        return out
    }

    // MARK: Myers

    private static func editScript(_ a: [String], _ b: [String], isCancelled: () -> Bool) -> ([Op], Bool) {
        var prefix = 0
        while prefix < a.count, prefix < b.count, a[prefix] == b[prefix] { prefix += 1 }
        var suffix = 0
        while suffix < a.count - prefix, suffix < b.count - prefix,
              a[a.count - 1 - suffix] == b[b.count - 1 - suffix] { suffix += 1 }
        let midA = Array(a[prefix..<(a.count - suffix)])
        let midB = Array(b[prefix..<(b.count - suffix)])
        var ops = [Op](repeating: .equal, count: prefix)
        var approximate = false
        if let middle = myers(midA, midB, isCancelled: isCancelled) {
            ops += middle
        } else {
            approximate = true
            ops += [Op](repeating: .delete, count: midA.count) + [Op](repeating: .insert, count: midB.count)
        }
        ops += [Op](repeating: .equal, count: suffix)
        return (ops, approximate)
    }

    /// Returns nil when the edit distance exceeds `maxEditDistance`.
    private static func myers(_ a: [String], _ b: [String], isCancelled: () -> Bool) -> [Op]? {
        let n = a.count, m = b.count
        if n == 0 { return [Op](repeating: .insert, count: m) }
        if m == 0 { return [Op](repeating: .delete, count: n) }
        // Hash lines to Ints for fast comparison.
        var table: [String: Int] = [:]
        let ai = a.map { line -> Int in if let v = table[line] { return v }; let v = table.count; table[line] = v; return v }
        let bi = b.map { line -> Int in if let v = table[line] { return v }; let v = table.count; table[line] = v; return v }
        let maxD = min(n + m, maxEditDistance)
        let offset = maxD + 1
        var v = [Int](repeating: 0, count: 2 * maxD + 3)
        var trace: [[Int]] = []
        var found = false
        outer: for d in 0...maxD {
            if isCancelled() { return nil }
            // Snapshot only the live window [-d, d] (O(D^2) memory total).
            trace.append(Array(v[(offset - d - 1)...(offset + d + 1)]))
            var k = -d
            while k <= d {
                var x: Int
                if k == -d || (k != d && v[offset + k - 1] < v[offset + k + 1]) {
                    x = v[offset + k + 1]
                } else {
                    x = v[offset + k - 1] + 1
                }
                var y = x - k
                while x < n, y < m, ai[x] == bi[y] { x += 1; y += 1 }
                v[offset + k] = x
                if x >= n, y >= m { found = true; break outer }
                k += 2
            }
        }
        guard found else { return nil }
        // Backtrack.
        var ops: [Op] = []
        var x = n, y = m
        for d in stride(from: trace.count - 1, through: 0, by: -1) {
            let snapshot = trace[d]
            func at(_ k: Int) -> Int { snapshot[k + d + 1] }
            let k = x - y
            let prevK: Int
            if d == 0 {
                while x > 0, y > 0 { ops.append(.equal); x -= 1; y -= 1 }
                break
            }
            if k == -d || (k != d && at(k - 1) < at(k + 1)) { prevK = k + 1 } else { prevK = k - 1 }
            let prevX = at(prevK)
            let prevY = prevX - prevK
            while x > prevX, y > prevY { ops.append(.equal); x -= 1; y -= 1 }
            if x == prevX { ops.append(.insert); y -= 1 } else { ops.append(.delete); x -= 1 }
        }
        return ops.reversed()
    }

    // MARK: Hunks

    private static func buildHunks(a: [String], b: [String], ops: [Op], aFinal: Bool, bFinal: Bool,
                                   approximate: Bool) -> SessionFileDiff {
        // Tag every op with its line numbers.
        struct Row { var op: Op; var ai: Int; var bi: Int }
        var rows: [Row] = []
        rows.reserveCapacity(ops.count)
        var i = 0, j = 0
        for op in ops {
            rows.append(Row(op: op, ai: i, bi: j))
            switch op {
            case .equal: i += 1; j += 1
            case .delete: i += 1
            case .insert: j += 1
            }
        }
        let changed = rows.indices.filter { rows[$0].op != .equal }
        guard !changed.isEmpty else { return .empty }
        // Group change indices into hunks with context.
        var ranges: [ClosedRange<Int>] = []
        for index in changed {
            let lower = max(0, index - contextLines)
            let upper = min(rows.count - 1, index + contextLines)
            if let last = ranges.last, lower <= last.upperBound + 1 {
                ranges[ranges.count - 1] = last.lowerBound...max(last.upperBound, upper)
            } else {
                ranges.append(lower...upper)
            }
        }
        var lines: [SessionDiffLine] = []
        var added = 0, removed = 0
        for range in ranges {
            let slice = rows[range]
            let oldCount = slice.filter { $0.op != .insert }.count
            let newCount = slice.filter { $0.op != .delete }.count
            let first = slice.first!
            let oldStart = oldCount == 0 ? first.ai : first.ai + 1
            let newStart = newCount == 0 ? first.bi : first.bi + 1
            lines.append(SessionDiffLine(kind: .hunkHeader, oldNumber: nil, newNumber: nil,
                                         text: "@@ -\(oldStart),\(oldCount) +\(newStart),\(newCount) @@"))
            for row in slice {
                switch row.op {
                case .equal:
                    lines.append(SessionDiffLine(kind: .context, oldNumber: row.ai + 1, newNumber: row.bi + 1, text: a[row.ai]))
                    if row.ai == a.count - 1, !aFinal { lines.append(noNewline()) }
                case .delete:
                    removed += 1
                    lines.append(SessionDiffLine(kind: .removed, oldNumber: row.ai + 1, newNumber: nil, text: a[row.ai]))
                    if row.ai == a.count - 1, !aFinal { lines.append(noNewline()) }
                case .insert:
                    added += 1
                    lines.append(SessionDiffLine(kind: .added, oldNumber: nil, newNumber: row.bi + 1, text: b[row.bi]))
                    if row.bi == b.count - 1, !bFinal { lines.append(noNewline()) }
                }
            }
        }
        return SessionFileDiff(lines: lines, added: added, removed: removed, previewTruncated: false, approximate: approximate)
    }

    private static func noNewline() -> SessionDiffLine {
        SessionDiffLine(kind: .noNewline, oldNumber: nil, newNumber: nil, text: "\\ No newline at end of file")
    }
}
