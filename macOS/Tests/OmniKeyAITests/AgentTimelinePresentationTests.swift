import XCTest

@testable import OmniKeyAI

final class AgentTimelinePresentationTests: XCTestCase {
    func testChatWindowUsesTwentyPercentLargerTargetAndFitsSmallerScreens() {
        XCTAssertEqual(ChatLayoutMetrics.sidebarExpandedWidth, 264)
        XCTAssertEqual(ChatWindowSizing.preferredContentSize.width, 1_320)
        XCTAssertEqual(ChatWindowSizing.preferredContentSize.height, 888)
        XCTAssertEqual(
            ChatWindowSizing.initialContentSize(visibleSize: NSSize(width: 1_920, height: 1_080)),
            NSSize(width: 1_320, height: 888)
        )
        XCTAssertEqual(
            ChatWindowSizing.initialContentSize(visibleSize: NSSize(width: 1_200, height: 700)),
            NSSize(width: 1_128, height: 644)
        )
    }

    func testSessionInfoKeepsOnlyUsefulResponsiveMetadata() {
        let session = AgentSessionInfo(
            id: "session",
            title: "Responsive chat",
            isPinned: false,
            platform: "macos",
            turns: 2,
            totalTokensUsed: 250,
            remainingContextTokens: 750,
            contextBudget: 1_000,
            groupName: "OmniKey",
            groupDescription: nil,
            taskInstructionId: nil,
            taskInstructionHeading: nil,
            lastActiveAt: "2026-09-19T00:00:00Z"
        )
        let presentation = ChatSessionInfoPresentation(
            session: session,
            visibleTurnCount: 3,
            projectName: "OmniKey"
        )

        XCTAssertEqual(presentation.project, "OmniKey")
        XCTAssertEqual(presentation.turns, "3 turns")
    }

    func testCompletedMilestoneRemainsVisibleAndClosesTheActivitiesThatProducedItsOutcome() {
        let now = Date()
        let blocks = [
            ChatBlock(kind: .shellCommand, text: "rg --files", createdAt: now),
            ChatBlock(
                kind: .terminalOutput, text: "[terminal success]\nSources/ChatView.swift",
                createdAt: now.addingTimeInterval(1)),
            ChatBlock(
                kind: .agentReasoning,
                text: "Found the relevant files. The timeline can now be updated safely.",
                createdAt: now.addingTimeInterval(2)),
        ]

        let presentation = AgentTimelinePresentation.build(from: blocks, isStreaming: false)

        XCTAssertEqual(presentation.steps.count, 1)
        XCTAssertEqual(
            presentation.steps[0].outcome,
            "Found the relevant files. The timeline can now be updated safely.")
        XCTAssertEqual(presentation.steps[0].title, "Found the relevant files")
        XCTAssertEqual(presentation.steps[0].status, .completed)
        XCTAssertEqual(presentation.steps[0].semanticOutcome, .usefulResult)
        XCTAssertEqual(presentation.steps[0].referencedFiles, ["Sources/ChatView.swift"])
        XCTAssertTrue(presentation.steps[0].modifiedFiles.isEmpty)
        XCTAssertTrue(presentation.steps[0].evidence.contains("1 referenced"))
        XCTAssertEqual(presentation.steps[0].activities.count, 1)
        XCTAssertEqual(presentation.steps[0].activities[0].blocks.count, 2)
        XCTAssertEqual(presentation.steps[0].activities[0].status, .completed)
        XCTAssertEqual(
            AgentTimelinePresentation.compactActivityTitle(for: presentation.steps[0].activities),
            "1 script run"
        )
    }

    func testLiveCommandAndFailedOutputStatuses() {
        let command = ChatBlock(kind: .shellCommand, text: "swift test")
        let live = AgentTimelinePresentation.build(from: [command], isStreaming: true)
        XCTAssertEqual(live.steps[0].activities[0].status, .running)

        let failed = AgentTimelinePresentation.build(
            from: [
                command,
                ChatBlock(kind: .terminalOutput, text: "[terminal error (exit code: 1)]\nTest failed"),
            ],
            isStreaming: false
        )
        XCTAssertEqual(failed.steps[0].activities[0].status, .failed)
        XCTAssertEqual(
            AgentTimelinePresentation.aggregateStatus(for: failed.steps[0].activities),
            .failed
        )
    }

    func testAggregateStatusOnlyReflectsTheMostRecentToolCall() {
        let failed = AgentCommandActivity(
            id: "failed",
            blocks: [
                ChatBlock(
                    kind: .toolCall,
                    text: "Error: initial tool failed",
                    activityId: "failed",
                    activityPhase: .failed
                )
            ],
            status: .failed
        )
        let recovered = AgentCommandActivity(
            id: "recovered",
            blocks: [
                ChatBlock(
                    kind: .toolCall,
                    text: "Recovery tool completed",
                    activityId: "recovered",
                    activityPhase: .completed
                )
            ],
            status: .completed
        )

        XCTAssertEqual(
            AgentTimelinePresentation.aggregateStatus(for: [failed, recovered]),
            .completed
        )
        XCTAssertEqual(
            AgentTimelinePresentation.aggregateStatus(for: [recovered, failed]),
            .failed
        )
    }

