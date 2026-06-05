# Developing OmniKey AI

OmniKey AI is a [Yarn 1 workspace monorepo](https://classic.yarnpkg.com/lang/en/docs/workspaces/) with three TypeScript workspaces plus two native desktop clients.

```
OmniKey-AI/
├── api/        — backend service (Express + Sequelize, deployed to Cloud Run)
├── cli/        — omnikey CLI (published to npm + Homebrew)
├── telegram/   — Telegram bot runtime, bundled inside the CLI
├── macOS/      — menu bar app (Swift, SwiftPM)
└── windows/    — system tray app (C#, .NET)
```

The CLI ships **all three TypeScript services in one package**: at build time `cli/` copies `api/dist` into `cli/backend-dist/` and `telegram/dist` into `cli/telegram-client-dist/dist/`, so end users get a self-contained binary from `brew install omnikey-cli` or `npm install -g omnikey-cli`.

## Prerequisites

- Node.js **≥ 22** (the engines field allows ≥ 14, but CI uses 22).
- **Yarn 1.22+** (`npm install -g yarn` if you don't have it). Yarn is the **only** supported package manager — there are no `package-lock.json` files in the repo.
- For the native clients: Xcode 15+ (macOS) or .NET 8 SDK + Visual Studio 2022 (Windows). Neither is required to work on the TypeScript services.

## Getting started

```sh
git clone https://github.com/GurinderRawala/OmniKey-AI.git
cd OmniKey-AI
yarn install            # installs every workspace (hoisted to root node_modules)
cp .env.example .env    # if present — otherwise create .env manually (see api/src/config.ts for required vars)
yarn build              # builds api → telegram → cli in dependency order
```

A successful `yarn build` produces:

- `api/dist/` — compiled API
- `telegram/dist/` — compiled Telegram bot
- `cli/dist/` — compiled CLI
- `cli/backend-dist/` — copy of `api/dist/` (so the CLI can launch the daemon)
- `cli/telegram-client-dist/` — copy of `telegram/dist/` (so `omnikey telegram start` works)

## Day-to-day workflow

### Running the API locally

```sh
yarn dev                # ts-node-dev on api/src/index.ts with hot reload
# or, explicitly:
yarn workspace omnikey-ai-api run dev
```

Required env vars are validated in [`api/src/config.ts`](./api/src/config.ts). At minimum you need an LLM API key (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, or `NVIDIA_API_KEY`/`NEMOTRON_API_KEY`). For the self-hosted SQLite path set `IS_SELF_HOSTED=true`; for the SaaS path set `DATABASE_URL` to a Postgres connection string.

### Running the CLI against your local build

```sh
yarn build:cli                          # ensures cli/dist + backend-dist + telegram-client-dist exist
node cli/dist/index.js --help           # invoke without installing globally
# or link it for the duration of your session:
yarn --cwd cli link
omnikey --help
```

### Running the Telegram bot locally

```sh
yarn workspace telegram run dev         # hot reload via ts-node-dev
```

Telegram needs `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in `.env` — see [`telegram/README.md`](./telegram/README.md) for the BotFather flow.

## Main yarn commands (run from the repo root)

| Command                                 | What it does                                                                                                                |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `yarn install`                          | Install all workspace deps (hoisted to the root `node_modules`).                                                            |
| `yarn build`                            | Build **all three** services in the correct order. Equivalent to `yarn build:api && yarn build:telegram && yarn build:cli`. |
| `yarn build:api` / `:telegram` / `:cli` | Build a single workspace.                                                                                                   |
| `yarn dev`                              | Start the API in watch mode.                                                                                                |
| `yarn start`                            | Run the compiled API (`api/dist/index.js`).                                                                                 |
| `yarn test`                             | Run vitest across every workspace (currently 67 tests in `api`; `cli`/`telegram` are no-ops).                               |
| `yarn lint`                             | Stubbed in every workspace — wire a real linter here when adopted.                                                          |
| `yarn format`                           | Run Prettier across every workspace's `src/**`.                                                                             |
| `yarn clean`                            | Remove every `dist/`, `backend-dist/`, and `telegram-client-dist/`.                                                         |

To run a script in just one workspace, use `yarn workspace <name> run <script>` where `<name>` is `omnikey-ai-api`, `omnikey-cli`, or `telegram`. List them with `yarn workspaces info`.

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
| `omnikey mcp add` / `list` / `toggle <id>`            | Manage MCP servers exposed to the agent.                                                                                                               |
| `omnikey schedule add` / `list` / `remove`            | Manage scheduled jobs.                                                                                                                                 |
| `omnikey telegram start` / `status` / `logs` / `stop` | Manage the Telegram bot daemon.                                                                                                                        |

Full reference: [`cli/README.md`](./cli/README.md).

## Tests

```sh
yarn test                                       # all workspaces
yarn workspace omnikey-ai-api run test          # just the api
yarn workspace omnikey-ai-api run test:watch    # vitest in watch mode
```

`api/vitest.config.ts` loads the repo-root `.env` and provides safe defaults for `DATABASE_URL`, `IS_SELF_HOSTED`, and `OPENAI_API_KEY`, so the suite runs without any real credentials.

## Docker / Cloud Run

The repo root `Dockerfile` builds **only the `api` workspace** for deployment:

```sh
docker build -t omnikey-api .
docker run -p 8080:8080 --env-file .env omnikey-api
```

Cloud Run picks this image up from the release branch automatically.

## CI/CD

Two GitHub Actions workflows ship the CLI:

- **`.github/workflows/release.yml`** — fires on `v*` tags. Builds the whole monorepo with `yarn install --frozen-lockfile && yarn build`, stages a self-contained CLI bundle (re-resolves production-only deps inside the staging dir), uploads the tarball as a GitHub Release asset, and updates the Homebrew formula in `Formula/omnikey-cli.rb` plus the tap repo.
- **`.github/workflows/publish-cli.yaml`** — fires on `main` when `api/`, `cli/`, or `telegram/` change. Builds the monorepo and runs `yarn publish` from `cli/`.

Both workflows are 100% Yarn — there is no `npm ci` or `npm publish` anywhere.

## Native clients

- **macOS** (`macOS/`) — open `OmniKey-AI.xcworkspace` (or use `swift build`/`swift run` from the directory). The app talks to the local API daemon at `http://127.0.0.1:<OMNIKEY_PORT>`.
- **Windows** (`windows/`) — open the `.sln` in Visual Studio or run `dotnet build` / `dotnet run` from the directory. Same local API contract.

Neither client has a hard dependency on the TypeScript services for compiling — you can iterate on them independently as long as the API daemon is running.
