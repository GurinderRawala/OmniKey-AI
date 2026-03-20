using System;
using System.Net.Http;
using System.Text.Json;
using System.Threading.Tasks;

namespace OmniKey.Windows
{
    internal sealed class UpdateInfo
    {
        public string Version      { get; init; } = "";
        public string DownloadUrl  { get; init; } = "";
        public string ReleaseNotes { get; init; } = "";
    }

    internal static class UpdateChecker
    {
        // Updates always come from the official cloud backend, regardless of
        // which backend the user has configured for AI features.
        private const string CloudBaseUrl = "https://omnikeyai-saas-fmytqc3dra-uc.a.run.app";

        private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(15) };

        /// <summary>
        /// The version compiled into this executable (from AssemblyVersion in the .csproj).
        /// </summary>
        public static Version CurrentVersion =>
            System.Reflection.Assembly.GetExecutingAssembly().GetName().Version
            ?? new Version(1, 0, 0);

        /// <summary>
        /// Queries <c>{CloudBaseUrl}/windows/update</c> for update metadata.
        /// Returns an <see cref="UpdateInfo"/> when a newer version is available,
        /// or <c>null</c> when already up-to-date or the check fails.
        /// </summary>
        public static async Task<UpdateInfo?> CheckAsync()
        {
            try
            {
                using var resp = await Http.GetAsync(CloudBaseUrl + "/windows/update");
                if (!resp.IsSuccessStatusCode) return null;

                string body = await resp.Content.ReadAsStringAsync();
                using var doc = JsonDocument.Parse(body);
                var root = doc.RootElement;

                if (!root.TryGetProperty("version", out var vEl)) return null;
                string? vStr = vEl.GetString();
                if (string.IsNullOrEmpty(vStr) || !Version.TryParse(vStr, out var remoteVer))
                    return null;

                if (remoteVer <= CurrentVersion) return null;

                string releaseNotes = root.TryGetProperty("releaseNotes", out var rEl)
                    ? rEl.GetString() ?? "" : "";

                return new UpdateInfo
                {
                    Version      = vStr,
                    DownloadUrl  = CloudBaseUrl + "/windows/download",
                    ReleaseNotes = releaseNotes,
                };
            }
            catch
            {
                return null;
            }
        }
    }
}
