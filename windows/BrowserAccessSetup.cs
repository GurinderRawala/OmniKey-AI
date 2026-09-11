using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Threading.Tasks;

namespace OmniKey.Windows
{
    /// <summary>Runs the fully-parameterized browser setup CLI in the signed-in
    /// user's profile without opening a terminal window.</summary>
    internal static class BrowserAccessSetup
    {
        private static readonly IReadOnlyDictionary<string, string[]> BrowserExecutables =
            new Dictionary<string, string[]>(StringComparer.OrdinalIgnoreCase)
            {
                ["Chrome"] = new[]
                {
                    @"C:\Program Files\Google\Chrome\Application\chrome.exe",
                    @"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
                    Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Google", "Chrome", "Application", "chrome.exe"),
                },
                ["Edge"] = new[]
                {
                    @"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
                    @"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
                    Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Microsoft", "Edge", "Application", "msedge.exe"),
                },
                ["Brave"] = new[]
                {
                    @"C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe",
                    Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
                },
            };

        public static IReadOnlyList<string> InstalledBrowsers { get; } = BrowserExecutables
            .Where(entry => entry.Value.Any(File.Exists))
            .Select(entry => entry.Key)
            .ToArray();

        public static async Task<string> RunInBackgroundAsync(string browser, string profile)
        {
            if (!InstalledBrowsers.Contains(browser, StringComparer.OrdinalIgnoreCase))
                throw new InvalidOperationException($"{browser} is not installed or supported.");
            if (string.IsNullOrWhiteSpace(profile))
                throw new InvalidOperationException("Enter a debug profile name.");

            string command =
                $"call {ResolveOmnikeyInvocation()} grant-browser-access --non-interactive " +
                $"--method debug-profile --browser {QuoteCmd(browser)} --profile {QuoteCmd(profile.Trim())}";
            var psi = new ProcessStartInfo
            {
                FileName = Environment.GetEnvironmentVariable("COMSPEC") ?? "cmd.exe",
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                WorkingDirectory = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            };
            psi.ArgumentList.Add("/d");
            psi.ArgumentList.Add("/s");
            psi.ArgumentList.Add("/c");
            psi.ArgumentList.Add(command);

            using var process = new Process { StartInfo = psi };
            if (!process.Start()) throw new InvalidOperationException("Windows did not start browser setup.");
            Task<string> stdout = process.StandardOutput.ReadToEndAsync();
            Task<string> stderr = process.StandardError.ReadToEndAsync();
            await process.WaitForExitAsync();
            string output = (await stdout) + (await stderr);
            if (process.ExitCode != 0)
            {
                string detail = output.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries).LastOrDefault()
                    ?? "Browser access setup failed.";
                throw new InvalidOperationException(detail);
            }
            return output.Trim();
        }

        private static string ResolveOmnikeyInvocation()
        {
            string appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            string shim = Path.Combine(appData, "npm", "omnikey.cmd");
            return File.Exists(shim) ? QuoteCmd(shim) : "omnikey";
        }

        private static string QuoteCmd(string value) =>
            $"\"{value.Replace("%", "%%").Replace("\"", "\"\"")}\"";
    }
}
