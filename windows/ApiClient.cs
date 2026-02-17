using System;
using System.Net.Http;
using System.Net.Http.Json;
using System.Text.Json;
using System.Threading.Tasks;

namespace OmniKey.Windows
{
    internal enum EnhanceCommand
    {
        Enhance,
        Grammar,
        Task
    }

    internal sealed class ApiClient
    {
        private static readonly HttpClient HttpClient = new HttpClient
        {
            Timeout = TimeSpan.FromSeconds(30)
        };

        private const string BaseUrl = "http://localhost:7172";

        public async Task<string> SendAsync(string text, EnhanceCommand command)
        {
            var endpoint = command switch
            {
                EnhanceCommand.Enhance => "/api/enhance",
                EnhanceCommand.Grammar => "/api/grammar",
                EnhanceCommand.Task => "/api/custom-task",
                _ => "/api/enhance"
            };

            var uri = new Uri(new Uri(BaseUrl), endpoint);

            var payload = new { text };

            using var response = await HttpClient.PostAsJsonAsync(uri, payload);
            response.EnsureSuccessStatusCode();

            var json = await response.Content.ReadAsStringAsync();

            try
            {
                using var doc = JsonDocument.Parse(json);
                if (doc.RootElement.TryGetProperty("result", out var resultElement) &&
                    resultElement.ValueKind == JsonValueKind.String)
                {
                    return resultElement.GetString() ?? text;
                }
            }
            catch
            {
                // Fall back to raw string
            }

            return json.Length > 0 ? json : text;
        }
    }
}
