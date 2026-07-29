using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;

namespace OmniKey.Windows.ViewModels
{
    /// <summary>
    /// Concise display text for agent timeline/tool blocks. Mirrors the macOS
    /// AgentTimelineSummarizer so Windows shows readable step summaries instead
    /// of raw shell, MCP, web, or terminal payloads.
    /// </summary>
    internal static class AgentTimelineSummarizer
    {
        private enum DisplayKind
        {
            AgentReasoning,
            ShellCommand,
            TerminalOutput,
            WebCall,
            McpCall,
            ImageRendering,
            FinalAnswer,
        }

        private readonly record struct Summary(string Collapsed, string Expanded);

        public static string CollapsedSummary(ChatBlockKind kind, string text) =>
            Summarize(DisplayKindFor(kind), text).Collapsed;

        public static string ExpandedSummary(ChatBlockKind kind, string text) =>
            Summarize(DisplayKindFor(kind), text).Expanded;

        public static string CollapsedSummary(TimelineKind kind, string text) =>
            Summarize(DisplayKindFor(kind), text).Collapsed;

        public static string ExpandedSummary(TimelineKind kind, string text) =>
            Summarize(DisplayKindFor(kind), text).Expanded;

        private static DisplayKind DisplayKindFor(ChatBlockKind kind) => kind switch
        {
            ChatBlockKind.AgentReasoning => DisplayKind.AgentReasoning,
            ChatBlockKind.ShellCommand => DisplayKind.ShellCommand,
            ChatBlockKind.TerminalOutput => DisplayKind.TerminalOutput,
            ChatBlockKind.WebCall => DisplayKind.WebCall,
            ChatBlockKind.McpCall => DisplayKind.McpCall,
            ChatBlockKind.ImageRendering => DisplayKind.ImageRendering,
            ChatBlockKind.FinalAnswer => DisplayKind.FinalAnswer,
            _ => DisplayKind.AgentReasoning,
        };

        private static DisplayKind DisplayKindFor(TimelineKind kind) => kind switch
        {
            TimelineKind.Web => DisplayKind.WebCall,
            TimelineKind.Mcp => DisplayKind.McpCall,
            TimelineKind.Terminal => DisplayKind.TerminalOutput,
            TimelineKind.Reasoning => DisplayKind.AgentReasoning,
            _ => DisplayKind.AgentReasoning,
        };

        private static Summary Summarize(DisplayKind kind, string text) => kind switch
        {
            DisplayKind.ShellCommand => SummarizeShellCommand(text),
            DisplayKind.TerminalOutput => SummarizeTerminalOutput(text),
            DisplayKind.McpCall => SummarizeMcp(text),
            DisplayKind.WebCall => SummarizeWebCall(text),
            DisplayKind.ImageRendering => SummarizeGeneric(text, "Image task updated"),
            _ => SummarizeGeneric(text, ""),
        };

        private static Summary SummarizeShellCommand(string text)
        {
            var lines = MeaningfulLines(text)
                .Where(line => !IsShellBoilerplate(line))
                .Take(4)
                .Select(CommandDescription)
                .ToList();

            if (lines.Count == 0)
            {
                return new Summary(
                    "Running a shell script",
                    "Running a shell script. No concise command preview is available.");
            }

            string collapsed = Truncate(lines[0], 160);
            string bullets = string.Join("\n", lines.Select(line => "- " + line));
            int totalLines = MeaningfulLines(text).Count;
            string suffix = totalLines > lines.Count
                ? $"\n- Plus {totalLines - lines.Count} additional script line(s)."
                : "";
            return new Summary(collapsed, $"Running shell script:\n{bullets}{suffix}");
        }

        private static Summary SummarizeTerminalOutput(string text)
        {
            var parts = TerminalParts(text);
            string body = parts.Body.Trim();
            var lines = MeaningfulLines(body);
            string status = parts.IsError ? "Command failed" : "Command finished";
            string statusText = parts.StatusLabel is { Length: > 0 }
                ? $"{status} ({parts.StatusLabel})"
                : status;

            if (body.Length == 0)
            {
                return new Summary(
                    $"{statusText} with no output",
                    $"{statusText}.\n- Output: no text was produced.");
            }

            string preview = PreviewText(lines, body);
            string collapsed = Truncate($"{statusText}: {preview}", 180);
            string expanded = string.Join("\n", new[]
            {
                $"{statusText}.",
                $"- Output size: {lines.Count} line{(lines.Count == 1 ? "" : "s")}, {body.Length} characters.",
                $"- Key output: {preview}",
            });
            return new Summary(collapsed, expanded);
        }

