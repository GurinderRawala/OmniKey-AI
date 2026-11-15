# Developing OmniKey AI

OmniKey AI is a [pnpm workspace](https://pnpm.io/workspaces) monorepo orchestrated by [Turborepo](https://turborepo.com/), with three TypeScript workspaces plus two native desktop clients. The workspace package names are `omnikey-ai-api` (`api/`), `omnikey-cli` (`cli/`), and `telegram` (`telegram/`).

```
OmniKey-AI/
├── api/        — backend service (Express + Sequelize, deployed to Cloud Run)
├── cli/        — omnikey CLI (published to npm + Homebrew)
├── telegram/   — Telegram bot runtime, bundled inside the CLI
├── macOS/      — menu bar app (Swift, SwiftPM)
└── windows/    — system tray app (C#, .NET)
```

The CLI ships **all three TypeScript services in one package**: at build time `cli/` copies `api/dist` into `cli/backend-dist/` and `telegram/dist` into `cli/telegram-client-dist/`, so end users get a self-contained binary from `brew install omnikey-cli` or `npm install -g omnikey-cli`.

## Prerequisites

- **Node.js for development:** **22.12.0+ within the 22.x line, or 24.0.0+** (`^22.12.0 || >=24.0.0`). This is the baseline for installing the full development dependencies and for monorepo work, including lint. CI and the Docker image use Node 22.
- **Node.js at runtime:** the published `omnikey-ai-api` and `omnikey-cli` manifests declare `engines.node: ">=22"`. That is what end users need to run the CLI/daemon; it does not mean every Node 22 release can install the development toolchain.
- **pnpm 10.34.9**, pinned exactly by the root `packageManager` field. The easiest way to get the matching version is `corepack enable` (Corepack ships with Node 22 and 24); otherwise `npm install -g pnpm@10.34.9`. pnpm 10 requires Node ≥18.12; the selected Turbo 2 release supports our Node 22 baseline. The stricter development floor covers Vite/Vitest and typescript-eslint, while existing production dependencies continue to support Node ≥22. Turbo **2.11.11** is a pinned root dev dependency, so no global install is needed — use the root scripts or `pnpm turbo …`.
- For the native clients: Xcode 15+ (macOS) or .NET 10 SDK + Visual Studio 2022 (Windows). Neither is required to work on the TypeScript services.

## Getting started

```sh
git clone https://github.com/GurinderRawala/OmniKey-AI.git
cd OmniKey-AI
corepack enable                 # once per machine; selects pnpm 10.34.9 from packageManager
pnpm install --frozen-lockfile  # installs every workspace exactly as pnpm-lock.yaml records
cp api/.env.example api/.env    # API commands run with api/ as their working directory
pnpm build                      # Turbo builds api + telegram, then the CLI that bundles them
```

A successful `pnpm build` produces:

- `api/dist/` — compiled API
- `telegram/dist/` — compiled Telegram bot
- `cli/dist/` — compiled CLI
- `cli/backend-dist/` — copy of `api/dist/` (so the CLI can launch the daemon)
- `cli/telegram-client-dist/` — copy of `telegram/dist/` (so `omnikey telegram start` works)

## Day-to-day workflow

### Dependencies and the lockfile

- `pnpm-lock.yaml` is the **only** dependency lockfile. Do not add `yarn.lock`, `package-lock.json`, or `npm-shrinkwrap.json` files anywhere in the repo.
- Use `pnpm install --frozen-lockfile` for clean checkouts, CI, and release work; it fails instead of rewriting the lockfile. Run plain `pnpm install` (or `pnpm --filter <name> add <pkg>`) only when you intend to change dependencies, and commit the resulting `pnpm-lock.yaml` change in the same pull request as the manifest change.
- The published CLI never pinned consumers with a lockfile: `npm publish` does not include `package-lock.json` in the package tarball, so the old `cli/package-lock.json` was removed rather than replaced.
- pnpm uses its default isolated `node_modules` layout; there is no blanket hoisting. Each workspace must declare every package it imports in its own `package.json`. Undeclared imports that only worked because Yarn hoisted them will fail.
- pnpm 10 does not run dependency lifecycle scripts unless they are approved. `pnpm-workspace.yaml` approves only `sqlite3`. If a new dependency genuinely needs an install script, add it to that allowlist in the same reviewed pull request and explain why.

`injectWorkspacePackages: true` enables pnpm 10’s lockfile-based deploy. Do not use `--legacy`: validation found that it can leave a self-link pointing back to the checkout. The deploy output contains its own virtual store and must pass `node scripts/verify-cli-bundle.mjs <stage>`.

### Running the API locally

```sh
pnpm dev                # ts-node-dev on api/src/index.ts with hot reload (API only)
pnpm dev:all            # every workspace's persistent dev task (never cached)
# or, for one workspace:
pnpm --filter omnikey-ai-api dev
```

Required env vars are validated in [`api/src/config.ts`](./api/src/config.ts). At minimum you need an LLM API key (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, or `NVIDIA_API_KEY`/`NEMOTRON_API_KEY`). For the self-hosted SQLite path set `IS_SELF_HOSTED=true`; for the SaaS path set `DATABASE_URL` to a Postgres connection string.

### Running the CLI against your local build

```sh
pnpm build:cli                          # builds api + telegram first, then cli/dist + backend-dist + telegram-client-dist
node cli/dist/index.js --help           # invoke without installing globally
# or link it globally (needs pnpm's global bin dir; run `pnpm setup` once if missing):
(cd cli && pnpm link --global)
omnikey --help
```

### Running the Telegram bot locally

```sh
pnpm --filter telegram dev              # hot reload via ts-node-dev
```

Telegram needs `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in `.env` — see [`telegram/README.md`](./telegram/README.md) for the BotFather flow.

## Main pnpm commands (run from the repo root)

| Command                              | What it does                                                                                                                                                                                            |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`     | Install all workspace deps exactly as `pnpm-lock.yaml` records.                                                                                                                                         |
| `pnpm build`                         | Build **all three** services through Turbo. `omnikey-cli#build` explicitly depends on `omnikey-ai-api#build` and `telegram#build`, and its outputs include the copied `backend-dist/` and `telegram-client-dist/`. |
| `pnpm build:api` / `build:telegram`  | Build a single service.                                                                                                                                                                                 |
| `pnpm build:cli`                     | Build the CLI **and** its prerequisite API/Telegram builds, producing complete CLI artifacts.                                                                                                          |
| `pnpm dev`                           | Start the API in watch mode (API only).                                                                                                                                                                 |
| `pnpm dev:all`                       | Start every workspace's persistent dev task. Never cached.                                                                                                                                              |
| `pnpm start`                         | Run the compiled API (`api/dist/index.js`).                                                                                                                                                             |
| `pnpm test`                          | Run vitest across every workspace through Turbo (API and CLI execute real suites; Telegram currently has no tests).                                                                                    |
| `pnpm lint`                          | Run ESLint across all three TypeScript workspaces; typed rules are deferred.                                                                                                                            |
| `pnpm format`                        | Rewrite files with Prettier across every workspace's `src/**`. Mutates files, so it is never cached.                                                                                                   |
| `pnpm format:check`                  | Check Prettier formatting without writing any files.                                                                                                                                                    |
| `pnpm clean`                         | Remove every `dist/`, `backend-dist/`, and `telegram-client-dist/`.                                                                                                                                     |
| `pnpm test:tooling`                  | Run the workspace/tooling contract tests (`node --test scripts/tests/workspace.test.mjs`).                                                                                                              |
| `pnpm test:cache`                    | Check Turbo cache behaviour (`node scripts/test-turbo-cache.mjs`).                                                                                                                                      |

### Filtering and the Turbo cache

- `pnpm --filter <name> <script>` runs one workspace's script directly, where `<name>` is `omnikey-ai-api`, `omnikey-cli`, or `telegram` (list them with `pnpm -r ls --depth -1`). It **bypasses the Turbo task graph**: `pnpm --filter omnikey-cli build` does not rebuild the API or Telegram first, so it can copy stale or missing outputs. Use `pnpm build:cli` (or `pnpm build`) when you need complete CLI artifacts.
- The root `build*`, `test`, `lint`, and `dev:all` scripts run through Turbo, which replays unchanged cacheable tasks (such as builds) from its local cache. Tests and CLI test type-checking, persistent dev tasks, `pnpm format`, and `pnpm clean` are never cached. Development tasks use loose environment mode so existing shell-supplied provider/runtime settings keep working; build hashes include `NODE_ENV` and shared lint/TypeScript configuration. No secret or runtime-state directories are declared as cache outputs. To force a re-run while debugging, pass `--force`, e.g. `pnpm turbo run build --force`.
- If a task gains a new input or output, update `turbo.json` in the same change so the cache cannot replay stale results; `pnpm test:cache` exercises the cache contract. Run it only in a disposable checkout: it deliberately deletes and restores compiled output. Never run it against the checkout serving a live daemon.

The lint toolchain is pinned to ESLint 9.39.5, @eslint/js 9.39.5, and typescript-eslint 8.72.2, which support the Node 22 development baseline above. The published API/CLI runtime metadata declares Node ≥22; that does not mean every Node 22 release supports the full development toolchain.

After fixing the simple baseline findings, ESLint reports 257 warnings and no errors across the three TypeScript workspaces: API has 213 `no-explicit-any`, 8 `no-empty-object-type`, 6 `no-control-regex`, and 6 `no-useless-escape`; CLI has 18 `no-explicit-any`, 4 `preserve-caught-error`, and 1 `no-require-imports`; Telegram has 1 `no-control-regex`. These rules remain warnings while the existing findings are addressed. Type-aware checks such as `no-floating-promises` are deferred; ESLint currently uses the recommended non-type-aware rule sets.

## Common CLI commands

These are the commands the published CLI exposes — useful both for trying your local build and as a quick reference.

| Command                                               | Description                                                                                                                                            |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `omnikey onboard`                                     | Interactive setup for LLM provider and (optional) web-search provider.                                                                                 |
| `omnikey daemon`                                      | Start the API backend as a persistent background daemon (launchd on macOS, Task Scheduler on Windows). Add `--telegram` to start the Telegram bot too. |
| `omnikey restart-daemon`                              | Kill + start in one step.                                                                                                                              |
| `omnikey kill-daemon`                                 | Stop the daemon.                                                                                                                                       |
| `omnikey status` / `omnikey logs`                     | Inspect the daemon.                                                                                                                                    |
| `omnikey config`                                      | Show current configuration (API keys masked).                                                                                                          |
| `omnikey set <KEY> <VALUE>`                           | Update a single config value.                                                                                                                          |
| `omnikey remove-config [--db]`                        | Wipe the config directory (and optionally the SQLite database).                                                                                        |
| `omnikey grant-browser-access`                        | Create a dedicated CDP debug profile so the agent can read authenticated browser tabs.                                                                 |
| `omnikey browser open`                                | Reopen the debug profile browser.                                                                                                                      |
| `omnikey mcp add` / `list` / `toggle <id>`            | Manage named MCP servers that connect on demand.                                                                                                       |
| `omnikey schedule add` / `list` / `remove`            | Manage scheduled jobs.                                                                                                                                 |
| `omnikey telegram start` / `status` / `logs` / `stop` | Manage the Telegram bot daemon.                                                                                                                        |

Full reference: [`cli/README.md`](./cli/README.md).

## Tests

```sh
pnpm test                                       # all workspaces (through Turbo)
pnpm --filter omnikey-ai-api test               # just the api
pnpm --filter omnikey-ai-api test:watch         # vitest in watch mode
pnpm test:tooling                               # workspace/tooling contract tests
pnpm test:cache                                 # disposable checkout only: deletes/restores build outputs
```

`api/vitest.config.ts` loads the repo-root `.env` and provides safe defaults for `DATABASE_URL`, `IS_SELF_HOSTED`, and `OPENAI_API_KEY`, so the suite runs without any real credentials.

## Docker / Cloud Run

The repo root `Dockerfile` builds **only the `api` workspace** for deployment, on Node 22 with the pinned pnpm and a frozen `pnpm-lock.yaml` install:

```sh
docker build -t omnikey-api .
docker run -p 8080:8080 --env-file .env omnikey-api
```

Cloud Run picks this image up from the release branch automatically.

## CI/CD

Two GitHub Actions workflows ship the CLI:

- **`.github/workflows/release.yml`** — fires on `v*` tags. Builds the whole monorepo with `pnpm install --frozen-lockfile && pnpm build`, stages a self-contained CLI bundle with `pnpm --filter omnikey-cli deploy --prod <stage>` (production dependencies only), verifies that the staged `sqlite3` native binding loads and that no symlink escapes the stage, uploads the tarball as a GitHub Release asset, and opens reviewable PRs for the Homebrew formula and generated changelog/blog pages in this repo and for the formula in the tap repo. Release-specific `automation/release-v<version>` branches are updated on retries; neither PR is auto-merged.
- **`.github/workflows/publish-cli.yaml`** — fires on `main` when `cli/**` changes. Runs `pnpm install --frozen-lockfile && pnpm build`, then `npm publish` from `cli/`. Because any `cli/**` change publishes, the patch version in `cli/package.json` and `api/package.json` must be bumped in the same pull request; npm rejects republishing an existing version.

Release automation never pushes directly to `main`. Enable **Settings → Actions → General → Allow GitHub Actions to create and approve pull requests** so the default `GITHUB_TOKEN` can open the repository PR; the workflow does not approve PRs. The release job requests `contents: write` and `pull-requests: write`.

Optionally configure `RELEASE_PR_TOKEN` with repository Contents and Pull requests write access if release-metadata PRs must trigger normal PR/push CI: events created using `GITHUB_TOKEN` do not trigger those workflows automatically. This token is used for checkout/push and PR creation. Do not add automation to the protected-branch bypass list; generated updates still require manual review/merge.

`HOMEBREW_TAP_PAT` must grant Contents and Pull requests write access to `GurinderRawala/homebrew-omnikey`; the repository's `GITHUB_TOKEN` cannot write to that separate repository. Both release PRs must be merged before the corresponding formula/page changes become live.

Installs and builds use pnpm on Node 22 throughout; only the final publish step uses `npm publish`, which needs the project-scoped `.npmrc` that `actions/setup-node` writes.

To reproduce the release staging locally, start from `pnpm install --frozen-lockfile` and `pnpm build`, then run `pnpm --filter omnikey-cli deploy --prod <empty-stage-dir>`. Symlinks inside the stage are fine as long as they resolve within it; before packing, confirm `sqlite3` loads from the stage and that no link under `<empty-stage-dir>` points outside it.

## Native clients

- **macOS** (`macOS/`) — open `OmniKey-AI.xcworkspace` (or use `swift build`/`swift run` from the directory). The app talks to the local API daemon at `http://127.0.0.1:<OMNIKEY_PORT>`.
- **Windows** (`windows/`) — open the `.sln` in Visual Studio or run `dotnet build` / `dotnet run` from the directory. Same local API contract.

Neither client has a hard dependency on the TypeScript services for compiling — you can iterate on them independently as long as the API daemon is running.

## Skills development and release checks

Read [Skills v1 contract](docs/skills-contract.md), [user guide](docs/skills.md), and [verification matrix](docs/skills-verification.md). API and CLI use one backend store/matcher; native tests cover transport and presentation, not separate matching implementations.

```sh
pnpm --filter omnikey-ai-api test
pnpm --filter omnikey-cli test
pnpm --filter omnikey-cli test:types
dotnet build windows/OmniKey.Windows.csproj
dotnet test windows.Tests/OmniKey.Windows.Tests.csproj
```

Windows requires the .NET **10** SDK. The test project links platform-neutral production source and runs on macOS/Linux; it does not replace Windows WPF runtime tests. CI runs it on Windows. macOS uses `swift build && swift test`. When developing inside the running OmniKey app, never restart its backend or write its build outputs: use isolated scratch/worktree build directories and disposable databases.

PostgreSQL tests are opt-in: set `SKILLS_TEST_PG_URL` to a **disposable** PostgreSQL database (or `SKILLS_TEST_PG_SOCKET` for the private local test socket on port 55439), then run `pnpm --filter omnikey-ai-api test src/__tests__/skills.postgres.test.ts`. The test creates/drops a unique schema and never reads `DATABASE_URL`; absent explicit test settings, it skips. SQLite migration/restart tests always use isolated temporary files.

Native manual checks remain required before release: shared-daemon CRUD with CLI, refresh after external edits, old backend, chat/hotkey/steering activation, blocked limits, stop/reconnect, keyboard/VoiceOver/Narrator. Live application feedback is not durable audit history. Backend-first rollout, backup DB, retain table data on code rollback. CLI/API patch versions must move together because merging `cli/**` to main publishes the CLI.

## Dependency refresh policy (PR #84)

Dependency updates are tested against the existing CommonJS output and Node baseline, not applied blindly across every major. The November 2026 refresh updates the AI SDKs, Google Cloud Storage, SQLite 6, cron-parser 5, Commander 14, MCP, browser tooling, network/database libraries, Prettier, typescript-eslint, and compatible type definitions. The unused Jest/ts-jest toolchain was removed; tests use Vitest. Development workers now declare their direct `ts-node` preload dependency. Commander retains the previous excess-argument behavior.

Intentional compatibility constraints:

- **Anthropic 0.137.0 / Google GenAI 1.52.0:** latest releases on the existing protocol/API lines. Anthropic 1 changes its wire API version; Gemini 3 needs provider streaming/tool/abort integration coverage before a major migration. No live provider calls are part of this refresh.

- **ESLint/@eslint/js 9.39.5:** latest 9.x; ESLint 10 requires Node 22.13 rather than the current development floor of 22.12. ESLint 9 is deprecated upstream; move to 10 when deliberately raising that floor.
- **TypeScript 5.9.3:** latest 5.x. TypeScript 7 exceeds typescript-eslint's supported `<6.1` peer range; a compiler/module-resolution migration is separate work. Keep `@types/node` on the latest 22.x to match the minimum runtime, rather than exposing Node 26-only APIs.
- **Vitest 4.1.12:** latest 4.x; Vitest 5 narrows supported Node lines. Vite is explicitly updated to 8.3.8 for security fixes.
- **Express 4.22.3 + matching 4.x types:** latest 4.x, preserving route syntax, query parsing and error behavior. Express 5 is a framework migration.
- **Commander 14.0.3 / Inquirer 9.3.8:** a native dynamic-import adapter lets the CommonJS CLI load ESM-only Inquirer on Node 22.0–22.11; current majors require Node 22.12 and 22.22.2 respectively. Inquirer keeps its matching 9.x types.
- **Telegram bot API 0.67.0:** latest compatible 0.x. Version 2 replaces the existing default-exported constructor/polling/event API; upgrading requires a Telegram-client rewrite. Matching community types are current.
- **pnpm 10.34.9 / Turbo 2.11.11:** retain the tested migration/deploy versions. pnpm 12 is a separate package-manager migration, not a lockfile-only update.
- **cuid 3:** already the latest release but deprecated. Replacing persisted identifier generation is outside this refresh. The diff renderer retains its exact version pin.

`pnpm-workspace.yaml` documents narrowly scoped security overrides. The Telegram Cypress wrapper supplies its request implementation to `request-promise-core`; removing only core's unused `request` peer prevents auto-installing the obsolete vulnerable client. Regression tests exercise real loopback Telegram text/multipart requests and Sequelize UUID defaults/transactions. UUID overrides retain the CommonJS `v1()`/`v4()` APIs used by their parents. Patched Vite, minimatch and qs versions are also required.

The committed workspace/release graph is audited with `pnpm audit`. These overrides govern pnpm installs and deployed release bundles; they **do not** propagate to consumers installing the npm package, which resolve dependencies from the published manifest. Do not claim the npm consumer graph is vulnerability-free solely from the workspace audit.

SQLite 6's prebuilt native binding runs on the unchanged Node ≥22 runtime baseline. Its optional `node-gyp` 12 toolchain requires Node ≥22.9 when compiling from source; use the documented development Node baseline for source builds (including Docker's musl build). No additional dependency install scripts are globally enabled.
