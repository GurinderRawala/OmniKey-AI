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
        public static Bitmap Checkmark(int size, Color color)
        {
            var bmp = Blank(size);
            using var g = AA(bmp);
            using var pen = RoundPen(color, size * 0.12f);

            g.DrawLines(pen, new[]
            {
                new PointF(size * 0.22f, size * 0.52f),
                new PointF(size * 0.42f, size * 0.72f),
                new PointF(size * 0.78f, size * 0.30f),
            });

            return bmp;
        }

        public static Bitmap Cross(int size, Color color)
        {
            var bmp = Blank(size);
            using var g = AA(bmp);
            using var pen = RoundPen(color, size * 0.12f);
            float p = size * 0.28f;

            g.DrawLine(pen, p, p, size - p, size - p);
            g.DrawLine(pen, size - p, p, p, size - p);

            return bmp;
        }

        public static Bitmap StopSquare(int size, Color color)
        {
            var bmp = Blank(size);
            using var g = AA(bmp);
            using var brush = new SolidBrush(color);

            float side = size * 0.46f;
            float p = (size - side) / 2f;
            using var path = GfxHelpers.RoundedPath(new RectangleF(p, p, side, side), size * 0.08f);
            g.FillPath(brush, path);

            return bmp;
        }

        public static Bitmap Dot(int size, Color color)
        {
            var bmp = Blank(size);
            using var g = AA(bmp);
            using var brush = new SolidBrush(color);

            float r = size * 0.25f;
            float cx = size / 2f;
            float cy = size / 2f;
            g.FillEllipse(brush, cx - r, cy - r, r * 2, r * 2);

            return bmp;
        }

        public static Bitmap Star(int size, Color color)
        {
            var bmp = Blank(size);
            using var g = AA(bmp);
            using var brush = new SolidBrush(color);

            g.FillPolygon(brush, StarPoints(size / 2f, size / 2f, size * 0.42f, size * 0.18f, 5));

            return bmp;
        }

        public static Bitmap ArrowRight(int size, Color color)
        {
            var bmp = Blank(size);
            using var g = AA(bmp);
            using var pen = RoundPen(color, size * 0.12f);

            float cy = size / 2f;
            float left = size * 0.22f;
            float right = size * 0.78f;
            float head = size * 0.20f;
            g.DrawLine(pen, left, cy, right, cy);
            g.DrawLine(pen, right - head, cy - head, right, cy);
            g.DrawLine(pen, right - head, cy + head, right, cy);

            return bmp;
        }

        public static Bitmap ArrowUp(int size, Color color)
        {
            var bmp = Blank(size);
            using var g = AA(bmp);
            using var pen = RoundPen(color, size * 0.12f);

            float cx = size / 2f;
            float top = size * 0.22f;
            float bottom = size * 0.78f;
            float head = size * 0.20f;
            g.DrawLine(pen, cx, bottom, cx, top);
            g.DrawLine(pen, cx - head, top + head, cx, top);
            g.DrawLine(pen, cx + head, top + head, cx, top);

            return bmp;
        }

        public static Bitmap ListIcon(int size, Color color)
        {
            var bmp = Blank(size);
            using var g = AA(bmp);
            using var pen = RoundPen(color, size * 0.10f);

            float left = size * 0.24f;
            float right = size * 0.76f;
            g.DrawLine(pen, left, size * 0.32f, right, size * 0.32f);
            g.DrawLine(pen, left, size * 0.50f, right, size * 0.50f);
            g.DrawLine(pen, left, size * 0.68f, right, size * 0.68f);

            return bmp;
        }

        public static Bitmap Globe(int size, Color color)
        {
            var bmp = Blank(size);
            using var g = AA(bmp);
            using var pen = RoundPen(color, size * 0.08f);

            float cx = size / 2f;
            float cy = size / 2f;
            float r = size * 0.38f;
            var bounds = new RectangleF(cx - r, cy - r, r * 2, r * 2);
            g.DrawEllipse(pen, bounds);
            g.DrawLine(pen, cx - r, cy, cx + r, cy);
            g.DrawArc(pen, new RectangleF(cx - r * 0.48f, cy - r, r * 0.96f, r * 2), 90, 180);
            g.DrawArc(pen, new RectangleF(cx - r * 0.48f, cy - r, r * 0.96f, r * 2), 270, 180);

            return bmp;
        }

        public static Bitmap BrainIcon(int size, Color color) => Brain(size, color);

        public static Bitmap Brain(int size, Color color)
        {
            var bmp = Blank(size);
            using var g = AA(bmp);
            using var pen = RoundPen(color, size * 0.075f);

            float s = size;
            using var outer = new GraphicsPath();
            outer.StartFigure();
            outer.AddBezier(s * 0.50f, s * 0.78f, s * 0.30f, s * 0.80f, s * 0.18f, s * 0.66f, s * 0.24f, s * 0.51f);
            outer.AddBezier(s * 0.24f, s * 0.51f, s * 0.13f, s * 0.42f, s * 0.22f, s * 0.25f, s * 0.38f, s * 0.29f);
            outer.AddBezier(s * 0.38f, s * 0.29f, s * 0.40f, s * 0.15f, s * 0.61f, s * 0.15f, s * 0.63f, s * 0.29f);
            outer.AddBezier(s * 0.63f, s * 0.29f, s * 0.80f, s * 0.24f, s * 0.90f, s * 0.42f, s * 0.76f, s * 0.52f);
            outer.AddBezier(s * 0.76f, s * 0.52f, s * 0.83f, s * 0.66f, s * 0.70f, s * 0.80f, s * 0.50f, s * 0.78f);
            g.DrawPath(pen, outer);

            g.DrawBezier(pen, s * 0.50f, s * 0.25f, s * 0.45f, s * 0.38f, s * 0.46f, s * 0.55f, s * 0.50f, s * 0.72f);
            g.DrawBezier(pen, s * 0.30f, s * 0.48f, s * 0.38f, s * 0.44f, s * 0.41f, s * 0.36f, s * 0.39f, s * 0.29f);
            g.DrawBezier(pen, s * 0.70f, s * 0.48f, s * 0.62f, s * 0.44f, s * 0.59f, s * 0.36f, s * 0.61f, s * 0.29f);
            g.DrawBezier(pen, s * 0.30f, s * 0.59f, s * 0.38f, s * 0.62f, s * 0.42f, s * 0.67f, s * 0.43f, s * 0.75f);
            g.DrawBezier(pen, s * 0.70f, s * 0.59f, s * 0.62f, s * 0.62f, s * 0.58f, s * 0.67f, s * 0.57f, s * 0.75f);

            return bmp;
        }

        public static Bitmap TerminalIcon(int size, Color color)
        {
            var bmp = Blank(size);
            using var g = AA(bmp);
            using var pen = RoundPen(color, size * 0.10f);

            float s = size;
            g.DrawLine(pen, s * 0.24f, s * 0.34f, s * 0.44f, s * 0.50f);
            g.DrawLine(pen, s * 0.24f, s * 0.66f, s * 0.44f, s * 0.50f);
            g.DrawLine(pen, s * 0.55f, s * 0.66f, s * 0.78f, s * 0.66f);

            return bmp;
        }

        public static Bitmap QuoteIcon(int size, Color color)
        {
            var bmp = Blank(size);
            using var g = AA(bmp);
            using var pen = RoundPen(color, size * 0.10f);

            DrawQuote(g, pen, size * 0.23f, size * 0.25f, size * 0.20f);
            DrawQuote(g, pen, size * 0.55f, size * 0.25f, size * 0.20f);

            return bmp;
        }

        public static Bitmap KeyIcon(int size, Color color)
        {
            var bmp = Blank(size);
            using var g = AA(bmp);
            using var pen = RoundPen(color, size * 0.09f);

            float s = size;
            float r = s * 0.16f;
            float cx = s * 0.34f;
            float cy = s * 0.42f;
            g.DrawEllipse(pen, cx - r, cy - r, r * 2, r * 2);
            g.DrawLine(pen, cx + r, cy, s * 0.78f, cy);
            g.DrawLine(pen, s * 0.62f, cy, s * 0.62f, s * 0.58f);
            g.DrawLine(pen, s * 0.74f, cy, s * 0.74f, s * 0.53f);

            return bmp;
        }

        public static Bitmap ClipboardIcon(int size, Color color) => DocOnDoc(size, color);

        public static Bitmap ClockIcon(int size, Color color)
        {
            var bmp = Blank(size);
            using var g = AA(bmp);
            using var pen = RoundPen(color, size * 0.08f);

            float cx = size / 2f;
            float cy = size / 2f;
            float r = size * 0.36f;
            g.DrawEllipse(pen, cx - r, cy - r, r * 2, r * 2);
            g.DrawLine(pen, cx, cy, cx, cy - r * 0.52f);
            g.DrawLine(pen, cx, cy, cx + r * 0.46f, cy + r * 0.20f);

            return bmp;
        }

        public static Bitmap ServerIcon(int size, Color color) => ServerRack(size, color);

        public static Bitmap SidebarLeft(int size, Color color)
        {
            var bmp = Blank(size);
            using var g = AA(bmp);
            using var pen = RoundPen(color, size * 0.075f);

            float s = size;
            var rect = new RectangleF(s * 0.18f, s * 0.20f, s * 0.64f, s * 0.60f);
            using var path = GfxHelpers.RoundedPath(rect, s * 0.09f);
            g.DrawPath(pen, path);
            g.DrawLine(pen, s * 0.40f, s * 0.22f, s * 0.40f, s * 0.78f);
            g.DrawLine(pen, s * 0.26f, s * 0.36f, s * 0.32f, s * 0.36f);
            g.DrawLine(pen, s * 0.26f, s * 0.50f, s * 0.32f, s * 0.50f);

            return bmp;
        }

        public static Bitmap SquareAndPencil(int size, Color color)
        {
            var bmp = Blank(size);
            using var g = AA(bmp);
            using var pen = RoundPen(color, size * 0.075f);

            float s = size;
            using (var path = GfxHelpers.RoundedPath(new RectangleF(s * 0.20f, s * 0.26f, s * 0.48f, s * 0.54f), s * 0.08f))
            {
                g.DrawPath(pen, path);
            }

            g.DrawLine(pen, s * 0.47f, s * 0.58f, s * 0.78f, s * 0.27f);
            g.DrawLine(pen, s * 0.70f, s * 0.20f, s * 0.84f, s * 0.34f);
            g.DrawLine(pen, s * 0.78f, s * 0.27f, s * 0.84f, s * 0.34f);
            g.DrawLine(pen, s * 0.43f, s * 0.65f, s * 0.47f, s * 0.58f);

            return bmp;
        }

        public static Bitmap MagnifyingGlass(int size, Color color)
        {
            var bmp = Blank(size);
            using var g = AA(bmp);
            using var pen = RoundPen(color, size * 0.09f);

            float s = size;
            float r = s * 0.22f;
            float cx = s * 0.43f;
            float cy = s * 0.43f;
            g.DrawEllipse(pen, cx - r, cy - r, r * 2, r * 2);
            g.DrawLine(pen, s * 0.60f, s * 0.60f, s * 0.78f, s * 0.78f);

            return bmp;
        }

        public static Bitmap XmarkCircleFill(int size, Color color)
        {
            var bmp = Blank(size);
            using var g = AA(bmp);
            using var fill = new SolidBrush(color);
            using var cut = RoundPen(InvertedFor(color), size * 0.10f);

            float s = size;
            float r = s * 0.40f;
            g.FillEllipse(fill, s * 0.50f - r, s * 0.50f - r, r * 2, r * 2);
            g.DrawLine(cut, s * 0.38f, s * 0.38f, s * 0.62f, s * 0.62f);
            g.DrawLine(cut, s * 0.62f, s * 0.38f, s * 0.38f, s * 0.62f);

            return bmp;
        }

        public static Bitmap Sparkles(int size, Color color)
        {
            var bmp = Blank(size);
            using var g = AA(bmp);
            using var brush = new SolidBrush(color);

            DrawSpark(g, brush, size * 0.50f, size * 0.34f, size * 0.24f);
            DrawSpark(g, brush, size * 0.28f, size * 0.68f, size * 0.13f);
            DrawSpark(g, brush, size * 0.72f, size * 0.66f, size * 0.10f);

            return bmp;
        }

        public static Bitmap StopFill(int size, Color color)
        {
            var bmp = Blank(size);
            using var g = AA(bmp);
            using var brush = new SolidBrush(color);

            float side = size * 0.42f;
            float p = (size - side) / 2f;
            using var path = GfxHelpers.RoundedPath(new RectangleF(p, p, side, side), size * 0.055f);
            g.FillPath(brush, path);

            return bmp;
        }

        public static Bitmap DocOnDoc(int size, Color color)
        {
            var bmp = Blank(size);
            using var g = AA(bmp);
            using var pen = RoundPen(color, size * 0.075f);

            float s = size;
            DrawDocument(g, pen, new RectangleF(s * 0.32f, s * 0.18f, s * 0.42f, s * 0.50f), s * 0.07f);
            DrawDocument(g, pen, new RectangleF(s * 0.22f, s * 0.32f, s * 0.42f, s * 0.50f), s * 0.07f);

            return bmp;
        }

        public static Bitmap ChevronUp(int size, Color color)
        {
            var bmp = Blank(size);
            using var g = AA(bmp);
            using var pen = RoundPen(color, size * 0.11f);

            DrawChevron(g, pen, size, true, 0.50f);

            return bmp;
        }

        public static Bitmap ChevronDown(int size, Color color)
        {
            var bmp = Blank(size);
            using var g = AA(bmp);
            using var pen = RoundPen(color, size * 0.11f);

            DrawChevron(g, pen, size, false, 0.50f);

            return bmp;
        }

        public static Bitmap ChevronUpChevronDown(int size, Color color)
        {
            var bmp = Blank(size);
            using var g = AA(bmp);
            using var pen = RoundPen(color, size * 0.095f);

            DrawChevron(g, pen, size, true, 0.34f);
            DrawChevron(g, pen, size, false, 0.66f);

            return bmp;
        }

        public static Bitmap Photo(int size, Color color)
        {
            var bmp = Blank(size);
            using var g = AA(bmp);
            using var pen = RoundPen(color, size * 0.075f);

            float s = size;
            var rect = new RectangleF(s * 0.18f, s * 0.24f, s * 0.64f, s * 0.54f);
            using (var path = GfxHelpers.RoundedPath(rect, s * 0.08f))
            {
                g.DrawPath(pen, path);
            }

            g.DrawEllipse(pen, s * 0.58f, s * 0.34f, s * 0.12f, s * 0.12f);
            g.DrawLines(pen, new[]
            {
                new PointF(s * 0.24f, s * 0.68f),
                new PointF(s * 0.40f, s * 0.52f),
                new PointF(s * 0.52f, s * 0.64f),
                new PointF(s * 0.62f, s * 0.56f),
                new PointF(s * 0.76f, s * 0.70f),
            });

            return bmp;
        }

        public static Bitmap ServerRack(int size, Color color)
        {
            var bmp = Blank(size);
            using var g = AA(bmp);
            using var pen = RoundPen(color, size * 0.07f);
            using var brush = new SolidBrush(color);

            float s = size;
            float x = s * 0.18f;
            float w = s * 0.64f;
            float h = s * 0.18f;
            float radius = s * 0.055f;
            for (int i = 0; i < 3; i++)
            {
                float y = s * (0.22f + i * 0.22f);
                var rect = new RectangleF(x, y, w, h);
                using var path = GfxHelpers.RoundedPath(rect, radius);
                g.DrawPath(pen, path);
                g.FillEllipse(brush, x + w - h * 0.72f, y + h * 0.34f, h * 0.32f, h * 0.32f);
                g.DrawLine(pen, x + h * 0.45f, y + h * 0.50f, x + w * 0.52f, y + h * 0.50f);
            }

            return bmp;
        }

        public static Bitmap CalendarBadgeClock(int size, Color color)
        {
            var bmp = Blank(size);
            using var g = AA(bmp);
            using var pen = RoundPen(color, size * 0.07f);
            using var fill = new SolidBrush(color);

            float s = size;
            var rect = new RectangleF(s * 0.18f, s * 0.22f, s * 0.54f, s * 0.54f);
            using (var path = GfxHelpers.RoundedPath(rect, s * 0.075f))
            {
                g.DrawPath(pen, path);
            }

            g.DrawLine(pen, s * 0.18f, s * 0.38f, s * 0.72f, s * 0.38f);
            g.DrawLine(pen, s * 0.32f, s * 0.15f, s * 0.32f, s * 0.28f);
            g.DrawLine(pen, s * 0.58f, s * 0.15f, s * 0.58f, s * 0.28f);

            float cx = s * 0.68f;
            float cy = s * 0.68f;
            float r = s * 0.18f;
            g.FillEllipse(fill, cx - r, cy - r, r * 2, r * 2);
            using var cut = RoundPen(InvertedFor(color), size * 0.055f);
            g.DrawLine(cut, cx, cy, cx, cy - r * 0.46f);
            g.DrawLine(cut, cx, cy, cx + r * 0.38f, cy + r * 0.16f);

            return bmp;
        }

        public static Bitmap TextBadgeStar(int size, Color color)
        {
            var bmp = Blank(size);
            using var g = AA(bmp);
            using var pen = RoundPen(color, size * 0.07f);
            using var brush = new SolidBrush(color);

            float s = size;
            DrawDocument(g, pen, new RectangleF(s * 0.20f, s * 0.18f, s * 0.50f, s * 0.62f), s * 0.07f);
            g.DrawLine(pen, s * 0.30f, s * 0.38f, s * 0.58f, s * 0.38f);
            g.DrawLine(pen, s * 0.30f, s * 0.52f, s * 0.54f, s * 0.52f);

            using var badge = new SolidBrush(InvertedFor(color));
            float cx = s * 0.70f;
            float cy = s * 0.70f;
            float r = s * 0.18f;
            g.FillEllipse(badge, cx - r * 1.05f, cy - r * 1.05f, r * 2.1f, r * 2.1f);
            g.FillPolygon(brush, StarPoints(cx, cy, r * 0.88f, r * 0.38f, 5));

            return bmp;
        }

        public static Bitmap Plus(int size, Color color)
        {
            var bmp = Blank(size);
            using var g = AA(bmp);
            using var pen = RoundPen(color, size * 0.12f);

            float c = size / 2f;
            float p = size * 0.26f;
            g.DrawLine(pen, c, p, c, size - p);
            g.DrawLine(pen, p, c, size - p, c);

            return bmp;
        }

        public static Bitmap ExclamationmarkTriangleFill(int size, Color color)
        {
            var bmp = Blank(size);
            using var g = AA(bmp);
            using var fill = new SolidBrush(color);

            float s = size;
            var pts = new[]
            {
                new PointF(s * 0.50f, s * 0.16f),
                new PointF(s * 0.84f, s * 0.78f),
                new PointF(s * 0.16f, s * 0.78f),
            };
            g.FillPolygon(fill, pts);

            using var cut = RoundPen(InvertedFor(color), size * 0.085f);
            g.DrawLine(cut, s * 0.50f, s * 0.38f, s * 0.50f, s * 0.58f);
            using var dot = new SolidBrush(InvertedFor(color));
            g.FillEllipse(dot, s * 0.46f, s * 0.66f, s * 0.08f, s * 0.08f);

            return bmp;
        }

        public static Bitmap ClockArrowCirclepath(int size, Color color)
        {
            var bmp = Blank(size);
            using var g = AA(bmp);
            using var pen = RoundPen(color, size * 0.075f);

            float s = size;
            float cx = s / 2f;
            float cy = s / 2f;
            float r = s * 0.33f;
            var arc = new RectangleF(cx - r, cy - r, r * 2, r * 2);
            g.DrawArc(pen, arc, 35, 285);
            g.DrawLine(pen, s * 0.70f, s * 0.18f, s * 0.84f, s * 0.20f);
            g.DrawLine(pen, s * 0.70f, s * 0.18f, s * 0.74f, s * 0.32f);
            g.DrawLine(pen, cx, cy, cx, cy - r * 0.48f);
            g.DrawLine(pen, cx, cy, cx + r * 0.42f, cy + r * 0.18f);

            return bmp;
        }

        public static Bitmap CheckmarkCircleFill(int size, Color color)
        {
            var bmp = Blank(size);
            using var g = AA(bmp);
            using var fill = new SolidBrush(color);
            using var cut = RoundPen(InvertedFor(color), size * 0.09f);

            float s = size;
            float r = s * 0.40f;
            g.FillEllipse(fill, s * 0.50f - r, s * 0.50f - r, r * 2, r * 2);
            g.DrawLines(cut, new[]
            {
                new PointF(s * 0.34f, s * 0.52f),
                new PointF(s * 0.46f, s * 0.63f),
                new PointF(s * 0.66f, s * 0.39f),
            });

            return bmp;
        }

        public static Bitmap Circle(int size, Color color)
        {
            var bmp = Blank(size);
            using var g = AA(bmp);
            using var pen = RoundPen(color, size * 0.08f);

            float r = size * 0.36f;
            float c = size / 2f;
            g.DrawEllipse(pen, c - r, c - r, r * 2, r * 2);

            return bmp;
        }

        public static Bitmap StopCircleFill(int size, Color color)
        {
            var bmp = Blank(size);
            using var g = AA(bmp);
            using var fill = new SolidBrush(color);
            using var cut = new SolidBrush(InvertedFor(color));

            float s = size;
            float r = s * 0.40f;
            g.FillEllipse(fill, s * 0.50f - r, s * 0.50f - r, r * 2, r * 2);
            float side = s * 0.28f;
            float p = (s - side) / 2f;
            using var path = GfxHelpers.RoundedPath(new RectangleF(p, p, side, side), s * 0.035f);
            g.FillPath(cut, path);

            return bmp;
        }

        private static Bitmap Blank(int size) => new Bitmap(Math.Max(1, size), Math.Max(1, size));

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
                pts[i] = new PointF(
                    cx + rad * (float)Math.Cos(angle),
                    cy + rad * (float)Math.Sin(angle));
            }
            return pts;
        }

        private static void DrawSpark(Graphics g, Brush brush, float cx, float cy, float r)
        {
            g.FillPolygon(brush, new[]
            {
                new PointF(cx, cy - r),
                new PointF(cx + r * 0.28f, cy - r * 0.28f),
                new PointF(cx + r, cy),
                new PointF(cx + r * 0.28f, cy + r * 0.28f),
                new PointF(cx, cy + r),
                new PointF(cx - r * 0.28f, cy + r * 0.28f),
                new PointF(cx - r, cy),
                new PointF(cx - r * 0.28f, cy - r * 0.28f),
            });
        }

        private static Color InvertedFor(Color c) => NordColors.WindowBackground;

        private static void DrawChevron(Graphics g, Pen pen, int size, bool up, float centerY)
        {
            float s = size;
            float left = s * 0.28f;
            float right = s * 0.72f;
            float mid = s * 0.50f;
            float offset = s * 0.12f;
            float y = s * centerY;

            if (up)
            {
                g.DrawLines(pen, new[]
                {
                    new PointF(left, y + offset),
                    new PointF(mid, y - offset),
                    new PointF(right, y + offset),
                });
            }
            else
            {
                g.DrawLines(pen, new[]
                {
                    new PointF(left, y - offset),
                    new PointF(mid, y + offset),
                    new PointF(right, y - offset),
                });
            }
        }

        private static void DrawDocument(Graphics g, Pen pen, RectangleF rect, float radius)
        {
            using var path = GfxHelpers.RoundedPath(rect, radius);
            g.DrawPath(pen, path);
        }

        private static void DrawQuote(Graphics g, Pen pen, float x, float y, float size)
        {
            g.DrawArc(pen, x, y, size, size, 0, 360);
            g.DrawLine(pen, x + size * 0.50f, y + size, x + size * 0.24f, y + size * 1.55f);
        }
    }

    // Shared GDI+ geometry helpers.
    internal static class GfxHelpers
    {
        public static GraphicsPath RoundedPath(RectangleF r, float radius)
        {
            float maxRadius = Math.Min(r.Width, r.Height) / 2f;
            radius = Math.Max(0, Math.Min(radius, maxRadius));

            var p = new GraphicsPath();
            if (radius <= 0)
            {
                p.AddRectangle(r);
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
