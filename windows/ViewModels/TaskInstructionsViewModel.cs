using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Linq;
using System.Threading.Tasks;
using System.Windows.Media;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;

namespace OmniKey.Windows.ViewModels
{
    /// <summary>
    /// Wraps a saved template OR the "+ New template" sentinel so the
    /// picker can show both kinds of entries in a single ItemsSource —
    /// mirrors the macOS Picker which always ends with "New template".
    /// </summary>
    internal sealed partial class TemplateChoice : ObservableObject
    {
        public TaskTemplateDto? Template { get; }
        public bool IsNewSlot => Template is null;

        public string DisplayName
        {
            get
            {
                if (Template is null) return _newSlotLabel;
                return Template.IsDefault ? $"★ {Template.Heading}" : Template.Heading;
            }
        }

        private readonly string _newSlotLabel;

        public TemplateChoice(TaskTemplateDto template)
        {
            Template = template;
            _newSlotLabel = string.Empty;
        }

        public TemplateChoice(string newSlotLabel)
        {
            Template = null;
            _newSlotLabel = newSlotLabel;
        }
    }

    internal sealed record ExampleTemplate(string Name, string Content);

    internal enum StatusKind { Neutral, Positive, Negative }

    internal partial class TaskInstructionsViewModel : ObservableObject
    {
        private readonly ApiClient _api = new();

        public ObservableCollection<TemplateChoice> Choices { get; } = new();

        public IReadOnlyList<ExampleTemplate> ExampleTemplates { get; } = new[]
        {
            new ExampleTemplate(
                "Editor – polish my writing",
                "<role>\n" +
                "You are an expert writing editor who improves clarity, tone, and correctness.\n" +
                "</role>\n" +
                "<task>\n" +
                "Rewrite the selected text to be clearer, more concise, and professional while preserving the original meaning and intent.\n" +
                "</task>\n" +
                "<style_guidelines>\n" +
                "- Fix grammar, spelling, and punctuation.\n" +
                "- Prefer clear, direct, and natural phrasing.\n" +
                "- Use a confident, professional, and friendly tone.\n" +
                "- Remove redundancy, filler, and unnecessary verbosity.\n" +
                "- Improve flow and readability (sentence structure, transitions, and word choice).\n" +
                "- Prefer active voice over passive voice when it does not change the meaning.\n" +
                "- Maintain any technical accuracy, domain-specific terminology, and constraints.\n" +
                "- Preserve placeholders, variables, code, URLs, and formatting markers exactly as given.\n" +
                "- Respect the original form: if the text is a list, heading, or bullet points, keep that structure.\n" +
                "</style_guidelines>\n\n" +
                "<output_constraints>\n" +
                "- Output only the revised version of the selected text.\n" +
                "- Do NOT include explanations, commentary, or justification.\n" +
                "- Do NOT add new ideas or information that is not implied by the original text.\n" +
                "- If the original text is incomplete or ambiguous, make the best good-faith edit while keeping intent as close as possible.\n" +
                "</output_constraints>"
            ),
            new ExampleTemplate(
                "Write SQL queries Template",
                "<role>\n" +
                "You are an expert SQL query writer and optimizer.\n" +
                "</role>\n" +
                "<schema>\n" +
                "You are given a database schema. Queries must operate only on the tables, columns, and relationships defined in that schema.\n" +
                "Always reference tables and columns exactly as they appear in the schema.\n" +
                "// copy past your schema here...\n" +
                "</schema>\n" +
                "<task>\n" +
                "- Read only the parts of the user's instructions that mention @omnikeyai and treat them as the single source of truth for the task.\n" +
                "- Generate one or more SQL statements that correctly implement those instructions, based strictly on the provided schema.\n" +
                "- Optimize the SQL for performance, clarity, and maintainability (e.g., appropriate joins, predicates, indexing hints when relevant, and avoiding unnecessary subqueries).\n" +
                "- If anything in the instructions or schema is ambiguous or missing, express your questions, assumptions, or notes **only** as SQL comments using `-- ...` or `/* ... */` within the SQL.\n" +
                "</task>\n" +
                "<output_constraints>\n" +
                "- Your entire response MUST be valid SQL syntax.\n" +
                "- Do NOT return markdown, natural-language explanations, or any text that is not valid SQL.\n" +
                "- Do NOT wrap SQL in code fences or any other formatting; output only raw SQL.\n" +
                "- All non-SQL remarks must appear as inline SQL comments beside or above the relevant SQL.\n" +
                "</output_constraints>"
            ),
        };

        [ObservableProperty]
        private TemplateChoice? selectedChoice;

        [ObservableProperty]
        private string heading = string.Empty;

        [ObservableProperty]
        private string instructions = string.Empty;

        [ObservableProperty]
        private ExampleTemplate? selectedExample;

        [ObservableProperty]
        private string statusMessage = string.Empty;

        [ObservableProperty]
        private StatusKind statusKind = StatusKind.Neutral;

