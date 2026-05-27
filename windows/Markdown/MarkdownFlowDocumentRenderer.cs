using System;
using System.Diagnostics;
using System.Linq;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Documents;
using System.Windows.Media;
using System.Windows.Navigation;
using Markdig;
using Markdig.Syntax;
using Markdig.Syntax.Inlines;
using MdBlock = Markdig.Syntax.Block;
using WpfBlock = System.Windows.Documents.Block;
using WpfList = System.Windows.Documents.List;

namespace OmniKey.Windows.MarkdownRender
{
    /// <summary>
    /// Light-weight CommonMark → WPF <see cref="FlowDocument"/> renderer.
    /// Built directly on Markdig's AST so we don't take a transitive
    /// dependency on Markdig.Wpf (which lags a Markdig major version).
    /// Supports headings, paragraphs, lists (ordered + unordered), code
    /// blocks (fenced + indented), inline code, bold/italic emphasis,
    /// links, and horizontal rules — which covers everything the agent
    /// emits in a final answer.
    /// </summary>
    public static class MarkdownFlowDocumentRenderer
    {
        private static readonly MarkdownPipeline Pipeline =
            new MarkdownPipelineBuilder().UseAdvancedExtensions().Build();

        public static FlowDocument Render(string? markdown, FontFamily bodyFont, FontFamily monoFont, Brush primary, Brush secondary, Brush codeBg, Brush border, Brush accent)
        {
            var doc = new FlowDocument
            {
                FontFamily = bodyFont,
                FontSize = 13.5,
                Foreground = primary,
                Background = Brushes.Transparent,
                PagePadding = new Thickness(0),
                TextAlignment = TextAlignment.Left,
                IsOptimalParagraphEnabled = true,
                IsHyphenationEnabled = false,
            };

            if (string.IsNullOrWhiteSpace(markdown)) return doc;

            try
            {
                var ast = Markdig.Markdown.Parse(markdown, Pipeline);
                foreach (var block in ast)
                {
                    var rendered = RenderBlock(block, monoFont, secondary, codeBg, border, accent);
                    if (rendered != null) doc.Blocks.Add(rendered);
                }
            }
            catch (Exception ex)
            {
                // Fall back to plain text — never let a malformed answer break the UI.
                Debug.WriteLine("MarkdownRender failed: " + ex);
                doc.Blocks.Clear();
                doc.Blocks.Add(new Paragraph(new Run(markdown)));
            }

            return doc;
        }

        // ── Block-level ──────────────────────────────────────────────

        private static WpfBlock? RenderBlock(MdBlock block, FontFamily monoFont, Brush secondary, Brush codeBg, Brush border, Brush accent)
        {
            switch (block)
            {
                case HeadingBlock h:
                    var para = new Paragraph
                    {
                        FontWeight = FontWeights.SemiBold,
                        FontSize = h.Level switch
                        {
                            1 => 22,
                            2 => 18,
                            3 => 16,
                            4 => 14.5,
                            _ => 13.5,
                        },
                        Margin = new Thickness(0, h.Level == 1 ? 4 : 10, 0, 6),
                    };
                    if (h.Inline != null) RenderInlines(h.Inline, para.Inlines, monoFont, codeBg, border, accent);
                    return para;

                case ParagraphBlock p:
                    var pp = new Paragraph
                    {
                        Margin = new Thickness(0, 0, 0, 8),
                        LineHeight = 20,
                    };
                    if (p.Inline != null) RenderInlines(p.Inline, pp.Inlines, monoFont, codeBg, border, accent);
                    return pp;

                case FencedCodeBlock fenced:
                    return BuildCodeParagraph(fenced.Lines.ToString(), monoFont, codeBg, border);

                case CodeBlock code:
                    return BuildCodeParagraph(code.Lines.ToString(), monoFont, codeBg, border);

                case QuoteBlock quote:
                    var section = new Section
                    {
                        Margin = new Thickness(0, 0, 0, 8),
                        Padding = new Thickness(12, 6, 8, 6),
                        BorderBrush = accent,
                        BorderThickness = new Thickness(3, 0, 0, 0),
                    };
                    foreach (var child in quote)
                    {
                        var rendered = RenderBlock(child, monoFont, secondary, codeBg, border, accent);
                        if (rendered != null) section.Blocks.Add(rendered);
                    }
                    return section;

                case ListBlock list:
                    return BuildList(list, monoFont, secondary, codeBg, border, accent);

                case ThematicBreakBlock:
                    var rule = new BlockUIContainer(new Border
                    {
                        Height = 1,
                        Margin = new Thickness(0, 8, 0, 8),
                        Background = border,
                    });
                    return rule;

                default:
                    return null;
            }
        }

