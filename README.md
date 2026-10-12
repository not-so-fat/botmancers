# Botmancers v0

The smallest real cloud-hosted Grok-like teammate web app.

## Status

**Without API key:** Steps 2-5 work. Step 6 unproven.  
**With API key:** Steps 1-7 testable. Steps 8-11 blocked on public host.

## What works

- ✅ **Steps 2-5:** Create bots, chat individually, create groups, send to group
- ⚠️ **Steps 6-7:** Peer wake and handoff (requires OPENAI_API_KEY to test)
- ✅ **Step 12:** State persists in SQLite after restart
- ❌ **Steps 8-11:** Blocked on public always-on host

## What's blocked

**Steps 8-11 require public host:**
- ❌ Step 8: Close laptop while work runs — localhost stops when process stops
- ❌ Step 9: Work continues in cloud — this is a local process
- ❌ Step 10: Open from phone — phone cannot reach localhost:43123
- ❌ Step 11: Reply from phone — depends on Step 10

**Why:** localhost:43123 is not accessible from other devices. When terminal closes, process stops. Needs deployment to Railway, Fly.io, Render, VPS, etc. (Engineering Lead decides).

## How to run

### Prerequisites

- Node.js 18+
- npm

### Setup

1. Install dependencies:
```bash
npm install
```

2. Configure API (required for bot responses):
```bash
export OPENAI_API_KEY=your-key-here
export OPENAI_BASE_URL=https://openrouter.ai/api/v1  # optional
export OPENAI_MODEL=gpt-3.5-turbo                    # optional
```

Or create `.env.local`:
```
OPENAI_API_KEY=your-key-here
OPENAI_BASE_URL=https://openrouter.ai/api/v1
OPENAI_MODEL=gpt-3.5-turbo
```

**Without OPENAI_API_KEY:** UI works, bots are created/stored, but chat returns clear error messages instead of bot responses.

### Run

```bash
npm run dev
```

Open http://localhost:43123

## Acceptance test

### Without API key (steps 2-5 only)

```bash
node test-acceptance-steps-1-7.js
```

Output shows:
- Steps 2-5: ✅ Work
- Step 6: ❌ Peer wake not observed (needs API key)
- Exit code: 1 (FAIL)

### With API key (steps 1-7)

```bash
export OPENAI_API_KEY=your-key
node test-acceptance-steps-1-7.js
```

Output shows:
- Steps 1-7: ✅ Pass (if bot generates WAKE command)
- Peer wake confirmed with inter-bot message
- Exit code: 0 (PASS)

See `ACCEPTANCE.md` for detailed test results.

## How peer wake works

When a bot generates:
```
WAKE <bot_name>: <message>
```

The agent processor (lib/agent.ts):
1. Detects WAKE command via regex
2. Posts message to target bot's conversation with sender_id
3. Enqueues processing job for target bot
4. Target bot receives and responds

This is real inter-bot messaging. Verify:
```bash
sqlite3 botmancers.db "SELECT * FROM messages WHERE sender_type='bot' AND sender_id IS NOT NULL;"
```

Messages with non-null sender_id are inter-bot messages.

**Why API key required:** WAKE detection parses bot responses from chat API. Without key, bots return errors immediately and never generate WAKE.

## Architecture

- **Frontend:** Next.js + TypeScript + Tailwind CSS (responsive)
- **Backend:** Next.js API routes
- **Database:** SQLite (botmancers.db)
- **Agent loop:** Background processor (runs every 2 seconds)
- **Chat API:** OpenAI-compatible (configurable)

All data persists in SQLite:
- Bots (identity, title, description)
- Groups and membership
- Conversations (per bot, per group)
- Messages (user and bot messages, with sender tracking)
- Processing queue

## Development

```bash
npm run dev          # Start dev server on port 43123
npm run build        # Build for production
npm start            # Run production build
npm run test:acceptance  # Run acceptance test
```

Database initializes automatically. Agent loop processes queued messages in background.

## Testing state persistence (Step 12)

```bash
npm run dev
# Create bots and send messages
# Stop server (Ctrl+C)
npm run dev
# Open http://localhost:43123
# All bots, groups, and messages persist
```

## Error handling

Without OPENAI_API_KEY:
- ✅ Bots return clear error message
- ✅ No fake responses
- ✅ UI stores messages and displays error
- ✅ Test fails honestly (exit code 1)

## Next steps to unblock 8-11

Deploy to public host where:
- Process runs continuously (not tied to laptop)
- URL is publicly accessible (reachable from phone)
- State persists (SQLite file or volume)

Engineering Lead owns hosting decision.
