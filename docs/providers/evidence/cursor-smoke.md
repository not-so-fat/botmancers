# Cursor provider real smoke (NOT-505)

Command: `node scripts/cursor-session-smoke.js` (`npm run smoke:cursor-session`)
on macOS (darwin), Node v26.10.0, against the installed, logged-in Cursor Agent
CLI. HEAD: `5bad1e71b7bc814e74879dd817ad908933822114`.

- **Cursor version:** `2026.10.16-e3cb207` (CLI backend; no SDK installed).
- **Session listing: not supported** by this version. The probe reports
  `list: false` (its `ls` is an interactive picker with no JSON output), and
  `syncAgentSessions` was refused as `unsupported`. The outside chat was made
  addressable by explicit scoped import.
- **Outside session:** created with `cursor-agent create-chat` plus one
  stream-json turn run directly from the shell, with no Botmancers code involved.
- **Restart:** the import and the resume ran in two separate Botmancers
  processes on the same database. The resume process recalled the codeword
  from the outside turn, which proves it reached the exact chat.
- **No Agent Deck:** `AGENT_DECK_*` was cleared, the Agent has `deck_id: null`
  and `launch_profile: direct`, and Botmancers made zero in-process `fetch` calls.
- **Redaction:** the Cursor chat id is replaced by `<cursor-chat-REDACTED>`.
  It does not occur in the output at all, so nothing was replaced. The home
  directory is shown as `~`.

## Transcript (structured, redacted)

```jsonl
{"step":"header","head":"5bad1e71b7bc814e74879dd817ad908933822114","node":"v26.10.0","platform":"darwin"}
{"step":"outside","cursor_version":"2026.10.16-e3cb207","created_chat":true,"turn_exit":0,"result_subtype":"success","result_text":"OK"}
{"step":"outside","check":"a chat created and used directly with cursor-agent, outside Botmancers","pass":true}
{"step":"import","process":20573,"probe":{"backend":"cli","cli":{"available":true,"version":"2026.10.16-e3cb207","list":false},"sdk":{"available":false,"version":null,"list":false}}}
{"step":"import","capability_report":{"provider_kind":"cursor","list":false,"search":false,"read":true,"resume":true,"start":true,"cancel":true,"usage":true,"authorities":["read_only","workspace_write"],"max_page_size":50,"explicit_import":true},"deck_id":null,"launch_profile":"direct"}
{"step":"import","session_listing":{"supported":false,"refused_as":"unsupported"}}
{"step":"import","check":"the capability report matches what discovery actually does","pass":true}
{"step":"import","safe_session_ref":"1bbd5a92-a4dd-45cd-9461-57d2035acca6","created":true,"repeat_created":false}
{"step":"import","check":"explicit scoped import is idempotent","pass":true}
{"step":"import","check":"no network call from Botmancers (no Agent Deck)","pass":true}
{"step":"resume","process":20596,"restarted":true,"safe_session_ref":"1bbd5a92-a4dd-45cd-9461-57d2035acca6"}
{"step":"resume","turn":{"turn_ref":"e45dfa2e-1596-48f2-8bf8-8ad860f3028d","session_ref":"1bbd5a92-a4dd-45cd-9461-57d2035acca6","kind":"send","authority":"read_only","state":"completed","output":"ZEBRA8280","failure_code":null,"created_at":1792377348445,"finished_at":1792377364910},"terminal_event":{"type":"turn_completed","usage":{"input_tokens":12279,"output_tokens":26,"cost_usd":null}}}
{"step":"resume","check":"the exact outside chat resumed after the restart and recalled its codeword","pass":true}
{"step":"resume","transcript":[{"role":"user","text":"What codeword did I ask you to remember? Reply with only the codeword."},{"role":"assistant","text":"ZEBRA8280"}]}
{"step":"resume","unknown_target":{"refused_as":"session_missing","turn_rows":0}}
{"step":"resume","check":"an unknown resume target is missing; no process, no fresh chat","pass":true}
{"step":"resume","cancel":{"turn":{"turn_ref":"7dae6c88-4605-47e5-8e56-30fbfb203a74","session_ref":"1bbd5a92-a4dd-45cd-9461-57d2035acca6","kind":"send","authority":"read_only","state":"cancelled","output":null,"failure_code":"cancelled","created_at":1792377364914,"finished_at":1792377367978},"outcome":"cancelled"},"repeat_cancel":{"turn":{"turn_ref":"7dae6c88-4605-47e5-8e56-30fbfb203a74","session_ref":"1bbd5a92-a4dd-45cd-9461-57d2035acca6","kind":"send","authority":"read_only","state":"cancelled","output":null,"failure_code":"cancelled","created_at":1792377364914,"finished_at":1792377367978},"outcome":"already_terminal"},"after_cancel":{"state":"cancelled"}}
{"step":"resume","check":"a running real Cursor turn is cancelled","pass":true}
{"step":"resume","durable":{"sessions":2,"turns":{"cancelled":1,"completed":1},"events":{"cancel_requested":1,"session_imported":1,"session_missing":1,"session_synced":3,"turn_cancelled":1,"turn_completed":1,"turn_started":2}}}
{"step":"resume","check":"no network call from Botmancers (no Agent Deck)","pass":true}
{"step":"summary","pass":true}
```