        [ObservableProperty]
        private bool isLoading;

        public bool IsExampleSectionVisible => SelectedChoice?.IsNewSlot ?? true;
        public bool HasAnyDefault => Choices.Any(c => c.Template?.IsDefault == true);
        public bool IsTemplateSelected => SelectedChoice?.Template is not null;
        public bool CanSave => !string.IsNullOrWhiteSpace(Heading) && !IsLoading;

        public Brush StatusBrush => StatusKind switch
        {
            StatusKind.Positive => (Brush)System.Windows.Application.Current.Resources["Nord.AccentGreenBrush"],
            StatusKind.Negative => new SolidColorBrush(Color.FromRgb(252, 100, 100)),
            _ => (Brush)System.Windows.Application.Current.Resources["Nord.SecondaryTextBrush"],
        };

        public TaskInstructionsViewModel()
        {
            Choices.CollectionChanged += (_, _) =>
            {
                OnPropertyChanged(nameof(HasAnyDefault));
                ClearDefaultCommand.NotifyCanExecuteChanged();
            };
        }

        partial void OnSelectedChoiceChanged(TemplateChoice? value)
        {
            if (value is { Template: { } tpl })
            {
                Heading = tpl.Heading;
                Instructions = tpl.Instructions;
            }
            else
            {
                // No selection or "New template" slot: clear the editor.
                Heading = string.Empty;
                Instructions = string.Empty;
            }
            SelectedExample = null;

            OnPropertyChanged(nameof(IsExampleSectionVisible));
            OnPropertyChanged(nameof(IsTemplateSelected));
            DeleteCommand.NotifyCanExecuteChanged();
            SetDefaultCommand.NotifyCanExecuteChanged();
        }

        partial void OnHeadingChanged(string value)
        {
            SaveCommand.NotifyCanExecuteChanged();
        }

        partial void OnIsLoadingChanged(bool value)
        {
            SaveCommand.NotifyCanExecuteChanged();
            DeleteCommand.NotifyCanExecuteChanged();
            SetDefaultCommand.NotifyCanExecuteChanged();
            ClearDefaultCommand.NotifyCanExecuteChanged();
        }

        partial void OnInstructionsChanged(string value)
        {
            if (!IsLoading) SetStatus(string.Empty, StatusKind.Neutral);
        }

        partial void OnStatusKindChanged(StatusKind value)
        {
            OnPropertyChanged(nameof(StatusBrush));
        }

        partial void OnSelectedExampleChanged(ExampleTemplate? value)
        {
            if (value is null || !(SelectedChoice?.IsNewSlot ?? true)) return;
            if (string.IsNullOrWhiteSpace(Heading)) Heading = value.Name;
            Instructions = value.Content;
            SetStatus($"Loaded example \"{value.Name}\".", StatusKind.Positive);
        }

        // ── Commands ──────────────────────────────────────────────────

        [RelayCommand]
        private async Task LoadAsync()
        {
            SetStatus("Loading templates…", StatusKind.Neutral);
            try
            {
                var fetched = await _api.FetchTaskTemplatesAsync();
                RebuildChoices(fetched);

                if (fetched.Count == 0)
                {
                    SelectedChoice = Choices.FirstOrDefault();
                    SetStatus("No saved templates yet.", StatusKind.Neutral);
                }
                else
                {
                    var def = fetched.FirstOrDefault(t => t.IsDefault) ?? fetched[0];
                    SelectByTemplateId(def.Id);
                    SetStatus("Templates loaded.", StatusKind.Positive);
                }
            }
            catch (Exception ex)
            {
                SetStatus("Failed to load templates: " + ex.Message, StatusKind.Negative);
            }
        }

        [RelayCommand(CanExecute = nameof(CanSave))]
        private async Task SaveAsync()
        {
            var heading = Heading.Trim();
            if (string.IsNullOrWhiteSpace(heading)) return;

            IsLoading = true;
            SetStatus("Saving…", StatusKind.Neutral);
            try
            {
                TaskTemplateDto saved;
                if (SelectedChoice?.Template is { } existing)
                {
                    saved = await _api.UpdateTaskTemplateAsync(existing.Id, heading, Instructions);
                    SetStatus("Template updated.", StatusKind.Positive);
                }
                else
                {
                    saved = await _api.CreateTaskTemplateAsync(heading, Instructions);
                    SetStatus("Template created.", StatusKind.Positive);
                }

                ReplaceOrAdd(saved);
                SelectByTemplateId(saved.Id);
            }
            catch (Exception ex)
            {
                SetStatus("Failed to save: " + ex.Message, StatusKind.Negative);
            }
            finally
            {
                IsLoading = false;
            }
        }

        private bool CanDelete() => IsTemplateSelected && !IsLoading;

