// Live routing eval for the botmancers-collaboration skill (NOT-501): a real
// MCP client, given only the user's prompt, must discover and invoke the
// installed skill on its own and choose the intended workflow.
//
// For each scenario in test/fixtures/skill-routing.json:
//   1. an isolated HOME with ~/.claude, and `botmancers setup --client claude`
//      from a package tree built from this checkout: it writes the skill to
//      ~/.claude/skills and the "botmancers" MCP entry to ~/.claude.json;
//   2. a stub botmancers.mcp.v2 server on the port that entry points at. It
//      requires the bearer token setup wrote, serves the packaged tool list,
//      and answers from scripts/skill-sim.mjs, recording every call;
//   3. `claude -p "<the scenario prompt>"` in a scratch project that holds the
//      installed skill directory (copied byte for byte from where setup put
//      it, so the client keeps the user's own login) and only the installed
//      MCP entry (--strict-mcp-config), with no built-in tools but Skill;
//   4. grade(): the Skill tool loaded botmancers-collaboration before any
//      action, capabilities came first, the action tool and its routing
//      arguments match the fixture, every id came from an earlier result,
//      no Botmancers-owned field was passed, polling and retries are
//      bounded, and the reply names its provenance without asking for ids.
//
//   node scripts/eval-skill-routing.mjs [--only a,b] [--jobs 3] [--out FILE]
//
// Needs an authenticated `claude` CLI and network; it is not part of
// `npm test`. The grader itself is unit-tested offline in test/skill.test.mjs.
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkArgs } from './check-skill.mjs';
import { makePackage } from './managed-harness.mjs';
import { makeSimulator } from './skill-sim.mjs';

const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const SKILL = 'botmancers-collaboration';
const TOOLS = JSON.parse(readFileSync(join(PACKAGE_DIR, 'schemas/botmancers.mcp.v2.tools.json'), 'utf8')).tools;
export const FIXTURES = JSON.parse(readFileSync(join(PACKAGE_DIR, 'test/fixtures/skill-routing.json'), 'utf8'));
const ACTIONS = new Set(['botmancers_start_task', 'botmancers_send_to_session', 'botmancers_create_exchange']);
const POLLS = new Set(['botmancers_get_exchange', 'botmancers_get_request']);
const MCP_PREFIX = 'mcp__botmancers__';

// ---------------------------------------------------------------------
// Grading: pure, so the offline tests can feed it canned transcripts.

const ID_FIELDS = new Set(['id', 'agent_id', 'ref', 'session_ref', 'exchange_id', 'request_id', 'conversation_id']);
function idsIn(value, out = []) {
  if (value && typeof value === 'object') for (const [key, inner] of Object.entries(value)) {
    if (ID_FIELDS.has(key) && typeof inner === 'string') out.push(inner);
    else idsIn(inner, out);
  }
  return out;
}

// The routing arguments that decide the workflow; free text is the model's.
export function routing(tool, args = {}) {
  if (tool === 'botmancers_start_task') return { coordinator: args.coordinator };
  if (tool === 'botmancers_send_to_session') return { session_ref: args.session_ref };
  if (tool === 'botmancers_create_exchange') {
    const out = { mode: args.mode, source: { session_ref: args.source?.session_ref } };
    if (args.destination !== undefined) out.destination = { agent_id: args.destination?.agent_id };
    return out;
  }
  return {};
}

export function expectedAction(scenario) {
  const found = scenario.expected.calls.find(([tool]) => ACTIONS.has(tool));
  return found ? { tool: found[0], routing: routing(found[0], found[1]) } : null;
}

