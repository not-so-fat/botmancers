#!/usr/bin/env node
// NOT-498: session Ask/Continue UI, inline exchange cards, and the Agent
// Exchanges ledger. Seeds real exchanges in every state (queued,
// extracting, delivering, completed Ask and Continue, failed, cancelled)
// through the canonical exchange store and leased dispatcher with a fake
// attempt adapter, then proves:
// - lib/exchange-ledger summaries: readable participants and session
//   titles, every linked thread, Cancel only when the API allows it,
//   stable newest-activity order, mode/state/Agent/conversation filters,
//   and no provider session, Work Request, or Attempt id;
// - GET /api/exchanges and GET /api/exchanges/:id (real route handlers);
// - ExchangeCard renders each state (server-rendered React markup) with
//   mode, participants, session label, objective/question, live state,
//   last update, details link, terminal outcome/failure, Cancel only when
//   permitted, and the same card by exchange id in every linked thread;
// - ledger helpers: filters, order, distinct loading/error/empty/filter-zero
//   states, event timeline wording without ids; the ledger page renders
//   its landmarks and filters;
// - session-row availability and the Ask/Continue dialog: recognizable
//   source context, required-field validation, the exact request payloads
//   (accepted by the server's body parser), and no session-id entry;
// - source contracts for accessibility (dialog semantics, Escape, focus
//   return, live status, reduced motion, rail entry, focus restored when
//   leaving a ledger detail);
// - a group-origin exchange: the group link opens the group thread page,
//   whose routes serve the thread and its card.
// Self-contained: isolated SQLite file and HOME, no network.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = __dirname;
const DB_PATH = path.join(os.tmpdir(), `botmancers-exchange-ui-${process.pid}.db`);
for (const suffix of ['', '-shm', '-wal']) fs.rmSync(DB_PATH + suffix, { force: true });
process.env.BOTMANCERS_DB_PATH = DB_PATH;
process.env.BOTMANCERS_NO_AUTOPROCESS = '1';
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'botmancers-exchange-ui-home-'));
process.env.HERMES_API_SERVER_KEY = 'fixture-hermes-key';

const { createJiti } = require('jiti');
const jiti = createJiti(__filename, { alias: { '@': ROOT }, jsx: { runtime: 'automatic' } });
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const dbModule = jiti('./lib/db.ts');
const service = jiti('./lib/agent-conversations.ts');
const dispatch = jiti('./lib/agent-dispatch.ts');
const ledger = jiti('./lib/exchange-ledger.ts');
const view = jiti('./lib/exchange-view.ts');
const catalog = jiti('./lib/session-catalog.ts');
const exchangeLib = jiti('./lib/session-exchanges.ts');
const ExchangeCard = jiti('./app/components/ExchangeCard.tsx').default;
const ExchangeDialog = jiti('./app/components/ExchangeDialog.tsx').default;
const ExchangesPage = jiti('./app/exchanges/page.tsx').default;
const { startRouteHost } = require('./test-support/acceptance/route-host');

const raw = dbModule.default;
const { engine, bots, groups, conversations, UI_OWNER_PRINCIPAL: OWNER } = dbModule;

const SECRETS = {
  dev: 'prov-dev-UI-SECRET-1111',
  rose: 'prov-rose-UI-SECRET-2222',
  tank: 'prov-tank-UI-SECRET-3333',
  iris: 'prov-iris-UI-SECRET-4444',
  ended: 'prov-dev-UI-ENDED-5555',
  scoutFresh: 'prov-scout-UI-FRESH-6666',
};