    func testCompletionDisclosureClearsEarlierFailureAfterLatestToolSucceeds() {
        let presentation = AgentTimelinePresentation.build(
            from: [
                ChatBlock(
                    kind: .toolCall,
                    text: "Error: first attempt failed",
                    activityId: "first",
                    activityPhase: .failed
                ),
                ChatBlock(
                    kind: .agentReasoning,
                    text: "The first approach failed, so I am trying a fallback."
                ),
                ChatBlock(
                    kind: .toolCall,
                    text: "Fallback completed",
                    activityId: "fallback",
                    activityPhase: .completed
                ),
                ChatBlock(
                    kind: .agentReasoning,
                    text: "The fallback completed successfully."
                ),
            ],
            isStreaming: false
        )

        let recap = presentation.completionRecap(durationLabel: "Worked for 5s")
        XCTAssertEqual(recap.outcome, .succeeded)
        XCTAssertEqual(recap.title, "Worked for 5s")
        XCTAssertEqual(recap.systemImage, "checkmark.circle.fill")
    }

    func testCompletionDisclosurePreservesWarningFromTheLatestCompletedTool() {
        let presentation = AgentTimelinePresentation.build(
            from: [
                ChatBlock(
                    kind: .webCall,
                    text: "Search completed",
                    activityId: "search",
                    activityPhase: .completed
                ),
                ChatBlock(
                    kind: .agentReasoning,
                    text: "The search completed but found no results."
                ),
            ],
            isStreaming: false
        )

        let recap = presentation.completionRecap(durationLabel: "Worked for 3s")
        XCTAssertEqual(recap.outcome, .warning)
        XCTAssertTrue(recap.title.contains("Completed with warnings"))
    }

    func testConcurrentActivitiesPairByStableIdentityInsteadOfArrivalOrder() {
        let blocks = [
            ChatBlock(
                kind: .webCall,
                text: "Searching the web for A",
                activityId: "a",
                activityPhase: .started
            ),
            ChatBlock(
                kind: .webCall,
                text: "Searching the web for B",
                activityId: "b",
                activityPhase: .started
            ),
            ChatBlock(
                kind: .webCall,
                text: "Tool: web_search\n\nResult B",
                activityId: "b",
                activityPhase: .completed
            ),
            ChatBlock(
                kind: .webCall,
                text: "Tool: web_search\n\nResult A",
                activityId: "a",
                activityPhase: .completed
            ),
        ]

        let presentation = AgentTimelinePresentation.build(from: blocks, isStreaming: true)

        XCTAssertEqual(presentation.steps[0].activities.count, 2)
        XCTAssertEqual(presentation.steps[0].activities[0].blocks.count, 2)
        XCTAssertEqual(presentation.steps[0].activities[1].blocks.count, 2)
        XCTAssertEqual(presentation.steps[0].activities.map(\.status), [.completed, .completed])
        XCTAssertEqual(
            AgentTimelinePresentation.compactActivityTitle(for: presentation.steps[0].activities),
            "2 web searches"
        )
    }

    func testProgressSummaryIsSingleParagraphRedactedAndWordLimited() {
        let repeated = Array(repeating: "observable", count: 275).joined(separator: " ")
        let summary = AgentTimelineSummarizer.progressSummary(
            "# Update\nI inspected the files. api_key=top-secret\n\(repeated)"
        )

        XCTAssertFalse(summary.contains("\n"))
        XCTAssertFalse(summary.contains("top-secret"))
        XCTAssertTrue(summary.contains("[REDACTED]"))
        XCTAssertLessThanOrEqual(summary.split(whereSeparator: { $0.isWhitespace }).count, 150)
        XCTAssertTrue(summary.hasSuffix("…"))
    }

    func testCompleteProgressSummaryIsShownWithoutDuplicateDetail() {
        let longSummary = Array(repeating: "observable", count: 90).joined(separator: " ")
        let presentation = AgentTimelinePresentation.build(
            from: [ChatBlock(kind: .agentReasoning, text: longSummary)],
            isStreaming: false
        )

        let step = presentation.steps[0]
        XCTAssertEqual(step.outcome, longSummary)
        XCTAssertNil(step.detail)
    }

    func testActivityCountsRemainConciseForRepetitiveScripts() {
        let blocks = (0..<14).flatMap { index in
            [
                ChatBlock(kind: .shellCommand, text: "echo \(index)"),
                ChatBlock(kind: .terminalOutput, text: "[terminal success]\n\(index)"),
            ]
        }
        let presentation = AgentTimelinePresentation.build(from: blocks, isStreaming: false)

        XCTAssertEqual(
            AgentTimelinePresentation.compactActivityTitle(for: presentation.steps[0].activities),
            "14 scripts run"
        )
        XCTAssertNil(presentation.steps[0].outcome)
    }

