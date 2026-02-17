## OmniKey AI

OmniKey AI is a cross‑platform helper (macOS menu bar app and Windows tray app) plus a small TypeScript backend that helps you quickly rewrite selected text using OpenAI.

Once everything is running, you can select any text on your Mac or PC and trigger one of three commands:

- macOS: `Cmd + E` / `Cmd + G` / `Cmd + T`.
- Windows: `Ctrl + E` / `Ctrl + G` / `Ctrl + T`.

The app sends the selected text to the backend, gets the rewritten result, and replaces your selection in place.

---

## Components

- **macOS app** (status bar app)
  - Lives in the menu bar with an "OK" icon.
  - Listens globally for `Cmd + E`, `Cmd + G`, and `Cmd + T`.
  - Captures the currently selected text and replaces it with the processed result.

- **windows app** (tray app)
  - Runs in the Windows system tray with an icon.
  - Listens globally for `Ctrl + E`, `Ctrl + G`, and `Ctrl + T`.
  - Captures the currently selected text and replaces it with the processed result.

- **Backend API** (TypeScript + Express)
  - Runs on `http://localhost:7172`.
  - Endpoints:
    - `POST /api/enhance` – enhance prompt (`Cmd + E`).
    - `POST /api/grammar` – grammar fix (`Cmd + G`).
    - `POST /api/custom-task` – custom task (`Cmd + T`).

---

## Prerequisites

- macOS 13 or later.
- Xcode installed (for the macOS app).
- Windows 10 or later.
- .NET 8.0 SDK installed (for the Windows tray app).
- Node.js and Yarn installed (for the backend).
- An OpenAI API key in `.env`.

---

## Backend Setup

All backend files live in the repository root (for example `package.json`, `src/index.ts`).

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