        private static Summary SummarizeMcp(string text)
        {
            string trimmed = text.Trim();
            string? toolName = ExtractToolName(trimmed, "Calling MCP tool:", "Tool:");
            string body = ResultBody(trimmed);

            if (!string.IsNullOrWhiteSpace(toolName) && string.IsNullOrWhiteSpace(body))
            {
                string label = $"Calling MCP tool {toolName}";
                return new Summary(label, label);
            }

            string target = !string.IsNullOrWhiteSpace(toolName) ? $"MCP tool {toolName}" : "MCP tool";
            var result = ResultSummary(string.IsNullOrWhiteSpace(body) ? trimmed : body);
            return new Summary(
                Truncate($"{target}: {result.Collapsed}", 180),
                $"{target} returned a result.\n{result.Expanded}");
        }

        private static Summary SummarizeWebCall(string text)
        {
            string trimmed = text.Trim();
            string? toolName = ExtractToolName(trimmed, "Tool:");
            string body = ResultBody(trimmed);

            if (!string.IsNullOrWhiteSpace(toolName))
            {
                var result = ResultSummary(body);
                return new Summary(
                    Truncate($"{toolName}: {result.Collapsed}", 180),
                    $"Web tool {toolName} returned a result.\n{result.Expanded}");
            }

            return SummarizeGeneric(trimmed, "Web activity updated");
        }

        private static Summary SummarizeGeneric(string text, string fallback)
        {
            string trimmed = text.Trim();
            if (trimmed.Length == 0) return new Summary(fallback, fallback);
            string preview = PreviewText(MeaningfulLines(trimmed), trimmed);
            return new Summary(Truncate(preview, 180), Truncate(preview, 600));
        }

        private static Summary ResultSummary(string text)
        {
            string trimmed = text.Trim();
            if (trimmed.Length == 0)
                return new Summary("No result text", "- Result: no text was returned.");

            if (DescribeJson(trimmed) is { } jsonDescription)
            {
                string preview = PreviewText(MeaningfulLines(trimmed), trimmed);
                return new Summary(
                    jsonDescription,
                    $"- Result shape: {jsonDescription}.\n- Preview: {preview}");
            }

            var lines = MeaningfulLines(trimmed);
            string bodyPreview = PreviewText(lines, trimmed);
            return new Summary(
                bodyPreview,
                $"- Result size: {lines.Count} line{(lines.Count == 1 ? "" : "s")}, {trimmed.Length} characters.\n- Preview: {bodyPreview}");
        }

        private static (string? StatusLabel, bool IsError, string Body) TerminalParts(string text)
        {
            string trimmed = text.Trim();
            var lines = trimmed.Split('\n').ToList();
            string first = lines.FirstOrDefault()?.Trim() ?? "";

            if (first.StartsWith("[terminal ", StringComparison.OrdinalIgnoreCase))
            {
                lines.RemoveAt(0);
                string status = first
                    .Replace("[terminal ", "", StringComparison.OrdinalIgnoreCase)
                    .Replace("]", "")
                    .Trim();
                return (status, status.Contains("error", StringComparison.OrdinalIgnoreCase), string.Join("\n", lines));
            }

            if (string.Equals(first, "command error", StringComparison.OrdinalIgnoreCase))
            {
                lines.RemoveAt(0);
                return ("error", true, string.Join("\n", lines));
            }

            return (null, false, trimmed);
        }

        private static string ResultBody(string text)
        {
            var parts = text.Split(new[] { "\n\n" }, StringSplitOptions.None);
            if (parts.Length <= 1) return "";
            return string.Join("\n\n", parts.Skip(1)).Trim();
        }

        private static string? ExtractToolName(string text, params string[] prefixes)
        {
            string firstLine = text.Split('\n').FirstOrDefault()?.Trim() ?? "";
            foreach (string prefix in prefixes)
            {
                if (!firstLine.StartsWith(prefix, StringComparison.Ordinal)) continue;
                string name = firstLine[prefix.Length..].Trim();
                return name.Length == 0 ? null : name;
            }
            return null;
        }