    func testSummaryOnlyAndActivityOnlyTurnsRemainRepresentable() {
        let summaryOnly = AgentTimelinePresentation.build(
            from: [ChatBlock(kind: .agentReasoning, text: "Validated the timeline. All checks pass.")],
            isStreaming: false
        )
        XCTAssertEqual(summaryOnly.steps.count, 1)
        XCTAssertEqual(summaryOnly.steps[0].title, "Validated the timeline")
        XCTAssertTrue(summaryOnly.steps[0].activities.isEmpty)
        XCTAssertEqual(summaryOnly.steps[0].status, .completed)

        let activityOnly = AgentTimelinePresentation.build(
            from: [
                ChatBlock(
                    kind: .webCall,
                    text: "Tool: web_search\n\nUseful result",
                    activityId: "search-1",
                    activityPhase: .completed
                )
            ],
            isStreaming: false
        )
        XCTAssertEqual(activityOnly.steps.count, 1)
        XCTAssertNil(activityOnly.steps[0].outcome)
        XCTAssertEqual(activityOnly.steps[0].activities.count, 1)
        XCTAssertEqual(activityOnly.steps[0].status, .completed)
    }

    func testMixedRunningAndFailedOperationsSeparateExecutionFromOutcome() {
        let presentation = AgentTimelinePresentation.build(
            from: [
                ChatBlock(
                    kind: .webCall,
                    text: "Tool: web_search\n\nError: request failed",
                    activityId: "failed",
                    activityPhase: .failed
                ),
                ChatBlock(
                    kind: .shellCommand,
                    text: "swift test",
                    activityId: "running",
                    activityPhase: .started
                ),
            ],
            isStreaming: true
        )

        XCTAssertEqual(presentation.steps[0].status, .running)
        XCTAssertEqual(presentation.steps[0].semanticOutcome, .warning)
        XCTAssertEqual(presentation.steps[0].activities.map(\.status), [.failed, .running])
    }

    func testRecoveredFailuresDoNotRequireUserAction() {
        let scenarios = [
            "The documentation was retrieved successfully using the open Chrome tab.",
            "The retry completed successfully after the first request failed.",
            "The optional lookup failed, but the main task completed successfully.",
        ]

        for summary in scenarios {
            let presentation = AgentTimelinePresentation.build(
                from: [
                    ChatBlock(
                        kind: .webCall,
                        text: "Error: initial lookup failed",
                        activityId: "failed",
                        activityPhase: .failed
                    ),
                    ChatBlock(
                        kind: .webCall,
                        text: "Fallback result",
                        activityId: "fallback",
                        activityPhase: .completed
                    ),
                    ChatBlock(kind: .agentReasoning, text: summary),
                ],
                isStreaming: false
            )

            XCTAssertEqual(presentation.steps[0].semanticOutcome, .recovered, summary)
        }
    }

    func testBlockedFailureRequiresAction() {
        let presentation = AgentTimelinePresentation.build(
            from: [
                ChatBlock(
                    kind: .mcpCall,
                    text: "Error: authentication failed",
                    activityId: "auth",
                    activityPhase: .failed
                ),
                ChatBlock(
                    kind: .agentReasoning,
                    text: "Credentials are required and I cannot continue without your input."
                ),
            ],
            isStreaming: false
        )

        XCTAssertEqual(presentation.steps[0].semanticOutcome, .actionRequired)
    }

    func testResolvedWarningAndMissingLanguageRemainSuccessful() {
        let summaries = [
            "No remaining issues were found.",
            "The security risk has been removed.",
            "All warnings were resolved.",
            "The build now completes without warnings.",
            "The previously missing file was found using the fallback path.",
            "The fallback succeeded after the first source was not found.",
        ]

        for summary in summaries {
            let presentation = AgentTimelinePresentation.build(
                from: [ChatBlock(kind: .agentReasoning, text: summary)],
                isStreaming: false
            )
            XCTAssertEqual(presentation.steps[0].semanticOutcome, .usefulResult, summary)
        }
    }

    func testReferencedAndModifiedFilesAreKeptDistinct() {
        let inspected = AgentTimelinePresentation.build(
            from: [
                ChatBlock(kind: .shellCommand, text: "sed -n '1,80p' Sources/ChatView.swift"),
                ChatBlock(
                    kind: .terminalOutput,
                    text: "Sources/App.swift:20: warning\nnode_modules/pkg/index.js\nhttps://example.com/file.js"
                ),
                ChatBlock(kind: .agentReasoning, text: "Inspected the relevant source files."),
            ],
            isStreaming: false
        )
        XCTAssertEqual(
            inspected.steps[0].referencedFiles,
            ["Sources/ChatView.swift", "Sources/App.swift"]
        )
        XCTAssertTrue(inspected.steps[0].modifiedFiles.isEmpty)

        let edited = AgentTimelinePresentation.build(
            from: [
                ChatBlock(
                    kind: .toolCall,
                    text: "Tool: edit_file\n\nInput:\n{\"path\":\"Sources/App.swift\"}",
                    activityId: "edit",
                    activityPhase: .completed
                ),
                ChatBlock(kind: .agentReasoning, text: "Updated the application source."),
            ],
            isStreaming: false
        )
        XCTAssertEqual(edited.steps[0].modifiedFiles, ["Sources/App.swift"])
        XCTAssertFalse(edited.steps[0].referencedFiles.contains("Sources/App.swift"))

        let gitConfirmed = AgentTimelinePresentation.build(
            from: [
                ChatBlock(kind: .shellCommand, text: "git diff --name-only"),
                ChatBlock(kind: .terminalOutput, text: "README.md\nSources/Model.swift"),
                ChatBlock(kind: .agentReasoning, text: "Confirmed the changed files."),
            ],
            isStreaming: false
        )
        XCTAssertEqual(gitConfirmed.steps[0].modifiedFiles, ["README.md", "Sources/Model.swift"])
    }

