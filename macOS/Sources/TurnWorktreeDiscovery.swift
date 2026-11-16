import Foundation

/// Discovers only linked checkouts of an explicitly selected repository, on the
/// execution host. Git output is data; no shell evaluation or recursive search.
struct TurnWorktreeDiscovery {
    private static func rootWithin(_ path: String, _ scope: String) -> Bool {
        guard let physical = TurnFileReader.physicalPath(path) else { return false }
        return physical == scope || physical.hasPrefix(scope + "/")
    }

    private static func rootWithinLexically(_ path: String, _ scope: String) -> Bool {
        let root = TurnChangeTracker.comparable(path), selected = TurnChangeTracker.comparable(scope)
        return root == selected || root.hasPrefix(selected + "/")
    }

    static func discover(_ candidates: [String], deadline: Date) -> [GitDiscoveredWorktree] {
        guard let git = GitCommandRunner() else { return [] }
        var found: [GitDiscoveredWorktree] = []
        var seen = Set<String>()
        func output(_ arguments: [String], at root: String, max: Int = 4096) -> String? {
            guard Date() < deadline,
                  let value = try? git.run(arguments, in: root, maxStdout: max, deadline: deadline), value.status == 0 else { return nil }
            return String(data: value.stdout, encoding: .utf8)?.trimmingCharacters(in: .newlines)
        }
        for candidate in candidates.prefix(8) {
            guard !TurnChangeTracker.sensitive(candidate),
                  let physical = TurnFileReader.physicalPath(candidate),
                  let top = output(["rev-parse", "--show-toplevel"], at: physical),
                  TurnFileReader.physicalPath(top) == physical,
                  let common = output(["rev-parse", "--path-format=absolute", "--git-common-dir"], at: physical),
                  let canonicalCommon = TurnFileReader.physicalPath(common),
                  let listing = output(["worktree", "list", "--porcelain", "-z"], at: physical, max: 128 * 1024) else { continue }
            // Selecting a subfolder does not authorize expanding to its Git parent.
            for field in listing.split(separator: "\0") where field.hasPrefix("worktree ") {
                let path = String(field.dropFirst(9))
                guard path.hasPrefix("/"), path.utf8.count <= 1024,
                      !path.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
                      !TurnChangeTracker.sensitive(path),
                      candidates.contains(where: { scope in
                          guard let allowed = TurnFileReader.physicalPath(scope) else { return false }
                          return rootWithin(path, allowed)
                      }),
                      let root = TurnFileReader.physicalPath(path), root != physical,
                      root != "/", root != TurnFileReader.physicalPath(NSHomeDirectory()),
                      !seen.contains(root), (try? TurnFileReader(root: root)) != nil,
                      let linked = output(["rev-parse", "--path-format=absolute", "--git-common-dir"], at: root),
                      TurnFileReader.physicalPath(linked) == canonicalCommon else { continue }
                seen.insert(root)
                var discovered = GitDiscoveredWorktree(root: root, repository: candidate)
                // The API cannot resolve paths on this host. Carry the selected
                // scope and its physical form when lexical containment differs.
                if !candidates.contains(where: { rootWithinLexically(root, $0) }),
                   let scope = candidates.first(where: {
                       guard let physicalScope = TurnFileReader.physicalPath($0) else { return false }
                       return rootWithin(root, physicalScope)
                   }) {
                    discovered.scope = scope
                    discovered.physicalScope = TurnFileReader.physicalPath(scope)
                }
                found.append(discovered)
                if found.count == 8 { return found }
            }
        }
        return found
    }

    /// Existing baselines are returned unchanged. Newly discovered worktrees get
    /// this request's timing and must be acknowledged by the server before final.
    static func collect(_ request: GitDiffRequestPayload, tracker: TurnChangeTracker) -> GitDiffResponsePayload {
        guard !request.hasUnsupportedPhase, request.candidatePaths.count <= 8,
              request.phase == .baseline, request.discoverWorktrees == true else { return tracker.collect(request) }
        let discovered = discover(request.candidatePaths, deadline: Date().addingTimeInterval(2))
        // One bounded baseline pass, not a second full timeout per worktree.
        // Explicit candidates get admission first. The tracker still reports
        // its root cap on subsequent explicit registration attempts.
        let paths = Array((request.candidatePaths + discovered.map(\.root)).prefix(8))
        let result = tracker.collect(GitDiffRequestPayload(requestID: request.requestID,
            candidatePaths: paths, phase: .baseline,
            baselineSource: request.baselineSource, filesystem: true))
        tracker.noteUncapturedRoots(discovered.map(\.root))
        return GitDiffResponsePayload(requestID: request.requestID, status: result.status,
            baselines: result.baselines, reason: result.reason, rootAliases: result.rootAliases,
            discoveredWorktrees: discovered)
    }
}
