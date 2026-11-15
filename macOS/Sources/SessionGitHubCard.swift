import Foundation
import SwiftUI

struct SessionPullRequest: Codable, Equatable, Identifiable, Sendable {
    let number: Int
    let title: String
    let url: String
    let state: String
    let isDraft: Bool
    var id: Int { number }
}

struct SessionGitHubInfo: Codable, Equatable, Sendable {
    let root: String
    let repository: String
    var branch: String
    var changedFiles: Int?
    var pullRequests: [SessionPullRequest]
    var pullRequestsLoaded: Bool
}

enum SessionGitHubDiscovery {
    static func repository(from remote: String) -> String? {
        var value = remote.trimmingCharacters(in: .whitespacesAndNewlines)
        if value.hasPrefix("git@github.com:") { value = "https://github.com/" + value.dropFirst("git@github.com:".count) }
        guard let url = URL(string: value), url.host?.lowercased() == "github.com",
              ["https", "ssh", "git"].contains(url.scheme?.lowercased() ?? "") else { return nil }
        var path = url.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        if path.hasSuffix(".git") { path.removeLast(4) }
        let parts = path.split(separator: "/")
        guard parts.count == 2, parts.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." && $0.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || "._-".contains($0)) } }) else { return nil }
        return path
    }

    static func linkedPRs(in texts: [String], repository: String) -> Set<Int> {
        let pattern = "https://github\\.com/" + NSRegularExpression.escapedPattern(for: repository) + "/pull/([0-9]+)(?![0-9])"
        guard let regex = try? NSRegularExpression(pattern: pattern, options: .caseInsensitive) else { return [] }
        var numbers = Set<Int>()
        for text in texts {
            let source = text as NSString
            for match in regex.matches(in: text, range: NSRange(location: 0, length: source.length)) {
                if let number = Int(source.substring(with: match.range(at: 1))), number > 0 { numbers.insert(number) }
            }
        }
        return numbers
    }

    static func startingPaths(in messages: [ChatMessage]) -> [String] {
        let blocks = messages.flatMap(\.blocks)
        let structured = blocks.compactMap { $0.kind == .shellCommand ? $0.workingDirectory : nil }
        let commands = blocks.filter { $0.kind == .shellCommand }.flatMap {
            GitShellCommandAnalyzer.analyze($0.text, initialDirectory: $0.workingDirectory).observedDirectories
        }
        let captured = blocks.flatMap { block in
            block.liveDiff?.coverage.map(\.root) ?? block.sessionDiff?.coverage?.map(\.root) ?? []
        }
        var seen = Set<String>()
        return (structured + captured + commands).filter { $0.hasPrefix("/") && seen.insert($0).inserted }
    }

    static func startingPath(in messages: [ChatMessage]) -> String? {
        startingPaths(in: messages).first
    }

    struct BranchPullRequest: Decodable {
        struct Repository: Decodable { let name: String }
        struct Owner: Decodable { let login: String }
        let number: Int
        let title: String
        let url: String
        let state: String
        let isDraft: Bool
        let headRepository: Repository?
        let headRepositoryOwner: Owner?
        func belongs(to repository: String) -> Bool { headRepositoryName?.lowercased() == repository.lowercased() }
        var headRepositoryName: String? {
            guard let headRepository, let headRepositoryOwner else { return nil }
            return headRepositoryOwner.login + "/" + headRepository.name
        }
        var pullRequest: SessionPullRequest {
            SessionPullRequest(number: number, title: title, url: url, state: state, isDraft: isDraft)
        }
    }

    static func lookupOrder(linked: Set<Int>, cached: Set<Int>, refreshIndex: Int) -> [Int] {
        let fresh = linked.subtracting(cached).sorted()
        let old = cached.sorted()
        let offset = old.isEmpty ? 0 : refreshIndex % old.count
        let freshOffset = fresh.isEmpty ? 0 : refreshIndex % fresh.count
        return Array((Array(fresh.dropFirst(freshOffset)) + Array(fresh.prefix(freshOffset))).prefix(3)) + Array((Array(old.dropFirst(offset)) + Array(old.prefix(offset))).prefix(1))
    }