        [RelayCommand(CanExecute = nameof(CanDelete))]
        private async Task DeleteAsync()
        {
            if (SelectedChoice?.Template is not { } target) return;
            IsLoading = true;
            SetStatus("Deleting…", StatusKind.Neutral);
            try
            {
                await _api.DeleteTaskTemplateAsync(target.Id);
                RemoveTemplate(target.Id);
                SelectedChoice = Choices.FirstOrDefault();
                SetStatus("Template deleted.", StatusKind.Positive);
            }
            catch (Exception ex)
            {
                SetStatus("Failed to delete: " + ex.Message, StatusKind.Negative);
            }
            finally
            {
                IsLoading = false;
            }
        }

        private bool CanSetDefault() => IsTemplateSelected && !IsLoading;

        [RelayCommand(CanExecute = nameof(CanSetDefault))]
        private async Task SetDefaultAsync()
        {
            if (SelectedChoice?.Template is not { } target) return;
            IsLoading = true;
            SetStatus("Setting default…", StatusKind.Neutral);
            try
            {
                var updated = await _api.SetDefaultTaskTemplateAsync(target.Id);
                RebuildChoices(Choices
                    .Where(c => c.Template is not null)
                    .Select(c => c.Template!)
                    .Select(t => new TaskTemplateDto
                    {
                        Id = t.Id,
                        Heading = t.Heading,
                        Instructions = t.Instructions,
                        IsDefault = t.Id == updated.Id,
                    })
                    .ToList());
                SelectByTemplateId(updated.Id);
                SetStatus("Default template set for Ctrl+T.", StatusKind.Positive);
            }
            catch (Exception ex)
            {
                SetStatus("Failed to set default: " + ex.Message, StatusKind.Negative);
            }
            finally
            {
                IsLoading = false;
            }
        }

        private bool CanClearDefault() => HasAnyDefault && !IsLoading;

        [RelayCommand(CanExecute = nameof(CanClearDefault))]
        private async Task ClearDefaultAsync()
        {
            IsLoading = true;
            SetStatus("Clearing default…", StatusKind.Neutral);
            try
            {
                await _api.ClearDefaultTaskTemplateAsync();
                var currentId = SelectedChoice?.Template?.Id;
                RebuildChoices(Choices
                    .Where(c => c.Template is not null)
                    .Select(c => c.Template!)
                    .Select(t => new TaskTemplateDto
                    {
                        Id = t.Id,
                        Heading = t.Heading,
                        Instructions = t.Instructions,
                        IsDefault = false,
                    })
                    .ToList());
                if (currentId is not null) SelectByTemplateId(currentId);
                SetStatus("Default cleared — no template is set for Ctrl+T.", StatusKind.Positive);
            }
            catch (Exception ex)
            {
                SetStatus("Failed to clear default: " + ex.Message, StatusKind.Negative);
            }
            finally
            {
                IsLoading = false;
            }
        }

        [RelayCommand]
        private void NewTemplate()
        {
            var newSlot = Choices.FirstOrDefault(c => c.IsNewSlot);
            if (newSlot is null) return;
            Heading = string.Empty;
            Instructions = string.Empty;
            SelectedChoice = newSlot;
            SetStatus("Creating new template.", StatusKind.Neutral);
        }

        // ── Helpers ───────────────────────────────────────────────────

        private void RebuildChoices(List<TaskTemplateDto> templates)
        {
            Choices.Clear();
            foreach (var t in templates) Choices.Add(new TemplateChoice(t));
            Choices.Add(new TemplateChoice(templates.Count == 0 ? "No templates yet" : "New template"));
            OnPropertyChanged(nameof(HasAnyDefault));
            ClearDefaultCommand.NotifyCanExecuteChanged();
        }

        private void ReplaceOrAdd(TaskTemplateDto template)
        {
            for (int i = 0; i < Choices.Count; i++)
            {
                if (Choices[i].Template is { } existing && existing.Id == template.Id)
                {
                    Choices[i] = new TemplateChoice(template);
                    return;
                }
            }
            // Otherwise insert before the trailing new-slot.
            int insertAt = Choices.Count - 1;
            if (insertAt < 0) insertAt = 0;
            Choices.Insert(insertAt, new TemplateChoice(template));

            // Refresh new-slot label if we just transitioned from empty.
            if (Choices.LastOrDefault()?.IsNewSlot == true)
            {
                Choices[^1] = new TemplateChoice("New template");
            }
        }

        private void RemoveTemplate(string id)
        {
            for (int i = 0; i < Choices.Count; i++)
            {
                if (Choices[i].Template is { } t && t.Id == id)
                {
                    Choices.RemoveAt(i);
                    break;
                }
            }
            // If only the new-slot is left, relabel it.
            if (Choices.Count == 1 && Choices[0].IsNewSlot)
            {
                Choices[0] = new TemplateChoice("No templates yet");
            }
        }

        private void SelectByTemplateId(string id)
        {
            SelectedChoice = Choices.FirstOrDefault(c => c.Template?.Id == id) ?? Choices.FirstOrDefault();
        }

        private void SetStatus(string text, StatusKind kind)
        {
            StatusMessage = text;
            StatusKind = kind;
        }
    }
}