        private static List<string> MeaningfulLines(string text) =>
            text.Split('\n')
                .Select(NormalizeInlineWhitespace)
                .Where(line =>
                    line.Length > 0 &&
                    !string.Equals(line, "TERMINAL OUTPUT:", StringComparison.Ordinal) &&
                    !string.Equals(line, "COMMAND ERROR:", StringComparison.Ordinal))
                .ToList();

        private static bool IsShellBoilerplate(string line)
        {
            string lower = line.ToLowerInvariant();
            return lower is "set -e" or "set -eu" or "set -euo pipefail" or "set -o pipefail"
                or "then" or "do" or "done" or "fi"
                || lower.StartsWith("#", StringComparison.Ordinal);
        }

        private static string CommandDescription(string line)
        {
            string trimmed = line.Trim();
            string lower = trimmed.ToLowerInvariant();

            if (lower.StartsWith("cd ", StringComparison.Ordinal)) return $"Change directory to {Truncate(trimmed[3..], 80)}";
            if (lower.StartsWith("git ", StringComparison.Ordinal)) return $"Run git {Truncate(trimmed[4..], 100)}";
            if (lower.StartsWith("rg ", StringComparison.Ordinal)) return "Search files with ripgrep";
            if (lower.StartsWith("grep ", StringComparison.Ordinal)) return "Search text with grep";
            if (lower.StartsWith("find ", StringComparison.Ordinal)) return "Find matching files";
            if (lower.StartsWith("sed ", StringComparison.Ordinal)) return "Read a selected range of a file";
            if (lower.StartsWith("cat ", StringComparison.Ordinal)) return "Read file contents";
            if (lower.StartsWith("sqlite3 ", StringComparison.Ordinal)) return "Query the local SQLite database";
            if (lower.StartsWith("npm ", StringComparison.Ordinal) ||
                lower.StartsWith("yarn ", StringComparison.Ordinal) ||
                lower.StartsWith("pnpm ", StringComparison.Ordinal))
                return $"Run package script: {Truncate(trimmed, 120)}";
            if (lower.StartsWith("dotnet ", StringComparison.Ordinal) ||
                lower.StartsWith("msbuild ", StringComparison.Ordinal))
                return $"Run Windows build command: {Truncate(trimmed, 120)}";
            if (lower.StartsWith("python ", StringComparison.Ordinal) ||
                lower.StartsWith("python3 ", StringComparison.Ordinal) ||
                lower.StartsWith("py ", StringComparison.Ordinal))
                return "Run Python helper script";
            if (lower.StartsWith("node ", StringComparison.Ordinal)) return "Run Node.js helper script";

            return Truncate(trimmed, 140);
        }

        private static string PreviewText(IReadOnlyList<string> lines, string fallback)
        {
            var candidates = lines.Count == 0 ? MeaningfulLines(fallback) : lines;
            string preview = string.Join("; ", candidates.Take(3).Select(line => Truncate(line, 120)));
            if (preview.Length > 0) return Truncate(preview, 260);
            return Truncate(NormalizeInlineWhitespace(fallback), 260);
        }

        private static string? DescribeJson(string text)
        {
            string trimmed = text.Trim();
            if (!trimmed.StartsWith("{", StringComparison.Ordinal) &&
                !trimmed.StartsWith("[", StringComparison.Ordinal))
                return null;

            try
            {
                using var doc = JsonDocument.Parse(trimmed);
                return doc.RootElement.ValueKind switch
                {
                    JsonValueKind.Object => $"JSON object with {doc.RootElement.EnumerateObject().Count()} field{(doc.RootElement.EnumerateObject().Count() == 1 ? "" : "s")}",
                    JsonValueKind.Array => $"JSON array with {doc.RootElement.GetArrayLength()} item{(doc.RootElement.GetArrayLength() == 1 ? "" : "s")}",
                    _ => "JSON value",
                };
            }
            catch
            {
                return null;
            }
        }

        private static string NormalizeInlineWhitespace(string text) =>
            string.Join(" ", text.Trim().Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));

        private static string Truncate(string text, int max)
        {
            if (text.Length <= max) return text;
            return text[..max].Trim() + "...";
        }
    }
}