    func testFailedEditsAndVersionControlChecksDoNotClaimFilesWereModified() {
        let scenarios: [[ChatBlock]] = [
            [
                ChatBlock(
                    kind: .toolCall,
                    text: "Tool: edit_file\n\nInput:\n{\"path\":\"Sources/Edit.swift\"}",
                    activityId: "edit",
                    activityPhase: .failed
                )
            ],
            [
                ChatBlock(
                    kind: .toolCall,
                    text: "Tool: write_file\n\nInput:\n{\"path\":\"Sources/Write.swift\"}",
                    activityId: "write",
                    activityPhase: .failed
                )
            ],
            [
                ChatBlock(
                    kind: .shellCommand,
                    text: "apply_patch <<'PATCH'\n*** Update File: Sources/Patch.swift",
                    activityId: "patch",
                    activityPhase: .failed
                )
            ],
            [
                ChatBlock(
                    kind: .shellCommand,
                    text: "git status --short",
                    activityId: "git",
                    activityPhase: .started
                ),
                ChatBlock(
                    kind: .terminalOutput,
                    text: "M Sources/NotConfirmed.swift",
                    activityId: "git",
                    activityPhase: .failed
                ),
            ],
        ]

        for blocks in scenarios {
            let presentation = AgentTimelinePresentation.build(from: blocks, isStreaming: false)
            XCTAssertTrue(presentation.steps[0].modifiedFiles.isEmpty)
        }
    }

    func testEditOutputPathsAreReferencesNotModifiedFiles() {
        let presentation = AgentTimelinePresentation.build(
            from: [
                ChatBlock(
                    kind: .toolCall,
                    text: "Tool: edit_file\n\nInput:\n{\"path\":\"Sources/App.swift\"}",
                    activityId: "edit",
                    activityPhase: .started
                ),
                ChatBlock(
                    kind: .toolCall,
                    text: "Updated Sources/App.swift. Tests/AppTests.swift still fails. See README.md.",
                    activityId: "edit",
                    activityPhase: .completed
                ),
            ],
            isStreaming: false
        )

        XCTAssertEqual(presentation.steps[0].modifiedFiles, ["Sources/App.swift"])
        XCTAssertEqual(presentation.steps[0].referencedFiles, ["Tests/AppTests.swift", "README.md"])
    }

    @MainActor
    func testGenericWireErrorBecomesFailedToolActivity() throws {
        let data = Data(
            #"{"session_id":"session","sender":"agent","content":"Tool: missing_tool\n\nError: not enabled","is_error":true,"activity_id":"call-missing","activity_phase":"failed"}"#.utf8
        )
        let message = try JSONDecoder().decode(ChatSessionRunner.AgentMessage.self, from: data)
        let block = ChatSessionRunner.genericErrorBlock(from: message)
        let presentation = AgentTimelinePresentation.build(from: [block], isStreaming: false)

        XCTAssertEqual(block.kind, .toolCall)
        XCTAssertEqual(block.activityId, "call-missing")
        XCTAssertEqual(block.activityPhase, .failed)
        XCTAssertEqual(presentation.steps[0].activities[0].status, .failed)
        XCTAssertEqual(presentation.runOutcome, .failed)
    }

    @MainActor
    func testFinalWireErrorTerminatesAsDurableErrorAnswer() throws {
        let data = Data(
            #"{"session_id":"session","sender":"agent","content":"<final_answer>Provider unavailable</final_answer>","is_error":true}"#.utf8
        )
        let message = try JSONDecoder().decode(ChatSessionRunner.AgentMessage.self, from: data)

        XCTAssertEqual(
            ChatSessionRunner.finalAnswerDisplayText(from: message),
            "**Error:** Provider unavailable"
        )
    }

    func testSteeringWireEventsPreserveCorrelationAndDoNotCreateRejectedLoaders() throws {
        let receivedData = Data(
            #"{"session_id":"session","sender":"agent","content":"Queued","is_steering":true,"steering_id":"steer-b","steering_status":"received","steering_pending_count":2}"#.utf8
        )
        let rejectedData = Data(
            #"{"session_id":"session","sender":"agent","content":"Queue full","is_error":true,"is_steering":true,"steering_id":"steer-a","steering_status":"rejected"}"#.utf8
        )
        let received = try JSONDecoder().decode(ChatSessionRunner.AgentMessage.self, from: receivedData)
        let rejected = try JSONDecoder().decode(ChatSessionRunner.AgentMessage.self, from: rejectedData)

        XCTAssertEqual(received.steeringID, "steer-b")
        XCTAssertEqual(received.steeringStatus, .received)
        XCTAssertEqual(received.steeringPendingCount, 2)
        XCTAssertEqual(rejected.steeringID, "steer-a")
        XCTAssertEqual(rejected.steeringStatus, .rejected)
        XCTAssertTrue(SteeringContinuationPolicy.shouldCreateContinuation(for: .received))
        XCTAssertFalse(SteeringContinuationPolicy.shouldCreateContinuation(for: .rejected))
        XCTAssertFalse(SteeringContinuationPolicy.shouldCreateContinuation(for: .applied))
    }

