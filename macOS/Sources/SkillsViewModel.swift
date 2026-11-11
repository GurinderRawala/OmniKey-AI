import Foundation

/// State for the Skills window. The backend is the only source of truth:
/// nothing is cached across launches, nothing is matched locally, and every
/// mutation is followed by a re-fetch. Responses that arrive after a newer
/// request for the same slot are dropped (generation tokens).
@MainActor
final class SkillsViewModel: ObservableObject {
    enum LoadState: Equatable {
        case idle
        case loading
        case loaded
        case failed(SkillsAPIError)
    }

    enum EditorMode: Equatable {
        case create
        /// `base` is the revision the draft will be saved against.
        case edit(base: SkillDTO)
    }

    struct EditorState: Equatable {
        let sessionID = UUID()
        var mode: EditorMode
        var draft: SkillDraft
        var fieldErrors: [String: String] = [:]
        var error: SkillsAPIError?
        var isSaving = false
        /// The server rejected the save as stale. The draft is kept; the user
        /// may reload the latest revision (keeping their text) and save again.
        var hasConflict = false
        var notice: String?
        /// Fields edited here that were also changed elsewhere (after a
        /// rebase). The draft value is kept; the view flags them.
        var conflictFields: [SkillDraftRebase.Field] = []
    }

    @Published private(set) var skills: [SkillSummary] = []
    @Published private(set) var listState: LoadState = .idle
    @Published private(set) var selectedID: String?
    @Published private(set) var detail: SkillDTO?
    @Published private(set) var detailState: LoadState = .idle
    @Published var editor: EditorState?
    enum Navigation: Equatable {
        case selection(String?)
        case create
        case closeEditor
    }

    @Published private(set) var sidebarSelection: String?
    @Published var showsUnsavedChanges = false
    private(set) var pendingNavigation: Navigation?
    private var navigationAfterSave: Navigation?
    @Published var pendingDelete: SkillSummary?
    @Published private(set) var busyIDs: Set<String> = []
    /// Neutral status line (success/info). Errors use `actionError`.
    @Published var statusMessage: String?
    @Published var actionError: String?

    private let service: any SkillsService
    private var listGeneration = 0
    private var detailGeneration = 0
    private var listTask: Task<Void, Never>?
    private var detailTask: Task<Void, Never>?

    /// `service` is bound to one backend + subscription; a model (and its
    /// drafts) is never reused for another identity.
    init(service: any SkillsService) {
        self.service = service
    }

    /// Set once the identity this model was bound to is no longer current.
    private(set) var isRetired = false

    /// Stop for good: cancel reads, drop drafts and shown data, and ignore
    /// every late completion. In-flight mutations still finish on the old
    /// identity's backend (the bound service refuses anything else), but
    /// their results never reach the UI.
    func retire() {
        guard !isRetired else { return }
        isRetired = true
        listGeneration += 1
        detailGeneration += 1
        listTask?.cancel()
        detailTask?.cancel()
        editor = nil
        pendingNavigation = nil
        navigationAfterSave = nil
        showsUnsavedChanges = false
        pendingDelete = nil
        busyIDs = []
        skills = []
        selectedID = nil
        sidebarSelection = nil
        detail = nil
        listState = .idle
        detailState = .idle
        statusMessage = nil
        actionError = nil
    }

    var isUpgradeRequired: Bool {
        if case let .failed(error) = listState { return error.kind == .upgradeRequired }
        return false
    }

    var isListLoading: Bool { listState == .loading }

    var selectedSummary: SkillSummary? {
        guard let selectedID else { return nil }
        return skills.first { $0.id == selectedID }
    }

    /// The loaded detail matches the selected row's revision (or is newer).
    /// While false the pane shows progress and edit/toggle/delete are
    /// disabled, so no action targets a revision the user has not seen.
    var isDetailCurrent: Bool {
        guard let detail, let summary = selectedSummary, detail.id == summary.id else { return false }
        return detail.revision >= summary.revision
    }

    // MARK: - Loading

    func onAppear() {
        if listState == .idle { refresh() }
    }

    /// Re-fetch the list (and the open detail, unless the user is editing).
    func refresh() {
        guard !isRetired else { return }
        statusMessage = nil
        actionError = nil
        reloadList()
        if editor == nil, let selectedID { loadDetail(id: selectedID) }
    }

