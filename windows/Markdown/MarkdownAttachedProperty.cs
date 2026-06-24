using System;
using System.Diagnostics;
using System.Linq;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Documents;
using System.Windows.Media;
using System.Windows.Navigation;
using System.Windows.Threading;
using MdXaml;

namespace OmniKey.Windows.MarkdownRender
{
    /// <summary>
    /// Attached property that turns a <see cref="FlowDocumentScrollViewer"/>
    /// into a one-way markdown sink. Bind <c>md:Markdown.Source="{Binding Text}"</c>
    /// on the viewer and it re-renders whenever the bound text changes.
    /// Rendering is delegated to MdXaml, then re-themed to match the
    /// Nord palette used by the rest of the chat surface and code blocks
    /// are wrapped with a macOS-style header (language label + Copy
    /// button) + rounded chrome.
    /// </summary>
    public static class Markdown
    {
        public static readonly DependencyProperty SourceProperty =
            DependencyProperty.RegisterAttached(
                "Source",
                typeof(string),
                typeof(Markdown),
                new PropertyMetadata(string.Empty, OnSourceChanged));

        public static string GetSource(DependencyObject obj) => (string)obj.GetValue(SourceProperty);
        public static void SetSource(DependencyObject obj, string value) => obj.SetValue(SourceProperty, value);

        // One shared engine — Transform is stateless w.r.t. configuration, and
        // re-allocating per keystroke during streaming makes typing feel laggy.
        // Lazy-initialised so a failure inside MdXaml's static init (it pulls
        // AvalonEdit + theme resources on first use) surfaces as a single
        // render fallback rather than killing the entire class.
        private static readonly Lazy<MdXaml.Markdown> EngineLazy = new(() => new MdXaml.Markdown
        {
            AssetPathRoot = AppDomain.CurrentDomain.BaseDirectory,
        });

        private static MdXaml.Markdown Engine => EngineLazy.Value;

        private static void OnSourceChanged(DependencyObject d, DependencyPropertyChangedEventArgs e)
        {
            if (d is not FlowDocumentScrollViewer viewer) return;
            var text = e.NewValue as string ?? string.Empty;

            FlowDocument doc;
            try
            {
                doc = Engine.Transform(text);
            }
            catch (Exception ex)
            {
                Debug.WriteLine("MdXaml render failed: " + ex);
                doc = new FlowDocument(new Paragraph(new Run(text)));
            }

            try
            {
                ApplyNordTheme(doc);
            }
            catch (Exception ex)
            {
                // Theming is best-effort: never let a malformed answer
                // (e.g. an exotic block MdXaml emits but we don't expect)
                // crash the chat surface. Fall back to the untinted doc.
                Debug.WriteLine("Markdown theming failed: " + ex);
            }

            viewer.Document = doc;
        }

        // ── Theming pass ────────────────────────────────────────────────

        private static void ApplyNordTheme(FlowDocument doc)
        {
            var theme = ThemeTokens.Resolve();

            doc.FontFamily = theme.BodyFont;
            doc.FontSize = 13.5;
            doc.Foreground = theme.Primary;
            doc.Background = Brushes.Transparent;
            doc.PagePadding = new Thickness(0);
            doc.TextAlignment = TextAlignment.Left;
            doc.IsOptimalParagraphEnabled = true;
            doc.IsHyphenationEnabled = false;
            doc.LineHeight = 20;

            // Snapshot the block list before iterating: RestyleBlock can
            // mutate the document tree (BuildCodeChrome swaps a
            // BlockUIContainer's child), which invalidates the live
            // TextElementCollection enumerator and throws
            // "Collection was modified" on the next MoveNext. Without
            // .ToList(), any code block after the first one in an
            // assistant turn stayed in MdXaml's white-themed AvalonEdit
            // form because the rest of the theming pass was aborted by
            // the exception and silently swallowed at the call site.
            foreach (var block in doc.Blocks.ToList())
                RestyleBlock(block, theme);
        }

