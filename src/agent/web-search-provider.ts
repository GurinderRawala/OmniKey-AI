import axios from 'axios';
import { config } from '../config';
import { logger } from '../logger';
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