    /// Read-only local Git + authenticated GitHub CLI, never a shell command.
    static func refresh(path: String, previous: SessionGitHubInfo?, texts: [String], loadPullRequests: Bool = true, refreshIndex: Int = 0) -> SessionGitHubInfo? {
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory), isDirectory.boolValue else { return nil }
        guard let git = GitCommandRunner() else { return previous }
        let localDeadline = Date().addingTimeInterval(3)
        func gitText(_ args: [String]) -> String? {
            guard let result = try? git.run(args, in: path, maxStdout: 512 * 1024, deadline: localDeadline), result.status == 0 else { return nil }
            return String(decoding: result.stdout, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        guard let root = gitText(["rev-parse", "--show-toplevel"]) else { return nil }
        let branch = gitText(["branch", "--show-current"]) ?? previous?.branch ?? ""
        let remoteName = branch.isEmpty ? nil : gitText(["config", "--get", "branch.\(branch).remote"])
        let names = [remoteName, "origin"].compactMap { $0 } + (gitText(["remote"]) ?? "").components(separatedBy: "\n")
        let repositories = names.filter { !$0.isEmpty && $0 != "." }.reduce(into: [String]()) { found, name in
            if let remote = gitText(["remote", "get-url", name]), let repo = repository(from: remote), !found.contains(repo) { found.append(repo) }
        }
        guard let repository = previous.flatMap({ repositories.contains($0.repository) ? $0.repository : nil }) ?? repositories.first else { return nil }
        // origin describes this clone's head repository; the branch may track
        // upstream, which is the base repository queried above.
        let headRepository = gitText(["remote", "get-url", "origin"]).flatMap { Self.repository(from: $0) } ?? repository
        let old = previous?.repository == repository ? previous : nil
        let status = gitText(["status", "--porcelain=v1", "--untracked-files=normal"])
        var info = SessionGitHubInfo(root: root, repository: repository, branch: branch,
            changedFiles: status.map { $0.isEmpty ? 0 : $0.components(separatedBy: "\n").count },
            pullRequests: old?.pullRequests ?? [], pullRequestsLoaded: false)
        guard loadPullRequests else { return info }
        guard let ghPath = ["/opt/homebrew/bin/gh", "/usr/local/bin/gh"].first(where: { FileManager.default.isExecutableFile(atPath: $0) }),
              let gh = GitCommandRunner(gitPath: ghPath, prefixArguments: []) else { return info }
        let deadline = Date().addingTimeInterval(15)
        let fields = "number,title,url,state,isDraft,headRepository,headRepositoryOwner"
        func request(_ args: [String]) -> Data? {
            guard let result = try? gh.run(args, in: root, maxStdout: 512 * 1024, deadline: min(deadline, Date().addingTimeInterval(3))), result.status == 0 else { return nil }
            return result.stdout
        }
        var prs = Dictionary(uniqueKeysWithValues: info.pullRequests.map { ($0.number, $0) })
        // Newly linked PRs have priority over all refresh work. Rotate cached
        // lookups, with a per-command timeout, so one slow PR cannot starve others.
        let linked = linkedPRs(in: texts, repository: repository)
        for number in lookupOrder(linked: linked, cached: Set(prs.keys), refreshIndex: refreshIndex) where Date() < deadline {
            if let data = request(["pr", "view", String(number), "--repo", repository, "--json", fields]),
               let item = try? JSONDecoder().decode(BranchPullRequest.self, from: data) {
                if linked.contains(number) || item.belongs(to: headRepository) { prs[number] = item.pullRequest }
                else { prs.removeValue(forKey: number) }
            }
        }
        if !branch.isEmpty,
           let data = request(["pr", "list", "--repo", repository, "--head", branch, "--state", "all", "--limit", "100", "--json", fields]),
           let current = try? JSONDecoder().decode([BranchPullRequest].self, from: data) {
            info.pullRequestsLoaded = true
            for item in current where item.belongs(to: headRepository) {
                let pr = item.pullRequest
                prs[pr.number] = pr
            }
        }
        info.pullRequests = prs.values.filter {
            $0.url.lowercased() == "https://github.com/\(repository)/pull/\($0.number)".lowercased()
        }.sorted { $0.number > $1.number }
        return info
    }
}

@MainActor
final class SessionGitHubCardModel: ObservableObject {
    @Published var info: SessionGitHubInfo?
    private(set) var selectedSession: String?
    private var generation = UUID()
    private let defaults: UserDefaults
    typealias Discovery = @Sendable (String, SessionGitHubInfo?, [String], Int) async -> SessionGitHubInfo?
    private let discovery: Discovery
    private var worker: Task<Void, Never>?
    private var pending: (session: String, paths: [String], texts: [String], token: UUID)?
    private var refreshIndex = 0
    init(defaults: UserDefaults = .standard, discovery: @escaping Discovery = { root, old, texts, index in
        await Task.detached(priority: .utility) {
            SessionGitHubDiscovery.refresh(path: root, previous: old, texts: texts, refreshIndex: index)
        }.value
    }) {
        self.defaults = defaults
        self.discovery = discovery
    }

    func load(session: String) {
        guard selectedSession != session else { return }
        selectedSession = session
        pending = nil
        generation = UUID()
        info = defaults.data(forKey: "sessionGitHub:\(session)").flatMap { try? JSONDecoder().decode(SessionGitHubInfo.self, from: $0) }
        if let cached = info {
            guard cached.root.hasPrefix("/"), SessionGitHubDiscovery.repository(from: "https://github.com/" + cached.repository) == cached.repository else { info = nil; return }
            info?.pullRequests = cached.pullRequests.filter { $0.url.lowercased() == "https://github.com/\(cached.repository)/pull/\($0.number)".lowercased() }
        }
    }

