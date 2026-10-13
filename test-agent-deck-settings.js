#!/usr/bin/env node
// NOT-443 workspace Agent Deck settings + verified deck discovery
// (deterministic, no network). Proves: one persisted server URL with the
// loopback default; discovery issues exactly one credential-free
// GET <url>/api/launch/decks and validates success/data/decks/id/name;
// connection and GRANT_REQUIRED failures surface the single attempted
// URL and never retry through /api/decks or the local CLI.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DB_PATH = path.join(os.tmpdir(), `botmancers-agent-deck-settings-test-${process.pid}.db`);
for (const suffix of ['', '-shm', '-wal']) {
  try { fs.rmSync(DB_PATH + suffix, { force: true }); } catch { /* fresh start */ }
}
process.env.BOTMANCERS_DB_PATH = DB_PATH;
process.env.BOTMANCERS_NO_AUTOPROCESS = '1';

const { createJiti } = require('jiti');
const jiti = createJiti(__filename);
const db = jiti('./lib/db.ts');
const settings = jiti('./lib/agent-deck-settings.ts');
const deckRun = jiti('./lib/agent-deck-run.ts');

let failures = 0;

function log(line) {
  console.log(line);
}

function assert(condition, label) {
  if (condition) {
    log(`  PASS: ${label}`);
  } else {
    failures += 1;
    log(`  FAIL: ${label}`);
  }
}

