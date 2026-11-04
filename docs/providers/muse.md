# Muse provider (NOT-508)

The direct `SessionProvider` for Muse Code. The boundary it implements, the
registry, and Botmancers' policy are in
[core-engine.md](../core-engine.md#provider-sessions); this page is what is
specific to Muse.

`lib/muse-session-provider.ts` is the provider for runtime connections whose
provider is `muse` (kind `muse-msp`). It speaks the stable Muse Session
Protocol (MSP v1) to `muse serve` over stdio.

- **Probe.** The `initialize` handshake supplies the Muse version, the MSP
  envelope schema version, and session durability. Muse older than 1.4.0 or
  a schema other than 1 is `unsupported` and reports no capability; an
  ephemeral host can start sessions but cannot list, read, or resume them;
  a credential failure is `auth_required` and a missing binary
  `binary_missing` (both `provider_unavailable` to callers).
- **Operations.** `session/list` (host cursor, bounded limit, `sessionId`
  filter for a selected-sessions scope, `name`/`title` text filter for
  search, refused as `unsupported` when the host does not echo it),
  `session/read` (metadata, inline history paged locally, `lastTurn`; it
  never attaches), `session/start` + `turn/start` in the explicit workspace,
  `session/resume` + `turn/start` on the exact session, `turn/completed` and
  `session/tokenUsage` notifications for observation, and `turn/cancel`.
  Every command carries a fresh UUIDv7 `commandId`; nothing else is sent.
- **Authority.** `muse serve` fixes its sandbox at startup, so there is one
  host per authority: `read_only` runs with `--disable-write
  --disable-shell`, `workspace_write` with the default posture. Approval mode
  is `denyUnmatched`. A busy session is refused, never queued or steered.
- **Facts.** MSP v1 has no archive state, so lifecycle is `open`;
  resumable means a durable host persisted the session; busy means
  `running` or an active turn. Subagent children and malformed rows are
  skipped. Usage is `turn/completed.usage`, else the sum of the turn's
  `session/tokenUsage` records (a field any record omits is unknown), else
  null. MSP reports no per-turn cost, so cost is never estimated.
- **Restart.** Muse ids stay private (the turn id is
  `<sessionId>:<turnId>`). After a Botmancers restart, observe reads the
  durable session: its `lastTurn` gives the terminal; a turn that died with
  its host is `failed` with `host_lost`, and no replacement session is
  started. Resume reloads the same session in its own workspace.
- **Configuration.** `BOTMANCERS_MUSE_BIN` (default `muse`) and
  `BOTMANCERS_MUSE_SERVE_ARGS` (a JSON array of extra `muse serve` flags,
  for example `["--provider","echo"]`).
- **Smoke.** `node scripts/muse-msp-smoke.js` imports and resumes a real
  past session through a real `muse serve` across a Botmancers restart
  (transcript: [evidence/NOT-508/muse-msp-smoke.md](../evidence/NOT-508/muse-msp-smoke.md)).
