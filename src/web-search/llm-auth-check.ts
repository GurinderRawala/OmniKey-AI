import type { Logger } from 'winston';
import { aiClient, AIMessage } from '../ai-client';
import { getDefaultModel } from '../ai-client';

const SYSTEM_PROMPT =
  'You are an expert at detecting whether a web page is showing the real requested content. ' +
  'Given a URL and the visible text content of a web page, answer "yes" if EITHER: ' +
  '(1) The URL looks like a public resource that does not require authentication — such as documentation sites, ' +
  'public wikis, news articles, open-source repos, package registries, developer references, or any URL whose ' +
  'hostname/path strongly suggests publicly accessible content (e.g. docs.*, developer.*, wikipedia.org, github.com public repos, ' +
  'stackoverflow.com, npmjs.com, medium.com, reddit.com, youtube.com, etc.). ' +
  '(2) The page is showing the actual content that an authenticated user would see at that URL. ' +
  'Answer "no" if the page is: a login/sign-in page, an access denied or unauthorized page, a redirect away from the requested URL, ' +
  'a generic 404/not-found or error page that could be an auth redirect in disguise (e.g. shows a not-found message but ' +
  'the URL was a valid authenticated route), or any page that does not correspond to the requested resource. ' +
  'When in doubt about whether a URL is public, lean towards "yes". Reply with only one word: "yes" or "no".';

const PUBLIC_URL_PATTERNS = [
  /^https?:\/\/(www\.)?github\.com\/(?!.*\/settings|.*\/account)/,
  /^https?:\/\/(www\.)?stackoverflow\.com/,
  /^https?:\/\/(www\.)?wikipedia\.org/,
  /^https?:\/\/docs\./,
  /^https?:\/\/developer\./,
  /^https?:\/\/(www\.)?npmjs\.com/,
  /^https?:\/\/(www\.)?pypi\.org/,
  /^https?:\/\/(www\.)?medium\.com/,
  /^https?:\/\/(www\.)?reddit\.com/,
  /^https?:\/\/(www\.)?youtube\.com/,
  /^https?:\/\/(www\.)?news\.ycombinator\.com/,
  // Package registries & language docs
  /^https?:\/\/(www\.)?crates\.io/,
  /^https?:\/\/(www\.)?rubygems\.org/,
  /^https?:\/\/(www\.)?packagist\.org/,
  /^https?:\/\/(www\.)?pkg\.go\.dev/,
  /^https?:\/\/(www\.)?hex\.pm/,
  /^https?:\/\/(www\.)?nuget\.org/,
  /^https?:\/\/(www\.)?maven\.apache\.org/,
  /^https?:\/\/central\.sonatype\.com/,
  // Official language & runtime docs
  /^https?:\/\/(www\.)?python\.org/,
  /^https?:\/\/(www\.)?rust-lang\.org/,
  /^https?:\/\/(www\.)?golang\.org/,
  /^https?:\/\/(www\.)?go\.dev/,
  /^https?:\/\/(www\.)?ruby-lang\.org/,
  /^https?:\/\/(www\.)?php\.net/,
  /^https?:\/\/(www\.)?kotlinlang\.org/,
  /^https?:\/\/(www\.)?swift\.org/,
  /^https?:\/\/learn\.microsoft\.com/,
  /^https?:\/\/msdn\.microsoft\.com/,
  /^https?:\/\/devblogs\.microsoft\.com/,
  /^https?:\/\/(www\.)?w3\.org/,
  /^https?:\/\/(www\.)?w3schools\.com/,
  /^https?:\/\/(www\.)?mdn\./,
  /^https?:\/\/developer\.mozilla\.org/,
  // Source code & open-source platforms
  /^https?:\/\/(www\.)?gitlab\.com\/(?!.*\/-\/settings)/,
  /^https?:\/\/(www\.)?bitbucket\.org\/(?!.*\/admin)/,
  /^https?:\/\/(www\.)?sourceforge\.net/,
  /^https?:\/\/(www\.)?codepen\.io/,
  /^https?:\/\/(www\.)?jsfiddle\.net/,
  /^https?:\/\/(www\.)?codesandbox\.io/,
  // Q&A, forums & community sites
  /^https?:\/\/(www\.)?stackexchange\.com/,
  /^https?:\/\/(www\.)?superuser\.com/,
  /^https?:\/\/(www\.)?serverfault\.com/,
  /^https?:\/\/(www\.)?askubuntu\.com/,
  /^https?:\/\/(www\.)?quora\.com/,
  /^https?:\/\/(www\.)?dev\.to/,
  /^https?:\/\/(www\.)?hashnode\.com/,
  /^https?:\/\/(www\.)?lobste\.rs/,
  // News & tech media
  /^https?:\/\/(www\.)?techcrunch\.com/,
  /^https?:\/\/(www\.)?theverge\.com/,
  /^https?:\/\/(www\.)?wired\.com/,
  /^https?:\/\/(www\.)?arstechnica\.com/,
  /^https?:\/\/(www\.)?thenextweb\.com/,
  /^https?:\/\/(www\.)?infoq\.com/,
  /^https?:\/\/(www\.)?smashingmagazine\.com/,
  /^https?:\/\/(www\.)?css-tricks\.com/,
  // Reference & encyclopedias
  /^https?:\/\/[a-z-]+\.wikipedia\.org/,
  /^https?:\/\/(www\.)?wikidata\.org/,
  /^https?:\/\/(www\.)?wikimedia\.org/,
  /^https?:\/\/(www\.)?archive\.org/,
  // Cloud provider public docs
  /^https?:\/\/cloud\.google\.com\/(?!.*\/console)/,
  /^https?:\/\/aws\.amazon\.com\/(?!(.*\/console|.*\/signin))/,
  /^https?:\/\/(www\.)?azure\.microsoft\.com/,
  /^https?:\/\/registry\./,
];

const AUTH_PATH_PATTERN =
  /[/?#](login|log-in|signin|sign-in|signup|sign-up|register|auth|authenticate|oauth|sso|saml|forgot-password|reset-password|verify|two-factor|2fa|mfa)([/?#]|$)/i;

function isPublicUrl(url: string): boolean {
  if (AUTH_PATH_PATTERN.test(url)) return false;
  return PUBLIC_URL_PATTERNS.some((pattern) => pattern.test(url));
}

export async function isPageAuthenticated(
  content: string,
  url: string,
  log: Logger,
  finalUrl?: string,
): Promise<boolean> {
  if (finalUrl) {
    const normalize = (u: string) => u.replace(/#.*$/, '').replace(/\/$/, '');
    if (normalize(finalUrl) !== normalize(url)) {
      log.info('llm-auth-check: redirect detected, treating as not authenticated', {
        requestUrl: url,
        finalUrl,
      });
      return false;
    }
  }

  if (isPublicUrl(url)) {
    log.info('llm-auth-check: public URL, skipping auth check', { url });
    return true;
  }

  const model = getDefaultModel(aiClient.getProvider(), 'fast');
  const messages: AIMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `URL: ${url}\n\nPage content:\n${content}` },
  ];
  try {
    const result = await aiClient.complete(model, messages, { temperature: 0, maxTokens: 1 });
    const answer = result.content.trim().toLowerCase();
    log.info('llm-auth-check: LLM response', { url, answer });
    return answer === 'yes';
  } catch (err) {
    log.error('llm-auth-check: LLM call failed', { url, error: String(err) });
    // If LLM call fails, default to not authorized
    return false;
  }
}
