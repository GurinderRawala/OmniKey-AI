using System;
using System.Diagnostics;
using System.Net.WebSockets;
using System.Runtime.CompilerServices;
using System.Threading;
using System.Threading.Tasks;
using OmniKey.Windows.Skills;

namespace OmniKey.Windows
{
    /// <summary>
    /// Marks chat timeline blocks created from live Skills notices so the
    /// transcript can label them "Skills" without a new persisted block kind.
    /// Only blocks created here are ever marked (server/history text cannot
    /// spoof it), and the weak table never keeps a block alive.
    /// </summary>
    internal static class SkillNoticeBlocks
    {
        private static readonly ConditionalWeakTable<ChatBlock, object> Marked = new();
        private static readonly object Marker = new();

        public static ChatBlock Create(string literalText)
        {
            var block = new ChatBlock(ChatBlockKind.AgentReasoning, literalText);
            Marked.AddOrUpdate(block, Marker);
            return block;
        }

        public static bool IsNotice(ChatBlock block) => Marked.TryGetValue(block, out _);
    }

    internal sealed class ChatSessionRunHandle
    {
        private readonly object _lock = new();
        private readonly SemaphoreSlim _sendLock = new(1, 1);
        private ClientWebSocket? _webSocket;
        private Process? _process;
        private CancellationTokenSource? _cancellationSource;
        private bool _isCancelledByUser;

        public bool IsCancelledByUser
        {
            get
            {
                lock (_lock) return _isCancelledByUser;
            }
        }

        internal void Attach(ClientWebSocket webSocket, CancellationTokenSource cancellationSource)
        {
            bool cancelNow;
            lock (_lock)
            {
                _webSocket = webSocket;
                _cancellationSource = cancellationSource;
                cancelNow = _isCancelledByUser;
            }

            if (cancelNow)
                Cancel();
        }

        internal void Detach()
        {
            lock (_lock)
            {
                _webSocket = null;
                _cancellationSource = null;
            }
        }

        internal async Task SendWebSocketMessageAsync(
            AgentRunner.AgentMessage message,
            CancellationToken cancellationToken = default)
        {
            ClientWebSocket? webSocket;
            CancellationTokenSource? cancellationSource;
            lock (_lock)
            {
                webSocket = _webSocket;
                cancellationSource = _cancellationSource;
            }

            if (webSocket == null || webSocket.State != WebSocketState.Open)
                throw new InvalidOperationException("The current agent turn is no longer connected.");

            using var linkedCancellation = cancellationSource != null
                ? CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, cancellationSource.Token)
                : CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);

