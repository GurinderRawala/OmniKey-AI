## OmniKey AI

OmniKey AI is a macOS menu bar app plus a small TypeScript backend that helps you quickly rewrite selected text using OpenAI.

Once everything is running, you can select any text on your Mac and trigger one of three commands:

- `Cmd + E` – **Enhance prompt** (rewrite into a clearer, LLM‑friendly coding prompt).
- `Cmd + G` – **Grammar** (fix grammar, spelling, and clarity only).
- `Cmd + T` – **Custom task** (run your own custom system prompt).

The app sends the selected text to the backend, gets the rewritten result, and replaces your selection in place.

---

## Components

- **macOS app** (status bar app)
  - Lives in the menu bar with an "OK" icon.
  - Listens globally for `Cmd + E`, `Cmd + G`, and `Cmd + T`.
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

The macOS app code is under `PromptEnhancerApp/`.

1. Open `PromptEnhancerApp/Package.swift` in Xcode.
2. Select the `PromptEnhancerApp` scheme and your Mac as destination.
3. Run the app; you should see the **OK** icon in the menu bar.
4. When prompted, grant **Accessibility** and (if requested) **Input Monitoring** permissions so the app can listen for shortcuts and perform copy/paste.

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
