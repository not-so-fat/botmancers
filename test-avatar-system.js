#!/usr/bin/env node
// NOT-431: composable outline avatar system test (deterministic, no network).
//
// Proves: every approved color/eyes/hands/accessory renders a stroke-only,
// transparent-background SVG in the configured line color with masked
// overlap handling; renders are deterministic; unconfigured bots resolve to
// the required defaults (Chief of Staff gets the crown); avatar fields
// persist through the bot store and read back; avatar fields are part of
// the launch snapshot hash.
//
// Self-contained: isolated SQLite file for the persistence slice, jiti for
// the TypeScript modules. No dev server (loopback listen() is unavailable
// in this sandbox), no API key.
'use strict';

const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createJiti } = require('jiti');
const jiti = createJiti(__filename);
const avatar = jiti('./lib/avatar.ts');
const snapshot = require('./lib/snapshot');

const {
  AVATAR_COLORS,
  AVATAR_EYES,
  AVATAR_HANDS,
  AVATAR_ACCESSORIES,
  DEFAULT_AVATAR,
  CHIEF_OF_STAFF_AVATAR,
  resolveAvatar,
  validateAvatarInput,
  avatarStroke,
  renderAvatarSvg,
} = avatar;

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`PASS: ${name}`);
}

// Strip the <mask>...</mask> block: mask internals legitimately use black
// and white fills to erase overlapped body lines. Everything outside the
// mask is a visible avatar element and must be stroke-only.
function splitMask(svg) {
  const match = svg.match(/<mask id="[^"]*">([\s\S]*?)<\/mask>/);
  assert.ok(match, 'rendered avatar must contain a knockout mask');
  const maskBody = match[1];
  const visible = svg.replace(/<mask id="[^"]*">[\s\S]*?<\/mask>/g, '');
  return { maskBody, visible };
}

function checkStrokeOnly(svg, hex) {
  const { maskBody, visible } = splitMask(svg);
  assert.ok(!/background/i.test(visible), 'visible avatar must not carry a background');
  assert.ok(!/style=/.test(visible), 'visible avatar must not carry inline styles');
  const fills = [...visible.matchAll(/fill="([^"]*)"/g)].map(match => match[1]);
  assert.ok(fills.length > 0, 'visible avatar must carry explicit fills');
  for (const fill of fills) {
    assert.strictEqual(fill, 'none', `every visible element must use fill="none" (found ${fill})`);
  }
  const strokes = [...visible.matchAll(/stroke="(#[0-9A-Fa-f]{6})"/g)].map(match => match[1]);
  assert.ok(strokes.length > 0, 'visible avatar must carry stroked shapes');
  for (const stroke of strokes) {
    assert.strictEqual(stroke.toLowerCase(), hex.toLowerCase(), `stroke must be the configured color ${hex} (found ${stroke})`);
  }
  return maskBody;
}

function knockoutCount(maskBody) {
  return (maskBody.match(/stroke="#000000"/g) || []).length;
}

