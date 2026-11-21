#!/usr/bin/env node
// Botmancers-owned capacity presentation + Claude cache parsing (no network).
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = require('./support/repo-root');
const { createJiti } = require('jiti');
const jiti = createJiti(__filename, { alias: { '@': ROOT } });

const { selectCapacityChips, capacitySeverity } = jiti('../lib/capacity/present.ts');
const { parseClaudeCachedUtilization, extractClaudeCacheSubtree } = jiti('../lib/capacity/claude.ts');
const { parseCodexRateLimits } = jiti('../lib/capacity/codex.ts');
const { isCursorIndividualExperimentalEnabled, cursorBillingWindow } = jiti('../lib/capacity/cursor.ts');
const { capacityEntryForRuntime } = jiti('../lib/capacity/service-client.ts');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

test('Claude/Codex pair renders 5H then 1W from criticalRole', () => {
  const entry = {
    runtime: 'claude',
    unavailableReason: null,
    windows: [
      {
        windowKey: 'claude_unified_seven_day',
        providerBucket: 'seven_day',
        displayLabel: '1W',
        remainingPercent: 72.4,
        resetAt: null,
        observedAt: new Date().toISOString(),
        source: 'observed_event',
        unavailableReason: null,
        criticalRole: 'weekly',
      },
      {
        windowKey: 'claude_unified_five_hour',
        providerBucket: 'five_hour',
        displayLabel: '5H',
        remainingPercent: 9.6,
        resetAt: null,
        observedAt: new Date().toISOString(),
        source: 'observed_event',
        unavailableReason: null,
        criticalRole: 'five_hour',
      },
    ],
  };
  const chips = selectCapacityChips(entry);
  assert.equal(chips.length, 2);
  assert.equal(chips[0].label, '5H');
  assert.equal(chips[0].kind, 'known');
  assert.equal(chips[0].remaining, 10);
  assert.equal(chips[0].rawRemaining, 9.6);
  assert.equal(capacitySeverity(chips[0].rawRemaining), 'critical');
  assert.equal(chips[1].label, '1W');
  assert.equal(chips[1].remaining, 72);
});

test('missing critical halves synthesize public N/A chips', () => {
  const chips = selectCapacityChips({
    runtime: 'codex',
    windows: [],
    unavailableReason: 'missing',
  });
  assert.equal(chips.length, 2);
  assert.equal(chips[0].kind, 'unknown');
  assert.equal(chips[0].label, '5H');
  assert.equal(chips[1].label, '1W');
});

test('Cursor renders only billing_cycle as 1M', () => {
  const chips = selectCapacityChips({
    runtime: 'cursor',
    unavailableReason: null,
    windows: [cursorBillingWindow(41)],
  });
  assert.equal(chips.length, 1);
  assert.equal(chips[0].label, '1M');
  assert.equal(chips[0].kind, 'known');
  assert.equal(chips[0].remaining, 41);
});

test('Cursor without opt-in is unsupported', () => {
  assert.equal(isCursorIndividualExperimentalEnabled({}), false);
  assert.equal(
    isCursorIndividualExperimentalEnabled({ BOTMANCERS_CURSOR_INDIVIDUAL_CAPACITY: 'experimental' }),
    true
  );
});

test('Claude cache parser keeps only account-wide 5H/1W', () => {
  const now = Date.now();
  const raw = {
    fetchedAtMs: now - 1000,
    utilization: {
      limits: [
        { kind: 'session', percent: 40, resets_at: new Date(now + 3_600_000).toISOString() },
        { kind: 'weekly_all', percent: 15, resets_at: new Date(now + 86_400_000).toISOString() },
        { kind: 'sonnet_only', percent: 90, resets_at: new Date(now + 86_400_000).toISOString() },
      ],
    },
  };
  const windows = parseClaudeCachedUtilization(raw, now);
  assert.ok(windows);
  assert.equal(windows.length, 2);
  assert.equal(windows.find(w => w.criticalRole === 'five_hour').remainingPercent, 60);
  assert.equal(windows.find(w => w.criticalRole === 'weekly').remainingPercent, 85);
});

test('Claude extract drops sibling config keys', () => {
  const subtree = extractClaudeCacheSubtree({
    accountUuid: 'secret',
    cachedUsageUtilization: { fetchedAtMs: 1, utilization: {} },
  });
  assert.equal(subtree.fetchedAtMs, 1);
  assert.equal(subtree.accountUuid, undefined);
});

test('Codex aggregate primary/secondary maps to critical pair', () => {
  const windows = parseCodexRateLimits({
    rateLimits: {
      primary: { usedPercent: 25, resetsAt: Math.floor(Date.now() / 1000) + 3600 },
      secondary: { usedPercent: 10, resetsAt: Math.floor(Date.now() / 1000) + 86400 },
    },
  });
  assert.ok(windows);
  assert.equal(windows.length, 2);
  assert.equal(windows[0].criticalRole, 'five_hour');
  assert.equal(windows[0].remainingPercent, 75);
  assert.equal(windows[1].criticalRole, 'weekly');
  assert.equal(windows[1].remainingPercent, 90);
});

test('capacityEntryForRuntime picks the Agent harness only', () => {
  const response = {
    observedAt: new Date().toISOString(),
    runtimes: [
      { runtime: 'claude', windows: [], unavailableReason: 'missing' },
      { runtime: 'cursor', windows: [cursorBillingWindow(12)], unavailableReason: null },
    ],
  };
  assert.equal(capacityEntryForRuntime(response, 'cursor').runtime, 'cursor');
  assert.equal(capacityEntryForRuntime(response, 'hermes'), null);
});

test('HarnessIcon and TopBarCapacity are wired into Agent shell, not Make it reachable', () => {
  const shell = fs.readFileSync(path.join(ROOT, 'app/agents/[id]/AgentShell.tsx'), 'utf8');
  const overview = fs.readFileSync(path.join(ROOT, 'app/agents/[id]/page.tsx'), 'utf8');
  const topBar = fs.readFileSync(path.join(ROOT, 'app/components/TopBarCapacity.tsx'), 'utf8');
  assert.match(shell, /HarnessIcon/);
  assert.match(shell, /TopBarCapacity/);
  assert.equal(shell.includes('AgentCapacity'), false);
  assert.match(overview, /HarnessIcon/);
  assert.equal(overview.includes('TopBarCapacity'), false);
  assert.match(topBar, /data-testid="topbar-capacity"/);
  assert.ok(fs.existsSync(path.join(ROOT, 'public/brand/harness/cursor.svg')));
  assert.ok(fs.existsSync(path.join(ROOT, 'public/brand/harness/claude.svg')));
  assert.ok(fs.existsSync(path.join(ROOT, 'public/brand/harness/codex.png')));
});

console.log(`\n${passed} passed`);
