# OmniKey Telegram Bot

This folder contains the canonical source for OmniKey's Telegram notification
integration. The runtime daemon — `telegram-client` — is built from a copy of
these files and ships inside the `omnikey-cli` bundle. Edit files **here** and
the build pipeline will mirror them into `telegram-client/` automatically.

The bot exposes a tiny local HTTP server (default port `6666`) that accepts:

```http
POST /telegram/send
Content-Type: application/json

{ "message": "Hello from OmniKey" }
```

…and forwards the payload to your private Telegram chat through the Bot API.
It is intentionally minimal: no inbound webhooks, no public exposure, no
secret storage outside of `~/.omnikey/config.json`.

---

## 1. Create a bot with @BotFather

1. Open Telegram and start a chat with [@BotFather](https://t.me/BotFather).
2. Send `/newbot`.
3. Pick a **display name** (e.g. `OmniKey Notifier`).
4. Pick a **username** ending in `bot` (e.g. `my_omnikey_notifier_bot`).
5. BotFather replies with an **HTTP API token** that looks like:

   ```
   123456789:ABCDefGhIJKlmNoPQRsTUVwxyZ-0123456789
   ```

   Copy this — it becomes `TELEGRAM_BOT_TOKEN`.

> Treat the token like a password. Anyone who has it can post as your bot.

## 2. Find your chat ID

The bot can only message a chat it has been added to. The easiest path:

1. Open a chat with the bot you just created and send it any message (e.g. `hi`).
2. Run the bundled helper from this folder:

   ```bash
   node telegram-bot/get-chat-id.js <TELEGRAM_BOT_TOKEN>
   ```

   It calls `getUpdates` and prints every chat the bot can see, e.g.:

   ```
   Chat: Gurinder Singh   id=123456789   type=private
   Chat: OmniKey Alerts   id=-1001234567890   type=supergroup
   ```

3. Copy the numeric `id` of the chat you want notifications in — that is your
   `TELEGRAM_CHAT_ID` (negative numbers for groups/channels are expected).

If you want notifications in a **group**, add the bot to the group first, send
any message there, then re-run the helper. For a **channel**, add the bot as
an admin.

## 3. Configure OmniKey

The Telegram client reads two variables from `~/.omnikey/config.json`:

| Key                   | Required | Description                                     |
| --------------------- | -------- | ----------------------------------------------- |
| `TELEGRAM_BOT_TOKEN`  | yes      | Token returned by BotFather                     |
| `TELEGRAM_CHAT_ID`    | yes      | Target chat id (use the helper to find it)      |
| `TELEGRAM_PORT`       | no       | Local listen port (defaults to `6666`)          |

You can set them in any of three ways:

**a. Interactive (recommended)** — let the daemon prompt for them on first run:

```bash
omnikey daemon --telegram
```

If either variable is missing the CLI will ask for it, validate the token
against the Telegram API, persist the values to `~/.omnikey/config.json`, and
then start the client.

**b. Manually with `omnikey set`:**

```bash
omnikey set TELEGRAM_BOT_TOKEN 123456789:ABC...
omnikey set TELEGRAM_CHAT_ID   123456789
```

**c. By hand** — edit `~/.omnikey/config.json` directly.

## 4. Run the client

```bash
# default port 6666
omnikey telegram-client

# custom port
omnikey telegram-client --port 7777

# alongside the main API backend
omnikey daemon --telegram
```

Verify it works:

```bash
curl -X POST http://localhost:6666/telegram/send \
     -H 'Content-Type: application/json' \
     -d '{"message":"hello from curl"}'
```

You should see the message arrive in the configured chat almost instantly.

## 5. Logs and troubleshooting

* Logs are written next to the daemon logs in `~/.omnikey/`:
  * `telegram-client.log`
  * `telegram-client-error.log`
* `401 Unauthorized` from Telegram → the token is wrong or has been revoked.
* `400 chat not found` → the bot has never received a message from that chat,
  or the chat id is wrong (don't forget the leading `-` for groups).
* Nothing happens → confirm the process is running with `omnikey status` and
  that the port matches what your producer is POSTing to.

## File layout

```
telegram-bot/
├── README.md         # this file
├── package.json      # runtime metadata (mirrored into telegram-client/)
├── get-chat-id.js    # helper for step 2
└── src/
    └── server.ts     # the HTTP → Telegram bridge
```
