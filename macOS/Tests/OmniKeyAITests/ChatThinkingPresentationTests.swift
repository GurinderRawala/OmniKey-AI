import XCTest
@testable import OmniKeyAI

final class ChatThinkingPresentationTests: XCTestCase {
    func testSnapshotMetadataDoesNotHideThinkingBeforeFirstTool() {
        let metadata = ChatBlock(kind: .sessionDiff, text: "")
        XCTAssertTrue(ChatThinkingPresentation.isAwaitingTool(blocks: [], isStreaming: true))
        XCTAssertTrue(ChatThinkingPresentation.isAwaitingTool(blocks: [metadata], isStreaming: true))
        XCTAssertTrue(ChatThinkingPresentation.isAwaitingTool(blocks: [metadata, ChatBlock(kind: .agentReasoning, text: "Considering the request")], isStreaming: true))
    }

    func testIndicatorStopsForToolsFinalAnswersAndStoppedTurns() {
        for kind: ChatBlockKind in [.shellCommand, .terminalOutput, .webCall, .mcpCall, .toolCall, .imageRendering, .finalAnswer] {
            XCTAssertFalse(ChatThinkingPresentation.isAwaitingTool(blocks: [ChatBlock(kind: kind, text: "activity")], isStreaming: true))
        }
        XCTAssertFalse(ChatThinkingPresentation.isAwaitingTool(blocks: [], isStreaming: false))
    }
}
