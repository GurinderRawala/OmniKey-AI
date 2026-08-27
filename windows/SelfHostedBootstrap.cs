using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;

namespace OmniKey.Windows
{
    internal sealed class SelfHostedProviderOption
    {
        public string Provider { get; init; } = "openai";
        public string DisplayName { get; init; } = "OpenAI";
        public string ApiKeyEnvName { get; init; } = "OPENAI_API_KEY";
        public string KeyPlaceholder { get; init; } = "sk-...";
        public bool SupportsBaseUrl { get; init; }
        public bool SupportsResponsesApiToggle { get; init; }
    }

    internal sealed class CliInstallResult
    {
        public string Message { get; init; } = "";
        public string Output { get; init; } = "";
    }

    internal sealed class CliUpdateStatus
    {
        public string? CurrentVersion { get; init; }
        public string? LatestVersion { get; init; }
        public bool IsUpdateAvailable { get; init; }
    }

    internal enum ElevatedLaunchOutcome
    {
        /// <summary>The elevated process was created.</summary>
        Started,

        /// <summary>The user dismissed the UAC consent dialog.</summary>
        DeclinedByUser,

        /// <summary>Elevation was accepted (or not reached) but launching failed.</summary>
        Failed,
    }

    internal sealed class ElevatedLaunchResult
    {
        public ElevatedLaunchOutcome Outcome { get; init; }
        public string Message { get; init; } = "";
    }

    internal static class SelfHostedBootstrap
    {
        private sealed class ShellCommandResult
        {
            public string Output { get; init; } = "";
            public int ExitCode { get; init; }
        }

        public static readonly IReadOnlyList<SelfHostedProviderOption> ProviderOptions =
            new List<SelfHostedProviderOption>
            {
                new()
                {
                    Provider = "openai",
                    DisplayName = "OpenAI",
                    ApiKeyEnvName = "OPENAI_API_KEY",
                    KeyPlaceholder = "sk-..."
                },
                new()
                {
                    Provider = "anthropic",
                    DisplayName = "Anthropic (Claude)",
                    ApiKeyEnvName = "ANTHROPIC_API_KEY",
                    KeyPlaceholder = "sk-ant-..."
                },
                new()
                {
                    Provider = "gemini",
                    DisplayName = "Google Gemini",
                    ApiKeyEnvName = "GEMINI_API_KEY",
                    KeyPlaceholder = "AIza..."
                },
                new()
                {
                    Provider = "nemotron",
                    DisplayName = "Open Model",
                    ApiKeyEnvName = "OPEN_MODEL_API_KEY",
                    KeyPlaceholder = "API key or local placeholder",
                    SupportsBaseUrl = true,
                    SupportsResponsesApiToggle = true
                }
            };

        public static string ConfigDir => Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            ".omnikey");

        public static string ConfigPath => Path.Combine(ConfigDir, "config.json");

        public static bool ConfigExists() => File.Exists(ConfigPath);

        public static async Task<bool> ShouldShowFirstRunOnboardingAsync()
        {
            if (!ConfigExists()) return true;

            int? port = ConfiguredDaemonPort();
            if (port is null) return true;

            bool configuredDaemonRunning = await ProbeHealthAsync(port.Value, milliseconds: 1000);
            return !configuredDaemonRunning;
        }

        public static int? ConfiguredDaemonPort() => ConfiguredPort();

        private static int? ConfiguredPort()
        {
            try
            {
                using var doc = JsonDocument.Parse(File.ReadAllText(ConfigPath));
                if (!doc.RootElement.TryGetProperty("OMNIKEY_PORT", out var portEl))
                    return null;

                if (portEl.ValueKind == JsonValueKind.Number &&
                    portEl.TryGetInt32(out int numericPort) &&
                    numericPort > 0)
                {
                    return numericPort;
                }

                if (portEl.ValueKind == JsonValueKind.String &&
                    int.TryParse(portEl.GetString(), out int stringPort) &&
                    stringPort > 0)
                {
                    return stringPort;
                }
            }
            catch
            {
                return null;
            }

            return null;
        }

