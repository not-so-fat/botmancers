# NOT-517 probe and smoke results

Run on 2026-10-24 (macOS, arm64) against the logged-in CLIs, from the
branch implementing NOT-517. The probes print only presence, shape, counts,
and salted-fingerprint comparisons, never a value.

## `npm run probe:not-514-claude -- --home` (Claude Code 2.1.309)

| Case | Result |
| --- | --- |
| `new` | MCP spawned; `CLAUDE_CODE_SESSION_ID` = the chosen id |
| `resume` | MCP spawned; env = the resumed id |
| `continue` | **env ≠ the session continued** (why no ambient id is trusted) |
| `fork` | env ≠ S (a new session) |
| `new_http_header_context` | 5 MCP requests, `initialize` seen, the `${BOTMANCERS_SESSION_CONTEXT}` header delivered on every request, nothing ambient in it |

Green: unchanged from NOT-514, and the per-turn `--mcp-config` header form
NOT-517 ships is delivered on every request.

## `npm run probe:not-514-codex -- --home` (codex-cli 0.157.1)

NOT-517 adds the case `exec_http_env_header`: the exact exec overrides
Botmancers passes (`-c mcp_servers.botmancers.url`, `env_http_headers`
naming `BOTMANCERS_SESSION_CONTEXT_TOKEN`, `enabled_tools`, the share-current
`approval_mode = "approve"`), the value only in the run environment.

```json
[
  {
    "case": "exec",
    "exit": 0,
    "mcp_spawned": true,
    "per_run_context_delivered": true,
    "thread_started_reported": true,
    "ambient_thread_env": {
      "CODEX_THREAD_ID": false,
      "CODEX_SESSION_ID": false
    },
    "ambient_matches_thread": null
  },
  {
    "case": "exec_http_env_header",
    "exit": 0,
    "mcp_requests": 3,
    "context_delivered_on_every_request": true,
    "value_in_argv": false
  },
  {
    "case": "app_thread",
    "exit": "ok",
    "threads": [
      {
        "thread": "A",
        "thread_started": true,
        "rpc_error": null,
        "mcp_spawned": true,
        "per_thread_context_delivered": true,
        "ambient_thread_env": false
      },
      {
        "thread": "B",
        "thread_started": true,
        "rpc_error": null,
        "mcp_spawned": true,
        "per_thread_context_delivered": true,
        "ambient_thread_env": false
      }
    ]
  },
  {
    "case": "app_thread_http_header_context",
    "exit": "ok",
    "threads_started": [
      true,
      true
    ],
    "mcp_requests": 6,
    "requests_without_context": 0,
    "distinct_contexts_seen": 2,
    "every_context_is_a_thread_marker": true,
    "both_threads_delivered": true
  },
  {
    "case": "resume_new_process",
    "exit": "ok",
    "thread_started": true,
    "resumed": true,
    "rpc_error": null,
    "start_context_spawned": true,
    "resume_context_spawned": true,
    "resume_sees_new_context": true,
    "resume_sees_old_context": false
  },
  {
    "case": "resume_same_process",
    "exit": "ok",
    "second_resume_ok": true,
    "first_context_spawned": true,
    "second_context_spawned": false
  }
]
```

Green: per-thread contexts on one app-server, a new context on a resume in a
new process, **no** new MCP client on a second resume of a loaded thread
(load-scoped), and the exec env-header form delivered on every request with
the value not in argv.

## `npm run smoke:not-517-share-current -- claude|codex`

A real turn launched by Botmancers' own provider (`startProviderSession`),
told to call `botmancers_share_current_session`, against the real
`/api/v0/mcp` handler on a loopback port, temporary database:

| Runtime | Turn | MCP requests | Share | Exact session | `created_via` | Context after | Context in DB |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Claude Code 2.1.309 | completed | 6 | 1 | yes | `current_session` by `botmancers-session-context` | `ended:turn_end` | no |
| Codex 0.157.1 (app-server) | completed | 4 (`initialize`, `initialized`, `tools/list`, `tools/call botmancers_share_current_session`) | 1 | yes | `current_session` by `botmancers-session-context` | `live` (load-scoped, until unload/exit/15 min) | no |

Finding while running the Codex smoke: with `approvalPolicy: "never"`,
Codex declines an MCP tool call that needs approval ("MCP approval is
required, but approval is disabled"). The thread and exec entries therefore
enable exactly `botmancers_share_current_session` (`enabled_tools`) and set
only its `approval_mode` to `approve`; after that change the call went
through. Cursor was not run: it has no per-launch MCP seam and receives no
context (`test-session-context.js`).
