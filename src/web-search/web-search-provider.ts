import axios from 'axios';
import { config } from '../config';
import { logger } from '../logger';
import { fetchWithPlaywright, isBrowserOpenWithUrl } from './browser-playwright';
import { isPageAuthenticated } from './llm-auth-check';
import type { AITool } from '../ai-client';

export const WEB_FETCH_TOOL: AITool = {
  name: 'web_fetch',
  description:
    "Fetch the text content of any publicly accessible URL. Use this to retrieve documentation, error references, API guides, release notes, or any web resource that would help answer the user's question.",
  parameters: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The full URL to fetch (e.g. https://example.com/page)',
      },
    },
    required: ['url'],
  },
};

export const WEB_SEARCH_TOOL: AITool = {
  name: 'web_search',
  description:
    "Search the web for information about a topic. Use this to find documentation, troubleshoot errors, or research topics relevant to the user's question.",
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The search query',
      },
    },
    required: ['query'],
  },
};

export const MAX_WEB_FETCH_BYTES = 500_000;
export const MAX_TOOL_CONTENT_CHARS = 8_000;

type SearchResult = { title: string; url: string; snippet: string };

function formatSearchResults(results: SearchResult[]): string {
  if (!results.length) return 'No search results found';
  return results
    .slice(0, 5)
    .map((r, i) => `${i + 1}. ${r.title}\n   URL: ${r.url}\n   ${r.snippet}`)
    .join('\n\n');
}

async function searchWithSerper(query: string): Promise<SearchResult[]> {
  const response = await axios.post<{
    organic?: { title?: string; link?: string; snippet?: string }[];
  }>(
    'https://google.serper.dev/search',
    { q: query, num: 5 },
    {
      headers: { 'X-API-KEY': config.serperApiKey!, 'Content-Type': 'application/json' },
      timeout: 15_000,
    },
  );
  return (response.data?.organic ?? []).map((r) => ({
    title: r.title ?? '(no title)',
    url: r.link ?? '',
    snippet: r.snippet ?? '',
  }));
}

async function searchWithBrave(query: string): Promise<SearchResult[]> {
  const response = await axios.get<{
    web?: { results?: { title?: string; url?: string; description?: string }[] };
  }>('https://api.search.brave.com/res/v1/web/search', {
    params: { q: query, count: 5 },
    headers: { Accept: 'application/json', 'X-Subscription-Token': config.braveSearchApiKey! },
    timeout: 15_000,
  });
  return (response.data?.web?.results ?? []).map((r) => ({
    title: r.title ?? '(no title)',
    url: r.url ?? '',
    snippet: r.description ?? '',
  }));
}

async function searchWithTavily(query: string): Promise<SearchResult[]> {
  const response = await axios.post<{
    results?: { title?: string; url?: string; content?: string }[];
  }>(
    'https://api.tavily.com/search',
    { query, max_results: 5, api_key: config.tavilyApiKey },
    { headers: { 'Content-Type': 'application/json' }, timeout: 15_000 },
  );
  return (response.data?.results ?? []).map((r) => ({
    title: r.title ?? '(no title)',
    url: r.url ?? '',
    snippet: r.content ?? '',
  }));
}

async function searchWithSearxng(query: string): Promise<SearchResult[]> {
  const response = await axios.get<{
    results?: { title?: string; url?: string; content?: string }[];
  }>(`${config.searxngUrl}/search`, {
    params: { q: query, format: 'json', num_results: 5 },
    timeout: 15_000,
  });
  return (response.data?.results ?? []).map((r) => ({
    title: r.title ?? '(no title)',
    url: r.url ?? '',
    snippet: r.content ?? '',
  }));
}

async function searchWithDuckDuckGo(query: string): Promise<SearchResult[]> {
  const response = await axios.get<{
    AbstractText?: string;
    AbstractURL?: string;
    AbstractSource?: string;
    RelatedTopics?: { Text?: string; FirstURL?: string; Name?: string }[];
  }>('https://api.duckduckgo.com/', {
    params: { q: query, format: 'json', no_html: '1', skip_disambig: '1' },
    timeout: 15_000,
  });

  const results: SearchResult[] = [];

  if (response.data?.AbstractText) {
    results.push({
      title: response.data.AbstractSource ?? 'Summary',
      url: response.data.AbstractURL ?? '',
      snippet: response.data.AbstractText,
    });
  }

  for (const topic of response.data?.RelatedTopics ?? []) {
    if (topic.Text && topic.FirstURL) {
      results.push({
        title: topic.Text.split(' - ')[0] ?? topic.Text,
        url: topic.FirstURL,
        snippet: topic.Text,
      });
    }
    if (results.length >= 5) break;
  }

  return results;
}

export async function executeWebSearch(query: string, log: typeof logger): Promise<string> {
  if (config.serperApiKey) {
    log.info('web_search: using Serper', { query });
    return formatSearchResults(await searchWithSerper(query));
  }
  if (config.braveSearchApiKey) {
    log.info('web_search: using Brave Search', { query });
    return formatSearchResults(await searchWithBrave(query));
  }
  if (config.tavilyApiKey) {
    log.info('web_search: using Tavily', { query });
    return formatSearchResults(await searchWithTavily(query));
  }
  if (config.searxngUrl) {
    log.info('web_search: using SearXNG', { query });
    return formatSearchResults(await searchWithSearxng(query));
  }
  log.info('web_search: using DuckDuckGo (free fallback)', { query });
  return formatSearchResults(await searchWithDuckDuckGo(query));
}

function stripHtml(raw: string): string {
  return raw
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const BASE_FETCH_HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (compatible; OmniKeyAgent/1.0)',
};

