#!/usr/bin/env node
// NOT-420: small snapshot-parity items (marketplace handoff hardening, skill
// end-token post-processing). NOT-461: agent-only UI surface assertions.
//
// Self-contained like test-approvals.js: isolated SQLite file, stub model at
// the model-call boundary, real route handlers invoked in-process. No dev
// server, no API key, no network.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DB_PATH = path.join(os.tmpdir(), `botmancers-parity-small-test-${process.pid}.db`);
for (const suffix of ['', '-shm', '-wal']) {
  try { fs.rmSync(DB_PATH + suffix, { force: true }); } catch { /* fresh start */ }
}
process.env.BOTMANCERS_DB_PATH = DB_PATH;
process.env.BOTMANCERS_NO_AUTOPROCESS = '1';
const SAVED_MARKET_URL = process.env.CLONE_MARKET_URL;
delete process.env.CLONE_MARKET_URL;

const ROOT = __dirname;
const { createJiti } = require('jiti');
const jiti = createJiti(__filename, { alias: { '@': ROOT } });
const db = jiti('./lib/db.ts');
const agent = jiti('./lib/agent.ts');
const handoff = jiti('./lib/market-handoff.ts');
const skills = jiti('./lib/skills.ts');
const draftLib = jiti('./lib/draft.ts');

const handoffRoute = jiti('./app/api/marketplace-handoff/route.ts');
const handoffStatusRoute = jiti('./app/api/marketplace-handoff/status/route.ts');

const { bots, conversations, messages } = db;

let failures = 0;
const tempSkills = [];

function log(line) {
  console.log(line);
}

function assert(condition, label) {
  if (condition) {
    log(`  PASS: ${label}`);
  } else {
    failures++;
    log(`  FAIL: ${label}`);
  }
  return condition;
}

function writeSkill(botName, contents) {
  const dir = path.join(process.cwd(), 'skills', botName);
  const file = path.join(dir, 'SKILL.md');
  tempSkills.push(file);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, contents);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function drain(cap = 20) {
  let processed = 0;
  while (processed < cap && await agent.processNextQueueItem()) {
    processed++;
    await sleep(3);
  }
  return processed;
}

async function ask(bot, conv, text) {
  messages.create(conv.id, 'user', text);
  db.queue.enqueue(conv.id, bot.id);
  await drain();
  return messages.getByConversation(conv.id);
}

function lastBotMessage(convId) {
  const thread = messages.getByConversation(convId).filter(m => m.sender_type === 'bot');
  return thread[thread.length - 1];
}

function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

