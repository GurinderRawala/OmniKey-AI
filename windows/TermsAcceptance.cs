using System;
using Microsoft.Win32;

namespace OmniKey.Windows
{
    /// <summary>
    /// Tracks whether the user has accepted the current version of the
    /// Terms &amp; Conditions bundled with the desktop app. Persisted in
    /// <c>HKCU\SOFTWARE\OmniKeyAI</c> alongside the subscription key so
    /// the two live under a single well-known registry root that the
    /// uninstall README already documents.
    /// </summary>
    internal static class TermsAcceptance
    {
        private const string RegSubKey     = @"SOFTWARE\OmniKeyAI";
        private const string RegVersionKey = "TermsAcceptedVersion";
        private const string RegAcceptedAt = "TermsAcceptedAt";

        /// <summary>
        /// True when the user has accepted the version currently shipped
        /// with this build. Any older accepted version returns false so we
        /// re-prompt after a material terms update.
        /// </summary>
        public static bool HasAcceptedCurrent
        {
            get
            {
                try
                {
                    using var key = Registry.CurrentUser.OpenSubKey(RegSubKey);
                    var accepted = key?.GetValue(RegVersionKey) as string;
                    return string.Equals(accepted, TermsContent.CurrentVersion, StringComparison.Ordinal);
                }
                catch
                {
                    // If the registry is inaccessible (unlikely under HKCU
                    // but possible in locked-down environments) fall back
                    // to prompting the user. Better to re-prompt once too
                    // often than to silently skip acceptance.
                    return false;
                }
            }
        }

        /// <summary>
        /// Marks the current terms version as accepted and stores an
        /// ISO-8601 acceptance timestamp for auditability.
        /// </summary>
        public static void RecordAcceptance()
        {
            try
            {
                using var key = Registry.CurrentUser.CreateSubKey(RegSubKey);
                key.SetValue(RegVersionKey, TermsContent.CurrentVersion);
                key.SetValue(RegAcceptedAt, DateTime.UtcNow.ToString("o"));
            }
            catch
            {
                // Best-effort — a registry write failure just means the user
                // will be re-prompted on next launch, which is safe.
            }
        }
    }
}