        private static WpfList BuildList(ListBlock listBlock, FontFamily monoFont, Brush secondary, Brush codeBg, Brush border, Brush accent)
        {
            var wpfList = new WpfList
            {
                MarkerStyle = listBlock.IsOrdered ? TextMarkerStyle.Decimal : TextMarkerStyle.Disc,
                Margin = new Thickness(0, 0, 0, 8),
                Padding = new Thickness(0),
            };

            foreach (var child in listBlock)
            {
                if (child is not ListItemBlock item) continue;
                var li = new ListItem { Margin = new Thickness(0, 0, 0, 4) };
                foreach (var sub in item)
                {
                    var rendered = RenderBlock(sub, monoFont, secondary, codeBg, border, accent);
                    if (rendered != null) li.Blocks.Add(rendered);
                }
                wpfList.ListItems.Add(li);
            }

            return wpfList;
        }

        private static Paragraph BuildCodeParagraph(string code, FontFamily monoFont, Brush codeBg, Brush border)
        {
            var border1 = new Border
            {
                Background = codeBg,
                BorderBrush = border,
                BorderThickness = new Thickness(1),
                CornerRadius = new CornerRadius(6),
                Padding = new Thickness(10, 8, 10, 8),
                Margin = new Thickness(0, 2, 0, 8),
                Child = new TextBlock
                {
                    Text = code.TrimEnd('\n', '\r'),
                    FontFamily = monoFont,
                    FontSize = 12.5,
                    Foreground = new SolidColorBrush(Color.FromRgb(220, 220, 224)),
                    TextWrapping = TextWrapping.NoWrap,
                },
            };
            return new Paragraph(new InlineUIContainer(new ScrollViewer
            {
                HorizontalScrollBarVisibility = ScrollBarVisibility.Auto,
                VerticalScrollBarVisibility = ScrollBarVisibility.Disabled,
                Content = border1,
                Background = Brushes.Transparent,
                BorderThickness = new Thickness(0),
                Padding = new Thickness(0),
            }))
            {
                Margin = new Thickness(0),
            };
        }

        // ── Inline-level ─────────────────────────────────────────────

        private static void RenderInlines(ContainerInline container, InlineCollection target, FontFamily monoFont, Brush codeBg, Brush border, Brush accent)
        {
            for (var node = container.FirstChild; node != null; node = node.NextSibling)
            {
                switch (node)
                {
                    case LiteralInline lit:
                        target.Add(new Run(lit.Content.ToString()));
                        break;

                    case EmphasisInline em:
                        Span span = em.DelimiterCount >= 2 ? new Bold() : new Italic();
                        RenderInlines(em, span.Inlines, monoFont, codeBg, border, accent);
                        target.Add(span);
                        break;

                    case CodeInline code:
                        target.Add(new Run(code.Content)
                        {
                            FontFamily = monoFont,
                            FontSize = 12,
                            Background = codeBg,
                            Foreground = new SolidColorBrush(Color.FromRgb(220, 220, 224)),
                        });
                        break;

                    case LinkInline link:
                        if (Uri.TryCreate(link.Url, UriKind.Absolute, out var uri))
                        {
                            var hyper = new Hyperlink { NavigateUri = uri, Foreground = accent };
                            RenderInlines(link, hyper.Inlines, monoFont, codeBg, border, accent);
                            hyper.RequestNavigate += OnHyperlinkNavigate;
                            target.Add(hyper);
                        }
                        else
                        {
                            // Relative or invalid URL — render the label as plain text.
                            RenderInlines(link, target, monoFont, codeBg, border, accent);
                        }
                        break;

                    case LineBreakInline:
                        target.Add(new LineBreak());
                        break;

                    case ContainerInline c:
                        RenderInlines(c, target, monoFont, codeBg, border, accent);
                        break;

                    default:
                        // Fallback — emit the raw text representation so nothing's silently dropped.
                        var text = node.ToString();
                        if (!string.IsNullOrEmpty(text)) target.Add(new Run(text));
                        break;
                }
            }
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
    }
}
