using System;
using System.Drawing;
using System.Drawing.Drawing2D;

namespace OmniKey.Windows
{
    /// <summary>
    /// GDI+-drawn icon bitmaps. Replaces Unicode block/symbol characters that may
    /// not render reliably across all Windows fonts and locales.
    /// </summary>
    internal static class WinIcons
    {
        // ── Icon bitmaps ─────────────────────────────────────────────────────

        public static Bitmap Checkmark(int size, Color color)
        {
            var bmp = Blank(size);
            using var g = AA(bmp);
            using var pen = RoundPen(color, size * 0.13f);
            g.DrawLines(pen, new[]
            {
                new PointF(size * 0.15f, size * 0.52f),
                new PointF(size * 0.40f, size * 0.78f),
                new PointF(size * 0.85f, size * 0.22f),
            });
            return bmp;
        }

        public static Bitmap Cross(int size, Color color)
        {
            var bmp = Blank(size);
            using var g = AA(bmp);
            using var pen = RoundPen(color, size * 0.13f);
            float p = size * 0.22f;
            g.DrawLine(pen, p, p, size - p, size - p);
            g.DrawLine(pen, size - p, p, p, size - p);
            return bmp;
        }

        public static Bitmap StopSquare(int size, Color color)
        {
            var bmp = Blank(size);
            using var g = AA(bmp);
            float p = size * 0.22f, w = size - p * 2;
            using var brush = new SolidBrush(color);
            using var path  = GfxHelpers.RoundedPath(new RectangleF(p, p, w, w), size * 0.12f);
            g.FillPath(brush, path);
            return bmp;
        }

        public static Bitmap Dot(int size, Color color)
        {
            var bmp = Blank(size);
            using var g = AA(bmp);
            float p = size * 0.1f;
            using var brush = new SolidBrush(color);
            g.FillEllipse(brush, p, p, size - p * 2, size - p * 2);
            return bmp;
        }

        public static Bitmap Star(int size, Color color)
        {
            var bmp = Blank(size);
            using var g = AA(bmp);
            using var brush = new SolidBrush(color);
            g.FillPolygon(brush, StarPoints(size / 2f, size / 2f, size * 0.44f, size * 0.18f, 5));
            return bmp;
        }

        public static Bitmap ArrowRight(int size, Color color)
        {
            var bmp = Blank(size);
            using var g = AA(bmp);
            using var pen = RoundPen(color, size * 0.12f);
            float m = size / 2f, right = size * 0.82f, head = size * 0.22f;
            g.DrawLine(pen, size * 0.12f, m, right, m);
            g.DrawLine(pen, right - head, m - head, right, m);
            g.DrawLine(pen, right - head, m + head, right, m);
            return bmp;
        }

        public static Bitmap ListIcon(int size, Color color)
        {
            var bmp = Blank(size);
            using var g = AA(bmp);
            using var pen = RoundPen(color, size * 0.10f);
            float l = size * 0.18f, r = size * 0.82f;
            g.DrawLine(pen, l, size * 0.28f, r, size * 0.28f);
            g.DrawLine(pen, l, size * 0.50f, r, size * 0.50f);
            g.DrawLine(pen, l, size * 0.72f, r, size * 0.72f);
            return bmp;
        }

        /// <summary>
        /// Draws a simple key outline icon (used in the LicenseForm).
        /// </summary>
        public static Bitmap KeyIcon(int size, Color color)
        {
            var bmp = Blank(size);
            using var g = AA(bmp);
            using var pen = RoundPen(color, size * 0.10f);
            float r = size * 0.30f;
            float cx = size * 0.32f, cy = size * 0.38f;
            g.DrawEllipse(pen, cx - r, cy - r, r * 2, r * 2);
            float stemY = cy + r * 0.05f;
            float stemX = cx + r;
            g.DrawLine(pen, stemX, stemY, size * 0.88f, stemY);
            g.DrawLine(pen, size * 0.70f, stemY, size * 0.70f, stemY + size * 0.18f);
            g.DrawLine(pen, size * 0.82f, stemY, size * 0.82f, stemY + size * 0.13f);
            return bmp;
        }

        // ── Private helpers ───────────────────────────────────────────────────

        private static Bitmap Blank(int size) => new Bitmap(size, size);

        private static Graphics AA(Bitmap bmp)
        {
            var g = Graphics.FromImage(bmp);
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.Clear(Color.Transparent);
            return g;
        }

        private static Pen RoundPen(Color color, float thickness)
        {
            var pen = new Pen(color, Math.Max(1.2f, thickness));
            pen.StartCap = pen.EndCap = LineCap.Round;
            pen.LineJoin = LineJoin.Round;
            return pen;
        }

        private static PointF[] StarPoints(float cx, float cy, float outerR, float innerR, int n)
        {
            var pts = new PointF[n * 2];
            for (int i = 0; i < n * 2; i++)
            {
                float angle = (float)(Math.PI * i / n) - (float)(Math.PI / 2);
                float rad = i % 2 == 0 ? outerR : innerR;
                pts[i] = new PointF(cx + rad * (float)Math.Cos(angle),
                                    cy + rad * (float)Math.Sin(angle));
            }
            return pts;
        }
    }

    // ── Shared GDI+ geometry helpers ──────────────────────────────────────────

    internal static class GfxHelpers
    {
        public static GraphicsPath RoundedPath(RectangleF r, float radius)
        {
            float d = radius * 2;
            var p = new GraphicsPath();
            p.AddArc(r.X,         r.Y,          d, d, 180, 90);
            p.AddArc(r.Right - d, r.Y,          d, d, 270, 90);
            p.AddArc(r.Right - d, r.Bottom - d, d, d,   0, 90);
            p.AddArc(r.X,         r.Bottom - d, d, d,  90, 90);
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
