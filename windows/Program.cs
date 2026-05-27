using System;
using System.Windows;
using System.Windows.Controls;
using OmniKey.Windows.Views;

namespace OmniKey.Windows
{
    /// <summary>
    /// Entry point. Hosts both the WinForms <see cref="HotkeyForm"/> (tray
    /// icon + Win32 global hotkeys) and the WPF <see cref="MainWindow"/>
    /// (the new WPF-UI shell). The WPF dispatcher loop drives the process;
    /// the hidden HotkeyForm's WndProc receives WM_HOTKEY messages through
    /// the same loop.
    /// </summary>
    internal static class Program
    {
        private static App? _wpfApp;
        private static MainWindow? _mainWindow;

        public static App WpfApp =>
            _wpfApp ?? throw new InvalidOperationException("WPF application not initialized.");

        [STAThread]
        private static void Main(string[] args)
        {
            bool previewOnly = Array.IndexOf(args, "--wpfui-preview") >= 0;

            // WinForms init must happen before any Form is constructed.
            System.Windows.Forms.Application.EnableVisualStyles();
            System.Windows.Forms.Application.SetCompatibleTextRenderingDefault(false);

            _wpfApp = new App();
            _wpfApp.InitializeComponent();
            _wpfApp.ShutdownMode = ShutdownMode.OnExplicitShutdown;

            if (previewOnly)
            {
                // Dev preview path: skip the tray + global hotkeys, just open the new shell.
                ShowMainWindow();
                _wpfApp.Run();
                return;
            }

            // Production path: hidden HotkeyForm owns the tray + Ctrl+E/G/T hotkeys.
            // WPF's dispatcher loop drives the process. WM_HOTKEY still reaches the
            // form's WndProc because DispatchMessage routes by HWND, regardless of
            // which framework set up the loop. The tray "Exit" menu item calls
            // Application.Current.Shutdown(), which returns from Run() below.
            var hotkeyForm = new HotkeyForm();
            hotkeyForm.Show();
            hotkeyForm.WindowState = System.Windows.Forms.FormWindowState.Minimized;
            hotkeyForm.Visible = false;

            // Also open the WPF MainWindow on startup so the user lands in
            // the new shell immediately. The tray icon still owns process
            // lifetime — closing the window doesn't shut down the app.
            ShowMainWindow();

            _wpfApp.Run();

            hotkeyForm.Close();
            hotkeyForm.Dispose();
        }

        /// <summary>
        /// Lazily create the singleton WPF MainWindow, bring it to the
        /// foreground, and optionally navigate to a specific page type.
        /// Safe to call from any thread; marshals onto the WPF dispatcher.
        /// </summary>
        public static void ShowMainWindow(Type? pageType = null)
        {
            if (_wpfApp == null) return;

            _wpfApp.Dispatcher.Invoke(() =>
            {
                if (_mainWindow == null)
                {
                    _mainWindow = new MainWindow();
                    _mainWindow.Closed += (_, _) => _mainWindow = null;
                }

                if (pageType != null)
                {
                    // Defer navigation until the window is fully loaded the first
                    // time around — RootNavigation's frame isn't ready before that.
                    if (_mainWindow.IsLoaded)
                        _mainWindow.NavigateTo(pageType);
                    else
                        _mainWindow.Loaded += DeferredNavigate;
                }

                _mainWindow.Show();
                if (_mainWindow.WindowState == WindowState.Minimized)
                    _mainWindow.WindowState = WindowState.Normal;
                _mainWindow.Activate();
                _mainWindow.Topmost = true;
                _mainWindow.Topmost = false;

                void DeferredNavigate(object? s, RoutedEventArgs e)
                {
                    _mainWindow!.Loaded -= DeferredNavigate;
                    _mainWindow.NavigateTo(pageType!);
                }
            });
        }

        /// <summary>Convenience generic for type-safe page navigation.</summary>
        public static void ShowMainWindow<TPage>() where TPage : Page => ShowMainWindow(typeof(TPage));
    }
}
