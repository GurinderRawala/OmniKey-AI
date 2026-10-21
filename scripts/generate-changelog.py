#!/usr/bin/env python3
"""Generate api/public/changelog.html and changelog.xml from git tags.

Usage:  python3 scripts/generate-changelog.py
Re-run after every release; the output is committed with the site.
"""
import html, re, subprocess, datetime, pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
PUB = ROOT / "api" / "public"
SITE = "https://omnikeyai.ca"
REPO = "https://github.com/GurinderRawala/OmniKey-AI"
MAX_RELEASES = 25

NOISE = re.compile(r"skip ci|update Homebrew formula|^release\.md$|^website updates$|^macos build$", re.I)
TYPES = {
    "feat": ("Added", "chg-add"),
    "fix": ("Fixed", "chg-fix"),
    "perf": ("Improved", "chg-imp"),
    "refactor": ("Improved", "chg-imp"),
    "docs": ("Docs", "chg-doc"),
    "chore": ("Maintenance", "chg-doc"),
}


def sh(*args):
    return subprocess.run(args, cwd=ROOT, capture_output=True, text=True).stdout.strip()


def tags():
    out = sh("git", "tag", "--sort=-creatordate")
    return [t for t in out.splitlines() if t.startswith("v")]


def commits(prev, tag):
    rng = f"{prev}..{tag}" if prev else tag
    raw = sh("git", "log", "--no-merges", "--pretty=%s", rng)
    items = []
    for line in raw.splitlines():
        line = line.strip()
        if not line or NOISE.search(line):
            continue
        m = re.match(r"^(\w+)(?:\(([^)]+)\))?!?:\s*(.+)$", line)
        if m:
            kind, scope, text = m.group(1).lower(), m.group(2), m.group(3)
            label, cls = TYPES.get(kind, ("Changed", "chg-imp"))
        else:
            scope, text, label, cls = None, line, "Changed", "chg-imp"
        items.append((label, cls, scope, text[0].upper() + text[1:]))
    seen, out = set(), []
    for it in items:
        if it[3] not in seen:
            seen.add(it[3])
            out.append(it)
    return out


