using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using OmniKey.Windows.Skills;
using OmniKey.Windows.ViewModels;
using Xunit;

namespace OmniKey.Windows.Tests
{
    /// <summary>
    /// Fake backend. Each call is recorded. If a responder is set for the
    /// operation it answers immediately; otherwise the call stays pending
    /// until the test completes it, which makes response ordering explicit.
    /// </summary>
    internal sealed class FakeSkillsService : ISkillsService
    {
        internal sealed class Call
        {
            public string Op = "";
            public string? Id;
            public int? Revision;
            public SkillPatch? Patch;
            public SkillDraft? Draft;
            public CancellationToken Token;
            public TaskCompletionSource<object?> Tcs = new();
            public void Succeed(object? value = null) => Tcs.SetResult(value);
            public void Fail(SkillsErrorKind kind, IReadOnlyDictionary<string, string>? fields = null) =>
                Tcs.SetException(new SkillsApiException(kind, "msg:" + kind, fields: fields));
        }

        public List<Call> Calls { get; } = new();
        public Func<Call, object?>? Responder { get; set; }

        public IEnumerable<Call> Pending(string op) => Calls.Where(c => c.Op == op && !c.Tcs.Task.IsCompleted);
        public Call LastPending(string op) => Pending(op).Last();
        public int Count(string op) => Calls.Count(c => c.Op == op);

        private async Task<T> Run<T>(Call call)
        {
            Calls.Add(call);
            if (Responder is { } r)
            {
                try { call.Tcs.SetResult(r(call)); }
                catch (Exception ex) { call.Tcs.SetException(ex); }
            }
            return (T)(await call.Tcs.Task)!;
        }

        public Task<IReadOnlyList<SkillSummary>> ListAsync(CancellationToken ct = default) =>
            Run<IReadOnlyList<SkillSummary>>(new Call { Op = "list", Token = ct });
        public Task<SkillDto> GetAsync(string id, CancellationToken ct = default) =>
            Run<SkillDto>(new Call { Op = "get", Id = id, Token = ct });
        public Task<SkillDto> CreateAsync(SkillDraft draft, CancellationToken ct = default) =>
            Run<SkillDto>(new Call { Op = "create", Draft = draft, Token = ct });
        public Task<SkillDto> UpdateAsync(string id, int revision, SkillPatch patch, CancellationToken ct = default) =>
            Run<SkillDto>(new Call { Op = "update", Id = id, Revision = revision, Patch = patch, Token = ct });
        public async Task DeleteAsync(string id, int revision, CancellationToken ct = default) =>
            await Run<object?>(new Call { Op = "delete", Id = id, Revision = revision, Token = ct });
    }

    /// <summary>Simple in-memory backend used as a responder.</summary>
    internal sealed class FakeBackend
    {
        private static SkillsApiException Error(SkillsErrorKind kind) => new(kind, "msg:" + kind);

        public Dictionary<string, SkillDto> Skills { get; } = new();
        public Dictionary<string, SkillsErrorKind> FailNext { get; } = new();

        public FakeBackend With(params SkillDto[] skills)
        {
            foreach (var s in skills) Skills[s.Id] = s;
            return this;
        }

        public object? Respond(FakeSkillsService.Call c)
        {
            if (FailNext.Remove(c.Op, out var kind)) throw Error(kind);
            switch (c.Op)
            {
                case "list":
                    return (IReadOnlyList<SkillSummary>)Skills.Values.OrderBy(s => s.Name, StringComparer.Ordinal)
                        .Select(s => s.ToSummary()).ToList();
                case "get":
                    return Skills.TryGetValue(c.Id!, out var s1) ? s1 : throw Error(SkillsErrorKind.NotFound);
                case "create":
                    var created = new SkillDto("new-" + Skills.Count, c.Draft!.Name, c.Draft.Keyword, c.Draft.Instructions, c.Draft.Enabled, 1);
                    Skills[created.Id] = created;
                    return created;
                case "update":
                    if (!Skills.TryGetValue(c.Id!, out var cur)) throw Error(SkillsErrorKind.NotFound);
                    if (cur.Revision != c.Revision) throw Error(SkillsErrorKind.RevisionConflict);
                    var p = c.Patch!;
                    var next = cur with
                    {
                        Name = p.Name ?? cur.Name,
                        Keyword = p.Keyword ?? cur.Keyword,
                        Instructions = p.Instructions ?? cur.Instructions,
                        Enabled = p.Enabled ?? cur.Enabled,
                        Revision = cur.Revision + 1,
                    };
                    Skills[c.Id!] = next;
                    return next;
                case "delete":
                    if (!Skills.TryGetValue(c.Id!, out var d)) throw Error(SkillsErrorKind.NotFound);
                    if (d.Revision != c.Revision) throw Error(SkillsErrorKind.RevisionConflict);
                    Skills.Remove(c.Id!);
                    return null;
            }
            throw new InvalidOperationException(c.Op);
        }
    }

