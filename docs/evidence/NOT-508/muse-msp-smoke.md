# NOT-508 real Muse MSP smoke

Command: `node scripts/muse-msp-smoke.js` (free `--provider echo`, isolated
workspace and Muse home; no Agent Deck configured, network `fetch` disabled).
Muse session/turn ids (UUIDv7) are redacted by the script; none reached the
output. The Botmancers references below are safe to share.

```text
# NOT-508 Muse MSP smoke
head: f37c97552fc567ed63e7e483303fd059e146d5fc
muse: Muse Code 1.4.10 (1.4.10-R6427.1)
node: v26.10.0  provider: --provider echo  agent deck: not configured

## 0. a past session created outside Botmancers (muse exec)
muse exec: exit 0, session echo: Smoke: describe this empty workspace in one line.

## 1. Botmancers process 1: probe, import, read
  agent: direct, deck=none, scope=1 workspace, policy=read_only
  probe: status=ready muse=1.4.10 msp_schema=1 durability=durable
  ok: the MSP capability probe is ready
  sync: imported=1 rejected_out_of_scope=0; re-sync imported=0 updated=1
  ok: the past session imports once
  session ref (Botmancers): 51c96038-9490-4012-a7fc-1daed07980ad
  catalog state: {"availability":"available","lifecycle":"open","resumable":true,"busy":false,"synced_at":1792390210127}
    #1 user: Smoke: describe this empty workspace in one line.
    #2 assistant: echo: Smoke: describe this empty workspace in one line.
  ok: the transcript reads through session/read
  ok: no network call (no Agent Deck)

## 2. Botmancers process 2 (restart): resume the exact session
  session ref (Botmancers): 51c96038-9490-4012-a7fc-1daed07980ad
  turn: 7a826f32-553a-4f69-ae02-79819f005c5f kind=send authority=read_only state=completed session_ref=51c96038-9490-4012-a7fc-1daed07980ad
  output: echo: Smoke after restart: reply with one short line.
  ok: the exact session resumed and the turn completed
    #1 user: Smoke: describe this empty workspace in one line.
    #2 assistant: echo: Smoke: describe this empty workspace in one line.
    #3 user: Smoke after restart: reply with one short line.
    #4 assistant: echo: Smoke after restart: reply with one short line.
  ok: the resumed turn is appended to the same session
  events: session_imported=1 session_synced=2 turn_completed=1 turn_started=1
  ok: no network call (no Agent Deck)

muse sessions on disk: before=1 after=1 (no replacement session)
SMOKE PASSED
```