    func testLegacySteeringAcknowledgementTargetsTheOldestPendingUpdate() throws {
        let legacyData = Data(
            #"{"session_id":"session","sender":"agent","content":"Steering queued","is_steering":true}"#.utf8
        )
        let legacyErrorData = Data(
            #"{"session_id":"session","sender":"agent","content":"Steering rejected","is_error":true,"is_steering":true}"#.utf8
        )
        let legacyMessage = try JSONDecoder().decode(
            ChatSessionRunner.AgentMessage.self,
            from: legacyData
        )
        let legacyErrorMessage = try JSONDecoder().decode(
            ChatSessionRunner.AgentMessage.self,
            from: legacyErrorData
        )
        let acknowledgement = try XCTUnwrap(ChatSessionRunner.steeringEvent(from: legacyMessage))
        let rejection = try XCTUnwrap(ChatSessionRunner.steeringEvent(from: legacyErrorMessage))
        let first = PendingSteeringContext(
            messageID: "message-first",
            text: "first",
            redirectKey: "assistant",
            continuationMessageID: nil
        )
        let second = PendingSteeringContext(
            messageID: "message-second",
            text: "second",
            redirectKey: "assistant",
            continuationMessageID: nil
        )

        XCTAssertNil(acknowledgement.id)
        XCTAssertEqual(acknowledgement.status, .received)
        XCTAssertTrue(acknowledgement.isLegacyAcknowledgement)
        XCTAssertEqual(rejection.status, .rejected)
        XCTAssertEqual(
            SteeringEventResolver.targetID(
                correlatedID: acknowledgement.id,
                pending: ["steer-second": second, "steer-first": first],
                messageIDsInDisplayOrder: ["message-first", "message-second"]
            ),
            "steer-first"
        )
        XCTAssertEqual(
            SteeringEventResolver.targetID(
                correlatedID: "steer-second",
                pending: ["steer-second": second, "steer-first": first],
                messageIDsInDisplayOrder: ["message-first", "message-second"]
            ),
            "steer-second"
        )
    }

    func testSteeringIDWithoutStatusRemainsCorrelated() throws {
        let data = Data(
            #"{"session_id":"session","sender":"agent","content":"Queued","is_steering":true,"steering_id":"steer-b"}"#.utf8
        )
        let message = try JSONDecoder().decode(ChatSessionRunner.AgentMessage.self, from: data)
        let event = try XCTUnwrap(ChatSessionRunner.steeringEvent(from: message))

        XCTAssertEqual(event.id, "steer-b")
        XCTAssertEqual(event.status, .received)
        XCTAssertFalse(event.isLegacyAcknowledgement)
    }

    func testHistoryTopLoaderAutomaticallyLoadsOnlyWithoutAnErrorOrRequestInFlight() {
        XCTAssertTrue(ChatHistoryTopLoadPolicy.shouldLoad(isLoading: false, error: nil))
        XCTAssertFalse(ChatHistoryTopLoadPolicy.shouldLoad(isLoading: true, error: nil))
        XCTAssertFalse(
            ChatHistoryTopLoadPolicy.shouldLoad(isLoading: false, error: "Network error")
        )
    }

    func testCancellationLifecycleTargetsActiveActivityOrCreatesTurnEvent() {
        let active = ChatBlock(
            kind: .webCall,
            text: "Searching",
            activityId: "search",
            activityPhase: .started
        )
        let cancelled = ChatCancellationLifecycle.block(for: [active])
        XCTAssertEqual(cancelled.kind, .webCall)
        XCTAssertEqual(cancelled.activityId, "search")
        XCTAssertEqual(cancelled.activityPhase, .cancelled)

        let turnCancellation = ChatCancellationLifecycle.block(for: [])
        XCTAssertEqual(turnCancellation.kind, .toolCall)
        XCTAssertEqual(turnCancellation.activityPhase, .cancelled)
        XCTAssertTrue(turnCancellation.activityId?.hasPrefix("turn-cancelled-") == true)
    }

