import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const publicDir = path.join(__dirname, '..', '..', 'public');
const blogIndex = fs.readFileSync(path.join(publicDir, 'blog.html'), 'utf8');
const article = fs.readFileSync(
  path.join(publicDir, 'blog', 'your-ai-assistant-lives-in-the-wrong-place.html'),
  'utf8',
);

describe('static blog pages', () => {
  it('links the first article from the blog index', () => {
    expect(blogIndex).toContain('href="/blog/your-ai-assistant-lives-in-the-wrong-place"');
    expect(blogIndex).toContain('Your AI Assistant Lives in the Wrong Place');
  });

  it('has canonical and social metadata on the article', () => {
    const canonical = 'https://omnikeyai.ca/blog/your-ai-assistant-lives-in-the-wrong-place';
    expect(article).toContain(`<link rel="canonical" href="${canonical}"`);
    expect(article).toContain(`<meta property="og:url" content="${canonical}"`);
    expect(article).toContain('"@type":"BlogPosting"');
  });

  it('links Blog from every primary website page', () => {
    for (const file of ['index.html', 'docs.html', 'changelog.html']) {
      expect(fs.readFileSync(path.join(publicDir, file), 'utf8')).toContain('href="/blog"');
    }
  });

  it('includes the blog and article in the sitemap', () => {
    const sitemap = fs.readFileSync(path.join(publicDir, 'sitemap.xml'), 'utf8');
    expect(sitemap).toContain('<loc>https://omnikeyai.ca/blog</loc>');
    expect(sitemap).toContain(
      `<loc>${'https://omnikeyai.ca/blog/your-ai-assistant-lives-in-the-wrong-place'}</loc>`,
    );
  });

  it('publishes the OmniAgent article with canonical metadata and five example workflows', () => {
    const slug = 'i-gave-my-keyboard-shortcut-a-terminal-and-a-browser';
    const page = fs.readFileSync(path.join(publicDir, 'blog', `${slug}.html`), 'utf8');
    expect(blogIndex).toContain(`href="/blog/${slug}"`);
    expect(page).toContain(`<link rel="canonical" href="https://omnikeyai.ca/blog/${slug}"`);
    expect(page).toContain('I Gave My Keyboard Shortcut a Terminal and a Browser');
    for (const heading of [
      'Audit your own codebase',
      'Summarise a pull request',
      'Triage a Slack thread',
      'Ask your database a question',
      'Pull numbers off an internal dashboard',
    ]) {
      expect(page).toContain(heading);
    }
    expect(page).toContain('example prompts, not benchmark results');
    expect(page).not.toContain('Terminal access is off until you enable it');
  });

  it('includes the OmniAgent article in discovery and changelog surfaces', () => {
    const url = '/blog/i-gave-my-keyboard-shortcut-a-terminal-and-a-browser';
    const sitemap = fs.readFileSync(path.join(publicDir, 'sitemap.xml'), 'utf8');
    expect(sitemap).toContain(`<loc>https://omnikeyai.ca${url}</loc>`);
    expect(fs.readFileSync(path.join(publicDir, 'changelog.html'), 'utf8')).toContain(
      `href="${url}"`,
    );
    expect(fs.readFileSync(path.join(publicDir, 'changelog.xml'), 'utf8')).toContain(
      `<link>https://omnikeyai.ca${url}</link>`,
    );
  });
});
