# NOT-504 direct Codex smoke (redacted)

Command: `node scripts/codex-direct-smoke.js` at code HEAD `4230b9e67d2fed0edc90c43eb7058d21e80ee70d` (the tip before this evidence-only commit), macOS, Node v26.10.0, `codex-cli 0.157.1` (locally signed in). Exit status: **1**. Codex thread ids are replaced by `[codex-id]` and never appeared in Botmancers views; tmp paths shortened.

Result:
- Functional path passed: a thread created outside Botmancers (`codex exec --json`) was imported by a direct Codex Agent scoped to its workspace, read through the Botmancers session ref, asked a read-only question, and resumed under the same ref after a Botmancers restart (fresh process, same database). Both answers name BLUE HERON.
- "Not contacted" holds: Botmancers made no fetch call and held no network socket in either phase, and Codex ran with `--disable plugins`, so the Agent Deck Codex plugin installed on this machine was not loaded.
- "Not running" does **not** hold on this host: an Agent Deck backend runs here and serves other local agent sessions (including the one that ran this smoke), so it was not stopped. The smoke now treats that as a failure, so the operator check is still open until someone runs it on a machine without Agent Deck.
- This machine's global Codex instructions (`~/.codex/AGENTS.md`) still make Codex look for a local `.agent-deck/use.json` file. That is a file read inside the read-only sandbox, not a network contact, and it comes from the user's Codex configuration, not Botmancers.

```
HEAD 4230b9e67d2fed0edc90c43eb7058d21e80ee70d
codex codex-cli 0.157.1
agent-deck process running: true
codex launched with --disable plugins
native thread created outside Botmancers via codex exec --json
[first] registered direct Codex Agent, deck_id=null
[first] probe: {"status":"ready","cli_version":"0.157.1","selection":{"start":"app-server","resume":"app-server"},"ok":true}
[first] imported 1 thread(s) in scope; session ref 0da4d541-eb40-4d91-9fc4-6cebf8e756ed: {"title":"Read NOTES.md and reply with one short sentence naming the codename.","workspace":"$TMPDIR/botmancers-codex-smoke-36268/workspace","lifecycle":"open","resumable":1,"busy":0,"availability":"available"}
[first] thread/items transcript: [{"role":"user","text":"Read NOTES.md and reply with one short sentence naming the codename."},{"role":"assistant","text":"I’ll verify the bound Agent Deck session, then read the note."},{"role":"tool","text":"$ /bin/zsh -lc \"if [ -f .agent-deck/use.json ]; then sed -n '1,120p' .agent-deck/use.json; else echo NO_ASSIGNMENT_FILE;"},{"role":"tool","text":"$ /bin/zsh -lc \"sed -n '1,160p' NOTES.md\""},{"role":"assistant","text":"The codename is BLUE HERON."}]
[first] turn/start (read_only) turn ref 89a6d2f5-1c3a-47f1-8898-c734eacfe6a1
[first] turn completed: "I named the codename BLUE HERON."
[first] usage: {"input_tokens":16014,"output_tokens":13,"cached_input_tokens":15744,"cost_usd":null}
[first] thread id in views: false
[first] fetch calls (Agent Deck or other HTTP): 0; Botmancers network sockets: 0; agent-deck backend process on this machine: true
[first] phase checks passed
[restart] probe: {"status":"ready","cli_version":"0.157.1","selection":{"start":"app-server","resume":"app-server"},"ok":true}
[restart] after restart: same session ref 0da4d541-eb40-4d91-9fc4-6cebf8e756ed
[restart] turn/start (read_only) turn ref 74873b0b-3b14-4561-ad2a-333f037f9080
[restart] turn completed: "The codename is BLUE HERON."
[restart] usage: {"input_tokens":16049,"output_tokens":12,"cached_input_tokens":15872,"cost_usd":null}
[restart] thread id in views: false
[restart] fetch calls (Agent Deck or other HTTP): 0; Botmancers network sockets: 0; agent-deck backend process on this machine: true
[restart] phase checks passed
smoke FAILED: an Agent Deck backend process is running on this host; re-run on a machine without Agent Deck
```
