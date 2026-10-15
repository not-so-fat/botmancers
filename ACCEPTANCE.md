# Botmancers v0 — Acceptance Report

> Superseded (NOT-435): the embedded OpenAI-compatible model loop was removed.
> Ordinary turns now route through the persistent Hermes gateway
> (`HERMES_API_SERVER_KEY`) and coding work through Agent Deck delegation —
> there is no embedded-loop key run path anymore. This report is kept for
> history; follow `README.md` for current setup. References below to the old
> key describe what this report originally measured, not current instructions.
>
> For current, isolated acceptance coverage of the conversation/Wake engine
> run `npm run test:acceptance` (docs/acceptance-harness.md); this report's
> live-server script is now `npm run test:acceptance:live-server`.

## Summary

**Without API key:** Steps 2-5 work. Step 6 (peer wake) unproven. Steps 8-11 blocked.  
**With API key:** Steps 1-7 testable. Steps 8-11 blocked on public host.

## Test results without HERMES_API_SERVER_KEY

Run `node test-acceptance-steps-1-7.js` without API key:

### What works ✅

**Step 2: Create two arbitrary bots**
- ✅ UI accepts name, title, description
- ✅ Bots stored in SQLite
- ✅ Conversation created for each bot

**Step 3: Chat with each bot**
- ✅ Messages stored and displayed
- ✅ Agent loop processes queue
- ✅ Without key: returns clear error, never fakes a response

**Step 4: Create a group**
- ✅ Group created with selected bots
- ✅ Group conversation initialized

**Step 5: Send message to group**
- ✅ Message stored
- ✅ Bot enqueued for processing

### What's unproven ❌

**Step 6: One bot messages and wakes another**
- ❌ Requires HERMES_API_SERVER_KEY
- ❌ Bot must generate `WAKE <name>: <message>` command
- ❌ Without key, bot returns error and never generates WAKE

**Step 7: Handoff visible in conversation**
- ❌ Depends on Step 6

Test output shows:
```
STEP 6: One Bot messages and wakes another
❌ Peer wake NOT observed.
  Cause: HERMES_API_SERVER_KEY not set, so bot cannot generate WAKE command.

Steps 1-7: FAIL ❌
Reason: Step 6 (peer wake) was not observed.
Steps 2-5 work. Step 6 requires HERMES_API_SERVER_KEY to generate WAKE.

TEST RESULT: FAIL
Exit code: 1
```

### Processor proof

Cannot demonstrate without API key because:
- WAKE detector parses bot responses from the Hermes gateway
- Without HERMES_API_SERVER_KEY, bots return Hermes errors immediately
- No bot response → no WAKE command → no peer wake

See `lib/agent.ts` processQueueItem() for detection logic:
```typescript
const wakeMatch = responseContent.match(/WAKE\s+(\w+):\s*(.+)/s);
```

## Test results WITH HERMES_API_SERVER_KEY

Set environment variable and run test:
```bash
export HERMES_API_SERVER_KEY=your-key-here
node test-acceptance-steps-1-7.js
```

Expected output:
```
STEP 6: One Bot messages and wakes another
✓ PEER WAKE CONFIRMED!
  Alice sent a message to Bob's conversation:
  "[From Alice]\nPlease review my research on..."

Steps 1-7: PASS ✅
TEST RESULT: PASS
Exit code: 0
```

Database evidence:
```sql
SELECT * FROM messages 
WHERE sender_type='bot' AND sender_id IS NOT NULL;
```
Returns inter-bot messages (sender_id = originating bot).

## Steps 8-11: Blocked ❌

**Blocker:** No public always-on host

**Step 8:** Close laptop while work runs  
❌ localhost:43123 stops when process stops

**Step 9:** Work continues in the cloud  
❌ Local process, not cloud infrastructure

**Step 10:** Open from a phone  
❌ Phone cannot reach localhost:43123

**Step 11:** Reply from phone  
❌ Depends on Step 10

**What's needed:** Public host (Railway, Fly.io, Render, VPS) where process runs continuously and URL is accessible from any device.

## Step 12: Works ✅

**Reopen without losing state**
- ✅ SQLite stores all data
- ✅ Survives process restart
- ✅ Same bots, groups, messages after restart

Test:
```bash
npm run dev
# Create bots, send messages
# Ctrl+C
npm run dev
# Open http://localhost:43123 — data persists
```

## What a stranger can verify

### Without API key (honest failure)
```bash
git clone <repo>
npm install
npm run dev
node test-acceptance-steps-1-7.js
```

Output shows:
- Steps 2-5: ✅ Work
- Step 6: ❌ Requires API key
- Exit code: 1 (failure)

### With API key (full test)
```bash
export HERMES_API_SERVER_KEY=your-key
npm run dev
node test-acceptance-steps-1-7.js
```

Output shows:
- Steps 1-7: ✅ Pass (if bot generates WAKE)
- Peer wake confirmed in transcript
- Exit code: 0 (success)

### Database inspection
```bash
sqlite3 botmancers.db "SELECT * FROM bots;"
sqlite3 botmancers.db "SELECT sender_type, sender_id, content FROM messages WHERE sender_type='bot';"
```

Messages with non-null sender_id are inter-bot messages (peer wake evidence).

## Honest status

| Step | Status | Notes |
|------|--------|-------|
| 1 | ✅ Works | Responsive web UI |
| 2 | ✅ Works | Create arbitrary bots |
| 3 | ✅ Works | Individual bot chats |
| 4 | ✅ Works | Group creation |
| 5 | ✅ Works | Send to group |
| 6 | ⚠️ Needs key | Unproven without HERMES_API_SERVER_KEY |
| 7 | ⚠️ Needs key | Depends on Step 6 |
| 8 | ❌ Blocked | Needs public host |
| 9 | ❌ Blocked | Needs public host |
| 10 | ❌ Blocked | Needs public host |
| 11 | ❌ Blocked | Needs public host |
| 12 | ✅ Works | SQLite persistence |

## Error handling ✅

Without HERMES_API_SERVER_KEY:
- Bots return: "[Hermes configuration missing: HERMES_API_SERVER_KEY is not set. Set it to enable persistent Hermes turns. No fallback transport attempted.]"
- No fake responses
- No silent failures
- UI works, messages stored, error displayed clearly

## Diff scope

All changes in this repo:
- Next.js app (app/, lib/)
- SQLite schema (lib/db.ts)
- Agent loop (lib/agent.ts)
- API routes (app/api/)
- Test script (test-acceptance-steps-1-7.js)
- Docs (README.md, ACCEPTANCE.md)

No external repos, no tunnels, no mock cloud, no fake API key.