def build():
    all_tags = tags()
    entries = []
    for i, tag in enumerate(all_tags[:MAX_RELEASES]):
        prev = all_tags[i + 1] if i + 1 < len(all_tags) else None
        date = sh("git", "log", "-1", "--format=%cs", tag)
        entries.append({"tag": tag, "date": date, "items": commits(prev, tag), "prev": prev})

    # Reuse the live nav + footer from docs.html so the changelog never drifts.
    docs = (PUB / "docs.html").read_text()
    # NB: slice to the OUTER </nav> (4-space indent); the inner mobile <nav> closes first.
    nav = docs[docs.index('    <a class="skip-link"') : docs.index("\n    </nav>") + len("\n    </nav>")]
    nav = nav.replace(' class="nav-link-active"', "").replace(
        "mobile-menu-link mobile-menu-link-active", "mobile-menu-link"
    )
    # Mark the existing Changelog links active on this page.
    nav = nav.replace(
        '<a href="/changelog">Changelog</a>',
        '<a href="/changelog" class="nav-link-active">Changelog</a>',
        1,
    )
    nav = nav.replace(
        '<a href="/changelog" class="mobile-menu-link">Changelog</a>',
        '<a href="/changelog" class="mobile-menu-link mobile-menu-link-active">Changelog</a>',
        1,
    )
    footer = docs[docs.index("    <footer>") : docs.index("</footer>") + len("</footer>")]

    rows = []
    for e in entries:
        if e["items"]:
            lis = "\n".join(
                '            <li><span class="chg-tag {cls}">{label}</span>'
                '<span class="chg-text">{scope}{text}</span></li>'.format(
                    cls=c,
                    label=html.escape(l),
                    scope=f'<strong>{html.escape(s)}</strong> ' if s else "",
                    text=html.escape(t),
                )
                for l, c, s, t in e["items"]
            )
            body = f'          <ul class="chg-list">\n{lis}\n          </ul>'
        else:
            body = ('          <p class="chg-empty">Packaging and release-pipeline updates. '
                    'No user-facing changes.</p>')
        compare = (f'<a class="chg-compare" href="{REPO}/compare/{e["prev"]}...{e["tag"]}" '
                   f'target="_blank" rel="noopener noreferrer">Compare on GitHub</a>'
                   if e["prev"] else "")
        pretty = datetime.date.fromisoformat(e["date"]).strftime("%B %-d, %Y")
        rows.append(f"""        <article class="chg-release" id="{e['tag']}">
          <div class="chg-meta">
            <a class="chg-version" href="#{e['tag']}">{e['tag']}</a>
            <time datetime="{e['date']}">{pretty}</time>
            {compare}
          </div>
          <div class="chg-body">
{body}
          </div>
        </article>""")

    latest = entries[0]
    page = f"""<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>OmniKey AI Changelog - Releases, Fixes &amp; New Features</title>
    <meta
      name="description"
      content="Every OmniKey AI release: new features, fixes, provider support, MCP improvements, and desktop app updates for macOS and Windows."
    />
    <link rel="canonical" href="{SITE}/changelog" />
    <meta property="og:type" content="website" />
    <meta property="og:url" content="{SITE}/changelog" />
    <meta property="og:title" content="OmniKey AI Changelog" />
    <meta property="og:description" content="Every OmniKey AI release: new features, fixes, and desktop app updates." />
    <meta property="og:site_name" content="OmniKey AI" />
    <meta name="twitter:card" content="summary" />
    <meta name="twitter:title" content="OmniKey AI Changelog" />
    <meta name="twitter:description" content="Every OmniKey AI release: new features, fixes, and desktop app updates." />
    <meta name="robots" content="index, follow" />
    <link rel="alternate" type="application/rss+xml" title="OmniKey AI releases" href="{SITE}/changelog.xml" />
    <link rel="icon" href="/favicon.ico" sizes="any" />
    <link rel="icon" href="/icon-192.png" type="image/png" sizes="192x192" />
    <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
    <link rel="manifest" href="/site.webmanifest" />
    <meta name="theme-color" content="#111318" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link
      href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:wght@500;600;700;800&amp;family=Manrope:wght@400;500;600;700;800&amp;display=swap"
      rel="stylesheet"
    />
    <link rel="stylesheet" href="/style.css" />
    <script src="https://unpkg.com/lucide@0.468.0/dist/umd/lucide.min.js" defer></script>
  </head>
  <body>
{nav}

    <main class="docs-main" id="main-content">
      <section class="docs-hero">
        <span class="docs-kicker">Changelog</span>
        <h1>Every OmniKey release, in one place.</h1>
        <p>
          OmniKey ships continuously. Below is the full history of the CLI, daemon, macOS menu bar
          app, and Windows tray app &mdash; generated straight from the Git history.
          <a href="/changelog.xml">Subscribe via RSS</a> or
          <a href="{REPO}/releases" target="_blank" rel="noopener noreferrer">watch releases on GitHub</a>.
        </p>
        <p class="chg-latest">Latest release <strong>{latest['tag']}</strong> &nbsp;&middot;&nbsp; {datetime.date.fromisoformat(latest['date']).strftime('%B %-d, %Y')}</p>
      </section>

      <section class="docs-section" id="releases">
{chr(10).join(rows)}
      </section>
    </main>

{footer}

    <script src="/app.js" defer></script>
  </body>
</html>
"""
    (PUB / "changelog.html").write_text(page)

    # RSS
    items = []
    for e in entries[:20]:
        desc = "<ul>" + "".join(f"<li>{html.escape(t)}</li>" for _, _, _, t in e["items"]) + "</ul>" if e["items"] else "<p>Release and packaging updates.</p>"
        pub = datetime.datetime.fromisoformat(e["date"]).strftime("%a, %d %b %Y 00:00:00 +0000")
        items.append(f"""    <item>
      <title>OmniKey {e['tag']}</title>
      <link>{SITE}/changelog#{e['tag']}</link>
      <guid isPermaLink="false">omnikey-{e['tag']}</guid>
      <pubDate>{pub}</pubDate>
      <description><![CDATA[{desc}]]></description>
    </item>""")
    rss = f"""<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>OmniKey AI releases</title>
    <link>{SITE}/changelog</link>
    <description>New features, fixes, and improvements in OmniKey AI.</description>
    <language>en</language>
{chr(10).join(items)}
  </channel>
</rss>
"""
    (PUB / "changelog.xml").write_text(rss)
    print(f"changelog.html: {len(entries)} releases")
    print(f"changelog.xml : {len(items)} items")


if __name__ == "__main__":
    build()
