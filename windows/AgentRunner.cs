using System;
using System.Diagnostics;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace OmniKey.Windows
{
    internal static class AgentRunner
    {
        // Tracks the active WebSocket so CancelCurrentSession() can abort it
        // immediately, mirroring macOS AgentSessionState.cancelCurrentSession().
        private static volatile ClientWebSocket? _activeWebSocket;

        /// Abort the currently running agent session (WebSocket + shell process).
        /// Called from the Cancel button in AgentThinkingForm.
        public static void CancelCurrentSession()
        {
            var ws = _activeWebSocket;
            if (ws != null)
            {
                try { ws.Abort(); }
                catch { }
            }
        }

        public static bool ContainsAgentDirective(string text) =>
            text.IndexOf("@omniAgent", StringComparison.OrdinalIgnoreCase) >= 0;

        /// Run a complete agent session.
        /// Updates the AgentThinkingForm during execution.
        /// Returns the final answer text on success.
        public static async Task<string> RunAgentSessionAsync(
            string originalText,
            IAgentSession thinkingForm,
            CancellationToken ct,
            string? selectedSessionId = null)
        {
            // Mirror macOS: if a JWT already exists use it with allowReauth:true so
            // an expired token is transparently refreshed on 401/403.  If we had to
            // activate upfront there is no point retrying with the brand-new token,
            // so pass allowReauth:false to avoid an infinite re-auth loop.
            bool hadToken = !string.IsNullOrEmpty(SubscriptionManager.Instance.JwtToken);
            if (!hadToken)
            {
                bool ok = await SubscriptionManager.Instance.ReactivateStoredKeyIfNeededAsync();
                if (!ok)
                    throw new InvalidOperationException("Subscription is not active.");
            }

            return await ConnectAndRunAsync(
                originalText,
                thinkingForm,
                ct,
                allowReauth: hadToken,
                selectedSessionId: selectedSessionId);
        }

        private static async Task<string> ConnectAndRunAsync(
            string originalText,
            IAgentSession thinkingForm,
            CancellationToken ct,
            bool allowReauth,
            string? selectedSessionId)
        {
            string wsUrl = MakeWebSocketUrl();
            string jwt = SubscriptionManager.Instance.JwtToken ?? "";

            using var ws = new ClientWebSocket();
            ws.Options.SetRequestHeader("Authorization", $"Bearer {jwt}");

            // Register this WebSocket as the active one so CancelCurrentSession()
            // can abort it immediately (mirrors macOS AgentSessionState).
            _activeWebSocket = ws;
            try
            {
                await ws.ConnectAsync(new Uri(wsUrl), ct);
            }
            catch (WebSocketException ex) when (
                (ex.Message.Contains("401") || ex.Message.Contains("403")) && allowReauth)
            {
                _activeWebSocket = null;
                bool ok = await SubscriptionManager.Instance.ReactivateStoredKeyIfNeededAsync();
                if (!ok) throw new InvalidOperationException("Subscription is not active.");
                return await ConnectAndRunAsync(
                    originalText,
                    thinkingForm,
                    ct,
                    allowReauth: false,
                    selectedSessionId: selectedSessionId);
            }

            string sessionId = string.IsNullOrWhiteSpace(selectedSessionId)
                ? Guid.NewGuid().ToString()
                : selectedSessionId;

            // Send initial message
            var initial = new AgentMessage
            {
                session_id = sessionId,
                sender = "client",
                content = originalText,
                is_terminal_output = false,
                is_error = false
            };

            await SendMessageAsync(ws, initial, ct);

            // Receive loop
            while (ws.State == WebSocketState.Open && !ct.IsCancellationRequested)
            {
                string? raw = await ReceiveTextAsync(ws, ct);
                if (raw == null) break;

                AgentMessage? msg;
                try
                {
                    msg = JsonSerializer.Deserialize<AgentMessage>(raw, JsonOptions);
                }
                catch
                {
                    // Not parseable – skip this frame and keep listening,
                    // matching macOS behaviour (receiveNext() on decode failure).
                    continue;
                }

                if (msg == null) continue;

                string content = msg.content ?? "";

                // Web call notification: show it in the thinking window and
                // keep listening — this is not a final answer (mirrors macOS).
                if (msg.is_web_call == true)
                {
                    thinkingForm.AppendWebCall(content);
                    continue;
                }

                string displayText = CleanDisplayText(content);

                // Show the message in the thinking window (not terminal output)
                if (!string.IsNullOrWhiteSpace(displayText))
                {
                    if (!displayText.StartsWith("[terminal ", StringComparison.OrdinalIgnoreCase))
                        thinkingForm.AppendAgentMessage(displayText);
                }

                // Execute <shell_script> if present
                string? script = ExtractShellScript(content);
                if (script != null)
                {
                    var (output, exitCode) = await RunShellCommandAsync(script, ct);

                    string statusLabel = exitCode == 0 ? "success" : $"error (exit code: {exitCode})";
                    thinkingForm.AppendTerminalOutput($"[terminal {statusLabel}]\n{output}");

                    var reply = new AgentMessage
                    {
                        session_id = msg.session_id ?? sessionId,
                        sender = "client",
                        content = output,
                        is_terminal_output = true,
                        is_error = exitCode != 0
                    };

                    await SendMessageAsync(ws, reply, ct);
                    continue;
                }

                // Extract <final_answer>
                string? finalAnswer = ExtractFinalAnswer(content);
                if (finalAnswer != null)
                {
                    _activeWebSocket = null;
                    await CloseWebSocketAsync(ws);
                    return finalAnswer;
                }

                // Implicit final answer (no tags)
                string answer = !string.IsNullOrWhiteSpace(displayText) ? displayText : content;
                _activeWebSocket = null;
                await CloseWebSocketAsync(ws);
                return answer;
            }

            _activeWebSocket = null;
            throw new OperationCanceledException("Agent session ended without a final answer.");
        }

        private static async Task SendMessageAsync(ClientWebSocket ws, AgentMessage msg, CancellationToken ct)
        {
            string json = JsonSerializer.Serialize(msg, JsonOptions);
            byte[] bytes = Encoding.UTF8.GetBytes(json);
            await ws.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, ct);
        }

        private static async Task<string?> ReceiveTextAsync(ClientWebSocket ws, CancellationToken ct)
        {
            var buffer = new byte[8192];
            var sb = new StringBuilder();

            while (true)
            {
                WebSocketReceiveResult result;
                try
                {
                    result = await ws.ReceiveAsync(new ArraySegment<byte>(buffer), ct);
                }
                catch (OperationCanceledException) { return null; }
                catch { return null; }

                if (result.MessageType == WebSocketMessageType.Close)
                {
                    await ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "", CancellationToken.None);
                    return null;
                }

                sb.Append(Encoding.UTF8.GetString(buffer, 0, result.Count));

                if (result.EndOfMessage)
                    return sb.ToString();
            }
        }

        private static async Task CloseWebSocketAsync(ClientWebSocket ws)
        {
            try
            {
                if (ws.State == WebSocketState.Open)
                    await ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "", CancellationToken.None);
            }
            catch { }
        }

        private static async Task<(string output, int exitCode)> RunShellCommandAsync(
            string script, CancellationToken ct)
        {
            // Encode the script as Base64 UTF-16LE so that PowerShell -EncodedCommand
            // receives it verbatim — no quoting, escaping, or curly-brace conflicts.
            // Both powershell.exe and pwsh.exe accept this encoding.
            string encodedScript = Convert.ToBase64String(Encoding.Unicode.GetBytes(script));

            // Resolve the best available PowerShell (7+ preferred over 5.1),
            // mirroring the macOS resolvedLoginShell() approach.
            string shell = ResolvedPowerShell();

            // Omit -NoProfile so the user's profile scripts run and load PATH
            // modifications and tool configurations (GitHub CLI, git, nvm, etc.).
            // This mirrors the macOS approach of launching with -l (login shell)
            // so that agent commands see the same environment as a normal terminal.
            var psi = new ProcessStartInfo
            {
                FileName               = shell,
                Arguments              = $"-NonInteractive -EncodedCommand {encodedScript}",
                RedirectStandardOutput = true,
                RedirectStandardError  = true,
                UseShellExecute        = false,
                CreateNoWindow         = true,
                // Start in the user's home directory, mirroring the macOS login
                // shell which opens in ~. This ensures relative paths and tools
                // that rely on HOME/USERPROFILE work as expected.
                WorkingDirectory       = Environment.GetFolderPath(
                                             Environment.SpecialFolder.UserProfile),
            };

            // Build the child environment by layering machine-level vars (HKLM)
            // then user-level vars (HKCU), mirroring what macOS's -l (login shell)
            // flag does by sourcing /etc/profile then ~/.bash_profile / ~/.zshrc.
            // This ensures agent commands see PATH entries added by installers,
            // Scoop, nvm, pyenv, conda, etc. even if they were installed after
            // OmniKey started and therefore aren't in our current process environment.
            ApplyUserEnvironment(psi);

            Console.WriteLine($"[AgentRunner] About to run PowerShell command. " +
                              $"Script length: {script.Length}, encoded length: {encodedScript.Length}");
            Console.WriteLine($"[AgentRunner] Using shell: {shell}");

            using var process = new Process { StartInfo = psi, EnableRaisingEvents = true };

            var outputSb = new StringBuilder();

            process.OutputDataReceived += (_, e) => { if (e.Data != null) outputSb.AppendLine(e.Data); };
            process.ErrorDataReceived  += (_, e) => { if (e.Data != null) outputSb.AppendLine(e.Data); };

            process.Start();
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();

            // Register cancellation to kill the process
            using var reg = ct.Register(() =>
            {
                try { if (!process.HasExited) process.Kill(entireProcessTree: true); }
                catch { }
            });

            await process.WaitForExitAsync(ct).ConfigureAwait(false);

            return (outputSb.ToString(), process.ExitCode);
        }

        /// Returns the path to the best available PowerShell executable.
        /// Prefers PowerShell 7+ (pwsh.exe) over Windows PowerShell 5.1 (powershell.exe),
        /// analogous to macOS resolvedLoginShell() which prefers the user's configured
        /// shell over a bare /bin/sh fallback.
        private static string ResolvedPowerShell()
        {
            // Check known absolute install paths for PowerShell 7+.
            var knownPaths = new[]
            {
                @"C:\Program Files\PowerShell\7\pwsh.exe",
                @"C:\Program Files\PowerShell\7-preview\pwsh.exe",
            };

            foreach (var path in knownPaths)
            {
                if (System.IO.File.Exists(path))
                    return path;
            }

            // Check if pwsh.exe is on PATH using where.exe (available since Vista).
            try
            {
                using var probe = new Process
                {
                    StartInfo = new ProcessStartInfo
                    {
                        FileName               = "where.exe",
                        Arguments              = "pwsh.exe",
                        UseShellExecute        = false,
                        CreateNoWindow         = true,
                        RedirectStandardOutput = true,
                    }
                };
                probe.Start();
                string found = probe.StandardOutput.ReadLine() ?? "";
                probe.WaitForExit();
                if (probe.ExitCode == 0 && !string.IsNullOrWhiteSpace(found))
                    return found.Trim();
            }
            catch { }

            // Windows PowerShell 5.1 — always present on modern Windows.
            return "powershell.exe";
        }

        /// Populate psi.Environment with the full user logon environment by
        /// layering machine-level then user-level variables from the Windows
        /// registry — the same two sources Windows merges during an interactive
        /// logon session. Mirrors the macOS -l (login shell) flag that sources
        /// /etc/profile then the user's shell rc files so that PATH entries added
        /// by Scoop, winget, nvm, conda, etc. are visible to spawned commands.
        private static void ApplyUserEnvironment(ProcessStartInfo psi)
        {
            // Layer 1 — machine-wide variables (equivalent to /etc/environment).
            foreach (System.Collections.DictionaryEntry kv in
                     Environment.GetEnvironmentVariables(EnvironmentVariableTarget.Machine))
            {
                if (kv.Key is not string key || kv.Value?.ToString() is not string val)
                    continue;
                psi.Environment[key] = Environment.ExpandEnvironmentVariables(val);
            }

            // Layer 2 — user-level variables (HKCU\Environment), equivalent to
            // ~/.bash_profile / ~/.zshrc entries. PATH is additive so that the
            // user's bin folders are appended rather than replacing the system PATH.
            foreach (System.Collections.DictionaryEntry kv in
                     Environment.GetEnvironmentVariables(EnvironmentVariableTarget.User))
            {
                if (kv.Key is not string key || kv.Value?.ToString() is not string val)
                    continue;

                string expanded = Environment.ExpandEnvironmentVariables(val);

                if (key.Equals("PATH", StringComparison.OrdinalIgnoreCase) &&
                    psi.Environment.TryGetValue("PATH", out string? existingPath) &&
                    !string.IsNullOrEmpty(existingPath))
                {
                    psi.Environment[key] = existingPath.TrimEnd(';') + ";" + expanded;
                }
                else
                {
                    psi.Environment[key] = expanded;
                }
            }
        }

        private static string MakeWebSocketUrl()
        {
            string baseUrl = ApiClient.BaseUrl;
            string wsUrl = baseUrl
                .Replace("https://", "wss://", StringComparison.OrdinalIgnoreCase)
                .Replace("http://", "ws://", StringComparison.OrdinalIgnoreCase);
            return wsUrl.TrimEnd('/') + "/ws/omni-agent";
        }

        // ─── Tag parsing ─────────────────────────────────────────────

        private static string? ExtractShellScript(string text)
        {
            int start = text.IndexOf("<shell_script>", StringComparison.Ordinal);
            if (start < 0) return null;
            start += "<shell_script>".Length;
            int end = text.IndexOf("</shell_script>", start, StringComparison.Ordinal);
            if (end < 0) return null;
            return text[start..end].Trim();
        }

        private static string? ExtractFinalAnswer(string text)
        {
            int start = text.IndexOf("<final_answer>", StringComparison.Ordinal);
            if (start < 0) return null;
            start += "<final_answer>".Length;
            int end = text.IndexOf("</final_answer>", start, StringComparison.Ordinal);
            if (end < 0) return null;
            return text[start..end].Trim();
        }

        private static string CleanDisplayText(string text)
        {
            return text
                .Replace("<shell_script>", "")
                .Replace("</shell_script>", "")
                .Replace("<final_answer>", "")
                .Replace("</final_answer>", "")
                .Trim();
        }

        // ─── JSON ─────────────────────────────────────────────────────

        private static readonly JsonSerializerOptions JsonOptions = new()
        {
            PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower
        };

        private sealed class AgentMessage
        {
            public string? session_id { get; set; }
            public string? sender { get; set; }
            public string? content { get; set; }
            public bool is_terminal_output { get; set; }
            public bool is_error { get; set; }
            public bool? is_web_call { get; set; }
            public string platform { get; set; } = "windows";
        }
    }
}
