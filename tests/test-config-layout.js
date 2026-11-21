#!/usr/bin/env node
// NOT-450: per-agent config page layout regression.
//
// Deterministic source checks against app/agents/[id]/config/page.tsx:
// (1) the loaded page renders two equal desktop columns that collapse to one
//     column below lg, so neither side is left empty beside a long stack;
// (2) the cards keep a fixed DOM (= keyboard) order: Skills, Rules, Agent,
//     Template source, then Launch snapshots, Avatar, Danger zone — with
//     Launch snapshots heading the second column, ahead of the Avatar editor;
// (3) no CSS reordering (order-*, *-start, reverse) can make visual placement
//     disagree with DOM order;
// (4) the loading skeleton and load-error state use the same two columns.
// No dev server, no browser, no network.
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = require('./support/repo-root');
const src = fs.readFileSync(path.join(ROOT, 'app/agents/[id]/config/page.tsx'), 'utf8');

let failures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

const PRIMARY = ['Skills', 'Rules', 'Agent', 'Template source'];
const SECONDARY = ['Launch snapshots', 'Avatar', 'Danger zone'];

// (1) Column structure of the loaded page.
const layoutAt = src.indexOf('data-cfg-layout="columns"');
const primaryAt = src.indexOf('data-cfg-column="primary"');
const secondaryAt = src.indexOf('data-cfg-column="secondary"');
check('loaded page has one column layout container', layoutAt > 0 && src.split('data-cfg-layout=').length === 2);
const layoutTag = src.slice(src.lastIndexOf('<div', layoutAt), src.indexOf('>', layoutAt));
check('layout is a single column below lg and two equal columns at lg',
  /className="grid gap-6 lg:grid-cols-2 items-start"/.test(layoutTag), layoutTag.trim());
check('primary column precedes secondary column', primaryAt > layoutAt && secondaryAt > primaryAt);
for (const [name, at] of [['primary', primaryAt], ['secondary', secondaryAt]]) {
  const tag = src.slice(src.lastIndexOf('<div', at), src.indexOf('>', at));
  check(`${name} column can shrink inside the grid (min-w-0)`, /\bmin-w-0\b/.test(tag), tag.trim());
}

// (2) DOM order of the card headings.
const headingAt = title => src.indexOf(`>${title}</h2>`, layoutAt);
const order = [...PRIMARY, ...SECONDARY].map(title => ({ title, at: headingAt(title) }));
for (const { title, at } of order) check(`"${title}" card renders in the column layout`, at > layoutAt);
const sorted = [...order].sort((a, b) => a.at - b.at).map(o => o.title);
check('card DOM order is Skills, Rules, Agent, Template source, Launch snapshots, Avatar, Danger zone',
  JSON.stringify(sorted) === JSON.stringify([...PRIMARY, ...SECONDARY]), sorted.join(' → '));
for (const title of PRIMARY) {
  const at = headingAt(title);
  check(`"${title}" is in the primary column`, at > primaryAt && at < secondaryAt);
}
for (const title of SECONDARY) check(`"${title}" is in the secondary column`, headingAt(title) > secondaryAt);
const firstSecondary = src.slice(secondaryAt).match(/<h2[^>]*>([^<]+)<\/h2>/);
check('Launch snapshots heads the secondary column, next to the config hash',
  firstSecondary && firstSecondary[1] === 'Launch snapshots', firstSecondary && firstSecondary[1]);
check('Launch snapshots precedes the Avatar editor in DOM order', headingAt('Launch snapshots') < headingAt('Avatar'));

// (3) No visual reordering anywhere on the page.
const reorder = src.match(/\b(?:[a-z]+:)?(?:order-\S+|col-start-\S+|row-start-\S+|flex-col-reverse|flex-row-reverse|grid-flow-dense)\b/g) || [];
check('no CSS reordering classes', reorder.length === 0, reorder.join(' '));
check('no leftover 5-column split', !/lg:grid-cols-5|lg:col-span-[23]/.test(src));

// (4) Loading skeleton and load-error state share the composition.
const grids = src.match(/className="grid gap-6 lg:grid-cols-2[^"]*"/g) || [];
check('skeleton, error state, and loaded page all use the two-column grid', grids.length === 3, `${grids.length} grids`);
const errorCols = src.match(/const errorColumns = (\[.*\]);/);
check('error state mirrors the loaded column split',
  errorCols && errorCols[1] === "[['Skills', 'Rules', 'Agent', 'Template source'], ['Launch snapshots', 'Avatar']]",
  errorCols && errorCols[1]);

console.log(failures ? `\n${failures} failure(s)` : '\nall config layout checks passed');
process.exit(failures ? 1 : 0);