// 1. Option inventory matches the approved sets.
check('avatar inventory: 8 colors with purple first', () => {
  assert.strictEqual(AVATAR_COLORS.length, 8);
  assert.strictEqual(AVATAR_COLORS[0].id, 'purple');
  assert.deepStrictEqual(
    AVATAR_COLORS.map(entry => entry.id),
    ['purple', 'blue', 'teal', 'green', 'amber', 'orange', 'pink', 'slate']
  );
  for (const entry of AVATAR_COLORS) {
    assert.match(entry.hex, /^#[0-9A-Fa-f]{6}$/, `color ${entry.id} must be a hex line color`);
  }
});
check('avatar inventory: 4 eyes, 3 hands, 6 accessories', () => {
  assert.deepStrictEqual(AVATAR_EYES.map(entry => entry.id), ['dots', 'sleepy', 'happy', 'wide']);
  assert.deepStrictEqual(AVATAR_HANDS.map(entry => entry.id), ['folded', 'reaching', 'waving']);
  assert.deepStrictEqual(
    AVATAR_ACCESSORIES.map(entry => entry.id),
    ['none', 'crown', 'glasses', 'headset', 'hat', 'bow']
  );
});

// 2. Every approved option renders in outline/no-fill style.
const colorHex = Object.fromEntries(AVATAR_COLORS.map(entry => [entry.id, entry.hex]));
for (const color of AVATAR_COLORS) {
  check(`color renders stroke-only: ${color.id}`, () => {
    const svg = renderAvatarSvg({ ...DEFAULT_AVATAR, color: color.id });
    assert.ok(svg.includes(`data-avatar-color="${color.id}"`), 'svg must tag its color');
    checkStrokeOnly(svg, color.hex);
  });
}
for (const eyes of AVATAR_EYES) {
  check(`eyes render stroke-only: ${eyes.id}`, () => {
    const svg = renderAvatarSvg({ ...DEFAULT_AVATAR, eyes: eyes.id });
    assert.ok(svg.includes(`data-avatar-layer="eyes"`), 'svg must carry an eyes layer');
    assert.ok(svg.includes(`data-avatar-eyes="${eyes.id}"`), 'svg must tag its eyes');
    checkStrokeOnly(svg, colorHex.purple);
  });
}
for (const hands of AVATAR_HANDS) {
  check(`hands render stroke-only: ${hands.id}`, () => {
    const svg = renderAvatarSvg({ ...DEFAULT_AVATAR, hands: hands.id });
    assert.ok(svg.includes(`data-avatar-hands="${hands.id}"`), 'svg must tag its hands');
    checkStrokeOnly(svg, colorHex.purple);
  });
}
for (const accessory of AVATAR_ACCESSORIES) {
  check(`accessory renders stroke-only: ${accessory.id}`, () => {
    const svg = renderAvatarSvg({ ...DEFAULT_AVATAR, accessory: accessory.id });
    assert.ok(svg.includes(`data-avatar-accessory="${accessory.id}"`), 'svg must tag its accessory');
    checkStrokeOnly(svg, colorHex.purple);
  });
}

// 3. Full cross-product: every combination is stroke-only in its color.
check('cross-product: all 576 combinations are stroke-only in their color', () => {
  let count = 0;
  for (const color of AVATAR_COLORS) {
    for (const eyes of AVATAR_EYES) {
      for (const hands of AVATAR_HANDS) {
        for (const accessory of AVATAR_ACCESSORIES) {
          const svg = renderAvatarSvg({ color: color.id, eyes: eyes.id, hands: hands.id, accessory: accessory.id });
          checkStrokeOnly(svg, color.hex);
          count += 1;
        }
      }
    }
  }
  assert.strictEqual(count, 8 * 4 * 3 * 6);
});

// 4. Overlap handling: the default (folded + none) needs no knockout;
// every other arm/accessory masks the body outline it sits on.
check('mask: default avatar needs no knockout', () => {
  const { maskBody } = splitMask(renderAvatarSvg(DEFAULT_AVATAR));
  assert.strictEqual(knockoutCount(maskBody), 0, 'folded arms with no accessory sit inside the body');
});
for (const hands of ['reaching', 'waving']) {
  check(`mask: ${hands} arm knocks out the body outline`, () => {
    const { maskBody } = splitMask(renderAvatarSvg({ ...DEFAULT_AVATAR, hands }));
    assert.ok(knockoutCount(maskBody) >= 1, `${hands} must hide the body line at its root`);
  });
}
for (const accessory of ['crown', 'glasses', 'headset', 'hat', 'bow']) {
  check(`mask: ${accessory} knocks out the body outline`, () => {
    const { maskBody } = splitMask(renderAvatarSvg({ ...DEFAULT_AVATAR, accessory }));
    assert.ok(knockoutCount(maskBody) >= 1, `${accessory} must hide the body line beneath it`);
  });
}
check('mask: reaching knockout sits on the right-side outline', () => {
  const { maskBody } = splitMask(renderAvatarSvg({ ...DEFAULT_AVATAR, hands: 'reaching' }));
  const lines = [...maskBody.matchAll(/<line x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2="([\d.]+)"/g)];
  assert.ok(lines.length >= 1, 'reaching must contribute a knockout line');
  const nearRightSide = lines.some(match => {
    const xs = [Number(match[1]), Number(match[3])];
    return xs.some(x => x >= 80 && x <= 95);
  });
  assert.ok(nearRightSide, 'reaching knockout must sit near the right-side outline');
});

// Overlap coverage: a knockout count alone cannot prove the body line is
// hidden (the bow's old right-only knockout passed while the dome showed
// through the left loop). Each sample below is a point on the body outline
// that falls inside the named attachment; the mask must erase it, i.e. the
// point must lie within half a knockout width of a knockout segment.
function parseMaskLines(maskBody) {
  return [...maskBody.matchAll(/<line x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2="([\d.]+)" stroke="#000000" stroke-width="([\d.]+)"/g)]
    .map(match => ({
      x1: Number(match[1]),
      y1: Number(match[2]),
      x2: Number(match[3]),
      y2: Number(match[4]),
      w: Number(match[5]),
    }));
}

function distPointToSegment(px, py, line) {
  const dx = line.x2 - line.x1;
  const dy = line.y2 - line.y1;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, ((px - line.x1) * dx + (py - line.y1) * dy) / len2));
  return Math.hypot(px - (line.x1 + t * dx), py - (line.y1 + t * dy));
}

