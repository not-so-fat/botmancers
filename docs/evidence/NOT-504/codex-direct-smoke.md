# NOT-504 direct Codex smoke (redacted)

Command: `node scripts/codex-direct-smoke.js` at code HEAD `584bf458d5baf03370b79bbe13c5436a4cdedf04`, macOS, Node v26.10.0, `codex-cli 0.157.1` (locally signed in). Codex thread ids are replaced by `[codex-id]` and never appeared in Botmancers views; home/tmp paths shortened.

Notes:
- Botmancers made no fetch call and held no network socket in either phase: it never contacted Agent Deck. An Agent Deck backend *is* running on this machine (it serves other local sessions), so the 'no Agent Deck server running' half of the operator check needs a machine without it.
- This machine's Codex has an Agent Deck plugin/skill installed globally (~/.codex/plugins). Codex itself tried that skill inside the native thread and was blocked by the read-only, never-approve policy. That is the user's Codex configuration, not Botmancers.

```
HEAD 584bf458d5baf03370b79bbe13c5436a4cdedf04
codex codex-cli 0.157.1
agent-deck process running: true
native thread created outside Botmancers via codex exec --json
[first] registered direct Codex Agent, deck_id=null
[first] probe: {"status":"ready","cli_version":"0.157.1","selection":{"start":"app-server","resume":"app-server"},"ok":true}
[first] imported 1 thread(s) in scope; session ref aeca8027-9002-4d27-a3ae-3b73d7e71a9d: {"title":"Read NOTES.md and reply with one short sentence naming the codename.","workspace":"$TMPDIR/botmancers-codex-smoke-23683/workspace","lifecycle":"open","resumable":1,"busy":0,"availability":"available"}
[first] thread/items transcript: [{"role":"user","text":"Read NOTES.md and reply with one short sentence naming the codename."},{"role":"assistant","text":"I’m using the Agent Deck session skill to verify the workspace binding before reading the requested file."},{"role":"tool","text":"$ /bin/zsh -lc \"sed -n '1,240p' ~/.codex/plugins/cache/agent-deck/agent-deck/2.2.0/skills/agent-deck-ses"},{"role":"assistant","text":"Agent Deck bootstrap failed because MCP approval is unavailable, so I can’t read `NOTES.md`."}]
[first] turn/start (read_only) turn ref ba39e86b-bc25-45fb-89aa-e230dde0981b
[first] turn completed: "I didn’t name a codename earlier."
[first] usage: {"input_tokens":21695,"output_tokens":31,"cached_input_tokens":19328,"cost_usd":null}
[first] thread id in views: false
[first] fetch calls (Agent Deck or other HTTP): 0; Botmancers network sockets: 0; agent-deck backend process on this machine: true
[restart] probe: {"status":"ready","cli_version":"0.157.1","selection":{"start":"app-server","resume":"app-server"},"ok":true}
[restart] after restart: same session ref aeca8027-9002-4d27-a3ae-3b73d7e71a9d
[restart] turn/start (read_only) turn ref 07ce1c9e-53b2-4ce2-9de7-d9ce9e7d17ea
[restart] turn completed: "No codename was named."
[restart] usage: {"input_tokens":23383,"output_tokens":10,"cached_input_tokens":21504,"cost_usd":null}
[restart] thread id in views: false
[restart] fetch calls (Agent Deck or other HTTP): 0; Botmancers network sockets: 0; agent-deck backend process on this machine: true
smoke passed
```