        public static async Task<CliUpdateStatus> CheckCliUpdateAsync()
        {
            const string script = @"
$ErrorActionPreference = 'Stop'

function Test-Command($name) {
    return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

function Get-CleanVersion([string]$value) {
    if ($value -match '(\d+(\.\d+){1,3})') { return $Matches[1] }
    return ''
}

function Get-OmniKeyVersion {
    if (-not (Test-Command 'omnikey')) { return '' }
    $raw = (& omnikey --version 2>$null | Select-Object -First 1)
    return Get-CleanVersion ([string]$raw)
}

if (-not (Test-Command 'omnikey')) {
    Write-Output 'OMNIKEY_CLI_INSTALLED=false'
    exit 0
}

$current = Get-OmniKeyVersion
$latest = ''
if (Test-Command 'npm') {
    $latest = ((& npm view omnikey-cli version 2>$null | Select-Object -First 1) -as [string]).Trim()
}

Write-Output 'OMNIKEY_CLI_INSTALLED=true'
Write-Output ""OMNIKEY_CLI_CURRENT_VERSION=$current""
Write-Output ""OMNIKEY_CLI_LATEST_VERSION=$latest""
";

            ShellCommandResult result = await ExecutePowerShellAsync(script);
            string output = result.Output.Trim();

            if (result.ExitCode != 0)
                throw new InvalidOperationException(InstallFailureMessage(output));

            string? current = NonEmptyMarker("OMNIKEY_CLI_CURRENT_VERSION", output);
            string? latest = NonEmptyMarker("OMNIKEY_CLI_LATEST_VERSION", output);

            return new CliUpdateStatus
            {
                CurrentVersion = current,
                LatestVersion = latest,
                IsUpdateAvailable = IsVersionNewer(latest, current)
            };
        }

        public static int FindAvailablePort()
        {
            var listener = new TcpListener(IPAddress.Loopback, 0);
            listener.Start();
            try
            {
                return ((IPEndPoint)listener.LocalEndpoint).Port;
            }
            finally
            {
                listener.Stop();
            }
        }

        public static void WriteSelfHostedConfig(
            SelfHostedProviderOption provider,
            string apiKey,
            string? openModelBaseUrl,
            bool openModelResponsesApiEnabled,
            int port)
        {
            Directory.CreateDirectory(ConfigDir);
            var sqlitePath = Path.Combine(ConfigDir, "omnikey-selfhosted.sqlite");

            var config = new Dictionary<string, object?>
            {
                ["AI_PROVIDER"] = provider.Provider,
                [provider.ApiKeyEnvName] = apiKey,
                ["IS_SELF_HOSTED"] = true,
                ["SQLITE_PATH"] = sqlitePath,
                ["OMNIKEY_PORT"] = port,
                ["TERMINAL_PLATFORM"] = "windows"
            };

            if (provider.Provider == "nemotron")
            {
                if (!string.IsNullOrWhiteSpace(openModelBaseUrl))
                    config["OPEN_MODEL_BASE_URL"] = openModelBaseUrl.Trim();

                config["OPEN_MODEL_RESPONSES_API_ENABLED"] = openModelResponsesApiEnabled.ToString().ToLowerInvariant();
            }

            string json = JsonSerializer.Serialize(
                config,
                new JsonSerializerOptions { WriteIndented = true });
            File.WriteAllText(ConfigPath, json, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
        }

        public static async Task<CliInstallResult> InstallOrUpdateCliAsync()
        {
            const string script = @"
$ErrorActionPreference = 'Stop'

function Test-Command($name) {
    return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

function Get-CleanVersion([string]$value) {
    if ($value -match '(\d+(\.\d+){1,3})') { return $Matches[1] }
    return ''
}

function Get-OmniKeyVersion {
    if (-not (Test-Command 'omnikey')) { return '' }
    $raw = (& omnikey --version 2>$null | Select-Object -First 1)
    return Get-CleanVersion ([string]$raw)
}

Write-Output 'Checking omnikey-cli...'
$current = Get-OmniKeyVersion
$currentCommand = Get-Command omnikey -ErrorAction SilentlyContinue
if ($current) {
    Write-Output ""Current version: $current""
    Write-Output ""Current path: $($currentCommand.Source)""
} else {
    Write-Output 'omnikey-cli is not installed yet.'
}

if (-not (Test-Command 'npm')) {
    Write-Error 'Node.js/npm is required to install or update omnikey-cli.'
    exit 127
}

$latest = ((& npm view omnikey-cli version 2>$null | Select-Object -First 1) -as [string]).Trim()
if (-not $latest) {
    Write-Error 'Could not determine the latest omnikey-cli version from npm.'
    exit 1
}

Write-Output ""Latest npm version: $latest""
if ($current -and $current -eq $latest) {
    Write-Output 'OMNIKEY_INSTALL_RESULT=already_latest'
    Write-Output ""OMNIKEY_INSTALL_VERSION=$current""
    exit 0
}

Write-Output 'Installing latest omnikey-cli with npm...'
& npm install -g omnikey-cli@latest
if ($LASTEXITCODE -ne 0) {
    Write-Error ""npm install failed with exit code $LASTEXITCODE.""
    exit $LASTEXITCODE
}

$machinePath = [System.Environment]::GetEnvironmentVariable('Path', 'Machine')
$userPath = [System.Environment]::GetEnvironmentVariable('Path', 'User')
$env:Path = @(
    $machinePath,
    $userPath,
    (Join-Path $env:APPDATA 'npm'),
    $env:Path
) -join ';'

$refreshed = Get-OmniKeyVersion
if (-not $refreshed) {
    Write-Error 'Installed, but the omnikey command is not on PATH.'
    exit 1
}

if ($refreshed -ne $latest) {
    $resolved = (Get-Command omnikey -ErrorAction SilentlyContinue).Source
    Write-Error ""Installed version $refreshed, but latest npm version is $latest. PATH resolves omnikey at: $resolved""
    exit 1
}

Write-Output 'OMNIKEY_INSTALL_RESULT=installed_or_updated'
Write-Output ""OMNIKEY_INSTALL_VERSION=$refreshed""
";

            ShellCommandResult result = await ExecutePowerShellAsync(script);
            string output = result.Output.Trim();

            if (result.ExitCode != 0)
                throw new InvalidOperationException(InstallFailureMessage(output));

            return new CliInstallResult
            {
                Message = InstallSuccessMessage(output),
                Output = output
            };
        }

        public static async Task<bool> WaitForDaemonAsync(int port, TimeSpan timeout)
        {
            var deadline = DateTimeOffset.UtcNow + timeout;
            while (DateTimeOffset.UtcNow < deadline)
            {
                if (await ProbeHealthAsync(port, milliseconds: 1000))
                    return true;

                await Task.Delay(1000);
            }

            return false;
        }

        private static async Task<bool> ProbeHealthAsync(int port, int milliseconds)
        {
            try
            {
                using var client = new HttpClient
                {
                    Timeout = TimeSpan.FromMilliseconds(milliseconds)
                };
                using var response = await client.GetAsync($"http://127.0.0.1:{port}/health");
                return response.IsSuccessStatusCode;
            }
            catch
            {
                return false;
            }
        }

        // ─── Elevated daemon launch ───────────────────────────────────

        /// <summary>
        /// ShellExecute's error code when the user dismisses the UAC consent
        /// dialog (ERROR_CANCELLED). Surfaced as a Win32Exception.
        /// </summary>
        private const int ErrorCancelled = 1223;

        /// <summary>
        /// Starts <c>omnikey daemon --port {port}</c> elevated, with no
        /// visible console.
        ///
        /// Windows has no way to silently acquire administrator rights from a
        /// non-elevated process — that is precisely what UAC exists to
        /// prevent, so any "run this as admin without asking" approach is by
        /// definition a UAC bypass. What we *can* do is ask the OS to launch
        /// the child elevated via the <c>runas</c> verb, which shows the
        /// standard consent dialog once. After the user approves, the daemon
        /// runs elevated and hidden, so from their point of view it starts in
        /// the background and no terminal is involved.
        ///
        /// Elevation requires UseShellExecute, which rules out redirecting
        /// stdout/stderr — success is therefore confirmed by health-probing
        /// the port (<see cref="WaitForDaemonAsync"/>) rather than by reading
        /// process output.
        /// </summary>
        public static ElevatedLaunchResult StartDaemonElevated(int port)
            => LaunchElevated(port, hidden: true);

        /// <summary>
        /// Fallback for when the hidden launch is declined or fails: opens a
        /// visible elevated PowerShell that runs the daemon and stays open
        /// (<c>-NoExit</c>) so the user can read any error itself. Still
        /// requires the same one-time UAC consent.
        /// </summary>
        public static ElevatedLaunchResult OpenElevatedDaemonTerminal(int port)
            => LaunchElevated(port, hidden: false);

        private static ElevatedLaunchResult LaunchElevated(int port, bool hidden)
        {
            string shell = ResolvePowerShell();
            string command = BuildDaemonCommand(port);

            // -NoProfile so a user's profile script can't interfere with, or
            // slow down, an elevated launch they can't see.
            string arguments = hidden
                ? $"-NoProfile -NonInteractive -Command \"{command}\""
                : $"-NoExit -NoProfile -Command \"{command}\"";

            var psi = new ProcessStartInfo
            {
                FileName = shell,
                Arguments = arguments,
                // Both required for the runas verb to take effect.
                UseShellExecute = true,
                Verb = "runas",
                WindowStyle = hidden ? ProcessWindowStyle.Hidden : ProcessWindowStyle.Normal,
                WorkingDirectory = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            };

            try
            {
                using var process = Process.Start(psi);
                if (process is null)
                {
                    return new ElevatedLaunchResult
                    {
                        Outcome = ElevatedLaunchOutcome.Failed,
                        Message = "Windows did not start the elevated process.",
                    };
                }

                return new ElevatedLaunchResult { Outcome = ElevatedLaunchOutcome.Started };
            }
            catch (System.ComponentModel.Win32Exception ex) when (ex.NativeErrorCode == ErrorCancelled)
            {
                return new ElevatedLaunchResult
                {
                    Outcome = ElevatedLaunchOutcome.DeclinedByUser,
                    Message = "Administrator permission was declined.",
                };
            }
            catch (Exception ex)
            {
                return new ElevatedLaunchResult
                {
                    Outcome = ElevatedLaunchOutcome.Failed,
                    Message = ex.Message,
                };
            }
        }

        /// <summary>
        /// The daemon command to run under the elevated shell.
        ///
        /// Prefers the absolute path to the npm shim over the bare "omnikey"
        /// name. Elevation can hand the child a different PATH than this
        /// process sees (notably when the admin account differs from the
        /// logged-in user), and %APPDATA%\npm is a per-user directory, so
        /// resolving by name is not reliable from an elevated context.
        /// </summary>
        private static string BuildDaemonCommand(int port)
        {
            string? shim = ResolveOmniKeyShim();
            if (shim is null)
                return $"omnikey daemon --port {port}";

            // & is required to invoke a quoted path; the quotes survive
            // because the whole -Command argument is itself quoted. Single
            // quotes inside the path are doubled — PowerShell's escape inside
            // a single-quoted string — so a username containing an apostrophe
            // can't terminate the literal early.
            string escaped = shim.Replace("'", "''");
            return $"& '{escaped}' daemon --port {port}";
        }

        /// <summary>
        /// Absolute path to the globally installed omnikey shim, or null when
        /// it cannot be found (in which case the caller falls back to PATH).
        /// </summary>
        public static string? ResolveOmniKeyShim()
        {
            string npmDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "npm");

            foreach (string name in new[] { "omnikey.cmd", "omnikey.ps1", "omnikey" })
            {
                string candidate = Path.Combine(npmDir, name);
                if (File.Exists(candidate))
                    return candidate;
            }

            return null;
        }

        private static async Task<ShellCommandResult> ExecutePowerShellAsync(string script)
        {
            string encodedScript = Convert.ToBase64String(Encoding.Unicode.GetBytes(script));
            var psi = new ProcessStartInfo
            {
                FileName = ResolvePowerShell(),
                Arguments = $"-NonInteractive -EncodedCommand {encodedScript}",
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
                WorkingDirectory = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile)
            };
            ApplyUserEnvironment(psi);

            using var process = new Process { StartInfo = psi };
            process.Start();

            Task<string> stdout = process.StandardOutput.ReadToEndAsync();
            Task<string> stderr = process.StandardError.ReadToEndAsync();
            await process.WaitForExitAsync();

            return new ShellCommandResult
            {
                Output = (await stdout) + (await stderr),
                ExitCode = process.ExitCode
            };
        }

        private static string ResolvePowerShell()
        {
            string[] knownPaths =
            {
                @"C:\Program Files\PowerShell\7\pwsh.exe",
                @"C:\Program Files\PowerShell\7-preview\pwsh.exe"
            };

            foreach (string path in knownPaths)
            {
                if (File.Exists(path))
                    return path;
            }

            try
            {
                using var probe = new Process
                {
                    StartInfo = new ProcessStartInfo
                    {
                        FileName = "where.exe",
                        Arguments = "pwsh.exe",
                        UseShellExecute = false,
                        CreateNoWindow = true,
                        RedirectStandardOutput = true
                    }
                };
                probe.Start();
                string found = probe.StandardOutput.ReadLine() ?? "";
                probe.WaitForExit();
                if (probe.ExitCode == 0 && !string.IsNullOrWhiteSpace(found))
                    return found.Trim();
            }
            catch { }

            return "powershell.exe";
        }

        private static void ApplyUserEnvironment(ProcessStartInfo psi)
        {
            foreach (System.Collections.DictionaryEntry kv in
                     Environment.GetEnvironmentVariables(EnvironmentVariableTarget.Machine))
            {
                if (kv.Key is not string key || kv.Value?.ToString() is not string val)
                    continue;

                psi.Environment[key] = Environment.ExpandEnvironmentVariables(val);
            }

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

            string appDataNpm = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                "npm");

            if (psi.Environment.TryGetValue("PATH", out string? path) &&
                path is not null &&
                !path.Contains(appDataNpm))
            {
                psi.Environment["PATH"] = path.TrimEnd(';') + ";" + appDataNpm;
            }
        }