        private static void RestyleBlock(Block block, ThemeTokens theme)
        {
            // Defensive: MdXaml ships with a light theme and stamps a
            // near-white Background on several block types (Paragraph,
            // Section/blockquote, List, Table). Always clear it before
            // setting our own, otherwise individual paragraphs render
            // with a white slab against the dark chat surface.
            if (block.Background is SolidColorBrush)
                block.Background = Brushes.Transparent;
            block.Foreground ??= theme.Primary;

            switch (block)
            {
                case Paragraph p:
                    // MdXaml emits markdown headings as Paragraphs carrying a
                    // larger/bolder font than body text. Give those extra top
                    // breathing room and force the Nord foreground — MdXaml's
                    // light theme can stamp a dark heading brush that would be
                    // near-invisible on the dark chat surface.
                    bool isHeading = p.FontSize > 14.5 || p.FontWeight.ToOpenTypeWeight() >= 600;
                    p.Margin = isHeading ? new Thickness(0, 10, 0, 4) : new Thickness(0, 0, 0, 8);
                    if (isHeading) p.Foreground = theme.Primary;
                    p.Background = Brushes.Transparent;
                    foreach (var inline in p.Inlines)
                        RestyleInline(inline, theme);
                    break;

                case Section section:
                    section.Padding = new Thickness(12, 6, 8, 6);
                    section.Margin = new Thickness(0, 0, 0, 8);
                    section.Background = Brushes.Transparent;
                    section.BorderBrush = theme.Accent;
                    section.BorderThickness = new Thickness(3, 0, 0, 0);
                    foreach (var child in section.Blocks.ToList())
                        RestyleBlock(child, theme);
                    break;

                case List list:
                    StyleList(list, theme, depth: 0);
                    break;

                case Table table:
                    table.CellSpacing = 0;
                    table.Background = Brushes.Transparent;
                    table.BorderBrush = theme.Border;
                    table.BorderThickness = new Thickness(1);
                    table.Margin = new Thickness(0, 0, 0, 10);
                    foreach (var col in table.Columns)
                        col.Width = new GridLength(1, GridUnitType.Star);
                    foreach (var rowGroup in table.RowGroups)
                    {
                        rowGroup.Background = Brushes.Transparent;
                        foreach (var row in rowGroup.Rows)
                        {
                            row.Background = Brushes.Transparent;
                            foreach (var cell in row.Cells)
                            {
                                // Clear MdXaml's light-theme cell fill
                                // before applying our own borders.
                                cell.Background = Brushes.Transparent;
                                cell.BorderBrush = theme.Border;
                                cell.BorderThickness = new Thickness(0, 0, 1, 1);
                                cell.Padding = new Thickness(8, 6, 8, 6);
                                foreach (var child in cell.Blocks.ToList())
                                    RestyleBlock(child, theme);
                            }
                        }
                    }
                    break;

                case BlockUIContainer container when container.Child is FrameworkElement fe:
                    // MdXaml emits fenced code blocks as a BlockUIContainer
                    // hosting an AvalonEdit TextEditor. Replace the bare
                    // editor with a macOS-style toolbar + rounded card.
                    if (IsCodeElement(fe))
                    {
                        try
                        {
                            container.Child = null; // unparent before re-attaching
                            var chrome = BuildCodeChrome(fe, container.Tag as string, theme);
                            container.Child = chrome;
                        }
                        catch (Exception ex)
                        {
                            // If chrome assembly fails for any reason, put
                            // the original child back so the code block
                            // still renders raw rather than the panel
                            // ending up with a null container.
                            Debug.WriteLine("Code-block chrome failed: " + ex);
                            if (container.Child == null) container.Child = fe;
                        }
                    }
                    break;
            }
        }

