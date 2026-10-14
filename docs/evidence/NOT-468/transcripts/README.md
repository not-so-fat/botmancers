# NOT-468 transcripts (redacted)

Real runs from 2026-10-14 (UTC 15:21–15:28). One file is one Botmancers process lifetime unless it is marked as host-side.
The decision record is [../decision-record.md](../decision-record.md).

## Under test

| Component | Exact version |
|-----------|---------------|
| Botmancers libraries | `7d0fa92455f02425e537c0f0c7795b2cd92faee1`. This contains NOT-487 `a53dd4c`. The harness commit `57233ca` adds only `scripts/not-468-restart-poc.js`, and `git diff 7d0fa92 HEAD -- lib app` is empty. |
| Agent Deck | `92e3293f67dbce3f396dad0a2b58f165fab2ac9f`. This contains NOT-480 `63ec376`, NOT-481 `0e55973`, and NOT-486 `92e3293`. It was cloned into `/tmp/not468/agent-deck-src`, built with `turbo run build`, and run as `node packages/backend/dist/index.js` with an isolated `AGENT_DECK_HOME=/tmp/not468/home` on `127.0.0.1:18468`. |
| Codex | `codex-cli 0.157.1`, logged in with ChatGPT. `CODEX_BIN` pointed to a wrapper that sets an isolated `CODEX_HOME` with an empty `config.toml`, and `auth.json` was a symlink to the owner's sign-in (not a copy). See finding F9 in the decision record for why. |
| Node | v26.10.0 |
| Mutation target | Disposable Git repo `/tmp/not468/ws` with baseline commit `dba6624`, assigned to the disposable deck through `.agent-deck/use.json` v3. The Botmancers working repository was never a run `cwd`. |
| Botmancers state | Disposable SQLite `/tmp/not468/poc/botmancers.db`. The Agent Deck server URL was set through `setAgentDeckServerUrl`. |

The caller is Botmancers' own `lib/agent-deck-api.ts` transport. The harness only wraps the transport seam (`setAgentDeckApiFetch`) to log each call and to SIGKILL itself at a boundary. The `Authorization` header is never read or logged.

## Redactions

| Shown as | Meaning |
|----------|---------|
| `<prompt sha256:… len:…>` | The rendered prompt that was sent to Agent Deck |
| `<S:01a13b03…325161>` | A Codex thread/session id: first 8 and last 6 characters. All equality assertions compare the full value. |
| `/Users/<owner>` | The owner's home directory |
| `<botmancers-worktree>` | The path of this worktree in stack frames |
| `(N empty starting/running event polls omitted)` | Event pages with no events and an unchanged cursor were dropped. Every page that carried an event or a terminal state is kept. |

Grant bearers, the admin secret, and the dashboard cookie never appear. The owner setup used the dashboard: an admin-secret nonce, then a session, then `POST /api/decks`, then `POST /api/agent-grants`. That is the same recipe as the NOT-481 smoke.

## Index

| File | Scenario | What it shows |
|------|----------|---------------|
| `01-s0-baseline.txt` | s0 | With the owner's global Codex agent-deck plugin, Codex refused the edit. The run ended `success` with an empty manifest (F8, F9). |
| `02-s0b-baseline.txt` | s0b | A second baseline with the same global plugin: Codex refused again, and the run ended `success` with an empty manifest (F8, F9) |
| `03-s0c-baseline.txt` | s0c | Uncrashed baseline: a real Codex edit, a 1-file manifest, and a Session Binding |
| `10`–`12` | s1 start-response | SIGKILL after the 202 and before the run id is persisted. Restart, then an idempotent re-POST returns the same run. |
| `20`–`22` | s2 started | Run id persisted, SIGKILL before the first status read. Restart sees `starting` with 0 events. Reattach follows. |
| `30`–`32` | s3 running | SIGKILL on the first `running` page. Restart sees `running` with 2 events and a session. Reattach follows. |
| `40`–`42` | s4 terminal | SIGKILL on the `ended` page, before the Attempt finished. Restart recovers the result, session, and manifest. Reattach persists them and binds the session. |
| `50-s5-resume.txt` | s5 | A new process resumes s4's Session Binding through a canonical revision. The same session id comes back byte-for-byte. |
| `60-n1-unknown-run.txt` | N1 | Unknown run id: `404 RUN_NOT_FOUND` for status, events, and cancel |
| `61-n2-foreign-grant.txt` | N2 | Another grant reads the run: `403 RESOURCE_OUT_OF_SCOPE` |
| `62-n3-idempotency-conflict.txt` | N3 | Same Attempt key with another body: `409 IDEMPOTENCY_CONFLICT` |
| `63-n4-resume-unknown.txt` | N4 | Resume of an unknown session: `422 RESUME_UNVERIFIED`. No run is created. |
| `64`, `65` | N5 expired grant | Launch under a 50-second grant, then restart after expiry: `401 GRANT_REQUIRED` |
| `66`, `67` | N5 rotated grant | A new grant cannot read the run (`403`). The owner dashboard still sees `ended`. |
| `68-n5-reattach-rotated-grant.txt` | N5 hazard | A re-POST of the same Attempt key under the rotated grant **launched a second run** (`run-20261014T152636-72c839`, host run directories 9 → 10). Botmancers' immutable external-id trigger then refused to record it (`SQLITE_CONSTRAINT_TRIGGER`). |
| `70`–`73`, `7x` | N7 | Botmancers and Agent Deck both SIGKILLed. A restart while Agent Deck is down gives `agent_deck_unreachable`. After Agent Deck restarts, the run is `died` with no terminal event and the orphaned Codex is stopped. A re-POST after the Agent Deck restart returns the same run (idempotency is durable). |
| `80`, `81`, `8x` | N8 | Agent Deck SIGKILLed under a live Botmancers observer. The adapter fails the Attempt on the first `ECONNREFUSED` (`failed`/`unavailable`), and its cancel is also unreachable. After the Agent Deck restart, the run is `died`. |
| `90`–`92`, `9x` | C1 | SIGKILL while `running`, then restart and cancel: `canceled`, and a repeated cancel also returns `canceled`. `canceled` is the last event, there is no `result`/`end`, the Codex process is gone, and the file was never written. |

