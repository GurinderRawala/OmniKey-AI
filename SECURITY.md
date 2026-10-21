# Security Policy

## Reporting a vulnerability

**Do not open a public issue.** Use GitHub's private reporting:
[Report a vulnerability](https://github.com/GurinderRawala/OmniKey-AI/security/advisories/new).

Please include the OmniKey version, your OS, the configured provider, and the steps to
reproduce. You will get an acknowledgement within 72 hours and an assessment within 7 days.
Fixes ship in a patch release; you will be credited in the release notes unless you prefer
otherwise.

## Supported versions

Only the latest released version is supported. OmniKey ships frequently — please reproduce
against the current release before reporting.

## What OmniKey can reach on your machine

OmniKey is a local-first tool with deliberately broad capabilities. Understanding the real
attack surface matters more here than in a typical desktop app.

| Capability                      | Scope                                                              | How it is gated                             |
| ------------------------------- | ------------------------------------------------------------------ | ------------------------------------------- |
| **Selected text**               | Whatever you highlight when you press a shortcut                   | Only read on an explicit keypress           |
| **Clipboard**                   | Read and write, to paste the result back in place                  | Only during a triggered action              |
| **Terminal access** (OmniAgent) | Runs shell commands as your user                                   | Off unless enabled; `@omniAgent` tasks only |
| **Browser access** (OmniAgent)  | Reads pages in a dedicated debug profile, including logged-in ones | Opt-in via `omnikey grant-browser-access`   |
| **MCP servers**                 | Whatever each configured server exposes                            | You register each server yourself           |
| **Local config**                | `~/.omnikey/config.json`, written `0600`                           | Contains your provider API keys             |

**The agent runs with your full user privileges.** If you enable terminal access, treat an
`@omniAgent` task the way you would treat pasting a script from the internet into your
shell. Review what you are asking it to do.

## What leaves your machine

- **Your prompt and selected text** go to the LLM provider you configured — OpenAI,
  Anthropic, Google Gemini, or your own OpenAI-compatible endpoint. Their terms and
  retention policies apply, not ours.
- **Search queries** go to the web-search provider you configured, if any.
- **MCP traffic** goes wherever you pointed those servers.

**Nothing is sent to OmniKey or its maintainers.** There is no telemetry, no analytics, no
usage counter, and no crash reporting. There is no OmniKey-operated server in the path of a
self-hosted install.

## Handling your API keys

Keys live in `~/.omnikey/config.json` with `0600` permissions and are never transmitted
anywhere except to the provider they belong to. If you attach logs to an issue, redact them
first — `omnikey logs` output can include request metadata.

## Verifying what you installed

Release tarballs are published as GitHub Release assets, and the Homebrew formula pins a
SHA256 for each architecture. The npm package and the Homebrew tap are built from the same
tagged commit by `.github/workflows/release.yml`. You can always build from source:
see [DEVELOPMENT.md](./DEVELOPMENT.md).
