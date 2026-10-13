#!/usr/bin/env node
// NOT-455: brand hierarchy in the rail and the zero-bot welcome state.
//
// Deterministic source + asset checks: the rail lockup uses a >=64 px filled
// asset at ~40 px with a 15-16 px wordmark, the zero-bot pane uses an outline
// asset at >=128 px, and both PNGs keep a transparent (no box) background.
// No dev server, no network.
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = __dirname;
const page = fs.readFileSync(path.join(ROOT, 'app/page.tsx'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'app/globals.css'), 'utf8');

let failures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

// Top-level (non-media) declaration block for a selector.
function rule(selector) {
  const top = css.replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
  const re = new RegExp(`(^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`);
  const m = top.match(re);
  return m ? m[2] : '';
}
function px(block, prop) {
  const m = block.match(new RegExp(`(^|[;\\s])${prop}:\\s*(\\d+)px`));
  return m ? Number(m[2]) : null;
}

// Decode an 8-bit RGBA, non-interlaced PNG and report alpha at the corners.
function inspectPng(file) {
  const buf = fs.readFileSync(file);
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const bitDepth = buf[24];
  const colorType = buf[25];
  const interlace = buf[28];
  const idat = [];
  for (let off = 8; off < buf.length;) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    if (type === 'IDAT') idat.push(buf.subarray(off + 8, off + 8 + len));
    off += 12 + len;
  }
  const info = { width, height, colorType, bitDepth };
  if (colorType !== 6 || bitDepth !== 8 || interlace !== 0) return { ...info, corners: null };
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = 4;
  const stride = width * bpp;
  const out = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x];
      const a = x >= bpp ? out[y * stride + x - bpp] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? out[(y - 1) * stride + x - bpp] : 0;
      let p;
      if (filter === 0) p = 0;
      else if (filter === 1) p = a;
      else if (filter === 2) p = b;
      else if (filter === 3) p = (a + b) >> 1;
      else {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[y * stride + x] = (v + p) & 0xff;
    }
  }
  const alpha = (x, y) => out[y * stride + x * bpp + 3];
  const corners = [alpha(0, 0), alpha(width - 1, 0), alpha(0, height - 1), alpha(width - 1, height - 1)];
  return { ...info, corners };
}

// Rail lockup markup.
const brandBlock = page.slice(page.indexOf('<div className="brand">'), page.indexOf('<div className="bar">'));
const filledSrc = (brandBlock.match(/src="(\/brand\/botmancers-logo-filled-(\d+)\.png)"/) || []);
check('rail lockup uses a filled brand asset', Boolean(filledSrc[1]), filledSrc[1]);
check('rail filled source asset is >= 64 px', Number(filledSrc[2]) >= 64, `${filledSrc[2]} px`);
check('rail lockup renders the mark at 40 px', /width=\{40\}/.test(brandBlock) && /height=\{40\}/.test(brandBlock));
check('rail lockup has the botmancers wordmark', /className="logo-word">botmancers</.test(brandBlock));
check('rail lockup sits above the New/Settings bar', page.indexOf('<div className="brand">') < page.indexOf('<div className="bar">'));

// Rail lockup CSS.
const shape = rule('.logo-shape img');
const word = rule('.logo-word');
const add = rule('.add-btn,\n.send-btn');
const markPx = px(shape, 'width');
const wordPx = px(word, 'font-size');
const addPx = px(add, 'font-size');
check('desktop mark is ~40 px', markPx >= 36 && markPx <= 44, `${markPx} px`);
check('desktop wordmark is 15-16 px', wordPx >= 15 && wordPx <= 16, `${wordPx} px`);
check('wordmark outweighs New/Settings (14 px)', wordPx > addPx && /font-weight:\s*(600|700)/.test(word), `${wordPx} px vs ${addPx} px`);
check('lockup groups mark and wordmark in one row', /flex-direction:\s*row/.test(rule('.brand')) && /align-items:\s*center/.test(rule('.brand')));

// Zero-bot welcome composition.
const welcomeAt = page.indexOf('<div className="welcome">');
const welcomeBlock = page.slice(welcomeAt, page.indexOf('</div>', welcomeAt));
const outlineSrc = (welcomeBlock.match(/src="(\/brand\/botmancers-logo-outline-(\d+)\.png)"/) || []);
check('zero-bot state is gated on bots.length === 0', /bots\.length === 0 \? \(\s*<div className="welcome">/.test(page));
check('zero-bot state uses an outline brand asset', Boolean(outlineSrc[1]), outlineSrc[1]);
const welcomeW = Number((welcomeBlock.match(/width=\{(\d+)\}/) || [])[1]);
check('zero-bot mark renders at >= 128 px', welcomeW >= 128 && px(rule('.welcome-mark'), 'width') >= 128, `${welcomeW} px`);
check('zero-bot copy is the existing invitation', welcomeBlock.includes('Pick someone to talk to.'));
const narrow = css.match(/\.welcome-mark\s*\{[^}]*width:\s*(\d+)px/g) || [];
check('narrow welcome mark stays >= 128 px', narrow.every(r => Number(r.match(/(\d+)px/)[1]) >= 128), narrow.join(' | '));
check('populated no-selection pane keeps the plain line', /\) : \(\s*<p className="empty-line">Pick someone to talk to\.<\/p>\s*\)\}\s*<\/section>/.test(page));

// Assets exist, keep RGBA, and have transparent corners (no box/backdrop).
for (const src of [filledSrc[1], outlineSrc[1]].filter(Boolean)) {
  const file = path.join(ROOT, 'public', src);
  const exists = fs.existsSync(file);
  check(`${src} exists`, exists);
  if (!exists) continue;
  const info = inspectPng(file);
  check(`${src} is RGBA ${info.width}x${info.height}`, info.colorType === 6);
  check(`${src} has transparent corners`, Array.isArray(info.corners) && info.corners.every(a => a === 0), JSON.stringify(info.corners));
}

// Favicon/app icon still uses the filled asset.
const layout = fs.readFileSync(path.join(ROOT, 'app/layout.tsx'), 'utf8');
check('favicon still points at filled assets', layout.includes('/brand/botmancers-logo-filled-64.png'));

if (failures) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll brand hierarchy checks passed');
