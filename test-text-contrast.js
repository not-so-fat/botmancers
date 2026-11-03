#!/usr/bin/env node
// NOT-453: muted small-text contrast regression.
//
// Deterministic source checks against app/globals.css and the page sources:
// (1) every shipped normal-text foreground token measures >= 4.5:1 (WCAG AA)
//     on every background it renders on (field, composer, card, and the
//     open roster row overlay), with each pair and ratio printed;
// (2) each meaningful muted selector (.bot-preview, .bot-runtime,
//     .cfg-faint, .runtime-hint, saved states, template metadata, ...)
//     resolves its color to an explicit token and carries no opacity;
// (3) opacity is left only on explicit exceptions: :disabled controls
//     (which must stay visibly dimmed), hidden inputs, and animation.
// No dev server, no browser, no network.
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const css = fs.readFileSync(path.join(ROOT, 'app/globals.css'), 'utf8');
const AA = 4.5;

let failures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

const rootBlock = (css.match(/:root\s*\{([^}]*)\}/) || [])[1] || '';
const tokens = {};
for (const m of rootBlock.matchAll(/--([a-z-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) tokens[m[1]] = m[2].toLowerCase();

function rgb(hex) {
  return [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
}
function luminance(hex) {
  const [r, g, b] = rgb(hex).map(c => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function ratio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
function over(fg, bg, alpha) {
  const b = rgb(bg);
  return '#' + rgb(fg).map((v, i) => Math.round(v * alpha + b[i] * (1 - alpha)).toString(16).padStart(2, '0')).join('');
}

// Top-level declaration block for an exact selector list.
function rule(selector) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = css.match(new RegExp(`(^|\\n)${esc}\\s*\\{([^}]*)\\}`));
  return m ? m[2] : null;
}

// (1) Token pairs. The open roster row paints rgba(ink, 0.08) over the field.
const openRow = rule('.bot-row.is-open,\n.bot-lead.is-open') || '';
check('open roster row overlay is rgba(213, 208, 195, 0.08)', /background:\s*rgba\(213,\s*208,\s*195,\s*0\.08\)/.test(openRow));
const backgrounds = {
  field: tokens.field,
  composer: tokens.composer,
  card: tokens.card,
  'field+open-row': over(tokens.ink, tokens.field, 0.08),
};
for (const name of ['field', 'composer', 'card', 'ink', 'ink-muted', 'ink-faint', 'accent', 'danger']) {
  check(`token --${name} is defined`, Boolean(tokens[name]), tokens[name]);
}
for (const fg of ['ink', 'ink-muted', 'ink-faint', 'accent', 'danger']) {
  for (const [bgName, bg] of Object.entries(backgrounds)) {
    const r = tokens[fg] ? ratio(tokens[fg], bg) : 0;
    check(`--${fg} ${tokens[fg]} on ${bgName} ${bg}`, r >= AA, `${r.toFixed(2)}:1`);
  }
}
// Semantic status colors rendered as text on cards.
for (const [sel, prop] of [['.cfg-error', 'color'], ['.cfg-ok', 'color']]) {
  const hex = ((rule(sel) || '').match(new RegExp(`${prop}:\\s*(#[0-9a-fA-F]{6})`)) || [])[1];
  for (const bgName of ['field', 'card']) {
    const r = hex ? ratio(hex, backgrounds[bgName]) : 0;
    check(`${sel} ${hex} on ${bgName}`, r >= AA, `${r.toFixed(2)}:1`);
  }
}

// Hierarchy: primary > muted > faint on every background.
for (const [bgName, bg] of Object.entries(backgrounds)) {
  const [p, m, f] = ['ink', 'ink-muted', 'ink-faint'].map(t => (tokens[t] ? ratio(tokens[t], bg) : 0));
  check(`hierarchy ink > ink-muted > ink-faint on ${bgName}`, p > m && m > f, `${p.toFixed(2)} > ${m.toFixed(2)} > ${f.toFixed(2)}`);
}

// (2) Meaningful muted selectors: explicit token, no opacity, and the
// computed (color x opacity) rendering clears 4.5:1 on each background
// the selector renders on.
const ROSTER = ['field', 'field+open-row'];
const SURFACES = ['field', 'composer', 'card'];
const MUTED = [
  ['.bot-preview', 'ink-faint', ROSTER],
  ['.bot-runtime', 'ink-faint', ROSTER],
  ['.card-preview', 'ink-muted', SURFACES],
  ['.card-role,\n.thread-role', 'ink-muted', ROSTER],
  ['.runtime-hint', 'ink-faint', ['card']],
  ['.cfg-muted', 'ink-muted', SURFACES],
  ['.cfg-faint', 'ink-faint', SURFACES],
  ['.composer textarea::placeholder', 'ink-faint', ['composer']],
  ['.delete-keeps', 'ink-muted', ['card']],
  ['.manage-count', 'ink-muted', ['card']],
  ['.manage-tag', 'ink-muted', ['card']],
  ['.manage-meta dt', 'ink-faint', ['card']],
  ['.manage-row.is-blocked .manage-name,\n.manage-row.is-blocked .manage-meta', 'ink-faint', ['card']],
];
function resolveColor(block) {
  const m = block && block.match(/(?:^|[;\s])color:\s*([^;]+);/);
  if (!m) return tokens.ink; // inherits body ink
  const v = m[1].trim();
  const t = v.match(/^var\(--([a-z-]+)\)$/);
  return (t ? tokens[t[1]] : v.toLowerCase()) || null;
}
for (const [sel, token, bgs] of MUTED) {
  const block = rule(sel);
  const label = sel.replace(/\n/g, ' ');
  check(`${label} uses var(--${token})`, block !== null && new RegExp(`color:\\s*var\\(--${token}\\)`).test(block));
  const op = block && block.match(/opacity:\s*([\d.]+)/);
  const alpha = op ? Number(op[1]) : 1;
  check(`${label} has no dimming opacity`, block !== null && alpha === 1, op ? `opacity: ${op[1]}` : '');
  const fg = resolveColor(block);
  for (const bgName of bgs) {
    const bg = backgrounds[bgName];
    const shown = fg && /^#[0-9a-f]{6}$/.test(fg) ? over(fg, bg, alpha) : null;
    const r = shown ? ratio(shown, bg) : 0;
    check(`${label} computed ${shown} on ${bgName}`, r >= AA, `${r.toFixed(2)}:1`);
  }
}

// (3) Remaining opacity declarations are explicit exceptions only.
const opacityRules = [];
const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@keyframes[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
for (const m of stripped.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
  const op = m[2].match(/opacity:\s*([\d.]+)/);
  if (op) opacityRules.push({ selector: m[1].trim(), value: Number(op[1]) });
}
for (const { selector, value } of opacityRules) {
  const hidden = value === 0;
  const reset = value === 1;
  const disabled = selector.split(',').every(s => /:disabled\b/.test(s));
  check(`opacity ${value} on "${selector.replace(/\s+/g, ' ')}" is an explicit exception`, hidden || reset || disabled,
    hidden ? 'visually hidden input' : reset ? 'reset' : disabled ? 'disabled control' : 'dims readable text');
}
// Disabled controls stay visibly dimmed.
for (const sel of ['.bot-form .create-btn:disabled', '.cfg-btn-primary:disabled', '.cfg-btn-ghost:disabled', '.delete-btn:disabled', '.manage-tools .pin-word:disabled']) {
  const op = ((rule(sel) || '').match(/opacity:\s*([\d.]+)/) || [])[1];
  check(`${sel} stays visibly disabled`, op !== undefined && Number(op) < 0.7, op ? `opacity: ${op}` : 'missing');
}

// Page sources: no inline opacity dims text, except the group member picker
// whose names are avatar-colored (out of scope for NOT-453).
for (const file of ['app/page.tsx', 'app/settings/page.tsx', 'app/bots/[id]/config/page.tsx']) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const inline = [...src.matchAll(/style=\{\{[^}]*opacity[^}]*\}\}/g)].map(m => m[0]);
  const unexpected = inline.filter(s => !/opacity: on \? 1 : 0\.45/.test(s));
  check(`${file} has no inline text opacity`, unexpected.length === 0, unexpected.join(' | '));
}

console.log(failures ? `\n${failures} failure(s)` : '\nall contrast checks passed');
process.exit(failures ? 1 : 0);