    public class SkillsViewModelTests
    {
        private static readonly SkillDto A = new("a", "Alpha", "alpha", "Alpha instructions.", true, 1);
        private static readonly SkillDto B = new("b", "Beta", "beta", "Beta instructions.", false, 4);

        private static (SkillsViewModel vm, FakeSkillsService svc, FakeBackend backend) Live(params SkillDto[] skills)
        {
            var backend = new FakeBackend().With(skills);
            var svc = new FakeSkillsService();
            svc.Responder = backend.Respond;
            return (new SkillsViewModel(svc), svc, backend);
        }

        private static IReadOnlyList<SkillSummary> Summaries(params SkillDto[] s) => s.Select(x => x.ToSummary()).ToList();

        // ── Loading ─────────────────────────────────────────────────────

        [Fact]
        public async Task LoadShowsRowsInServerOrder()
        {
            var (vm, _, _) = Live(B, A);
            await vm.OnAppearedAsync();
            Assert.Equal(SkillsLoadState.Loaded, vm.ListState);
            Assert.Equal(new[] { "a", "b" }, vm.Skills.Select(r => r.Id));
            Assert.False(vm.Skills[1].IsEnabled);
            Assert.False(vm.IsEmptyStateVisible);
        }

        [Fact]
        public async Task EmptyListShowsEmptyState()
        {
            var (vm, _, _) = Live();
            await vm.RefreshAsync();
            Assert.True(vm.IsEmptyStateVisible);
            Assert.False(vm.IsUpgradeRequired);
        }

        [Fact]
        public async Task OldBackendShowsUpgradeRequiredNotEmpty()
        {
            var (vm, _, backend) = Live(A);
            await vm.RefreshAsync();
            backend.FailNext["list"] = SkillsErrorKind.UpgradeRequired;

            await vm.RefreshAsync();

            Assert.True(vm.IsUpgradeRequired);
            Assert.False(vm.IsEmptyStateVisible);
            Assert.False(vm.HasListError);
            Assert.Empty(vm.Skills);
            Assert.False(vm.NewSkillCommand.CanExecute(null));
        }

        [Fact]
        public async Task NetworkFailureKeepsExistingRowsAndShowsError()
        {
            var (vm, _, backend) = Live(A);
            await vm.RefreshAsync();
            backend.FailNext["list"] = SkillsErrorKind.Network;
            await vm.RefreshAsync();
            Assert.True(vm.HasListError);
            Assert.Single(vm.Skills);
        }

        [Fact]
        public async Task StaleListResponseIsIgnored()
        {
            var svc = new FakeSkillsService();
            var vm = new SkillsViewModel(svc);
            var first = vm.RefreshAsync();
            var second = vm.RefreshAsync();
            Assert.True(svc.Calls[0].Token.IsCancellationRequested);

            svc.Calls[1].Succeed(Summaries(B));
            await second;
            svc.Calls[0].Succeed(Summaries(A));
            await first;

            Assert.Equal(new[] { "b" }, vm.Skills.Select(r => r.Id));
        }

        [Fact]
        public async Task StaleDetailForPreviousSelectionIsIgnored()
        {
            var svc = new FakeSkillsService();
            var vm = new SkillsViewModel(svc);
            var load = vm.RefreshAsync();
            svc.LastPending("list").Succeed(Summaries(A, B));
            await load;

            vm.Select("a");
            vm.Select("b");
            var gets = svc.Pending("get").ToList();
            Assert.Equal(new[] { "a", "b" }, gets.Select(c => c.Id));
            gets[1].Succeed(B);
            gets[0].Succeed(A);

            Assert.Equal("b", vm.Detail!.Id);
            Assert.True(vm.IsDetailCurrent);
            Assert.Equal("Beta instructions.", vm.DetailInstructions);
        }

