#!/usr/bin/env node
// NOT-549: focused Agent-home contract. Seeds canonical Agent/session/skill
// authorities, checks the redacted Overview projection, and source-checks the
// route shell/navigation compatibility without requiring a browser.
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = __dirname;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'botmancers-agent-home-'));
process.env.BOTMANCERS_DB_PATH = path.join(temp, 'agent-home.db');
process.env.BOTMANCERS_SKILLS_ROOT = path.join(temp, 'skills');
process.env.BOTMANCERS_NO_AUTOPROCESS = '1';
process.env.BOTMANCERS_CODEX_PROVIDER = 'off';

const { createJiti } = require('jiti');
const jiti = createJiti(__filename, { alias: { '@': ROOT } });
const dbModule = jiti('./lib/db.ts');
const { seedSessionCatalog, EXTERNAL_IDS } = require('./test-support/session-catalog-fixture');
const { writeSkillForBot } = jiti('./lib/skills.ts');
const { getAgentOverview, summarizeInstruction } = jiti('./lib/agent-overview.ts');

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

  test('active, recent, and empty work come from the Agent session catalog', () => {
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
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/ci-botmancers.yml'), 'utf8');
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
    assert.match(overviewPage, /This Agent does not exist or was removed/);
  });

  test('shared shell exposes the full selected-tab navigation contract', () => {
    for (const label of ['Overview', 'Sessions', 'Conversations', 'Slack', 'Activity']) assert.ok(shell.includes(`label: '${label}'`));
    assert.match(shell, />Config<\/Link>/);
    assert.match(shell, /aria-current=\{selectedTab \? 'page'/);
    assert.match(shell, /Runtime and availability/);
    for (const behavior of ['Hidden', 'Mark as Unread', 'Rename Agent', 'Hide from sidebar', 'Delete agent…', 'ArrowDown', 'onContextMenu']) {
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
    assert.match(overviewPage, /\/?agent=\$\{encodeURIComponent\(id\)\}/);
    assert.match(overviewPage, /\/bots\/\$\{encodeURIComponent\(id\)\}\/config/);
  });

  test('Overview has no ambient thread or composer', () => {
    assert.equal(overviewPage.includes('Say something'), false);
    assert.equal(overviewPage.includes('<textarea'), false);
    assert.equal(overviewPage.includes('className="composer'), false);
    assert.match(overviewPage, /Open conversation/);
  });

  test('Use this Agent names three real paths and the MCP discovery flow', () => {
    for (const text of ['Message in Botmancers', 'Use from a coding agent', 'Share a session to Slack', 'POST /api/v0/mcp', 'botmancers_capabilities', 'botmancers_list_agents']) {
      assert.ok(overviewPage.includes(text), text);
    }
    assert.match(overviewPage, /packages\/mcp-server\/README\.md#client-setup-and-the-collaboration-skill/);
    assert.equal(/token|grant_secret|provider_session_id|working_directory|model/i.test(dtoShape), false);
    assert.equal(overviewPage.includes('<select'), false);
    assert.equal(/label[^>]*>\s*(Runtime|Model|Provider session)/i.test(overviewPage), false);
  });

  test('release-check workflow runs the focused Agent-home and roster suites', () => {
    assert.match(workflow, /npm run test:agent-home/);
    assert.match(workflow, /npm run test:roster-a11y/);
    assert.match(workflow, /npm run release:check/);
  });
} finally {
  dbModule.default.close();
  fs.rmSync(temp, { recursive: true, force: true });
}

console.log(`\n${passed} passed`);
