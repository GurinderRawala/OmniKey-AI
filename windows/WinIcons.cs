using System;
using System.Collections.Concurrent;
using System.Drawing;
using System.Drawing.Drawing2D;
using FontAwesome.Sharp;

namespace OmniKey.Windows
{
    /// <summary>
    /// Icon bitmaps for the app. Backed by FontAwesome.Sharp so glyphs render as
    /// proper vector icons (not the hand-drawn GDI+ paths the previous build used).
    /// The public surface mirrors what existing callers expect.
    /// </summary>
    internal static class WinIcons
    {
        private static readonly ConcurrentDictionary<(IconChar, int, int), Bitmap> Cache = new();

        public static Bitmap Get(IconChar icon, int size, Color color)
        {
            var key = (icon, size, color.ToArgb());
            return Cache.GetOrAdd(key, _ => icon.ToBitmap(color, size));
        }

        // ── Basic ──────────────────────────────────────────────────────
        public static Bitmap Checkmark(int size, Color color) => Get(IconChar.Check, size, color);
        public static Bitmap Cross(int size, Color color) => Get(IconChar.Xmark, size, color);
        public static Bitmap Plus(int size, Color color) => Get(IconChar.Plus, size, color);
        public static Bitmap Star(int size, Color color) => Get(IconChar.Star, size, color);
        public static Bitmap Circle(int size, Color color) => Get(IconChar.Circle, size, color);
        public static Bitmap Dot(int size, Color color) => Get(IconChar.Circle, size, color);

        // ── Arrows & chevrons ──────────────────────────────────────────
        public static Bitmap ArrowRight(int size, Color color) => Get(IconChar.ArrowRight, size, color);
        public static Bitmap ArrowUp(int size, Color color) => Get(IconChar.ArrowUp, size, color);
        public static Bitmap ChevronUp(int size, Color color) => Get(IconChar.ChevronUp, size, color);
        public static Bitmap ChevronDown(int size, Color color) => Get(IconChar.ChevronDown, size, color);
        public static Bitmap ChevronUpChevronDown(int size, Color color) => Get(IconChar.Sort, size, color);

        // ── Stop / status ──────────────────────────────────────────────
        public static Bitmap StopSquare(int size, Color color) => Get(IconChar.Stop, size, color);
        public static Bitmap StopFill(int size, Color color) => Get(IconChar.Stop, size, color);
        public static Bitmap StopCircleFill(int size, Color color) => Get(IconChar.CircleStop, size, color);
        public static Bitmap CheckmarkCircleFill(int size, Color color) => Get(IconChar.CircleCheck, size, color);
        public static Bitmap XmarkCircleFill(int size, Color color) => Get(IconChar.CircleXmark, size, color);
        public static Bitmap ExclamationmarkTriangleFill(int size, Color color) => Get(IconChar.TriangleExclamation, size, color);

        // ── Content-type ───────────────────────────────────────────────
        public static Bitmap ListIcon(int size, Color color) => Get(IconChar.ListUl, size, color);
        public static Bitmap Globe(int size, Color color) => Get(IconChar.Globe, size, color);
        public static Bitmap Brain(int size, Color color) => Get(IconChar.Brain, size, color);
        public static Bitmap BrainIcon(int size, Color color) => Brain(size, color);
        public static Bitmap TerminalIcon(int size, Color color) => Get(IconChar.Terminal, size, color);
        public static Bitmap QuoteIcon(int size, Color color) => Get(IconChar.QuoteRight, size, color);
        public static Bitmap KeyIcon(int size, Color color) => Get(IconChar.Key, size, color);
        public static Bitmap DocOnDoc(int size, Color color) => Get(IconChar.Copy, size, color);
        public static Bitmap ClipboardIcon(int size, Color color) => Get(IconChar.Copy, size, color);
        public static Bitmap ClockIcon(int size, Color color) => Get(IconChar.Clock, size, color);
        public static Bitmap ClockArrowCirclepath(int size, Color color) => Get(IconChar.ClockRotateLeft, size, color);
        public static Bitmap Photo(int size, Color color) => Get(IconChar.Image, size, color);
        public static Bitmap ServerRack(int size, Color color) => Get(IconChar.Server, size, color);
        public static Bitmap ServerIcon(int size, Color color) => ServerRack(size, color);
        public static Bitmap CalendarBadgeClock(int size, Color color) => Get(IconChar.CalendarDays, size, color);
        public static Bitmap TextBadgeStar(int size, Color color) => Get(IconChar.Star, size, color);

        // ── UI affordances ─────────────────────────────────────────────
        public static Bitmap MagnifyingGlass(int size, Color color) => Get(IconChar.MagnifyingGlass, size, color);
        public static Bitmap SquareAndPencil(int size, Color color) => Get(IconChar.PenToSquare, size, color);
        public static Bitmap SidebarLeft(int size, Color color) => Get(IconChar.BarsStaggered, size, color);
        public static Bitmap SidebarRight(int size, Color color) => Get(IconChar.BarsStaggered, size, color);
        public static Bitmap Sparkles(int size, Color color) => Get(IconChar.WandMagicSparkles, size, color);
    }

    // Shared GDI+ geometry helpers.
    internal static class GfxHelpers
    {
        public static GraphicsPath RoundedPath(RectangleF r, float radius)
        {
            float maxRadius = Math.Min(r.Width, r.Height) / 2f;
            radius = Math.Max(0, Math.Min(radius, maxRadius));

            var p = new GraphicsPath();
            if (radius <= 0 || r.Width <= 0 || r.Height <= 0)
            {
                if (r.Width > 0 && r.Height > 0) p.AddRectangle(r);
                return p;
            }

            float d = radius * 2;
            p.AddArc(r.X, r.Y, d, d, 180, 90);
            p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
            p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
            p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
            p.CloseFigure();
            return p;
        }

        public static void FillRoundedRect(Graphics g, Brush brush, RectangleF r, float radius)
        {
            using var path = RoundedPath(r, radius);
            g.FillPath(brush, path);
        }

        public static void DrawRoundedRect(Graphics g, Pen pen, RectangleF r, float radius)
        {
            using var path = RoundedPath(r, radius);
            g.DrawPath(pen, path);
        }
    }
}
