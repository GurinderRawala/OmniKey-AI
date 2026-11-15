import AppKit
import SwiftUI
import XCTest
@testable import OmniKeyAI

final class LiveTurnDiffViewTests: XCTestCase {
    @MainActor
    func testLivePanelRendersWithPatchAndCoverage() throws {
        let baseline = GitTurnBaseline(root: "/Projects/Example", head: nil, capturedAt: "2026-11-14T12:00:00.000Z", source: .turnStart)
        let patch = "diff --git a/settings.swift b/settings.swift\n--- a/settings.swift\n+++ b/settings.swift\n@@ -1 +1 @@\n-let liveChanges = false\n+let liveChanges = true\n"
        let diff = LiveTurnDiff(turnID: "preview", revision: 2, status: "running", repositories: [
            GitDiffRepositoryPatch(root: baseline.root, patch: patch, baseline: baseline, head: nil),
        ], coverage: [
            TurnRootCoverage(root: baseline.root, status: "complete", reason: "Compared with the contents captured at the start of this run.", suggestedFix: ""),
            TurnRootCoverage(root: "/Projects/Notes", status: "partial", reason: "One file exceeded the capture size limit.", suggestedFix: "Narrow the workspace before the next turn."),
        ])
        let view = NSHostingView(rootView: LiveTurnDiffView(diff: diff, isRunning: true)
            .padding().frame(width: 620).background(Color(nsColor: .windowBackgroundColor)))
        view.frame = CGRect(x: 0, y: 0, width: 620, height: 500)
        view.layoutSubtreeIfNeeded()
        XCTAssertGreaterThan(view.fittingSize.height, 100)
        if let path = ProcessInfo.processInfo.environment["OMNIKEY_DIFF_PREVIEW"] {
            let bitmap = try XCTUnwrap(view.bitmapImageRepForCachingDisplay(in: view.bounds))
            view.cacheDisplay(in: view.bounds, to: bitmap)
            try XCTUnwrap(bitmap.representation(using: .png, properties: [:])).write(to: URL(fileURLWithPath: path))
        }
    }
}

extension LiveTurnDiffViewTests {
    @MainActor
    func testModelKeepsOneLiveCardAcrossSteeringAndRejectsStaleRevisions() throws {
        let suite = "LiveDiffModel.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let steeringID = LockedBox<String?>(nil)
        let socket = GitDiffTestSocket { message in
            if message.isSteering == true { steeringID.set(message.steeringID) }
        }
        let handle = ChatSessionRunHandle()
        handle.attach(task: socket)
        var callbacks: ChatTurnCallbacks?
        let chat = ChatModel(modelDefaults: defaults, authToken: { nil }, startTurn: { _, incoming in
            callbacks = incoming
            return handle
        })
        chat.inputText = "Start"
        chat.sendCurrentInput()
        let hooks = try XCTUnwrap(callbacks)
        func block(_ revision: Int) -> ChatBlock {
            ChatBlock(id: "live-diff:test", kind: .sessionDiff, text: "", liveDiff:
                LiveTurnDiff(turnID: "test", revision: revision, status: "running", repositories: [], coverage: []))
        }
        hooks.onBlock(block(1))
        let originalAssistant = try XCTUnwrap(chat.messages.last?.id)
        chat.inputText = "Also update the tests"
        chat.sendCurrentInput()
        hooks.onSteeringEvent(SteeringServerEvent(id: try XCTUnwrap(steeringID.get()), status: .applied, message: "Applied", pendingCount: 0))
        XCTAssertNotEqual(chat.messages.last?.id, originalAssistant)
        XCTAssertEqual(chat.messages.last?.blocks.last?.liveDiff?.revision, 1)
        hooks.onBlock(block(2))
        hooks.onBlock(block(1))
        XCTAssertEqual(chat.messages.flatMap(\.blocks).compactMap(\.liveDiff).count, 1)
        XCTAssertEqual(chat.messages.last?.blocks.last?.liveDiff?.revision, 2)
        hooks.onBlock(ChatBlock(kind: .sessionDiff, text: "", sessionDiff:
            SavedSessionDiff(id: "saved", fileCount: 1, repositoryCount: 1, createdAt: "now", filesystem: true)))
        XCTAssertTrue(chat.messages.flatMap(\.blocks).compactMap(\.liveDiff).isEmpty)
        chat.cancelCurrentTurn()
    }
}
