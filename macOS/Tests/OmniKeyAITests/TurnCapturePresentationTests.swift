import AppKit
import SwiftUI
import XCTest
@testable import OmniKeyAI

final class TurnCapturePresentationTests: XCTestCase {
    private let patch = "diff --git a/a.swift b/a.swift\n--- a/a.swift\n+++ b/a.swift\n@@ -1 +1,2 @@\n-old\n+new\n+added\n"

    private func root(_ path: String, _ status: String) -> TurnRootCoverage {
        TurnRootCoverage(root: path, status: status, reason: "Reason for \(status).", suggestedFix: status == "complete" ? "" : "Fix")
    }

    private func live(_ patches: [String], _ coverage: [TurnRootCoverage]) -> LiveTurnDiff {
        let baseline = GitTurnBaseline(root: "/Projects/App", head: nil, capturedAt: "now", source: .turnStart)
        return LiveTurnDiff(turnID: "turn", revision: 1, status: "final",
            repositories: patches.map { GitDiffRepositoryPatch(root: baseline.root, patch: $0, baseline: baseline, head: nil) },
            coverage: coverage)
    }

    private func saved(files: Int, _ coverage: [TurnRootCoverage]?, filesystem: Bool? = true) -> SavedSessionDiff {
        SavedSessionDiff(id: "s", fileCount: files, repositoryCount: 1, createdAt: "now", filesystem: filesystem, coverage: coverage)
    }

    /// Live and saved forms of the same capture must agree on every surface.
    private func assertAgree(_ coverage: [TurnRootCoverage], files: Int, file: StaticString = #filePath, line: UInt = #line) -> TurnCapturePresentation {
        let livePresentation = TurnCapturePresentation(live: live(files > 0 ? [patch] : [], coverage))
        let savedPresentation = TurnCapturePresentation(saved: { var d = saved(files: files, coverage); d.additions = files > 0 ? 2 : 0; d.deletions = files > 0 ? 1 : 0; return d }())
        XCTAssertEqual(livePresentation.state, savedPresentation.state, file: file, line: line)
        XCTAssertEqual(livePresentation.title, savedPresentation.title, file: file, line: line)
        XCTAssertEqual(livePresentation.emptySummary, savedPresentation.emptySummary, file: file, line: line)
        XCTAssertEqual(livePresentation.coverageQualifier, savedPresentation.coverageQualifier, file: file, line: line)
        XCTAssertEqual(livePresentation.inspectorNotice, savedPresentation.inspectorNotice, file: file, line: line)
        XCTAssertEqual(livePresentation.showsCard, savedPresentation.showsCard, file: file, line: line)
        if files == 0 { XCTAssertEqual(livePresentation.accessibilityLabel, savedPresentation.accessibilityLabel, file: file, line: line) }
        XCTAssertEqual(ChangesInspectorSource.preview(sessionID: "x", diff: live(files > 0 ? [patch] : [], coverage)).presentation.state, livePresentation.state, file: file, line: line)
        XCTAssertEqual(ChangesInspectorSource.saved(SessionDiffSelection(sessionId: "x", diff: saved(files: files, coverage))).presentation.state, savedPresentation.state, file: file, line: line)
        return savedPresentation
    }

    func testCompleteEmptyClaimsNoChangesOnlyInCapturedFolders() {
        let p = assertAgree([root("/a", "complete")], files: 0)
        XCTAssertEqual(p.state, .noChangesDetected)
        XCTAssertEqual(p.emptySummary, "No changes detected in captured folders")
        XCTAssertNil(p.inspectorNotice)
        XCTAssertFalse(p.showsCard, "complete-empty turns stay quiet")
        XCTAssertEqual(p.title, "Turn changes")
    }

    func testPartialEmptyIsNotUnavailableAndNotNoChanges() {
        let p = assertAgree([root("/a", "partial")], files: 0)
        XCTAssertEqual(p.state, .noChangesIncomplete)
        XCTAssertEqual(p.emptySummary, "No changes captured · incomplete coverage")
        XCTAssertTrue(p.showsCard)
        XCTAssertEqual(p.accessibilityLabel, "Turn changes, No changes captured, incomplete coverage")
        XCTAssertEqual(p.inspectorNotice, "1 of 1 folder was only partly compared; some changes may be missing.")
        // Source-compatible legacy flag keeps its old meaning; presentation must not reuse it.
        XCTAssertTrue(saved(files: 0, [root("/a", "partial")]).captureUnavailable)
        XCTAssertNotEqual(p.emptySummary, "Capture unavailable")
    }

