#!/usr/bin/env python3
"""Generate the static blog index and article pages from plain-text sources.

Usage: python3 scripts/generate-blog.py
"""
import datetime
import html
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parent.parent
PUB = ROOT / 'api' / 'public'
BLOG = ROOT / 'content' / 'blog'
SITE = 'https://omnikeyai.ca'


def read_chrome():
    docs = (PUB / 'docs.html').read_text()
    nav = docs[docs.index('    <a class="skip-link"') : docs.index('\n    </nav>') + len('\n    </nav>')]
    nav = nav.replace(' class="nav-link-active"', '').replace(
        'mobile-menu-link mobile-menu-link-active', 'mobile-menu-link'
    )
    # docs.html already contains Blog in desktop/mobile navigation. Mark those
    # links active without inserting a duplicate.
    nav = nav.replace(
        '<a href="/blog">Blog</a>',
        '<a href="/blog" class="nav-link-active">Blog</a>',
        1,
    )
    nav = nav.replace(
        '<a href="/blog" class="mobile-menu-link">Blog</a>',
        '<a href="/blog" class="mobile-menu-link mobile-menu-link-active">Blog</a>',
        1,
    )
    footer = docs[docs.index('    <footer>') : docs.index('</footer>') + len('</footer>')]
    return nav, footer


def meta(path):
    text = path.read_text()
    header, body = text.split('\n---\n', 1)
    values = {}
    for line in header.splitlines():
        k, v = line.split(':', 1)
        values[k.strip()] = v.strip()
    values['body'] = body.strip()
    values['slug'] = path.stem
    return values


def paragraph_html(body):
    blocks = re.split(r'\n\s*\n', body.strip())
    out = []
    for block in blocks:
        lines = block.splitlines()
        if len(lines) == 1 and lines[0].upper() == lines[0] and any(c.isalpha() for c in lines[0]):
            out.append(f'<h2>{html.escape(lines[0].title())}</h2>')
        elif all(line.startswith('  ') for line in lines):
            out.append('<pre><code>' + html.escape('\n'.join(line[2:] for line in lines)) + '</code></pre>')
        else:
            escaped = '<br />\n'.join(html.escape(x) for x in lines)
            escaped = re.sub(r'`([^`]+)`', r'<code>\1</code>', escaped)
            escaped = re.sub(r'(https://omnikeyai\.ca)', r'<a href="\1">\1</a>', escaped)
            out.append(f'<p>{escaped}</p>')
    return '\n'.join(out)


def page_head(title, description, canonical, page_type='article', published=None):
    date_meta = f'\n    <meta property="article:published_time" content="{published}" />' if published else ''
    schema_type = 'BlogPosting' if page_type == 'article' else 'CollectionPage'
    return f'''  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>{html.escape(title)}</title>
    <meta name="description" content="{html.escape(description, quote=True)}" />
    <link rel="canonical" href="{canonical}" />
    <meta name="robots" content="index, follow" />
    <meta property="og:type" content="{page_type}" />
    <meta property="og:url" content="{canonical}" />
    <meta property="og:title" content="{html.escape(title, quote=True)}" />
    <meta property="og:description" content="{html.escape(description, quote=True)}" />
    <meta property="og:site_name" content="OmniKey AI" />{date_meta}
    <meta name="twitter:card" content="summary" />
    <meta name="twitter:title" content="{html.escape(title, quote=True)}" />
    <meta name="twitter:description" content="{html.escape(description, quote=True)}" />
    <script type="application/ld+json">
      {{"@context":"https://schema.org","@type":"{schema_type}","headline":"{html.escape(title, quote=True)}","description":"{html.escape(description, quote=True)}","url":"{canonical}","publisher":{{"@type":"Organization","name":"OmniKey AI","url":"{SITE}"}}}}
    </script>
    <link rel="icon" href="/favicon.ico" sizes="any" />
    <link rel="icon" href="/icon-192.png" type="image/png" sizes="192x192" />
    <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
    <link rel="manifest" href="/site.webmanifest" />
    <meta name="theme-color" content="#111318" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:wght@500;600;700;800&amp;family=Manrope:wght@400;500;600;700;800&amp;display=swap" rel="stylesheet" />
    <link rel="stylesheet" href="/style.css" />
    <script src="https://unpkg.com/lucide@0.468.0/dist/umd/lucide.min.js" defer></script>
  </head>'''