        [Fact]
        public async Task CliEditVisibleAfterRefreshAndNewerRowReloadsDetail()
        {
            var (vm, svc, backend) = Live(A);
            await vm.RefreshAsync();
            vm.Select("a");
            Assert.Equal("Alpha instructions.", vm.DetailInstructions);

            // Another client (e.g. the CLI) edits the skill on the same backend.
            backend.Skills["a"] = A with { Instructions = "Edited by CLI.", Revision = 2 };
            await vm.RefreshAsync();

            Assert.Equal(2, vm.Skills.Single().Revision);
            Assert.Equal("Edited by CLI.", vm.DetailInstructions);
            Assert.True(vm.IsDetailCurrent);
        }

        // ── Create / edit ───────────────────────────────────────────────

        [Fact]
        public async Task CreateSuccessClosesEditorSelectsAndRefetches()
        {
            var (vm, svc, _) = Live(A);
            await vm.RefreshAsync();
            vm.StartCreate();
            vm.EditName = "SQL review";
            vm.EditKeyword = "sql review";
            vm.EditInstructions = "Line 1\r\nLine 2";

            await vm.SaveAsync();

            var create = svc.Calls.Single(c => c.Op == "create");
            Assert.Equal(new SkillDraft("SQL review", "sql review", "Line 1\nLine 2", true), create.Draft);
            Assert.False(vm.IsEditorOpen);
            Assert.Equal(SkillsViewModel.CreatedMessage, vm.StatusMessage);
            Assert.Equal("new-1", vm.SelectedRow!.Id);
            Assert.Equal("Line 1\nLine 2", vm.DetailInstructions);
            Assert.Equal(2, svc.Count("list"));
            Assert.Equal(0, svc.Count("get"));
        }

        [Fact]
        public async Task LocalValidationBlocksRequestAndKeepsDraft()
        {
            var (vm, svc, _) = Live();
            await vm.RefreshAsync();
            vm.StartCreate();
            vm.EditName = "Two\nlines";
            vm.EditKeyword = "  ";
            vm.EditInstructions = new string('x', SkillLimits.InstructionCodePoints + 1);

            await vm.SaveAsync();

            Assert.Equal(0, svc.Count("create"));
            Assert.True(vm.IsEditorOpen);
            Assert.NotNull(vm.NameError);
            Assert.NotNull(vm.KeywordError);
            Assert.NotNull(vm.InstructionsError);
            Assert.Equal("Two\nlines", vm.EditName);
        }

        [Fact]
        public async Task ServerValidationAndNetworkFailuresKeepDraft()
        {
            var svc = new FakeSkillsService();
            var vm = new SkillsViewModel(svc);
            vm.StartCreate();
            vm.EditName = "N";
            vm.EditKeyword = "@omniagent";
            vm.EditInstructions = "I";

            var save = vm.SaveAsync();
            Assert.True(vm.IsSaving);
            Assert.False(vm.SaveCommand.CanExecute(null));
            Assert.False(vm.CancelEditCommand.CanExecute(null));
            await vm.SaveAsync(); // duplicate submission is a no-op
            Assert.Equal(1, svc.Count("create"));

            svc.LastPending("create").Fail(SkillsErrorKind.Validation,
                new Dictionary<string, string> { ["keyword"] = "Reserved keyword." });
            await save;

            Assert.True(vm.IsEditorOpen);
            Assert.False(vm.IsSaving);
            Assert.Equal("Reserved keyword.", vm.KeywordError);
            Assert.Equal("@omniagent", vm.EditKeyword);

            var retry = vm.SaveAsync();
            svc.LastPending("create").Fail(SkillsErrorKind.Network);
            await retry;
            Assert.Equal("msg:Network", vm.EditorError);
            Assert.Equal("I", vm.EditInstructions);
            Assert.Null(vm.KeywordError);
        }

