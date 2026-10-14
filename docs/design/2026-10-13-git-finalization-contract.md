# Git finalization for sandboxed coding-agent runs

Status: accepted

Date: October 13, 2026

Ticket: NOT-485

## Decision

Split policy from host-local mechanism:

- Botmancers owns the workflow decision. It records the pre-run workspace baseline,
  receives the coding result, obtains reviewer acceptance, and submits an immutable
  manifest of approved repository-relative paths and content digests.
- Agent Deck owns the host-local Git mechanism. It exposes a narrow, authenticated,
  run-scoped finalization operation that validates the approved manifest and creates
  one local commit. The coding-agent child never receives broader host or `.git`
  authority.

This is one contract, not two competing finalizers. Botmancers decides *whether* a
reviewed result may be committed; Agent Deck performs *how* the commit is created on
the machine that owns the workspace. That boundary continues to work when Botmancers
and Agent Deck are on different machines.

## Why

Codex `workspace-write` can edit the working tree but cannot create `.git/index.lock`.
The restriction holds in both a linked worktree and a full clone, so moving from a
worktree to a clone does not solve finalization. Granting the child unrestricted host
Git access would defeat the sandbox. Having Botmancers execute Git directly would
couple the coordinator to a same-machine workspace and would fail when Agent Deck is
the remote execution host.

Agent Deck already owns the run, host `cwd`, process lifecycle, public run API, and
host audit boundary. Botmancers already owns work-request state, review policy, and
the decision to continue or accept the result. The split follows those existing
responsibilities.

## Contract

### Botmancers approval input

Before an edit run, Agent Deck captures the host-local Git baseline and Botmancers
records the returned public reference and digest:

- the run and attempt identifiers;
- the expected repository, workspace, branch/ref, and base commit;
- the opaque baseline reference and digest (Agent Deck privately retains the
  complete dirty-path status and content digests); and
- an idempotency key for the eventual finalization request.

After the edit run reaches a terminal prepared state, Agent Deck exposes an ordered
candidate manifest without file contents or host paths. Botmancers persists that
manifest as immutable attempt evidence and gives the exact artifact to the reviewer
and coordinator. After the reviewer accepts the result and the coordinator explicitly
authorizes finalization, Botmancers submits that same manifest:

```text
expectedBaseCommit
runId
reviewId
files[] = { repositoryRelativePath, sha256, mode }
commitMessage
```

The manifest is review evidence. Botmancers must not derive, recompute, or broaden it
after review acceptance; the browser and coordinator Agent do not supply replacement
paths or digests at finalization time.

### Agent Deck finalization behavior

The finalization operation must:

1. Require a separate finalization capability; ordinary MCP and run grants do not
   gain Git authority automatically.
2. Resolve the workspace from the referenced run. The caller cannot substitute an
   arbitrary `cwd`.
3. Require the current commit to equal `expectedBaseCommit` and fail on a ref race.
4. Reject absolute paths, `..`, `.git`, paths outside the worktree, submodule
   traversal, and symlink escape.
5. Compare the current workspace to the recorded pre-run baseline. A pre-existing
   dirty path must remain byte-for-byte unchanged, and every new run-produced change
   must appear in the approved manifest. Any unexpected path fails the whole request.
6. Recompute every approved file digest immediately before staging.
7. Require an initially clean Git index, stage only the manifest paths, then verify
   that the staged path set and staged blob digests exactly match the manifest.
8. Create one commit whose parent is `expectedBaseCommit`, and return the commit id,
   tree id, manifest digest, and finalization state.
9. Be idempotent: the same key and request returns the original result; the same key
   with a different request returns `409` without touching Git state.
10. Audit actor, run, repository identity, commit, outcome, reason code, file count,
    and manifest digest. Prompts, model results, credentials, and file contents do not
    enter the audit record.

### Failure and cancellation

Before commit creation, failure or cancellation removes only staging performed by
this operation and preserves working-tree files. A lock conflict, base mismatch,
digest mismatch, unexpected path, changed baseline path, or ref race fails closed.
No push, PR creation, reset, checkout, clean, or deletion is allowed.