async function main() {
  log('NOT-420 small-parity test (real handlers, isolated DB, stub model)');
  log(`DB: ${DB_PATH}`);

  // Return URL cleaning.
  log('\nReturn URL cleaning');
  const cleaned = handoff.cleanReturnUrl('http://user:pass@localhost:43123/path?a=1#fragment');
  assert(!!cleaned, 'dirty return URL parses');
  assert(cleaned.username === '' && cleaned.password === '', 'return URL strips userinfo');
  assert(cleaned.hash === '', 'return URL strips fragment');
  assert(
    cleaned.origin === 'http://localhost:43123' && cleaned.pathname === '/path' && cleaned.search === '?a=1',
    'return URL keeps origin, path and search'
  );
  assert(handoff.cleanReturnUrl('ftp://localhost:43123/x') === null, 'non-http(s) return rejected');
  assert(handoff.cleanReturnUrl('not a url') === null, 'unparseable return rejected');

  // Handoff destination.
  log('\nHandoff destination');
  assert(
    handoff.buildHandoffDestination(new URL('http://localhost:43123/'), {}) === null,
    'no destination when CLONE_MARKET_URL is unset'
  );
  assert(
    handoff.buildHandoffDestination(new URL('http://localhost:43123/'), { CLONE_MARKET_URL: '::bad::' }) === null,
    'no destination when CLONE_MARKET_URL is invalid'
  );
  const dest = handoff.buildHandoffDestination(
    new URL('http://localhost:43123/?imported=abc'),
    { CLONE_MARKET_URL: 'http://user:pw@market.test:99/old?x=1#frag' }
  );
  assert(!!dest, 'destination builds when configured');
  const destKeys = [...dest.searchParams.keys()];
  assert(
    destKeys.length === 2 && dest.searchParams.get('target') === 'botmancers',
    'destination keeps only target and return'
  );
  assert(
    dest.searchParams.get('return') === 'http://localhost:43123/?imported=abc',
    'destination return is the cleaned same-origin URL'
  );
  assert(
    dest.username === '' && dest.password === '' && dest.hash === '' && dest.host === 'market.test:99',
    'destination strips market userinfo, fragment and old query'
  );

  // Handoff query shape.
  log('\nHandoff query shape');
  const query = qs => new Request(`http://localhost:43123/api/marketplace-handoff${qs}`);
  assert(handoff.invalidHandoffQuery(query('')) === true, 'missing query is invalid');
  assert(handoff.invalidHandoffQuery(query('?return=http://localhost:43123/')) === false, 'exactly return is valid');
  assert(handoff.invalidHandoffQuery(query('?return=http://localhost:43123/&extra=1')) === true, 'extra parameter is invalid');
  assert(handoff.invalidHandoffQuery(query('?url=http://localhost:43123/')) === true, 'wrong parameter name is invalid');

  // Forwarded origin through the real route (CLONE_MARKET_URL unset: an
  // accepted origin reaches the 404, a rejected one stops at the 400).
  log('\nForwarded origin');
  const returnParam = encodeURIComponent('http://localhost:43123/?imported=x');
  const forwarded = await handoffRoute.GET(new Request(
    `http://127.0.0.1:43123/api/marketplace-handoff?return=${returnParam}`,
    { headers: { 'x-forwarded-host': 'localhost:43123' } }
  ));
  assert(forwarded.status === 404, `forwarded host accepted (got ${forwarded.status})`);
  assert(
    (await forwarded.json()).error === 'CLONE_MARKET_URL is not set.',
    'unconfigured market reports the snapshot message'
  );
  const unforwarded = await handoffRoute.GET(new Request(
    `http://127.0.0.1:43123/api/marketplace-handoff?return=${returnParam}`
  ));
  assert(unforwarded.status === 400, `127.0.0.1 vs localhost mismatch rejected without the header (got ${unforwarded.status})`);
  const protoMismatch = await handoffRoute.GET(new Request(
    `http://localhost:43123/api/marketplace-handoff?return=${returnParam}`,
    { headers: { 'x-forwarded-host': 'localhost:43123', 'x-forwarded-proto': 'https' } }
  ));
  assert(protoMismatch.status === 400, `forwarded proto honored (got ${protoMismatch.status})`);
  const evil = await handoffRoute.GET(new Request(
    `http://localhost:43123/api/marketplace-handoff?return=${encodeURIComponent('https://evil.com/steal')}`
  ));
  assert(evil.status === 400, `wrong origin rejected (got ${evil.status})`);

  // Configured redirect through the real route.
  log('\nConfigured redirect');
  process.env.CLONE_MARKET_URL = 'https://market.example/sub?old=1#frag';
  const dirty = encodeURIComponent('http://user:pass@localhost:43123/path#fragment');
  const redirect = await handoffRoute.GET(new Request(
    `http://localhost:43123/api/marketplace-handoff?return=${dirty}`
  ));
  assert(redirect.status === 307, `handoff redirects with 307 (got ${redirect.status})`);
  const location = new URL(redirect.headers.get('location'));
  const locationKeys = [...location.searchParams.keys()];
  assert(
    locationKeys.length === 2 && location.searchParams.get('target') === 'botmancers',
    'redirect keeps only target and return'
  );
  const redirectedReturn = new URL(location.searchParams.get('return'));
  assert(
    redirectedReturn.username === '' && redirectedReturn.password === '' && redirectedReturn.hash === '',
    'redirect return strips userinfo and fragment'
  );
  assert(
    redirectedReturn.origin === 'http://localhost:43123' && redirectedReturn.pathname === '/path',
    'redirect return keeps origin and path'
  );
  const statusOn = await handoffStatusRoute.GET();
  assert((await statusOn.json()).configured === true, 'status reports configured');
  delete process.env.CLONE_MARKET_URL;
  const statusOff = await handoffStatusRoute.GET();
  assert((await statusOff.json()).configured === false, 'status reports unconfigured');

  // End-token post-processor units.
  log('\nEnd-token post-processor');
  assert(skills.skillEndToken('Nobody-Here-Parity') === null, 'no skill means no token');
  writeSkill('Parityplain', 'Always be brief.');
  assert(skills.skillEndToken('Parityplain') === null, 'skill without the rule means no token');
  writeSkill('Paritymint', 'Always be brief.\nEvery reply ends with the exact token paritymint1');
  assert(skills.skillEndToken('Paritymint') === 'paritymint1', 'rule token parses from skill text');
  assert(
    skills.applySkillEndToken('Paritymint', 'hello') === 'hello\nparitymint1',
    'end token appended once'
  );
  assert(
    skills.applySkillEndToken('Paritymint', 'hello\nparitymint1') === 'hello\nparitymint1',
    'end token never doubled'
  );
  assert(
    skills.applySkillEndToken('Parityplain', 'hello') === 'hello',
    'bot without the rule passes through'
  );

  // End-token integration: model replies and ask questions carry the token
  // exactly once; draft JSON cards stay verbatim and parseable.
  log('\nEnd-token integration');
  const minter = bots.create({ deck_id: 'deck-test', name: 'Paritymint', title: '', description: 'Replies briefly.' });
  const mintConv = conversations.getByBotId(minter.id);
  agent.setDelegationChatStub(async () => 'hello there');
  await ask(minter, mintConv, 'Draft an email to Sam saying the demo moved to Friday');
  const draftCard = lastBotMessage(mintConv.id);
  assert(!!draftCard && draftLib.parseDraft(draftCard.content) !== null, 'draft card stays parseable for a skill bot');
  assert(!draftCard.content.includes('paritymint1'), 'draft JSON card stays verbatim');
  await ask(minter, mintConv, 'hi');
  const modelReply = lastBotMessage(mintConv.id);
  assert(modelReply.content === 'hello there\nparitymint1', 'model reply ends with the token once');
  assert(countOccurrences(modelReply.content, 'paritymint1') === 1, 'model reply never doubles the token');

  writeSkill('Parityask', 'Every reply ends with the exact token parityask1');
  const asker = bots.create({ deck_id: 'deck-test', name: 'Parityask', title: '', description: 'Asks first.' });
  const askConv = conversations.getByBotId(asker.id);
  await ask(asker, askConv, 'ask me one question: which city? then wait');
  const question = lastBotMessage(askConv.id);
  assert(!!question && question.content.endsWith('\nparityask1'), 'ask question ends with the token');
  assert(countOccurrences(question.content, 'parityask1') === 1, 'ask question never doubles the token');

  // End-token integration: the Hermes gateway mirror posts the token once on
  // both threads, and a retried mirror of the same round stays silent.
  log('\nEnd-token mirror');
  writeSkill('Parityspec', 'Every reply ends with the exact token parityspec1');
  const caller = bots.create({ deck_id: 'deck-test', name: 'Paritycaller', title: '', description: 'Delegates.' });
  const specialist = bots.create({ deck_id: 'deck-test', name: 'Parityspec', title: '', description: 'Replies briefly.' });
  const callerConv = conversations.getByBotId(caller.id);
  const specConv = conversations.getByBotId(specialist.id);
  const mirrorArgs = {
    callerConversationId: callerConv.id,
    caller,
    target: specialist,
    taskMessage: 'summarize the inbox',
    reply: 'three items need you',
  };
  const first = agent.mirrorSpecialistReply(mirrorArgs);
  assert(first.callerMessageId !== null && first.targetMessageId !== null, 'mirror posts to both threads');
  const callerPosted = messages.getByConversation(callerConv.id).find(m => m.id === first.callerMessageId);
  const targetPosted = messages.getByConversation(specConv.id).find(m => m.id === first.targetMessageId);
  assert(callerPosted.content === 'three items need you\nparityspec1', 'caller-thread mirror ends with the token once');
  assert(targetPosted.content === 'three items need you\nparityspec1', 'specialist-thread mirror ends with the token once');
  assert(countOccurrences(callerPosted.content, 'parityspec1') === 1, 'caller-thread mirror never doubles the token');
  const retry = agent.mirrorSpecialistReply(mirrorArgs);
  assert(retry.callerMessageId === null && retry.targetMessageId === null, 'retried mirror of the same round posts nothing');
  agent.setDelegationChatStub(null);

  // NOT-461: the UI is agent-only. No client source requests group data or
  // renders Group copy; stored groups stay a backend-only compatibility
  // surface (covered by test:group-semantics).
  log('\nAgent-only UI (NOT-461)');
  const clientSources = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (full !== path.join(ROOT, 'app', 'api')) walk(full);
      } else if (/\.tsx?$/.test(entry.name)) {
        clientSources.push(full);
      }
    }
  };
  walk(path.join(ROOT, 'app'));
  const groupCalls = clientSources.filter(file => /\/api\/groups|groupId=/.test(fs.readFileSync(file, 'utf8')));
  log(`  scanned ${clientSources.length} client sources; group API callers=${JSON.stringify(groupCalls.map(f => path.relative(ROOT, f)))}`);
  assert(groupCalls.length === 0, 'no client source requests /api/groups or /api/conversations?groupId=');
  // Per line, ignore comments, class names, and ARIA roles; flag "group" in
  // JSX text or string literals (user-visible copy).
  // A trailing ` //` comment is stripped only outside string literals, so a
  // URL inside a string cannot hide copy later on the same line.
  const stripTrailingComment = line => {
    let quote = null;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quote) {
        if (ch === '\\') i++;
        else if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'" || ch === '`') {
        quote = ch;
      } else if (ch === '/' && line[i + 1] === '/' && (i === 0 || /\s/.test(line[i - 1]))) {
        return line.slice(0, i);
      }
    }
    return line;
  };
  const copyLine = line => stripTrailingComment(line.replace(/^\s*(\/\/|\*|\/\*).*$/, ''))
    .replace(/className=(["'])[^"']*\1/g, '')
    .replace(/role="(radio)?group"/g, '');
  const groupCopy = clientSources.filter(file => fs.readFileSync(file, 'utf8').split('\n').map(copyLine).some(line =>
    />[^<{]*\bgroups?\b[^<]*</i.test(line) || /(['"`])[^'"`]*\bgroups?\b[^'"`]*\1/i.test(line)));
  const probe = ["const u = 'https://x.test // y'; const c = 'New group';", 'f(); // a group note'].map(copyLine);
  assert(/New group/.test(probe[0]) && !/group/.test(probe[1]), 'copy scan keeps strings containing // and strips real trailing comments');
  log(`  Group copy offenders=${JSON.stringify(groupCopy.map(f => path.relative(ROOT, f)))}`);
  assert(groupCopy.length === 0, 'no client source renders Group copy (ARIA role="group" excepted)');
  const page = fs.readFileSync(path.join(ROOT, 'app', 'page.tsx'), 'utf8');
  assert(!/group/i.test(page), 'app/page.tsx has no group type, state, loader, row, mention, or thread branch');
  assert((page.match(/>\s*New Agent\s*</g) || []).length === 1 && !/New Group|setKind|member-picks/.test(page), 'New opens one New Agent panel with no kind switch or member picker');
  assert(/const mentionItems = mentionOpen\s*\?\s*bots\.filter/.test(page), 'composer mentions suggest agents only');
  const deleteCopy = jiti('./lib/bot-deletion.ts');
  assert(!/group/i.test(deleteCopy.DELETE_REMOVES_COPY + deleteCopy.DELETE_KEEPS_COPY), 'delete confirmation copy names no groups');
  const css = fs.readFileSync(path.join(ROOT, 'app', 'globals.css'), 'utf8');
  assert(!/\.(group-error|member-picks|delete-groups)\b/.test(css), 'no Group-only styles remain');
  const seed = fs.readFileSync(path.join(ROOT, 'scripts', 'seed-design-fixture.js'), 'utf8');
  assert(/hidden by the agent-only UI/.test(seed), 'design fixture keeps legacy groups only as hidden stored data');
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  assert(!/create bots and groups/.test(readme) && /UI shows agents\s+only/.test(readme), 'README describes the agent-only UI');
  const parity = fs.readFileSync(path.join(ROOT, 'docs', 'PARITY.md'), 'utf8');
  assert(/## Agent-only UI \(NOT-461\)/.test(parity) && /RETIRED \(NOT-461\)/.test(parity) && !/MATCH — flat rows, group pills/.test(parity), 'PARITY.md no longer requires group UI captures');

  log(`\n${failures === 0 ? 'TEST RESULT: PASS' : `TEST RESULT: FAIL (${failures} assertion(s))`}`);
  return failures === 0;
}

function cleanup() {
  for (const file of tempSkills) {
    try { fs.rmSync(file, { force: true }); } catch { /* best effort */ }
    try { fs.rmdirSync(path.dirname(file)); } catch { /* best effort */ }
  }
  for (const suffix of ['', '-shm', '-wal']) {
    try { fs.rmSync(DB_PATH + suffix, { force: true }); } catch { /* best effort */ }
  }
  if (SAVED_MARKET_URL === undefined) delete process.env.CLONE_MARKET_URL;
  else process.env.CLONE_MARKET_URL = SAVED_MARKET_URL;
}

main()
  .then(ok => {
    cleanup();
    process.exit(ok ? 0 : 1);
  })
  .catch(error => {
    console.error('parity-small test crashed:', error);
    cleanup();
    process.exit(1);
  });
