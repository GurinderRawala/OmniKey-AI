# OmniKey via Telegram

You can now access the OmniKey agent directly from Telegram. Send commands to your bot and get agent responses, reasoning, and shell output delivered to your chat — from any device, anywhere.

---

## Configure

### 1. Create a bot with @BotFather

1. Open Telegram and start a chat with [@BotFather](https://t.me/BotFather).
2. Send `/newbot`.
3. Choose a display name (e.g. `OmniKey Agent`).
4. Choose a username ending in `bot` (e.g. `my_omnikey_bot`).
5. BotFather replies with a token:

   ```
   123456789:ABCDefGhIJKlmNoPQRsTUVwxyZ-0123456789
   ```

   This becomes `TELEGRAM_BOT_TOKEN`. Treat it like a password.

### 2. Find your chat ID

1. Open a chat with your new bot and send it any message (e.g. `hi`).  
   For a **group**, add the bot and post a message. For a **channel**, add it as admin.
2. Fetch updates:

   ```bash
   curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getUpdates"
   ```

3. Find `"chat": { "id": ... }` in the response. That number is `TELEGRAM_CHAT_ID`.  
   Group and channel IDs are negative — keep the minus sign.

### 3. Start the Telegram daemon

The CLI handles the rest. Run:

```bash
omnikey telegram start
```

If `TELEGRAM_BOT_TOKEN` or `TELEGRAM_CHAT_ID` are not yet saved, the CLI prompts for them, validates the token against the Telegram API, and saves them to `~/.omnikey/config.json` before installing the daemon.

Alternatively, start both the main OmniKey backend and the Telegram daemon together:

```bash
omnikey daemon --telegram
```

Or set the credentials manually first, then start:

```bash
omnikey set TELEGRAM_BOT_TOKEN 123456789:ABC...
omnikey set TELEGRAM_CHAT_ID   -1001234567890
omnikey telegram start
```

### Environment variables

| Key                  | Required | Description                                            |
| -------------------- | -------- | ------------------------------------------------------ |
| `TELEGRAM_BOT_TOKEN` | yes      | Token from @BotFather                                  |
| `TELEGRAM_CHAT_ID`   | yes      | Numeric chat ID (negative for groups/channels)         |
| `PORT`               | no       | HTTP server port (defaults to `7072`)                  |
| `LOG_LEVEL`          | no       | `error` · `warn` · `info` · `debug` — defaults to `info` |

---

## Manage the daemon

```bash
omnikey telegram start      # Prompt for credentials if missing, install and start
omnikey telegram stop       # Stop the daemon
omnikey telegram restart    # Restart after a config change
omnikey telegram status     # Show whether the daemon is running
omnikey telegram logs       # Tail stdout + stderr
omnikey telegram uninstall  # Stop and remove the daemon
```

On **macOS** the daemon runs as a launchd `LaunchAgent` — it starts at login, restarts on crash, and survives reboots.  
Plist: `~/Library/LaunchAgents/com.<your-username>.telegram.plist`  
Logs: `~/Library/Logs/telegram/{out,err}.log`

On **Windows** the daemon runs as an NSSM Windows service (`OmnikeyTelegram`) — it starts at boot, restarts automatically, and requires no user session.  
Logs: `~/.omnikey/telegram/daemon.log`

---

## Use it — Telegram commands

All commands are only accepted from the configured `TELEGRAM_CHAT_ID`. Messages from any other chat are silently ignored.

---

### `/cmd` — Run an agent task

Opens a guided wizard to start a new session or resume a recent one.

**Wizard steps:**

1. **Session** — pick a recent session to resume, or start a new one.
2. **Instructions** — pick a saved task template to set as the active default, or skip.
3. **Project** — pick a project for context, or skip.
4. **Prompt** — send your prompt as the next plain-text message.

Each step is presented as an inline keyboard. Tap **✕ Cancel** at any point to abort.

```
/cmd
```

Add `--verbose` (or `-v`) to also receive shell commands, terminal output, web calls, MCP calls, and image events as they happen:

```
/cmd --verbose
```

---

### `/task` — Show the last result

If an agent session is **currently running**, shows the most recent reasoning snapshot.

If no session is running, fetches the final answer from the most recent completed session and sends it to the chat (formatted, split across multiple messages if needed).

```
/task
```

---

### `/stop` — Abort a running session

Sends an abort signal to the running agent turn. The session stops cleanly and you get a confirmation message.

```
/stop
```

---

## Troubleshooting

| Symptom | Fix |
| ------- | --- |
| `401 Unauthorized` from Telegram | Token is wrong or revoked — re-run `omnikey telegram start` to re-enter it |
| `400 Bad Request: chat not found` | Bot has never received a message from that chat, or chat ID is wrong (missing `-` for groups) |
| Commands are silently ignored | Message is coming from a chat ID that doesn't match `TELEGRAM_CHAT_ID` |
| Daemon not running | Check `omnikey telegram status` and `omnikey telegram logs` |
| Nothing listening on port | Confirm `omnikey daemon` is running; check `omnikey status` |

