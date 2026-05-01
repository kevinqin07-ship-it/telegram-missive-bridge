# Deploy to Railway

## Prerequisites
- [Railway account](https://railway.app) (free tier works)
- [GitHub account](https://github.com) (Railway deploys from GitHub)
- Node.js 18+ installed locally

## Step 1 — Push code to GitHub

```bash
cd telegram-missive-bridge
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/telegram-missive-bridge.git
git push -u origin main
```

## Step 2 — Deploy on Railway

1. Go to [railway.app](https://railway.app) → **New Project**
2. Choose **Deploy from GitHub repo**
3. Select your `telegram-missive-bridge` repo
4. Railway auto-detects Node.js and deploys — wait ~1 minute

## Step 3 — Add a Postgres Database

1. In your Railway project, click **+ New** → **Database** → **PostgreSQL**
2. Railway provisions the database and automatically injects `DATABASE_URL` into your service's environment — no manual copy needed
3. That's it. The server creates the `conversation_map` table on first boot

## Step 4 — Set Environment Variables

In Railway → your project → your **web service** → **Variables**, add:

| Key | Value |
|-----|-------|
| `TELEGRAM_BOT_TOKEN` | Your bot token from @BotFather |
| `MISSIVE_API_KEY` | Your key from Missive → Settings → API |
| `MISSIVE_TEAM_ID` | (Optional) Team ID from Missive → Settings → Teams |
| `WEBHOOK_SECRET` | (Optional) Any random string |

Railway sets `PORT` and `DATABASE_URL` automatically — don't add those.

## Step 5 — Get Your Public URL

In Railway → your project → **Settings** → **Networking**, click **Generate Domain**.

Your server URL will look like:
```
https://telegram-missive-bridge-production.up.railway.app
```

## Step 6 — Register Webhook with Telegram

Run this once in your terminal (replace the values):

```bash
curl -X POST "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://YOUR_RAILWAY_URL/telegram-webhook"}'
```

Expected response:
```json
{"ok": true, "result": true, "description": "Webhook was set"}
```

## Step 7 — Set Up Missive Webhook

1. Go to Missive → **Settings** → **Integrations** → **Webhooks**
2. Click **New Webhook**
3. URL: `https://YOUR_RAILWAY_URL/missive-webhook`
4. Event: `message:sent`
5. If you set `WEBHOOK_SECRET`, enter it in the Secret field
6. Save

## Step 8 — Test It

1. Send a message to your Telegram bot
2. It should appear as a new conversation in Missive
3. Reply in Missive — it should send back to the Telegram user

## Verify Health

Visit `https://YOUR_RAILWAY_URL/` — you should see:
```json
{"status": "ok", "message": "Telegram-Missive bridge is running"}
```

## Notes

- **Conversation mapping is persisted in Postgres** — server restarts and redeployments are safe, existing Telegram threads will continue to route to the correct Missive conversations.
- Railway redeploys automatically on every GitHub push.
- The `conversation_map` table is created automatically on first boot — no manual migrations needed.