    func refresh(session: String, path: String?, texts: [String], paths: [String] = []) async {
        load(session: session)
        var seen = Set<String>()
        let candidates = ([path].compactMap { $0 } + paths + [info?.root].compactMap { $0 })
            .filter { seen.insert($0).inserted }
        guard !candidates.isEmpty else { return }
        let token = UUID()
        generation = token
        pending = (session, candidates, texts, token)
        if let worker { await worker.value; return }
        let task = Task { @MainActor in
            while let request = self.pending {
                self.pending = nil
                let old = self.selectedSession == request.session ? self.info : nil
                let index = self.refreshIndex
                self.refreshIndex += 1
                var updated: SessionGitHubInfo?
                // One bad/removed first folder must not hide a valid project.
                for root in request.paths.prefix(32) {
                    updated = await self.discovery(root, old, request.texts, index)
                    if updated != nil { break }
                    guard self.generation == request.token else { break }
                }
                guard self.selectedSession == request.session, self.generation == request.token else { continue }
                self.info = updated
                if let updated, let data = try? JSONEncoder().encode(updated) {
                    self.defaults.set(data, forKey: "sessionGitHub:\(request.session)")
                } else { self.defaults.removeObject(forKey: "sessionGitHub:\(request.session)") }
            }
            self.worker = nil
        }
        worker = task
        await task.value
    }

}

struct SessionGitHubCard: View {
    @ObservedObject var model: ChatModel
    @StateObject private var card = SessionGitHubCardModel()
    private var session: String { model.activeSessionId ?? "" }
    private var paths: [String] { SessionGitHubDiscovery.startingPaths(in: model.messages) }
    private var refreshKey: String {
        "\(session):\(paths.joined(separator: "|")):\(model.isRunning):\(model.messages.flatMap(\.blocks).filter { $0.kind == .terminalOutput || $0.kind == .finalAnswer }.count)"
    }
    var body: some View {
        Group {
            if !session.isEmpty, card.selectedSession == session, let info = card.info {
                GitHubRepositoryCard(info: info)
                    .padding(.trailing, 22).padding(.top, 10).padding(.bottom, 2)
            }
        }
        .onChange(of: session) { _, value in card.load(session: value) }
        .task(id: refreshKey) {
            guard !session.isEmpty else { card.load(session: ""); return }
            let texts = model.messages.flatMap { [$0.text] + $0.blocks.map(\.text) }
            repeat {
                await card.refresh(session: session, path: paths.first, texts: texts, paths: paths)
                guard model.isRunning, !Task.isCancelled else { break }
                try? await Task.sleep(for: .seconds(30))
            } while !Task.isCancelled
        }
    }
}

struct GitHubRepositoryCard: View {
    let info: SessionGitHubInfo
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 7) {
                Image(systemName: "point.3.connected.trianglepath.dotted")
                if let url = URL(string: "https://github.com/\(info.repository)") {
                    Link(info.repository, destination: url).lineLimit(1).truncationMode(.middle)
                }
                Spacer(minLength: 0)
                if !info.branch.isEmpty {
                    Text(info.branch).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                }
            }.font(.system(size: 11, weight: .medium))
            if let changed = info.changedFiles {
                Text(changed == 0 ? "Working tree clean" : "\(changed) working-tree changes")
                    .font(.system(size: 11)).foregroundStyle(.secondary)
            }
            if !info.pullRequests.isEmpty {
                ScrollView {
                    VStack(alignment: .leading, spacing: 7) {
                        ForEach(info.pullRequests) { pr in
                            if let url = URL(string: pr.url) {
                                Link(destination: url) {
                                    HStack(spacing: 6) {
                                        Image(systemName: pr.state == "MERGED" ? "arrow.triangle.merge" : "arrow.triangle.pull")
                                            .foregroundStyle(pr.state == "MERGED" ? Color.purple : pr.state == "OPEN" ? Color.green : Color.secondary)
                                        Text("#\(pr.number) \(pr.title)").lineLimit(1).truncationMode(.tail)
                                        Spacer(minLength: 0)
                                        Text(pr.isDraft ? "Draft" : pr.state.capitalized).foregroundStyle(.secondary)
                                    }.font(.system(size: 11))
                                }
                            }
                        }
                    }
                }.frame(height: CGFloat(min(info.pullRequests.count, 3)) * 22)
            } else {
                Text(info.pullRequestsLoaded ? "No linked pull requests" : "Pull requests unavailable")
                    .font(.system(size: 11)).foregroundStyle(.secondary)
            }
        }
        .padding(12).frame(maxWidth: 360)
        .background(.quaternary.opacity(0.35), in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(.secondary.opacity(0.15)))
    }
}