async function main() {
  log('NOT-443 agent-deck settings + discovery test (isolated DB, stubbed fetch)');
  log(`DB: ${DB_PATH}`);

  // --- Criterion 1: one workspace URL with the loopback default.
  log('\nSettings API round-trip (workspace URL store)');
  db.workspaceSettings.clearForTests();
  const freshDefault = settings.getAgentDeckServerUrl();
  log(`default fixture: no stored value reads back server_url=${JSON.stringify(freshDefault)} (expected ${JSON.stringify(settings.DEFAULT_AGENT_DECK_SERVER_URL)})`);
  assert(freshDefault === settings.DEFAULT_AGENT_DECK_SERVER_URL, 'default reads http://127.0.0.1:1111 when nothing stored');

  const saved = settings.setAgentDeckServerUrl('http://127.0.0.1:2222/');
  log(`save fixture: stored raw "http://127.0.0.1:2222/" normalized to server_url=${JSON.stringify(saved)}`);
  assert(saved === 'http://127.0.0.1:2222', 'save normalizes the URL (trailing slash stripped)');

  const reloaded = settings.getAgentDeckServerUrl();
  const rawRow = db.workspaceSettings.get(settings.AGENT_DECK_SERVER_URL_KEY);
  log(`reload fixture: raw row=${JSON.stringify(rawRow)} reread server_url=${JSON.stringify(reloaded)}`);
  assert(reloaded === 'http://127.0.0.1:2222' && rawRow === 'http://127.0.0.1:2222', 'reload returns the saved URL from persistence');

  for (const bad of ['not-a-url', '', '   ', 'ftp://example.com/x']) {
    let threw = false;
    let message = '';
    try {
      settings.setAgentDeckServerUrl(bad);
    } catch (error) {
      threw = true;
      message = error instanceof Error ? error.message : String(error);
    }
    log(`invalid-URL fixture: input=${JSON.stringify(bad)} rejected=${threw} error=${JSON.stringify(message.slice(0, 120))}`);
    assert(threw, `invalid URL is rejected: ${JSON.stringify(bad)}`);
  }
  // Restore the default for the discovery sections below.
  settings.setAgentDeckServerUrl(settings.DEFAULT_AGENT_DECK_SERVER_URL);

  // Prove the local CLI is never a discovery path: any CLI spawn fails.
  let cliCalls = 0;
  deckRun.setDeckRunProcess(async argv => {
    cliCalls += 1;
    return { stdout: '', stderr: `unexpected CLI call: ${argv.join(' ')}`, exitCode: 1 };
  });

  // --- Criterion 2: verified launch route only, no credentials.
  log('\nDeck discovery (verified launch route)');
  const seen = [];
  const verifiedBody = { success: true, data: { decks: [{ id: 'deck-b', name: 'Beta' }, { id: 'deck-a', name: 'Alpha' }] } };
  const captureFetch = async (url, init) => {
    seen.push({ url: String(url), method: init && init.method, headers: init && init.headers });
    return { json: async () => verifiedBody };
  };
  const decks = await settings.listAgentDecks({ serverUrl: 'http://127.0.0.1:1111', fetchImpl: captureFetch });
  const captured = seen[0] || {};
  log(`captured request method=${JSON.stringify(captured.method)} URL=${JSON.stringify(captured.url)} headers=${JSON.stringify(captured.headers ?? null)}`);
  log(`verified response fixture: ${JSON.stringify(verifiedBody)}`);
  log(`validated decks: ${JSON.stringify(decks)}`);
  assert(seen.length === 1, 'discovery issues exactly one HTTP request');
  assert(captured.method === 'GET', 'discovery uses GET');
  assert(captured.url === 'http://127.0.0.1:1111/api/launch/decks', 'discovery requests only GET <url>/api/launch/decks');
  const headerText = JSON.stringify(captured.headers ?? {}).toLowerCase();
  assert(!headerText.includes('authorization') && !headerText.includes('cookie') && !headerText.includes('api-key') && !headerText.includes('apikey'), 'discovery sends no credentials');
  assert(
    Array.isArray(decks) && decks.length === 2 && decks[0].id === 'deck-a' && decks[1].id === 'deck-b',
    'discovery returns stable sorted ID/name choices'
  );

  const malformed = [
    ['success-false', { success: false, data: { decks: [] } }],
    ['missing-data', { success: true }],
    ['decks-not-array', { success: true, data: { decks: 'nope' } }],
    ['blank-id', { success: true, data: { decks: [{ id: '  ', name: 'Alpha' }] } }],
    ['missing-name', { success: true, data: { decks: [{ id: 'deck-a' }] } }],
    ['null-body', null],
  ];
  for (const [label, body] of malformed) {
    let threw = false;
    let attempted = [];
    try {
      await settings.listAgentDecks({
        serverUrl: 'http://127.0.0.1:1111',
        fetchImpl: async url => ({ json: async () => body }),
      });
    } catch (error) {
      threw = true;
      attempted = (error && error.attemptedUrls) || [];
    }
    log(`malformed-response failure fixture ${label}: body=${JSON.stringify(body)} rejected=${threw} attemptedUrls=${JSON.stringify(attempted)}`);
    assert(threw, `malformed payload is rejected: ${label}`);
    assert(attempted.length === 1 && attempted[0] === 'http://127.0.0.1:1111/api/launch/decks', `malformed ${label} attempts only the launch route`);
  }

  // --- Criterion 3: connection + GRANT_REQUIRED never retry elsewhere.
  log('\nDiscovery failures (no /api/decks retry, no CLI fallback)');
  const connSeen = [];
  let connError = null;
  try {
    await settings.listAgentDecks({
      serverUrl: 'http://127.0.0.1:1111',
      fetchImpl: async url => {
        connSeen.push(String(url));
        throw new Error('fetch failed');
      },
    });
  } catch (error) {
    connError = error;
  }
  const connAttempted = (connError && connError.attemptedUrls) || [];
  log(`connection failure attempted URL list: ${JSON.stringify(connAttempted)} (fetch calls=${connSeen.length})`);
  log(`connection failure error: ${JSON.stringify(String((connError && connError.message) || connError).slice(0, 200))}`);
  assert(!!connError, 'connection failure throws an actionable error');
  assert(connAttempted.length === 1 && connAttempted[0] === 'http://127.0.0.1:1111/api/launch/decks', 'connection failure attempts only /api/launch/decks');
  assert(connSeen.length === 1 && !connSeen.some(u => u === 'http://127.0.0.1:1111/api/decks'), 'connection failure never retries through /api/decks');

  const grantSeen = [];
  let grantError = null;
  try {
    await settings.listAgentDecks({
      serverUrl: 'http://127.0.0.1:1111',
      fetchImpl: async url => {
        grantSeen.push(String(url));
        return { json: async () => ({ success: false, error: { code: 'GRANT_REQUIRED', message: 'grant required' } }) };
      },
    });
  } catch (error) {
    grantError = error;
  }
  const grantAttempted = (grantError && grantError.attemptedUrls) || [];
  log(`GRANT_REQUIRED failure attempted URL list: ${JSON.stringify(grantAttempted)} (fetch calls=${grantSeen.length})`);
  log(`GRANT_REQUIRED failure error: ${JSON.stringify(String((grantError && grantError.message) || grantError).slice(0, 200))}`);
  assert(!!grantError, 'GRANT_REQUIRED throws an actionable error');
  assert(grantAttempted.length === 1 && grantAttempted[0] === 'http://127.0.0.1:1111/api/launch/decks', 'GRANT_REQUIRED attempts only /api/launch/decks');
  assert(grantSeen.length === 1 && !grantSeen.some(u => u === 'http://127.0.0.1:1111/api/decks'), 'GRANT_REQUIRED never retries through /api/decks');
  assert(cliCalls === 0, 'discovery never falls back to the local CLI');

  deckRun.resetDeckRunProcessForTests();

  log(`\n${failures === 0 ? 'TEST RESULT: PASS' : `TEST RESULT: FAIL (${failures} assertion(s))`}`);
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
    console.error('agent-deck-settings test crashed:', error);
    try { fs.rmSync(DB_PATH, { force: true }); } catch { /* best effort */ }
    process.exit(1);
  });
