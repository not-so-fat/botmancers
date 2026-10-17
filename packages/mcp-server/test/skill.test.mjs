// The packaged botmancers-collaboration skill (NOT-501): the validator and
// source-link checks against the packed artifact, the static contract-name
// and secret-pattern assertions (with negative controls proving each check
// fires), and the deterministic tool-selection fixtures: SKILL.md's decision
// table and procedure, executed against simulated MCP results, produce the
// exact ordered tool calls and safe arguments for Codex-to-Grok and
// Grok-to-Codex scenarios, never take an id from the user, and never pass
// Deck/runtime authority.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SKILL_DIR, TOOLS, checkArgs, checkSkill, extractSkill } from '../scripts/check-skill.mjs';
import { PACKAGE_DIR } from '../scripts/product-harness.mjs';

const skillText = readFileSync(join(SKILL_DIR, 'SKILL.md'), 'utf8');
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/skill-routing.json', import.meta.url), 'utf8'));

test('the skill in this checkout passes the validator', () => {
  const result = checkSkill();
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.files, ['SKILL.md', 'references/workflows.md']);
});

test('the packed npm artifact ships the same skill, and it passes the validator', t => {
  const out = mkdtempSync(join(tmpdir(), 'botmancers-skill-pack-'));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', out], { cwd: PACKAGE_DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }))[0];
  const shipped = packed.files.map(file => file.path).filter(path => path.startsWith('skills/')).sort();
  assert.deepEqual(shipped, ['skills/botmancers-collaboration/SKILL.md', 'skills/botmancers-collaboration/references/workflows.md']);
  const { dir, cleanup } = extractSkill(join(out, packed.filename));
  t.after(cleanup);
  assert.deepEqual(checkSkill(dir).problems, []);
  for (const rel of ['SKILL.md', 'references/workflows.md']) assert.equal(readFileSync(join(dir, rel), 'utf8'), readFileSync(join(SKILL_DIR, rel), 'utf8'), rel);
});

test('every skill file names only botmancers.mcp.v2 tools and passes only schema fields', () => {
  const { used } = checkSkill();
  for (const name of used) assert.ok(TOOLS.has(name), name);
  // The whole workflow is covered: v1 fresh task plus every v2 tool.
  assert.deepEqual(used, [...TOOLS.keys()].sort());
  // Every example in the references was actually parsed and validated.
  const refs = readFileSync(join(SKILL_DIR, 'references/workflows.md'), 'utf8');
  const examples = [...refs.matchAll(/`(botmancers_[a-z_]+) (\{.*?\})`/g)];
  assert.ok(examples.length >= 12, `found ${examples.length} argument examples`);
  for (const [, tool, json] of examples) {
    const problems = [];
    checkArgs(tool, JSON.parse(json), 'workflows.md', problems);
    assert.deepEqual(problems, [], `${tool} ${json}`);
  }
});

