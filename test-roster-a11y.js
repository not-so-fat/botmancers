#!/usr/bin/env node
// NOT-448: roster rows and row actions are keyboard accessible.
// Source-level contract for app/page.tsx and app/globals.css: each agent row
// opens through one named <button> (no clickable generic container), the
// row-actions trigger is a visible labelled menu button outside that button,
// the menu offers every row action with arrow-key navigation, and the focused
// row gets a whole-row outline. scripts/ui-roster-keyboard-proof.js proves the
// same contract in a real browser. No server, no network.
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const page = fs.readFileSync(path.join(ROOT, 'app', 'page.tsx'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'app', 'globals.css'), 'utf8');

let failures = 0;
function assert(condition, label) {
  console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${label}`);
  if (!condition) failures++;
}

const between = (start, end) => {
  const from = page.indexOf(start);
  const to = page.indexOf(end, from + start.length);
  return from >= 0 && to > from ? page.slice(from, to) : '';
};
const rule = selector => {
  const at = css.indexOf(`${selector} {`);
  return at >= 0 ? css.slice(at, css.indexOf('}', at)) : '';
};

console.log('Case 1: one semantic open control per agent row');
const roster = between('{rosterBots.map(', '{hiddenBots.length > 0');
const row = between('const agentRow = ', '\n  );\n');
const hidden = between('{hiddenBots.length > 0', '</aside>');
assert(roster.length > 0 && row.length > 0 && hidden.length > 0, 'roster, agent row and hidden list render blocks found');
assert(!/onClick=\{\(\) => openBot/.test(roster + row), 'row containers carry no click-to-open handler');
assert(/rowOpen\(bot/.test(roster) && /agentRow\(bot\)/.test(roster), 'Chief of Staff card renders rowOpen, other agents render agentRow');
assert(/rowOpen\(bot\)/.test(row), 'agent rows render rowOpen');
assert(!/<button/.test(roster + row), 'row containers hold no inline buttons (controls come from rowOpen/rowActions)');
const open = between('const rowOpen = ', 'const rowActions = ');
assert(/<button\s+type="button"\s+className="bot-name row-open"/.test(open), 'rowOpen renders a <button type="button" className="bot-name row-open">');
assert(/data-open-bot=\{bot\.id\}/.test(open) && /router\.push\(`\/agents\/\$\{encodeURIComponent\(bot\.id\)\}`\)/.test(open), 'rowOpen opens the Agent Overview and is addressable for focus restore');
assert(/aria-current=/.test(open), 'rowOpen marks the open agent with aria-current');
assert(/>\s*\{bot\.name\}\s*<\/button>/.test(open), 'rowOpen is named by the agent name only');
assert(!/rowActions|<button[\s\S]*<button/.test(open), 'rowOpen nests no other interactive control');

console.log('\nCase 2: visible, named row-actions trigger and menu');
const actions = between('const rowActions = ', 'const rowTip = ');
assert(/aria-haspopup="menu"/.test(actions) && /aria-expanded=/.test(actions), 'trigger is a menu button with aria-expanded');
assert(/aria-label=\{`Actions for \$\{bot\.name\}`\}/.test(actions), 'trigger is labelled "Actions for <agent>"');
assert(/onClick=\{e => openRowMenu\(bot, e\.currentTarget\)\}/.test(actions), 'trigger opens the menu anchored to itself');
assert(/rowActions\(bot\)/.test(roster) && /rowActions\(bot\)/.test(row), 'every row (card and list) renders the trigger');
const tip = between('const rowTip = ', ');\n');
assert(!/<button|onClick/.test(tip), 'hover tip holds status only, no hover-only controls');
const menu = between('role="menu"', '</div>');
const items = menu.split('\n').filter(line => /role="menuitem"/.test(line))
  .map(line => (line.match(/>([^<>]+)<\/(?:button|Link)>\s*$/) || [])[1]).filter(Boolean);
console.log(`  menu items: ${JSON.stringify(items)}`);
assert(/\{rowMenu\.bot\.pinned \? 'Unpin' : 'Pin'\}/.test(menu), 'menu offers Pin or Unpin by pinned state');
assert(/\{rowMenu\.bot\.hidden \? 'Unhide' : 'Hide from sidebar'\}/.test(menu), 'menu offers Hide from sidebar or Unhide by hidden state');
assert(/hideBot\(rowMenu\.bot, !rowMenu\.bot\.hidden\)/.test(menu), 'Hide/Unhide item toggles hidden');
for (const item of ['Mark as Unread', 'Rename Agent', 'Config', 'Delete agent…']) {
  assert(items.includes(item), `menu offers ${item}`);
}
assert(/href=\{`\/bots\/\$\{rowMenu\.bot\.id\}\/config`\}/.test(menu), 'Config item links to the agent config page');
assert(/onKeyDown=\{onRowMenuKey\}/.test(menu), 'menu handles its own keys');
const itemLines = menu.split('\n').filter(line => /role="menuitem"/.test(line));
assert(itemLines.length === 6 && itemLines.every(line => /tabIndex=\{-1\}/.test(line)), 'menu items use roving focus (tabIndex=-1, out of the Tab sequence)');
const keys = between('const onRowMenuKey = ', 'const onRowContextMenu = ');
for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Tab']) assert(keys.includes(`'${key}'`), `menu handles ${key}`);
assert(/rowMenu\.returnTo\?\.focus\(\)/.test(page), 'Escape returns focus to the trigger');
assert(/onContextMenu=\{e => onRowContextMenu\(e, bot\)\}/.test(roster), 'right-click menu still works on rows');

console.log('\nCase 3: whole-row focus treatment');
assert(/position: absolute;[\s\S]*inset: 0;/.test(rule('.row-open::after')), 'row-open overlay spans the row');
assert(/outline: 2px solid var\(--accent\)/.test(rule('.row-open:focus-visible::after')), 'focused row shows a 2px accent outline');
assert(/outline: 2px solid var\(--accent\)/.test(rule('.row-actions:focus-visible')), 'focused trigger shows an outline');
assert(/z-index: 2/.test(rule('.row-actions')), 'trigger sits above the row overlay');
assert(/(^|\n)\.row-tip \{[^}]*pointer-events: none;/.test(css), 'status tip never swallows clicks (.row-tip rule sets pointer-events: none)');

console.log('\nCase 3b: hidden agents keep the open control and row-actions trigger');
assert(/hiddenBots\.map\(agentRow\)/.test(hidden), 'expanded Hidden list renders the shared agent row');
assert(!/Unhide/.test(hidden) && !/<button[^>]*onClick=\{\(\) => hideBot/.test(page), 'no bare, identically named Unhide buttons');
assert(/aria-expanded=\{showHidden\}/.test(hidden), 'Hidden toggle reports aria-expanded');

console.log('\nCase 4: Manage agents, deletion, ordering, no Group path');
assert(/Manage agents/.test(page) && /<ManageAgentsPanel/.test(page) && /<DeleteAgentsDialog/.test(page), 'Manage agents and shared delete dialog remain');
assert(/return isChiefOfStaff\(bot\) \? 0 : bot\.pinned \? 1 : 2;/.test(page), 'Chief of Staff, pinned, rest ordering unchanged');
assert(!/group/i.test(page), 'page has no Group row, action, or keyboard path');

console.log(`\n${failures === 0 ? 'TEST RESULT: PASS' : `TEST RESULT: FAIL (${failures} assertion(s))`}`);
process.exit(failures === 0 ? 0 : 1);
