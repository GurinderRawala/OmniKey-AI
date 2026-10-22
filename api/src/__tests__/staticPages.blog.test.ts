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
});