test('negative controls: the validator rejects each kind of defect', t => {
  const cases = [
    ['unknown tool', 'references/workflows.md', '\nCall `botmancers_grant_access {}`.\n', /botmancers_grant_access is not a botmancers\.mcp\.v2 tool/],
    ['authority field', 'references/workflows.md', '\n`botmancers_send_to_session { "session_ref": "<ref>", "deck_id": "<deck>" }`\n', /Botmancers-owned field deck_id/],
    ['undefined field', 'references/workflows.md', '\n`botmancers_create_exchange { "mode": "ask", "source": { "session_ref": "<ref>", "provider": "x" } }`\n', /passes source\.provider/],
    ['MCP token', 'SKILL.md', `\nbmmcp_${'a'.repeat(64)}\n`, /generated botmancers token|Botmancers token prefix/],
    ['digest', 'references/workflows.md', `\nsha256:${'b'.repeat(64)}\n`, /service token digest/],
    ['user id', 'references/workflows.md', '\nsession 3f2b8c1e-1d2a-4c3b-9e8f-0123456789ab\n', /UUID/],
    ['provider id', 'references/workflows.md', '\nresume prov-relay-SECRET-session\n', /provider session-like id/],
    ['grants document', 'references/workflows.md', '\n{ "version": 1, "grants": [] }\n', /service-grants document/],
    ['bearer', 'references/workflows.md', '\nAuthorization: Bearer abcdefgh12345678\n', /bearer credential/],
    ['home path', 'SKILL.md', '\nSee /Users/someone/.codex\n', /machine-specific home path/],
    ['broken link', 'SKILL.md', '\n[x](references/missing.md)\n', /does not resolve/],
    ['broken anchor', 'SKILL.md', '\n[x](references/workflows.md#nowhere)\n', /anchor #nowhere not found/],
    ['external link', 'SKILL.md', '\n[x](https://example.com)\n', /external link/],
  ];
  for (const [label, file, addition, expected] of cases) {
    const dir = join(mkdtempSync(join(tmpdir(), 'botmancers-skill-neg-')), 'botmancers-collaboration');
    t.after(() => rmSync(join(dir, '..'), { recursive: true, force: true }));
    cpSync(SKILL_DIR, dir, { recursive: true });
    appendFileSync(join(dir, file), addition);
    const { problems } = checkSkill(dir);
    assert.ok(problems.some(problem => expected.test(problem)), `${label}: ${JSON.stringify(problems)}`);
  }
  // Structural defects.
  const structural = [
    ['long SKILL.md', dir => appendFileSync(join(dir, 'SKILL.md'), '\nmore\n'.repeat(80)), /keep it under/],
    ['missing topic', dir => writeFileSync(join(dir, 'references/workflows.md'), readFileSync(join(dir, 'references/workflows.md'), 'utf8').replace('## Cancellation', '## Stopping').replace('(#cancellation)', '(#stopping)')), /do not cover "cancellation"/],
    ['unlinked reference', dir => writeFileSync(join(dir, 'references/extra.md'), '# Extra\n'), /extra\.md is not linked directly/],
    ['bad name', dir => writeFileSync(join(dir, 'SKILL.md'), skillText.replace('name: botmancers-collaboration', 'name: Botmancers_Collab')), /must be 1-64 lower-case/],
    ['no trigger', dir => writeFileSync(join(dir, 'SKILL.md'), skillText.replace(' Use when', ' Handy when')), /Use when/],
    ['no authority statement', dir => writeFileSync(join(dir, 'SKILL.md'), skillText.replace('is the authority for', 'helps with')), /authority for live data/],
  ];
  for (const [label, mutate, expected] of structural) {
    const dir = join(mkdtempSync(join(tmpdir(), 'botmancers-skill-neg-')), 'botmancers-collaboration');
    t.after(() => rmSync(join(dir, '..'), { recursive: true, force: true }));
    cpSync(SKILL_DIR, dir, { recursive: true });
    mutate(dir);
    const { problems } = checkSkill(dir);
    assert.ok(problems.some(problem => expected.test(problem)), `${label}: ${JSON.stringify(problems)}`);
  }
});

// ---------------------------------------------------------------------
// Deterministic tool selection

// SKILL.md "Choose one action": action -> the tools its row names.
function decisionTable() {
  const section = skillText.split('## 2. Choose one action')[1].split('\n## ')[0];
  const rows = section.split('\n').filter(line => /^\| [^-]/.test(line)).slice(1);
  const table = new Map();
  for (const row of rows) {
    const [, , action, tools] = row.split('|').map(cell => cell.trim());
    table.set(action.replace(/`/g, ''), [...tools.matchAll(/`(botmancers_[a-z_]+)`/g)].map(match => match[1]));
  }
  return table;
}

const CAPABILITY = {
  botmancers_list_agents: 'agents:read', botmancers_list_sessions: 'sessions:read', botmancers_list_conversations: 'conversations:read',
  botmancers_send_to_session: 'sessions:message', botmancers_create_exchange: 'exchanges:create',
  botmancers_get_exchange: 'exchanges:read', botmancers_list_exchanges: 'exchanges:read',
};
const ALL = ['agents:read', 'sessions:read', 'conversations:read', 'sessions:message', 'exchanges:read', 'exchanges:create'];
const RETRYABLE = new Set(['source_session_busy', 'agent_unavailable', 'rate_limited', 'internal_error', 'conflict']);

// Simulated MCP: results built from the fixture's Agents and sessions.
function simulator(scenario) {
  const byName = name => fixtures.agents.find(agent => agent.name === name);
  const grants = scenario.grants ?? Object.fromEntries(fixtures.agents.map(agent => [agent.name, ALL]));
  const errors = structuredClone(scenario.errors ?? {});
  const exchangeStates = [...(scenario.exchange ?? [])];
  const requestStates = [...(scenario.request ?? [])];
  const calls = [];
  const call = (tool, args) => {
    assert.ok(TOOLS.has(tool), `unknown tool ${tool}`);
    calls.push([tool, structuredClone(args)]);
    const code = errors[tool]?.shift();
    if (code) return { error: { code, retryable: RETRYABLE.has(code) } };
    switch (tool) {
      case 'botmancers_capabilities':
        return {
          mode: scenario.mode ?? 'granted',
          agents: scenario.mode === 'narrow' ? [] : fixtures.agents.map(agent => ({ agent_id: agent.agent_id, capabilities: grants[agent.name] ?? [] })),
          operations: scenario.mode === 'narrow' ? [] : Object.entries(CAPABILITY).map(([name, capability]) => ({
            tool: name, capability, agent_ids: fixtures.agents.filter(agent => (grants[agent.name] ?? []).includes(capability)).map(agent => agent.agent_id),
          })),
          polling: { initial_seconds: 2, max_seconds: 30 },
        };
      case 'botmancers_health': return { status: 'ok', coordinators: fixtures.agents.map(agent => ({ name: agent.name, available: true })) };
      case 'botmancers_list_agents': return { items: fixtures.agents, next_cursor: null };
      case 'botmancers_list_sessions': return { items: fixtures.sessions[args.agent_id], next_cursor: null };
      case 'botmancers_start_task': return { request_id: 'req-fixture-1', conversation_id: 'conv-fixture-1', replayed: false };
      case 'botmancers_get_request': {
        const status = requestStates.shift();
        return { request_id: args.request_id, status, terminal: ['succeeded', 'failed', 'cancelled'].includes(status), result: status === 'succeeded' ? 'done' : null };
      }
      case 'botmancers_get_conversation': return { messages: [], status: 'idle', content_trust: 'untrusted' };
      case 'botmancers_send_to_session': return { exchange_id: 'xch-fixture-1', conversation_id: 'conv-fixture-2', replayed: false };
      case 'botmancers_create_exchange': return { exchange: { id: 'xch-fixture-1', state: 'queued' }, terminal: false, replayed: false };
      case 'botmancers_get_exchange': {
        const state = exchangeStates.shift();
        const terminal = ['completed', 'failed', 'cancelled'].includes(state);
        return {
          terminal,
          content_trust: 'untrusted',
          exchange: {
            id: args.exchange_id, state,
            answer: state === 'completed' ? { content: scenario.answer ?? 'An answer.' } : null,
            failure: state === 'failed' ? scenario.failure : null,
            cancel: state === 'cancelled' ? { reason: null } : null,
          },
        };
      }
      default: throw new Error(`fixture does not simulate ${tool}`);
    }
  };
  return { call, calls, byName };
}

// SKILL.md's procedure, step by step. Returns the outcome; the simulator
// records the calls. Returned content is never read for instructions.
function runSkill(scenario) {
  const sim = simulator(scenario);
  const { facts } = scenario;
  const waits = [];
  const table = decisionTable();
  const key = `${scenario.name}-1`;
  const result = { calls: sim.calls, waits, ask_user: null, outcome: null, provenance: null };

  // Step 3: poll with 2 s doubling to 30 s, bounded.
  const poll = (tool, args) => {
    let wait = 2;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      waits.push(wait);
      const view = sim.call(tool, args);
      if (view.error) return view;
      if (view.terminal) return view;
      wait = Math.min(wait * 2, 30);
    }
    return { timeout: true };
  };
  // Step 5: retry only a retryable error, at most twice, with the same key.
  const act = (tool, args) => {
    let response = sim.call(tool, args);
    for (let retry = 0; retry < 2 && response.error?.retryable; retry += 1) response = sim.call(tool, args);
    return response;
  };

  // Step 1: discover.
  const caps = sim.call('botmancers_capabilities', {});
  const allowed = (tool, agentIds) => caps.operations.some(op => op.tool === tool && agentIds.every(id => op.agent_ids.includes(id)));

  if (facts.wants === 'fresh') {
    const action = table.get('Fresh task');
    const health = sim.call(action[0], {});
    const coordinator = health.coordinators.find(entry => entry.name === facts.coordinator && entry.available);
    const started = act(action[1], { coordinator: coordinator.name, objective: facts.text, idempotency_key: key });
    if (started.error) return { ...result, outcome: `error:${started.error.code}` };
    const done = poll(action[2], { request_id: started.request_id });
    sim.call(action[3], { conversation_id: started.conversation_id });
    result.provenance = { coordinator: coordinator.name, request_id: started.request_id, conversation_id: started.conversation_id };
    return { ...result, outcome: done.status === 'succeeded' ? 'completed' : done.status };
  }

  if (!allowed('botmancers_list_agents', [])) return { ...result, outcome: 'grant_missing:botmancers_list_agents' };
  const agents = sim.call('botmancers_list_agents', {}).items;
  const owner = agents.find(agent => agent.name === facts.session_agent);
  const sessions = sim.call('botmancers_list_sessions', { agent_id: owner.agent_id, status: 'active' }).items;
  const hint = facts.session_hint.toLowerCase();
  const matches = sessions.filter(session => session.title.toLowerCase().includes(hint));
  if (matches.length !== 1) return { ...result, outcome: 'choose_session', ask_user: matches.map(session => session.title) };
  const session = matches[0];

  // Step 2: the first row that fits.
  let tool;
  let args;
  let involved = [owner.agent_id];
  let action;
  if (facts.wants === 'follow_up') {
    action = 'Same-session message';
    [tool] = table.get(action);
    args = { session_ref: session.ref, content: facts.text, idempotency_key: key };
  } else if (facts.wants === 'answer') {
    action = 'Ask';
    [tool] = table.get(action);
    args = { mode: 'ask', source: { session_ref: session.ref }, instruction: facts.text, idempotency_key: key };
  } else {
    action = 'Continue';
    [tool] = table.get(action);
    const destination = agents.find(agent => agent.name === facts.to_agent);
    involved = [owner.agent_id, destination.agent_id];
    args = { mode: 'continue', source: { session_ref: session.ref }, destination: { agent_id: destination.agent_id }, instruction: facts.text, idempotency_key: key };
  }
  if (!allowed(tool, involved)) return { ...result, outcome: `grant_missing:${tool}` };
  const acted = act(tool, args);
  if (acted.error) {
    if (['session_ended', 'session_not_resumable'].includes(acted.error.code)) {
      const active = sim.call('botmancers_list_sessions', { agent_id: owner.agent_id, status: 'active' }).items;
      return { ...result, outcome: `error:${acted.error.code}`, ask_user: active.map(item => item.title) };
    }
    return { ...result, outcome: `error:${acted.error.code}` };
  }
  const exchangeId = acted.exchange_id ?? acted.exchange.id;
  const done = poll(table.get(action).at(-1), { exchange_id: exchangeId });
  result.provenance = { agent: owner.name, session: session.title, session_ref: session.ref, exchange_id: exchangeId, state: done.exchange?.state };
  if (done.timeout) return { ...result, outcome: 'timeout' };
  const state = done.exchange.state;
  return { ...result, outcome: state === 'failed' ? `failed:${done.exchange.failure.code}` : state, reported: done.exchange.answer?.content ?? null };
}

const ID_FIELDS = new Set(['id', 'agent_id', 'session_ref', 'exchange_id', 'request_id', 'conversation_id']);
function idsIn(value, out = []) {
  if (value && typeof value === 'object') for (const [key, inner] of Object.entries(value)) {
    if (ID_FIELDS.has(key) && typeof inner === 'string') out.push(inner);
    else idsIn(inner, out);
  }
  return out;
}

test('the decision table in SKILL.md names a tool sequence for each action', () => {
  const table = decisionTable();
  assert.deepEqual([...table.keys()], ['Fresh task', 'Same-session message', 'Ask', 'Continue']);
  assert.deepEqual(table.get('Same-session message'), ['botmancers_send_to_session', 'botmancers_get_exchange']);
  assert.deepEqual(table.get('Ask'), ['botmancers_create_exchange', 'botmancers_get_exchange']);
  assert.deepEqual(table.get('Continue'), ['botmancers_create_exchange', 'botmancers_get_exchange']);
  assert.deepEqual(table.get('Fresh task'), ['botmancers_health', 'botmancers_start_task', 'botmancers_get_request', 'botmancers_get_conversation']);
});

test('fixtures cover both directions and every action and recovery', () => {
  const names = fixtures.scenarios.map(scenario => scenario.name);
  for (const direction of ['codex-to-grok', 'grok-to-codex']) {
    for (const wants of ['fresh', 'follow_up', 'answer', 'handoff']) {
      assert.ok(fixtures.scenarios.some(scenario => scenario.name.startsWith(direction) && scenario.facts.wants === wants && scenario.expected.outcome === 'completed'), `${direction} ${wants}`);
    }
  }
  for (const outcome of ['choose_session', 'error:session_ended', 'grant_missing:botmancers_create_exchange', 'error:grant_required', 'failed:packet_invalid', 'cancelled', 'error:source_session_busy']) {
    assert.ok(fixtures.scenarios.some(scenario => scenario.expected.outcome === outcome), outcome);
  }
  assert.equal(new Set(names).size, names.length);
});

for (const scenario of fixtures.scenarios) {
  test(`routing: ${scenario.name}`, () => {
    const run = runSkill(scenario);
    assert.deepEqual(run.calls, scenario.expected.calls, 'ordered tool names and arguments');
    assert.equal(run.outcome, scenario.expected.outcome);
    if (scenario.expected.ask_user) assert.deepEqual(run.ask_user, scenario.expected.ask_user);
    if (scenario.expected.waits) assert.deepEqual(run.waits, scenario.expected.waits);
    assert.ok(run.waits.every(wait => wait >= 2 && wait <= 30), 'bounded backoff');

    // Safe arguments: only schema fields, no Botmancers-owned authority.
    for (const [tool, args] of run.calls) {
      const problems = [];
      checkArgs(tool, args, scenario.name, problems);
      assert.deepEqual(problems, [], `${tool} ${JSON.stringify(args)}`);
      for (const field of ['coordinator', 'objective', 'idempotency_key', 'mode', 'source', 'destination', 'instruction', 'content', 'session_ref', 'agent_id', 'status', 'exchange_id', 'request_id', 'conversation_id']) {
        if (field in args) assert.ok(field in TOOLS.get(tool).inputSchema.properties, `${tool} ${field}`);
      }
    }
    // No raw ids from the user: every id argument came from an earlier result.
    const seen = new Set();
    const sim = simulator(scenario);
    for (const [tool, args] of run.calls) {
      for (const id of idsIn(args)) {
        assert.ok(seen.has(id), `${tool} used ${id} before any tool returned it`);
        assert.ok(!scenario.prompt.includes(id), `the prompt carried ${id}`);
      }
      for (const id of idsIn(sim.call(tool, args))) seen.add(id);
      if (tool === 'botmancers_list_agents') for (const agent of fixtures.agents) seen.add(agent.agent_id);
      if (tool === 'botmancers_list_sessions') for (const item of fixtures.sessions[args.agent_id]) seen.add(item.ref);
    }
    // Asking the user is by recognizable title, never by id.
    for (const title of run.ask_user ?? []) assert.ok(!/sref-|agent-|xch-/.test(title));
    // Provenance uses Botmancers labels.
    if (run.provenance && run.outcome === 'completed' && scenario.facts.wants !== 'fresh') {
      assert.ok(run.provenance.agent && run.provenance.session && run.provenance.exchange_id);
    }
    // Untrusted content changes nothing: no further calls after the answer.
    if (scenario.answer) assert.equal(run.calls.at(-1)[0], 'botmancers_get_exchange');
  });
}

test('routing fixtures name only tools the skill documents', () => {
  const documented = new Set(readdirSync(SKILL_DIR, { recursive: true }).filter(rel => rel.endsWith('.md')).flatMap(rel => [...readFileSync(join(SKILL_DIR, rel), 'utf8').matchAll(/botmancers_[a-z_]+/g)].map(match => match[0])));
  for (const scenario of fixtures.scenarios) for (const [tool] of scenario.expected.calls) assert.ok(documented.has(tool), tool);
});