After a commit is created, the operation is terminal and idempotent; cancellation
does not rewrite history. Push and PR creation remain separate authorized steps.

## PoC evidence

All timestamps below are UTC on October 14, 2026, corresponding to the October 13
local work session.

| Probe | Evidence | Result |
| --- | --- | --- |
| Linked worktree child run | Agent Deck run `run-20261014T003848-53b175`, Codex session `01a137d8-fcec-79c2-bac8-eb71998dbab9`, `edit` profile | File creation succeeded; staging failed at the parent repository's worktree `index.lock`. |
| Full-clone child run | Agent Deck run `run-20261014T004137-301b43`, Codex session `01a137db-8e53-7090-85cd-a4bd1df41cf6`, `edit` profile | File creation succeeded; staging failed at the clone's `.git/index.lock`. This rules out a linked-worktree-only cause. |
| Fresh full-clone child run | Agent Deck run `run-20261014T030009-1d474f`, Codex session `01a1385a-63be-7742-997d-ae78fc18f964`, `edit` profile | Created only `docs/not-485-agent-output.md`; `git diff --check` passed; staging failed at `.git/index.lock`; index remained empty. |
| Exact child artifact | `docs/not-485-agent-output.md` | SHA-256 `416e010458bf61f97fa2eef3ddce8f0a5860f1d904f3e275d77efe60107c92b1`. |
| Pre-existing dirty artifact | `unrelated-user-note.txt` | SHA-256 `73985619a4a96551cf8392831c6cd0ddcd4e41f74130c9657b089c5deea87560`; remained unchanged and untracked. |
| Stale manifest | Finalizer invoked first with a non-matching expected digest | Rejected before staging; index remained empty. |
| Host finalization | Base `3ad256625678b36694b42179f9d386ac295f246c` to disposable commit `435bf98dfa177914ce696223a4260b85526f74d4` | Commit contained exactly `docs/not-485-agent-output.md`; unrelated and Agent Deck binding files remained untracked. |
| Cancellation probe | A second approved-path fixture was staged and then canceled before commit | Only that path was unstaged; target and unrelated file digests were unchanged and both files remained recoverable. |

The disposable commits were not pushed and are not production artifacts.

## Rejected alternatives

### Let the child commit

Rejected. It requires a sandbox bypass or broader host authority solely to mutate Git
metadata. Both real repository layouts demonstrated the same fail-closed behavior.

### Botmancers runs Git directly

Rejected as the production contract. It works only while the coordinator and
workspace share a host, gives the control plane filesystem-specific machinery, and
does not survive the already anticipated Agent Deck/runner separation.

### Operator handoff for every commit

Rejected as the normal workflow. It is a safe emergency fallback, but it breaks the
goal of a conversational implementation-review-revision loop without routine manual
tool switching.

## Follow-up implementation tickets

Only two tickets are needed:

1. [**NOT-486 — Agent Deck run API: finalize a reviewed manifest into one local
   commit.**](https://linear.app/not-so-fat/issue/NOT-486/agent-deck-run-api-finalize-a-reviewed-manifest-into-one-local-commit)
   Add the run-scoped candidate-manifest read and the capability-gated, idempotent
   finalizer with audit, race, path, baseline, digest, index, cancellation, and
   recovery tests. Stop before push or PR creation.
2. [**NOT-487 — Botmancers: finalize an accepted reviewed attempt through Agent
   Deck.**](https://linear.app/not-so-fat/issue/NOT-487/botmancers-finalize-an-accepted-reviewed-attempt-through-agent-deck)
   Persist the pre-run baseline and Agent Deck candidate manifest, obtain explicit
   reviewer and coordinator acceptance, submit the unchanged manifest, project
   finalization state into the originating conversation, and prove one real
   developer/reviewer/finalizer loop. Stop before automatic push or PR creation.

The Agent Deck ticket must land first. The Botmancers ticket owns the cross-repository
acceptance smoke, so a third integration-only ticket is not required.

## Owner approval

The owner approved the policy/mechanism split and the two-ticket boundary on
October 13, 2026. The approval does not include sandbox bypass, arbitrary Git
commands, push, PR creation, or remote-runner implementation.
