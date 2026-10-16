#!/usr/bin/env node
// NOT-493: correlate an external MCP handoff (for example a Cursor Grok Bot
// invocation) with the durable Botmancers records it created.
//
//   node scripts/mcp-handoff-correlate.js --request-id <id> [--service grok-bot] [--key <idempotency_key>] [--db botmancers.db]
//
// Opens the database read-only and prints JSON: the direct request, its
// intake, the full request lineage with each requester, the coordinator's
// Wakes, the root request's engine event ids, and the canonical row counts
// for the service principal. The verdict says whether every request other
// than the direct read-only turn came from inside the lineage: an Agent's
// Wake (requester bot:<name>) or an engine continuation turn
// (service:botmancers-engine), i.e. the external principal gained no
// authority. It reads no
// token, Session Binding, external run/session id, or attempt output.
'use strict';

/* eslint-disable @typescript-eslint/no-require-imports -- standalone CommonJS operator script. */

const path = require('path');
const Database = require('better-sqlite3');

const MCP_IDEMPOTENCY_PREFIX = 'mcp:';
// lib/coordinator-loop.ts ENGINE_REQUESTER: the engine requests coordinator continuation turns.
const ENGINE_REQUESTER_ID = 'botmancers-engine';

function parseArgs(argv) {
  const options = { db: process.env.BOTMANCERS_DB_PATH || 'botmancers.db', service: null, key: null, requestId: null };
  const names = { '--db': 'db', '--service': 'service', '--key': 'key', '--request-id': 'requestId' };
  for (let i = 0; i < argv.length; i += 1) {
    const name = names[argv[i]];
    if (!name || argv[i + 1] === undefined) throw new Error(`unknown or incomplete option: ${argv[i]}`);
    options[name] = argv[i += 1];
  }
  if (!options.requestId) throw new Error('--request-id is required');
  return options;
}

function correlate({ db: dbPath, requestId, service, key }) {
  const db = new Database(path.resolve(dbPath), { readonly: true, fileMustExist: true });
  try {
    const one = (sql, ...params) => db.prepare(sql).get(...params);
    const all = (sql, ...params) => db.prepare(sql).all(...params);
    const agentName = id => (one('SELECT name FROM bots WHERE id = ?', id) || {}).name || id;
    const who = (kind, id) => `${kind}:${kind === 'bot' ? agentName(id) : id}`;

    const root = one('SELECT * FROM work_requests WHERE id = ?', requestId);
    if (!root) throw new Error(`request not found: ${requestId}`);
    const principal = service || (root.requester_kind === 'service' ? root.requester_id : null);
    const intake = one('SELECT requester_kind, requester_id, idempotency_key, surface, conversation_id, work_request_ids, created_at FROM conversation_intakes WHERE conversation_id = ? AND work_request_ids LIKE ?',
      root.source_conversation_id, `%${requestId}%`);
    const originOf = r => {
      if (r.parent_request_id === null) return 'external';
      if (r.requester_kind === 'bot') return 'wake';
      if (r.requester_kind === 'service' && r.requester_id === ENGINE_REQUESTER_ID) return 'engine_continuation';
      return 'unexpected';
    };
    const lineage = all('SELECT * FROM work_requests WHERE root_request_id = ? ORDER BY created_at, rowid', root.root_request_id).map(r => ({
      request_id: r.id,
      origin: originOf(r),
      requester: who(r.requester_kind, r.requester_id),
      target: agentName(r.target_agent_id),
      execution_kind: r.execution_kind,
      tool_profile: r.tool_profile,
      state: r.state,
      parent_request_id: r.parent_request_id,
      root_principal: r.root_principal_kind ? `${r.root_principal_kind}:${r.root_principal_id}` : null,
    }));
    const wakes = all('SELECT * FROM wakes WHERE root_request_id = ? ORDER BY created_at, position', root.root_request_id).map(w => ({
      wake_id: w.id,
      requester: agentName(w.requester_agent_id),
      target: w.target_agent_id ? agentName(w.target_agent_id) : w.requested_target,
      execution_kind: w.execution_kind,
      status: w.status,
      reason_code: w.reason_code,
      work_request_id: w.work_request_id,
    }));
    const events = all('SELECT id, sequence, type FROM engine_events WHERE request_id = ? ORDER BY sequence', requestId);
    const counts = principal ? {
      service: principal,
      intakes: one("SELECT COUNT(*) AS n FROM conversation_intakes WHERE requester_kind = 'service' AND requester_id = ?", principal).n,
      intakes_for_key: key === null ? null : one("SELECT COUNT(*) AS n FROM conversation_intakes WHERE requester_kind = 'service' AND requester_id = ? AND idempotency_key = ?", principal, `${MCP_IDEMPOTENCY_PREFIX}${key}`).n,
      direct_work_requests: one("SELECT COUNT(*) AS n FROM work_requests WHERE requester_kind = 'service' AND requester_id = ?", principal).n,
      work_requests_for_key: key === null ? null : one("SELECT COUNT(*) AS n FROM work_requests WHERE requester_kind = 'service' AND requester_id = ? AND idempotency_key LIKE ?", principal, `%${MCP_IDEMPOTENCY_PREFIX}${key}%`).n,
    } : null;

    const internal = lineage.filter(r => r.request_id !== root.id);
    const verdict = {
      direct_request_is_readonly_conversation: root.execution_kind === 'conversation' && root.tool_profile === 'readonly',
      direct_requester_is_external_service: root.requester_kind === 'service',
      all_other_requests_internal: internal.every(r => r.origin === 'wake' || r.origin === 'engine_continuation'),
      terminal: ['completed', 'failed', 'cancelled'].includes(root.state),
    };
    verdict.no_external_elevation = verdict.direct_request_is_readonly_conversation && verdict.all_other_requests_internal;
    return {
      request_id: root.id,
      conversation_id: root.source_conversation_id,
      intake: intake && { ...intake, work_request_ids: JSON.parse(intake.work_request_ids) },
      lineage,
      wakes,
      engine_events: events,
      counts,
      verdict,
    };
  } finally {
    db.close();
  }
}

if (require.main === module) {
  try {
    console.log(JSON.stringify(correlate(parseArgs(process.argv.slice(2))), null, 2));
  } catch (error) {
    console.error(`mcp-handoff-correlate: ${error.message}`);
    process.exit(2);
  }
}

module.exports = { correlate };
