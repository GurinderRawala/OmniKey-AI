using System;
using System.Collections.Generic;
using System.Text;

namespace OmniKey.Windows.Skills
{
    // Skills v1 wire models (mirror docs/skills-contract.md and macOS Skill.swift).
    //
    // Skills are owned by the backend. The app keeps no local copy and never
    // matches keywords itself; it only renders what the API returns.
    // Everything in this folder is platform-neutral (no WPF/WinForms/registry)
    // so windows.Tests can compile it on any OS.

    internal static class SkillLimits
    {
        public const int Saved = 100;
        public const int NameCodePoints = 80;
        public const int KeywordCodePoints = 80;
        public const int InstructionCodePoints = 8_000;
        public const int InstructionBytes = 32_768;

        /// <summary>Unicode scalar count, matching the backend's code-point
        /// limits (a lone surrogate counts as one, like a replacement char).</summary>
        public static int CodePoints(string? text)
        {
            if (string.IsNullOrEmpty(text)) return 0;
            int count = 0;
            foreach (var _ in text.EnumerateRunes()) count++;
            return count;
        }

        public static int Utf8Bytes(string? text) =>
            string.IsNullOrEmpty(text) ? 0 : Encoding.UTF8.GetByteCount(text);
    }

    /// <summary>List row. The list endpoint never includes instruction text.</summary>
    internal sealed record SkillSummary(
        string Id,
        string Name,
        string Keyword,
        bool Enabled,
        int Revision,
        string? CreatedAt = null,
        string? UpdatedAt = null);

    /// <summary>Full skill returned by item/create/patch endpoints.</summary>
    internal sealed record SkillDto(
        string Id,
        string Name,
        string Keyword,
        string Instructions,
        bool Enabled,
        int Revision,
        string? CreatedAt = null,
        string? UpdatedAt = null)
    {
        public SkillSummary ToSummary() =>
            new(Id, Name, Keyword, Enabled, Revision, CreatedAt, UpdatedAt);
    }

    /// <summary>Reference carried in live status notices. Never contains instructions.</summary>
    internal sealed record AppliedSkillRef(string Id, string Name, string Keyword, int Revision);

    internal sealed record SkillWarning(string Code, string? SkillId, string? Message);

    /// <summary>Editable fields for the create/edit form.</summary>
    internal sealed record SkillDraft(
        string Name = "",
        string Keyword = "",
        string Instructions = "",
        bool Enabled = true)
    {
        public static SkillDraft From(SkillDto skill) =>
            new(skill.Name, skill.Keyword, skill.Instructions, skill.Enabled);
    }

    internal enum SkillField { Name, Keyword, Instructions, Enabled }

    internal static class SkillFieldLabels
    {
        public static string Label(SkillField field) => field switch
        {
            SkillField.Name => "Name",
            SkillField.Keyword => "Keyword",
            SkillField.Instructions => "Instructions",
            SkillField.Enabled => "Enabled",
            _ => field.ToString(),
        };
    }

    /// <summary>
    /// Three-way merge used after a revision conflict. Per field: untouched
    /// locally → adopt the latest server value; edited locally only → keep the
    /// draft; edited on both sides to different values → keep the draft and
    /// report the field so the user reconciles explicitly. Never a silent
    /// stale overwrite of a field the user did not touch.
    /// </summary>
    internal sealed record SkillDraftRebase(
        SkillDraft Draft,
        IReadOnlyList<SkillField> Conflicts,
        IReadOnlyList<SkillField> Adopted)
    {
        public static SkillDraftRebase Merge(SkillDraft draft, SkillDto original, SkillDto latest)
        {
            var conflicts = new List<SkillField>();
            var adopted = new List<SkillField>();

            T Resolve<T>(SkillField field, T mine, T baseValue, T theirs)
            {
                var cmp = EqualityComparer<T>.Default;
                if (cmp.Equals(mine, baseValue))
                {
                    if (!cmp.Equals(theirs, baseValue)) adopted.Add(field);
                    return theirs;
                }
                if (!cmp.Equals(theirs, baseValue) && !cmp.Equals(theirs, mine))
                    conflicts.Add(field);
                return mine;
            }

            var merged = new SkillDraft(
                Resolve(SkillField.Name, draft.Name, original.Name, latest.Name),
                Resolve(SkillField.Keyword, draft.Keyword, original.Keyword, latest.Keyword),
                Resolve(SkillField.Instructions, draft.Instructions, original.Instructions, latest.Instructions),
                Resolve(SkillField.Enabled, draft.Enabled, original.Enabled, latest.Enabled));

            return new SkillDraftRebase(merged, conflicts, adopted);
        }
    }

    /// <summary>Partial update; null fields are omitted from the PATCH body.</summary>
    internal sealed record SkillPatch(
        string? Name = null,
        string? Keyword = null,
        string? Instructions = null,
        bool? Enabled = null)
    {
        public bool IsEmpty => Name is null && Keyword is null && Instructions is null && Enabled is null;

        /// <summary>Only fields the user actually changed relative to the loaded skill.</summary>
        public static SkillPatch Diff(SkillDto baseSkill, SkillDraft draft) => new(
            Name: draft.Name != baseSkill.Name ? draft.Name : null,
            Keyword: draft.Keyword != baseSkill.Keyword ? draft.Keyword : null,
            Instructions: draft.Instructions != baseSkill.Instructions ? draft.Instructions : null,
            Enabled: draft.Enabled != baseSkill.Enabled ? draft.Enabled : null);

        public Dictionary<string, object> ToJsonObject()
        {
            var payload = new Dictionary<string, object>();
            if (Name is not null) payload["name"] = Name;
            if (Keyword is not null) payload["keyword"] = Keyword;
            if (Instructions is not null) payload["instructions"] = Instructions;
            if (Enabled is bool enabled) payload["enabled"] = enabled;
            return payload;
        }
    }
}