        [Fact]
        public async Task EditSendsOnlyChangedFieldsAtDisplayedRevision()
        {
            var (vm, svc, _) = Live(B);
            await vm.RefreshAsync();
            vm.Select("b");
            vm.StartEdit();
            vm.EditInstructions = "Changed.";

            await vm.SaveAsync();

            var update = svc.Calls.Single(c => c.Op == "update");
            Assert.Equal(4, update.Revision);
            Assert.Equal(new SkillPatch(Instructions: "Changed."), update.Patch);
            Assert.Equal(SkillsViewModel.SavedMessage, vm.StatusMessage);
            Assert.Equal(5, vm.Detail!.Revision);
        }

        [Fact]
        public async Task CrlfOnlyDifferenceIsNoChange()
        {
            var multi = A with { Instructions = "One\nTwo" };
            var (vm, svc, _) = Live(multi);
            await vm.RefreshAsync();
            vm.Select("a");
            vm.StartEdit();
            vm.EditInstructions = "One\r\nTwo";

            await vm.SaveAsync();

            Assert.Equal(0, svc.Count("update"));
            Assert.Equal("No changes to save.", vm.StatusMessage);
            Assert.False(vm.IsEditorOpen);
        }

        [Fact]
        public async Task RevisionConflictKeepsDraftThenThreeWayMergeAdoptsDisjointRemoteEdits()
        {
            var (vm, svc, backend) = Live(A);
            await vm.RefreshAsync();
            vm.Select("a");
            vm.StartEdit();
            vm.EditInstructions = "My local instructions.";

            // Someone else renames and disables it meanwhile.
            backend.Skills["a"] = A with { Name = "Alpha (renamed)", Enabled = false, Revision = 2 };
            await vm.SaveAsync();

            Assert.True(vm.HasConflict);
            Assert.True(vm.IsEditorOpen);
            Assert.Equal("My local instructions.", vm.EditInstructions);
            Assert.True(vm.ReloadLatestCommand.CanExecute(null));

            await vm.ReloadLatestKeepingDraftAsync();

            Assert.False(vm.HasConflict);
            Assert.Equal("Alpha (renamed)", vm.EditName);
            Assert.False(vm.EditEnabled);
            Assert.Equal("My local instructions.", vm.EditInstructions);
            Assert.False(vm.NameConflict || vm.InstructionsConflict || vm.EnabledConflict || vm.KeywordConflict);
            Assert.Contains("Updated Name, Enabled from the latest version", vm.EditorNotice);

            await vm.SaveAsync();

            var last = svc.Calls.Last(c => c.Op == "update");
            Assert.Equal(2, last.Revision);
            Assert.Equal(new SkillPatch(Instructions: "My local instructions."), last.Patch);
            Assert.Equal(new SkillDto("a", "Alpha (renamed)", "alpha", "My local instructions.", false, 3), backend.Skills["a"]);
        }

        [Fact]
        public async Task SameFieldConflictIsFlaggedAndLocalValueKept()
        {
            var (vm, _, backend) = Live(A);
            await vm.RefreshAsync();
            vm.Select("a");
            vm.StartEdit();
            vm.EditKeyword = "sql review";
            backend.Skills["a"] = A with { Keyword = "db review", Revision = 2 };

            await vm.SaveAsync();
            await vm.ReloadLatestKeepingDraftAsync();

            Assert.True(vm.KeywordConflict);
            Assert.Equal("sql review", vm.EditKeyword);
            Assert.Contains("Keyword also changed elsewhere", vm.EditorNotice);
        }

        [Fact]
        public async Task RevisionRequiredAlsoOffersReload()
        {
            var svc = new FakeSkillsService();
            var vm = new SkillsViewModel(svc);
            var load = vm.RefreshAsync();
            svc.LastPending("list").Succeed(Summaries(A));
            await load;
            vm.Select("a");
            svc.LastPending("get").Succeed(A);
            vm.StartEdit();
            vm.EditName = "X";
            var save = vm.SaveAsync();
            svc.LastPending("update").Fail(SkillsErrorKind.RevisionRequired);
            await save;
            Assert.True(vm.HasConflict);
        }

