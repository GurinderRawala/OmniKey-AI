## OmniKey AI

OmniKey AI is a cross‑platform helper (macOS menu bar app and Windows tray app) plus a small TypeScript backend that helps you quickly rewrite selected text using OpenAI.

Once everything is running, you can select any text on your Mac or PC and trigger one of three commands:

- macOS: `Cmd + E` / `Cmd + G` / `Cmd + T`.
- Windows: `Ctrl + E` / `Ctrl + G` / `Ctrl + T`.

The app sends the selected text to the backend, gets the rewritten result, and replaces your selection in place.

---

# Omnikey SaaS

Omnikey is an open-source app for managing your OpenAI API key and onboarding users. Now supports self-hosted mode with SQLite and Yarn-based workflows.

## Features

- Onboard users with their OpenAI API key
- Backend API built with Node.js, Express, and Sequelize
- CLI for onboarding and configuration
- Self-hosted mode with SQLite (no external database required)

## Getting Started

1. Clone the repository
2. Install dependencies with Yarn
3. Build and start the backend
4. Use the CLI to onboard

```sh
git clone <repo-url>
cd omnikey-saas
yarn install
yarn build
yarn start
```

## Self-Hosted Setup

When onboarding with the CLI, you can choose self-hosted mode. This will:

- Generate a `.env` file with your OpenAI API key and SQLite database path
- Configure the backend to use SQLite (no need for Postgres)
- Start the backend locally with Yarn

To onboard:

```sh
cd cli
yarn global add .
omnikey onboard
```

Follow the prompts to set up your OpenAI API key and choose self-hosted mode. The CLI will generate the necessary `.env` file for you.

## CLI Usage

See [cli/README.md](cli/README.md) for details.

## Configuration

Environment variables are loaded from `.env` or your environment. For self-hosted mode, the CLI will generate `.env` with `OPENAI_API_KEY`, `IS_SELF_HOSTED`, and `SQLITE_PATH`.

## License

MIT

1. **Install dependencies**

   ```bash
   yarn install
   ```

2. **Configure environment variables**

   Create a `.env` file in the repo root:

   ```bash
   OPENAI_API_KEY=your_openai_api_key_here
   # Optional
   LOG_LEVEL=info
   ```

3. **Start the backend server**

   ```bash
   yarn dev
   ```

   The backend listens on `http://localhost:7172`.

---

## macOS App Setup

The macOS app code is under `macOS/`.

1. Open `OmniKey-AI/macOS` in Xcode.
2. Run app in Xcode select my mac as destination.
3. Run the app; you should see the **OK** icon in the menu bar.
4. When prompted, grant **Accessibility** and (if requested) **Input Monitoring** permissions so the app can listen for shortcuts and perform copy/paste.

---

## windows App Setup

From the repo root on a Windows machine:

```bash
cd windows

# Build
dotnet build

# Run (Debug)
dotnet run
```

When the app starts, you will see a tray icon with tooltip **OmniKey AI**. The main window stays hidden; the app is controlled entirely via global shortcuts and the tray icon menu.

---

## Keyboard Commands

With the backend and macOS app running:

- `Cmd + E` – sends the selection to `/api/enhance` and replaces it with an improved coding prompt.
- `Cmd + G` – sends the selection to `/api/grammar` and replaces it with a grammatically correct version.
- `Cmd + T` – sends the selection to `/api/custom-task` and replaces it with the result of your custom task prompt.

If no text is selected, the app shows a small notification asking you to select text.

---

## Custom Task Configuration (`Cmd + T`)

The custom task uses a system prompt that you can configure with a plain text file.

- Create a file named `custom_task.md` or `custom_task.txt` in the **root** of this repository.
- Put your full system prompt text in that file (for example, a detailed SQL or refactoring guideline).
- The backend reads custom task prompt from file and uses its contents as the system prompt for `/api/custom-task`.
- If custom task instructions file is missing or unreadable, command will not work.