function assertKnockoutCovers(label, svg, points) {
  const { maskBody } = splitMask(svg);
  const lines = parseMaskLines(maskBody);
  assert.ok(lines.length >= 1, `${label}: expected at least one knockout line`);
  for (const [px, py] of points) {
    const covered = lines.some(line => distPointToSegment(px, py, line) <= line.w / 2 + 1e-9);
    assert.ok(covered, `${label}: body point (${px},${py}) must be erased by a knockout`);
  }
}

check('mask: knockouts cover the body outline inside each attachment', () => {
  assertKnockoutCovers(
    'reaching covers the outline under both arms',
    renderAvatarSvg({ ...DEFAULT_AVATAR, hands: 'reaching' }),
    [[88.25, 73], [89.06, 78], [89.71, 82], [90.35, 86]]
  );
  assertKnockoutCovers(
    'waving',
    renderAvatarSvg({ ...DEFAULT_AVATAR, hands: 'waving' }),
    [[33, 65]]
  );
  assertKnockoutCovers(
    'crown',
    renderAvatarSvg({ ...DEFAULT_AVATAR, accessory: 'crown' }),
    [[60, 28], [70, 30]]
  );
  assertKnockoutCovers(
    'hat',
    renderAvatarSvg({ ...DEFAULT_AVATAR, accessory: 'hat' }),
    [[70, 30]]
  );
  assertKnockoutCovers(
    'bow covers the dome under the knot and both loops',
    renderAvatarSvg({ ...DEFAULT_AVATAR, accessory: 'bow' }),
    [[64.3, 28.3], [70, 30], [79, 29]]
  );
  assertKnockoutCovers(
    'headset',
    renderAvatarSvg({ ...DEFAULT_AVATAR, accessory: 'headset' }),
    [[60, 28], [34, 58], [85, 58]]
  );
  assertKnockoutCovers(
    'glasses',
    renderAvatarSvg({ ...DEFAULT_AVATAR, accessory: 'glasses' }),
    [[33, 59], [87, 59]]
  );
  // Combined hands + accessory: the union must cover both attachments.
  assertKnockoutCovers(
    'reaching+bow',
    renderAvatarSvg({ ...DEFAULT_AVATAR, hands: 'reaching', accessory: 'bow' }),
    [[88.25, 73], [64.3, 28.3]]
  );
});

// Brows: every face carries straight, slightly thick brows above both eyes.
function browsOf(svg) {
  const match = svg.match(/<path data-avatar-brows="straight" d="M(\d+) (\d+) H(\d+) M(\d+) (\d+) H(\d+)"[^>]*stroke-width="([\d.]+)"/);
  assert.ok(match, 'every avatar must carry straight brows');
  const [, lx1, ly, lx2, rx1, ry, rx2, width] = match.map(Number);
  return { lx1, ly, lx2, rx1, ry, rx2, width };
}
check('brows: every combination renders straight, slightly thick brows above the eyes', () => {
  for (const color of AVATAR_COLORS) {
    for (const eyes of AVATAR_EYES) {
      for (const hands of AVATAR_HANDS) {
        for (const accessory of AVATAR_ACCESSORIES) {
          const brows = browsOf(renderAvatarSvg({ color: color.id, eyes: eyes.id, hands: hands.id, accessory: accessory.id }));
          assert.strictEqual(brows.ly, brows.ry, 'both brows sit on one level');
          assert.ok(brows.ly < 50, 'brows sit above the eyes');
          assert.ok(brows.lx1 < 48 && brows.lx2 > 48, 'left brow spans the left eye');
          assert.ok(brows.rx1 < 72 && brows.rx2 > 72, 'right brow spans the right eye');
          assert.ok(brows.width > 3.5 && brows.width <= 5.5, 'brows are slightly thicker than the outline');
        }
      }
    }
  }
});

