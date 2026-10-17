#!/usr/bin/env node
// NOT-496: the Agent session catalog (lib/session-catalog) and its owner
// routes (GET /api/bots/:id/sessions, GET /api/bots/:id/sessions/:ref).
// Proves: summaries derive from the canonical session_bindings plus the
// Conversation, Work Request, Attempts, and stored launch snapshot (no
// parallel table); active/released maps to active/ended; newest-activity
// ordering is deterministic; active|ended|all filtering; unknown Agents and
// unknown or foreign references are 404; external provider session ids
// never appear in normal JSON, only behind the labeled debug parameter.
// The routes run behind the real owner boundary (proxy.ts) on loopback.
// Self-contained: isolated SQLite file, no network.
'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = __dirname;
const DB_PATH = path.join(os.tmpdir(), `botmancers-session-catalog-${process.pid}.db`);
function removeDb() {
  for (const suffix of ['', '-shm', '-wal']) {
    try { fs.rmSync(DB_PATH + suffix, { force: true }); } catch { /* fresh start */ }
  }
}
removeDb();
process.env.BOTMANCERS_DB_PATH = DB_PATH;
process.env.BOTMANCERS_NO_AUTOPROCESS = '1';

const { createJiti } = require('jiti');
const jiti = createJiti(__filename, { alias: { '@': ROOT } });
const dbModule = jiti('./lib/db.ts');
const catalog = jiti('./lib/session-catalog.ts');
const { startRouteHost } = require('./test-support/acceptance/route-host');
const { BASE, MIN, EXTERNAL_IDS, seedSessionCatalog } = require('./test-support/session-catalog-fixture');

const db = dbModule.default;
let failures = 0;
function assert(condition, label) {
  if (condition) console.log(`  PASS: ${label}`);
  else { failures++; console.log(`  FAIL: ${label}`); }
  return condition;
}
const leaks = text => Object.values(EXTERNAL_IDS).filter(id => text.includes(id));