## Launch-count ledger

Every `POST /api/agent-runs` in the transcript, grouped by `Idempotency-Key`. The host-side check is the number of run directories under `AGENT_DECK_HOME/runs`.

| Scenario | Idempotency-Key | POSTs | HTTP | Run ids returned |
|----------|-----------------|-------|------|------------------|
| s0 | `botmancers-attempt-9901a76f-89ce-4bdb-9b35-3a7ec6287dad` | 1 | 202 | `run-20261014T152114-bfbb48` |
| s0b | `botmancers-attempt-07518cca-71f6-45ac-913b-6e2f7f709965` | 1 | 202 | `run-20261014T152222-8f85dc` |
| s0c | `botmancers-attempt-0a2947ec-3c42-4cab-bc48-e3bc147bb425` | 1 | 202 | `run-20261014T152325-371e48` |
| s1 start-response | `botmancers-attempt-3d72377d-75ee-4eca-8220-dc1af3ab3637` | 3 | 202, 202, 409 (N3 probe) | `run-20261014T152347-7e5349` |
| s2 started | `botmancers-attempt-62f49373-6980-48c3-859e-0c41a79744e3` | 2 | 202, 202 | `run-20261014T152402-a7281c` |
| s3 running | `botmancers-attempt-be4bf11f-0c6f-4078-8bd9-75bee1f6b134` | 2 | 202, 202 | `run-20261014T152410-9d62d6` |
| s4 terminal | `botmancers-attempt-88b9ea03-c0cc-40c5-9ecc-4801046a5c4f` | 2 | 202, 202 | `run-20261014T152424-74465e` |
| s5 resume | `botmancers-attempt-785d6ef1-4656-449d-848f-eb7a4a82b47c` | 1 | 202 | `run-20261014T152441-e8430e` |
| N4 | `not468-probe-resume-unknown-1791991508081` | 1 | 422 | — |
| N5 (second POST under the rotated grant) | `botmancers-attempt-9ba0c3d4-6daf-4734-8c5b-d7d3b38e1a1c` | 2 | 202, 202 | `run-20261014T152525-cf8def`, **`run-20261014T152636-72c839`** |
| N7 | `botmancers-attempt-7cca0405-eba3-4a6f-a25e-6a403f1dc859` | 2 | 202, 202 (second after the Agent Deck restart) | `run-20261014T152659-0816e9` |
| N8 | `botmancers-attempt-cbf15876-61ca-49ea-a61f-7a4c855c76c3` | 1 | 202 | `run-20261014T152717-3a18cb` |
| C1 | `botmancers-attempt-554b488a-c87f-472d-9efd-822e0b08ecc6` | 1 | 202 | `run-20261014T152734-191fea` |

There were 13 distinct run ids, and the host had 13 run directories with none unaccounted for. Every same-grant re-POST (s1, s2, s3, s4, N7) returned the original run. The only second logical run is the deliberate N5 rotated-grant hazard. The harness recorded 72 assertions. The 3 that failed are exactly the N5 hazard assertions, which is the negative result that file 68 documents.

## Reproduce

```bash
# Owner side: build Agent Deck 92e3293, start it isolated, create a deck plus a run+finalization grant,
# git init a workspace, and write .agent-deck/use.json. Keep the grant token in a 0600 file.
export POC_DIR=/tmp/not468/poc POC_TOKEN_FILE=<token file> POC_DECK=<deck> POC_WORKSPACE=<ws> \
       POC_AGENT_DECK_HOME=<agent deck home> POC_AGENT_DECK_URL=http://127.0.0.1:18468
node scripts/not-468-restart-poc.js init
node scripts/not-468-restart-poc.js launch s4 --crash-at=terminal   # exit 137 = SIGKILL at the boundary
node scripts/not-468-restart-poc.js restart s4                      # startup recovery + read-only reconcile
node scripts/not-468-restart-poc.js reattach s4                     # idempotent re-POST, observe, persist
node scripts/not-468-restart-poc.js resume s4 s5                    # canonical revision resume
```
