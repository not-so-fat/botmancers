#!/usr/bin/env node
// NOT-549: focused Agent-home contract. Seeds canonical Agent/session/skill
// authorities, checks the redacted Overview projection, and source-checks the
// route shell/navigation compatibility without requiring a browser.
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = require('./support/repo-root');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'botmancers-agent-home-'));
process.env.BOTMANCERS_DB_PATH = path.join(temp, 'agent-home.db');
process.env.BOTMANCERS_SKILLS_ROOT = path.join(temp, 'skills');
process.env.BOTMANCERS_NO_AUTOPROCESS = '1';
process.env.BOTMANCERS_CODEX_PROVIDER = 'off';

const { createJiti } = require('jiti');
const jiti = createJiti(__filename, { alias: { '@': ROOT } });
const dbModule = jiti('../lib/db.ts');
const { seedSessionCatalog, EXTERNAL_IDS } = require('./support/session-catalog-fixture');
const { writeSkillForBot } = jiti('../lib/skills.ts');
const { getAgentOverview, summarizeInstruction } = jiti('../lib/agent-overview.ts');

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

try {
  const fixture = seedSessionCatalog(dbModule);
  const { dev, scout, tank } = fixture.agents;
  dbModule.bots.updateIdentity(dev.id, dev.name, 'Release implementer', 'Own release implementation.\nKeep changes scoped and prove the user path.');
  writeSkillForBot(dev.name, '# Implementation skill\nBuild coherent slices and report evidence.');
  dbModule.default.prepare('UPDATE bots SET runtime_connection_id = NULL WHERE id = ?').run(scout.id);

  const devOverview = getAgentOverview(dev.id);
  const scoutOverview = getAgentOverview(scout.id);
  const tankOverview = getAgentOverview(tank.id);

  test('present rules and skill are summarized from canonical config authorities', () => {
    assert.equal(devOverview.agent.role, 'Release implementer');
    assert.match(devOverview.instructions.rules, /Own release implementation/);
    assert.equal(devOverview.instructions.skill_present, true);
    assert.match(devOverview.instructions.skill, /Build coherent slices/);
    assert.equal(summarizeInstruction('', 'empty'), 'empty');
  });

  test('launchable and blocked runtime states stay truthful', () => {
    assert.equal(devOverview.runtime.available, true);
    assert.equal(scoutOverview.runtime.available, false);
    assert.equal(scoutOverview.runtime.blocker, 'connection');
    assert.equal(scoutOverview.instructions.skill_present, false);
    assert.equal(scoutOverview.instructions.skill, 'No skill instructions are installed.');
  });

  test('active, recent, and empty work come from the agent session catalog', () => {
    assert.ok(devOverview.current_work.length > 0);
    assert.ok(devOverview.recent_work.some(row => row.status === 'ended'));
    assert.equal(tankOverview.current_work.length, 0);
    assert.equal(tankOverview.recent_work.length, 0);
  });

  test('Overview DTO does not leak external provider sessions or secret-bearing fields', () => {
    const serialized = JSON.stringify(devOverview);
    for (const secret of Object.values(EXTERNAL_IDS)) assert.equal(serialized.includes(secret), false);
    for (const field of ['token', 'grant_secret', 'provider_session_id', 'working_directory', 'model']) {
      assert.equal(Object.prototype.hasOwnProperty.call(devOverview, field), false);
      assert.equal(serialized.includes(`"${field}"`), false);
    }
  });

  const home = fs.readFileSync(path.join(ROOT, 'app/page.tsx'), 'utf8');
  const shell = fs.readFileSync(path.join(ROOT, 'app/agents/[id]/AgentShell.tsx'), 'utf8');
  const rail = fs.readFileSync(path.join(ROOT, 'app/components/AgentRail.tsx'), 'utf8');
  const overviewPage = fs.readFileSync(path.join(ROOT, 'app/agents/[id]/page.tsx'), 'utf8');
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');
  const overviewDto = fs.readFileSync(path.join(ROOT, 'lib/agent-overview.ts'), 'utf8');
  const dtoShape = overviewDto.slice(overviewDto.indexOf('export interface AgentOverviewDto'), overviewDto.indexOf('export function summarizeInstruction'));

  test('populated startup and rail selection route to Agent Overview', () => {
    assert.match(home, /router\.replace\(`\/agents\/\$\{encodeURIComponent\(first\.id\)\}/);
    assert.match(rail, /router\.push\(`\/agents\/\$\{encodeURIComponent\(agent\.id\)\}`\)/);
    assert.match(home, /<AgentRail/);
    assert.match(shell, /<AgentRail/);
  });

  test('zero-Agent and invalid-Agent states remain explicit', () => {
    assert.match(home, /const noBots = botsLoaded && bots\.length === 0/);
    assert.match(overviewPage, /Agent not found/);
    assert.match(overviewPage, /This agent does not exist or was removed/);
  });

  test('shared shell exposes the full selected-tab navigation contract', () => {
    for (const label of ['Overview', 'Sessions', 'Conversations', 'Slack', 'Activity', 'Config']) assert.ok(shell.includes(`label: '${label}'`));
    assert.match(shell, /segment: 'config'/);
    assert.match(shell, /aria-current=\{selectedTab \? 'page'/);
    assert.match(shell, /Runtime and availability/);
    for (const behavior of ['Hidden', 'Mark as Unread', 'Rename agent', 'Hide from sidebar', 'Delete agent…', 'ArrowDown', 'onContextMenu']) {
      assert.ok(rail.includes(behavior), behavior);
    }
  });

  test('shell refreshes roster, runtime, availability, and work without navigation', () => {
    assert.match(shell, /setInterval\(\(\) => \{ void load\(isCancelled\); \}, 2000\)/);
    assert.match(shell, /fetch\('\/api\/bots'/);
    assert.match(shell, /\/overview`/);
  });

  test('delete confirmation survives the Overview redirect', () => {
    assert.match(home, /deletedCountRef\.current = deleted/);
    assert.match(home, /\?deleted=\$\{deleted\}/);
    assert.match(shell, /Number\(searchParams\.get\('deleted'\)\)/);
    assert.match(shell, /deleted > 0 \? deletedStatusLine\(deleted\) : ''/);
  });

  test('legacy conversation, exchange, session, and Config deep links remain reachable', () => {
    assert.match(home, /query\.get\('exchange'\)/);
    assert.match(home, /query\.get\('sessions'\) === '1'[\s\S]*?\/agents\/\$\{encodeURIComponent\(linkedAgent\)\}\/sessions/);
    assert.match(overviewPage, /\/agents\/\$\{encodeURIComponent\(id\)\}\/conversations\/\$\{encodeURIComponent\(overview\.conversation\.id\)\}/);
    assert.match(overviewPage, /\/agents\/\$\{encodeURIComponent\(id\)\}\/config/);
    assert.match(fs.readFileSync(path.join(ROOT, 'app/bots/[id]/config/page.tsx'), 'utf8'), /\/agents\/\$\{encodeURIComponent\(id\)\}\/config/);
  });

  test('Overview has no ambient thread or composer', () => {
    assert.equal(overviewPage.includes('Say something'), false);
    assert.equal(overviewPage.includes('<textarea'), false);
    assert.equal(overviewPage.includes('className="composer'), false);
    assert.match(overviewPage, /Open conversation/);
  });

  test('Overview opens reachability paths before direct chat, with the local setup command', () => {
    assert.equal(overviewPage.includes('agent-hero'), false);
    assert.equal(overviewPage.includes('agent-capabilities'), false);
    assert.equal(overviewPage.includes('Full Config'), false);
    assert.equal(overviewPage.includes('github.com/not-so-fat/botmancers'), false);
    assert.equal((overviewPage.match(/>Config</g) || []).length >= 2, true);
    for (const text of [
      'Make it reachable',
      'Use from a coding agent',
      'Share a session to Slack',
      'Message in Botmancers',
      'Click your client to copy it',
      'Copy setup command for a coding client',
    ]) {
      assert.ok(overviewPage.includes(text), text);
    }
    for (const text of [
      "id: 'cursor'",
      "id: 'codex'",
      "id: 'claude'",
      "label: 'Cursor'",
      "label: 'Codex'",
      "label: 'Claude Code'",
      'botmancers setup --client ${id}',
    ]) {
      assert.ok(overviewPage.includes(text), text);
    }
    assert.equal(overviewPage.includes('Swap <code>cursor</code>'), false);
    assert.equal(overviewPage.includes("'Copy setup command'"), false);
    assert.equal(overviewPage.includes('BRIDGE_SETUP_COMMAND'), false);
    assert.ok(overviewPage.includes('HarnessIcon'), 'setup clients use HarnessIcon');
    assert.equal(overviewPage.includes('TopBarCapacity'), false, 'capacity stays off Make it reachable');
    assert.equal(overviewPage.includes('AgentCapacity'), false, 'no per-Agent shell capacity chips');
    assert.ok(shell.includes('HarnessIcon') && shell.includes('TopBarCapacity'), 'Agent shell uses top-bar capacity');
    assert.equal(shell.includes('AgentCapacity'), false, 'shell no longer mounts per-Agent capacity chips');
    const coding = overviewPage.indexOf('Use from a coding agent');
    const slack = overviewPage.indexOf('Share a session to Slack');
    const direct = overviewPage.indexOf('Message in Botmancers');
    assert.ok(coding < slack && slack < direct, 'coding agent and Slack precede direct Botmancers chat');
    assert.equal(/token|grant_secret|provider_session_id|working_directory|model/i.test(dtoShape), false);
    assert.equal(overviewPage.includes('<select'), false);
    assert.equal(/label[^>]*>\s*(Runtime|Model|Provider session)/i.test(overviewPage), false);
  });

  test('coding-agent card splits into Install and Ask steps that name the Agent', () => {
    const card = overviewPage.slice(overviewPage.indexOf('Use from a coding agent'), overviewPage.indexOf('Share a session to Slack'));
    const step1 = card.indexOf('Step 1</span> Install in your coding agent');
    const step2 = card.indexOf('Step 2</span> Ask it to talk to {overview.agent.name}');
    assert.ok(step1 > 0 && step2 > step1, 'Step 1 precedes Step 2 inside card 01');
    assert.ok(card.includes('Run this where your coding agent runs (the one that will ask {overview.agent.name}), not on this registered agent.'));
    assert.ok(card.indexOf('<BridgeSetupClients />') > step1 && card.indexOf('<BridgeSetupClients />') < step2, 'client buttons live in Step 1');
    assert.ok(card.indexOf('<AskAgentPrompt agentName={overview.agent.name} />') > step2, 'prompt lives in Step 2');
    assert.ok(card.includes('Your coding agent sends the question to {overview.agent.name}, waits for the answer, and can read the conversation.'));
    for (const tool of ['botmancers_health', 'botmancers_start_task', 'botmancers_get_request', 'botmancers_get_conversation']) {
      assert.equal(overviewPage.includes(tool), false, `no MCP tool name ${tool} on Overview`);
    }
    assert.match(overviewPage, /\{copied \? 'Copied' : 'Copy'\}/);
    assert.match(overviewPage, /if \(await copyText\(prompt\)\) \{\s*setCopied\(true\)/);
    assert.match(overviewPage, /if \(await copyText\(setupCommand\(id\)\)\) \{\s*setCopied\(id\)/);
  });

  test('release-check workflow runs the Agent-home and roster suites via npm test', () => {
    assert.match(workflow, /run: npm test/);
    assert.match(workflow, /npm run release:check/);
    const scripts = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts;
    for (const alias of ['test:agent-home', 'test:roster-a11y']) {
      const target = (scripts[alias].match(/node\s+(\S+)/) || [])[1];
      assert.ok(target && fs.existsSync(path.join(ROOT, target)), `${alias} still resolves to an existing suite (${target})`);
    }
  });
} finally {
  dbModule.default.close();
  fs.rmSync(temp, { recursive: true, force: true });
}

(async () => {
  // Page files may not export helpers, so evaluate the marked helper block of page.tsx directly.
  const overviewSource = fs.readFileSync(path.join(ROOT, 'app/agents/[id]/page.tsx'), 'utf8');
  const startMarker = '// --- reach-copy helpers';
  const endMarker = '// --- end reach-copy helpers ---';
  assert.ok(overviewSource.includes(startMarker) && overviewSource.includes(endMarker), 'page.tsx keeps the marked reach-copy helper block');
  const helperTs = overviewSource.slice(overviewSource.indexOf(startMarker), overviewSource.indexOf(endMarker));
  const ts = require('typescript');
  const helperJs = ts.transpileModule(`${helperTs}\nmodule.exports = { askAgentPrompt, setupCommand, copyText, BRIDGE_CLIENTS };`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const helperModule = { exports: {} };
  new Function('module', 'exports', helperJs)(helperModule, helperModule.exports);
  const { askAgentPrompt, setupCommand, copyText, BRIDGE_CLIENTS } = helperModule.exports;

  assert.equal(askAgentPrompt('Atlas'), 'Use Botmancers to ask Atlas: <your question>');
  assert.deepEqual(BRIDGE_CLIENTS.map(client => setupCommand(client.id)), [
    'botmancers setup --client cursor',
    'botmancers setup --client codex',
    'botmancers setup --client claude',
  ]);
  passed++;
  console.log('ok - Step 2 prompt interpolates the Agent name; setup commands are unchanged');

  const written = [];
  const okClipboard = { writeText: async text => { written.push(text); } };
  assert.equal(await copyText(askAgentPrompt('Atlas'), okClipboard), true);
  assert.deepEqual(written, ['Use Botmancers to ask Atlas: <your question>']);
  const failingClipboard = { writeText: async () => { throw new Error('denied'); } };
  assert.equal(await copyText(askAgentPrompt('Atlas'), failingClipboard), false, 'failed write reports no copy');
  passed++;
  console.log('ok - copy writes exactly the prompt and reports failure so no Copied state is shown');

  console.log(`\n${passed} passed`);
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
