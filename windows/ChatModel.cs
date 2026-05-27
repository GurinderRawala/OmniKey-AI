using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace OmniKey.Windows
{
    internal enum ChatMessageRole
    {
        User,
        Assistant,
        System
    }

    internal enum ChatBlockKind
    {
        AgentReasoning,
        ShellCommand,
        TerminalOutput,
        WebCall,
        McpCall,
        ImageRendering,
        FinalAnswer
    }

    internal sealed class ChatBlock
    {
        public Guid Id { get; } = Guid.NewGuid();
        public ChatBlockKind Kind { get; }
        public string Text { get; set; }

        public ChatBlock(ChatBlockKind kind, string text)
        {
            Kind = kind;
            Text = text;
        }
    }

    internal sealed class ChatMessage
    {
        public Guid Id { get; } = Guid.NewGuid();
        public ChatMessageRole Role { get; }
        public string Text { get; set; }
        public List<ChatBlock> Blocks { get; set; }

        private ChatMessage(ChatMessageRole role, string text, List<ChatBlock>? blocks = null)
        {
            Role = role;
            Text = text;
            Blocks = blocks ?? new List<ChatBlock>();
        }

        public static ChatMessage User(string text) => new(ChatMessageRole.User, text);
        public static ChatMessage Assistant() => new(ChatMessageRole.Assistant, "");
        public static ChatMessage System(string text) => new(ChatMessageRole.System, text);
    }

    internal sealed class ChatSessionState
    {
        public List<ChatMessage> Messages { get; set; } = new();
        public int TrimmedOlderMessageCount { get; set; }
        public bool IsRunning { get; set; }
        public ChatSessionRunHandle? RunHandle { get; set; }
        public int? StreamingAssistantIndex { get; set; }
    }

    internal sealed class ChatModel
    {
        public static readonly ChatModel Shared = new();
        public const int MaxVisibleMessages = 30;

        private const string PendingNewChatKey = "__pending_new__";
        private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(30) };

        private readonly ApiClient _apiClient = new();
        private readonly Dictionary<string, ChatSessionState> _states = new();
        private SynchronizationContext? _syncContext;

        private string _sessionSearchQuery = "";
        private string? _activeSessionId;
        private string _activeSessionTitle = "New Chat";
        private string? _lastErrorMessage;
        private string _inputText = "";

        private ChatModel()
        {
            _states[PendingNewChatKey] = new ChatSessionState();
        }

        public event EventHandler? StateChanged;

        public List<AgentSessionInfo> Sessions { get; private set; } = new();

        public string SessionSearchQuery
        {
            get => _sessionSearchQuery;
            set
            {
                if (_sessionSearchQuery == value) return;
                _sessionSearchQuery = value;
                NotifyStateChanged();
            }
        }

        public string? ActiveSessionId
        {
            get => _activeSessionId;
            private set
            {
                if (_activeSessionId == value) return;
                _activeSessionId = value;
                NotifyStateChanged();
            }
        }

        public string ActiveSessionTitle
        {
            get => _activeSessionTitle;
            private set
            {
                if (_activeSessionTitle == value) return;
                _activeSessionTitle = value;
                NotifyStateChanged();
            }
        }

        public List<ChatMessage> Messages { get; private set; } = new();
        public bool IsLoadingSessionHistory { get; private set; }
        public bool IsRunning { get; private set; }

        public string? LastErrorMessage
        {
            get => _lastErrorMessage;
            private set
            {
                if (_lastErrorMessage == value) return;
                _lastErrorMessage = value;
                NotifyStateChanged();
            }
        }

        public string InputText
        {
            get => _inputText;
            set
            {
                if (_inputText == value) return;
                _inputText = value;
                NotifyStateChanged();
            }
        }

        public TaskTemplateDto? DefaultTaskTemplate { get; private set; }
        public List<TaskTemplateDto> AvailableTaskTemplates { get; private set; } = new();
        public bool IsUpdatingDefaultTaskTemplate { get; private set; }
        public int TrimmedOlderMessageCount { get; private set; }

        public AgentSessionInfo? ActiveSession =>
            ActiveSessionId == null ? null : Sessions.FirstOrDefault(s => s.Id == ActiveSessionId);

        public List<AgentSessionInfo> FilteredSessions
        {
            get
            {
                string query = SessionSearchQuery.Trim();
                if (query.Length == 0)
                    return Sessions;

                var tokens = NormalizeSearchText(query)
                    .Split(' ', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
                if (tokens.Length == 0)
                    return Sessions;

                return Sessions
                    .Where(session =>
                    {
                        string haystack = NormalizeSearchText(session.Title ?? "");
                        return tokens.All(haystack.Contains);
                    })
                    .ToList();
            }
        }

        public bool IsSessionSearchActive => SessionSearchQuery.Trim().Length > 0;

        public void BindToCurrentThread()
        {
            _syncContext = SynchronizationContext.Current;
        }

        public void ClearSessionSearch()
        {
            SessionSearchQuery = "";
        }

        public void RefreshSessions(Action? completion = null)
        {
            _ = RefreshSessionsAsync(completion);
        }

        public void StartNewChat()
        {
            savePublishedToActiveState();

            ActiveSessionId = null;
            ActiveSessionTitle = "New Chat";
            LastErrorMessage = null;
            IsLoadingSessionHistory = false;

            var fresh = new ChatSessionState();
            _states[PendingNewChatKey] = fresh;
            loadState(fresh);

            DefaultTaskTemplate = null;
            FetchDefaultTaskTemplate();
            NotifyStateChanged();
        }

        public void OpenSession(AgentSessionInfo session)
        {
            savePublishedToActiveState();

            ActiveSessionId = session.Id;
            ActiveSessionTitle = string.IsNullOrWhiteSpace(session.Title) ? "Untitled Chat" : session.Title;
            LastErrorMessage = null;
            IsLoadingSessionHistory = true;

            loadState(sessionState(session.Id));

            DefaultTaskTemplate = null;
            FetchDefaultTaskTemplate();
            NotifyStateChanged();

            _ = LoadSessionHistoryAsync(session.Id);
        }

        public void DeleteSession(AgentSessionInfo session)
        {
            if (_states.TryGetValue(session.Id, out var state))
                state.RunHandle?.Cancel();

            _ = DeleteSessionAsync(session);
        }

        public void SendCurrentInput()
        {
            string text = InputText.Trim();
            if (text.Length == 0)
                return;

            var currentState = sessionState(activeStateKey);
            if (currentState.IsRunning)
                return;

            InputText = "";
            LastErrorMessage = null;

            string sessionId = ActiveSessionId ?? Guid.NewGuid().ToString();
            ChatSessionState sessionSt;
            if (ActiveSessionId == null)
            {
                sessionSt = currentState;
                _states[sessionId] = sessionSt;
                _states.Remove(PendingNewChatKey);
            }
            else
            {
                sessionSt = currentState;
            }

            sessionSt.Messages.Add(ChatMessage.User(text));
            sessionSt.Messages.Add(ChatMessage.Assistant());
            enforceMessageCap(sessionSt);
            sessionSt.StreamingAssistantIndex = sessionSt.Messages.Count - 1;
            sessionSt.IsRunning = true;

            Messages = new List<ChatMessage>(sessionSt.Messages);
            TrimmedOlderMessageCount = sessionSt.TrimmedOlderMessageCount;
            IsRunning = true;

            if (ActiveSessionId == null)
            {
                string title = text.Length > 60 ? text[..60] : text;
                var placeholder = new AgentSessionInfo
                {
                    Id = sessionId,
                    Title = string.IsNullOrWhiteSpace(title) ? "New Chat" : title,
                    Platform = "windows",
                    Turns = 0,
                    RemainingContextTokens = 0,
                    LastActiveAt = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture),
                };

                Sessions.RemoveAll(s => s.Id == sessionId);
                Sessions.Insert(0, placeholder);
                ActiveSessionId = sessionId;
                ActiveSessionTitle = placeholder.Title;
            }

            var handle = ChatSessionRunner.Shared.Run(
                sessionId,
                text,
                block => RunOnUi(() => appendBlock(block, sessionSt)),
                finalText => RunOnUi(() =>
                {
                    appendBlock(new ChatBlock(ChatBlockKind.FinalAnswer, finalText), sessionSt);
                    sessionSt.IsRunning = false;
                    sessionSt.RunHandle = null;
                    sessionSt.StreamingAssistantIndex = null;
                    if (ReferenceEquals(_states.GetValueOrDefault(activeStateKey), sessionSt))
                        IsRunning = false;
                    NotifyStateChanged();
                    RefreshSessions();
                }),
                error => RunOnUi(() =>
                {
                    appendBlock(new ChatBlock(ChatBlockKind.FinalAnswer, $"**Error:** {error.Message}"), sessionSt);
                    sessionSt.IsRunning = false;
                    sessionSt.RunHandle = null;
                    sessionSt.StreamingAssistantIndex = null;
                    if (ReferenceEquals(_states.GetValueOrDefault(activeStateKey), sessionSt))
                        IsRunning = false;
                    LastErrorMessage = error.Message;
                    NotifyStateChanged();
                }));

            sessionSt.RunHandle = handle;
            NotifyStateChanged();
        }

        public bool RecallLastUserMessage()
        {
            if (InputText.Length > 0)
                return false;

            var last = Messages.LastOrDefault(m => m.Role == ChatMessageRole.User);
            if (last == null || string.IsNullOrWhiteSpace(last.Text))
                return false;

            InputText = last.Text;
            return true;
        }

        public void DismissError()
        {
            LastErrorMessage = null;
        }

        public void CancelCurrentTurn()
        {
            if (!_states.TryGetValue(activeStateKey, out var state))
                return;

            state.RunHandle?.Cancel();
            state.IsRunning = false;
            state.RunHandle = null;
            state.StreamingAssistantIndex = null;
            IsRunning = false;
            NotifyStateChanged();
        }

        public void FetchDefaultTaskTemplate()
        {
            _ = FetchDefaultTaskTemplateAsync();
        }

        public void SetDefaultTaskTemplate(string? id)
        {
            if (IsUpdatingDefaultTaskTemplate)
                return;
            if (id == DefaultTaskTemplate?.Id)
                return;

            _ = SetDefaultTaskTemplateAsync(id);
        }

        private string activeStateKey => ActiveSessionId ?? PendingNewChatKey;

        private ChatSessionState sessionState(string key)
        {
            if (_states.TryGetValue(key, out var existing))
                return existing;

            var state = new ChatSessionState();
            _states[key] = state;
            return state;
        }

        private void savePublishedToActiveState()
        {
            var state = sessionState(activeStateKey);
            state.Messages = new List<ChatMessage>(Messages);
            state.TrimmedOlderMessageCount = TrimmedOlderMessageCount;
        }

        private void loadState(ChatSessionState state)
        {
            Messages = new List<ChatMessage>(state.Messages);
            TrimmedOlderMessageCount = state.TrimmedOlderMessageCount;
            IsRunning = state.IsRunning;
        }

        private static void enforceMessageCap(ChatSessionState state)
        {
            int overflow = state.Messages.Count - MaxVisibleMessages;
            if (overflow <= 0)
                return;

            state.Messages.RemoveRange(0, overflow);
            state.TrimmedOlderMessageCount += overflow;
        }

        private async Task RefreshSessionsAsync(Action? completion)
        {
            try
            {
                var sessions = await AgentSessionService.FetchSessionsAsync();
                RunOnUi(() =>
                {
                    Sessions = sessions;
                    NotifyStateChanged();
                    completion?.Invoke();
                });
            }
            catch (Exception ex)
            {
                RunOnUi(() =>
                {
                    LastErrorMessage = ex.Message;
                    completion?.Invoke();
                });
            }
        }

        private async Task LoadSessionHistoryAsync(string sessionId)
        {
            if (!await EnsureSubscriptionReadyAsync())
            {
                RunOnUi(() =>
                {
                    if (ActiveSessionId != sessionId) return;
                    IsLoadingSessionHistory = false;
                    LastErrorMessage = "Sign in to load this chat history.";
                    NotifyStateChanged();
                });
                return;
            }

            try
            {
                var entries = await _apiClient.FetchSessionMessagesAsync(sessionId);
                var hydrated = HydrateTranscript(entries);
                int overflow = Math.Max(0, hydrated.Count - MaxVisibleMessages);
                var visible = overflow > 0
                    ? hydrated.Skip(hydrated.Count - MaxVisibleMessages).ToList()
                    : hydrated;

                RunOnUi(() =>
                {
                    if (ActiveSessionId != sessionId) return;

                    var state = sessionState(sessionId);
                    state.Messages = visible;
                    state.TrimmedOlderMessageCount = overflow;

                    Messages = new List<ChatMessage>(visible);
                    TrimmedOlderMessageCount = overflow;
                    IsLoadingSessionHistory = false;
                    NotifyStateChanged();
                });
            }
            catch (Exception ex)
            {
                RunOnUi(() =>
                {
                    if (ActiveSessionId != sessionId) return;
                    IsLoadingSessionHistory = false;
                    LastErrorMessage = "Couldn't load this chat history.";
                    if (!string.IsNullOrWhiteSpace(ex.Message))
                        LastErrorMessage = ex.Message;
                    NotifyStateChanged();
                });
            }
        }

        private async Task DeleteSessionAsync(AgentSessionInfo session)
        {
            if (!await EnsureSubscriptionReadyAsync())
                return;

            var token = SubscriptionManager.Instance.JwtToken;
            if (string.IsNullOrWhiteSpace(token))
                return;

            try
            {
                using var req = new HttpRequestMessage(
                    HttpMethod.Delete,
                    ApiClient.BaseUrl.TrimEnd('/') + $"/api/agent/sessions/{session.Id}");
                req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);

                using var resp = await Http.SendAsync(req);
                if (!resp.IsSuccessStatusCode)
                    return;

                RunOnUi(() =>
                {
                    _states.Remove(session.Id);
                    Sessions.RemoveAll(s => s.Id == session.Id);
                    if (ActiveSessionId == session.Id)
                        StartNewChat();
                    else
                        NotifyStateChanged();
                });
            }
            catch
            {
            }
        }

        private async Task FetchDefaultTaskTemplateAsync()
        {
            if (!await EnsureSubscriptionReadyAsync())
            {
                RunOnUi(() =>
                {
                    DefaultTaskTemplate = null;
                    AvailableTaskTemplates = new List<TaskTemplateDto>();
                    NotifyStateChanged();
                });
                return;
            }

            try
            {
                var templates = await _apiClient.FetchTaskTemplatesAsync();
                RunOnUi(() =>
                {
                    AvailableTaskTemplates = templates;
                    DefaultTaskTemplate = templates.FirstOrDefault(t => t.IsDefault);
                    NotifyStateChanged();
                });
            }
            catch
            {
                RunOnUi(() =>
                {
                    AvailableTaskTemplates = new List<TaskTemplateDto>();
                    DefaultTaskTemplate = null;
                    NotifyStateChanged();
                });
            }
        }

        private async Task SetDefaultTaskTemplateAsync(string? id)
        {
            var previousDefault = DefaultTaskTemplate;
            var previousTemplates = AvailableTaskTemplates;

            RunOnUi(() =>
            {
                if (id != null && AvailableTaskTemplates.FirstOrDefault(t => t.Id == id) is { } target)
                {
                    AvailableTaskTemplates = AvailableTaskTemplates
                        .Select(t => new TaskTemplateDto
                        {
                            Id = t.Id,
                            Heading = t.Heading,
                            Instructions = t.Instructions,
                            IsDefault = t.Id == id
                        })
                        .ToList();
                    DefaultTaskTemplate = new TaskTemplateDto
                    {
                        Id = target.Id,
                        Heading = target.Heading,
                        Instructions = target.Instructions,
                        IsDefault = true
                    };
                }
                else
                {
                    AvailableTaskTemplates = AvailableTaskTemplates
                        .Select(t => new TaskTemplateDto
                        {
                            Id = t.Id,
                            Heading = t.Heading,
                            Instructions = t.Instructions,
                            IsDefault = false
                        })
                        .ToList();
                    DefaultTaskTemplate = null;
                }

                IsUpdatingDefaultTaskTemplate = true;
                NotifyStateChanged();
            });

            try
            {
                if (id != null)
                {
                    var updated = await _apiClient.SetDefaultTaskTemplateAsync(id);
                    RunOnUi(() =>
                    {
                        AvailableTaskTemplates = AvailableTaskTemplates
                            .Select(t => new TaskTemplateDto
                            {
                                Id = t.Id,
                                Heading = t.Heading,
                                Instructions = t.Instructions,
                                IsDefault = t.Id == updated.Id
                            })
                            .ToList();
                        DefaultTaskTemplate = updated;
                        IsUpdatingDefaultTaskTemplate = false;
                        NotifyStateChanged();
                    });
                }
                else
                {
                    await _apiClient.ClearDefaultTaskTemplateAsync();
                    RunOnUi(() =>
                    {
                        AvailableTaskTemplates = AvailableTaskTemplates
                            .Select(t => new TaskTemplateDto
                            {
                                Id = t.Id,
                                Heading = t.Heading,
                                Instructions = t.Instructions,
                                IsDefault = false
                            })
                            .ToList();
                        DefaultTaskTemplate = null;
                        IsUpdatingDefaultTaskTemplate = false;
                        NotifyStateChanged();
                    });
                }
            }
            catch (Exception ex)
            {
                RunOnUi(() =>
                {
                    AvailableTaskTemplates = previousTemplates;
                    DefaultTaskTemplate = previousDefault;
                    IsUpdatingDefaultTaskTemplate = false;
                    LastErrorMessage = id == null
                        ? $"Failed to clear task instruction: {ex.Message}"
                        : $"Failed to change task instruction: {ex.Message}";
                    NotifyStateChanged();
                });
            }
        }

        private void appendBlock(ChatBlock block, ChatSessionState state)
        {
            if (state.StreamingAssistantIndex is not int index ||
                index < 0 ||
                index >= state.Messages.Count)
            {
                return;
            }

            var message = state.Messages[index];
            if (message.Role != ChatMessageRole.Assistant)
                return;

            message.Blocks.Add(block);

            if (ReferenceEquals(_states.GetValueOrDefault(activeStateKey), state))
            {
                Messages = new List<ChatMessage>(state.Messages);
                NotifyStateChanged();
            }
        }

        private static List<ChatMessage> HydrateTranscript(List<SessionHistoryEntryDto> entries)
        {
            if (entries.Any(e => e.Blocks is { Count: > 0 }))
            {
                return entries
                    .Select(entry =>
                    {
                        if (entry.Role.Equals("user", StringComparison.OrdinalIgnoreCase))
                            return ChatMessage.User(entry.Text);

                        if (!entry.Role.Equals("assistant", StringComparison.OrdinalIgnoreCase))
                            return null;

                        var message = ChatMessage.Assistant();
                        foreach (var block in entry.Blocks ?? new List<SessionHistoryBlockDto>())
                        {
                            if (BlockKindFromString(block.Kind) is { } kind)
                                message.Blocks.Add(new ChatBlock(kind, block.Text));
                        }

                        return message.Blocks.Count == 0 ? null : message;
                    })
                    .Where(m => m != null)
                    .Cast<ChatMessage>()
                    .ToList();
            }

            var result = new List<ChatMessage>();
            var pendingAssistantTexts = new List<string>();

            void FlushAssistant()
            {
                string? text = pendingAssistantTexts
                    .AsEnumerable()
                    .Reverse()
                    .Select(HistoryAssistantDisplayText)
                    .FirstOrDefault(t => !string.IsNullOrWhiteSpace(t));

                pendingAssistantTexts.Clear();
                if (string.IsNullOrWhiteSpace(text))
                    return;

                var message = ChatMessage.Assistant();
                message.Blocks.Add(new ChatBlock(ChatBlockKind.FinalAnswer, text));
                result.Add(message);
            }

            foreach (var entry in entries)
            {
                if (entry.Role.Equals("user", StringComparison.OrdinalIgnoreCase))
                {
                    FlushAssistant();
                    result.Add(ChatMessage.User(entry.Text));
                }
                else if (entry.Role.Equals("assistant", StringComparison.OrdinalIgnoreCase))
                {
                    pendingAssistantTexts.Add(entry.Text);
                }
            }

            FlushAssistant();
            return result;
        }

        private static string? HistoryAssistantDisplayText(string raw)
        {
            string cleaned = (AgentRunner.ExtractFinalAnswer(raw) ?? AgentRunner.CleanDisplayText(raw)).Trim();
            if (cleaned.Length == 0) return null;
            if (cleaned == "[shell command]") return null;
            if (cleaned.StartsWith("[terminal ", StringComparison.OrdinalIgnoreCase)) return null;
            return cleaned;
        }

        private static ChatBlockKind? BlockKindFromString(string value) =>
            value switch
            {
                "agentReasoning" => ChatBlockKind.AgentReasoning,
                "shellCommand" => ChatBlockKind.ShellCommand,
                "terminalOutput" => ChatBlockKind.TerminalOutput,
                "webCall" => ChatBlockKind.WebCall,
                "mcpCall" => ChatBlockKind.McpCall,
                "imageRendering" => ChatBlockKind.ImageRendering,
                "finalAnswer" => ChatBlockKind.FinalAnswer,
                _ => null
            };

        private static async Task<bool> EnsureSubscriptionReadyAsync()
        {
            if (!string.IsNullOrWhiteSpace(SubscriptionManager.Instance.JwtToken))
                return true;

            return await SubscriptionManager.Instance.ReactivateStoredKeyIfNeededAsync();
        }

        private static string NormalizeSearchText(string text)
        {
            var normalized = text.ToLowerInvariant().Normalize(NormalizationForm.FormD);
            var sb = new StringBuilder(normalized.Length);
            foreach (char c in normalized)
            {
                if (CharUnicodeInfo.GetUnicodeCategory(c) != UnicodeCategory.NonSpacingMark)
                    sb.Append(c);
            }

            return sb.ToString().Normalize(NormalizationForm.FormC);
        }

        private void RunOnUi(Action action)
        {
            var context = _syncContext;
            if (context == null || SynchronizationContext.Current == context)
            {
                action();
                return;
            }

            context.Post(_ => action(), null);
        }

        private void NotifyStateChanged()
        {
            StateChanged?.Invoke(this, EventArgs.Empty);
        }
    }
}