// transcript: ordered tool_use blocks from the client ({ name, input });
// calls: [tool, args, result] in the order the MCP server received them;
// reply: the client's final text.
export function grade(scenario, { transcript, calls, reply }) {
  const problems = [];
  const names = transcript.map(use => use.name);
  const skillAt = transcript.findIndex(use => use.name === 'Skill' && JSON.stringify(use.input ?? {}).includes(SKILL));
  const firstMcp = names.findIndex(name => name.startsWith(MCP_PREFIX));
  const firstAction = names.findIndex(name => ACTIONS.has(name.slice(MCP_PREFIX.length)));
  if (skillAt < 0) problems.push(`the client never invoked the ${SKILL} skill`);
  else if (firstAction >= 0 && skillAt > firstAction) problems.push('the skill was invoked only after acting');
  const other = transcript.filter(use => !use.name.startsWith(MCP_PREFIX) && use.name !== 'Skill');
  if (other.length) problems.push(`used tools outside the skill and MCP: ${[...new Set(other.map(use => use.name))].join(', ')}`);

  if (!calls.length) problems.push('no MCP call reached Botmancers');
  else if (calls[0][0] !== 'botmancers_capabilities') problems.push(`first MCP call was ${calls[0][0]}, not botmancers_capabilities`);

  const actions = calls.filter(([tool]) => ACTIONS.has(tool));
  const want = expectedAction(scenario);
  if (!want) {
    if (actions.length) problems.push(`acted (${actions[0][0]}) where the fixture expects no action (${scenario.expected.outcome})`);
  } else if (!actions.length) problems.push(`never called ${want.tool}`);
  else {
    const [tool, args] = actions[0];
    if (tool !== want.tool) problems.push(`chose ${tool}, expected ${want.tool}`);
    else if (JSON.stringify(routing(tool, args)) !== JSON.stringify(want.routing)) problems.push(`${tool} routed ${JSON.stringify(routing(tool, args))}, expected ${JSON.stringify(want.routing)}`);
    const keys = new Set(actions.map(([, a]) => a.idempotency_key));
    if (actions.length > 3) problems.push(`${actions.length} action calls: retries are not bounded`);
    if (keys.size > 1) problems.push('a retry changed the idempotency_key');
    const allowedRetries = (scenario.errors?.[tool] ?? []).length;
    if (actions.length > 1 + Math.min(allowedRetries, 2)) problems.push(`retried ${tool} without a retryable error`);
  }
  if (calls.filter(([tool]) => POLLS.has(tool)).length > 40) problems.push('polling is not bounded');

  // Safe arguments and ids only from earlier results.
  const seen = new Set();
  for (const [tool, args, result] of calls) {
    const argProblems = [];
    if (TOOLS.some(entry => entry.name === tool)) checkArgs(tool, args ?? {}, scenario.name, argProblems);
    problems.push(...argProblems);
    for (const id of idsIn(args ?? {})) {
      if (!seen.has(id)) problems.push(`${tool} used ${id} before any tool returned it`);
      if (scenario.prompt.includes(id)) problems.push(`the prompt carried ${id}`);
    }
    for (const id of idsIn(result ?? {})) seen.add(id);
  }

  // The reply: provenance, a choice by title, and never a request for ids.
  const text = reply ?? '';
  if (/\b(?:provide|share|give|send|paste|tell)\b[^.?\n]{0,60}\b(?:ids?|identifiers?|session[_ ]refs?|uuids?)\b/i.test(text)) problems.push('the reply asks the user for an id');
  if (/\bprov-|provider[_ ]session[_ ]id/i.test(text)) problems.push('the reply exposes a provider id');
  if (scenario.expected.ask_user?.length && scenario.expected.outcome === 'choose_session') {
    for (const title of scenario.expected.ask_user) if (!text.includes(title)) problems.push(`the reply does not offer "${title}"`);
  }
  if (scenario.expected.outcome === 'completed' && want && want.tool !== 'botmancers_start_task') {
    const facts = scenario.facts;
    if (!text.includes(facts.session_agent)) problems.push(`the reply does not name the Agent ${facts.session_agent}`);
    const session = FIXTURES.sessions[FIXTURES.agents.find(agent => agent.name === facts.session_agent).agent_id]
      .find(item => item.ref === want.routing.source?.session_ref || item.ref === want.routing.session_ref);
    if (session && !text.toLowerCase().includes(session.title.toLowerCase())) problems.push(`the reply does not name the session "${session.title}"`);
  }
  return { problems, skillInvoked: skillAt >= 0, skillBeforeMcp: skillAt >= 0 && (firstMcp < 0 || skillAt < firstMcp) };
}

// ---------------------------------------------------------------------
// Running one scenario against a real client