    func testCompletionRecapReflectsEveryAggregateOutcome() {
        func recap(_ blocks: [ChatBlock]) -> AgentCompletionRecap {
            AgentTimelinePresentation.build(from: blocks, isStreaming: false)
                .completionRecap(durationLabel: "Worked for 12s")
        }

        let success = recap([ChatBlock(kind: .agentReasoning, text: "Validated the result.")])
        XCTAssertEqual(success.outcome, .succeeded)
        XCTAssertEqual(success.title, "Worked for 12s")
        XCTAssertEqual(success.systemImage, "checkmark.circle.fill")

        let recovered = recap([
            ChatBlock(kind: .webCall, text: "Error", activityId: "a", activityPhase: .failed),
            ChatBlock(kind: .webCall, text: "Result", activityId: "b", activityPhase: .completed),
            ChatBlock(kind: .agentReasoning, text: "The fallback succeeded and the work completed successfully."),
        ])
        XCTAssertEqual(recovered.outcome, .succeeded)
        XCTAssertEqual(recovered.title, "Worked for 12s")

        let warning = recap([
            ChatBlock(kind: .agentReasoning, text: "One unresolved warning remains."),
        ])
        XCTAssertEqual(warning.outcome, .warning)
        XCTAssertTrue(warning.title.contains("Completed with warnings"))

        let failed = recap([
            ChatBlock(kind: .toolCall, text: "Error", activityId: "failed", activityPhase: .failed),
        ])
        XCTAssertEqual(failed.outcome, .failed)
        XCTAssertTrue(failed.title.contains("Needs attention"))

        let cancelled = recap([
            ChatBlock(kind: .toolCall, text: "Stopped", activityId: "cancel", activityPhase: .cancelled),
        ])
        XCTAssertEqual(cancelled.outcome, .cancelled)
        XCTAssertTrue(cancelled.title.contains("Stopped by user"))

        let blocked = recap([
            ChatBlock(kind: .mcpCall, text: "Error", activityId: "auth", activityPhase: .failed),
            ChatBlock(kind: .agentReasoning, text: "Credentials are required and I cannot continue without your input."),
        ])
        XCTAssertEqual(blocked.outcome, .actionRequired)
        XCTAssertEqual(blocked.subtitle, "1 blocked step")

        let errorFinal = AgentTimelinePresentation.build(
            from: [ChatBlock(kind: .agentReasoning, text: "Inspected the request.")],
            isStreaming: false
        ).completionRecap(durationLabel: "Worked for 2s", finalAnswer: "**Error:** Connection lost")
        XCTAssertEqual(errorFinal.outcome, .failed)
        XCTAssertTrue(errorFinal.title.contains("Needs attention"))
    }

    func testCurrentActivityIsReplacedAsNewToolsStart() {
        let first = AgentTimelinePresentation.build(
            from: [
                ChatBlock(
                    kind: .webCall, text: "Searching", activityId: "search",
                    activityPhase: .started)
            ],
            isStreaming: true
        )
        XCTAssertEqual(first.currentActivity?.id, first.steps[0].activities[0].id)

        let second = AgentTimelinePresentation.build(
            from: [
                ChatBlock(
                    kind: .webCall, text: "Result", activityId: "search",
                    activityPhase: .completed),
                ChatBlock(
                    kind: .shellCommand, text: "swift test", activityId: "tests",
                    activityPhase: .started),
            ],
            isStreaming: true
        )
        XCTAssertEqual(second.currentActivity?.title, "Shell command")
    }

    func testCommandDisclosureStartsCollapsedAndStaysStableAsEventsArrive() {
        XCTAssertFalse(AgentCommandDisclosurePolicy.initiallyExpanded)
        XCTAssertFalse(
            AgentCommandDisclosurePolicy.expansion(current: false, afterActivityCountChangedTo: 3)
        )
        XCTAssertTrue(
            AgentCommandDisclosurePolicy.expansion(current: true, afterActivityCountChangedTo: 4)
        )
    }

    func testActivityPaginationStartsWithNewestTenAndLoadsTenEarlierAtATime() {
        XCTAssertEqual(AgentActivityPagination.pageSize, 10)
        XCTAssertEqual(AgentActivityPagination.initialVisibleCount(totalCount: 24), 10)
        XCTAssertEqual(
            AgentActivityPagination.visibleRange(totalCount: 24, visibleCount: 10),
            14..<24
        )
        XCTAssertTrue(AgentActivityPagination.hasMore(totalCount: 24, visibleCount: 10))

        let secondPage = AgentActivityPagination.nextVisibleCount(
            totalCount: 24,
            currentVisibleCount: 10
        )
        XCTAssertEqual(secondPage, 20)
        XCTAssertEqual(
            AgentActivityPagination.visibleRange(totalCount: 24, visibleCount: secondPage),
            4..<24
        )

        let finalPage = AgentActivityPagination.nextVisibleCount(
            totalCount: 24,
            currentVisibleCount: secondPage
        )
        XCTAssertEqual(finalPage, 24)
        XCTAssertEqual(
            AgentActivityPagination.visibleRange(totalCount: 24, visibleCount: finalPage),
            0..<24
        )
        XCTAssertFalse(AgentActivityPagination.hasMore(totalCount: 24, visibleCount: finalPage))
    }

