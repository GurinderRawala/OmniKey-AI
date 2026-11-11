import AppKit
import SwiftUI
import XCTest
@testable import OmniKeyAI

private struct OfflineWindowSkillsService: SkillsService {
    func list() async throws -> [SkillSummary] { [] }
    func get(id: String) async throws -> SkillDTO { throw CancellationError() }
    func create(_ draft: SkillDraft) async throws -> SkillDTO { throw CancellationError() }
    func update(id: String, revision: Int, patch: SkillPatch) async throws -> SkillDTO { throw CancellationError() }
    func delete(id: String, revision: Int) async throws {}
}

@MainActor
final class SkillsWindowLayoutTests: XCTestCase {
    private func settle(_ window: NSWindow) {
        window.contentView?.layoutSubtreeIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(0.1))
        window.contentView?.layoutSubtreeIfNeeded()
    }

    func testInitialWindowIsCompactAndHostingCannotResizeIt() throws {
        let model = SkillsViewModel(service: OfflineWindowSkillsService())
        let controller = SkillsWindowController(identity: nil, model: model,
            visibleFrame: NSRect(x: 0, y: 25, width: 1920, height: 1055))
        let window = try XCTUnwrap(controller.window)
        defer { model.retire(); window.close() }
        let host = try XCTUnwrap(window.contentViewController as? NSHostingController<SkillsView>)
        XCTAssertEqual(host.sizingOptions, [])
        XCTAssertEqual(window.contentRect(forFrameRect: window.frame).size, NSSize(width: 960, height: 640))
        let initial = window.frame
        model.startCreate()
        model.editor?.draft.instructions = String(repeating: "Long instructions ", count: 400)
        settle(window)
        XCTAssertEqual(window.frame, initial)
        XCTAssertTrue(window.styleMask.contains(.resizable))
    }

    func testWholeWindowFitsSmallScaledDisplaysIncludingTitleBar() throws {
        for visible in [NSRect(x: 0, y: 40, width: 1024, height: 620),
                        NSRect(x: 0, y: 40, width: 800, height: 500),
                        NSRect(x: 0, y: 40, width: 640, height: 400)] {
            let model = SkillsViewModel(service: OfflineWindowSkillsService())
            let controller = SkillsWindowController(identity: nil, model: model, visibleFrame: visible)
            let window = try XCTUnwrap(controller.window)
            settle(window)
            XCTAssertTrue(SkillsWindowSizing.availableFrame(in: visible).contains(window.frame), "\(window.frame) must fit \(visible)")
            XCTAssertLessThanOrEqual(window.minSize.width, window.frame.width)
            XCTAssertLessThanOrEqual(window.minSize.height, window.frame.height)
            model.retire(); window.close()
        }
    }

    func testFrameGeometrySupportsOffsetAndNegativeOriginDisplays() {
        for visible in [NSRect(x: -1200, y: -200, width: 800, height: 500),
                        NSRect(x: 1800, y: 500, width: 640, height: 400)] {
            let original = NSRect(x: 100, y: 100, width: 1400, height: 1000)
            let fitted = SkillsWindowSizing.fittedFrame(original, in: visible)
            XCTAssertTrue(visible.contains(fitted))
            XCTAssertEqual(SkillsWindowSizing.fittedFrame(fitted, in: visible), fitted)
        }
    }

    func testRefitsPreserveTiledFramesAndDoNotSnapDuringScreenChanges() {
        let screen = NSRect(x: 0, y: 30, width: 1200, height: 750)
        XCTAssertEqual(SkillsWindowSizing.fittedFrame(screen, in: screen), screen)
        let straddling = NSRect(x: 800, y: 70, width: 900, height: 600)
        XCTAssertEqual(SkillsWindowSizing.fittedFrame(straddling, in: screen, duringScreenChange: true), straddling)
        let other = NSRect(x: 1200, y: 0, width: 1600, height: 1000)
        XCTAssertEqual(SkillsWindowSizing.bestScreenIndex(for: straddling, frames: [screen, other]), 1)
        XCTAssertNil(SkillsWindowSizing.bestScreenIndex(for: NSRect(x: -3000, y: 0, width: 500, height: 500), frames: [screen, other]))
    }

    func testRefitKeepsUserSizeWhenItFitsAndClampsAfterDisplayChange() throws {
        let model = SkillsViewModel(service: OfflineWindowSkillsService())
        let controller = SkillsWindowController(identity: nil, model: model,
            visibleFrame: NSRect(x: 0, y: 0, width: 1920, height: 1080))
        let window = try XCTUnwrap(controller.window)
        defer { model.retire(); window.close() }
        let custom = NSRect(x: 100, y: 100, width: 1100, height: 760)
        window.setFrame(custom, display: false)
        controller.fitWindow(to: NSRect(x: 0, y: 0, width: 1920, height: 1080))
        XCTAssertEqual(window.frame, custom)
        let laptop = NSRect(x: 0, y: 40, width: 1100, height: 650)
        controller.fitWindow(to: laptop)
        settle(window)
        XCTAssertTrue(laptop.contains(window.frame))
        XCTAssertLessThanOrEqual(window.minSize.height, window.frame.height)
    }
}
