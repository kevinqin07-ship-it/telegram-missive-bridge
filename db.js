const { Pool } = require('pg');

// Railway injects DATABASE_URL automatically when you add a Postgres addon
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway')
    ? { rejectUnauthorized: false }
    : false
});

// Create the mapping table if it doesn't exist yet
async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS conversation_map (
      chat_id         TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_conversation_id
      ON conversation_map (conversation_id);
  `);
  console.log('[DB] conversation_map table ready');
}

// Save a chatId <-> conversationId mapping
async function set(chatId, conversationId) {
  await pool.query(
    `INSERT INTO conversation_map (chat_id, conversation_id)
     VALUES ($1, $2)
     ON CONFLICT (chat_id) DO UPDATE SET conversation_id = EXCLUDED.conversation_id`,
    [String(chatId), conversationId]
  );
}

// Look up Missive conversationId by Telegram chatId
async function getConversation(chatId) {
  const { rows } = await pool.query(
    'SELECT conversation_id FROM conversation_map WHERE chat_id = $1',
    [String(chatId)]
  );
  return rows[0]?.conversation_id || null;
}

// Look up Telegram chatId by Missive conversationId
async function getChat(conversationId) {
  const { rows } = await pool.query(
    'SELECT chat_id FROM conversation_map WHERE conversation_id = $1',
    [conversationId]
  );
  return rows[0]?.chat_id || null;
}

module.exports = { init, set, getConversation, getChat };