        /// <summary>
        /// Styles a markdown list and (recursively) its nested lists so bullets
        /// read like a real document: depth-varied unordered markers
        /// (• → ◦ → ▪), compact item spacing (MdXaml's default 8 DIP paragraph
        /// margin makes lists look double-spaced), and a left indent that keeps
        /// the marker glyph fully visible against the zero-padding FlowDocument
        /// edge. Ordered lists keep their numeric / alpha markers untouched.
        /// </summary>
        private static void StyleList(List list, ThemeTokens theme, int depth)
        {
            list.Background = Brushes.Transparent;
            // Top-level lists get room below; nested lists hug their parent item.
            list.Margin = new Thickness(0, 0, 0, depth == 0 ? 8 : 2);
            // Left padding hosts the marker — keep it clear of the document edge
            // so the glyph isn't clipped, and indent nested levels a touch less.
            list.Padding = new Thickness(depth == 0 ? 24 : 20, 2, 0, 0);
            list.MarkerOffset = 6;

            // Cycle disc → circle → square down the nesting levels, matching how
            // browsers render nested <ul>s. Ordered lists keep their markers.
            if (!IsOrderedMarker(list.MarkerStyle))
            {
                list.MarkerStyle = depth switch
                {
                    0 => TextMarkerStyle.Disc,
                    1 => TextMarkerStyle.Circle,
                    _ => TextMarkerStyle.Square,
                };
            }

            foreach (var item in list.ListItems)
            {
                item.Background = Brushes.Transparent;
                foreach (var child in item.Blocks.ToList())
                {
                    switch (child)
                    {
                        case List nested:
                            StyleList(nested, theme, depth + 1);
                            break;

                        case Paragraph itemPara:
                            // Tight inter-item spacing — overrides MdXaml's 8 DIP.
                            itemPara.Margin = new Thickness(0, 0, 0, 2);
                            itemPara.Background = Brushes.Transparent;
                            itemPara.Foreground ??= theme.Primary;
                            foreach (var inline in itemPara.Inlines)
                                RestyleInline(inline, theme);
                            break;

                        default:
                            RestyleBlock(child, theme);
                            break;
                    }
                }
            }
        }

        private static bool IsOrderedMarker(TextMarkerStyle style) =>
            style is TextMarkerStyle.Decimal
                or TextMarkerStyle.LowerLatin or TextMarkerStyle.UpperLatin
                or TextMarkerStyle.LowerRoman or TextMarkerStyle.UpperRoman;

        private static void RestyleInline(Inline inline, ThemeTokens theme)
        {
            switch (inline)
            {
                case Hyperlink hyper:
                    hyper.Foreground = theme.Accent;
                    hyper.TextDecorations = null;
                    hyper.RequestNavigate -= OnHyperlinkNavigate;
                    hyper.RequestNavigate += OnHyperlinkNavigate;
                    foreach (var child in hyper.Inlines)
                        RestyleInline(child, theme);
                    break;

                case Run run when LooksLikeInlineCode(run):
                    // Override MdXaml's light-theme tint. We use a
                    // softer pill background (BadgeFill) rather than
                    // the near-black CodeBg used by fenced blocks —
                    // inline code should read as a chip, not a slab.
                    run.FontFamily = theme.MonoFont;
                    run.FontSize = 12;
                    run.Background = theme.BadgeFill;
                    run.Foreground = theme.CodeFg;
                    break;

                case Run run when run.Background is SolidColorBrush:
                    // Any other Run that arrives with a non-null
                    // Background is almost certainly MdXaml's light-
                    // theme leak (highlighted text, lead-in spans).
                    // Clear it so the chat surface shows through.
                    run.Background = Brushes.Transparent;
                    run.Foreground ??= theme.Primary;
                    break;

                case Span span:
                    foreach (var child in span.Inlines)
                        RestyleInline(child, theme);
                    break;
            }
        }

        private static bool LooksLikeInlineCode(Run run)
        {
            // MdXaml flags inline code by giving the Run a mono font + a
            // background tint. Detect either tell-tale.
            if (run.Background is SolidColorBrush) return true;
            var src = run.FontFamily?.Source;
            return !string.IsNullOrEmpty(src) &&
                   (src.Contains("Mono", StringComparison.OrdinalIgnoreCase)
                    || src.Contains("Consolas", StringComparison.OrdinalIgnoreCase)
                    || src.Contains("Courier", StringComparison.OrdinalIgnoreCase));
        }