function stubServer(scenario, expectToken) {
  const sim = makeSimulator(FIXTURES, scenario);
  const calls = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const json = (status, body) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(body === undefined ? '' : JSON.stringify(body));
      };
      if (req.method !== 'POST' || req.url !== '/mcp') return json(405, { error: 'POST /mcp only' });
      if (req.headers.authorization !== `Bearer ${expectToken()}`) return json(401, { error: 'unauthenticated' });
      const message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const { id, method, params } = message;
      if (id === undefined) return json(202);
      if (method === 'initialize') return json(200, { jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'botmancers', title: 'Botmancers', version: 'eval' } } });
      if (method === 'tools/list') return json(200, { jsonrpc: '2.0', id, result: { tools: TOOLS.map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations })) } });
      if (method === 'tools/call') {
        let result;
        try {
          result = sim.call(params.name, params.arguments ?? {});
        } catch (error) {
          result = { error: { code: 'invalid_arguments', message: String(error.message), retryable: false } };
        }
        calls.push([params.name, params.arguments ?? {}, result]);
        const structured = { contract: 'botmancers.mcp.v2', ...result };
        return json(200, { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(structured) }], structuredContent: structured, isError: !!result.error } });
      }
      return json(200, { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, calls, port: server.address().port })));
}

// The client keeps the user's own login (HOME); no Botmancers variables leak in.
function clientEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('BOTMANCERS_')) delete env[key];
  return env;
}

