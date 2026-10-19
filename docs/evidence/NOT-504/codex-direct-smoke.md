# NOT-504 direct Codex smoke (redacted)

**Status: pending operator verification.** The `[operator]` check ("no Agent Deck server is running or contacted") cannot pass on the agent host, because Agent Deck runs the agent sessions there. The transcript below is the expected fail-closed run: the smoke exits 1 while an Agent Deck backend is present. An operator closes this check by following "Operator re-run" at the end of this file.

Command: `node scripts/codex-direct-smoke.js` at code HEAD `49f7e607bc1398a96e8a4abf1b4a8d50664b2d56` (the round-6 merge of `origin/main`, the tip before this evidence-only commit), macOS, Node v26.10.0, `codex-cli 0.157.1` (locally signed in). Exit status: **1**. Codex thread ids are replaced by `[codex-id]` and never appeared in Botmancers views; tmp paths shortened.

Result:
- Functional path passed: a thread created outside Botmancers (`codex exec --json`) was imported by a direct Codex Agent scoped to its workspace, read through the Botmancers session ref, asked a read-only question, and resumed under the same ref after a Botmancers restart (fresh process, same database). Both answers name BLUE HERON.
- "Not contacted" holds: Botmancers made no fetch call and held no network socket in either phase, and Codex ran with `--disable plugins`, so the Agent Deck Codex plugin installed on this machine was not loaded.
- "Not running" does **not** hold on this host: an Agent Deck backend runs here and serves other local agent sessions (including the one that ran this smoke), so it was not stopped. The smoke now treats that as a failure, so the operator check is still open until someone runs it on a machine without Agent Deck.
- This machine's global Codex instructions (`~/.codex/AGENTS.md`) still make Codex look for a local `.agent-deck/use.json` file. That is a file read inside the read-only sandbox, not a network contact, and it comes from the user's Codex configuration, not Botmancers.

```
HEAD 49f7e607bc1398a96e8a4abf1b4a8d50664b2d56
codex codex-cli 0.157.1
agent-deck process running: true
codex launched with --disable plugins
native thread created outside Botmancers via codex exec --json
[first] registered direct Codex Agent, deck_id=null
[first] probe: {"status":"ready","cli_version":"0.157.1","selection":{"start":"app-server","resume":"app-server"},"ok":true}
[first] imported 1 thread(s) in scope; session ref 532d98a4-a15b-4d9d-b2a7-10100f2acd83: {"title":"Read NOTES.md and reply with one short sentence naming the codename.","workspace":"$TMPDIR/botmancers-codex-smoke-54040/workspace","lifecycle":"open","resumable":1,"busy":0,"availability":"available"}
[first] thread/items transcript: [{"role":"user","text":"Read NOTES.md and reply with one short sentence naming the codename."},{"role":"assistant","text":"I’ll verify the workspace’s Agent Deck binding first, then read the note."},{"role":"tool","text":"$ /bin/zsh -lc 'if [ -e .agent-deck/use.json ]; then echo expected; else echo no-assignment-signal; fi'"},{"role":"tool","text":"$ /bin/zsh -lc \"sed -n '1,160p' NOTES.md\""},{"role":"assistant","text":"The codename is BLUE HERON."}]
[first] turn/start (read_only) turn ref 6a3c3937-ce77-4c66-b1b7-3ee86a61dd14
[first] turn completed: "I named the codename BLUE HERON."
[first] usage: {"input_tokens":16037,"output_tokens":13,"cached_input_tokens":15872,"cost_usd":null}
[first] thread id in views: false
[first] fetch calls (Agent Deck or other HTTP): 0; Botmancers network sockets: 0; agent-deck backend process on this machine: true
[first] phase checks passed
[restart] probe: {"status":"ready","cli_version":"0.157.1","selection":{"start":"app-server","resume":"app-server"},"ok":true}
[restart] after restart: same session ref 532d98a4-a15b-4d9d-b2a7-10100f2acd83
[restart] turn/start (read_only) turn ref 2add7974-23d8-4ee3-9686-a4294d547930
[restart] turn completed: "The codename is BLUE HERON."
[restart] usage: {"input_tokens":16072,"output_tokens":12,"cached_input_tokens":15872,"cost_usd":null}
[restart] thread id in views: false
[restart] fetch calls (Agent Deck or other HTTP): 0; Botmancers network sockets: 0; agent-deck backend process on this machine: true
[restart] phase checks passed
smoke FAILED: an Agent Deck backend process is running on this host; re-run on a machine without Agent Deck
```

## Operator re-run (closes the "no Agent Deck running" check)

Rounds 3, 4, and 6 could not close this check either: the Agent Deck backend on this host (`@agent-deck/backend`, Agent Deck 2.2.0) serves the agent session that runs the builder and other agent sessions that are running now. Stopping it would break that work. Docker (OrbStack) is not running here (re-checked in round 6: `docker info` fails), so no isolated host was available.

On a machine (or container) with a signed-in `codex` (0.157.x) and no Agent Deck:

1. `git checkout <branch tip>` and run `pgrep -fl @agent-deck/backend`. It must print nothing.
2. `node scripts/codex-direct-smoke.js > /tmp/not504-smoke.txt; echo "exit $?"`. It must print `exit 0`, and the last line must be `smoke passed`.
3. Replace the transcript above with `/tmp/not504-smoke.txt`. It is already redacted, and its `HEAD` line records the tip that was used.