    func testActivityPaginationHandlesShortAndGrowingTimelines() {
        XCTAssertEqual(AgentActivityPagination.initialVisibleCount(totalCount: 7), 7)
        XCTAssertEqual(
            AgentActivityPagination.visibleRange(totalCount: 7, visibleCount: 10),
            0..<7
        )
        XCTAssertFalse(AgentActivityPagination.hasMore(totalCount: 7, visibleCount: 10))
        XCTAssertEqual(
            AgentActivityPagination.visibleRange(totalCount: 11, visibleCount: 10),
            1..<11
        )
    }

    func testSessionChangesAndHydrationResetTheConversationToBottom() {
        XCTAssertTrue(
            ChatSessionScrollPolicy.shouldResetForSessionChange(
                previousSessionID: "cached-a",
                sessionID: "cached-b"
            )
        )
        XCTAssertTrue(
            ChatSessionScrollPolicy.shouldResetForSessionChange(
                previousSessionID: "idle",
                sessionID: "background-running"
            )
        )
        XCTAssertTrue(
            ChatSessionScrollPolicy.shouldResetAfterHydration(
                wasLoading: true,
                isLoading: false,
                sessionID: "uncached"
            )
        )
        XCTAssertFalse(
            ChatSessionScrollPolicy.shouldResetAfterHydration(
                wasLoading: false,
                isLoading: false,
                sessionID: "cached"
            )
        )
    }

    func testLargeActivityPreviewTruncatesWithoutChangingFullText() {
        let full = String(repeating: "x", count: AgentActivityDetailContent.previewCharacterLimit + 500)
        let preview = AgentActivityDetailContent.displayedText(full, showFullContent: false)

        XCTAssertLessThan(preview.count, full.count)
        XCTAssertTrue(preview.contains("Output truncated"))
        XCTAssertEqual(AgentActivityDetailContent.displayedText(full, showFullContent: true), full)
    }

    func testComposerUsesReadableFontAndAlignedMultilineMetrics() {
        XCTAssertEqual(ChatComposerMetrics.fontSize, 14)
        XCTAssertGreaterThan(ChatComposerMetrics.lineHeight, ChatComposerMetrics.fontSize)
        XCTAssertEqual(ChatComposerMetrics.height(for: "one line"), ChatComposerMetrics.minimumHeight)
        XCTAssertGreaterThan(
            ChatComposerMetrics.height(for: "1\n2\n3\n4"), ChatComposerMetrics.minimumHeight)
    }

    func testAutoScrollOnlyFollowsLiveUpdatesNearBottom() {
        XCTAssertTrue(ChatAutoScrollPolicy.shouldFollow(wasNearBottom: true, isLiveUpdate: true))
        XCTAssertFalse(ChatAutoScrollPolicy.shouldFollow(wasNearBottom: false, isLiveUpdate: true))
        XCTAssertFalse(ChatAutoScrollPolicy.shouldFollow(wasNearBottom: true, isLiveUpdate: false))
        XCTAssertFalse(ChatAutoScrollPolicy.shouldAnimate(reduceMotion: true))
        XCTAssertTrue(ChatAutoScrollPolicy.shouldAnimate(reduceMotion: false))
    }

    func testScrollObserverGeometryUsesTheLiveNearBottomThreshold() {
        XCTAssertTrue(
            ConversationScrollGeometry.isNearBottom(visibleBottom: 880, contentBottom: 1_000)
        )
        XCTAssertFalse(
            ConversationScrollGeometry.isNearBottom(visibleBottom: 879, contentBottom: 1_000)
        )
        XCTAssertTrue(ConversationScrollGeometry.isNearTop(visibleTop: 120))
        XCTAssertFalse(ConversationScrollGeometry.isNearTop(visibleTop: 121))
    }

    func testCompletedTimelineCollapsesAndFormatsElapsedTime() {
        XCTAssertTrue(
            AgentCompletedTimelinePolicy.isExpanded(
                isStreaming: true,
                hasFinalAnswer: false,
                completedExpanded: false
            )
        )
        XCTAssertTrue(
            AgentCompletedTimelinePolicy.isExpanded(
                isStreaming: false,
                hasFinalAnswer: false,
                completedExpanded: false
            )
        )
        XCTAssertFalse(
            AgentCompletedTimelinePolicy.shouldShowDisclosure(
                isStreaming: false,
                hasFinalAnswer: false
            )
        )
        XCTAssertTrue(
            AgentCompletedTimelinePolicy.shouldShowDisclosure(
                isStreaming: false,
                hasFinalAnswer: true
            )
        )
        XCTAssertFalse(
            AgentCompletedTimelinePolicy.isExpanded(
                isStreaming: false,
                hasFinalAnswer: true,
                completedExpanded: false
            )
        )
        XCTAssertFalse(
            AgentCompletedTimelinePolicy.expansionAfterStreamingChange(
                isStreaming: false,
                hasFinalAnswer: true,
                current: true
            )
        )
        XCTAssertTrue(
            AgentCompletedTimelinePolicy.expansionAfterStreamingChange(
                isStreaming: false,
                hasFinalAnswer: false,
                current: true
            )
        )
        XCTAssertEqual(AgentTimelineDuration.label(for: 125), "Worked for 2m 5s")
        let started = Date(timeIntervalSince1970: 100)
        XCTAssertEqual(
            AgentTimelineDuration.elapsed(
                blocks: [ChatBlock(kind: .agentReasoning, text: "Started", createdAt: started)],
                completionDate: started.addingTimeInterval(125)
            ),
            125
        )
        XCTAssertFalse(AgentTimelineMotionPolicy.shouldAnimate(reduceMotion: true))
        XCTAssertTrue(AgentTimelineMotionPolicy.shouldAnimate(reduceMotion: false))
    }

