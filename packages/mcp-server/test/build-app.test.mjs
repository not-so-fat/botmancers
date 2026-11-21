// Unit tests for the scripts/build-app.mjs .next assembly filter. Like the
// pack-report tests these need no build output: they feed synthetic
// standalone paths through the pure keepNextEntry predicate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { keepNextEntry } from '../scripts/build-app.mjs';

const STANDALONE_NEXT = join('standalone', '.next');
const entry = (...parts) => join(STANDALONE_NEXT, ...parts);

test('the filter keeps the runtime .next entries, including the .js next to a manifest', () => {
  for (const src of [
    STANDALONE_NEXT,
    entry('BUILD_ID'),
    entry('package.json'),
    entry('required-server-files.json'),
    entry('server', 'app', 'api', 'health', 'route.js'),
    entry('server', 'app', 'page.js'),
    entry('server', 'app', 'api', 'bots', 'route.js'),
    entry('static', 'chunks', 'app.js'),
    entry('routes-manifest.json'),
  ]) {
    assert.equal(keepNextEntry(STANDALONE_NEXT, src), true, src);
  }
});

test('the filter drops source maps, tracing manifests, and the top-level build artifacts', () => {
  for (const src of [
    entry('server', 'app', 'page.js.map'),
    entry('static', 'chunks', 'app.js.map'),
    entry('server', 'app', 'page.js.nft.json'),
    entry('server', 'app', 'api', 'bots', 'route.js.nft.json'),
    entry('trace'),
    entry('trace-build'),
    entry('types', 'validator.ts'),
    entry('diagnostics', 'build-diagnostics.json'),
    entry('lock'),
    entry('cache'),
    entry('cache', 'x.json'),
  ]) {
    assert.equal(keepNextEntry(STANDALONE_NEXT, src), false, src);
  }
});

test('the filter only drops cache paths, not names that merely contain it', () => {
  assert.equal(keepNextEntry(STANDALONE_NEXT, entry('server', 'cache.js')), true);
});
