# Contributing to OmniKey AI

Thanks for considering a contribution. OmniKey is MIT licensed and runs entirely on the
user's machine — that constraint shapes most of the guidance below.

## The one rule that matters most

**OmniKey must never phone home.** The daemon, CLI, and desktop apps run locally. The only
network calls OmniKey makes are to the LLM provider, the web-search provider, and the MCP
servers _the user configured themselves_. No analytics, no usage pings, no crash reporting,
no counters — not even anonymised ones.

If a change would record anything about how someone uses OmniKey, it will be declined
regardless of how well it is implemented. When in doubt, open an issue first.

## Getting set up

Full environment setup, build order, and the monorepo tour live in
**[DEVELOPMENT.md](./DEVELOPMENT.md)**. The short version:

```sh
git clone https://github.com/GurinderRawala/OmniKey-AI.git
cd OmniKey-AI
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm test
```

Node `^22.12.0 || >=24.0.0` for development (the published CLI/API only require Node ≥ 22
at runtime) and pnpm 10.34.9, pinned by the root `packageManager` field. `pnpm-lock.yaml` is
the only lockfile; commit it whenever you change dependencies, and never add `yarn.lock` or
`package-lock.json`. Xcode 15+ only if you are touching `macOS/`; .NET 10 only for
`windows/`. Neither native client is needed to work on the TypeScript services.

## Where to start

Issues labelled [`good first issue`](https://github.com/GurinderRawala/OmniKey-AI/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22)
are scoped so you can finish them in one sitting. Beyond those, these areas are the easiest
to contribute to meaningfully:

| Label              | Area                                                  | Why it is a good entry point                                                                        |
| ------------------ | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `provider-adapter` | `api/src/ai-client.ts`                                | Self-contained. Add or improve support for an LLM provider without touching the rest of the system. |
| `mcp-recipe`       | docs                                                  | Write up a working MCP server pairing. No build required.                                           |
| `docs`             | `README.md`, `DEVELOPMENT.md`, `api/public/docs.html` | The fastest way to make your first merged PR.                                                       |
| `help wanted`      | anywhere                                              | Things that are wanted but not yet started.                                                         |

## Making a change

1. Branch off `main`.
2. Keep the change focused. One concern per pull request.
3. Run `pnpm test`, `pnpm lint`, and `pnpm format` (or confirm with `pnpm format:check`)
   before pushing. If you touch workspace tooling (`package.json` scripts,
   `pnpm-workspace.yaml`, `turbo.json`), also run `pnpm test:tooling` and `pnpm test:cache` (the latter only in a disposable checkout: it deletes and restores build outputs). For native changes run
   `swift build && swift test` (macOS) or `dotnet build` and `dotnet test windows.Tests/OmniKey.Windows.Tests.csproj` (Windows).
4. Add tests when you change behaviour. The `api` workspace uses vitest; see
   `api/src/__tests__/` for the established patterns.
5. Write a commit message that explains _why_, not just _what_. The diff shows what changed.

## Pull requests

- Describe the problem before the solution, and mention how you verified the fix.
- Screenshots or a short clip help a lot for `macOS/` and `windows/` changes.
- CI must be green. `publish-cli` runs on pushes to `main` that touch `cli/**`, so CLI
  changes also need a version bump — see below.

### Versioning

`cli/package.json` and `api/package.json` move together. Any merged change that touches
`cli/**` triggers a publish to npm, and npm rejects a republish of an existing version, so
bump the patch in both files in the same pull request. (There is no `cli/package-lock.json`;
the repo's only lockfile is `pnpm-lock.yaml`.)
Releases are cut by pushing a matching `v*` tag, which builds the macOS tarballs, publishes
the GitHub Release, and updates the Homebrew formula and tap.

## Reporting bugs

Open an issue with your OS and version, the OmniKey version (`omnikey --version`), the
provider you configured, and the exact steps to reproduce. `omnikey logs` output is usually
the single most useful thing you can attach — **redact your API keys first**.

## Security

Do not open a public issue for a vulnerability. See [SECURITY.md](./SECURITY.md).

## Code of conduct

Be straightforward and civil. Critique code, not people. Maintainers may remove comments or
contributions that are abusive, dismissive, or deliberately unproductive.