    func testPartialWithPatchShowsCountsAndQualifier() {
        let p = assertAgree([root("/a", "partial")], files: 1)
        XCTAssertEqual(p.state, .changes(.incomplete))
        XCTAssertNil(p.emptySummary)
        XCTAssertEqual(p.coverageQualifier, "incomplete coverage")
        XCTAssertEqual(p.accessibilityLabel, "Turn changes, 1 file, 2 lines added, 1 line removed, incomplete coverage")
        XCTAssertNotNil(p.inspectorNotice)
    }

    func testLateEmptyNamesTimingAndNeverClaimsCompleteNoChanges() {
        let p = assertAgree([root("/a", "late")], files: 0)
        XCTAssertEqual(p.state, .noChangesLate)
        XCTAssertEqual(p.emptySummary, "No changes captured · late baseline or checkpoint")
        XCTAssertFalse(p.emptySummary?.contains("No changes detected") ?? true)
        XCTAssertTrue(p.showsCard)
        XCTAssertTrue(p.inspectorNotice?.contains("after the turn started") == true)
        let withPatch = assertAgree([root("/a", "late"), root("/b", "complete")], files: 1)
        XCTAssertEqual(withPatch.state, .changes(.late))
        XCTAssertEqual(withPatch.coverageQualifier, "late baseline or checkpoint")
    }

    func testTrueUnavailable() {
        for coverage: [TurnRootCoverage] in [[root("/a", "unavailable")], [root("/a", "unavailable"), root("/b", "unavailable")], []] {
            let p = assertAgree(coverage, files: 0)
            XCTAssertEqual(p.state, .unavailable)
            XCTAssertEqual(p.emptySummary, "Capture unavailable")
            XCTAssertTrue(p.showsCard)
            XCTAssertEqual(p.accessibilityLabel, "Turn changes, Capture unavailable")
        }
        XCTAssertEqual(TurnCapturePresentation(saved: saved(files: 0, [root("/a", "unavailable")])).inspectorNotice, "Capture unavailable for every folder.")
    }

    func testMixedCoverageDoesNotImplyEverythingUnavailable() {
        let p = assertAgree([root("/a", "complete"), root("/b", "unavailable"), root("/c", "late")], files: 0)
        XCTAssertEqual(p.state, .noChangesIncomplete)
        XCTAssertNotEqual(p.emptySummary, "Capture unavailable")
        let notice = p.inspectorNotice
        XCTAssertTrue(notice?.contains("1 of 3 folders could not be captured.") == true)
        XCTAssertTrue(notice?.contains("1 folder uses a baseline") == true)
        XCTAssertFalse(notice?.contains("every folder") == true)
        let withPatch = assertAgree([root("/a", "complete"), root("/b", "unavailable")], files: 1)
        XCTAssertEqual(withPatch.state, .changes(.incomplete))
        // Unknown future statuses are never treated as complete.
        XCTAssertEqual(assertAgree([root("/a", "complete"), root("/b", "future")], files: 0).state, .noChangesIncomplete)
    }

    func testMissingCoverage() {
        let empty = TurnCapturePresentation(saved: saved(files: 0, nil))
        XCTAssertEqual(empty.state, .unavailable)
        XCTAssertTrue(empty.showsCard)
        let changed = TurnCapturePresentation(saved: { var d = saved(files: 3, nil); d.additions = 5; return d }())
        XCTAssertEqual(changed.state, .changes(.unreported))
        XCTAssertEqual(changed.coverageQualifier, "coverage not reported")
        XCTAssertEqual(changed.inspectorNotice, "Coverage was not reported for this capture.")
    }