        [Fact]
        public async Task EditOfSkillDeletedElsewhereSwitchesToCreateKeepingText()
        {
            var (vm, svc, backend) = Live(A);
            await vm.RefreshAsync();
            vm.Select("a");
            vm.StartEdit();
            vm.EditInstructions = "Keep me.";
            backend.Skills["a"] = A with { Revision = 2 };
            await vm.SaveAsync();
            backend.Skills.Remove("a");

            await vm.ReloadLatestKeepingDraftAsync();

            Assert.True(vm.IsCreateMode);
            Assert.False(vm.HasConflict);
            Assert.Equal(SkillsViewModel.DeletedElsewhereNotice, vm.EditorNotice);
            Assert.Equal("Keep me.", vm.EditInstructions);

            await vm.SaveAsync();
            Assert.Equal("Keep me.", svc.Calls.Single(c => c.Op == "create").Draft!.Instructions);
        }

        [Fact]
        public async Task SaveNotFoundSwitchesToCreate()
        {
            var (vm, _, backend) = Live(A);
            await vm.RefreshAsync();
            vm.Select("a");
            vm.StartEdit();
            vm.EditName = "Renamed";
            backend.Skills.Remove("a");
            await vm.SaveAsync();
            Assert.True(vm.IsCreateMode);
            Assert.Equal(SkillsViewModel.DeletedElsewhereNotice, vm.EditorNotice);
            Assert.Equal("Renamed", vm.EditName);
        }

        [Fact]
        public async Task ListIsLockedWhileEditingSoDraftsCannotBeLost()
        {
            var (vm, _, _) = Live(A, B);
            await vm.RefreshAsync();
            vm.Select("a");
            vm.StartEdit();
            Assert.False(vm.IsListInteractive);
            Assert.False(vm.ToggleSelectedCommand.CanExecute(null));
            Assert.False(vm.RequestDeleteCommand.CanExecute(null));
            vm.CancelEdit();
            Assert.True(vm.IsListInteractive);
        }

        // ── Toggle ──────────────────────────────────────────────────────

        [Fact]
        public async Task TogglePendingThenSuccessShowsServerState()
        {
            var svc = new FakeSkillsService();
            var vm = new SkillsViewModel(svc);
            var load = vm.RefreshAsync();
            svc.LastPending("list").Succeed(Summaries(A));
            await load;
            var row = vm.Skills.Single();

            row.IsEnabled = false; // user flips the switch
            Assert.True(row.IsBusy);
            Assert.False(row.IsEnabled);
            Assert.True(row.Summary.Enabled); // confirmed state untouched while pending
            var update = svc.LastPending("update");
            Assert.Equal(1, update.Revision);
            Assert.Equal(new SkillPatch(Enabled: false), update.Patch);

            row.IsEnabled = true; // flipping again while busy does nothing new
            Assert.Equal(1, svc.Count("update"));

            update.Succeed(A with { Enabled = false, Revision = 2 });
            Assert.False(row.IsBusy);
            Assert.False(row.Summary.Enabled);
            Assert.Equal(2, row.Revision);
            Assert.Equal("Disabled “Alpha”.", vm.StatusMessage);
        }

        [Fact]
        public async Task ToggleFailureRollsBackAndRefreshes()
        {
            var (vm, svc, backend) = Live(A);
            await vm.RefreshAsync();
            var row = vm.Skills.Single();
            backend.FailNext["update"] = SkillsErrorKind.StoreUnavailable;

            row.IsEnabled = false;

            Assert.True(row.IsEnabled);
            Assert.True(row.Summary.Enabled);
            Assert.False(row.IsBusy);
            Assert.Equal("msg:StoreUnavailable", vm.ActionError);
            Assert.Equal(2, svc.Count("list"));
        }

        [Fact]
        public async Task ToggleFailureRollsBackImmediatelyEvenIfRefreshNeverAnswers()
        {
            var svc = new FakeSkillsService();
            var vm = new SkillsViewModel(svc);
            var load = vm.RefreshAsync();
            svc.LastPending("list").Succeed(Summaries(A));
            await load;
            var row = vm.Skills.Single();

            row.IsEnabled = false;
            svc.LastPending("update").Fail(SkillsErrorKind.Network);

            Assert.Single(svc.Pending("list")); // follow-up refresh still in flight
            Assert.True(row.IsEnabled);
            Assert.False(row.IsBusy);
            Assert.Equal("Enabled", row.StateText);
            Assert.Equal("msg:Network", vm.ActionError);
        }