let failures = 0;
function assert(condition, label) {
  console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${label}`);
  if (!condition) failures += 1;
  return condition;
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(fn, label, timeoutMs = 5000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (fn()) return true;
    await sleep(5);
  }
  assert(false, `timed out waiting: ${label}`);
  return false;
}
const render = (Component, props) => renderToStaticMarkup(React.createElement(Component, props));

// ---------------------------------------------------------------------
// Fake attempt adapter. `script` decides each hop's result; a hop kind in
// `held` waits until released.
let script = () => ({ output: 'ok' });
const held = {};
function hold(kind) {
  let release;
  held[kind] = new Promise(resolve => { release = resolve; });
  return () => { delete held[kind]; release(); };
}
function hopKind(input) {
  const text = input.prompt.kind === 'conversation' ? input.prompt.history.map(entry => entry.content).join('\n') : input.prompt.text;
  if (text.includes('[Session Ask')) return 'ask';
  if (text.includes('[Session Continue handoff')) return 'extract';
  if (text.includes('[Session Continue]')) return 'deliver';
  return 'other';
}
dispatch.setAttemptAdapterOverride(() => ({
  name: 'hermes-gateway',
  async run(input, onEvent) {
    const kind = hopKind(input);
    const started = Date.now();
    onEvent({ type: 'started', adapter: 'hermes-gateway', at: started, externalRunId: null, externalSessionId: null });
    if (held[kind]) await held[kind];
    const out = script(input, kind);
    return {
      status: 'completed', adapter: 'hermes-gateway', externalRunId: null, externalSessionId: out.session ?? null,
      output: out.output, artifacts: [], startedAt: started, finishedAt: Date.now(), failure: null,
    };
  },
}));

function packetJson() {
  return JSON.stringify({
    objective: 'Ship the Agent Exchanges ledger',
    decisions: ['Cards read state from the exchange API'],
    constraints: ['No graph views'],
    artifacts: ['app/exchanges/page.tsx'],
    open_questions: [],
  });
}

function agent(name) {
  return bots.create({ name, title: 'Agent', description: `${name} fixture`, agent: 'hermes' });
}
function seedSession(bot, secret, key, intent) {
  const conv = conversations.getByBotId(bot.id);
  const { request } = engine.createOrGetWorkRequest({
    sourceConversationId: conv.id, sourceEventId: `seed-${key}`, requester: OWNER, targetAgentId: bot.id,
    intent, executionKind: 'implementation', toolProfile: 'edit', idempotencyKey: `seed-${key}`,
  });
  engine.transitionWorkRequest(request.id, { from: 'queued', to: 'running' });
  const attempt = engine.createAttempt(request.id, { kind: 'launch', adapter: 'hermes', toolProfile: 'edit', launchSnapshot: { seeded: true } });
  engine.finishAttempt(attempt.id, { outcome: 'succeeded', output: 'done', externalSessionId: secret });
  const binding = engine.bindSession({ agentId: bot.id, adapter: 'hermes', externalSessionId: secret, conversationId: conv.id, requestId: request.id, sourceAttemptId: attempt.id });
  engine.transitionWorkRequest(request.id, { from: 'running', to: 'completed', result: { reply_message_id: null } });
  return { binding, conv };
}

function input(fields) {
  return { requester: OWNER, ...fields };
}

async function main() {
  service.configureDispatcher({ owner: `exchange-ui-test:${process.pid}`, config: { maxGlobal: 10, maxPerTarget: 1, heartbeatMs: 600_000 } });
  const dev = agent('Dev');
  const scout = agent('Scout');
  const rose = agent('Rose');
  const tank = agent('Tank');
  const iris = agent('Iris');
  const conv = id => conversations.getByBotId(id);
  const devS = seedSession(dev, SECRETS.dev, 'dev', 'Add the session catalog read model\n\nUse session_bindings.');
  const roseS = seedSession(rose, SECRETS.rose, 'rose', 'Draft the exchange card copy');
  const tankS = seedSession(tank, SECRETS.tank, 'tank', 'Coordinate the review round');
  const irisS = seedSession(iris, SECRETS.iris, 'iris', 'Survey the ledger filters');
  const ids = {};

  console.log('Seed: exchanges in every state');
  // Completed Ask: Dev's session answers into Tank's thread.
  script = (_, kind) => (kind === 'ask' ? { output: 'The catalog reads session_bindings joined with attempts.' } : { output: 'x' });
  let started = service.createExchangeCommand(input({ idempotencyKey: 'ui-ask-done', mode: 'ask', originConversationId: conv(tank.id).id, sourceAgentId: dev.id, sessionRef: devS.binding.id, instruction: 'Which table does the catalog read?' }));
  await started.dispatched; await service.waitForAgentDispatchIdle();
  ids.askDone = started.exchange.id;
  // Failed Continue: the extraction is not a packet.
  script = (_, kind) => (kind === 'extract' ? { output: 'I would rather not.' } : { output: 'x' });
  started = service.createExchangeCommand(input({ idempotencyKey: 'ui-cont-failed', mode: 'continue', originConversationId: conv(dev.id).id, sourceAgentId: dev.id, sessionRef: devS.binding.id, destinationAgentId: scout.id, instruction: 'Hand the catalog to Scout' }));
  await started.dispatched; await service.waitForAgentDispatchIdle();
  ids.failed = started.exchange.id;
  // Completed Continue: Rose hands off to Scout.
  script = (_, kind) => (kind === 'extract' ? { output: packetJson() } : kind === 'deliver' ? { output: 'Picked up the ledger work.', session: SECRETS.scoutFresh } : { output: 'x' });
  started = service.createExchangeCommand(input({ idempotencyKey: 'ui-cont-done', mode: 'continue', originConversationId: conv(rose.id).id, sourceAgentId: rose.id, sessionRef: roseS.binding.id, destinationAgentId: scout.id, instruction: 'Scout continues the ledger' }));
  await started.dispatched; await service.waitForAgentDispatchIdle();
  ids.contDone = started.exchange.id;
  // Cancelled: queued, then cancelled before it ran.
  const toCancel = service.exchanges.create(input({ idempotencyKey: 'ui-cancelled', mode: 'ask', originConversationId: conv(dev.id).id, sourceAgentId: dev.id, sessionRef: devS.binding.id, instruction: 'Never mind this one' })).exchange;
  await service.cancelExchangeCommand(toCancel.id, OWNER, 'not needed');
  ids.cancelled = toCancel.id;
  // Extracting: Tank's Ask is held mid-turn.
  const releaseAsk = hold('ask');
  script = (_, kind) => (kind === 'ask' ? { output: 'Held answer.' } : { output: 'x' });
  ids.extracting = service.createExchangeCommand(input({ idempotencyKey: 'ui-extracting', mode: 'ask', originConversationId: conv(tank.id).id, sourceAgentId: tank.id, sessionRef: tankS.binding.id, instruction: 'Who reviews next?' })).exchange.id;
  await waitFor(() => service.exchanges.get(ids.extracting).state === 'extracting', 'Tank Ask extracting');
  // Delivering: Iris hands off to Scout; the delivery is held.
  const releaseDeliver = hold('deliver');
  script = (_, kind) => (kind === 'extract' ? { output: packetJson() } : kind === 'deliver' ? { output: 'Late.', session: 'prov-scout-UI-LATE-7777' } : { output: 'Held answer.' });
  ids.delivering = service.createExchangeCommand(input({ idempotencyKey: 'ui-delivering', mode: 'continue', originConversationId: conv(iris.id).id, sourceAgentId: iris.id, sessionRef: irisS.binding.id, destinationAgentId: scout.id, instruction: 'Scout finishes the filter survey' })).exchange.id;
  await waitFor(() => service.exchanges.get(ids.delivering).state === 'delivering', 'Iris Continue delivering');
  // Queued: created last, after every dispatch, so nothing claims it.
  ids.queued = service.exchanges.create(input({ idempotencyKey: 'ui-queued', mode: 'ask', originConversationId: conv(dev.id).id, sourceAgentId: dev.id, sessionRef: devS.binding.id, instruction: 'What is still open?' })).exchange.id;
  const states = Object.fromEntries(Object.entries(ids).map(([key, id]) => [key, service.exchanges.get(id).state]));
  assert(states.askDone === 'completed' && states.contDone === 'completed' && states.failed === 'failed' && states.cancelled === 'cancelled'
    && states.queued === 'queued' && states.extracting === 'extracting' && states.delivering === 'delivering', `seeded states ${JSON.stringify(states)}`);

  const secrets = [...Object.values(SECRETS), 'prov-scout-UI-LATE-7777'];
  const internalIds = () => {
    const rows = raw.prepare('SELECT source_binding_id, destination_binding_id, source_request_id, destination_request_id, source_attempt_id, destination_attempt_id, answer_message_id FROM session_exchanges').all();
    return rows.flatMap(row => Object.values(row)).filter(value => typeof value === 'string');
  };
  const leaks = text => [...secrets, ...internalIds()].filter(id => text.includes(id));

  console.log('Case 1: ledger read model');
  const all = ledger.listExchanges(raw, { requester: OWNER });
  const byId = Object.fromEntries(all.map(summary => [summary.id, summary]));
  assert(all.length === 7, 'all seven exchanges are listed for the owner');
  assert(ledger.listExchanges(raw, { requester: { kind: 'person', id: 'someone-else' } }).length === 0, 'another requester sees none');
  const order = all.map(summary => summary.id);
  assert(JSON.stringify(order) === JSON.stringify([...all].sort(view.byActivity).map(summary => summary.id)), 'server order equals newest activity first (byActivity)');
  assert(JSON.stringify(ledger.listExchanges(raw, { requester: OWNER }).map(summary => summary.id)) === JSON.stringify(order), 'order is stable across refresh');
  const askDone = byId[ids.askDone];
  assert(askDone.source.agent_name === 'Dev' && askDone.source.session_title === 'Add the session catalog read model', 'source Agent and catalog session title are readable');
  assert(askDone.origin.label === 'Tank thread' && askDone.origin.thread_agent_id === tank.id, 'Ask origin is the Tank thread');
  assert(askDone.links.map(link => `${link.label}:${link.roles.join('+')}`).join(',') === 'Tank thread:origin,Dev thread:source', 'Ask links its origin and source threads');
  assert(askDone.outcome.answer === 'The catalog reads session_bindings joined with attempts.', 'Ask outcome is the stored answer');
  const contDone = byId[ids.contDone];
  assert(contDone.destination.agent_name === 'Scout' && contDone.destination.session_title === 'Continue from Rose: Ship the Agent Exchanges ledger', 'Continue destination and its new session title are readable');
  assert(contDone.links.map(link => `${link.label}:${link.roles.join('+')}`).join(',') === 'Rose thread:origin+source,Scout thread:destination', 'Continue links origin/source and destination threads');
  assert(contDone.outcome.objective === 'Ship the Agent Exchanges ledger' && contDone.outcome.reply === 'Picked up the ledger work.', 'Continue outcome carries the packet objective and the destination reply');
  assert(byId[ids.failed].failure.code === 'packet_invalid' && byId[ids.failed].failure.message.length > 0, 'failure carries the stable code and message');
  const cancellable = all.filter(summary => summary.can_cancel).map(summary => summary.id).sort();
  assert(JSON.stringify(cancellable) === JSON.stringify([ids.queued, ids.extracting, ids.delivering].sort()), 'can_cancel is true exactly for non-terminal exchanges');
  assert(all.every(summary => summary.terminal === ['completed', 'failed', 'cancelled'].includes(summary.state)), 'terminal mirrors the state');
  assert(leaks(JSON.stringify(all)).length === 0, 'no provider session, Work Request, Attempt, binding, or message id in summaries');
  const q = query => ledger.listExchanges(raw, { requester: OWNER, ...query }).map(summary => summary.id).sort();
  assert(JSON.stringify(q({ mode: 'ask' })) === JSON.stringify([ids.askDone, ids.cancelled, ids.queued, ids.extracting].sort()), 'mode=ask filter');
  assert(JSON.stringify(q({ state: 'active' })) === JSON.stringify([ids.queued, ids.extracting, ids.delivering].sort()), 'state=active filter');
  assert(JSON.stringify(q({ agentId: scout.id })) === JSON.stringify([ids.failed, ids.contDone, ids.delivering].sort()), 'agent filter matches the destination too');
  assert(JSON.stringify(q({ conversationId: conv(tank.id).id })) === JSON.stringify([ids.askDone, ids.extracting].sort()), 'conversation filter: Tank thread is origin of two Asks');
  assert(JSON.stringify(q({ conversationId: conv(scout.id).id })) === JSON.stringify([ids.failed, ids.contDone, ids.delivering].sort()), 'conversation filter: Scout thread is destination of three Continues');
  assert(q({ conversationId: conv(iris.id).id }).includes(ids.delivering) && q({ conversationId: conv(scout.id).id }).includes(ids.delivering), 'the delivering exchange is linked from both its origin and destination threads');

  console.log('Case 2: owner routes');
  const host = await startRouteHost({ jiti, repoRoot: ROOT });
  try {
    const list = await host.owner('GET', '/api/exchanges');
    assert(list.status === 200 && list.json.exchanges.length === 7 && JSON.stringify(list.json.exchanges.map(item => item.id)) === JSON.stringify(order), 'GET /api/exchanges lists every exchange newest activity first');
    const scoped = await host.owner('GET', `/api/exchanges?conversation=${conv(scout.id).id}&mode=continue&state=delivering`);
    assert(scoped.status === 200 && scoped.json.exchanges.length === 1 && scoped.json.exchanges[0].id === ids.delivering, 'query filters combine');
    const bad = await host.owner('GET', '/api/exchanges?mode=debate');
    const badState = await host.owner('GET', '/api/exchanges?state=running');
    assert(bad.status === 400 && badState.status === 400, 'unknown mode or state is 400');
    const detail = await host.owner('GET', `/api/exchanges/${ids.contDone}`);
    assert(detail.status === 200 && detail.json.detail.summary.id === ids.contDone && detail.json.detail.packet.objective === 'Ship the Agent Exchanges ledger'
      && detail.json.detail.events.length >= 6, 'GET /api/exchanges/:id adds the ledger detail with packet and events');
    assert(leaks(list.text).length === 0 && leaks(JSON.stringify(detail.json.detail)).length === 0, 'route bodies carry no provider session id or internal hop ids');
  } finally {
    await host.close();
  }

  console.log('Case 3: inline exchange cards, one per state');
  const expectations = {
    queued: { label: 'Queued', cancel: true },
    extracting: { label: 'Asking the session', cancel: true },
    delivering: { label: 'Delivering handoff', cancel: true },
    askDone: { label: 'Answered', cancel: false, outcome: 'Answer in Tank thread: The catalog reads session_bindings' },
    contDone: { label: 'Handed off', cancel: false, outcome: 'Scout picked it up in a new session: Picked up the ledger work.' },
    failed: { label: 'Failed', cancel: false, outcome: 'The handoff packet is not a JSON object.', advice: 'Start a new Continue with a clearer objective.' },
    cancelled: { label: 'Cancelled', cancel: false, outcome: 'Cancelled before it finished.' },
  };
  for (const [key, expected] of Object.entries(expectations)) {
    const summary = byId[ids[key]];
    const html = render(ExchangeCard, { summary });
    const mode = summary.mode === 'ask' ? 'Ask' : 'Continue';
    const who = summary.mode === 'ask' ? `You → ${summary.source.agent_name}` : `${summary.source.agent_name} → ${summary.destination.agent_name}`;
    assert(html.includes(`data-exchange-id="${summary.id}"`) && html.includes(`data-exchange-state="${summary.state}"`), `${key}: card keyed by exchange id and typed by API state`);
    assert(html.includes(`>${mode}<`) && html.includes(who) && html.includes(`${summary.source.agent_name}&#x27;s session “${summary.source.session_title}”`), `${key}: mode, participants, and session label`);
    assert(html.includes(`role="status">${expected.label}<`), `${key}: live state "${expected.label}" in a status region`);
    assert(html.includes(summary.mode === 'ask' ? 'Question</span>' : 'Objective</span>') && html.includes(summary.instruction.slice(0, 20)), `${key}: question/objective summary`);
    assert(html.includes(`Updated ${view.formatExchangeTime(summary.updated_at)}`) && html.includes(`href="/exchanges?id=${summary.id}"`), `${key}: last update and details link`);
    assert(html.includes('>Cancel</button>') === expected.cancel, `${key}: Cancel ${expected.cancel ? 'offered' : 'absent'}`);
    if (expected.outcome) assert(html.replace(/&#x27;/g, "'").includes(expected.outcome), `${key}: terminal outcome shown`);
    if (expected.advice) assert(html.includes(expected.advice), `${key}: actionable failure advice`);
    assert(leaks(html).length === 0, `${key}: no provider or internal ids in the card`);
  }
  const origin = ledger.listExchanges(raw, { requester: OWNER, conversationId: conv(iris.id).id }).find(item => item.id === ids.delivering);
  const destination = ledger.listExchanges(raw, { requester: OWNER, conversationId: conv(scout.id).id }).find(item => item.id === ids.delivering);
  assert(render(ExchangeCard, { summary: origin }) === render(ExchangeCard, { summary: destination }), 'the same exchange renders the same card in its origin and destination threads');
  const pending = { ...byId[ids.queued], cancel_requested: true, can_cancel: false };
  const pendingHtml = render(ExchangeCard, { summary: pending });
  assert(pendingHtml.includes('role="status">Cancelling…<') && !pendingHtml.includes('>Cancel</button>'), 'a requested cancel shows Cancelling… and hides Cancel');
  // A message whose prose claims a state changes nothing: cards take only the summary.
  const card = fs.readFileSync(path.join(ROOT, 'app/components/ExchangeCard.tsx'), 'utf8');
  assert(!/content|messages|parse[A-Z]/.test(card.replace(/^\/\/.*$/gm, '')), 'ExchangeCard reads no message prose');

  console.log('Case 4: ledger helpers and page');
  const F = view.DEFAULT_LEDGER_FILTER;
  assert(view.ledgerRows(all, { ...F, mode: 'continue' }).every(item => item.mode === 'continue') && view.ledgerRows(all, { ...F, mode: 'continue' }).length === 3, 'mode filter Continue');
  assert(view.ledgerRows(all, { ...F, state: 'failed' }).map(item => item.id).join() === ids.failed, 'status filter Failed');
  assert(view.ledgerRows(all, { ...F, state: 'active' }).length === 3, 'status filter In progress');
  assert(view.ledgerRows(all, { ...F, agentId: rose.id }).map(item => item.id).join() === ids.contDone, 'Agent filter (source)');
  const zero = view.ledgerRows(all, { mode: 'ask', state: 'delivering', agentId: '' });
  assert(view.ledgerView(all, '', zero) === 'filtered-out' && view.ledgerView(null, '', []) === 'loading' && view.ledgerView(null, 'Could not load exchanges.', []) === 'error'
    && view.ledgerView([], '', []) === 'empty' && view.ledgerView(all, '', all) === 'rows', 'loading, error, empty, filter-zero, and rows are distinct');
  assert(JSON.stringify(view.ledgerRows([...all].reverse(), F).map(item => item.id)) === JSON.stringify(order), 'client order matches the server order whatever the input order');
  assert(view.ledgerAgents(all).map(item => item.name).join() === 'Dev,Iris,Rose,Scout,Tank', 'Agent filter options are every participant');
  let unlabeled = 0;
  let labelLeaks = 0;
  for (const id of Object.values(ids)) {
    const exchange = service.getExchangeView(id);
    const summary = byId[id];
    for (const event of exchange.events) {
      const label = view.eventLabel(event, summary);
      if (label === event.type.replace(/_/g, ' ')) unlabeled += 1;
      if (leaks(label).length > 0 || label.includes(id)) labelLeaks += 1;
    }
  }
  assert(unlabeled === 0, 'every seeded event type has readable timeline wording');
  assert(labelLeaks === 0, 'timeline wording carries no ids');
  const contEvents = service.getExchangeView(ids.contDone).events;
  assert(contEvents.every((event, index) => index === 0 || event.sequence > contEvents[index - 1].sequence), 'timeline events are in sequence order');
  const pageHtml = render(ExchangesPage, {});
  assert(pageHtml.includes('<main') && pageHtml.includes('<header') && /<h1[^>]*>Agent Exchanges<\/h1>/.test(pageHtml), 'ledger page has header, main, and its h1');
  assert(/role="group" aria-label="Mode"/.test(pageHtml) && ['All', 'Ask', 'Continue'].every(word => pageHtml.includes(`aria-pressed="${word === 'All'}">${word}<`)), 'All | Ask | Continue toggle buttons with pressed state');
  assert(/<label[^>]*>Status<select/.test(pageHtml) && /<label[^>]*>Agent<select/.test(pageHtml), 'Status and Agent filters are labelled selects');
  assert(pageHtml.includes('data-ledger-state="loading"') && pageHtml.includes('role="status"'), 'first paint is the loading state, announced');

  console.log('Case 5: session actions and the Ask/Continue dialog');
  const sessions = catalog.listAgentSessions(raw, dev.id, 'all');
  const resumable = sessions.find(row => row.ref === devS.binding.id);
  assert(view.sessionActionAvailability(resumable).available === true, 'a resumable session offers Ask and Continue');
  const endedBinding = engine.bindSession({ agentId: dev.id, adapter: 'hermes', externalSessionId: SECRETS.ended, conversationId: conv(scout.id).id });
  raw.prepare('UPDATE session_bindings SET released_at = ? WHERE id = ? AND released_at IS NULL').run(Date.now(), endedBinding.id);
  const ended = catalog.listAgentSessions(raw, dev.id, 'ended').find(row => row.ref === endedBinding.id);
  const endedWhy = view.sessionActionAvailability(ended);
  assert(endedWhy.available === false && /has ended/.test(endedWhy.reason), 'an ended session explains why actions are unavailable');
  const notResumable = view.sessionActionAvailability({ ...resumable, resumable: false });
  assert(notResumable.available === false && /can’t resume/.test(notResumable.reason), 'an active non-resumable session explains why');
  const agents = [dev, scout, rose].map(bot => ({ id: bot.id, name: bot.name }));
  const originThread = { conversationId: conv(dev.id).id, label: 'Dev thread' };
  const askHtml = render(ExchangeDialog, { mode: 'ask', session: resumable, agents, origin: originThread, onClose() {}, onStarted() {} });
  const contHtml = render(ExchangeDialog, { mode: 'continue', session: resumable, agents, origin: originThread, onClose() {}, onStarted() {} });
  for (const [name, html] of [['Ask', askHtml], ['Continue', contHtml]]) {
    assert(/role="dialog" aria-modal="true" aria-labelledby="[^"]+"/.test(html), `${name} dialog: modal dialog labelled by its title`);
    assert(html.includes('>Dev<') && html.includes('Add the session catalog read model') && html.includes('Last activity'), `${name} dialog: recognizable source Agent, title, and activity`);
    assert(!html.includes(resumable.ref) && !html.includes(SECRETS.dev) && !/<input/.test(html) && !/session id|session ID|session_ref/i.test(html), `${name} dialog: no session id shown or asked for`);
    assert(html.includes('Dev thread'), `${name} dialog: confirms the origin thread`);
    assert(/<button type="submit"[^>]*>Send<\/button>/.test(html) && html.includes('role="status"'), `${name} dialog: Send and a status region`);
  }
  assert(/<h2[^>]*>Ask from this context<\/h2>/.test(askHtml) && /<label[^>]*>Question<\/label>/.test(askHtml) && !askHtml.includes('<select'), 'Ask dialog: titled Ask from this context, question field, no destination picker');
  assert(/<h2[^>]*>Hand off to…<\/h2>/.test(contHtml) && /<label[^>]*>Hand off to<\/label><select/.test(contHtml) && /<label[^>]*>Objective<\/label>/.test(contHtml), 'Hand off dialog: titled Hand off to…, destination picker and objective field');
  assert(!askHtml.includes('Continue with') && !contHtml.includes('Continue with') && !askHtml.includes('Ask this session'), 'the old Ask this session / Continue with… copy is gone');
  const resumeRow = { ...resumable, route: 'provider' };
  const resumeHtml = render(ExchangeDialog, { mode: 'resume', session: resumeRow, agents, origin: originThread, onClose() {}, onStarted() {} });
  assert(/<h2[^>]*>Resume work here<\/h2>/.test(resumeHtml) && /<label[^>]*>Instruction<\/label>/.test(resumeHtml) && !resumeHtml.includes('<select'), 'Resume dialog: titled Resume work here, instruction field, no destination picker');
  assert(/<input[^>]*type="checkbox"/.test(resumeHtml) && !/<input[^>]*checked/.test(resumeHtml) && resumeHtml.includes('I approve edits by Dev in this session'), 'Resume dialog: an explicit, unticked approval of edits');
  assert(resumeHtml.includes('this exact session') && resumeHtml.includes('never moves to another session'), 'Resume dialog: says the turn stays on this exact session');
  assert(!resumeHtml.includes(resumable.ref) && !resumeHtml.includes(SECRETS.dev), 'Resume dialog: no session id shown');
  const resumeErrors = view.validateResumeDraft('', false);
  assert(resumeErrors.instruction && resumeErrors.approval && Object.keys(view.validateResumeDraft('Fix it', true)).length === 0, 'Resume requires an instruction and the approval');
  assert(JSON.stringify(view.pinRequestBody('resume', ' Fix it ', 'c1', true, 'k1')) === JSON.stringify({ action: 'resume', content: 'Fix it', conversation_id: 'c1', idempotency_key: 'k1', approve_write: true })
    && !('approve_write' in view.pinRequestBody('ask', 'Why?', 'c1', false, 'k2')), 'pin payloads: resume carries the approval, ask never does');
  assert(view.sessionDialogUsesPin('resume', 'engine') && view.sessionDialogUsesPin('ask', 'provider') && !view.sessionDialogUsesPin('ask', 'engine') && !view.sessionDialogUsesPin('continue', 'provider'),
    'Resume and a provider-only Ask pin the session; an engine Ask and Hand off stay exchanges');
  assert(view.sessionDialogMode('handoff') === 'continue' && view.sessionDialogMode('ask') === 'ask' && view.sessionDialogMode('resume') === 'resume', 'Hand off to… keeps the Continue exchange semantics');

  // NOT-507: row actions and tags per runtime state.
  const actionsLib = jiti('./lib/session-actions.ts');
  const sessionView = jiti('./lib/session-view.ts');
  const baseState = { availability: 'available', lifecycle: 'open', resumable: true, busy: false };
  const ctxFull = { route: 'provider', provider: { resume: true, authorities: ['read_only', 'workspace_write'] }, policy: { mode: 'workspace_write', allow_resume_with_edits: true } };
  const stateRow = (state, extra = {}) => {
    const row = { ...resumable, source: 'native', status: 'active', resumable: false, state: { ...baseState, ...state }, ...extra };
    return { ...row, route: 'provider', actions: actionsLib.sessionActions(row, ctxFull) };
  };
  const matrix = {
    open: stateRow({}),
    archived: stateRow({ lifecycle: 'archived' }),
    busy: stateRow({ busy: true }),
    missing: stateRow({ availability: 'missing', resumable: true }),
    notResumable: stateRow({ resumable: false }),
  };
  const avail = row => view.sessionRowActions(row).filter(item => item.availability.available).map(item => item.label).join('|');
  assert(avail(matrix.open) === 'Ask from this context|Resume work here', 'open native session: Ask and Resume; Hand off needs a Botmancers-launched session');
  assert(avail(matrix.archived) === 'Ask from this context|Resume work here' && sessionView.sessionStateTags(matrix.archived).includes('Archived'), 'archived but resumable: Ask and Resume, tagged Archived');
  const busyActions = view.sessionRowActions(matrix.busy);
  assert(avail(matrix.busy) === '' && busyActions.filter(i => i.action !== 'handoff').every(i => i.availability.code === 'source_session_busy' && i.availability.recovery === 'retry_later' && /Try again when it finishes/.test(i.availability.reason))
    && sessionView.sessionStateTags(matrix.busy).includes('Busy'), 'busy: no action, each says try again when the turn finishes, tagged Busy');
  const missingActions = view.sessionRowActions(matrix.missing);
  assert(avail(matrix.missing) === '' && missingActions.filter(i => i.action !== 'handoff').every(i => i.availability.code === 'session_missing' && /choose another session/.test(i.availability.reason))
    && JSON.stringify(sessionView.sessionStateTags(matrix.missing)) === JSON.stringify(['Missing']), 'missing: no action, recovery says choose another session, tagged Missing only');
  assert(avail(matrix.notResumable) === '', 'a session the runtime cannot resume offers no action');
  const readOnly = { ...matrix.open, actions: actionsLib.sessionActions({ ...matrix.open }, { ...ctxFull, policy: { mode: 'read_only', allow_resume_with_edits: false } }) };
  const ro = view.sessionRowActions(readOnly).find(i => i.action === 'resume').availability;
  assert(ro.available === false && ro.code === 'authority_not_allowed' && /policy is read only/.test(ro.reason) && ro.recovery === 'ask_owner', 'read-only policy: Resume unavailable with an owner recovery');
  const engineRow = { ...resumable, route: 'engine', home: true, actions: actionsLib.sessionActions({ ...resumable, source: 'botmancers', state: baseState }, { route: 'engine', provider: null, policy: null }) };
  assert(avail(engineRow) === 'Ask from this context|Hand off to…' && sessionView.sessionStateTags(engineRow)[0] === 'Home', 'Botmancers session: Ask and Hand off, Resume explains why not; the home session is tagged Home');
  const legacy = view.sessionRowActions({ status: 'active', resumable: true, agent: { name: 'Dev' } });
  assert(legacy.map(i => i.availability.available).join() === 'true,false,true', 'a row from an older server: Ask and Hand off, never Resume');
  assert(contHtml.includes(`value="${scout.id}">Scout<`) && !contHtml.includes(`value="${dev.id}"`), 'destination picker lists other Agents, never the source');
  assert(contHtml.includes('receives an extracted handoff') && contHtml.includes('new session of its own'), 'Continue explains the extracted handoff into a new session');
  const askDraft = { mode: 'ask', instruction: '', originConversationId: originThread.conversationId, destinationAgentId: '' };
  assert(view.validateDraft(askDraft).instruction === 'Enter a question.', 'Ask requires a question');
  assert(view.validateDraft({ ...askDraft, instruction: '   ' }).instruction === 'Enter a question.', 'whitespace is not a question');
  assert(view.validateDraft({ ...askDraft, instruction: 'x'.repeat(4001) }).instruction !== undefined, 'over-limit question refused');
  const contErrors = view.validateDraft({ ...askDraft, mode: 'continue' });
  assert(contErrors.destination && contErrors.instruction === 'Enter an objective.', 'Continue requires a destination and an objective');
  assert(Object.keys(view.validateDraft({ ...askDraft, instruction: 'Why?' })).length === 0, 'a complete Ask draft validates');
  const askBody = view.exchangeRequestBody({ ...askDraft, instruction: '  Why?  ' }, { agentId: dev.id, sessionRef: resumable.ref }, 'key-1');
  assert(JSON.stringify(askBody) === JSON.stringify({ mode: 'ask', idempotency_key: 'key-1', origin_conversation_id: originThread.conversationId, source: { agent_id: dev.id, session_ref: resumable.ref }, instruction: 'Why?' }), 'Ask payload: selected session, question, origin thread');
  const contBody = view.exchangeRequestBody({ ...askDraft, mode: 'continue', instruction: 'Finish it', destinationAgentId: scout.id }, { agentId: dev.id, sessionRef: resumable.ref }, 'key-2');
  assert(contBody.destination.agent_id === scout.id && contBody.instruction === 'Finish it' && contBody.source.session_ref === resumable.ref && contBody.mode === 'continue', 'Continue payload: selected session, destination Agent, objective');
  const parsedAsk = exchangeLib.exchangeInputFromBody(askBody, OWNER);
  const parsedCont = exchangeLib.exchangeInputFromBody(contBody, OWNER);
  assert(parsedAsk.sessionRef === resumable.ref && parsedAsk.destinationAgentId === null && parsedCont.destinationAgentId === scout.id, 'the server body parser accepts both payloads');
  assert(view.submitErrorMessage('source_session_busy', 'x').includes('already has an exchange in progress') && view.submitErrorMessage(null, null).includes('draft is kept'), 'server errors become actionable sentences');

  console.log('Case 6: accessibility and wiring source contracts');
  const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
  const dialogSrc = read('app/components/ExchangeDialog.tsx');
  const panelSrc = read('app/components/SessionsPanel.tsx');
  const pageSrc = read('app/agents/[id]/conversations/[conversationId]/ConversationDetail.tsx');
  const railSrc = read('app/components/AgentRail.tsx');
  const ledgerSrc = read('app/exchanges/page.tsx');
  const css = read('app/globals.css');
  assert(/e\.key !== 'Escape'[\s\S]*?e\.stopPropagation\(\);\s*onClose\(\)/.test(dialogSrc) && dialogSrc.includes("addEventListener('keydown', onKey, true)"), 'Escape closes only the dialog (capture + stopPropagation)');
  assert(dialogSrc.includes('wrapFocusTarget') && /instructionRef\.current\)\?\.focus\(\)/.test(dialogSrc), 'dialog contains Tab and focuses its first field');
  assert(/if \(submittingRef\.current\) return;/.test(dialogSrc) && /disabled=\{submitting\}/.test(dialogSrc), 'a pending submission blocks a second one');
  assert(/keyRef\.current\.payload !== payload/.test(dialogSrc), 'a retry of the unchanged draft reuses its idempotency key');
  assert(/aria-invalid=\{errors\.instruction/.test(dialogSrc) && /aria-describedby/.test(dialogSrc) && /role="alert">\{serverError\}/.test(dialogSrc), 'field errors are associated; server errors are alerts');
  assert(/returnTo\.focus\(\)/.test(panelSrc) && /if \(action \|\| !returnToRef\.current\) return;/.test(panelSrc) && /inert=\{!!action\}/.test(panelSrc), 'focus returns to the opening action; the review page is inert under the dialog');
  assert(/sessionRowActions\(row\)/.test(panelSrc) && /onAction\(sessionDialogMode\(item\.action\)/.test(panelSrc) && /className="session-unavailable"/.test(panelSrc) && !panelSrc.includes('Ask this session'), 'detail renders the three actions from the server answer and every unavailable reason');
  assert(/<button key=\{item\.action\} type="button"/.test(panelSrc) && !/disabled=\{!item/.test(panelSrc), 'only available actions are buttons, so keyboard focus never lands on a dead control');
  assert(/sessions\/\$\{encodeURIComponent\(session\.ref\)\}\/pins/.test(dialogSrc) && /approvalRef\.current\?\.focus\(\)/.test(dialogSrc), 'Resume posts to the owner pin route and focuses the missing approval');
  assert(/@media \(max-width: 799px\) \{\s*\.session-actions \{\s*flex-direction: column;/.test(css) && /\.exchange-approval input:focus-visible/.test(css), 'narrow screens stack the session actions; the approval has a focus ring');
  assert(/grid-template-columns: minmax\(18rem, 20rem\) minmax\(0, 1fr\)/.test(css), 'wide screens keep a narrow scan list and wide detail');
  assert(/<nav className="rail-nav" aria-label="Workspace">/.test(railSrc) && /href="\/exchanges"[^>]*>Exchanges</.test(railSrc), 'the shared rail exposes an Exchanges destination');
  assert(/\/api\/exchanges\?conversation=/.test(pageSrc) && /<ExchangeCard summary=\{exchange\}/.test(pageSrc) && /shownExchanges\.has\(exchange\.id\)/.test(pageSrc), 'threads render one card per linked exchange id from the API');
  assert(/aria-current=\{selected === summary\.id/.test(ledgerSrc) && /headingRef\.current\?\.focus\(\)/.test(ledgerSrc), 'ledger marks the selected row and moves focus to the detail heading');
  assert(/@media \(max-width: 799px\)\s*\{\s*\.ledger-page\.has-detail \.ledger-list-pane/.test(css), 'narrow ledger shows list or detail full-height, not squeezed columns');
  assert(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.exchange-card,/.test(css), 'reduced motion is honoured for the new surfaces');
  assert(/\.exchange-card a:focus-visible,[\s\S]*?outline: 2px solid var\(--accent\)/.test(css) && /\.session-action:focus-visible/.test(css), 'new controls get the accent focus ring');
  assert(/if \(selected \|\| !previous\) return;/.test(ledgerSrc) && /\.ledger-row\[data-exchange-id=/.test(ledgerSrc) && /\(row \?\? listTitleRef\.current\)\?\.focus\(\)/.test(ledgerSrc)
    && /ref=\{listTitleRef\} tabIndex=\{-1\}/.test(ledgerSrc), 'leaving a detail returns focus to its row, or to the list heading');
  const groupSrc = read('app/threads/[id]/route.ts');
  assert(/conversation_participants/.test(groupSrc) && /participant_kind = 'bot'/.test(groupSrc) && /\?exchange=/.test(groupSrc) && /redirect\(`\/agents\//.test(groupSrc),
    'the old group thread route resolves an Agent-scoped detail and preserves the focused exchange');

  console.log('Case 7: group-origin exchange backlinks');
  const room = groups.create('Design review', [rose.id, tank.id]);
  const roomConv = conversations.getByGroupId(room.id);
  const groupAsk = service.exchanges.create(input({ idempotencyKey: 'ui-group-ask', mode: 'ask', originConversationId: roomConv.id, sourceAgentId: rose.id, sessionRef: roseS.binding.id, instruction: 'What copy did the room agree on?' })).exchange;
  const groupSummary = ledger.listExchanges(raw, { requester: OWNER, conversationId: roomConv.id }).find(summary => summary.id === groupAsk.id);
  const groupLink = groupSummary && groupSummary.links.find(link => link.id === roomConv.id);
  assert(!!groupLink && groupLink.kind === 'group' && groupLink.thread_agent_id === null && groupLink.roles.includes('origin'), 'the group origin is a linked thread with no owner Agent');
  assert(view.threadHref(groupLink, groupAsk.id) === `/threads/${roomConv.id}?exchange=${groupAsk.id}`, 'the group link backlinks to its group thread page with the card focused');
  assert(groupSummary.links.every(link => link.kind === 'agent_api' || view.threadHref(link, groupAsk.id) !== null), 'every owner-visible linked thread has a backlink');
  assert(view.threadHref({ id: 'c1', kind: 'agent_api', thread_agent_id: null }) === null, 'an Agent API conversation has no backlink');
  const groupHost = await startRouteHost({ jiti, repoRoot: ROOT });
  try {
    const gConv = await groupHost.owner('GET', `/api/conversations/${roomConv.id}`);
    assert(gConv.status === 200 && gConv.json.details.name === 'Design review' && gConv.json.details.members.length === 2, 'the group thread page reads the group and its members');
    const gCards = await groupHost.owner('GET', `/api/exchanges?conversation=${roomConv.id}`);
    assert(gCards.status === 200 && gCards.json.exchanges.some(item => item.id === groupAsk.id), 'the group thread page reads its exchange card from the exchange API');
  } finally {
    await groupHost.close();
  }
  await service.cancelExchangeCommand(groupAsk.id, OWNER, 'test done');

  releaseAsk();
  releaseDeliver();
  await service.waitForAgentDispatchIdle();

  console.log(failures === 0 ? '\nAll exchange UI checks passed.' : `\n${failures} exchange UI check(s) failed.`);
  for (const suffix of ['', '-shm', '-wal']) fs.rmSync(DB_PATH + suffix, { force: true });
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