        private static string InstallSuccessMessage(string output)
        {
            string? version = InstallMarker("OMNIKEY_INSTALL_VERSION", output);

            if (output.Contains("OMNIKEY_INSTALL_RESULT=already_latest", StringComparison.Ordinal))
            {
                return string.IsNullOrWhiteSpace(version)
                    ? "omnikey-cli is already up to date. Click Next to continue."
                    : $"omnikey-cli {version} is already up to date. Click Next to continue.";
            }

            return string.IsNullOrWhiteSpace(version)
                ? "omnikey-cli is installed and ready. Click Next to continue."
                : $"omnikey-cli {version} is installed and ready. Click Next to continue.";
        }

        private static string InstallFailureMessage(string output)
        {
            if (string.IsNullOrWhiteSpace(output))
                return "Could not install omnikey-cli. Install Node.js/npm, then try again.";

            string[] lines = output
                .Split(new[] { "\r\n", "\n" }, StringSplitOptions.RemoveEmptyEntries);

            for (int i = lines.Length - 1; i >= Math.Max(0, lines.Length - 6); i--)
            {
                string line = lines[i].Trim();
                if (line.Contains("required", StringComparison.OrdinalIgnoreCase) ||
                    line.Contains("failed", StringComparison.OrdinalIgnoreCase) ||
                    line.Contains("not on PATH", StringComparison.OrdinalIgnoreCase) ||
                    line.Contains("latest npm version", StringComparison.OrdinalIgnoreCase) ||
                    line.Contains("could not determine", StringComparison.OrdinalIgnoreCase))
                {
                    return line;
                }
            }

            return lines[^1].Trim();
        }

        private static string? InstallMarker(string key, string output)
        {
            string prefix = key + "=";
            foreach (string line in output.Split(new[] { "\r\n", "\n" }, StringSplitOptions.RemoveEmptyEntries))
            {
                string trimmed = line.Trim();
                if (trimmed.StartsWith(prefix, StringComparison.Ordinal))
                    return trimmed[prefix.Length..].Trim();
            }

            return null;
        }

        private static string? NonEmptyMarker(string key, string output)
        {
            string? value = InstallMarker(key, output);
            return string.IsNullOrWhiteSpace(value) ? null : value.Trim();
        }

        private static bool IsVersionNewer(string? candidate, string? current)
        {
            if (string.IsNullOrWhiteSpace(candidate) || string.IsNullOrWhiteSpace(current))
                return false;

            if (Version.TryParse(candidate, out var candidateVersion) &&
                Version.TryParse(current, out var currentVersion))
            {
                return candidateVersion > currentVersion;
            }

            return string.Compare(candidate, current, StringComparison.OrdinalIgnoreCase) > 0;
        }
    }
}