            await _sendLock.WaitAsync(linkedCancellation.Token);
            try
            {
                await AgentRunner.SendMessageAsync(webSocket, message, linkedCancellation.Token);
            }
            finally
            {
                _sendLock.Release();
            }
        }

        internal void AttachProcess(Process? process)
        {
            bool cancelNow;
            lock (_lock)
            {
                _process = process;
                cancelNow = _isCancelledByUser;
            }

            if (cancelNow && process != null)
                KillProcess(process);
        }

        public void Cancel()
        {
            ClientWebSocket? webSocket;
            Process? process;
            CancellationTokenSource? cancellationSource;

            lock (_lock)
            {
                _isCancelledByUser = true;
                webSocket = _webSocket;
                process = _process;
                cancellationSource = _cancellationSource;
                _webSocket = null;
                _process = null;
                _cancellationSource = null;
            }

            try { cancellationSource?.Cancel(); }
            catch { }

            try { webSocket?.Abort(); }
            catch { }

            if (process != null)
                KillProcess(process);
        }

        public bool TakeWasCancelledByUser()
        {
            lock (_lock)
            {
                bool wasCancelled = _isCancelledByUser;
                _isCancelledByUser = false;
                return wasCancelled;
            }
        }

        private static void KillProcess(Process process)
        {
            try
            {
                if (!process.HasExited)
                    process.Kill(entireProcessTree: true);
            }
            catch
            {
            }
        }
    }

    internal sealed class ChatSessionRunner
    {
        public static readonly ChatSessionRunner Shared = new();

        private ChatSessionRunner()
        {
        }

        public ChatSessionRunHandle Run(
            string sessionId,
            string userText,
            string? groupName,
            Action<ChatBlock> onBlock,
            Action<SteeringAck> onSteering,
            Action<string> onFinal,
            Action<Exception> onError)
        {
            var handle = new ChatSessionRunHandle();

            _ = Task.Run(async () =>
            {
                bool delivered = false;

                void DeliverError(Exception error)
                {
                    if (delivered) return;
                    delivered = true;
                    onError(error);
                }

                void DeliverFinal(string text)
                {
                    if (delivered) return;
                    delivered = true;
                    onFinal(text);
                }

                try
                {
                    bool hadToken = !string.IsNullOrWhiteSpace(SubscriptionManager.Instance.JwtToken);
                    if (!hadToken)
                    {
                        bool activated = await SubscriptionManager.Instance.ReactivateStoredKeyIfNeededAsync();
                        if (!activated)
                            throw new InvalidOperationException("Subscription is not active.");
                    }

                    await ConnectAndRunAsync(
                        sessionId,
                        userText,
                        groupName,
                        allowReauth: hadToken,
                        handle,
                        onBlock,
                        onSteering,
                        DeliverFinal);
                }
                catch (Exception ex)
                {
                    if (handle.TakeWasCancelledByUser() || ex is OperationCanceledException)
                        DeliverError(new OperationCanceledException("Chat turn cancelled."));
                    else
                        DeliverError(ex);
                }
            });

            return handle;
        }

        /// <param name="steeringId">Created by the caller once per user send
        /// (<see cref="NewSteeringId"/>) so the server's received/applied/
        /// rejected acknowledgements route back to that send. A user retry
        /// is a new send with a new id (the backend treats a seen id as a
        /// duplicate for the rest of the run).</param>
        public Task SendSteeringMessageAsync(
            string sessionId,
            string steeringId,
            string text,
            ChatSessionRunHandle handle)
        {
            var message = new AgentRunner.AgentMessage
            {
                session_id = sessionId,
                sender = "client",
                content = text,
                is_terminal_output = false,
                is_error = false,
                is_steering = true,
                platform = "windows",
                steering_id = steeringId,
                supports_skill_status = true,
            };

            return handle.SendWebSocketMessageAsync(message);
        }

        internal static string NewSteeringId() => Guid.NewGuid().ToString("D");

        private static async Task ConnectAndRunAsync(
            string sessionId,
            string userText,
            string? groupName,
            bool allowReauth,
            ChatSessionRunHandle handle,
            Action<ChatBlock> onBlock,
            Action<SteeringAck> onSteering,
            Action<string> onFinal)
        {
            if (handle.IsCancelledByUser)
                throw new OperationCanceledException("Chat turn cancelled.");

            string wsUrl = AgentRunner.MakeWebSocketUrl();
            string jwt = SubscriptionManager.Instance.JwtToken ?? "";

            using var ws = new ClientWebSocket();
            using var cts = new CancellationTokenSource();
            ws.Options.SetRequestHeader("Authorization", $"Bearer {jwt}");
            handle.Attach(ws, cts);

            try
            {
                await ws.ConnectAsync(new Uri(wsUrl), cts.Token);
            }
            catch (WebSocketException ex) when (
                (ex.Message.Contains("401") || ex.Message.Contains("403")) && allowReauth)
            {
                handle.Detach();
                bool ok = await SubscriptionManager.Instance.ReactivateStoredKeyIfNeededAsync();
                if (!ok)
                    throw new InvalidOperationException("Subscription is not active.");

                await ConnectAndRunAsync(sessionId, userText, groupName, false, handle, onBlock, onSteering, onFinal);
                return;
            }

            try
            {
                var initial = new AgentRunner.AgentMessage
                {
                    session_id = sessionId,
                    sender = "client",
                    content = userText,
                    is_terminal_output = false,
                    is_error = false,
                    platform = "windows",
                    group_name = string.IsNullOrWhiteSpace(groupName) ? null : groupName,
                    // Every frame below goes through AgentFrameRouter, which
                    // consumes skill_status notices before shell/final parsing.
                    supports_skill_status = true,
                };

                await handle.SendWebSocketMessageAsync(initial, cts.Token);

                // Fresh per turn: notice dedup never survives a new turn.
                var skillTracker = new SkillStatusTracker();

                while (ws.State == WebSocketState.Open && !cts.Token.IsCancellationRequested)
                {
                    string? raw = await AgentRunner.ReceiveTextAsync(ws, cts.Token);
                    if (raw == null)
                    {
                        if (handle.IsCancelledByUser)
                            throw new OperationCanceledException("Chat turn cancelled.");

                        throw new OperationCanceledException("Agent session ended without a final answer.");
                    }

                    var action = AgentFrameRouter.ForChat(raw, skillTracker);
                    var msg = action.Message;

                    switch (action.Kind)
                    {
                        case AgentFrameKind.SkillNotice:
                            // Live-only, literal text; never executed or final.
                            if (action.Display is { Length: > 0 } notice)
                                onBlock(SkillNoticeBlocks.Create(notice));
                            continue;

                        case AgentFrameKind.Ignored:
                            continue;

                        case AgentFrameKind.SteeringAck:
                            // Routed by steering_id to its pending send; never
                            // executed and never ends the turn.
                            if (action.Steering is { } ack)
                                onSteering(ack);
                            continue;

                        case AgentFrameKind.WebCall:
                            onBlock(new ChatBlock(ChatBlockKind.WebCall, action.Text));
                            continue;

                        case AgentFrameKind.ImageRendering:
                            onBlock(new ChatBlock(ChatBlockKind.ImageRendering, action.Text));
                            continue;

                        case AgentFrameKind.McpCall:
                            onBlock(new ChatBlock(ChatBlockKind.McpCall, action.Text));
                            continue;

                        case AgentFrameKind.FinalAnswer:
                            await AgentRunner.CloseWebSocketAsync(ws);
                            onFinal(action.Text);
                            return;
                    }

                    string content = msg?.content ?? "";

                    if (action.Kind == AgentFrameKind.ShellScript)
                    {
                        string script = action.Text;
                        string reasoning = CleanedTextRemovingShellScript(content);
                        if (reasoning.Length > 0)
                            onBlock(new ChatBlock(ChatBlockKind.AgentReasoning, reasoning));

                        onBlock(new ChatBlock(ChatBlockKind.ShellCommand, script));

                        var (output, exitCode) = await AgentRunner.ExecuteShellAsync(
                            script,
                            cts.Token,
                            process => handle.AttachProcess(process));

                        if (handle.IsCancelledByUser)
                            throw new OperationCanceledException("Chat turn cancelled.");

                        string statusLabel = exitCode == 0 ? "success" : $"error (exit code: {exitCode})";
                        onBlock(new ChatBlock(ChatBlockKind.TerminalOutput, $"[terminal {statusLabel}]\n{output}"));

                        var reply = new AgentRunner.AgentMessage
                        {
                            session_id = msg?.session_id ?? sessionId,
                            sender = "client",
                            content = output,
                            is_terminal_output = true,
                            is_error = exitCode != 0,
                            platform = "windows"
                        };

                        await handle.SendWebSocketMessageAsync(reply, cts.Token);
                        continue;
                    }

                    if (action.Display is { } displayText)
                        onBlock(new ChatBlock(ChatBlockKind.AgentReasoning, displayText));
                }

                if (handle.IsCancelledByUser)
                    throw new OperationCanceledException("Chat turn cancelled.");

                throw new OperationCanceledException("Agent session ended without a final answer.");
            }
            finally
            {
                handle.Detach();
            }
        }

        private static string CleanedTextRemovingShellScript(string content)
        {
            int start = content.IndexOf("<shell_script>", StringComparison.Ordinal);
            if (start < 0)
                return AgentRunner.CleanDisplayText(content);

            int end = content.IndexOf("</shell_script>", start, StringComparison.Ordinal);
            if (end < 0)
                return AgentRunner.CleanDisplayText(content);

            string cleaned = content.Remove(start, end + "</shell_script>".Length - start);
            return AgentRunner.CleanDisplayText(cleaned);
        }
    }
}