        // ── Code-block chrome (rounded card + Copy header) ──────────────

        /// <summary>True when MdXaml's BlockUIContainer is hosting a code
        /// block. MdXaml uses BlockUIContainer for two cases: an
        /// AvalonEdit <c>TextEditor</c> (when a language is recognised)
        /// and a plain TextBlock fallback (no language). Both paint
        /// themselves white by default, so we treat *any* text-bearing
        /// BlockUIContainer as a code block and rebuild its surface from
        /// scratch.</summary>
        private static bool IsCodeElement(FrameworkElement element)
        {
            if (IsAvalonEditType(element)) return true;
            if (element is TextBlock) return true;
            // The element isn't in the visual tree yet (we're walking the
            // FlowDocument before assigning it to the viewer), so use the
            // logical tree which is populated at construction time.
            foreach (var child in LogicalChildren(element))
                if (child is FrameworkElement fe && IsCodeElement(fe))
                    return true;
            return false;
        }

        private static bool IsAvalonEditType(object element) =>
            element.GetType().FullName?.Contains("AvalonEdit", StringComparison.OrdinalIgnoreCase) == true;

        private static System.Collections.IEnumerable LogicalChildren(DependencyObject root)
        {
            var en = System.Windows.LogicalTreeHelper.GetChildren(root);
            return en ?? System.Linq.Enumerable.Empty<object>();
        }

        private static FrameworkElement BuildCodeChrome(
            FrameworkElement original,
            string? rawTag,
            ThemeTokens theme)
        {
            string codeText = ExtractCodeText(original);
            string language = ResolveLanguageLabel(rawTag, original);

            // Always render the code body with our own TextBlock. MdXaml
            // hands us either an AvalonEdit TextEditor (light-themed,
            // white TextArea + TextView that bleed through any chrome
            // background we set) or a TextBlock-in-Border fallback (also
            // painted white). Trying to clear those backgrounds via
            // reflection worked on some builds but not others — replacing
            // the surface entirely is the only consistent fix. We lose
            // syntax highlighting, which matches the macOS app exactly.
            var codeTextBlock = new TextBlock
            {
                Text = codeText,
                FontFamily = theme.MonoFont,
                FontSize = 12.5,
                Foreground = theme.CodeFg,
                Background = Brushes.Transparent,
                TextWrapping = TextWrapping.NoWrap,
                Padding = new Thickness(0),
                Margin = new Thickness(0),
            };

            FrameworkElement body = new ScrollViewer
            {
                HorizontalScrollBarVisibility = ScrollBarVisibility.Auto,
                VerticalScrollBarVisibility = ScrollBarVisibility.Disabled,
                Background = Brushes.Transparent,
                BorderThickness = new Thickness(0),
                Padding = new Thickness(12, 10, 12, 10),
                Content = codeTextBlock,
            };

            // Header bar: language label + Copy button.
            var header = BuildHeaderBar(language, codeText, theme);

            // Separator hairline between header and code.
            var separator = new Border
            {
                Height = 1,
                Background = theme.Border,
            };

            var stack = new StackPanel { Orientation = Orientation.Vertical };
            stack.Children.Add(header);
            stack.Children.Add(separator);
            stack.Children.Add(body);

            return new Border
            {
                CornerRadius = new CornerRadius(8),
                BorderBrush = theme.Border,
                BorderThickness = new Thickness(1),
                Background = theme.CodeBg,
                Margin = new Thickness(0, 2, 0, 10),
                // Clip child rendering to the rounded shape — without this
                // the header's flat background pokes past the corner radius.
                ClipToBounds = true,
                SnapsToDevicePixels = true,
                Child = stack,
            };
        }

