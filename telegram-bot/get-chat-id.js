#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Helper script: prints every chat the bot has received messages from.
 * Usage:
 *   node get-chat-id.js <TELEGRAM_BOT_TOKEN>
 */
const https = require('https');

const token = process.argv[2] || process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('Usage: node get-chat-id.js <TELEGRAM_BOT_TOKEN>');
  process.exit(1);
}

const url = `https://api.telegram.org/bot${token}/getUpdates`;

https
  .get(url, (res) => {
    let body = '';
    res.on('data', (chunk) => (body += chunk));
    res.on('end', () => {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch (e) {
        console.error('Failed to parse Telegram response:', body);
        process.exit(1);
      }
      if (!parsed.ok) {
        console.error(`Telegram API error (${parsed.error_code}): ${parsed.description}`);
        process.exit(1);
      }
      const updates = parsed.result || [];
      if (updates.length === 0) {
        console.log('No updates yet. Send any message to your bot from the target chat first.');
        return;
      }
      const seen = new Map();
      for (const update of updates) {
        const chat =
          update.message?.chat ||
          update.edited_message?.chat ||
          update.channel_post?.chat ||
          update.edited_channel_post?.chat;
        if (!chat) continue;
        if (seen.has(chat.id)) continue;
        seen.set(chat.id, chat);
      }
      for (const chat of seen.values()) {
        const name = chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.username || '(unknown)';
        console.log(`Chat: ${name}\tid=${chat.id}\ttype=${chat.type}`);
      }
    });
  })
  .on('error', (err) => {
    console.error('Request failed:', err.message);
    process.exit(1);
  });
