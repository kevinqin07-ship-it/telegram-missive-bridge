require('dotenv').config();
const express = require('express');
const db = require('./db');
const app = express();
app.use(express.json());

const {
  TELEGRAM_BOT_TOKEN,
  MISSIVE_API_KEY,
  MISSIVE_TEAM_ID,       // optional: auto-assign to a team inbox
  WEBHOOK_SECRET,        // optional: a secret string to validate Missive webhooks
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

async function createMissiveConversation(chatId, senderName, text) {
  const body = {
    conversations: {
      subject: `Telegram: ${senderName}`,
      ...(MISSIVE_TEAM_ID && { assignee_team: MISSIVE_TEAM_ID }),
      messages: {
        from_field: {
          name: senderName,
          address: `telegram_${chatId}@telegram.bridge`
        },
        to_fields: [
          {
            name: 'Missive Connect Bot',
            address: 'missiveconnect@telegram.bridge'
          }
        ],
        body: `<p>${escapeHtml(text)}</p>`
      }
    }
  };

  console.log('[Missive] createConversation payload:', JSON.stringify(body));

  const res = await fetch(`${MISSIVE_API}/conversations`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${MISSIVE_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const err = await res.text();
    console.error('[Missive] createConversation failed status=%d body=%s', res.status, err);
    return null;
  }

  const data = await res.json();
  console.log('[Missive] createConversation response:', JSON.stringify(data));
  // Missive returns { conversation: { id: '...' } } (singular)
  return data.conversation?.id || null;
}

async function replyInMissiveConversation(conversationId, chatId, senderName, text) {
  const body = {
    drafts: {
      body: `<p>${escapeHtml(text)}</p>`,
      from_field: {
        name: senderName,
        address: `telegram_${chatId}@telegram.bridge`
      },
      to_fields: [
        {
          name: 'Missive Connect Bot',
          address: 'missiveconnect@telegram.bridge'
        }
      ],
      conversation: conversationId
    }
  };

  const res = await fetch(`${MISSIVE_API}/drafts`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${MISSIVE_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const err = await res.text();
    console.error('[Missive] replyInConversation failed status=%d body=%s', res.status, err);
  } else {
    console.log('[Missive] replyInConversation succeeded for conversationId=%s', conversationId);
  }
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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
    // Thread the reply into the existing Missive conversation
    await replyInMissiveConversation(existingConversationId, chatId, senderName, text);
  } else {
    // New conversation
    const conversationId = await createMissiveConversation(chatId, senderName, text);
    if (conversationId) {
      await db.set(chatId, conversationId);
      console.log(`[DB] Mapped chatId=${chatId} → conversationId=${conversationId}`);
    }
  }
});

// ─────────────────────────────────────────────
// ROUTE 2: Missive → Telegram
// Missive posts here when your team sends a reply
// ─────────────────────────────────────────────
app.post('/missive-webhook', async (req, res) => {
  res.sendStatus(200); // always ack immediately

  // Optional: validate secret to ensure the request is from Missive
  if (WEBHOOK_SECRET && req.headers['x-webhook-secret'] !== WEBHOOK_SECRET) {
    console.warn('[Missive] Webhook secret mismatch — ignoring');
    return;
  }

  const { rule, message, conversation } = req.body;

  // Only act on sent messages (not drafts, notes, etc.)
  if (rule?.type !== 'message:sent') return;
  if (!message?.body || !conversation?.id) return;

  const conversationId = conversation.id;
  const chatId = await db.getChat(conversationId);

  if (!chatId) {
    console.warn(`[Missive→Telegram] No Telegram chatId found for conversationId=${conversationId}`);
    return;
  }

  // Strip HTML tags from Missive's rich-text body
  const plainText = message.body.replace(/<[^>]*>/g, '').trim();

  console.log(`[Missive→Telegram] conversationId=${conversationId} chatId=${chatId} text="${plainText}"`);

  await sendToTelegram(chat