        private static Border BuildHeaderBar(string language, string codeText, ThemeTokens theme)
        {
            var languageLabel = new TextBlock
            {
                Text = language,
                FontFamily = theme.BodyFont,
                FontSize = 10.5,
                FontWeight = FontWeights.SemiBold,
                Foreground = theme.Secondary,
                VerticalAlignment = VerticalAlignment.Center,
            };

            var copyIcon = new TextBlock
            {
                Text = "⧉", // two-squares glyph, no icon-font dep
                FontSize = 11,
                VerticalAlignment = VerticalAlignment.Center,
                Margin = new Thickness(0, 0, 4, 0),
            };
            var copyLabel = new TextBlock
            {
                Text = "Copy",
                FontFamily = theme.BodyFont,
                FontSize = 10.5,
                FontWeight = FontWeights.Medium,
                VerticalAlignment = VerticalAlignment.Center,
            };
            var copyContent = new StackPanel
            {
                Orientation = Orientation.Horizontal,
                VerticalAlignment = VerticalAlignment.Center,
            };
            copyContent.Children.Add(copyIcon);
            copyContent.Children.Add(copyLabel);

            var copyButton = new Button
            {
                Content = copyContent,
                Padding = new Thickness(8, 3, 8, 3),
                BorderThickness = new Thickness(0),
                Background = Brushes.Transparent,
                Foreground = theme.Secondary,
                Cursor = System.Windows.Input.Cursors.Hand,
                ToolTip = "Copy code",
                FocusVisualStyle = null,
            };
            // Strip the default Button chrome so it reads as a chip.
            copyButton.Template = BuildChipButtonTemplate(theme);

            copyButton.Click += (_, _) =>
            {
                try { System.Windows.Clipboard.SetText(codeText); }
                catch { /* clipboard can throw transiently */ }

                copyIcon.Text = "✓"; // checkmark
                copyLabel.Text = "Copied";
                copyButton.Foreground = theme.AccentGreen;

                var timer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(2) };
                timer.Tick += (_, _) =>
                {
                    timer.Stop();
                    copyIcon.Text = "⧉";
                    copyLabel.Text = "Copy";
                    copyButton.Foreground = theme.Secondary;
                };
                timer.Start();
            };

            var dock = new DockPanel { LastChildFill = true };
            DockPanel.SetDock(copyButton, Dock.Right);
            dock.Children.Add(copyButton);
            dock.Children.Add(languageLabel);

            return new Border
            {
                Padding = new Thickness(12, 7, 8, 7),
                Background = theme.BadgeFill,
                Child = dock,
            };
        }

        private static ControlTemplate BuildChipButtonTemplate(ThemeTokens theme)
        {
            // Minimal hand-rolled template: rounded chip that lights up on
            // hover, no default ControlTemplate background that fights the
            // Nord surface.
            var template = new ControlTemplate(typeof(Button));
            var bg = new FrameworkElementFactory(typeof(Border), "Bg");
            bg.SetValue(Border.BackgroundProperty, Brushes.Transparent);
            bg.SetValue(Border.CornerRadiusProperty, new CornerRadius(6));

            var presenter = new FrameworkElementFactory(typeof(ContentPresenter));
            presenter.SetValue(FrameworkElement.HorizontalAlignmentProperty, HorizontalAlignment.Center);
            presenter.SetValue(FrameworkElement.VerticalAlignmentProperty, VerticalAlignment.Center);
            presenter.SetValue(FrameworkElement.MarginProperty, new Thickness(6, 2, 6, 2));
            bg.AppendChild(presenter);

            template.VisualTree = bg;

            var hover = new Trigger { Property = UIElement.IsMouseOverProperty, Value = true };
            hover.Setters.Add(new Setter(Border.BackgroundProperty, theme.HoverFill, "Bg"));
            template.Triggers.Add(hover);

            return template;
        }

        // ── Helpers ─────────────────────────────────────────────────────

