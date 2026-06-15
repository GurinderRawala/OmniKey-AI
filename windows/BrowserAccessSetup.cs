using System;
using System.Diagnostics;
using System.IO;

namespace OmniKey.Windows
{
    /// <summary>
    /// Launches the interactive <c>omnikey grant-browser-access</c> wizard for
    /// authenticated browser access on Windows.
    ///
    /// Why this lives in the desktop app and not the backend: on Windows the
    /// daemon runs as an NSSM service under LocalSystem in session 0, which has
    /// no desktop — a console it spawned would be invisible and the wizard's
    /// prompts would hang. The tray app runs in the user's interactive session,
    /// so it can surface a real console window. The CLI itself writes the
    /// BROWSER_DEBUG_* config and restarts the daemon when the user finishes,
    /// so no backend round-trip is needed to enable the feature.
    /// </summary>
    internal static class BrowserAccessSetup
    {
        /// <summary>
        /// Opens a visible console window running the interactive browser-access
        /// setup. Returns true if the window was launched. Throws on failure so
        /// the caller can surface the error in the settings status bar.
        /// </summary>
        public static bool LaunchInteractiveSetup()
        {
            string invoke = ResolveOmnikeyInvocation();

            // A tiny batch wrapper keeps the console open after the wizard exits
            // (so the user can read the result) and sidesteps the nested-quoting
            // pain of `start "" cmd /k "<path>" ...`.
            string batch = string.Join("\r\n", new[]
            {
                "@echo off",
                "title OmniKey Browser Access",
                $"call {invoke} grant-browser-access",
                "echo.",
                "echo [Setup finished - press any key to close this window]",
                "pause >nul",
            });

            string batchPath = Path.Combine(
                Path.GetTempPath(), $"omnikey-grant-browser-{Guid.NewGuid():N}.cmd");
            File.WriteAllText(batchPath, batch);

            // UseShellExecute opens the .cmd in its own console window on the
            // user's desktop.
            var psi = new ProcessStartInfo
            {
                FileName = batchPath,
                UseShellExecute = true,
                WorkingDirectory = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            };
            Process.Start(psi);
            return true;
        }

        /// <summary>
        /// Resolves how to invoke the omnikey CLI. Prefers the npm global shim
        /// (<c>%APPDATA%\npm\omnikey.cmd</c>) with a full quoted path; falls back
        /// to the bare <c>omnikey</c> command resolved via PATH.
        /// </summary>
        private static string ResolveOmnikeyInvocation()
        {
            string appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            string shim = Path.Combine(appData, "npm", "omnikey.cmd");
            return File.Exists(shim) ? $"\"{shim}\"" : "omnikey";
        }
    }
}
