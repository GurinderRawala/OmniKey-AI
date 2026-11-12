import AppKit
import Foundation

// MARK: - Injectable selection service

/// The subset of `APIClient` the chat composer uses to load and mutate its
/// task-instruction / model selections. Injected into `ChatModel` so tests
/// can drive (and reorder) the async callbacks deterministically without
/// touching the network or the live account.
protocol ChatSelectionService: AnyObject {
    func fetchTaskTemplates(completion: @escaping @Sendable (Result<[APIClient.TaskTemplateDTO], Error>) -> Void)
    func setDefaultTaskTemplate(id: String, completion: @escaping @Sendable (Result<APIClient.TaskTemplateDTO, Error>) -> Void)
    func clearDefaultTaskTemplate(completion: @escaping @Sendable (Result<Void, Error>) -> Void)
    func fetchAIProviders(completion: @escaping @Sendable (Result<APIClient.AIProviderListResponse, Error>) -> Void)
}

extension APIClient: ChatSelectionService {}

// MARK: - Turn request

/// Exactly what one chat turn sends for project/model selection. Built in
/// one place so the composer labels and the outgoing request cannot drift.
struct ChatTurnRequest: Equatable {
    let sessionId: String
    let userText: String
    /// `nil` lets the server keep the project already stored on the session.
    let groupName: String?
    /// `nil` lets the server use its configured model (settings not loaded).
    let model: String?
}

struct ChatTurnCallbacks {
    let onBlock: @MainActor @Sendable (ChatBlock) -> Void
    let onSteeringEvent: @MainActor @Sendable (SteeringServerEvent) -> Void
    let onFinal: @MainActor @Sendable (String) -> Void
    let onError: @MainActor @Sendable (Error) -> Void
}

typealias ChatTurnStarter = @MainActor (ChatTurnRequest, ChatTurnCallbacks) -> ChatSessionRunHandle

enum ChatTurnStarters {
    @MainActor static let live: ChatTurnStarter = { request, callbacks in
        ChatSessionRunner.shared.run(
            sessionId: request.sessionId,
            userText: request.userText,
            groupName: request.groupName,
            model: request.model,
            onBlock: callbacks.onBlock,
            onSteeringEvent: callbacks.onSteeringEvent,
            onFinal: callbacks.onFinal,
            onError: callbacks.onError
        )
    }
}

// MARK: - New-chat policy

/// What "New Chat" does to the pending (not yet persisted) chat's setup.
///
/// * An explicit project (sidebar group "+") always wins immediately.
/// * If the pending chat still holds an unsent draft, its project and model
///   choice are restored together with the draft text — the user is
///   resuming that chat, not starting over.
/// * Otherwise New Chat is a deliberate reset: no project, configured
///   default model. The task instruction is the account-wide default and is
///   kept from cache while it refreshes.
enum SessionSelectionPolicy {
    struct NewChatSetup: Equatable {
        let group: AgentGroupInfo?
        let keepsPendingModel: Bool
    }

    static func newChatSetup(
        explicitGroup: AgentGroupInfo?,
        pendingGroup: AgentGroupInfo?,
        pendingDraftText: String
    ) -> NewChatSetup {
        let resumesDraft = !pendingDraftText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        if let explicitGroup {
            return NewChatSetup(group: explicitGroup, keepsPendingModel: resumesDraft)
        }
        return resumesDraft
            ? NewChatSetup(group: pendingGroup, keepsPendingModel: true)
            : NewChatSetup(group: nil, keepsPendingModel: false)
    }
}

// MARK: - Display helpers

enum ModelDisplayName {
    /// Human label for a model id when the server did not supply one. Keeps
    /// the family *and* version ("claude-opus-4-7" → "Claude Opus 4.7")
    /// instead of collapsing every Claude model to a generic family word.
    static func label(for model: String) -> String {
        let id = model.trimmingCharacters(in: .whitespacesAndNewlines)
        if id.isEmpty { return "Model" }
        if id.hasPrefix("gpt-") { return "GPT " + id.dropFirst(4) }
        guard id.hasPrefix("claude-") || id.hasPrefix("gemini-") else { return id }
        func capitalized(_ word: String) -> String { word.prefix(1).uppercased() + word.dropFirst() }
        var words: [String] = []      // family words before the version
        var version: [String] = []    // "4","7" → "4.7"; "2.5" stays
        var trailing: [String] = []   // variant words / dated snapshots
        for part in id.split(separator: "-").map(String.init) {
            let isNumber = !part.isEmpty && part.allSatisfy(\.isNumber)
            let isDotted = part.first?.isNumber == true && part.contains(".")
            if trailing.isEmpty, (isNumber && part.count <= 2) || isDotted {
                version.append(part)
            } else if isNumber {
                trailing.append("(\(part))")
            } else if version.isEmpty, trailing.isEmpty {
                words.append(capitalized(part))
            } else {
                trailing.append(capitalized(part))
            }
        }
        return (words + [version.joined(separator: ".")] + trailing)
            .filter { !$0.isEmpty }
            .joined(separator: " ")
    }
}

enum TaskInstructionHelp {
    static let maxExcerpt = 600

    /// Hover/accessibility text for the task pill: the full heading plus an
    /// excerpt of the instructions when they are known.
    static func text(heading: String, instructions: String?, isLocked: Bool) -> String {
        var lines = ["Task instructions: \(heading)"]
        if let body = instructions?.trimmingCharacters(in: .whitespacesAndNewlines), !body.isEmpty {
            lines.append(body.count > maxExcerpt ? String(body.prefix(maxExcerpt)) + "…" : body)
        }
        lines.append(isLocked ? "Locked to this session." : "Applies when this chat starts.")
        return lines.joined(separator: "\n\n")
    }
}

// MARK: - Pill title fitting

enum PillTitle {
    static let fontSize: CGFloat = 11.5

    /// Middle-truncates `title` so it renders within `maxWidth` points.
    /// Needed because `Menu` labels with `.borderlessButton` are drawn by
    /// AppKit, which ignores SwiftUI frame caps on the label's `Text`.
    @MainActor static func fitted(_ title: String, maxWidth: CGFloat) -> String {
        let font = NSFont.systemFont(ofSize: fontSize, weight: .medium)
        func width(_ text: String) -> CGFloat {
            (text as NSString).size(withAttributes: [.font: font]).width
        }
        guard width(title) > maxWidth else { return title }
        let characters = Array(title)
        var low = 0, high = characters.count
        var best = "…"
        while low <= high {
            let keep = (low + high) / 2
            let head = characters.prefix((keep + 1) / 2)
            let tail = characters.suffix(keep / 2)
            let candidate = String(head).trimmingCharacters(in: .whitespaces) + "…"
                + String(tail).trimmingCharacters(in: .whitespaces)
            if width(candidate) <= maxWidth {
                best = candidate
                low = keep + 1
            } else {
                high = keep - 1
            }
        }
        return best
    }
}
