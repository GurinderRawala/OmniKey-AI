using System;
using System.Diagnostics;
using System.Net.WebSockets;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace OmniKey.Windows
{
    internal sealed class ChatSessionRunHandle
    {
        private readonly object _lock = new();
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
            Action<ChatBlock> onBlock,
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
                        allowReauth: hadToken,
                        handle,
                        onBlock,
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

        private static async Task ConnectAndRunAsync(
            string sessionId,
            string userText,
            bool allowReauth,
            ChatSessionRunHandle handle,
            Action<ChatBlock> onBlock,
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

                await ConnectAndRunAsync(sessionId, userText, false, handle, onBlock, onFinal);
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
                    platform = "windows"
                };

                await AgentRunner.SendMessageAsync(ws, initial, cts.Token);

                while (ws.State == WebSocketState.Open && !cts.Token.IsCancellationRequested)
                {
                    string? raw = await AgentRunner.ReceiveTextAsync(ws, cts.Token);
                    if (raw == null)
                    {
                        if (handle.IsCancelledByUser)
                            throw new OperationCanceledException("Chat turn cancelled.");

                        throw new OperationCanceledException("Agent session ended without a final answer.");
                    }

                    AgentRunner.AgentMessage? msg;
                    try
                    {
                        msg = JsonSerializer.Deserialize<AgentRunner.AgentMessage>(raw, AgentRunner.JsonOptions);
                    }
                    catch
                    {
                        continue;
                    }

                    if (msg == null)
                        continue;

                    string content = msg.content ?? "";

                    if (msg.is_web_call == true)
                    {
                        onBlock(new ChatBlock(ChatBlockKind.WebCall, content));
                        continue;
                    }

                    if (msg.is_image_rendering == true)
                    {
                        onBlock(new ChatBlock(ChatBlockKind.ImageRendering, content));
                        continue;
                    }

                    if (msg.is_mcp_call == true)
                    {
                        onBlock(new ChatBlock(ChatBlockKind.McpCall, content));
                        continue;
                    }

                    string? finalAnswer = AgentRunner.ExtractFinalAnswer(content);
                    if (finalAnswer != null)
                    {
                        await AgentRunner.CloseWebSocketAsync(ws);
                        onFinal(finalAnswer);
                        return;
                    }

                    string? script = AgentRunner.ExtractShellScript(content);
                    if (script != null)
                    {
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
                            session_id = msg.session_id ?? sessionId,
                            sender = "client",
                            content = output,
                            is_terminal_output = true,
                            is_error = exitCode != 0,
                            platform = "windows"
                        };

                        await AgentRunner.SendMessageAsync(ws, reply, cts.Token);
                        continue;
                    }

                    string displayText = AgentRunner.CleanDisplayText(content);
                    if (!string.IsNullOrWhiteSpace(displayText) &&
                        !displayText.StartsWith("[terminal ", StringComparison.OrdinalIgnoreCase))
                    {
                        onBlock(new ChatBlock(ChatBlockKind.AgentReasoning, displayText));
                    }
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
