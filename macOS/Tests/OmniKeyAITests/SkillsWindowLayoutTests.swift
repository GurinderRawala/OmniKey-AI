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

    private func descendants(of view: NSView) -> [NSView] {
        view.subviews + view.subviews.flatMap(descendants(of:))
    }

    /// Real rendered controls in the smallest supported window (640×400
    /// display): the header buttons and the editor's Cancel/Create stay on
    /// screen while the long form scrolls, even with banners and a long
    /// draft; while saving the inputs are really disabled. SwiftUI exposes
    /// no accessibility tree to an unshown test window, so this inspects
    /// the AppKit views it renders: each focusable SwiftUI button gets a
    /// focus-ring proxy view placed exactly over it.
    func testEditorActionsAndHeaderAreVisibleInSmallestWindow() throws {
        let visible = NSRect(x: 0, y: 40, width: 640, height: 400)
        let model = SkillsViewModel(service: OfflineWindowSkillsService())
        let controller = SkillsWindowController(identity: nil, model: model, visibleFrame: visible)
        let window = try XCTUnwrap(controller.window)
        defer { model.retire(); window.close() }
        settle(window)
        model.startCreate()
        model.editor?.draft = SkillDraft(
            name: "Name", keyword: "kw",
            instructions: String(repeating: "# Heading\n\nLong instructions line.\n", count: 80)
        )
        model.editor?.error = SkillsAPIError(kind: .network, message: "Couldn't reach the OmniKey backend. Check that it is running, then retry.")
        model.editor?.notice = "This skill was deleted elsewhere. Your text is kept; saving will create a new skill."
        settle(window)

        XCTAssertTrue(SkillsWindowSizing.availableFrame(in: visible).contains(window.frame))
        let content = try XCTUnwrap(window.contentView)
        let all = descendants(of: content)

        // The form scrolls: the name/keyword fields live in a scroll view
        // whose document is taller than its visible clip.
        let fields = all.compactMap { $0 as? NSTextField }.filter { $0.placeholderString?.hasPrefix("e.g.") == true }
        XCTAssertEqual(fields.count, 2, "name and keyword fields rendered")
        let formScroll = try XCTUnwrap(fields.first?.enclosingScrollView, "fields must be inside a scroll view")
        let clip = content.convert(formScroll.contentView.bounds, from: formScroll.contentView)
        XCTAssertGreaterThan(try XCTUnwrap(formScroll.documentView).frame.height, formScroll.contentView.bounds.height,
                             "the form is longer than the viewport, so it must scroll")
        XCTAssertTrue(content.bounds.contains(clip))

        // Focusable button proxies outside the form scroll view: the header
        // (Refresh, New Skill) above it, the pinned actions (Cancel, Create)
        // below it. Every one must be fully on screen.
        let buttons = all.filter { String(describing: type(of: $0)).contains("FocusRing") && !$0.isDescendant(of: formScroll) }
        let header = buttons.filter { content.convert($0.bounds, from: $0).maxY <= clip.minY + 0.5 }
        let actions = buttons.filter { content.convert($0.bounds, from: $0).minY >= clip.maxY - 0.5 }
        XCTAssertEqual(header.count, 2, "Refresh and New Skill rendered above the form")
        XCTAssertEqual(actions.count, 2, "Cancel and Create Skill rendered below the form")
        for button in header + actions {
            let frame = content.convert(button.bounds, from: button)
            XCTAssertGreaterThan(frame.width, 20)
            XCTAssertGreaterThan(frame.height, 15)
            XCTAssertFalse(button.isHiddenOrHasHiddenAncestor)
            XCTAssertTrue(content.bounds.contains(frame), "\(frame) must be fully visible in \(content.bounds)")
            XCTAssertFalse(frame.intersects(clip), "\(frame) must not sit under the scrolling form \(clip)")
        }
        let actionFrames = actions.map { content.convert($0.bounds, from: $0) }
        XCTAssertFalse(actionFrames[0].intersects(actionFrames[1]), "Cancel and Create must not overlap")

        // While saving, the inputs are disabled, not just ignored.
        XCTAssertTrue(fields.allSatisfy(\.isEnabled))
        model.editor?.isSaving = true
        settle(window)
        let savingFields = descendants(of: content).compactMap { $0 as? NSTextField }
            .filter { $0.placeholderString?.hasPrefix("e.g.") == true }
        XCTAssertEqual(savingFields.count, 2)
        XCTAssertTrue(savingFields.allSatisfy { !$0.isEnabled }, "fields must be disabled while saving")
    }

    func testInstructionsHeightFillsLargeViewportsAndIsCappedInSmallOnes() {
        typealias L = SkillEditorLayout
        // Large window: unchanged behaviour, fills what the rest leaves.
        XCTAssertEqual(L.instructionsHeight(viewport: 800, chrome: 300), 500)
        XCTAssertEqual(L.instructionsHeight(viewport: 500.7, chrome: 300), 200)
        // Small viewport: capped to a fraction, so outer form stays under the pointer.
        for viewport: CGFloat in [120, 180, 250, 300, 333] {
            let height = L.instructionsHeight(viewport: viewport, chrome: 400)
            XCTAssertLessThanOrEqual(height, viewport * L.maximumViewportFraction, "\(viewport)")
            XCTAssertGreaterThanOrEqual(height, L.floorEditorHeight)
            XCTAssertLessThan(height, viewport, "never fills the whole viewport")
        }
        XCTAssertEqual(L.instructionsHeight(viewport: 400, chrome: 300), 200, "preferred minimum once it fits the cap")
        // Bounded positive for degenerate input (first layout pass, bad values).
        for (viewport, chrome) in [(0, 0), (-10, 50), (.nan, 10), (.infinity, .nan), (50, 500)] as [(CGFloat, CGFloat)] {
            let height = L.instructionsHeight(viewport: viewport, chrome: chrome)
            XCTAssertTrue(height.isFinite)
            XCTAssertGreaterThanOrEqual(height, L.floorEditorHeight)
            XCTAssertLessThanOrEqual(height, L.minimumEditorHeight)
        }
    }

    /// M2: in the smallest window, the nested instructions editor (which
    /// keeps wheel events while its long text overflows) must not cover the
    /// whole form viewport. Scrolled to the bottom, part of the viewport is
    /// still outer form. A wheel event there scrolls the form back up to
    /// Name and Keyword.
    func testSmallWindowEditorLeavesOuterFormReachableByWheel() throws {
        let visible = NSRect(x: 0, y: 40, width: 640, height: 400)
        let model = SkillsViewModel(service: OfflineWindowSkillsService())
        let controller = SkillsWindowController(identity: nil, model: model, visibleFrame: visible)
        let window = try XCTUnwrap(controller.window)
        defer { model.retire(); window.close() }
        settle(window)
        model.startCreate()
        model.editor?.draft = SkillDraft(
            name: "Name", keyword: "kw",
            instructions: String(repeating: "# Heading\n\nLong instructions line.\n", count: 80)
        )
        model.editor?.error = SkillsAPIError(kind: .network, message: "Couldn't reach the OmniKey backend. Check that it is running, then retry.")
        settle(window)
        settle(window)

        let content = try XCTUnwrap(window.contentView)
        let fields = descendants(of: content).compactMap { $0 as? NSTextField }
            .filter { $0.placeholderString?.hasPrefix("e.g.") == true }
        let formScroll = try XCTUnwrap(fields.first?.enclosingScrollView)
        let document = try XCTUnwrap(formScroll.documentView)
        let editorScroll = try XCTUnwrap(
            descendants(of: document).compactMap { $0 as? NSScrollView }
                .first { String(describing: type(of: $0)).contains("ClampedScrollView") },
            "instructions editor rendered inside the form"
        )
        let viewport = formScroll.contentView.bounds.height
        XCTAssertGreaterThan(viewport, 0)
        XCTAssertGreaterThan(document.frame.height, viewport, "the form must scroll in this window")
        let editorHeight = editorScroll.frame.height
        XCTAssertGreaterThanOrEqual(editorHeight, SkillEditorLayout.floorEditorHeight - 0.5)
        XCTAssertLessThanOrEqual(editorHeight, viewport * SkillEditorLayout.maximumViewportFraction + 1,
                                 "editor \(editorHeight) must leave outer form in viewport \(viewport)")

        // Scroll the form to its bottom (editor fully in view).
        let clip = formScroll.contentView
        let bottomY = document.isFlipped ? document.frame.height - viewport : 0
        clip.scroll(to: NSPoint(x: 0, y: bottomY))
        formScroll.reflectScrolledClipView(clip)
        content.layoutSubtreeIfNeeded()
        let scrolledY = clip.bounds.origin.y

        // Some of the viewport is still outer form, not the editor.
        let clipInContent = content.convert(clip.bounds, from: clip)
        let editorInContent = content.convert(editorScroll.bounds, from: editorScroll).intersection(clipInContent)
        let uncovered = clipInContent.height - editorInContent.height
        XCTAssertGreaterThanOrEqual(uncovered, viewport * (1 - SkillEditorLayout.maximumViewportFraction) - 1)

        // Find a point in that outer area; the view under it belongs to the
        // form, not the editor.
        let point: NSPoint = editorInContent.minY - clipInContent.minY > clipInContent.maxY - editorInContent.maxY
            ? NSPoint(x: clipInContent.midX, y: (clipInContent.minY + editorInContent.minY) / 2)
            : NSPoint(x: clipInContent.midX, y: (editorInContent.maxY + clipInContent.maxY) / 2)
        let hitPoint = content.superview.map { content.convert(point, to: $0) } ?? point
        let hit = try XCTUnwrap(content.hitTest(hitPoint), "something under the pointer")
        XCTAssertFalse(hit.isDescendant(of: editorScroll), "the pointer is over outer form, not the editor")
        XCTAssertTrue(hit.isDescendant(of: formScroll))

        // A real wheel event over it scrolls the form back towards the top.
        let cgEvent = try XCTUnwrap(CGEvent(scrollWheelEvent2Source: nil, units: .pixel,
                                            wheelCount: 1, wheel1: 120, wheel2: 0, wheel3: 0))
        let wheel = try XCTUnwrap(NSEvent(cgEvent: cgEvent))
        hit.scrollWheel(with: wheel)
        RunLoop.main.run(until: Date().addingTimeInterval(0.2))
        XCTAssertNotEqual(clip.bounds.origin.y, scrolledY, "the outer form scrolled")
        let towardsTop = document.isFlipped ? clip.bounds.origin.y < scrolledY : clip.bounds.origin.y > scrolledY
        XCTAssertTrue(towardsTop, "scrolled up towards Name/Keyword")
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
