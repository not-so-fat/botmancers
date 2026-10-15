#!/usr/bin/env node
// NOT-476: opt-in smoke of the canonical engine against a REAL Agent Deck
// server (docs/acceptance-harness.md). Never part of the default suite.
//
//   AGENT_DECK_RUN_TOKEN=... npm run smoke:agent-deck -- \
//     --workdir /tmp/my-disposable-repo --deck <deck id> [--agent codex] \
//     [--server http://127.0.0.1:1111] [--prompt "..."]
//
// Refuses to run (exit 2) unless --workdir names an explicit disposable
// Git repository (test-support/acceptance/real-deck-guard.js) and a token
// and deck are given. Botmancers state (database, data root, HOME) lives in
// a disposable harness root as in the default suite; only the Agent Deck
// server and the given workdir are real. One read-only conversation turn
// runs; the evidence (versions, Work Request / Attempt / run ids, outcome)
// is redacted and written to a JSON file whose path is printed.
'use strict';

/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS script run by Node directly. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const harnessLib = require('../test-support/acceptance/harness.js');
const guard = require('../test-support/acceptance/real-deck-guard.js');

const AGENTS = ['codex', 'claude', 'cursor'];
const DEFAULT_SERVER = 'http://127.0.0.1:1111';
const DEFAULT_PROMPT = 'Reply with one short sentence naming the top-level files in this repository. Do not change anything.';

if (process.env.BOTMANCERS_SMOKE_CHILD === '1') {
  runChild().then(() => process.exit(0), error => {
    console.error(error && error.stack || error);
    process.exit(1);
  });
} else {
  main(process.argv.slice(2)).then(code => process.exit(code), error => {
    console.error(guard.redactText(String(error && error.stack || error), guard.secretValues()));
    process.exit(1);
  });
}

function parseArgs(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 1) {
    const match = /^--(workdir|deck|agent|server|prompt|evidence)(?:=(.*))?$/.exec(args[i]);
    if (!match) throw new guard.GuardError('invalid_argument', `Unknown argument ${args[i]}.`);
    options[match[1]] = match[2] !== undefined ? match[2] : args[++i];
  }
  return options;
}

function refuse(error) {
  console.error(`agent-deck smoke refused (${error.code}): ${error.message}`);
  return 2;
}

function gitState(dir) {
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  return { head: git('rev-parse', 'HEAD'), status: git('status', '--porcelain', '--untracked-files=all') };
}