// Reaching right: both arms high, stacked near mouth level, equal longer reach.
check('reaching: both arms are stacked near mouth level with the longer reach', () => {
  const svg = renderAvatarSvg({ ...DEFAULT_AVATAR, hands: 'reaching' });
  const group = svg.match(/<g data-avatar-layer="hands" data-avatar-hands="reaching">([\s\S]*?)<\/g>/)[1];
  const arms = [...group.matchAll(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/g)]
    .map(match => ({ x: Number(match[1]), y: Number(match[2]), w: Number(match[3]), h: Number(match[4]) }));
  assert.strictEqual(arms.length, 2, 'reaching renders two arms');
  const [top, bottom] = arms;
  assert.strictEqual(top.x, bottom.x, 'arms are stacked on the same start');
  assert.strictEqual(top.w, bottom.w, 'both arms share the longer reach');
  assert.ok(top.y + top.h < bottom.y, 'arms are stacked without overlapping');
  // Mouth spans y 71-75.5 (SMILE_PATH); folded bars start at y 79.
  assert.ok(top.y <= 72 && top.y + top.h >= 75, 'top arm sits level with the mouth');
  assert.ok(bottom.y + bottom.h <= 89, 'the stacked pair stays high, clear of the lower body');
  assert.ok(bottom.y - (top.y + top.h) <= top.h, 'arms stack closely, gap no wider than an arm');
  assert.ok(top.x > 67.75, 'arms start right of the smile so they do not cross it');
  assert.ok(top.x + top.w > 105, 'arms reach well past the body outline');
});

check('reaching: arms mask hides eye and accessory lines inside the arms', () => {
  for (const accessory of AVATAR_ACCESSORIES) {
    const svg = renderAvatarSvg({ ...DEFAULT_AVATAR, hands: 'reaching', accessory: accessory.id }, 'r1');
    assert.ok(svg.includes('<mask id="avatar-arms-r1">'), `${accessory.id}: reaching must define an arms mask`);
    assert.match(svg, /<g mask="url\(#avatar-arms-r1\)"><g data-avatar-layer="eyes"/, `${accessory.id}: eyes sit behind the arms`);
    assert.match(svg, /<g mask="url\(#avatar-arms-r1\)"><g data-avatar-layer="accessory"/, `${accessory.id}: accessory sits behind the arms`);
  }
  const folded = renderAvatarSvg(DEFAULT_AVATAR, 'f1');
  assert.ok(!folded.includes('avatar-arms-'), 'other poses keep a single mask');
});

// 5. Determinism: repeated renders are byte-identical; uid only re-scopes
// the mask id so many avatars can share a page.
check('render is deterministic across repeated renders', () => {
  const config = { color: 'teal', eyes: 'happy', hands: 'waving', accessory: 'hat' };
  assert.strictEqual(renderAvatarSvg(config), renderAvatarSvg(config));
});
check('render uid only re-scopes the mask id', () => {
  const config = { color: 'teal', eyes: 'happy', hands: 'waving', accessory: 'hat' };
  const first = renderAvatarSvg(config, 'one');
  const second = renderAvatarSvg(config, 'two');
  assert.ok(first.includes('id="avatar-knockout-one"'), 'uid must scope the mask id');
  assert.ok(second.includes('id="avatar-knockout-two"'), 'uid must scope the mask id');
  assert.strictEqual(
    second.replaceAll('two', 'one'),
    first,
    'only the mask id may differ between uids'
  );
});

