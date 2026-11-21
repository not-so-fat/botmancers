#!/usr/bin/env node
// NOT-543: direct operator smoke. With Agent Deck stopped or uninstalled,
// proves at the exact HEAD that a user can register local coding Agents,
// Wake a fresh session, Wake an existing session, and complete a
// review/revision round — with no Agent Deck launch choice, endpoint, or
// fallback anywhere in the path.
//
//   node scripts/direct-smoke.js --workdir <disposable-git-repo> [--agent claude] [--reviewer codex] [--evidence <path>]
//
// The workdir guardrails (disposable marker, clean Git root, outside the
// repo/home/data) and evidence rules come from
// tests/support/acceptance/smoke-guard.js. BOTMANCERS_SMOKE_PROVIDER=fake
// (test-only) swaps the real CLIs for scripted in-process providers; the
// operator run uses the real installed, signed-in CLIs.
'use strict';

/* eslint-disable @typescript-eslint/no-require-imports -- standalone operator probe. */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const guard = require('../tests/support/acceptance/smoke-guard.js');
const harnessLib = require('../tests/support/acceptance/harness.js');

function usage() {
  return [
    'Usage: node scripts/direct-smoke.js --workdir <path> [--agent claude] [--reviewer codex] [--evidence <path>] [--timeout-ms <n>]',
    '',
    'Registers two local Agents, runs an implement -> review -> revise round through',
    'direct provider Sessions, and writes redacted JSON evidence. No Agent Deck is used.',
  ].join('\n');
}

function parseArgs(argv) {
  const args = { agent: 'claude', reviewer: 'codex', timeoutMs: 10 * 60 * 1000 };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--help' || flag === '-h') return { help: true };
    if (flag === '--workdir' || flag === '--agent' || flag === '--reviewer' || flag === '--evidence' || flag === '--timeout-ms') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new guard.GuardError('invalid_argument', `${flag} needs a value.`);
      i += 1;
      if (flag === '--workdir') args.workdir = value;
      else if (flag === '--agent') args.agent = value;
      else if (flag === '--reviewer') args.reviewer = value;
      else if (flag === '--evidence') args.evidence = value;
      else args.timeoutMs = Number(value);
    } else {
      throw new guard.GuardError('invalid_argument', `Unknown argument: ${flag}\n${usage()}`);
    }
  }
  return args;
}

const FAKE = process.env.BOTMANCERS_SMOKE_PROVIDER === 'fake';

function cliVersion(binary) {
  try {
    return execFileSync(binary, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim().slice(0, 200);
  } catch {
    return null;
  }
}

function gitHead(workdir) {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workdir, encoding: 'utf8' }).trim();
}