        [Fact]
        public async Task ToggleTargetsDisplayedRevisionAndStaleWriteIsRejected()
        {
            var (vm, svc, backend) = Live(A);
            await vm.RefreshAsync();
            var row = vm.Skills.Single();
            backend.Skills["a"] = A with { Revision = 2 }; // unseen newer revision

            row.IsEnabled = false;

            Assert.Equal(1, svc.Calls.Single(c => c.Op == "update").Revision);
            Assert.Equal("msg:RevisionConflict", vm.ActionError);
            Assert.True(row.IsEnabled); // rolled back
            Assert.Equal(2, row.Revision); // refreshed to latest
        }

        [Fact]
        public async Task StaleDetailBlocksToggleEditAndDeleteUntilCurrent()
        {
            var svc = new FakeSkillsService();
            var vm = new SkillsViewModel(svc);
            var load = vm.RefreshAsync();
            svc.LastPending("list").Succeed(Summaries(A));
            await load;
            vm.Select("a");
            svc.LastPending("get").Succeed(A);

            var refresh = vm.RefreshAsync();
            svc.LastPending("list").Succeed(Summaries(A with { Revision = 2 }));
            Assert.False(vm.IsDetailCurrent);
            Assert.True(vm.IsDetailLoading);
            Assert.False(vm.EditCommand.CanExecute(null));
            Assert.False(vm.ToggleSelectedCommand.CanExecute(null));
            Assert.False(vm.RequestDeleteCommand.CanExecute(null));
            vm.Skills.Single().IsEnabled = false;
            Assert.Equal(0, svc.Count("update"));
            Assert.True(vm.Skills.Single().IsEnabled);

            foreach (var g in svc.Pending("get").ToList()) g.Succeed(A with { Instructions = "v2", Revision = 2 });
            await refresh;
            Assert.True(vm.IsDetailCurrent);
            Assert.True(vm.EditCommand.CanExecute(null));
        }

        [Fact]
        public async Task DetailGetOlderThanAConfirmedToggleIsRejected()
        {
            var svc = new FakeSkillsService();
            var vm = new SkillsViewModel(svc);
            var load = vm.RefreshAsync();
            svc.LastPending("list").Succeed(Summaries(A));
            await load;
            vm.Select("a");
            svc.LastPending("get").Succeed(A);

            // Refresh: list + item GET both in flight.
            var refresh = vm.RefreshAsync();
            var staleGet = svc.LastPending("get");
            svc.LastPending("list").Succeed(Summaries(A));

            // Toggle succeeds and installs revision 2; its list reload lands first.
            var toggle = vm.ToggleAsync(vm.Skills.Single(), false);
            var v2 = A with { Enabled = false, Revision = 2 };
            svc.LastPending("update").Succeed(v2);
            svc.LastPending("list").Succeed(Summaries(v2));
            await toggle;

            // The older GET answers last.
            staleGet.Succeed(A);
            await refresh;

            Assert.Equal(2, vm.Detail!.Revision);
            Assert.True(vm.IsDetailCurrent);
            Assert.False(vm.IsDetailLoading);
            Assert.Equal("Alpha instructions.", vm.DetailInstructions);
            Assert.True(vm.EditCommand.CanExecute(null));
            Assert.Empty(svc.Pending("get"));
        }

        [Fact]
        public async Task StaleDetailWithNothingCurrentReloadsOnceThenReportsInsteadOfSpinning()
        {
            var svc = new FakeSkillsService();
            var vm = new SkillsViewModel(svc);
            var load = vm.RefreshAsync();
            svc.LastPending("list").Succeed(Summaries(A with { Revision = 3 }));
            await load;

            vm.Select("a");
            svc.LastPending("get").Succeed(A); // revision 1 < row revision 3
            var retry = Assert.Single(svc.Pending("get"));
            retry.Succeed(A with { Revision = 3, Instructions = "v3" });

            Assert.True(vm.IsDetailCurrent);
            Assert.Equal("v3", vm.DetailInstructions);

            // A backend that keeps answering an older revision: no endless loop.
            var svc2 = new FakeSkillsService();
            var vm2 = new SkillsViewModel(svc2);
            var load2 = vm2.RefreshAsync();
            svc2.LastPending("list").Succeed(Summaries(A with { Revision = 3 }));
            await load2;
            vm2.Select("a");
            svc2.LastPending("get").Succeed(A);
            svc2.LastPending("get").Succeed(A);
            Assert.Empty(svc2.Pending("get"));
            Assert.Equal(2, svc2.Count("get"));
            Assert.True(vm2.HasDetailError);
            Assert.False(vm2.IsDetailLoading);
            Assert.Equal(SkillsViewModel.StaleDetailMessage, vm2.DetailError);
        }

