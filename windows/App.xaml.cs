using System;
using System.IO;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Threading;
using Wpf.Ui.Appearance;
using Wpf.Ui.Controls;

namespace OmniKey.Windows
{
    public partial class App : Application
    {
        public App()
        {
            InitializeComponent();
        }

        protected override void OnStartup(StartupEventArgs e)
        {
            base.OnStartup(e);
            ApplicationThemeManager.Apply(ApplicationTheme.Dark, WindowBackdropType.Mica);

            // The app lives in the tray and must survive a recoverable failure
            // (e.g. the self-hosted backend being down while the user edits
            // Settings). Without these handlers any exception that escapes a
            // view-model — including ones raised on the dispatcher during
            // binding/property-change callbacks, outside a try/catch — tears the
            // whole process down, which looked like "the app quits when I change
            // a setting". We log the failure and keep running instead.
            DispatcherUnhandledException += OnDispatcherUnhandledException;
            AppDomain.CurrentDomain.UnhandledException += OnAppDomainUnhandledException;
            TaskScheduler.UnobservedTaskException += OnUnobservedTaskException;
        }

        private void OnDispatcherUnhandledException(object sender, DispatcherUnhandledExceptionEventArgs e)
        {
            LogException("Dispatcher", e.Exception);
            // Mark handled so the UI thread keeps pumping messages — the failed
            // action is abandoned but the app stays up in the tray.
            e.Handled = true;
        }

        private void OnAppDomainUnhandledException(object sender, UnhandledExceptionEventArgs e)
        {
            LogException("AppDomain", e.ExceptionObject as Exception);
        }

        private void OnUnobservedTaskException(object? sender, UnobservedTaskExceptionEventArgs e)
        {
            LogException("Task", e.Exception);
            // Prevent the unobserved-exception policy from escalating to a crash.
            e.SetObserved();
        }

        /// <summary>
        /// Appends an exception to <c>~/.omnikey/windows-app.log</c>. Best-effort:
        /// logging must never itself throw and take the app down.
        /// </summary>
        private static void LogException(string source, Exception? ex)
        {
            if (ex is null) return;
            try
            {
                string dir = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                    ".omnikey");
                Directory.CreateDirectory(dir);
                string line =
                    $"[{DateTime.Now:yyyy-MM-dd HH:mm:ss}] [{source}] {ex}\n\n";
                File.AppendAllText(Path.Combine(dir, "windows-app.log"), line);
            }
            catch
            {
                // Swallow — a logging failure must not crash the app.
            }
        }
    }
}
