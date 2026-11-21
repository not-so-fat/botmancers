#!/usr/bin/env node
// NOT-448/NOT-549: the shared roster used by Home and Agent routes keeps
// the established row, menu, hidden-Agent, and keyboard contracts.
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = require('./support/repo-root');
const rail = fs.readFileSync(path.join(ROOT, 'app/components/AgentRail.tsx'), 'utf8');
const home = fs.readFileSync(path.join(ROOT, 'app/page.tsx'), 'utf8');
const shell = fs.readFileSync(path.join(ROOT, 'app/agents/[id]/AgentShell.tsx'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'app/globals.css'), 'utf8');
let failures = 0;
function assert(condition, label) {
  console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${label}`);
  if (!condition) failures++;
}
const between = (start, end) => {
  const from = rail.indexOf(start);
  const to = rail.indexOf(end, from + start.length);
  return from >= 0 && to > from ? rail.slice(from, to) : '';
};
const rule = selector => {
  const at = css.indexOf(`${selector} {`);
  return at >= 0 ? css.slice(at, css.indexOf('}', at)) : '';
};

console.log('Case 1: Home and Agent routes share one roster implementation');
assert(/<AgentRail/.test(home) && /<AgentRail/.test(shell), 'Home and Agent shell both mount AgentRail');
assert(!/className="agent-row-menu"|<details/.test(shell), 'Agent shell has no replacement details menu');

console.log('\nCase 2: one semantic open control per agent row');
const open = between('const rowOpen = ', 'const rowActions = ');
const row = between('const agentRow = ', '\n\n  return <>');
assert(/<button type="button" className="bot-name row-open"/.test(open), 'rowOpen renders a named button');
assert(/data-open-bot=\{agent\.id\}/.test(open) && /router\.push\(`\/agents\/\$\{encodeURIComponent\(agent\.id\)\}`\)/.test(open), 'row opens Agent Overview and supports focus restore');
assert(/aria-current=/.test(open), 'selected row exposes aria-current');
assert(!/rowActions|<button[\s\S]*<button/.test(open), 'rowOpen nests no other control');
assert(/agentRow\(agent\)/.test(rail) && /rowOpen\(agent\)/.test(row), 'card and list variants use the same open control');

console.log('\nCase 3: visible menu supports every action and keyboard movement');
const actions = between('const rowActions = ', 'const rowTip = ');
assert(/aria-haspopup="menu"/.test(actions) && /aria-expanded=/.test(actions), 'trigger is a labelled menu button with expanded state');
assert(/aria-label=\{`Actions for \$\{agent\.name\}`\}/.test(actions), 'trigger is labelled with Agent name');
for (const item of ['Mark as Unread', 'Rename agent', 'Hide from sidebar', 'Unhide', 'Config', 'Delete agent…', 'Pin', 'Unpin']) {
  assert(rail.includes(item), `menu offers ${item}`);
}
assert((rail.match(/role="menuitem"/g) || []).length === 6, 'menu exposes six menuitems');
assert((rail.match(/tabIndex=\{-1\}/g) || []).length === 6, 'menuitems use roving focus outside the Tab sequence');
const keys = between('const onRowMenuKey = ', 'const rename = ');
for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Tab']) assert(keys.includes(`'${key}'`), `menu handles ${key}`);
assert(/rowMenu\.returnTo\?\.focus\(\)/.test(rail), 'Escape restores trigger focus');
assert(/onContextMenu=\{event => onContextMenu\(event, agent\)\}/.test(rail), 'right click opens the same menu');

console.log('\nCase 4: hidden Agents and row status remain present');
assert(/hidden\.map\(agentRow\)/.test(rail), 'expanded Hidden list renders the shared row');
assert(/aria-expanded=\{showHidden\}/.test(rail), 'Hidden toggle reports expanded state');
for (const state of ['mark-dot', 'bot-preview', 'Unread', 'Heartbeat', 'Stopped']) assert(rail.includes(state), `roster retains ${state}`);
assert(/Manage agents/.test(rail) && /<DeleteAgentsDialog/.test(rail), 'Manage agents and shared delete dialog remain');
assert(/return isChiefOfStaff\(agent\) \? 0 : agent\.pinned \? 1 : 2;/.test(rail), 'Chief of Staff, pinned, rest ordering remains');

console.log('\nCase 5: whole-row focus treatment');
assert(/position: absolute;[\s\S]*inset: 0;/.test(rule('.row-open::after')), 'row-open overlay spans the row');
assert(/outline: 2px solid var\(--accent\)/.test(rule('.row-open:focus-visible::after')), 'focused row shows an accent outline');
assert(/outline: 2px solid var\(--accent\)/.test(rule('.row-actions:focus-visible')), 'focused menu trigger shows an outline');
assert(/z-index: 2/.test(rule('.row-actions')), 'trigger sits above row overlay');
assert(/(^|\n)\.row-tip \{[^}]*pointer-events: none;/.test(css), 'status tip never swallows clicks');

console.log(`\n${failures === 0 ? 'TEST RESULT: PASS' : `TEST RESULT: FAIL (${failures} assertion(s))`}`);
process.exit(failures === 0 ? 0 : 1);