async function main(args) {
  let options;
  let workdir;
  try {
    options = parseArgs(args);
    workdir = guard.validateDisposableWorkdir(options.workdir);
    if (!process.env.AGENT_DECK_RUN_TOKEN || !process.env.AGENT_DECK_RUN_TOKEN.trim()) {
      throw new guard.GuardError('token_missing', 'AGENT_DECK_RUN_TOKEN is not set; the smoke needs a real Agent Deck run grant.');
    }
    if (!options.deck) throw new guard.GuardError('deck_missing', 'An Agent Deck deck id is required (--deck <id>).');
    if (options.agent && !AGENTS.includes(options.agent)) throw new guard.GuardError('invalid_argument', `--agent must be one of ${AGENTS.join(', ')}.`);
    const server = new URL(options.server || DEFAULT_SERVER);
    if (server.protocol !== 'http:' && server.protocol !== 'https:') throw new guard.GuardError('invalid_argument', '--server must be an http(s) URL.');
  } catch (error) {
    if (error instanceof guard.GuardError) return refuse(error);
    if (error instanceof TypeError) return refuse(new guard.GuardError('invalid_argument', '--server must be an http(s) URL.'));
    throw error;
  }

  const token = process.env.AGENT_DECK_RUN_TOKEN.trim();
  const secrets = guard.secretValues(process.env, [token]);
  const server = (options.server || DEFAULT_SERVER).replace(/\/+$/, '');
  const before = harnessLib.snapshotProductionState();
  const workdirBefore = gitState(workdir);
  const harness = harnessLib.createHarness('agent-deck-smoke');
  const run = await new Promise(resolve => {
    const child = spawn(process.execPath, [__filename], {
      cwd: harness.root,
      env: harness.env({
        BOTMANCERS_SMOKE_CHILD: '1',
        BOTMANCERS_ACCEPTANCE_WORKSPACE: workdir,
        AGENT_DECK_RUN_TOKEN: token,
        BOTMANCERS_SMOKE_SERVER: server,
        BOTMANCERS_SMOKE_DECK: options.deck,
        BOTMANCERS_SMOKE_AGENT: options.agent || 'codex',
        BOTMANCERS_SMOKE_PROMPT: options.prompt || DEFAULT_PROMPT,
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { err += chunk; });
    child.on('exit', code => resolve({ code, out, err }));
  });

  const line = run.out.split('\n').find(entry => entry.startsWith('SMOKE_EVIDENCE '));
  const childEvidence = line ? JSON.parse(line.slice('SMOKE_EVIDENCE '.length)) : null;
  const workdirAfter = gitState(workdir);
  const changes = harnessLib.diffSnapshots(before, harnessLib.snapshotProductionState());
  const ok = run.code === 0 && !!childEvidence && childEvidence.request.state === 'completed' && changes.length === 0;
  const evidence = guard.redact({
    smoke: 'botmancers-agent-deck-smoke/v1',
    result: ok ? 'passed' : 'failed',
    finishedAt: new Date().toISOString(),
    versions: {
      node: process.version,
      botmancers: require('../package.json').version,
      botmancersCommit: (() => { try { return gitState(harnessLib.REPO_ROOT).head; } catch { return null; } })(),
      agentDeck: childEvidence ? childEvidence.agentDeckVersion : null,
    },
    server,
    deck: options.deck,
    agent: options.agent || 'codex',
    workdir: { path: workdir, headBefore: workdirBefore.head, headAfter: workdirAfter.head, cleanAfter: workdirAfter.status === '' },
    run: childEvidence,
    productionStateUnchanged: changes.length === 0,
    exitCode: run.code,
    stderrTail: run.err ? run.err.slice(-2000) : '',
  }, secrets);
  const evidencePath = options.evidence
    ? path.resolve(options.evidence)
    : path.join(os.tmpdir(), `botmancers-agent-deck-smoke-${Date.now()}.json`);
  fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
  const preserved = harness.finish(ok, ok ? '' : JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
  console.log(`\nevidence (redacted): ${evidencePath}`);
  if (preserved) console.log(`harness root preserved: ${preserved}`);
  console.log(`\nSMOKE RESULT: ${ok ? 'PASS' : 'FAIL'}`);
  return ok ? 0 : 1;
}

// The smoke turn, inside the harness root, against the real server.
async function runChild() {
  const { createContext } = require('../test-support/acceptance/engine-context.js');
  const server = new URL(process.env.BOTMANCERS_SMOKE_SERVER);
  const ctx = createContext('agent-deck-smoke', { remoteDeck: true, realToken: true, allowHosts: [server.hostname] });
  ctx.lib('agent-deck-settings.ts').setAgentDeckServerUrl(process.env.BOTMANCERS_SMOKE_SERVER);
  const agent = ctx.agent('Smoke', process.env.BOTMANCERS_SMOKE_AGENT, { deck_id: process.env.BOTMANCERS_SMOKE_DECK });
  const accepted = await ctx.ask(agent, process.env.BOTMANCERS_SMOKE_PROMPT, `smoke-${Date.now()}`);
  const request = ctx.engine.getWorkRequest(accepted.requestId);
  const attempts = ctx.attemptsOf(request.id);
  const reply = ctx.messagesIn(accepted.conversationId).find(m => m.request_id === request.id && m.sender_type === 'bot');
  let agentDeckVersion = null;
  try {
    const response = await fetch(`${process.env.BOTMANCERS_SMOKE_SERVER}/api/health`);
    const body = await response.json().catch(() => null);
    agentDeckVersion = body && (body.version || (body.data && body.data.version)) || null;
  } catch { /* version unknown */ }
  const evidence = {
    agentDeckVersion,
    request: { id: request.id, state: request.state, executionKind: request.execution_kind, toolProfile: request.tool_profile, errorCode: request.error_code },
    attempts: attempts.map(a => ({ id: a.id, outcome: a.outcome, externalRunId: a.external_run_id, externalSessionId: a.external_session_id, errorCategory: a.error_category })),
    projection: ctx.projectedKinds(accepted.conversationId),
    replyPreview: reply ? reply.content.slice(0, 500) : null,
    blockedConnections: ctx.guards.blockedConnections,
  };
  process.stdout.write(`SMOKE_EVIDENCE ${JSON.stringify(evidence)}\n`);
}