function runProcess(command, args, { env, cwd, timeoutMs }) {
  return new Promise(resolve => {
    const child = spawn(command, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

export async function runScenario(scenario, { pkg, timeoutMs = 300_000 }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'botmancers-skill-eval-')));
  try {
    const user = join(root, 'user');
    mkdirSync(join(user, '.claude'), { recursive: true });
    const bmHome = join(root, 'bm');
    let token = null;
    const stub = await stubServer(scenario, () => token);
    try {
      const env = { PATH: process.env.PATH, HOME: user, BOTMANCERS_HOME: bmHome, BOTMANCERS_DISABLE_AUTOUPDATER: '1', BOTMANCERS_APP_DIR: join(pkg, 'app'), BOTMANCERS_MCP_PORT: String(stub.port), BOTMANCERS_UI_PORT: '9', BOTMANCERS_AGENT_DECK_URL: 'http://127.0.0.1:9' };
      const setup = await runProcess(process.execPath, [join(pkg, 'dist', 'cli.js'), 'setup', '--client', 'claude'], { env, cwd: root, timeoutMs: 60_000 });
      if (setup.code !== 0) throw new Error(`setup --client claude failed (${setup.code}): ${setup.stderr}`);
      token = /^BOTMANCERS_MCP_TOKEN=(\S+)$/m.exec(readFileSync(join(bmHome, 'config/bridge.env'), 'utf8'))[1];
      const entry = JSON.parse(readFileSync(join(user, '.claude.json'), 'utf8')).mcpServers.botmancers;

      const project = join(root, 'project');
      cpSync(join(user, '.claude', 'skills', SKILL), join(project, '.claude', 'skills', SKILL), { recursive: true });
      const mcpConfig = join(root, 'mcp.json');
      writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { botmancers: entry } }), { mode: 0o600 });

      const client = await runProcess('claude', [
        '-p', scenario.prompt,
        '--output-format', 'stream-json', '--verbose',
        '--mcp-config', mcpConfig, '--strict-mcp-config',
        '--setting-sources', 'project',
        '--tools', 'Skill',
        '--allowedTools', 'Skill', 'mcp__botmancers',
        '--no-session-persistence',
        '--max-turns', '40',
      ], { env: clientEnv(), cwd: project, timeoutMs });

      if (process.env.SKILL_EVAL_RAW_DIR) writeFileSync(join(process.env.SKILL_EVAL_RAW_DIR, `${scenario.name}.jsonl`), client.stdout.split(token).join('<redacted>'));
      const transcript = [];
      let reply = '';
      let model = null;
      for (const line of client.stdout.split('\n')) {
        if (!line.trim().startsWith('{')) continue;
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (event.type === 'system' && event.subtype === 'init') model = event.model ?? null;
        if (event.type === 'assistant') for (const block of event.message?.content ?? []) if (block.type === 'tool_use') transcript.push({ name: block.name, input: block.input });
        if (event.type === 'result') reply = event.result ?? '';
      }
      const graded = grade(scenario, { transcript, calls: stub.calls, reply });
      if (client.code !== 0) graded.problems.unshift(`claude exited ${client.code}: ${client.stderr.trim().slice(0, 400)}`);
      for (const text of [client.stdout, reply]) if (text.includes(token)) graded.problems.push('the MCP token appeared in client output');
      return { name: scenario.name, model, transcript: transcript.map(use => (use.name === 'Skill' ? `Skill(${use.input?.skill ?? use.input?.command ?? ''})` : use.name.replace(MCP_PREFIX, ''))), calls: stub.calls.map(([tool, args]) => [tool, args]), reply, ...graded };
    } finally {
      stub.server.close();
      stub.server.closeAllConnections();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------

async function main(argv) {
  const option = name => { const at = argv.indexOf(name); return at >= 0 ? argv[at + 1] : null; };
  const only = option('--only')?.split(',');
  const jobs = Number(option('--jobs') ?? 3);
  const out = option('--out');
  const scenarios = FIXTURES.scenarios.filter(scenario => !only || only.includes(scenario.name));
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'botmancers-skill-eval-pkg-')));
  const version = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8')).version;
  const pkg = makePackage(join(work, version), version);
  const results = [];
  try {
    const queue = [...scenarios];
    await Promise.all(Array.from({ length: Math.max(1, jobs) }, async () => {
      while (queue.length) {
        const scenario = queue.shift();
        const result = await runScenario(scenario, { pkg }).catch(error => ({ name: scenario.name, problems: [String(error.stack ?? error)], transcript: [], calls: [], reply: '' }));
        results.push(result);
        process.stderr.write(`${result.problems.length ? 'FAIL' : 'pass'} ${scenario.name}\n`);
      }
    }));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  results.sort((a, b) => scenarios.findIndex(s => s.name === a.name) - scenarios.findIndex(s => s.name === b.name));
  const head = (() => { try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: PACKAGE_DIR, encoding: 'utf8' }).trim(); } catch { return 'unknown'; } })();
  const clientVersion = (() => { try { return execFileSync('claude', ['--version'], { encoding: 'utf8' }).trim(); } catch { return 'unknown'; } })();
  const lines = [
    `botmancers-collaboration live routing eval`,
    `head: ${head}`,
    `package: botmancers ${version} (package tree built from this checkout)`,
    `client: claude ${clientVersion}; model: ${results.find(r => r.model)?.model ?? 'unknown'}`,
    `command: node scripts/eval-skill-routing.mjs${argv.length ? ` ${argv.join(' ')}` : ''}`,
    '',
  ];
  for (const result of results) {
    const want = expectedAction(FIXTURES.scenarios.find(s => s.name === result.name));
    lines.push(`${result.problems.length ? 'FAIL' : 'pass'} ${result.name}`);
    lines.push(`  prompt:   ${FIXTURES.scenarios.find(s => s.name === result.name).prompt}`);
    lines.push(`  expected: ${want ? `${want.tool} ${JSON.stringify(want.routing)}` : 'no action (ask or stop)'}`);
    lines.push(`  client:   ${result.transcript.join(' -> ')}`);
    const action = result.calls.find(([tool]) => ACTIONS.has(tool));
    if (action) lines.push(`  action:   ${action[0]} ${JSON.stringify(routing(action[0], action[1]))}`);
    lines.push(`  reply:    ${result.reply.replace(/\s+/g, ' ').slice(0, 300)}`);
    for (const problem of result.problems) lines.push(`  problem:  ${problem}`);
  }
  const failed = results.filter(result => result.problems.length).length;
  lines.push('', `${results.length - failed}/${results.length} scenarios passed`);
  const report = `${lines.join('\n')}\n`;
  if (out) writeFileSync(out, report);
  process.stdout.write(report);
  return failed ? 1 : 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(code => process.exit(code), error => { console.error(error); process.exit(1); });
}