        // ── Saving locks the draft ──────────────────────────────────────

        [Fact]
        public async Task DraftIsNotEditableWhileSaving()
        {
            var svc = new FakeSkillsService();
            var vm = new SkillsViewModel(svc);
            var load = vm.RefreshAsync();
            svc.LastPending("list").Succeed(Summaries());
            await load;
            vm.StartCreate();
            Assert.True(vm.IsDraftEditable);
            vm.EditName = "N";
            vm.EditKeyword = "k";
            vm.EditInstructions = "i";

            var save = vm.SaveAsync();
            Assert.True(vm.IsSaving);
            Assert.False(vm.IsDraftEditable);

            svc.LastPending("create").Succeed(new SkillDto("n1", "N", "k", "i", true, 1));
            svc.LastPending("list").Succeed(Summaries(new SkillDto("n1", "N", "k", "i", true, 1)));
            await save;
            Assert.False(vm.IsEditorOpen);
            Assert.Equal(SkillsViewModel.CreatedMessage, vm.StatusMessage);
        }

        [Fact]
        public async Task EditsThatLandDuringSaveAreKeptNotDiscarded()
        {
            var svc = new FakeSkillsService();
            var vm = new SkillsViewModel(svc);
            var load = vm.RefreshAsync();
            svc.LastPending("list").Succeed(Summaries(A));
            await load;
            vm.Select("a");
            svc.LastPending("get").Succeed(A);
            vm.StartEdit();
            vm.EditInstructions = "First edit.";

            var save = vm.SaveAsync();
            vm.EditInstructions = "Second edit."; // arrives after submission
            var saved = A with { Instructions = "First edit.", Revision = 2 };
            svc.LastPending("update").Succeed(saved);
            svc.LastPending("list").Succeed(Summaries(saved));
            await save;

            Assert.True(vm.IsEditorOpen);
            Assert.False(vm.IsCreateMode);
            Assert.Equal("Second edit.", vm.EditInstructions);
            Assert.Equal(SkillsViewModel.SavedWithLaterEditsNotice, vm.EditorNotice);
            Assert.Equal(2, vm.Skills.Single().Revision);

            // The next save applies the later edit on top of the saved revision.
            var again = vm.SaveAsync();
            var update = svc.LastPending("update");
            Assert.Equal(2, update.Revision);
            Assert.Equal(new SkillPatch(Instructions: "Second edit."), update.Patch);
            update.Succeed(saved with { Instructions = "Second edit.", Revision = 3 });
            svc.LastPending("list").Succeed(Summaries(saved with { Instructions = "Second edit.", Revision = 3 }));
            await again;
            Assert.False(vm.IsEditorOpen);
            Assert.Equal("Second edit.", vm.DetailInstructions);
        }

        // ── Delete ──────────────────────────────────────────────────────

        [Fact]
        public async Task DeleteRequiresConfirmation()
        {
            var (vm, svc, backend) = Live(A, B);
            await vm.RefreshAsync();
            vm.Select("a");

            vm.RequestDeleteCommand.Execute(null);
            Assert.True(vm.HasPendingDelete);
            Assert.Contains("“Alpha”", vm.DeleteConfirmText);
            Assert.Contains("use Stop", vm.DeleteConfirmText);
            Assert.Equal(0, svc.Count("delete"));
            Assert.False(vm.IsListInteractive);

            vm.CancelDelete();
            Assert.False(vm.HasPendingDelete);
            Assert.Equal(0, svc.Count("delete"));

            vm.RequestDeleteCommand.Execute(null);
            await vm.ConfirmDeleteAsync();

            Assert.Equal(1, svc.Calls.Single(c => c.Op == "delete").Revision);
            Assert.DoesNotContain(vm.Skills, r => r.Id == "a");
            Assert.Null(vm.SelectedRow);
            Assert.Null(vm.Detail);
            Assert.Equal("Deleted “Alpha”.", vm.StatusMessage);
            Assert.False(backend.Skills.ContainsKey("a"));
        }