// 6. Defaults: unconfigured bots read purple/dots/folded/none; the Chief
// of Staff reads purple with a crown; stored values always win.
check('defaults: unconfigured bot resolves to purple/dots/folded/none', () => {
  assert.deepStrictEqual(resolveAvatar({}), DEFAULT_AVATAR);
  assert.deepStrictEqual(resolveAvatar({ name: 'Relay' }), DEFAULT_AVATAR);
  assert.deepStrictEqual(DEFAULT_AVATAR, { color: 'purple', eyes: 'dots', hands: 'folded', accessory: 'none' });
});
check('defaults: Chief of Staff resolves to purple with a crown', () => {
  assert.deepStrictEqual(resolveAvatar({ name: 'chief-of-staff' }), CHIEF_OF_STAFF_AVATAR);
  assert.deepStrictEqual(resolveAvatar({ name: 'Chief-Of-Staff' }), CHIEF_OF_STAFF_AVATAR);
  assert.strictEqual(CHIEF_OF_STAFF_AVATAR.accessory, 'crown');
  assert.strictEqual(CHIEF_OF_STAFF_AVATAR.color, 'purple');
});
check('defaults: stored values win, unknown values fall back', () => {
  const resolved = resolveAvatar({
    name: 'chief-of-staff',
    avatar_color: 'teal',
    avatar_eyes: 'wide',
    avatar_hands: 'reaching',
    avatar_accessory: 'bow',
  });
  assert.deepStrictEqual(resolved, { color: 'teal', eyes: 'wide', hands: 'reaching', accessory: 'bow' });
  assert.deepStrictEqual(
    resolveAvatar({ name: 'Relay', avatar_color: 'nope', avatar_eyes: null, avatar_hands: undefined, avatar_accessory: '' }),
    DEFAULT_AVATAR
  );
});
check('avatarStroke maps each color id to its line hex', () => {
  for (const entry of AVATAR_COLORS) {
    assert.strictEqual(avatarStroke({ ...DEFAULT_AVATAR, color: entry.id }), entry.hex);
  }
});

// 7. Validation: unknown option ids are rejected for the API contract.
check('validateAvatarInput accepts a full valid object', () => {
  const result = validateAvatarInput({ color: 'teal', eyes: 'happy', hands: 'waving', accessory: 'hat' });
  assert.deepStrictEqual(result.errors, []);
  assert.deepStrictEqual(result.fields, {
    avatar_color: 'teal',
    avatar_eyes: 'happy',
    avatar_hands: 'waving',
    avatar_accessory: 'hat',
  });
});
check('validateAvatarInput rejects unknown option ids', () => {
  for (const bad of [
    { color: 'magenta' },
    { eyes: 'wink' },
    { hands: 'clapping' },
    { accessory: 'halo' },
  ]) {
    const result = validateAvatarInput(bad);
    assert.strictEqual(result.errors.length, 1, `${JSON.stringify(bad)} must be rejected`);
  }
  const nonObject = validateAvatarInput('purple');
  assert.ok(nonObject.errors.length >= 1, 'non-object avatar input must be rejected');
});

// 8. Persistence: avatar fields survive create/update/reload and read back
// through serializeBot with the required defaults.
(function persistence() {
  const DB_PATH = path.join(os.tmpdir(), `botmancers-avatar-test-${process.pid}.db`);
  for (const suffix of ['', '-shm', '-wal']) {
    try { fs.rmSync(DB_PATH + suffix, { force: true }); } catch { /* fresh start */ }
  }
  process.env.BOTMANCERS_DB_PATH = DB_PATH;
  process.env.BOTMANCERS_NO_AUTOPROCESS = '1';

  const db = jiti('./lib/db.ts');
  const def = jiti('./lib/bot-definition.ts');

  const created = db.bots.create({ deck_id: 'deck-test',
    name: 'Relay',
    title: 'Coding Relay',
    description: 'Relays work.',
    avatar_color: 'teal',
    avatar_eyes: 'happy',
    avatar_hands: 'waving',
    avatar_accessory: 'hat',
  });
  check('persistence: created bot stores its avatar fields', () => {
    const reloaded = db.bots.getById(created.id);
    assert.strictEqual(reloaded.avatar_color, 'teal');
    assert.strictEqual(reloaded.avatar_eyes, 'happy');
    assert.strictEqual(reloaded.avatar_hands, 'waving');
    assert.strictEqual(reloaded.avatar_accessory, 'hat');
  });

  check('persistence: partial update keeps the other stored fields', () => {
    db.bots.updateAvatarConfig(created.id, { avatar_color: 'pink' });
    const reloaded = db.bots.getById(created.id);
    assert.strictEqual(reloaded.avatar_color, 'pink');
    assert.strictEqual(reloaded.avatar_eyes, 'happy');
    assert.strictEqual(reloaded.avatar_hands, 'waving');
    assert.strictEqual(reloaded.avatar_accessory, 'hat');
  });

  check('persistence: serializeBot reads back the saved configuration', () => {
    const reloaded = db.bots.getById(created.id);
    const serialized = def.serializeBot(reloaded);
    assert.deepStrictEqual(serialized.avatar_config, {
      color: 'pink',
      eyes: 'happy',
      hands: 'waving',
      accessory: 'hat',
    });
  });

  check('persistence: unconfigured bot serializes to the required defaults', () => {
    const plain = db.bots.create({ deck_id: 'deck-test', name: 'Plain', title: '', description: '' });
    const serialized = def.serializeBot(db.bots.getById(plain.id));
    assert.deepStrictEqual(serialized.avatar_config, DEFAULT_AVATAR);
  });

  check('persistence: unconfigured Chief of Staff serializes to purple with a crown', () => {
    const chief = db.bots.create({ deck_id: 'deck-test', name: 'chief-of-staff', title: '', description: '' });
    const serialized = def.serializeBot(db.bots.getById(chief.id));
    assert.deepStrictEqual(serialized.avatar_config, CHIEF_OF_STAFF_AVATAR);
  });

  for (const suffix of ['', '-shm', '-wal']) {
    try { fs.rmSync(DB_PATH + suffix, { force: true }); } catch { /* cleanup */ }
  }
})();