    func testOlderHistoryPrependsInOrderWithoutDuplicatesAndKeepsStableIDs() {
        let existing = [
            ChatMessage.user("three", sentAt: nil, id: "server:3-user"),
            ChatMessage.assistant(id: "server:assistant-3"),
        ]
        let older = [
            ChatMessage.user("one", sentAt: nil, id: "server:1-user"),
            ChatMessage.assistant(id: "server:assistant-1"),
            ChatMessage.user("duplicate", sentAt: nil, id: "server:3-user"),
        ]

        let merged = ChatHistoryMergePolicy.prepend(existing: existing, older: older)

        XCTAssertEqual(
            merged.map(\.id),
            ["server:1-user", "server:assistant-1", "server:3-user", "server:assistant-3"]
        )
        XCTAssertEqual(merged.first(where: { $0.id == "server:3-user" })?.text, "three")
    }

    func testMultipleSteeringRedirectsSurviveOutOfOrderRemoval() {
        let original = "local:assistant:original"
        let first = SteeringRedirectRecord(
            redirectKey: original,
            continuationMessageID: "local:assistant:first",
            sequence: 1
        )
        let second = SteeringRedirectRecord(
            redirectKey: original,
            continuationMessageID: "local:assistant:second",
            sequence: 2
        )

        XCTAssertEqual(
            SteeringRedirectResolver.target(for: original, records: ["a": first, "b": second]),
            "local:assistant:second"
        )
        XCTAssertEqual(
            SteeringRedirectResolver.target(for: original, records: ["b": second]),
            "local:assistant:second"
        )
        XCTAssertEqual(
            SteeringRedirectResolver.target(for: original, records: ["a": first]),
            "local:assistant:first"
        )
        XCTAssertNil(SteeringRedirectResolver.target(for: original, records: [:]))
    }

    func testCachedHistoryRematerializesTheLatestUserTurnWithoutAStaleSuccess() {
        let messages = [
            ChatMessage.user("old", sentAt: nil, id: "server:user-old"),
            ChatMessage.assistant(id: "server:assistant-old"),
            ChatMessage.user("latest", sentAt: nil, id: "server:user-latest"),
            ChatMessage.assistant(id: "server:assistant-latest"),
            ChatMessage.user("unanswered", sentAt: nil, id: "server:user-trailing"),
        ]

        XCTAssertEqual(
            ChatHistoryMergePolicy.latestVisibleTurn(in: messages).map(\.id),
            ["server:user-trailing"]
        )
        XCTAssertEqual(
            ChatHistoryMergePolicy.latestVisibleTurn(
                in: Array(messages.dropLast())
            ).map(\.id),
            ["server:user-latest", "server:assistant-latest"]
        )
        XCTAssertEqual(
            ChatHistoryMergePolicy.latestVisibleTurn(
                in: [ChatMessage.user("pending", sentAt: nil, id: "server:only-user")]
            ).map(\.id),
            ["server:only-user"]
        )
    }

    func testProgressiveFinalAnswerDisplaysOnlyPreviewUntilExpanded() {
        let block = ChatBlock(
            id: "server:block-final",
            kind: .finalAnswer,
            text: String(repeating: "full", count: 5_000),
            contentLength: 20_000,
            isContentTruncated: false,
            fullContentID: "block-final",
            previewText: "Bounded preview"
        )

        XCTAssertEqual(
            ProgressiveBlockContent.displayedText(for: block, showFullContent: false),
            "Bounded preview"
        )
        XCTAssertEqual(
            ProgressiveBlockContent.displayedText(for: block, showFullContent: true),
            block.text
        )
        XCTAssertEqual(ProgressiveBlockContent.sizeLabel(for: block), "19 KB")
    }

    func testProgressiveContentRejectsAResponseThatDoesNotMatchItsImmutableID() {
        let expectedID = "content-DzXDDxEVhitKbNxEIc19kXbrROMp2u6OveEwoOvMVyg"
        let block = ChatBlock(
            kind: .finalAnswer,
            text: "Preview",
            contentLength: 24,
            isContentTruncated: true,
            fullContentID: expectedID,
            previewText: "Preview"
        )

        XCTAssertEqual(
            TranscriptContentIntegrity.contentID(
                kind: .finalAnswer,
                text: "Original complete answer"
            ),
            expectedID
        )
        XCTAssertTrue(
            TranscriptContentIntegrity.matches(
                block: block,
                fullText: "Original complete answer"
            )
        )
        XCTAssertFalse(
            TranscriptContentIntegrity.matches(
                block: block,
                fullText: "Unrelated content after pruning"
            )
        )
    }
}