        [Fact]
        public async Task DeleteOfAlreadyDeletedSkillRemovesRow()
        {
            var (vm, _, backend) = Live(A);
            await vm.RefreshAsync();
            vm.Select("a");
            backend.Skills.Remove("a");
            vm.RequestDeleteFor(vm.Skills.Single());
            await vm.ConfirmDeleteAsync();
            Assert.Empty(vm.Skills);
            Assert.Equal("“Alpha” was already deleted.", vm.StatusMessage);
            Assert.Null(vm.ActionError);
        }

        [Fact]
        public async Task StaleDeleteIsRejectedAndRowKept()
        {
            var (vm, _, backend) = Live(A);
            await vm.RefreshAsync();
            vm.Select("a");
            backend.Skills["a"] = A with { Revision = 3 };
            vm.RequestDeleteFor(vm.Skills.Single());
            await vm.ConfirmDeleteAsync();
            Assert.Equal("msg:RevisionConflict", vm.ActionError);
            Assert.Single(vm.Skills);
            Assert.True(backend.Skills.ContainsKey("a"));
        }

        [Fact]
        public async Task RefreshWhileDeletePromptIsOpenKeepsTheConfirmedRevision()
        {
            var (vm, svc, backend) = Live(A);
            await vm.RefreshAsync();
            vm.Select("a");
            vm.RequestDeleteCommand.Execute(null);
            Assert.True(vm.HasPendingDelete);

            // Another client edits the skill; the user refreshes (F5) with
            // the prompt still open.
            backend.Skills["a"] = A with { Name = "Renamed", Instructions = "Unseen.", Revision = 2 };
            await vm.RefreshAsync();
            Assert.Equal(2, vm.Skills.Single().Revision); // the list itself is current
            Assert.True(vm.HasPendingDelete);
            Assert.Contains("“Alpha”", vm.DeleteConfirmText); // what the user is confirming

            await vm.ConfirmDeleteAsync();

            Assert.Equal(1, svc.Calls.Single(c => c.Op == "delete").Revision);
            Assert.Equal("msg:RevisionConflict", vm.ActionError);
            Assert.True(backend.Skills.ContainsKey("a"));
            Assert.Single(vm.Skills);
        }

        [Fact]
        public async Task OlderInFlightListNeverRollsARowRevisionBack()
        {
            var svc = new FakeSkillsService();
            var vm = new SkillsViewModel(svc);
            var load = vm.RefreshAsync();
            svc.LastPending("list").Succeed(Summaries(A));
            await load;
            vm.Select("a");
            svc.LastPending("get").Succeed(A);

            vm.StartEdit();
            vm.EditInstructions = "Mine.";
            var staleList = vm.RefreshAsync(); // editing: list only, stays in flight
            var save = vm.SaveAsync();
            svc.LastPending("update").Fail(SkillsErrorKind.RevisionConflict);
            await save;
            Assert.True(vm.HasConflict);

            var reload = vm.ReloadLatestKeepingDraftAsync();
            svc.LastPending("get").Succeed(A with { Instructions = "Theirs.", Revision = 2 });
            await reload;
            Assert.Equal(2, vm.Skills.Single().Revision);

            // The list request started before the reload answers last, with rev 1.
            svc.LastPending("list").Succeed(Summaries(A));
            await staleList;

            Assert.Equal(2, vm.Skills.Single().Revision);
            Assert.Equal("Mine.", vm.EditInstructions);
        }

        [Fact]
        public async Task UnsafeNamesAreSanitizedForDisplay()
        {
            var (vm, _, _) = Live(A with { Name = "Evil‮name\nx" });
            await vm.RefreshAsync();
            Assert.Equal("Evil name x", vm.Skills.Single().Name);
        }
    }
}