        private static string ExtractCodeText(FrameworkElement element)
        {
            // Direct Text property — covers AvalonEdit's TextEditor and
            // anything else that exposes a string Text DP.
            var prop = element.GetType().GetProperty("Text");
            if (prop?.GetValue(element) is string s && !string.IsNullOrEmpty(s))
                return s;
            if (element is TextBlock tb && !string.IsNullOrEmpty(tb.Text))
                return tb.Text;

            // MdXaml's no-language fallback wraps the TextBlock in a
            // Border — descend the logical tree to find it.
            foreach (var child in LogicalChildren(element))
            {
                if (child is FrameworkElement childFe)
                {
                    var nested = ExtractCodeText(childFe);
                    if (!string.IsNullOrEmpty(nested)) return nested;
                }
            }
            return string.Empty;
        }

        private static string ResolveLanguageLabel(string? rawTag, FrameworkElement original)
        {
            // BlockUIContainer.Tag — MdXaml stamps the raw language token here.
            string? candidate = rawTag?.Trim();

            // AvalonEdit exposes the chosen syntax def via SyntaxHighlighting.Name.
            if (string.IsNullOrEmpty(candidate))
            {
                var syntaxProp = original.GetType().GetProperty("SyntaxHighlighting");
                if (syntaxProp?.GetValue(original) is { } syntax)
                {
                    var nameProp = syntax.GetType().GetProperty("Name");
                    candidate = nameProp?.GetValue(syntax) as string;
                }
            }

            if (string.IsNullOrWhiteSpace(candidate)) return "code";
            // Strip MdXaml's "lang-" prefix if present so the chip reads cleanly.
            if (candidate.StartsWith("lang-", StringComparison.OrdinalIgnoreCase))
                candidate = candidate.Substring(5);
            return candidate.ToLowerInvariant();
        }

        private static void OnHyperlinkNavigate(object sender, RequestNavigateEventArgs e)
        {
            try
            {
                Process.Start(new ProcessStartInfo
                {
                    FileName = e.Uri.AbsoluteUri,
                    UseShellExecute = true,
                });
                e.Handled = true;
            }
            catch
            {
                // Best-effort — user can copy the URL from the tooltip.
            }
        }

        // ── Theme tokens ───────────────────────────────────────────────

        private sealed record ThemeTokens(
            FontFamily BodyFont,
            FontFamily MonoFont,
            Brush Primary,
            Brush Secondary,
            Brush Border,
            Brush Accent,
            Brush AccentGreen,
            Brush CodeBg,
            Brush CodeFg,
            Brush BadgeFill,
            Brush HoverFill)
        {
            public static ThemeTokens Resolve()
            {
                var r = System.Windows.Application.Current.Resources;
                Brush GetBrush(string key, Brush fallback) =>
                    r.Contains(key) && r[key] is Brush b ? b : fallback;

                var border = GetBrush("Nord.BorderBrush", new SolidColorBrush(Color.FromRgb(60, 64, 72)));
                var accentGreen = GetBrush("Nord.AccentGreenBrush", new SolidColorBrush(Color.FromRgb(143, 188, 143)));
                var badge = GetBrush("Nord.BadgeFillBrush",
                    GetBrush("Nord.PanelBackgroundBrush", new SolidColorBrush(Color.FromRgb(40, 44, 52))));
                return new ThemeTokens(
                    BodyFont: (FontFamily)r["OK.FontFamily"],
                    MonoFont: (FontFamily)r["OK.MonoFontFamily"],
                    Primary: GetBrush("Nord.PrimaryTextBrush", Brushes.White),
                    Secondary: GetBrush("Nord.SecondaryTextBrush", Brushes.LightGray),
                    Border: border,
                    Accent: GetBrush("Nord.AccentBrush", Brushes.SteelBlue),
                    AccentGreen: accentGreen,
                    CodeBg: new SolidColorBrush(Color.FromRgb(0x0A, 0x0C, 0x16)),
                    CodeFg: new SolidColorBrush(Color.FromRgb(220, 220, 224)),
                    BadgeFill: badge,
                    HoverFill: GetBrush("Nord.HoverBrush", new SolidColorBrush(Color.FromArgb(0x22, 0xFF, 0xFF, 0xFF))));
            }
        }
    }
}
