// NOT-548: deterministic 788-session fixture for the paginated session
// list, shared by test-session-list-paging.js and
// scripts/seed-session-list-fixture.js (browser proof). One Agent
// ("Claude", adapter claude) owns COUNT native registry rows written
// straight to provider_sessions: varied stored titles (including a real
// unrecognizable one and blanks), four rotating workspaces, mixed
// open/archived lifecycles, and activity ties that pin the newest-first
// order. A second Agent owns one session in a shared workspace so the
// workspace filter must still scope to the Agent.
'use strict';

const COUNT = 788;
const BASE = Date.UTC(2026, 9, 20, 9, 0, 0);
const MIN = 60 * 1000;

const WORKSPACES = [
  '/Users/owner/work/botmancers',
  '/Users/owner/work/shop',
  '/Users/owner/work/blog',
  '/tmp/scratch',
];

function titleFor(i) {
  if (i === 3) return 'Reply with exactly: pong';
  if (i === 20) return '';
  if (i % 10 === 0) return null;
  if (i % 7 === 0) return `Fix login bug ${i}`;
  if (i % 7 === 1) return `Audit LOGIN flow ${i}`;
  return [`Refactor widget ${i}`, `Tune dashboard queries ${i}`, `Draft release notes ${i}`][i % 3];
}

function seedSessionList(dbModule, { count = COUNT } = {}) {
  const db = dbModule.default;
  const { bots } = dbModule;
  const agent = bots.create({ name: 'Claude', title: 'Implementer', description: 'Writes the code', agent: 'claude', deck_id: 'deck-builder' });
  const other = bots.create({ name: 'Archivist', title: 'Researcher', description: 'Reads things', agent: 'claude', deck_id: 'deck-builder' });

  const insert = db.prepare(`
    INSERT INTO provider_sessions (
      id, agent_id, runtime_connection_id, provider_kind, provider_session_id,
      binding_id, origin, title, workspace, provider_created_at, provider_updated_at,
      availability, lifecycle, resumable, busy, last_synced_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, NULL, 'discovered', ?, ?, ?, ?, 'available', ?, 1, 0, ?, ?, ?)
  `);
  const sessions = [];
  const seedOne = (id, owner, providerId, title, workspace, created, updated, lifecycle) => {
    insert.run(id, owner.id, 'conn-session-list', 'claude', providerId, title, workspace,
      created, updated, lifecycle, updated, created, updated);
    return { ref: id, title, workspace, created, updated, lifecycle };
  };

  for (let i = 0; i < count; i++) {
    const ref = `ses-list-${String(i).padStart(4, '0')}`;
    let created = BASE + i * MIN;
    let updated = created + 5 * MIN;
    // Ties that pin the order: 100/101 share activity (newer creation
    // first); 200/201 share both (reference ascending).
    if (i === 101) updated = BASE + 100 * MIN + 5 * MIN;
    if (i === 201) { created = BASE + 200 * MIN; updated = created + 5 * MIN; }
    sessions.push(seedOne(ref, agent, `prov-list-${i}-SECRET`, titleFor(i),
      i === 10 ? null : WORKSPACES[i % WORKSPACES.length],
      created, updated, i % 9 === 8 ? 'archived' : 'open'));
  }
  const foreign = seedOne('ses-list-foreign', other, 'prov-list-foreign-SECRET',
    'Foreign login notes', WORKSPACES[0], BASE, BASE + MIN, 'open');

  return { agent, other, sessions, foreign, BASE, MIN, COUNT: count, WORKSPACES };
}

module.exports = { COUNT, BASE, MIN, WORKSPACES, titleFor, seedSessionList };
