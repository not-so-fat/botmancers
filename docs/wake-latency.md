# Wake latency (NOT-391)

How long a botmancers specialist takes to produce its first reply text when it is started from nothing, and when it is already warm. Measured on the owner's MacBook Air with the Claude Agent SDK. Raw log: `not-391-timing-log.jsonl` (16 runs, JSON lines).

## Result

Seconds to first reply text (`tFirstText`). The first message from the SDK (`tFirstMsg`) is shown for reference.

| Path | Kind | Runs | Median first text | Worst first text | Median first message |
| --- | --- | --- | --- | --- | --- |
| A, new SDK session | cold | 5 | 1.57 s | 2.66 s | 0.73 s |
| A, new SDK session | warm | 3 | 0.83 s | 1.13 s | 0.11 s |
| B, resume of a small seeded session | cold | 5 | 1.70 s | 1.97 s | 0.86 s |
| B, resume of a small seeded session | warm | 3 | 0.84 s | 0.85 s | 0.10 s |

No run errored.

Cold means a fresh node process for each run. Warm means the process was already up.

## Decision

Median cold first text is under 10 s on both paths, so no persistence ticket is opened from this measurement.

The 10 s threshold is a placeholder. It has not been confirmed by the owner. If the real threshold is lower than 1.7 s, this decision changes.

## Protocol

- Claude Agent SDK, using the owner's logged-in subscription.
- Working directory: the botmancers repo, with the planner deck loaded through `.mcp.json`.
- Machine: the owner's MacBook Air.
- Each cold run was a fresh node process.
- Prompt: "reply with the single word ok". No tool calls.

## Caveats

- The prompt is trivial and makes no tool calls. A real specialist turn with tools will take longer to reach its first text and much longer to finish. These numbers say nothing about turn length.
- Path B resumed a small seeded session, not the large planner session. All eight path B runs reused one session id. A large session will likely resume more slowly. That is not measured here.
- Small samples: five cold runs and three warm runs per path. The medians are rough. The cold worst case on path A (2.66 s) is one run, about a second above its median.
- One machine, one network, one account. No runs on the cloud host.
- The 10 s threshold is an unconfirmed placeholder (see Decision).

## Not measured

- Large planner session resume.
- Runs with tool calls.
- Cloud-hosted timing.
- Idle token cost of a warm process.