    private func reloadList() {
        guard !isRetired else { return }
        listGeneration += 1
        let generation = listGeneration
        listTask?.cancel()
        listState = .loading
        listTask = Task { [service] in
            let result: Result<[SkillSummary], SkillsAPIError>
            do { result = .success(try await service.list()) }
            catch { result = .failure(Self.apiError(error)) }
            self.applyList(result, generation: generation)
        }
    }

    private func applyList(_ result: Result<[SkillSummary], SkillsAPIError>, generation: Int) {
        guard !isRetired, generation == listGeneration else { return }
        switch result {
        case let .success(list):
            skills = list
            listState = .loaded
            if let selectedID, !list.contains(where: { $0.id == selectedID }), editor == nil {
                self.selectedID = nil
                sidebarSelection = nil
                detail = nil
                detailState = .idle
            } else if editor == nil, let selectedID, let detail, detail.id == selectedID,
                      let summary = selectedSummary, summary.revision > detail.revision
            {
                // The row is newer than the instructions on screen; fetch them
                // so the pane never mixes revisions.
                loadDetail(id: selectedID)
            }
        case let .failure(error):
            if error.kind == .cancelled { return }
            listState = .failed(error)
            if error.kind == .upgradeRequired { skills = [] }
        }
    }

    var hasUnsavedChanges: Bool {
        guard let editor else { return false }
        switch editor.mode {
        case .create: return editor.draft != SkillDraft()
        case let .edit(base): return editor.draft != SkillDraft(base)
        }
    }

    func select(_ id: String?) {
        guard !isRetired else { return }
        // Clicking the previously selected row still leaves a New Skill draft.
        if editor == nil, id == selectedID { return }
        guard editor?.isSaving != true else { return }
        sidebarSelection = id
        requestNavigation(.selection(id))
    }

    private func requestNavigation(_ destination: Navigation) {
        guard !isRetired, editor?.isSaving != true else { return }
        if hasUnsavedChanges {
            pendingNavigation = destination
            showsUnsavedChanges = true
        } else {
            performNavigation(destination)
        }
    }

    func keepEditing() {
        pendingNavigation = nil
        showsUnsavedChanges = false
        sidebarSelection = editor?.mode == .create ? nil : selectedID
    }

    func discardAndNavigate() {
        guard !isRetired, editor?.isSaving != true, let destination = pendingNavigation else { return }
        keepEditing()
        performNavigation(destination)
    }

    func saveAndNavigate() {
        guard !isRetired, editor?.isSaving != true, let destination = pendingNavigation else { return }
        navigationAfterSave = destination
        keepEditing()
        save()
        // Local validation can fail before a request is sent. Stay in the editor.
        if editor?.isSaving != true { navigationAfterSave = nil }
    }

    private func performNavigation(_ destination: Navigation, afterSave: Bool = false) {
        editor = nil
        switch destination {
        case let .selection(id): applySelection(id)
        case .create:
            sidebarSelection = nil
            if !afterSave { statusMessage = nil }
            actionError = nil
            editor = EditorState(mode: .create, draft: SkillDraft())
        case .closeEditor:
            sidebarSelection = selectedID
            reconcileDetail()
        }
    }

    private func applySelection(_ id: String?) {
        sidebarSelection = id
        if id == selectedID { reconcileDetail(); return }
        selectedID = id
        if let id { loadDetail(id: id) } else {
            detailGeneration += 1
            detailTask?.cancel()
            detail = nil
            detailState = .idle
        }
    }

    /// Shown when the backend keeps returning instructions older than the
    /// listed revision even after one re-fetch.
    static let staleDetailError = SkillsAPIError(
        kind: .invalidResponse,
        message: "The backend returned an older version of this skill than the list shows. Retry to load the latest."
    )

    /// `staleRetry` marks the single automatic re-fetch after a read came
    /// back older than a known revision; a second stale read fails visibly.
    private func loadDetail(id: String, staleRetry: Bool = false) {
        guard !isRetired else { return }
        detailGeneration += 1
        let generation = detailGeneration
        detailTask?.cancel()
        if detail?.id != id { detail = nil }
        detailState = .loading
        detailTask = Task { [service] in
            let result: Result<SkillDTO, SkillsAPIError>
            do { result = .success(try await service.get(id: id)) }
            catch { result = .failure(Self.apiError(error)) }
            self.applyDetail(result, id: id, generation: generation, staleRetry: staleRetry)
        }
    }