// 9. Snapshot: avatar fields are part of the hashed launch input.
check('snapshot: avatar fields round-trip and change the launch hash', () => {
  const bot = { name: 'Alice', title: '', description: '' };
  const skill = { path: null, present: null, content: null };
  const base = snapshot.buildSnapshotInput(bot, skill);
  assert.strictEqual(base.avatar_color, null);
  assert.strictEqual(base.avatar_eyes, null);
  assert.strictEqual(base.avatar_hands, null);
  assert.strictEqual(base.avatar_accessory, null);
  const configured = snapshot.buildSnapshotInput(
    { ...bot, avatar_color: 'teal', avatar_eyes: 'happy', avatar_hands: 'waving', avatar_accessory: 'hat' },
    skill
  );
  assert.notStrictEqual(
    snapshot.hashSnapshot(base),
    snapshot.hashSnapshot(configured),
    'configuring an avatar must change the launch hash'
  );
  const repeated = snapshot.buildSnapshotInput(
    { ...bot, avatar_color: 'teal', avatar_eyes: 'happy', avatar_hands: 'waving', avatar_accessory: 'hat' },
    skill
  );
  assert.strictEqual(
    snapshot.hashSnapshot(configured),
    snapshot.hashSnapshot(repeated),
    'the same avatar configuration must hash identically'
  );
});

// 10. Option-sheet artifact: one SVG sheet with every approved option for
// visual proof (written outside the repo; path is overridable).
check('option sheet artifact is generated', () => {
  const out = process.env.AVATAR_SHEET_OUT || '/tmp/botmancers-avatar-sheet.svg';
  const cell = 140;
  const pad = 16;
  function nested(config, x, y, label) {
    const inner = renderAvatarSvg(config, `sheet-${config.color}-${config.eyes}-${config.hands}-${config.accessory}`)
      .replace('<svg ', `<svg x="${x}" y="${y}" width="120" height="120" `);
    return `${inner}<text x="${x + 60}" y="${y + 134}" text-anchor="middle" font-size="11" fill="#888888">${label}</text>`;
  }
  const parts = [];
  let x = pad;
  let y = pad;
  for (const color of AVATAR_COLORS) {
    parts.push(nested({ ...DEFAULT_AVATAR, color: color.id }, x, y, color.id));
    x += cell;
  }
  x = pad;
  y += cell + 20;
  for (const eyes of AVATAR_EYES) {
    parts.push(nested({ ...DEFAULT_AVATAR, eyes: eyes.id }, x, y, `eyes:${eyes.id}`));
    x += cell;
  }
  for (const hands of AVATAR_HANDS) {
    parts.push(nested({ ...DEFAULT_AVATAR, hands: hands.id }, x, y, `hands:${hands.id}`));
    x += cell;
  }
  x = pad;
  y += cell + 20;
  for (const accessory of AVATAR_ACCESSORIES) {
    parts.push(nested({ ...DEFAULT_AVATAR, accessory: accessory.id }, x, y, `acc:${accessory.id}`));
    x += cell;
  }
  const width = pad * 2 + cell * 8;
  const height = y + cell + 30;
  const sheet =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<rect x="0" y="0" width="${width}" height="${height}" fill="none"/>` +
    parts.join('') +
    `</svg>`;
  fs.writeFileSync(out, sheet, 'utf8');
  const stats = fs.statSync(out);
  assert.ok(stats.size > 20000, `option sheet must be substantive (got ${stats.size} bytes)`);
  console.log(`option sheet: ${out} (${stats.size} bytes)`);
});

console.log(`\ntest:avatar-system: ${passed}/${passed} assertions passing`);
