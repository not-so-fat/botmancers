// Asserts what `npm pack` would publish: the compiled CLI/bridge, versioned
// schemas, README/LICENSE/CHANGELOG, package.json, and the assembled app/
// runtime (standalone Next.js server, .next build, static/public assets, and
// the bundled node_modules it needs), with no TypeScript source, tests,
// checkout docs, databases, logs, environment files, credentials, user
// state, secret-looking content, .next build artifacts, or the build
// machine's checkout path.
// Usage: node scripts/check-pack.mjs [--out file]
// (run after `npm run build` and `npm run build:app`; the dry run skips
// lifecycle scripts).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = join(PACKAGE_DIR, '..', '..');

export const ALLOWED = [
  /^package\.json$/,
  /^README\.md$/,
  /^LICENSE$/,
  /^CHANGELOG\.md$/,
  /^dist\/[a-z0-9-]+\.(?:js|d\.ts)$/,
  /^schemas\/botmancers\.mcp\.v\d+\.tools\.json$/,
  /^skills\/botmancers-collaboration\/(?:SKILL\.md|references\/[a-z0-9-]+\.md)$/,
  /^app\/(?:server\.js|package\.json|BUILD_INFO\.json)$/,
  /^app\/(?:\.next|node_modules|public)\//,
];

// Never shipped anywhere, including inside app/.
export const FORBIDDEN = [
  [/\.(?:db|db-wal|db-shm|sqlite|sqlite3|log|tgz|map)$/i, 'database, log, archive, or source map'],
  [/(?:^|\/)\.env(?:\.|$)/, 'environment file'],
  [/(?:^|\/)(?:core|bridge)\.env$/, 'generated credentials'],
  [/(?:^|\/)\.npmrc$/, 'npm configuration'],
  [/(?:^|\/)(?:id_rsa|id_ed25519)[^/]*$|\.pem$|\.key$/, 'key material'],
  // NOT-651 safe exclusions: .next/ build artifacts the server never reads
  // (trace telemetry, generated route types, analyzer diagnostics, the
  // build lock, the build cache) and the sharp wasm runtime, whose only
  // requirer (sharp) is already excluded.
  [/^app\/\.next\/(?:trace(?:-build)?|types|diagnostics|cache)(?:\/|$)/, '.next build artifact'],
  [/^app\/\.next\/lock$/, '.next build lock'],
  [/^app\/node_modules\/@emnapi\//, 'sharp wasm runtime without sharp'],
];

// TypeScript source must not ship outside third-party node_modules.
const OWN_SOURCE = /^(?!app\/node_modules\/).*(?<!\.d)\.(?:ts|tsx|mts|cts)$/;

export const REQUIRED = [
  'package.json', 'README.md', 'LICENSE', 'CHANGELOG.md',
  'dist/cli.js', 'dist/index.js', 'dist/index.d.ts', 'dist/product.js', 'dist/setup.js', 'dist/home.js', 'dist/server.js',
  'dist/managed.js', 'dist/upgrade.js',  // managed install: launcher, release trees, updater
  'schemas/botmancers.mcp.v1.tools.json', 'schemas/botmancers.mcp.v2.tools.json',
  'dist/clients.js', 'skills/botmancers-collaboration/SKILL.md', 'skills/botmancers-collaboration/references/workflows.md',
  'app/server.js', 'app/package.json', 'app/BUILD_INFO.json', 'app/.next/BUILD_ID',
  'app/.next/required-server-files.json', 'app/.next/server/app/api/health/route.js',
  'app/public/brand/botmancers-logo-filled-64.png',
  'app/node_modules/next/package.json', 'app/node_modules/react/package.json', 'app/node_modules/react-dom/package.json',
  'app/node_modules/better-sqlite3/package.json', 'app/node_modules/better-sqlite3/lib/index.js',
  ...['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'linuxmusl-x64', 'linuxmusl-arm64', 'win32-x64', 'win32-arm64']
    .map(platform => `app/node_modules/better-sqlite3/prebuilds/${platform}.node`),
];

export const SECRET_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'],
  [/\bnpm_[A-Za-z0-9]{36}\b/, 'npm token'],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/, 'GitHub token'],
  [/\bsk-[A-Za-z0-9_-]{20,}/, 'API key'],
  [/\bbm(?:svc|mcp)_[0-9a-f]{64}\b/, 'generated botmancers token'],
  [/sha256:[0-9a-f]{64}/, 'service token digest'],
  [/\b(?:[A-Z][A-Z0-9_]*_(?:TOKEN|SECRET|KEY))=[^\s"'`<$.][^\s"'`]{7,}/, 'assigned credential'],
];

const TEXT = /\.(?:js|cjs|mjs|json|md|html|rsc|txt|css|meta|body|d\.ts)$|^(?:LICENSE|BUILD_ID)$/;

export function packManifest() {
  const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: PACKAGE_DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  const [entry] = JSON.parse(out);
  return entry;
}

export function buildInfo() {
  try {
    return JSON.parse(readFileSync(join(PACKAGE_DIR, 'app/BUILD_INFO.json'), 'utf8'));
  } catch {
    return null;
  }
}

// Returns the list of problems (empty when the manifest is acceptable).
export function checkManifest(entry) {
  const problems = [];
  const paths = entry.files.map(file => file.path).sort();
  for (const path of paths) {
    if (!ALLOWED.some(pattern => pattern.test(path))) problems.push(`not allowlisted: ${path}`);
    for (const [pattern, label] of FORBIDDEN) if (pattern.test(path)) problems.push(`forbidden (${label}): ${path}`);
    if (OWN_SOURCE.test(path)) problems.push(`forbidden (TypeScript source): ${path}`);
  }
  for (const path of REQUIRED) {
    if (!paths.includes(path)) problems.push(`missing: ${path}`);
  }
  if (!paths.some(path => path.startsWith('app/.next/static/'))) problems.push('missing: app/.next/static/ assets');
  const checkout = REPO_ROOT.replace(/\/+$/, '');
  for (const path of paths) {
    const absolute = join(PACKAGE_DIR, path);
    if (!existsSync(absolute) || statSync(absolute).size > 32 * 1024 * 1024) continue;
    const text = readFileSync(absolute, 'utf8');
    // Bundled third-party code is scanned for checkout paths only; its
    // documentation legitimately shows placeholder credentials.
    const own = !path.startsWith('app/node_modules/');
    if (own && TEXT.test(path.split('/').pop())) {
      for (const [pattern, label] of SECRET_PATTERNS) {
        if (pattern.test(text)) problems.push(`${label}-like content in ${path}`);
      }
    }
    if (text.includes(checkout)) problems.push(`build checkout path in ${path}`);
  }
  const manifest = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8'));
  if (manifest.name !== 'botmancers') problems.push(`package name is ${manifest.name}, expected botmancers`);
  if (manifest.private) problems.push('package.json is private');
  if (manifest.bin?.botmancers !== 'dist/cli.js') problems.push('bin.botmancers must be dist/cli.js');
  if (!manifest.engines?.node) problems.push('engines.node is not set');
  if (manifest.license !== 'MIT') problems.push('license is not MIT');
  if (manifest.repository?.directory !== 'packages/mcp-server') problems.push('repository.directory must be packages/mcp-server');
  if (Object.keys(manifest.dependencies ?? {}).length) problems.push('the package must have no install-time dependencies (the app runtime is bundled under app/node_modules)');
  if (!readFileSync(join(PACKAGE_DIR, 'dist/cli.js'), 'utf8').startsWith('#!/usr/bin/env node')) problems.push('dist/cli.js has no node shebang');
  const info = buildInfo();
  if (!info) problems.push('app/BUILD_INFO.json is missing or unreadable; run npm run build:app');
  else if (info.version !== manifest.version) problems.push(`app/ was built as ${info.version}, package is ${manifest.version}; run npm run build:app`);
  const appPackage = existsSync(join(PACKAGE_DIR, 'app/package.json')) ? JSON.parse(readFileSync(join(PACKAGE_DIR, 'app/package.json'), 'utf8')) : {};
  if (appPackage.type !== 'commonjs') problems.push('app/package.json must declare "type": "commonjs" for the standalone server');
  return problems;
}

// Package-level files individually; app/ summarized by area plus the
// bundled module versions (the full list is 1,500+ entries).
export function formatManifest(entry) {
  const info = buildInfo();
  const lines = [
    `${entry.name}@${entry.version}  ${entry.filename}`,
    `size ${entry.size} B, unpacked ${entry.unpackedSize} B, ${entry.entryCount} files`,
    `shasum ${entry.shasum}`,
    `integrity ${entry.integrity}`,
    `app build ${info ? `${info.version} commit ${info.commit}${info.dirty ? ' (dirty tree)' : ''}, next ${info.next}` : 'missing'}`,
  ];
  const files = [...entry.files].sort((a, b) => a.path.localeCompare(b.path));
  for (const file of files.filter(f => !f.path.startsWith('app/') || /^app\/[^/]+$/.test(f.path))) lines.push(`${String(file.size).padStart(8)}  ${file.path}`);
  const areas = new Map();
  for (const file of files.filter(f => f.path.startsWith('app/'))) {
    const parts = file.path.split('/');
    const key = parts[1] === 'node_modules'
      ? `app/node_modules/${parts[2].startsWith('@') ? `${parts[2]}/${parts[3]}` : parts[2]}`
      : parts.length > 2 ? `app/${parts[1]}/${parts[1] === '.next' ? `${parts[2]}${parts.length > 3 ? '/' : ''}` : ''}` : null;
    if (!key) continue;
    const area = areas.get(key) ?? { count: 0, size: 0 };
    area.count++;
    area.size += file.size;
    areas.set(key, area);
  }
  for (const [key, area] of [...areas].sort(([a], [b]) => a.localeCompare(b))) {
    let version = '';
    if (key.startsWith('app/node_modules/')) {
      try { version = `@${JSON.parse(readFileSync(join(PACKAGE_DIR, key, 'package.json'), 'utf8')).version}`; } catch { /* no manifest */ }
    }
    lines.push(`${String(area.size).padStart(8)}  ${key}${version}  (${area.count} files)`);
  }
  return `${lines.join('\n')}\n`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let commit = 'unknown';
  try {
    commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: PACKAGE_DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { /* not a git checkout */ }
  const entry = packManifest();
  const problems = checkManifest(entry);
  const verdict = problems.length
    ? `package contents check FAILED:\n${problems.map(p => `  - ${p}`).join('\n')}\n`
    : 'package contents check passed: allowlist only, required runtime present, no source, state, secrets, or checkout paths.\n';
  const text = `commit ${commit}\n${formatManifest(entry)}`;
  process.stdout.write(text);
  const outAt = process.argv.indexOf('--out');
  if (outAt > 0 && process.argv[outAt + 1]) writeFileSync(process.argv[outAt + 1], text + verdict);
  if (problems.length) {
    process.stderr.write(verdict);
    process.exit(1);
  }
  process.stdout.write(verdict);
}