    private func applyDetail(
        _ result: Result<SkillDTO, SkillsAPIError>, id: String, generation: Int, staleRetry: Bool
    ) {
        guard !isRetired, generation == detailGeneration, selectedID == id else { return }
        switch result {
        case let .success(skill):
            // A read issued before a mutation/refresh can return an older
            // revision than one already known; never step back to it.
            let shownRevision = detail?.id == skill.id ? detail?.revision ?? 0 : 0
            let listedRevision = selectedSummary?.revision ?? 0
            if skill.revision < max(shownRevision, listedRevision) {
                if editor != nil || isDetailCurrent {
                    // Keep what is shown; closing the editor reconciles.
                    detailState = .loaded
                } else if staleRetry {
                    detailState = .failed(Self.staleDetailError)
                } else {
                    loadDetail(id: id, staleRetry: true)
                }
                return
            }
            detail = skill
            detailState = .loaded
            replaceSummary(skill.summary)
        case let .failure(error):
            if error.kind == .cancelled { return }
            detailState = .failed(error)
            if error.kind == .notFound {
                detail = nil
                reloadList()
            }
        }
    }

    /// Fetch the selected skill's instructions when the pane is settled but
    /// shows an older revision than its row (e.g. a refresh during editing
    /// deferred the fetch). No-op while editing, loading or failed.
    private func reconcileDetail() {
        guard editor == nil, let selectedID, detailState == .loaded, !isDetailCurrent else { return }
        loadDetail(id: selectedID)
    }

    // MARK: - Editing

    func startCreate() {
        guard !isRetired, !isUpgradeRequired else { return }
        requestNavigation(.create)
    }

    func startEdit() {
        guard !isRetired, let detail, detail.id == selectedID, isDetailCurrent else { return }
        statusMessage = nil
        actionError = nil
        editor = EditorState(mode: .edit(base: detail), draft: SkillDraft(detail))
    }

    func requestCloseEditor() { requestNavigation(.closeEditor) }

    func cancelEdit() {
        guard editor?.isSaving != true else { return }
        editor = nil
        reconcileDetail()
    }

