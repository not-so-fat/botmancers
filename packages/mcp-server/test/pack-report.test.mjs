// Unit tests for scripts/pack-report.mjs. Unlike the other package tests
// these need no build output: they feed synthetic pack file lists and a
// hand-built tarball through the pure report functions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { formatHuman, formatJson, listTarballFiles, parseArgs, summarize } from '../scripts/pack-report.mjs';

const FILES = [
  { path: 'package.json', size: 1000 },
  { path: 'dist/cli.js', size: 9000 },
  { path: 'dist/cli.d.ts', size: 1000 },
  { path: 'app/server.js', size: 7000 },
  { path: 'app/node_modules/next/dist/server/base.js', size: 50_000 },
  { path: 'app/node_modules/next/package.json', size: 5000 },
  { path: 'app/node_modules/@slack/web-api/dist/index.js', size: 20_000 },
  { path: 'app/node_modules/better-sqlite3/prebuilds/linux-x64.node', size: 4_000_000 },
  { path: 'app/node_modules/better-sqlite3/lib/index.js', size: 10_000 },
  { path: 'app/.next/BUILD_ID', size: 20 },
  { path: 'app/.next/server/app/page.js', size: 300_000 },
  { path: 'app/.next/static/chunks/app.js', size: 100_000 },
];

test('summarize totals bytes and counts every file', () => {
  const summary = summarize(FILES);
  assert.equal(summary.unpacked, FILES.reduce((sum, file) => sum + file.size, 0));
  assert.equal(summary.count, FILES.length);
});

test('summarize groups bytes per top-level directory with root files together', () => {
  const summary = summarize(FILES);
  const byKey = Object.fromEntries(summary.topLevel.map(group => [group.key, group]));
  assert.equal(byKey['(root)'].bytes, 1000);
  assert.equal(byKey['(root)'].count, 1);
  assert.equal(byKey.dist.bytes, 10_000);
  assert.equal(byKey.app.bytes, FILES.filter(file => file.path.startsWith('app/')).reduce((sum, file) => sum + file.size, 0));
  assert.deepEqual(summary.topLevel.map(group => group.bytes), [...summary.topLevel.map(group => group.bytes)].sort((a, b) => b - a));
});

test('summarize groups app/node_modules by package, keeping scopes together', () => {
  const summary = summarize(FILES, { top: 10 });
  const byKey = Object.fromEntries(summary.nodeModules.map(group => [group.key, group]));
  assert.equal(byKey['app/node_modules/next'].bytes, 55_000);
  assert.equal(byKey['app/node_modules/@slack/web-api'].bytes, 20_000);
  assert.equal(byKey['app/node_modules/better-sqlite3'].bytes, 4_010_000);
  assert.equal(summary.nodeModuleGroups, 3);
});

test('summarize groups app/.next one level below the build directory', () => {
  const summary = summarize(FILES, { top: 10 });
  const byKey = Object.fromEntries(summary.nextBuild.map(group => [group.key, group]));
  assert.equal(byKey['app/.next/server'].bytes, 300_000);
  assert.equal(byKey['app/.next/static'].bytes, 100_000);
  assert.equal(byKey['app/.next/BUILD_ID'].bytes, 20);
});

test('summarize subtotals the better-sqlite3 prebuilds separately', () => {
  const summary = summarize(FILES);
  assert.deepEqual(summary.prebuilds, { bytes: 4_000_000, count: 1 });
});

test('summarize honours --top and reports the overflow', () => {
  const summary = summarize(FILES, { top: 1 });
  assert.equal(summary.nodeModules.length, 1);
  assert.equal(summary.nodeModules[0].key, 'app/node_modules/better-sqlite3');
  assert.equal(summary.nextBuild.length, 1);
  assert.equal(summary.nextBuild[0].key, 'app/.next/server');
});

function header({ name, size, type }) {
  const block = Buffer.alloc(512);
  block.write(name, 0, 100, 'utf8');
  block.write(size.toString(8).padStart(7, '0'), 124, 'ascii');
  block[156] = type.charCodeAt(0);
  return block;
}

function entry(name, text) {
  const data = Buffer.from(text);
  return Buffer.concat([header({ name, size: data.length, type: '0' }), data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}

test('listTarballFiles reads npm-style package/ entries and GNU longnames', () => {
  const long = `package/app/node_modules/some-dep/${'d'.repeat(120)}/index.js`;
  const gnuLong = Buffer.concat([
    header({ name: '././@LongLink', size: long.length + 1, type: 'L' }),
    Buffer.from(`${long}\0`),
    Buffer.alloc(512 - ((long.length + 1) % 512)),
    header({ name: 'placeholder', size: 3, type: '0' }),
    Buffer.from('x'.repeat(3)),
    Buffer.alloc(512 - 3),
  ]);
  const tarball = gzipSync(Buffer.concat([
    entry('package/package.json', '{"a":1}'),
    entry('package/dist/cli.js', '#!/usr/bin/env node\n'),
    gnuLong,
    Buffer.alloc(1024),
  ]));
  assert.deepEqual(listTarballFiles(tarball), [
    { path: 'package.json', size: 7 },
    { path: 'dist/cli.js', size: 20 },
    { path: long.replace(/^package\//, ''), size: 3 },
  ]);
});

test('listTarballFiles joins ustar prefix names and skips directories', () => {
  const block = header({ name: 'index.js', size: 1, type: '0' });
  block.write('package/app/node_modules/some-dep/nested', 345, 'utf8');
  const dir = header({ name: 'package/app/', size: 0, type: '5' });
  const tarball = gzipSync(Buffer.concat([dir, block, Buffer.from('z'), Buffer.alloc(511), Buffer.alloc(1024)]));
  assert.deepEqual(listTarballFiles(tarball), [{ path: 'app/node_modules/some-dep/nested/index.js', size: 1 }]);
});

test('parseArgs defaults the top-N window and rejects bad input', () => {
  assert.deepEqual(parseArgs(['pack.tgz']), { spec: 'pack.tgz', top: 15, json: false });
  assert.deepEqual(parseArgs(['pack.json', '--top', '3', '--json']), { spec: 'pack.json', top: 3, json: true });
  assert.throws(() => parseArgs(['a.tgz', 'b.tgz']), /single tarball-or-json/);
  assert.throws(() => parseArgs(['a.tgz', '--top', '0']), /positive integer/);
  assert.throws(() => parseArgs(['a.tgz', '--bogus']), /unknown flag/);
});

test('formatHuman and formatJson report the same totals', () => {
  const pack = { source: 'pack.tgz', compressed: 1000, unpacked: 3000, count: FILES.length, files: FILES };
  const summary = summarize(FILES);
  const human = formatHuman(pack, summary);
  assert.match(human, /pack-report: pack\.tgz/);
  assert.match(human, /compressed: 1,000 B/);
  assert.match(human, /unpacked:.*in 12 files/);
  assert.match(human, /better-sqlite3 prebuilds: 4,000,000 B/);
  assert.match(human, /top 15 app\/node_modules packages/);
  const json = JSON.parse(formatJson(pack, summary));
  assert.equal(json.compressed, 1000);
  assert.equal(json.unpacked, summary.unpacked);
  assert.equal(json.count, FILES.length);
  assert.equal(json.prebuilds.bytes, 4_000_000);
});
