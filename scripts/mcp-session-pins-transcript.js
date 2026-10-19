#!/usr/bin/env node
// NOT-507: a redacted MCP transcript against a running Botmancers seeded
// with scripts/seed-pins-fixture.js, driven over the real Streamable HTTP
// endpoint (POST /api/v0/mcp) as a granted service caller would:
// tools/list; list Agents; list Forge's sessions and pick a past one by its
// title; Ask from this context with two follow-ups on the same ref; Resume
// work here refused without approval, then switched to with approval; a
// registered-Agent message without a session id; Hand off to… on a native
// session refused with a structured recovery; detach, then pin_detached.
// The bearer token is never written. Writes mcp-session-pins-transcript.json
// (HEAD and every request/response) under --out.
//
// Usage: node scripts/mcp-session-pins-transcript.js --token <service token> [--url http://127.0.0.1:43507] [--out .agent-dealer-visual-qa]
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const URL_BASE = arg('--url', 'http://127.0.0.1:43507');
const OUT = arg('--out', '.agent-dealer-visual-qa');
const TOKEN = arg('--token', process.env.BOTMANCERS_PROOF_TOKEN || '');
const HEAD = execSync('git rev-parse HEAD').toString().trim();
const RUN = Date.now().toString(36);

const transcript = [];
let failures = 0;
let nextId = 1;
function check(ok, label) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}: ${label}`);
  if (!ok) failures++;
  transcript.push({ check: label, ok });
}

async function rpc(method, params) {
  const request = { jsonrpc: '2.0', id: nextId++, method, params };
  const res = await fetch(`${URL_BASE}/api/v0/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(request),
  });
  const text = await res.text();
  const body = text.startsWith('{') ? JSON.parse(text) : JSON.parse(text.split('\n').find(line => line.startsWith('data:')).slice(5));
  transcript.push({ request, status: res.status, response: body });
  return body;
}