    /// Local checks for obvious mistakes. The server remains authoritative.
    static func localFieldErrors(for draft: SkillDraft) -> [String: String] {
        var errors: [String: String] = [:]
        let name = draft.name.trimmingCharacters(in: .whitespacesAndNewlines)
        let keyword = draft.keyword.trimmingCharacters(in: .whitespacesAndNewlines)
        if name.isEmpty {
            errors["name"] = "Enter a name."
        } else if name.codePointCount > SkillLimits.nameCodePoints {
            errors["name"] = "Use at most \(SkillLimits.nameCodePoints) characters."
        } else if name.contains(where: \.isNewline) {
            errors["name"] = "Names must be a single line."
        }
        if keyword.isEmpty {
            errors["keyword"] = "Enter a keyword or phrase."
        } else if keyword.codePointCount > SkillLimits.keywordCodePoints {
            errors["keyword"] = "Use at most \(SkillLimits.keywordCodePoints) characters."
        } else if keyword.contains(where: \.isNewline) {
            errors["keyword"] = "Keywords must be a single line."
        }
        if draft.instructions.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            errors["instructions"] = "Enter instructions."
        } else if draft.instructions.codePointCount > SkillLimits.instructionCodePoints
            || draft.instructions.utf8.count > SkillLimits.instructionBytes
        {
            errors["instructions"] =
                "Use at most \(SkillLimits.instructionCodePoints) characters (\(SkillLimits.instructionBytes / 1024) KiB)."
        }
        return errors
    }

    func save() {
        guard !isRetired, var state = editor, !state.isSaving else { return }
        let localErrors = Self.localFieldErrors(for: state.draft)
        state.fieldErrors = localErrors
        state.error = nil
        state.notice = nil
        guard localErrors.isEmpty else {
            editor = state
            return
        }

        let draft = state.draft
        let mode = state.mode
        if case let .edit(base) = mode, SkillPatch.diff(from: base, to: draft).isEmpty {
            editor = nil
            statusMessage = "No changes to save."
            if let destination = navigationAfterSave {
                navigationAfterSave = nil
                performNavigation(destination, afterSave: true)
            } else { reconcileDetail() }
            return
        }

        state.isSaving = true
        editor = state
        Task { [service] in
            let result: Result<SkillDTO, SkillsAPIError>
            do {
                switch mode {
                case .create:
                    result = .success(try await service.create(draft))
                case let .edit(base):
                    let patch = SkillPatch.diff(from: base, to: draft)
                    result = .success(try await service.update(id: base.id, revision: base.revision, patch: patch))
                }
            } catch {
                result = .failure(Self.apiError(error))
            }
            self.finishSave(result, mode: mode)
        }
    }

    private func finishSave(_ result: Result<SkillDTO, SkillsAPIError>, mode: EditorMode) {
        guard !isRetired, var state = editor, state.mode == mode, state.isSaving else { return }
        state.isSaving = false
        switch result {
        case let .success(skill):
            editor = nil
            statusMessage = mode == .create ? "Skill created." : "Skill saved."
            replaceSummary(skill.summary)
            selectedID = skill.id
            sidebarSelection = skill.id
            detailGeneration += 1
            detailTask?.cancel()
            detail = skill
            detailState = .loaded
            let destination = navigationAfterSave
            navigationAfterSave = nil
            if let destination { performNavigation(destination, afterSave: true) }
            reloadList()

        case let .failure(error):
            navigationAfterSave = nil
            // Keep the draft in every failure case.
            state.error = error.kind == .cancelled ? nil : error
            state.fieldErrors = error.fields
            switch error.kind {
            case .revisionConflict, .revisionRequired:
                state.hasConflict = true
            case .notFound:
                if case .edit = mode {
                    state.mode = .create
                    state.hasConflict = false
                    state.conflictFields = []
                    state.notice = "This skill was deleted elsewhere. Your text is kept; saving will create a new skill."
                }
            default:
                break
            }
            editor = state
        }
    }

    /// After a conflict: fetch the latest revision and rebase the draft onto
    /// it without discarding the user's text.
    func reloadLatestKeepingDraft() {
        guard !isRetired, let state = editor, !state.isSaving, case let .edit(base) = state.mode else { return }
        var saving = state
        saving.isSaving = true
        editor = saving
        Task { [service] in
            let result: Result<SkillDTO, SkillsAPIError>
            do { result = .success(try await service.get(id: base.id)) }
            catch { result = .failure(Self.apiError(error)) }
            self.finishRebase(result, originalBase: base)
        }
    }

    private func finishRebase(_ result: Result<SkillDTO, SkillsAPIError>, originalBase: SkillDTO) {
        guard !isRetired, var state = editor, state.isSaving, state.mode == .edit(base: originalBase) else { return }
        state.isSaving = false
        switch result {
        case let .success(latest):
            let rebase = SkillDraftRebase.merge(draft: state.draft, original: originalBase, latest: latest)
            state.mode = .edit(base: latest)
            state.draft = rebase.draft
            state.conflictFields = rebase.conflicts
            state.hasConflict = false
            state.error = nil
            if !rebase.conflicts.isEmpty {
                let labels = rebase.conflicts.map(\.label).joined(separator: ", ")
                state.notice = "Loaded revision \(latest.revision). \(labels) also changed elsewhere; "
                    + "your version is kept and will replace it if you save. Review before saving."
            } else if latest.revision == originalBase.revision {
                state.notice = "Already up to date. Save again to apply your edits."
            } else if rebase.adopted.isEmpty {
                state.notice = "Loaded revision \(latest.revision). Your edits are kept; review and save again."
            } else {
                let labels = rebase.adopted.map(\.label).joined(separator: ", ")
                state.notice = "Loaded revision \(latest.revision). Updated \(labels) from the latest version; "
                    + "your edits are kept. Review and save again."
            }
            replaceSummary(latest.summary)
            if selectedID == latest.id {
                detail = latest
                detailState = .loaded
            }
        case let .failure(error):
            if error.kind == .notFound {
                state.mode = .create
                state.hasConflict = false
                state.conflictFields = []
                state.error = nil
                state.notice = "This skill was deleted elsewhere. Your text is kept; saving will create a new skill."
            } else if error.kind != .cancelled {
                state.error = error
            }
        }
        editor = state
    }

    // MARK: - Toggle / delete

    func toggleEnabled(_ summary: SkillSummary) {
        guard !isRetired, !busyIDs.contains(summary.id), !showsStaleDetail(for: summary) else { return }
        let revision = displayedRevision(for: summary)
        busyIDs.insert(summary.id)
        actionError = nil
        statusMessage = nil
        let target = !summary.enabled
        Task { [service] in
            let result: Result<SkillDTO, SkillsAPIError>
            do {
                result = .success(try await service.update(
                    id: summary.id, revision: revision, patch: SkillPatch(enabled: target)
                ))
            } catch {
                result = .failure(Self.apiError(error))
            }
            self.finishToggle(result, id: summary.id)
        }
    }

    private func finishToggle(_ result: Result<SkillDTO, SkillsAPIError>, id: String) {
        guard !isRetired else { return }
        busyIDs.remove(id)
        switch result {
        case let .success(skill):
            replaceSummary(skill.summary)
            if let current = detail, current.id == skill.id, current.revision <= skill.revision, editor == nil {
                // Committed revision supersedes any read still in flight.
                detailGeneration += 1
                detailTask?.cancel()
                detail = skill
                detailState = .loaded
            }
            statusMessage = skill.enabled ? "Enabled “\(skill.name)”." : "Disabled “\(skill.name)”."
            reloadList()
        case let .failure(error):
            guard error.kind != .cancelled else { return }
            actionError = error.message
            reloadList()
            if editor == nil, selectedID == id { loadDetail(id: id) }
        }
    }

    func requestDelete(_ summary: SkillSummary) {
        guard !isRetired, !busyIDs.contains(summary.id), !showsStaleDetail(for: summary) else { return }
        pendingDelete = summary
    }

    func confirmDelete() {
        guard !isRetired, let summary = pendingDelete else { return }
        pendingDelete = nil
        guard !busyIDs.contains(summary.id) else { return }
        let revision = displayedRevision(for: summary)
        busyIDs.insert(summary.id)
        actionError = nil
        statusMessage = nil
        Task { [service] in
            let result: Result<Void, SkillsAPIError>
            do {
                try await service.delete(id: summary.id, revision: revision)
                result = .success(())
            } catch {
                result = .failure(Self.apiError(error))
            }
            self.finishDelete(result, summary: summary)
        }
    }

    private func finishDelete(_ result: Result<Void, SkillsAPIError>, summary: SkillSummary) {
        guard !isRetired else { return }
        busyIDs.remove(summary.id)
        let removeLocally = {
            self.skills.removeAll { $0.id == summary.id }
            if self.selectedID == summary.id {
                self.selectedID = nil
                self.sidebarSelection = nil
                self.detailGeneration += 1
                self.detailTask?.cancel()
                self.detail = nil
                self.detailState = .idle
                if case let .edit(base) = self.editor?.mode, base.id == summary.id, self.editor?.isSaving != true {
                    self.editor = nil
                }
            }
        }
        switch result {
        case .success:
            removeLocally()
            statusMessage = "Deleted “\(summary.name)”."
        case let .failure(error):
            switch error.kind {
            case .cancelled:
                return
            case .notFound:
                removeLocally()
                statusMessage = "“\(summary.name)” was already deleted."
            default:
                actionError = error.message
            }
        }
        reloadList()
    }

    // MARK: - Helpers

    /// The revision the user is looking at. A newer revision the user has not
    /// seen must not be targeted silently; the server answers 409 and the
    /// following refresh shows the latest state instead.
    private func displayedRevision(for summary: SkillSummary) -> Int {
        summary.revision
    }

    /// The open detail pane for this skill shows older instructions than
    /// the row; mutating now would target a revision the user hasn't read.
    private func showsStaleDetail(for summary: SkillSummary) -> Bool {
        guard summary.id == selectedID, let detail, detail.id == summary.id else { return false }
        return detail.revision < summary.revision
    }

    private func replaceSummary(_ summary: SkillSummary) {
        if let index = skills.firstIndex(where: { $0.id == summary.id }) {
            if skills[index].revision <= summary.revision { skills[index] = summary }
        } else {
            skills.append(summary)
        }
    }

    nonisolated static func apiError(_ error: Error) -> SkillsAPIError {
        if let error = error as? SkillsAPIError { return error }
        if error is CancellationError { return SkillsAPIError(kind: .cancelled, message: "Request cancelled.") }
        return SkillsAPIError(kind: .network, message: "Couldn't reach the OmniKey backend. Check that it is running, then retry.")
    }
}
