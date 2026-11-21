#!/usr/bin/env node
// NOT-459: single and bulk agent deletion contract.
// Proves: DELETE /api/bots keeps { id }, accepts 1–500 unique ids, returns
// 400/404/409 with no partial deletion; a batch removes every agent-owned
// row in one transaction and an injected mid-batch failure rolls it all
// back; the preview matches what deletion does; no filesystem path is
// touched; the shared UI contract is wired into Config, the row menu, and
// Manage agents. Self-contained: isolated SQLite file and temp directory,
// real route handlers in-process, no dev server, no network.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const DB_PATH = path.join(os.tmpdir(), `botmancers-bot-deletion-test-${process.pid}.db`);
for (const suffix of ['', '-shm', '-wal']) {
  try { fs.rmSync(DB_PATH + suffix, { force: true }); } catch { /* fresh start */ }
}
process.env.BOTMANCERS_DB_PATH = DB_PATH;
process.env.BOTMANCERS_NO_AUTOPROCESS = '1';

const { createJiti } = require('jiti');
const jiti = createJiti(__filename, { alias: { '@': ROOT } });
const db = jiti('./lib/db.ts');
const botsRoute = jiti('./app/api/bots/route.ts');
const previewRoute = jiti('./app/api/bots/delete-preview/route.ts');
const manageRoute = jiti('./app/api/bots/manage/route.ts');
const deletion = jiti('./lib/bot-deletion.ts');

const sqlite = db.default;
const { bots, groups, conversations, messages, memories, oneShots, routines, launchSnapshots, approvals } = db;
const { uiTurns } = jiti('./lib/ui-turns.ts');

let failures = 0;
function assert(condition, label) {
  if (condition) console.log(`  PASS: ${label}`);
  else { failures++; console.log(`  FAIL: ${label}`); }
  return condition;
}

function request(handler, method, body) {
  return handler(new Request('http://localhost/api/bots', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }));
}
const del = body => request(botsRoute.DELETE, 'DELETE', body);
const preview = body => request(previewRoute.POST, 'POST', body);
const json = async res => { try { return await res.json(); } catch { return null; } };

let clock = 1_700_000_000_000;
function makeBot(name, extra = {}) {
  clock += 1000;
  return bots.create({ name, title: '', description: '', ...extra }, { created_at: clock });
}

const count = (sql, ...args) => sqlite.prepare(sql).get(...args).n;

// Every database row an agent owns, keyed by table, for before/after checks.
function ownedRows(botId) {
  const conv = conversations.getByBotId(botId);
  const convId = conv ? conv.id : '__none__';
  return {
    bots: count('SELECT COUNT(*) AS n FROM bots WHERE id = ?', botId),
    conversations: count('SELECT COUNT(*) AS n FROM conversations WHERE bot_id = ?', botId),
    messages: count('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?', convId),
    ui_turns: count("SELECT COUNT(*) AS n FROM work_requests WHERE executor <> 'dispatcher' AND (target_agent_id = ? OR source_conversation_id = ?)", botId, convId),
    approvals: count('SELECT COUNT(*) AS n FROM approvals WHERE conversation_id = ?', convId),
    approval_requests: count('SELECT COUNT(*) AS n FROM approval_requests WHERE conversation_id = ? OR bot_id = ?', convId, botId),
    snapshots: count('SELECT COUNT(*) AS n FROM launch_snapshots WHERE bot_id = ?', botId),
    memberships: count('SELECT COUNT(*) AS n FROM group_members WHERE bot_id = ?', botId),
    memories: count('SELECT COUNT(*) AS n FROM memories WHERE bot_id = ?', botId),
    one_shots: count('SELECT COUNT(*) AS n FROM one_shots WHERE bot_id = ?', botId),
    routines: count('SELECT COUNT(*) AS n FROM routines WHERE bot_id = ?', botId),
    pending_questions: count('SELECT COUNT(*) AS n FROM pending_questions WHERE bot_id = ?', botId),
    participants: count("SELECT COUNT(*) AS n FROM conversation_participants WHERE participant_kind = 'bot' AND participant_id = ?", botId),
  };
}