async function tool(name, args) {
  const body = await rpc('tools/call', { name, arguments: args });
  const result = body.result ?? {};
  return { error: result.isError ? result.structuredContent?.error ?? result.structuredContent : null, value: result.structuredContent };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function settle(pinRef, seq) {
  for (let i = 0; i < 60; i++) {
    const read = await tool('botmancers_get_pin', { pin_ref: pinRef });
    const turn = read.value?.turns?.find(t => t.seq === seq);
    if (turn && turn.state !== 'running') return { pin: read.value.pin, turn };
    await sleep(500);
  }
  return null;
}

async function main() {
  if (!TOKEN) throw new Error('--token is required (the proof service token)');
  fs.mkdirSync(OUT, { recursive: true });
  console.log(`HEAD ${HEAD}\napp ${URL_BASE}/api/v0/mcp`);
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'not-507-proof', version: '0' } });
  check(init.result?.serverInfo?.name === 'botmancers', 'initialize: Botmancers MCP');
  const list = await rpc('tools/list', {});
  const names = list.result.tools.map(t => t.name);
  check(['botmancers_message_agent', 'botmancers_pin_session', 'botmancers_send_to_pin', 'botmancers_get_pin', 'botmancers_detach_pin', 'botmancers_send_to_session', 'botmancers_create_exchange', 'botmancers_start_task'].every(n => names.includes(n)),
    `tools/list: v1, v2, and the NOT-507 tools (${names.length} tools)`);

  const agents = await tool('botmancers_list_agents', {});
  const forge = agents.value.items.find(a => a.name === 'Forge');
  check(!!forge, 'list_agents: Forge by name');
  const sessions = await tool('botmancers_list_sessions', { agent_id: forge.agent_id });
  const pick = sessions.value.items.find(s => s.title === 'Fix the uploader retry');
  check(!!pick && pick.actions.ask.available && pick.actions.resume.available && !pick.actions.handoff.available,
    'list_sessions: a past session picked by its title; Ask and Resume available, Hand off says why not');
  check(!/SECRET/.test(JSON.stringify(sessions.value)), 'list_sessions: no provider session id');

  const asked = await tool('botmancers_pin_session', { session_ref: pick.ref, action: 'ask', idempotency_key: `ask-${RUN}` });
  const pinRef = asked.value.pin.pin_ref;
  check(asked.value.pin.session.ref === pick.ref && asked.value.pin.authority === 'read_only', 'pin_session ask: pinned to the exact ref, read only');
  const refs = [];
  for (const [i, q] of ['Which tests are still pending?', 'And which file holds them?'].entries()) {
    const sent = await tool('botmancers_send_to_pin', { pin_ref: pinRef, content: q, idempotency_key: `t${i}-${RUN}` });
    const done = await settle(pinRef, sent.value.turn.seq);
    refs.push(done?.pin.session.ref);
    check(done?.turn.state === 'completed' && typeof done.turn.answer === 'string', `follow-up ${i + 1}: answered on the pinned session`);
  }
  check(refs.every(r => r === pick.ref), 'both follow-ups stayed on the same session ref');
  const replay = await tool('botmancers_send_to_pin', { pin_ref: pinRef, content: 'And which file holds them?', idempotency_key: `t1-${RUN}` });
  check(replay.value?.replayed === true, 'a retried follow-up with the same key is a replay, not a second turn');

  const noApproval = await tool('botmancers_pin_session', { session_ref: pick.ref, action: 'resume', idempotency_key: `r0-${RUN}` });
  check(noApproval.error?.code === 'approval_required' && noApproval.error?.recovery === 'approve_write', 'resume without approval: approval_required, recovery approve_write');
  const resumed = await tool('botmancers_pin_session', { session_ref: pick.ref, action: 'resume', approve_write: true, replace_pin_ref: pinRef, idempotency_key: `r1-${RUN}` });
  check(resumed.value?.pin.session.ref === pick.ref && resumed.value.pin.authority === 'workspace_write' && resumed.value.replaced_pin_ref === pinRef,
    'resume with explicit approval: same Agent, same session, workspace write; the ask pin is switched out');
  const work = await tool('botmancers_send_to_pin', { pin_ref: resumed.value.pin.pin_ref, content: 'Add the missing test and run it.', idempotency_key: `rw-${RUN}` });
  const worked = await settle(resumed.value.pin.pin_ref, work.value.turn.seq);
  check(worked?.turn.state === 'completed' && worked.turn.authority === 'workspace_write', 'the resumed turn completed with workspace-write authority');
  const old = await tool('botmancers_send_to_pin', { pin_ref: pinRef, content: 'still there?', idempotency_key: `old-${RUN}` });
  check(old.error?.code === 'pin_detached' && old.error?.recovery === 'pin_again', 'the switched-out pin no longer sends: pin_detached');

  const messaged = await tool('botmancers_message_agent', { agent_id: forge.agent_id, content: 'What are you working on?', idempotency_key: `m-${RUN}` });
  check(!!messaged.value?.pin && ['home', 'newest'].includes(messaged.value.resolution), `message_agent without a session id: resolved ${messaged.value?.resolution}`);

  const handoff = await tool('botmancers_create_exchange', {
    mode: 'continue', idempotency_key: `h-${RUN}`, source: { agent_id: forge.agent_id, session_ref: pick.ref }, destination: { agent_id: forge.agent_id }, instruction: 'Take this over',
  });
  check(!!handoff.error && typeof handoff.error.code === 'string', `hand off from a native session or to an ungranted Agent: structured refusal ${handoff.error?.code}`);

  const detached = await tool('botmancers_detach_pin', { pin_ref: resumed.value.pin.pin_ref });
  check(detached.value?.pin.state === 'detached', 'detach_pin: explicit detach');
  const after = await tool('botmancers_send_to_pin', { pin_ref: resumed.value.pin.pin_ref, content: 'x', idempotency_key: `x-${RUN}` });
  check(after.error?.code === 'pin_detached', 'a detached pin never retargets: pin_detached');

  const text = JSON.stringify(transcript);
  check(!/SECRET/.test(text) && !text.includes(TOKEN), 'transcript: no provider id and no token');
  fs.writeFileSync(path.join(OUT, 'mcp-session-pins-transcript.json'), `${JSON.stringify({ head: HEAD, app: URL_BASE, failures, transcript }, null, 2)}\n`);
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
