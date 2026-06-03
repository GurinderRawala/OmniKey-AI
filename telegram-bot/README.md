# OmniKey Telegram Bot

A local HTTP → Telegram bridge for OmniKey notifications. Runs as a tiny
Express server (default port `7072`, or whatever you set via `PORT` /
`--port`) that exposes:

```http
POST /telegram/send
Content-Type: application/json

{ "message": "Hello", "parseMode": "Markdown" }
```

…and forwards the payload to a chat through the Telegram Bot API. The bot
also keeps a Telegram message listener open and bridges replies into the
OmniKey agent (see `src/notifyTelegram.ts` / `src/agentClient.ts`).

This folder is the **canonical source**. The OmniKey CLI build pipeline
mirrors it into a `telegram-client/` bundle that ships with `omnikey-cli`
on both npm and Homebrew.

---

## 1. Create a bot with @BotFather

1. Open Telegram and start a chat with [@BotFather](https://t.me/BotFather).
2. Send `/newbot`.
3. Choose a **display name** (e.g. `OmniKey Notifier`).
4. Choose a **username** ending in `bot` (e.g. `my_omnikey_notifier_bot`).
5. BotFather replies with an HTTP API token of the form:

   ```
   123456789:ABCDefGhIJKlmNoPQRsTUVwxyZ-0123456789
   ```

   Copy this — it becomes `TELEGRAM_BOT_TOKEN`.

> Treat the token like a password. Anyone who has it can post as your bot.

## 2. Find your chat ID

The bot can only message a chat it has been added to. Easiest path:

1. Open a chat with the bot you just created and send it any message (e.g. `hi`).
   For a **group** chat, add the bot to the group and post any message.
   For a **channel**, add the bot as an admin and post any message.
2. Hit Telegram's `getUpdates` endpoint:

   ```bash
   curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getUpdates"
   ```

3. Look for `"chat": { "id": ... }` in the response. That number is your
   `TELEGRAM_CHAT_ID`. Group/channel ids are negative — keep the minus sign.

## 3. Configure OmniKey

The bot reads these variables. Set them however you like — `.env`, real
environment variables, or via OmniKey config:

| Key                  | Required | Description                                                     |
| -------------------- | -------- | --------------------------------------------------------------- |
| `TELEGRAM_BOT_TOKEN` | yes      | Token returned by BotFather                                     |
| `TELEGRAM_CHAT_ID`   | yes      | Numeric chat id (negative for groups/channels)                  |
| `PORT`               | no       | Listen port (defaults to `7072`; CLI default is `6666`)         |
| `LOG_LEVEL`          | no       | `error`, `warn`, `info`, `debug` — defaults to `info`           |

When you launch the client through the OmniKey CLI it also reads these
keys from `~/.omnikey/config.json`. Three ways to provide them:

**a. Interactive (recommended)** — let the CLI prompt on first run:

```bash
# Standalone
omnikey telegram-client

# Or alongside the main backend
omnikey daemon --telegram
```

If either variable is missing the CLI prompts for it, validates the token
against the Telegram API, writes the values to `~/.omnikey/config.json`,
and then starts the service.

**b. With `omnikey set`:**

```bash
omnikey set TELEGRAM_BOT_TOKEN 123456789:ABC...
omnikey set TELEGRAM_CHAT_ID   123456789
```

**c. Standalone development** — use the bundled `.env`:

```bash
cd telegram-bot
cp .env.example .env
# edit .env, then:
yarn install
yarn build
yarn start
```

## 4. Run the client

```bash
# default port 6666 (CLI default; the underlying app uses 7072 if no PORT is set)
omnikey telegram-client

# custom port
omnikey telegram-client --port 7777

# alongside the main API backend
omnikey daemon --telegram --telegram-port 6666
```

Smoke test it:

```bash
curl -X POST http://localhost:6666/telegram/send \
     -H 'Content-Type: application/json' \
     -d '{"message":"hello from curl"}'
```

You should see the message in the configured chat almost instantly.

## 5. Standalone launchd manager (macOS only)

If you want to run the bot directly (not through `omnikey-cli`), this
project ships its own launchd manager:

```bash
yarn daemon:start      # build + install LaunchAgent + load
yarn daemon:status     # show launchctl entry + port liveness
yarn daemon:logs       # tail stdout + stderr
yarn daemon:restart    # reload after a code change
yarn daemon:stop       # unload
yarn daemon:uninstall  # unload + remove the plist
```

LaunchAgent path: `~/Library/LaunchAgents/com.gurindersingh.telegram-bot.plist`
Logs:             `~/Library/Logs/telegram-bot/{out,err}.log`

## 6. Troubleshooting

* Logs (when launched via OmniKey CLI):
  * `~/.omnikey/telegram-client.log`
  * `~/.omnikey/telegram-client-error.log`
* `401 Unauthorized` from Telegram → the token is wrong or has been revoked.
* `400 Bad Request: chat not found` → the bot has never received a message
  from that chat, or the chat id is wrong (missing leading `-` for groups).
* Nothing happens → confirm the process is running with `omnikey status`
  and that the port matches what your producer is POSTing to.

## File layout

```
telegram-bot/
├── README.md
├── package.json
├── tsconfig.json
├── .env.example
└── src/
    ├── index.ts              # Express server + Telegram listener bootstrap
    ├── notifyTelegram.ts     # Bot lifecycle, send + message routing
    ├── agentClient.ts        # OmniKey agent WS bridge
    ├── omnikeyAuth.ts        # JWT issuance against the local OmniKey API
    ├── config.ts             # ~/.omnikey/config.json reader
    ├── db.ts                 # SQLite cache (better-sqlite3)
    └── daemon.ts             # standalone launchd manager
```