function seedOwnedRecords(bot, peer) {
  const conv = conversations.getByBotId(bot.id);
  messages.create(conv.id, 'user', `hello ${bot.name}`);
  messages.create(conv.id, 'bot', `I am ${bot.name}, I like tea.`, bot.id);
  const done = uiTurns.enqueue(conv.id, bot.id);
  uiTurns.start(done.id);
  uiTurns.finish(done.id, 'completed');
  approvals.recordPending(conv.id, `code-${bot.name}`);
  sqlite.prepare(
    "INSERT INTO approval_requests (id, conversation_id, bot_id, code, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)"
  ).run(crypto.randomUUID(), conv.id, bot.id, `req-${bot.name}`, Date.now());
  launchSnapshots.record(crypto.randomUUID(), bot.id, 'hash', '{}');
  memories.rememberStatement(bot.id, `${bot.name} prefers tea.`);
  oneShots.create(conv.id, bot.id, Date.now() + 60000);
  routines.create(conv.id, bot.id, 'tick', Date.now() + 60000, 60000);
  sqlite.prepare(
    "INSERT INTO pending_questions (id, conversation_id, bot_id, question, status, created_at) VALUES (?, ?, ?, ?, 'asked', ?)"
  ).run(crypto.randomUUID(), conv.id, bot.id, 'Which file?', Date.now());
  if (peer) groups.create(`${bot.name} crew`, [bot.id, peer.id], bot.id);
}

const allZero = rows => Object.values(rows).every(n => n === 0);
const allPositive = rows => Object.entries(rows).every(([key, n]) => key === 'conversations' || key === 'bots' ? n === 1 : n > 0);

function hashTree(dir) {
  const out = {};
  const walk = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) { out[path.relative(dir, full) + '/'] = 'dir'; walk(full); }
      else out[path.relative(dir, full)] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    }
  };
  walk(dir);
  return out;
}

