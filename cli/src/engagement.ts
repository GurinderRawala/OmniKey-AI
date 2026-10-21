const REPO_URL = 'https://github.com/GurinderRawala/OmniKey-AI';
const DISCUSSIONS_URL = 'https://github.com/GurinderRawala/OmniKey-AI/discussions';

/**
 * Shown once at the end of onboarding. Purely static text: OmniKey records
 * nothing about how you use it, so there is no usage tracking behind this.
 * Set OMNIKEY_NO_NAG=1 to suppress it.
 */
export function renderWelcomeCta(): string {
  if (process.env.OMNIKEY_NO_NAG === '1' || process.env.OMNIKEY_NO_NAG === 'true') {
    return '';
  }

  return [
    '',
    '  OmniKey is free and MIT licensed.',
    `  ⭐ Star the repo:   ${REPO_URL}`,
    `  💬 Ask / suggest:  ${DISCUSSIONS_URL}`,
    '',
  ].join('\n');
}
