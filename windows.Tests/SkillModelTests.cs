using System.Linq;
using OmniKey.Windows.Skills;
using Xunit;

namespace OmniKey.Windows.Tests
{
    public class SkillModelTests
    {
        private static readonly SkillDto Base = new("s1", "Review", "code review", "Check edge cases.", true, 1);

        [Fact]
        public void PatchDiffContainsOnlyChangedFields()
        {
            var draft = SkillDraft.From(Base) with { Instructions = "New text." };
            var patch = SkillPatch.Diff(Base, draft);
            Assert.Equal(new SkillPatch(Instructions: "New text."), patch);
            Assert.Equal(new[] { "instructions" }, patch.ToJsonObject().Keys.ToArray());
            Assert.True(SkillPatch.Diff(Base, SkillDraft.From(Base)).IsEmpty);
        }

        [Fact]
        public void RebaseAdoptsUntouchedFieldsAndKeepsLocalEdits()
        {
            var draft = SkillDraft.From(Base) with { Instructions = "Mine." };
            var latest = Base with { Name = "Renamed elsewhere", Enabled = false, Revision = 2 };

            var r = SkillDraftRebase.Merge(draft, Base, latest);

            Assert.Equal(new SkillDraft("Renamed elsewhere", "code review", "Mine.", false), r.Draft);
            Assert.Empty(r.Conflicts);
            Assert.Equal(new[] { SkillField.Name, SkillField.Enabled }, r.Adopted);
        }

        [Fact]
        public void RebaseReportsSameFieldConflictAndKeepsDraft()
        {
            var draft = SkillDraft.From(Base) with { Keyword = "sql review" };
            var latest = Base with { Keyword = "db review", Revision = 3 };

            var r = SkillDraftRebase.Merge(draft, Base, latest);

            Assert.Equal("sql review", r.Draft.Keyword);
            Assert.Equal(new[] { SkillField.Keyword }, r.Conflicts);
        }

        [Fact]
        public void RebaseEqualEditsOnBothSidesAreNotConflicts()
        {
            var draft = SkillDraft.From(Base) with { Name = "Same" };
            var r = SkillDraftRebase.Merge(draft, Base, Base with { Name = "Same", Revision = 2 });
            Assert.Empty(r.Conflicts);
            Assert.Equal("Same", r.Draft.Name);
        }

        [Fact]
        public void CodePointsCountScalarsNotUtf16Units()
        {
            Assert.Equal(1, SkillLimits.CodePoints("😀"));
            Assert.Equal(2, SkillLimits.CodePoints("é"));
            Assert.Equal(4, SkillLimits.Utf8Bytes("😀"));
            Assert.Equal(0, SkillLimits.CodePoints(null));
        }
    }
}