async function main() {
  console.log('NOT-459 bot-deletion test (isolated DB and temp dir)');

  console.log('\nCase 1: request validation (400)');
  const keeper = makeBot('Keeper');
  const cases = [
    ['non-JSON body', 'not json'],
    ['empty object', {}],
    ['empty id', { id: '' }],
    ['non-string id', { id: 7 }],
    ['ids not an array', { ids: 'abc' }],
    ['empty ids', { ids: [] }],
    ['blank id in ids', { ids: [keeper.id, ' '] }],
    ['duplicate ids', { ids: [keeper.id, keeper.id] }],
    ['501 ids', { ids: Array.from({ length: 501 }, (_, i) => `id-${i}`) }],
    ['both id and ids', { id: keeper.id, ids: [keeper.id] }],
  ];
  for (const [label, body] of cases) {
    const res = await del(body);
    assert(res.status === 400, `${label} → 400 (got ${res.status})`);
  }
  assert(bots.getById(keeper.id), 'no 400 request deleted anything');
  assert(deletion.parseDeleteIds({ ids: Array.from({ length: 500 }, (_, i) => `id-${i}`) }).ok === true, '500 unique ids parse');

  console.log('\nCase 2: missing target (404) deletes nothing');
  const a = makeBot('Alpha');
  let res = await del({ ids: [a.id, 'missing-id'] });
  let body = await json(res);
  assert(res.status === 404, `bulk with a missing id → 404 (got ${res.status})`);
  assert(body && Array.isArray(body.missing) && body.missing[0] === 'missing-id', '404 names the missing id');
  assert(bots.getById(a.id), 'present target survives a 404 batch');
  res = await del({ id: 'missing-id' });
  assert(res.status === 404, `legacy { id } missing → 404 (got ${res.status})`);

  console.log('\nCase 3: Chief of Staff and active targets (409) delete nothing');
  const chief = makeBot('chief-of-staff');
  const pendingBot = makeBot('PendingBot');
  const processingBot = makeBot('ProcessingBot');
  uiTurns.enqueue(conversations.getByBotId(pendingBot.id).id, pendingBot.id);
  const proc = uiTurns.enqueue(conversations.getByBotId(processingBot.id).id, processingBot.id);
  uiTurns.start(proc.id);
  res = await del({ ids: [a.id, chief.id] });
  body = await json(res);
  assert(res.status === 409, `batch with Chief of Staff → 409 (got ${res.status})`);
  assert(body && body.blocked.length === 1 && body.blocked[0].id === chief.id && body.blocked[0].name === 'chief-of-staff', '409 names the Chief of Staff id and name');
  res = await del({ ids: [a.id, pendingBot.id, processingBot.id] });
  body = await json(res);
  assert(res.status === 409, `batch with pending + processing agents → 409 (got ${res.status})`);
  assert(body && body.blocked.map(item => item.id).sort().join() === [pendingBot.id, processingBot.id].sort().join(), '409 names both active agents');
  assert(body && body.blocked.every(item => item.reason === 'active' && /stop it or let it finish/.test(item.message)), '409 explains active agents must stop or finish');
  res = await del({ id: chief.id });
  assert(res.status === 409, `legacy { id } Chief of Staff → 409 (got ${res.status})`);
  assert(bots.getById(a.id) && bots.getById(chief.id) && bots.getById(pendingBot.id) && bots.getById(processingBot.id), 'no target deleted by a 409 batch');

  console.log('\nCase 4: legacy { id } still deletes one agent');
  res = await del({ id: a.id });
  body = await json(res);
  assert(res.status === 200 && body.ok === true, `legacy { id } → 200 (got ${res.status})`);
  assert(!bots.getById(a.id), 'legacy target removed');
  assert(body.deleted.length === 1 && body.deleted[0].id === a.id, 'response lists the deleted agent');

  console.log('\nCase 5: forced mid-transaction failure rolls back the whole batch');
  const r1 = makeBot('Roll1');
  const r2 = makeBot('Roll2');
  const r3 = makeBot('Roll3');
  seedOwnedRecords(r1, r2);
  seedOwnedRecords(r2);
  seedOwnedRecords(r3, keeper);
  const snapshotBefore = [r1, r2, r3].map(bot => JSON.stringify(ownedRows(bot.id)));
  const groupsBefore = count('SELECT COUNT(*) AS n FROM groups');
  let thrown = null;
  try {
    bots.removeMany([r1.id, r2.id, r3.id], { onAgentDeleted: id => { if (id === r2.id) throw new Error('injected failure'); } });
  } catch (error) { thrown = error; }
  assert(thrown && thrown.message === 'injected failure', 'injected failure surfaces');
  assert([r1, r2, r3].every((bot, i) => JSON.stringify(ownedRows(bot.id)) === snapshotBefore[i]), 'every agent and owned row is intact after rollback');
  assert(count('SELECT COUNT(*) AS n FROM groups') === groupsBefore, 'group reconciliation rolled back too');

  console.log('\nCase 6: bulk delete removes every agent-owned record');
  assert([r1, r2, r3].every(bot => allPositive(ownedRows(bot.id))), 'fixture seeded every owned table');
  const survivor = makeBot('Survivor');
  seedOwnedRecords(survivor);
  const survivorBefore = JSON.stringify(ownedRows(survivor.id));
  const crewConvId = conversations.getByGroupId(groups.getAll().find(g => g.name === 'Roll1 crew').id).id;
  res = await del({ ids: [r1.id, r2.id, r3.id] });
  body = await json(res);
  assert(res.status === 200 && body.deleted.length === 3, `bulk { ids } → 200 with three deleted (got ${res.status})`);
  assert([r1, r2, r3].every(bot => allZero(ownedRows(bot.id))), 'no owned rows remain for any deleted agent');
  assert(count('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?', crewConvId) === 0, 'removed group conversation has no messages');
  assert(JSON.stringify(ownedRows(survivor.id)) === survivorBefore, 'unselected agent rows untouched');

  console.log('\nCase 7: preview matches deletion and management rows');
  const p1 = makeBot('Prev1');
  const p2 = makeBot('Prev2');
  const p3 = makeBot('Prev3');
  const trio = groups.create('PrevTrio', [p1.id, p2.id, p3.id], p1.id);
  const pair = groups.create('PrevPair', [p2.id, p3.id], p2.id);
  res = await preview({ ids: [p1.id, chief.id, pendingBot.id, 'ghost'] });
  body = await json(res);
  assert(res.status === 200, 'preview answers 200 with blockers listed');
  assert(body.missing.join() === 'ghost', 'preview lists missing ids');
  assert(body.blocked.map(item => `${item.name}:${item.reason}`).sort().join() === ['PendingBot:active', 'chief-of-staff:chief'].sort().join(), 'preview lists chief and active blockers');
  res = await preview({ ids: [p1.id, p2.id] });
  body = await json(res);
  const trioImpact = body.groups.find(g => g.id === trio.id);
  const pairImpact = body.groups.find(g => g.id === pair.id);
  assert(trioImpact && trioImpact.outcome === 'removed', 'preview: trio left with one member is removed');
  assert(pairImpact && pairImpact.outcome === 'removed', 'preview: pair left with one member is removed');
  assert((await preview({ ids: [] })).status === 400, 'preview validates like DELETE');
  bots.setHidden(survivor.id, true);
  res = await manageRoute.GET();
  const rows = await json(res);
  const byName = name => rows.find(row => row.name === name);
  assert(byName('Survivor') && byName('Survivor').hidden === 1, 'management list includes hidden agents');
  assert(byName('chief-of-staff').blocked === 'chief', 'management marks Chief of Staff blocked');
  assert(byName('PendingBot').blocked === 'active' && byName('ProcessingBot').blocked === 'active', 'management marks pending and processing agents blocked');
  assert(byName('Keeper').blocked === null, 'idle agent is deletable');
  assert(typeof byName('Survivor').last_activity === 'number' && byName('Keeper').last_activity === null, 'last activity present when available, null otherwise');
  assert(['agent', 'runtime_connection', 'source_provider', 'created_at'].every(key => key in byName('Keeper')), 'rows carry Agent, runtime connection, source, and created date');

  console.log('\nCase 8: no filesystem path is removed');
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'botmancers-delete-sentinel-'));
  const workdir = path.join(sandbox, 'workdirs', 'fsbot');
  const hermesDir = path.join(sandbox, 'hermes', 'profiles', 'fsbot');
  const sourceDir = path.join(sandbox, 'marketplace-source');
  fs.mkdirSync(path.join(sandbox, 'skills', 'FsBot'), { recursive: true });
  fs.mkdirSync(path.join(sandbox, 'skills', 'FsBot2'), { recursive: true });
  fs.mkdirSync(workdir, { recursive: true });
  fs.mkdirSync(hermesDir, { recursive: true });
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(path.join(sandbox, 'skills', 'FsBot', 'SKILL.md'), 'sentinel skill\n');
  fs.writeFileSync(path.join(sandbox, 'skills', 'FsBot2', 'SKILL.md'), 'sentinel skill 2\n');
  fs.writeFileSync(path.join(workdir, 'notes.txt'), 'sentinel workdir');
  fs.writeFileSync(path.join(hermesDir, 'config.yaml'), 'sentinel: hermes');
  fs.writeFileSync(path.join(sourceDir, 'agent.json'), '{"sentinel":true}');
  const fsBot = makeBot('FsBot', { working_directory: workdir, hermes_profile: hermesDir });
  const fsBot2 = makeBot('FsBot2', { working_directory: sourceDir });
  const treeBefore = hashTree(sandbox);
  const cwd = process.cwd();
  process.chdir(sandbox);
  try {
    res = await del({ id: fsBot.id });
    assert(res.status === 200, 'single delete with filesystem paths succeeds');
    res = await del({ ids: [fsBot2.id] });
    assert(res.status === 200, 'bulk delete with filesystem paths succeeds');
  } finally {
    process.chdir(cwd);
  }
  const treeAfter = hashTree(sandbox);
  assert(JSON.stringify(treeAfter) === JSON.stringify(treeBefore), `all ${Object.keys(treeBefore).length} sentinel paths byte-identical after deletion`);
  fs.rmSync(sandbox, { recursive: true, force: true });

  console.log('\nCase 9: one shared UI contract on Config, row menu, and Manage agents');
  const page = fs.readFileSync(path.join(ROOT, 'app', 'page.tsx'), 'utf8');
  const rail = fs.readFileSync(path.join(ROOT, 'app', 'components', 'AgentRail.tsx'), 'utf8');
  const config = fs.readFileSync(path.join(ROOT, 'app', 'bots', '[id]', 'config', 'page.tsx'), 'utf8');
  const dialog = fs.readFileSync(path.join(ROOT, 'app', 'components', 'DeleteAgentsDialog.tsx'), 'utf8');
  assert(/Danger zone/.test(config) && /Delete agent/.test(config) && /<DeleteAgentsDialog/.test(config), 'Config has a Danger zone that opens DeleteAgentsDialog');
  assert(/Manage agents/.test(rail) && /<ManageAgentsPanel/.test(page), 'roster has Manage agents opening the panel');
  assert(/Delete agent…/.test(rail) && /<DeleteAgentsDialog/.test(rail), 'row menu Delete routes through DeleteAgentsDialog');
  const panel = fs.readFileSync(path.join(ROOT, 'app', 'components', 'ManageAgentsPanel.tsx'), 'utf8');
  assert(/<DeleteAgentsDialog/.test(panel) && /Select all shown/.test(panel) && /Delete selected/.test(panel), 'Manage agents panel uses DeleteAgentsDialog with Select all shown and Delete selected');
  assert(/delete-preview/.test(dialog) && /DELETE_REMOVES_COPY/.test(dialog) && /DELETE_KEEPS_COPY/.test(dialog), 'dialog renders the shared preview and permanent-data copy');
  assert(!/preview\.groups|delete-legacy-impact|sharedConversationImpactCopy|groupImpactLine/.test(dialog), 'dialog shows no stored-group impact (NOT-461)');
  assert(!('sharedConversationImpactCopy' in deletion) && !('groupImpactLine' in deletion), 'no group-impact copy helpers remain (NOT-461)');
  const visibleDialogCopy = dialog.split('\n').filter(line => !/^\s*(\/\/|import|\}|type )/.test(line));
  assert(!visibleDialogCopy.some(line => /group/i.test(line)), 'dialog renders no Group wording (NOT-461)');
  assert(!/group/i.test(deletion.DELETE_REMOVES_COPY), 'permanent-data copy uses no Group wording');
  console.log(`\n${failures === 0 ? 'TEST RESULT: PASS' : `TEST RESULT: FAIL (${failures} assertion(s))`}`);
  return failures === 0;
}

main()
  .then(ok => {
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.rmSync(DB_PATH + suffix, { force: true }); } catch { /* best effort */ }
    }
    process.exit(ok ? 0 : 1);
  })
  .catch(error => {
    console.error('bot-deletion test crashed:', error);
    try { fs.rmSync(DB_PATH, { force: true }); } catch { /* best effort */ }
    process.exit(1);
  });