// ── Step 1: plain HTTP fetch ──────────────────────────────────────────────────
async function fetchPlainHttp(
  url: string,
  log: typeof logger,
): Promise<{ html: string | null; authBlocked: boolean; finalUrl: string }> {
  try {
    const response = await axios.get<string>(url, {
      timeout: 15_000,
      responseType: 'text',
      maxContentLength: MAX_WEB_FETCH_BYTES,
      headers: BASE_FETCH_HEADERS,
    });
    const finalUrl: string = (response.request as any)?.res?.responseUrl ?? url;
    return { html: String(response.data), authBlocked: false, finalUrl };
  } catch (err) {
    const status = axios.isAxiosError(err) ? err.response?.status : undefined;
    log.warn('Initial fetch failed', {
      url,
      error: err instanceof Error ? err.message : String(err),
      status,
    });

    // If a browser is running, any failure could be auth-related —
    // sites use redirects, 302s, custom error pages, or soft-blocks
    // rather than a clean 401/403, so checking status codes alone is
    // unreliable. Fall through to the browser-session path instead.
    if (isSelfHostedWithBrowserSession && await isBrowserOpenWithUrl(url, log)) {
      return { html: null, authBlocked: true, finalUrl: url };
    }
    if (status === 401 || status === 403) {
      return { html: null, authBlocked: true, finalUrl: url };
    }
    throw err;
  }
}

// ── Step 2: LLM auth check on plain response ──────────────────────────────────
async function checkPlainResponseAuth(
  plainText: string,
  url: string,
  log: typeof logger,
  finalUrl?: string,
): Promise<boolean> {
  const authenticated = await isPageAuthenticated(plainText.slice(0, 5_000), url, log, finalUrl);
  if (!authenticated) {
    log.info('web_fetch: plain response failed auth check — trying active-tab strategy', { url });
  }
  return authenticated;
}

// ── Step 3: active-tab extraction (self-hosted macOS only) ───────────────────
async function fetchFromActiveTab(url: string, log: typeof logger): Promise<string | null> {
  log.info('web_fetch: falling back to active-tab extraction', { url });
  return fetchWithPlaywright(url, log);
}

const isSelfHostedWithBrowserSession = config.isSelfHosted;
async function executeWebFetch(url: string, log: typeof logger): Promise<string> {
  log.info('Executing web_fetch tool', { url });

  // ── Step 1: plain HTTP request ────────────────────────────────────────────
  const { html, authBlocked, finalUrl } = await fetchPlainHttp(url, log);

  const plainText = html ? stripHtml(html) : '';

  if (!isSelfHostedWithBrowserSession) {
    if (authBlocked) {
      log.warn(
        'Error: page requires authentication. Run OmniKey in self-hosted mode on macOS or Windows to enable browser-session access.',
      );
    }
    return plainText.slice(0, MAX_TOOL_CONTENT_CHARS) || 'No content retrieved';
  }

  // ── Step 2 (self-hosted desktop): LLM auth check on plain response ────────
  let looksUnauthenticated = false;
  if (!authBlocked && plainText) {
    log.info('web_fetch: performing LLM auth check on plain HTTP response', { url });
    const authenticated = await checkPlainResponseAuth(plainText, url, log, finalUrl);
    if (authenticated) {
      return plainText.slice(0, MAX_TOOL_CONTENT_CHARS) || 'No content retrieved';
    }
    looksUnauthenticated = true;
  }

  // ── Step 3 (self-hosted desktop): active-tab extraction ──────────────────
  // Only attempted when there is evidence authentication is required.
  const needsAuth = authBlocked || looksUnauthenticated;
  if (needsAuth) {
    log.info(
      'web_fetch: evidence of authentication requirement, attempting active-tab extraction',
      { url },
    );
    const activeTabText = await fetchFromActiveTab(url, log);
    if (activeTabText) {
      return activeTabText.slice(0, MAX_TOOL_CONTENT_CHARS);
    }
  }

  // All strategies exhausted.
  if (authBlocked) {
    if (config.terminalPlatform === 'macos') {
      log.warn(
        'Error: page requires authentication. Open the page in Chrome and ensure "Allow JavaScript from Apple Events" is enabled (View → Developer → Allow JavaScript from Apple Events).',
      );
    } else if (config.terminalPlatform === 'windows') {
      log.warn(
        'Error: page requires authentication. To enable live browser-session access on Windows, ' +
          'launch Chrome with --remote-debugging-port=9222: right-click your Chrome shortcut → Properties, ' +
          'and append "--remote-debugging-port=9222" to the Target field, then restart Chrome. ' +
          'OmniKey will then read the authenticated tab directly.',
      );
    }
  }
  return plainText.slice(0, MAX_TOOL_CONTENT_CHARS) || 'No content retrieved';
}

export async function executeTool(
  name: string,
  args: Record<string, string>,
  log: typeof logger,
): Promise<string> {
  if (name === 'web_fetch') {
    const url = args.url;
    if (!url) return 'Error: url parameter is required';
    try {
      return await executeWebFetch(url, log);
    } catch (err) {
      log.warn('web_fetch tool failed', {
        url,
        error: err instanceof Error ? err.message : String(err),
      });
      return `Error fetching URL: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  if (name === 'web_search') {
    const query = args.query;
    if (!query) return 'Error: query parameter is required';
    try {
      log.info('Executing web_search tool', { query });
      return await executeWebSearch(query, log);
    } catch (err) {
      log.warn('web_search tool failed', {
        query,
        error: err instanceof Error ? err.message : String(err),
      });
      return `Error searching: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  return `Unknown tool: ${name}`;
}