function gitStatus(workdir) {
  return execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: workdir, encoding: 'utf8' });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  for (const key of ['agent', 'reviewer']) {
    if (!['claude', 'codex', 'cursor', 'muse'].includes(args[key])) {
      throw new guard.GuardError('invalid_argument', `--${key} must be one of claude|codex|cursor|muse.`);
    }
  }
  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) {
    throw new guard.GuardError('invalid_argument', '--timeout-ms must be a positive number.');
  }
  const workdir = guard.validateDisposableWorkdir(args.workdir);
  const evidencePath = args.evidence
    ? guard.validateEvidencePath(args.evidence, { workdir, protectedPaths: harnessLib.productionPaths() })
    : null;

  const versions = { node: process.version };
  try {
    versions.botmancers = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  } catch {
    versions.botmancers = 'unknown';
  }
  versions[args.agent] = FAKE ? 'fake (BOTMANCERS_SMOKE_PROVIDER=fake)' : cliVersion(args.agent);
  versions[args.reviewer] = FAKE ? 'fake (BOTMANCERS_SMOKE_PROVIDER=fake)' : cliVersion(args.reviewer);
  if (!FAKE) {
    for (const key of [args.agent, args.reviewer]) {
      if (!versions[key]) {
        process.stderr.write(`SMOKE RESULT: REFUSED provider_unavailable: the ${key} CLI is not installed or not on PATH.\n`);
        return 2;
      }
    }
  }

  const headBefore = gitHead(workdir);
  const statusBefore = gitStatus(workdir);
  // The production paths as seen before the harness environment exists;
  // both snapshots cover this same list (the harness's own disposable
  // paths are supposed to change).
  const productionPaths = harnessLib.productionPaths();
  const productionBefore = harnessLib.snapshotProductionState(productionPaths);
  const harness = harnessLib.createHarness('direct-smoke');
  Object.assign(process.env, harness.env());

  // No non-loopback endpoint may be used; record every attempt.
  const blockedConnections = [];
  const net = require('net');
  const originalConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function patchedConnect(...connectArgs) {
    const options = (connectArgs[0] && typeof connectArgs[0] === 'object' ? connectArgs[0] : { port: connectArgs[0], host: connectArgs[1] }) || {};
    const host = String(options.host || options.hostname || 'localhost');
    if (host !== 'localhost' && host !== '127.0.0.1' && host !== '::1' && host !== '::ffff:127.0.0.1') {
      blockedConnections.push(`${host}:${options.port}`);
      throw new Error(`refused non-loopback connection to ${host}:${options.port}`);
    }
    return originalConnect.apply(this, connectArgs);
  };

  const { createJiti } = require('jiti');
  const jiti = createJiti(path.join(REPO_ROOT, 'scripts', 'direct-smoke.js'), { alias: { '@': REPO_ROOT } });
  const lib = name => jiti(path.join(REPO_ROOT, 'lib', name));
  const db = lib('db.ts');
  const { bots, messages, runtimeConnections, engine, UI_OWNER_PRINCIPAL } = db;
  const { routeAgentWakes, decideWakeGrant } = lib('wake-router.ts');
  const { acceptAgentMessage, startAgentDispatch, waitForAgentDispatchIdle } = lib('agent-conversations.ts');

  const adaptersUsed = [];
  let fakeStates = null;
  if (FAKE) {
    const fake = require('../tests/support/fake-session-provider.js');
    const { registerSessionProvider } = lib('session-provider.ts');
    fakeStates = {
      fake,
      registerSessionProvider,
      devState: path.join(harness.root, 'dev.provider.json'),
      revState: path.join(harness.root, 'rev.provider.json'),
    };
    // Call order per Agent: reviewer parents, review; dev implementation, revision.
    fake.mutateFakeProvider(fakeStates.revState, state => {
      state.results = ['Ready.', 'Review: the note is accurate.', 'Ready again.'];
    });
    fake.mutateFakeProvider(fakeStates.devState, state => {
      state.results = ['Dev done: wrote smoke-note.txt.', 'Revised: tightened the wording.'];
    });
    adaptersUsed.push('session-provider(fake)');
  }

  const evidence = {
    result: 'failed',
    smoke: 'direct',
    versions,
    head: versions.botmancers,
    agents: {},
    run: { requests: [] },
    workdir: { path: workdir, headBefore, statusBefore: statusBefore.trim() },
    agentDeck: {
      envPresent: Object.keys(process.env).filter(key => key.startsWith('AGENT_DECK')),
      adaptersUsed,
      nonLoopbackConnections: blockedConnections,
    },
    productionStateUnchanged: null,
  };

  const fail = message => {
    throw new Error(message);
  };

  try {
    const register = (name, provider, policy) => {
      const created = bots.create({
        name, title: `${name} (direct smoke)`, description: `${name} (direct smoke)`, agent: provider,
        runtime_connection_id: runtimeConnections.ensureLocal(provider),
        session_scope_kind: 'workspaces',
        session_scope_items: JSON.stringify([workdir]),
        default_workspace: workdir,
        policy_mode: policy,
        allow_new_sessions: 1,
        allow_resume_with_edits: policy === 'workspace_write' ? 1 : 0,
      });
      const bot = bots.getById(created.id);
      if (FAKE) {
        const statePath = policy === 'workspace_write' ? fakeStates.devState : fakeStates.revState;
        const connectionId = bot.runtime_connection_id;
        fakeStates.registerSessionProvider({ connectionId }, () => fakeStates.fake.createFakeSessionProvider({ statePath, kind: 'smoke' }));
      } else {
        adaptersUsed.push('session-provider');
      }
      return bot;
    };

    const dev = register('SmokeDev', args.agent, 'workspace_write');
    const reviewer = register('SmokeReviewer', args.reviewer, 'read_only');
    evidence.agents = {
      dev: { name: dev.name, agent: args.agent },
      reviewer: { name: reviewer.name, agent: args.reviewer },
    };

    const owner = { category: 'human_owner', principal: UI_OWNER_PRINCIPAL };

    async function settle(requestId, label) {
      const deadline = Date.now() + args.timeoutMs;
      for (;;) {
        const request = engine.getWorkRequest(requestId);
        if (request && (request.state === 'completed' || request.state === 'failed' || request.state === 'cancelled')) return request;
        if (Date.now() > deadline) fail(`${label} did not settle within ${args.timeoutMs}ms`);
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    }

    // One conversation turn for the requesting Agent, so the Wake it sends
    // has tracked lineage.
    async function parentTurn(agent, content, key) {
      const { accepted } = acceptAgentMessage(UI_OWNER_PRINCIPAL, { agentId: agent.id, content, idempotencyKey: key });
      await settle(accepted.requestId, `${agent.name} parent turn`);
      await waitForAgentDispatchIdle();
      return engine.getWorkRequest(accepted.requestId);
    }

    // Posts one wake block as the Agent's reply and routes it. The reply
    // goes in the parent turn's conversation: Wake lineage requires the
    // parent to have run by this Agent in this conversation.
    function sendWake(agent, parent, envelope, idempotencyNote) {
      const block = '```botmancers-wake\n' + JSON.stringify({ version: 1, ...envelope }, null, 2) + '\n```';
      const reply = messages.create(parent.source_conversation_id, 'bot', `${idempotencyNote}\n${block}`, agent.id);
      const [routed] = routeAgentWakes({ sourceEventId: reply.id, parentRequestId: parent.id });
      if (!routed) fail(`${agent.name} Wake was not routed`);
      return routed.wake;
    }

    // 1. Fresh implementation turn (waits for the owner edit grant).
    const implParent = await parentTurn(reviewer, 'Reply with the single word READY.', 'smoke-parent-1');
    if (implParent.state !== 'completed') fail(`reviewer parent turn did not complete (${implParent.state})`);
    const implWake = sendWake(reviewer, implParent, {
      target: dev.name,
      executionKind: 'implementation',
      objective: FAKE
        ? 'Write the smoke note.'
        : 'In your workspace, write exactly one line "smoke-note: direct launch works" to smoke-note.txt (create it), then reply with the single word DONE.',
    }, 'Dev, please implement the smoke note.');
    if (implWake.status !== 'blocked') fail(`implementation Wake did not wait for the owner grant (${implWake.status}/${implWake.reason_code})`);
    decideWakeGrant({ wakeId: implWake.id, decision: 'allow', caller: owner });
    await startAgentDispatch(implWake.work_request_id);
    const impl = await settle(implWake.work_request_id, 'implementation');
    if (impl.state !== 'completed') fail(`implementation did not complete (${impl.state}/${impl.error_code}: ${impl.error_message})`);

    // 2. Read-only review turn in a fresh reviewer session.
    const reviewWake = sendWake(dev, impl, {
      target: reviewer.name,
      executionKind: 'review',
      objective: FAKE
        ? 'Review the smoke note.'
        : 'Read smoke-note.txt in the implementation workspace and reply with one sentence saying whether it holds the expected line.',
      contextWorkRequests: [impl.id],
    }, 'Reviewer, please review the note.');
    if (reviewWake.status !== 'accepted') fail(`review Wake was not accepted (${reviewWake.status}/${reviewWake.reason_code})`);
    await startAgentDispatch(reviewWake.work_request_id);
    const review = await settle(reviewWake.work_request_id, 'review');
    if (review.state !== 'completed') fail(`review did not complete (${review.state}/${review.error_code}: ${review.error_message})`);

    // 3. Revision turn resuming the implementation session.
    const revisionWake = sendWake(reviewer, review, {
      target: dev.name,
      executionKind: 'revision',
      objective: FAKE
        ? 'Tighten the wording.'
        : 'Reply DONE if smoke-note.txt still holds the expected line, else rewrite it.',
      resumeWorkRequest: impl.id,
      contextWorkRequests: [review.id],
    }, 'Dev, please revise.');
    // Edit grants cover the (caller, target) pair, so the implementation's
    // Allow already admits this revision; a fresh pair would wait instead.
    if (revisionWake.status === 'blocked') {
      decideWakeGrant({ wakeId: revisionWake.id, decision: 'allow', caller: owner });
    } else if (revisionWake.status !== 'accepted') {
      fail(`revision Wake was neither granted nor waiting (${revisionWake.status}/${revisionWake.reason_code})`);
    }
    await startAgentDispatch(revisionWake.work_request_id);
    const revision = await settle(revisionWake.work_request_id, 'revision');
    if (revision.state !== 'completed') fail(`revision did not complete (${revision.state}/${revision.error_code}: ${revision.error_message})`);

    // Session continuity: the revision resumed the implementation session.
    const revisionAttempts = engine.listAttempts(revision.id);
    const binding = engine.getActiveSessionBinding({
      agentId: dev.id, adapter: args.agent,
      conversationId: impl.source_conversation_id, requestId: impl.id,
    });
    const sameSession = revisionAttempts.length === 1 && revisionAttempts[0].kind === 'resume' && !!binding
      && revisionAttempts[0].resumed_session_binding_id === binding.id;
    if (!sameSession) fail('the revision did not resume the implementation session');

    const threadOf = agent => messages.getByConversation(impl.source_conversation_id)
      .filter(entry => entry.sender_type === 'bot' && entry.sender_id === agent.id)
      .map(entry => entry.content);
    evidence.run.requests = [
      { kind: 'implementation', state: impl.state, attempts: engine.listAttempts(impl.id).length },
      { kind: 'review', state: review.state, attempts: engine.listAttempts(review.id).length },
      { kind: 'revision', state: revision.state, attempts: revisionAttempts.length },
    ];
    evidence.run.sameDevSession = sameSession;
    evidence.run.replyPreview = {
      implementation: (threadOf(dev).pop() ?? '').replace(/\s+/g, ' ').trim().slice(0, 160),
      review: (threadOf(reviewer).pop() ?? '').replace(/\s+/g, ' ').trim().slice(0, 160),
    };

    if (!FAKE) {
      const notePath = path.join(workdir, 'smoke-note.txt');
      if (!fs.existsSync(notePath)) fail('smoke-note.txt was not written');
      const note = fs.readFileSync(notePath, 'utf8');
      if (!note.includes('smoke-note: direct launch works')) fail(`smoke-note.txt is wrong: ${note.slice(0, 200)}`);
    }

    // Test-only: pretend the round dirtied the workdir, so the check below
    // can fail deterministically.
    if (FAKE && process.env.BOTMANCERS_SMOKE_MUTATE === '1') {
      fs.writeFileSync(path.join(workdir, 'mutated-by-test.txt'), 'x');
    }
    const statusAfter = gitStatus(workdir);
    const headAfter = gitHead(workdir);
    evidence.workdir.headAfter = headAfter;
    evidence.workdir.statusAfter = statusAfter.trim();
    evidence.workdir.unchangedExceptNote = headAfter === headBefore
      && (FAKE ? statusAfter.trim() === '' : statusAfter.trim() === '?? smoke-note.txt');
    if (!evidence.workdir.unchangedExceptNote) fail(`the workdir changed beyond smoke-note.txt: ${statusAfter.slice(0, 500)}`);
    evidence.productionStateUnchanged = harnessLib.diffSnapshots(productionBefore, harnessLib.snapshotProductionState(productionPaths)).length === 0;
    if (!evidence.productionStateUnchanged) fail('production state changed');
    if (blockedConnections.length > 0) fail(`non-loopback connections were attempted: ${blockedConnections.join(', ')}`);

    evidence.result = 'passed';
    harness.finish(true);
    const text = JSON.stringify(guard.redact(evidence, guard.secretValues(process.env)), null, 2);
    if (evidencePath) fs.writeFileSync(evidencePath, `${text}\n`);
    process.stdout.write(`SMOKE RESULT: PASS\n${text}\n`);
    return 0;
  } catch (error) {
    const kept = harness.finish(false, error && error.stack || String(error));
    const text = JSON.stringify(guard.redact({ ...evidence, error: error.message }, guard.secretValues(process.env)), null, 2);
    if (evidencePath) {
      try { fs.writeFileSync(evidencePath, `${text}\n`); } catch { /* evidence write is best-effort on failure */ }
    }
    process.stdout.write(`SMOKE RESULT: FAIL ${error.message}\n`);
    process.stdout.write(`harness root preserved: ${kept}\n`);
    return 1;
  }
}

main().then(code => process.exit(code), error => {
  if (error instanceof guard.GuardError) {
    process.stderr.write(`SMOKE RESULT: REFUSED ${error.code}: ${error.message}\n`);
    process.exit(2);
    return;
  }
  console.error(error && error.stack || error);
  process.exit(1);
});