async function main() {
  const tablesBefore = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map(row => row.name);
  const fixture = seedSessionCatalog(dbModule);
  const { dev, scout } = fixture.agents;
  const { implementation, replaced, direct, directNext, group, other } = fixture.bindings;

  console.log('\nRead model over canonical session_bindings');
  const tablesAfter = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map(row => row.name);
  assert(JSON.stringify(tablesBefore) === JSON.stringify(tablesAfter), 'the catalog adds no table (no parallel session-identity store)');
  const all = catalog.listAgentSessions(db, dev.id, 'all');
  const canonical = db.prepare('SELECT id FROM session_bindings WHERE agent_id = ? ORDER BY id').all(dev.id).map(row => row.id);
  assert(JSON.stringify(all.map(s => s.ref).sort()) === JSON.stringify(canonical), 'every canonical binding of the Agent is listed once, by its binding id');
  assert(all.every(s => s.ref !== other.id), 'another Agent\'s binding is not listed');
  assert(JSON.stringify(all.map(s => s.ref)) === JSON.stringify([implementation.id, group.id, directNext.id, direct.id, replaced.id]),
    'newest activity first; equal activity breaks by newest binding');
  const byRef = Object.fromEntries(all.map(s => [s.ref, s]));
  const impl = byRef[implementation.id];
  assert(impl.status === 'active' && impl.ended_at === null && impl.resumable === true, 'an unreleased implementation binding is active and resumable');
  assert(impl.last_activity_at === BASE + 64 * MIN, 'last activity includes the Attempt that resumed the binding');
  assert(impl.title === 'Add the session catalog read model', 'title is the owning Work Request\'s first intent line');
  assert(impl.agent.name === 'Dev' && impl.agent.adapter === 'codex' && impl.agent.transport === 'agent-deck', 'agent identity, adapter, and transport from the launch snapshot');
  assert(impl.origin.conversation.label === 'Tank thread' && impl.origin.conversation.thread_agent_id === fixture.agents.tank.id
    && impl.origin.conversation.kind === 'direct', 'origin conversation is the coordinator thread it came from');
  assert(impl.origin.work_request.id === fixture.requests.implementation.id && impl.origin.work_request.execution_kind === 'implementation'
    && impl.origin.work_request.state === 'completed', 'origin Work Request reference, kind, and state');
  assert(impl.context.workspace === '/Users/owner/work/botmancers' && impl.context.deck === 'builder', 'workspace and deck come from the stored launch snapshot');
  const ended = byRef[replaced.id];
  assert(ended.status === 'ended' && ended.ended_at === BASE + 20 * MIN && ended.resumable === false, 'a released binding is ended, with its release time, and not resumable');
  assert(byRef[group.id].title === 'Group Design review' && byRef[group.id].origin.conversation.kind === 'group'
    && byRef[group.id].origin.conversation.thread_agent_id === null && byRef[group.id].resumable === false, 'a group binding is titled from its group and has no thread link');
  assert(byRef[direct.id].title === 'Dev · 2026-10-15 09:05 UTC', 'no Work Request or group: <Agent name> · <created date/time>');
  assert(byRef[directNext.id].context.workspace === null && byRef[directNext.id].context.deck === null, 'no launch snapshot: no invented workspace or deck');
  assert(JSON.stringify(catalog.listAgentSessions(db, dev.id, 'active').map(s => s.ref)) === JSON.stringify([implementation.id, group.id, directNext.id]), 'active filter');
  assert(JSON.stringify(catalog.listAgentSessions(db, dev.id, 'ended').map(s => s.ref)) === JSON.stringify([direct.id, replaced.id]), 'ended filter');
  assert(leaks(JSON.stringify(all)).length === 0, 'summaries carry no external provider session id');
  const detail = catalog.getAgentSession(db, dev.id, implementation.id);
  assert(detail.attempts.length === 2 && detail.attempts[0].role === 'source' && detail.attempts[1].role === 'resume'
    && detail.attempts[1].kind === 'resume', 'detail lists the source Attempt and the Attempt that resumed it');
  assert(catalog.getAgentSession(db, dev.id, other.id) === undefined, 'detail of another Agent\'s binding is undefined');

  console.log('\nOwner routes on loopback (real proxy.ts)');
  const host = await startRouteHost({ jiti, repoRoot: ROOT });
  try {
    const list = await host.owner('GET', `/api/bots/${dev.id}/sessions`);
    assert(list.status === 200 && list.json.status === 'all' && list.json.sessions.length === 5, 'GET /api/bots/:id/sessions defaults to all');
    assert(JSON.stringify(list.json.sessions.map(s => s.ref)) === JSON.stringify(all.map(s => s.ref)), 'route order matches the read model');
    assert(leaks(list.text).length === 0 && !list.text.includes('external_session_id'), 'list JSON omits external_session_id');
    const active = await host.owner('GET', `/api/bots/${dev.id}/sessions?status=active`);
    assert(active.status === 200 && active.json.sessions.every(s => s.status === 'active') && active.json.sessions.length === 3, '?status=active');
    const endedList = await host.owner('GET', `/api/bots/${dev.id}/sessions?status=ended`);
    assert(endedList.status === 200 && endedList.json.sessions.every(s => s.status === 'ended') && endedList.json.sessions.length === 2, '?status=ended');
    assert((await host.owner('GET', `/api/bots/${dev.id}/sessions?status=released`)).status === 400, 'an unknown status filter is 400');
    const scoutList = await host.owner('GET', `/api/bots/${scout.id}/sessions`);
    assert(scoutList.status === 200 && scoutList.json.sessions.length === 1 && scoutList.json.sessions[0].ref === other.id, 'the second Agent sees only its own session');
    assert((await host.owner('GET', '/api/bots/no-such-agent/sessions')).status === 404, 'unknown Agent list is 404');

    const one = await host.owner('GET', `/api/bots/${dev.id}/sessions/${implementation.id}`);
    assert(one.status === 200 && one.json.session.ref === implementation.id && one.json.session.attempts.length === 2, 'GET /api/bots/:id/sessions/:ref');
    assert(leaks(one.text).length === 0 && !one.text.includes('external_session_id') && one.json.debug === undefined, 'detail JSON omits external_session_id');
    const foreign = await host.owner('GET', `/api/bots/${dev.id}/sessions/${other.id}`);
    const unknown = await host.owner('GET', `/api/bots/${dev.id}/sessions/no-such-session`);
    assert(foreign.status === 404 && unknown.status === 404 && foreign.text === unknown.text, 'another Agent\'s reference is 404, indistinguishable from an unknown one');
    assert(leaks(foreign.text).length === 0, 'a foreign reference discloses nothing');
    assert((await host.owner('GET', `/api/bots/no-such-agent/sessions/${implementation.id}`)).status === 404, 'unknown Agent detail is 404');
    const debug = await host.owner('GET', `/api/bots/${dev.id}/sessions/${implementation.id}?debug=external_session_id`);
    assert(debug.status === 200 && debug.json.debug.external_session_id === EXTERNAL_IDS.implementation, 'only the explicit debug parameter returns the provider session id');
    const foreignDebug = await host.owner('GET', `/api/bots/${dev.id}/sessions/${other.id}?debug=external_session_id`);
    assert(foreignDebug.status === 404 && leaks(foreignDebug.text).length === 0, 'the debug parameter never crosses Agents');
    const remote = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: host.port, path: `/api/bots/${dev.id}/sessions`, headers: { host: 'botmancers.example' } }, res => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      }).on('error', reject);
    });
    assert(remote === 403, 'a non-loopback host is refused by the owner boundary');
  } finally {
    await host.close();
  }

  removeDb();
  if (failures > 0) {
    console.log(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log('\nAll session catalog checks passed.');
}

main().catch(error => {
  console.error(error);
  removeDb();
  process.exit(1);
});
