require('dotenv').config();
const express = require('express');
const db = require('./db');
const app = express();
app.use(express.json());

const {
  TELEGRAM_BOT_TOKEN,
  MISSIVE_API_KEY,
  MISSIVE_CHANNEL_ID,    // Custom Channel Account ID from Missive Settings → Accounts
  WEBHOOK_SECRET,        // optional: validate Missive custom channel webhook requests
  PORT = 3000
} = process.env;

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
const MISSIVE_API  = 'https://public.missiveapp.com/v1';

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────
async function sendToTelegram(chatId, text) {
  const res = await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text })
  });
  if (!res.ok) {
    const err = await res.text();
    console.error('[Telegram] sendMessage failed:', err);
  }
}

// POST /v1/messages — creates a new message in the Custom Channel.
// If conversationId is provided, threads into that existing conversation.
// Returns the Missive conversation ID (or null on failure).
async function sendToMissive(chatId, senderName, text, conversationId = null) {
  const payload = {
    messages: {
      account: MISSIVE_CHANNEL_ID,
      from_field: {
        id:   String(chatId),
        name: senderName
      },
      body: text,
      ...(conversationId && { conversation_id: conversationId })
    }
  };

  console.log('[Missive] sendMessage payload:', JSON.stringify(payload));

  const res = await fetch(`${MISSIVE_API}/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${MISSIVE_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const err = await res.text();
    console.error('[Missive] sendMessage failed status=%d body=%s', res.status, err);
    return null;
  }

  // 201 with no body is success for new conversations; some responses include conversation
  const raw = await res.text();
  console.log('[Missive] sendMessage response status=%d body=%s', res.status, raw);

  if (!raw) return null;
  try {
    const data = JSON.parse(raw);
    return data.conversation?.id || null;
  } catch (_) {
    return null;
  }
}

// ─────────────────────────────────────────────
// ROUTE 1: Telegram → Missive
// Telegram posts here when someone messages your bot
// ─────────────────────────────────────────────
app.post('/telegram-webhook', async (req, res) => {
  res.sendStatus(200); // always ack immediately so Telegram doesn't retry

  const message = req.body?.message;
  if (!message || !message.text) return; // ignore non-text messages for now

  const chatId     = message.chat.id;
  const text       = message.text;
  const senderName = [message.from.first_name, message.from.last_name]
    .filter(Boolean).join(' ') || 'Telegram User';

  console.log(`[Telegram→Missive] chatId=${chatId} sender="${senderName}" text="${text}"`);

  const existingConversationId = await db.getConversation(chatId);

  if (existingConversationId) {
    // Thread into the existing Missive conversation
    await sendToMissive(chatId, senderName, text, existingConversationId);
  } else {
    // New conversation — send message and capture the returned conversation ID
    const conversationId = await sendToMissive(chatId, senderName, text);
    if (conversationId) {
      await db.set(chatId, conversationId);
      console.log(`[DB] Mapped chatId=${chatId} → conversationId=${conversationId}`);
    } else {
      console.warn(`[DB] No conversationId returned — cannot map chatId=${chatId}`);
    }
  }
});

// ─────────────────────────────────────────────
// ROUTE 2: Missive → Telegram
// Missive Custom Channel posts here when your team sends a reply
// Payload: { message: { body, to_fields: [{id: chatId, ...}] }, conversation: { id } }
// ─────────────────────────────────────────────
app.post('/missive-webhook', async (req, res) => {
  res.sendStatus(200); // always ack immediately

  // Optional: validate signature secret set in the custom channel settings
  if (WEBHOOK_SECRET && req.headers['x-hook-signature']) {
    // Signature validation can be added here if needed
  }

  const { message, conversation } = req.body;

  if (!message?.body || !conversation?.id) {
    console.warn('[Missive→Telegram] Missing message.body or conversation.id — ignoring');
    return;
  }

  // chatId is stored in to_fields[0].id — set when we created the inbound message
  const chatId = message.to_fields?.[0]?.id;

  if (!chatId) {
    // Fallback: look up by conversationId in DB
    const dbChatId = await db.getChat(conversation.id);
    if (!dbChatId) {
      console.warn(`[Missive→Telegram] No chatId in to_fields and no DB match for conversationId=${conversation.id}`);
      return;
    }
    console.log(`[Missive→Telegram] chatId from DB: ${dbChatId}`);
    await sendToTelegram(dbChatId, message.body.replace(/<[^>]*>/g, '').trim());
    return;
  }

  const plainText = message.body.replace(/<[^>]*>/g, '').trim();
  console.log(`[Missive→Telegram] conversationId=${conversation.id} chatId=${chatId} text="${plainText}"`);
  await sendToTelegram(chatId, plainText);
});

// ─────────────────────────────────────────────
// Health check
// ─────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Telegram-Missive bridge is running' });
});

// ─────────────────────────────────────────────
// Debug: test Missive Custom Channel API
// ─────────────────────────────────────────────
app.get('/debug-missive', async (req, res) => {
  const payload = {
    messages: {
      account: MISSIVE_CHANNEL_ID,
      from_field: { id: '9999001', name: 'Debug User' },
      body: 'Debug test from server'
    }
  };
  const apiRes = await fetch(`${MISSIVE_API}/messages`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${MISSIVE_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const text = await apiRes.text();
  res.json({
    status: apiRes.status,
    channelIdPresent: !!MISSIVE_CHANNEL_ID,
    channelIdValue: MISSIVE_CHANNEL_ID,
    apiKeyPresent: !!MISSIVE_API_KEY,
    apiKeyPrefix: MISSIVE_API_KEY ? MISSIVE_API_KEY.substring(0, 10) + '...' : null,
    body: text
  });
});

// Init DB then start server
db.init()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server listening on port ${PORT}`);
    });
  })
  .catch(err => {
    console.error('[DB] Failed to initialize database:', err);
    process.exit(1);
  });