def render():
    nav, footer = read_chrome()
    posts = sorted((meta(p) for p in BLOG.glob('*.txt')), key=lambda x: x['date'], reverse=True)
    out_dir = PUB / 'blog'
    out_dir.mkdir(exist_ok=True)

    cards = []
    for post in posts:
        canonical = f"{SITE}/blog/{post['slug']}"
        article = f'''<!doctype html>
<html lang="en">
{page_head(post['title'] + ' | OmniKey AI', post['description'], canonical, published=post['date'])}
  <body>
{nav}
    <main class="blog-main" id="main-content">
      <article class="blog-article">
        <header class="blog-article-header">
          <a href="/blog" class="blog-back">&larr; All posts</a>
          <p class="section-label">OmniKey Blog</p>
          <h1>{html.escape(post['title'])}</h1>
          <p class="blog-dek">{html.escape(post['description'])}</p>
          <div class="blog-byline"><time datetime="{post['date']}">{datetime.date.fromisoformat(post['date']).strftime('%B %-d, %Y')}</time><span>&middot;</span><span>{post['read_time']}</span></div>
        </header>
        <div class="blog-prose">
{paragraph_html(post['body'])}
        </div>
        <aside class="blog-cta">
          <p class="section-label">Try it where you type</p>
          <h2>One shortcut. Any app.</h2>
          <p>Free, open source, and built for macOS and Windows. Bring your own model.</p>
          <div><a href="/#download" class="btn btn-primary">Download OmniKey</a> <a href="https://github.com/GurinderRawala/OmniKey-AI" class="btn btn-secondary">View source</a></div>
        </aside>
      </article>
    </main>
{footer}
    <script src="/app.js" defer></script>
  </body>
</html>
'''
        (out_dir / f"{post['slug']}.html").write_text(article)
        cards.append(f'''        <article class="blog-card">
          <p class="section-label">Workflow</p>
          <h2><a href="/blog/{post['slug']}">{html.escape(post['title'])}</a></h2>
          <p>{html.escape(post['description'])}</p>
          <div class="blog-card-meta"><time datetime="{post['date']}">{datetime.date.fromisoformat(post['date']).strftime('%B %-d, %Y')}</time><span>&middot;</span><span>{post['read_time']}</span></div>
          <a href="/blog/{post['slug']}" class="blog-read">Read the post <span aria-hidden="true">&rarr;</span></a>
        </article>''')

    index = f'''<!doctype html>
<html lang="en">
{page_head('OmniKey AI Blog - Local AI, Desktop Workflows & Agents', 'Practical notes on local AI, keyboard-first workflows, agents, MCP, and getting useful work done without another chat tab.', f'{SITE}/blog', page_type='website')}
  <body>
{nav}
    <main class="blog-main" id="main-content">
      <section class="blog-hero">
        <p class="section-label">OmniKey Blog</p>
        <h1>AI should work where you do.</h1>
        <p>Practical notes on local models, keyboard-first workflows, MCP, and agents that can use real context.</p>
      </section>
      <section class="blog-grid" aria-label="Blog posts">
{chr(10).join(cards)}
      </section>
    </main>
{footer}
    <script src="/app.js" defer></script>
  </body>
</html>
'''
    (PUB / 'blog.html').write_text(index)
    print(f"blog.html: {len(posts)} post(s)")
    for post in posts: print(f"blog/{post['slug']}.html")


if __name__ == '__main__':
    render()