    func testCompleteWithPatchHasNoQualifierOrNotice() {
        let p = assertAgree([root("/a", "complete")], files: 1)
        XCTAssertEqual(p.state, .changes(.complete))
        XCTAssertNil(p.coverageQualifier)
        XCTAssertNil(p.inspectorNotice)
        XCTAssertTrue(p.help.contains("A pull request may include earlier turns."))
        XCTAssertFalse(p.help.lowercased().contains("made by the agent"))
    }

    func testNonFilesystemKeepsLegacySemantics() {
        let workingTree = SavedSessionDiff(id: "w", fileCount: 2, repositoryCount: 1, createdAt: "now")
        let p = TurnCapturePresentation(saved: workingTree)
        XCTAssertEqual(p.state, .legacy)
        XCTAssertEqual(p.title, workingTree.headerTitle)
        XCTAssertEqual(p.help, workingTree.helpText)
        XCTAssertNil(p.emptySummary)
        XCTAssertNil(p.coverageQualifier)
        XCTAssertNil(p.inspectorNotice)
        XCTAssertTrue(p.showsCard)
        XCTAssertFalse(TurnCapturePresentation(saved: SavedSessionDiff(id: "e", fileCount: 0, repositoryCount: 1, createdAt: "now")).showsCard)
        let ai = SavedSessionDiff(id: "ai", fileCount: 1, repositoryCount: 1, createdAt: "now", recovered: true, recoveryMethod: "ai_reconstructed")
        XCTAssertEqual(TurnCapturePresentation(saved: ai).title, "AI-generated turn changes")
        // A legacy snapshot with coverage still never borrows filesystem wording.
        XCTAssertEqual(TurnCapturePresentation(saved: saved(files: 0, [root("/a", "partial")], filesystem: nil)).state, .legacy)
    }

    func testPlacementUsesCoverageAwareEligibility() {
        let blocks = [
            saved(files: 0, [root("/a", "complete")]),
            SavedSessionDiff(id: "partial", fileCount: 0, repositoryCount: 1, createdAt: "now", filesystem: true, coverage: [root("/a", "partial")]),
            SavedSessionDiff(id: "late", fileCount: 0, repositoryCount: 1, createdAt: "now", filesystem: true, coverage: [root("/a", "late")]),
            SavedSessionDiff(id: "legacy-empty", fileCount: 0, repositoryCount: 1, createdAt: "now"),
        ].map { ChatBlock(kind: .sessionDiff, text: "", sessionDiff: $0) } + [ChatBlock(kind: .finalAnswer, text: "Done")]
        XCTAssertEqual(ChatSessionDiffPlacement.cards(beforeFinalIn: blocks).compactMap { $0.sessionDiff?.id }, ["partial", "late"])
    }

    @MainActor
    func testHeaderAndCardRenderEveryStateWithoutOverflow() {
        let states: [[TurnRootCoverage]] = [[root("/a", "complete")], [root("/a", "partial")], [root("/a", "late")], [root("/a", "unavailable")], [root("/a", "complete"), root("/b", "unavailable")]]
        for coverage in states {
            for files in [0, 1] {
                let presentation = TurnCapturePresentation(live: live(files > 0 ? [patch] : [], coverage))
                let host = NSHostingView(rootView: VStack {
                    ChangesDrawerHeader(files: presentation.files, additions: presentation.additions, deletions: presentation.deletions, isUpdating: false,
                        layout: .constant(.unified), filter: .constant(""), expand: {}, collapse: {}, close: {}, presentation: presentation)
                    TurnChangesCard(files: presentation.files, additions: presentation.additions, deletions: presentation.deletions, selected: false, presentation: presentation) {}
                }.frame(width: 360))
                host.frame = NSRect(x: 0, y: 0, width: 360, height: 400)
                host.layoutSubtreeIfNeeded()
                XCTAssertLessThanOrEqual(host.fittingSize.width, 361)
                XCTAssertGreaterThan(host.fittingSize.height, 70)
            }
        }
        // Legacy callers keep compiling and only the explicit flag means unavailable.
        _ = TurnChangesCard(files: 0, additions: nil, deletions: nil, selected: false, captureUnavailable: true) {}
        _ = ChangesDrawerHeader(files: 1, additions: 1, deletions: 0, isUpdating: true, layout: .constant(.split), filter: .constant(""), expand: {}, collapse: {}, close: {})
    }
}
