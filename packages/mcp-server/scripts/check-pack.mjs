// Asserts what `npm pack` would publish: only compiled runtime files,
// versioned schemas, README/LICENSE/CHANGELOG, and package.json, with no
// secret-looking content. Usage: node scripts/check-pack.mjs [--out file]
// (run after `npm run build`; the dry run skips lifecycle scripts).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

export const ALLOWED = [
  /^package\.json$/,
  /^README\.md$/,
  /^LICENSE$/,
  /^CHANGELOG\.md$/,
  /^dist\/[a-z0-9-]+\.(?:js|d\.ts)$/,
  /^schemas\/botmancers\.mcp\.v\d+\.tools\.json$/,
];

export const REQUIRED = ['package.json', 'README.md', 'LICENSE', 'CHANGELOG.md', 'dist/cli.js', 'dist/index.js', 'dist/index.d.ts', 'schemas/botmancers.mcp.v1.tools.json'];

const SECRET_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'],
  [/\bnpm_[A-Za-z0-9]{36}\b/, 'npm token'],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/, 'GitHub token'],
  [/\bsk-[A-Za-z0-9_-]{20,}/, 'API key'],
  [/sha256:[0-9a-f]{64}/, 'service token digest'],
  [/\b(?:[A-Z][A-Z0-9_]*_(?:TOKEN|SECRET|KEY))=[^\s"'`<$.][^\s"'`]{7,}/, 'assigned credential'],
];

export function packManifest() {
  const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: PACKAGE_DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const [entry] = JSON.parse(out);
  return entry;
}

// Returns the list of problems (empty when the manifest is acceptable).
export function checkManifest(entry) {
  const problems = [];
  const paths = entry.files.map(file => file.path).sort();
  for (const path of paths) {
    if (!ALLOWED.some(pattern => pattern.test(path))) problems.push(`not allowlisted: ${path}`);
  }
  for (const path of REQUIRED) {
    if (!paths.includes(path)) problems.push(`missing: ${path}`);
  }
  for (const path of paths) {
    if (!existsSync(join(PACKAGE_DIR, path))) continue;
    const text = readFileSync(join(PACKAGE_DIR, path), 'utf8');
    for (const [pattern, label] of SECRET_PATTERNS) {
      if (pattern.test(text)) problems.push(`${label}-like content in ${path}`);
    }
  }
  const manifest = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8'));
  if (manifest.name !== 'botmancers') problems.push(`package name is ${manifest.name}, expected botmancers`);
  if (manifest.private) problems.push('package.json is private');
  if (manifest.bin?.botmancers !== 'dist/cli.js') problems.push('bin.botmancers must be dist/cli.js');
  if (!manifest.engines?.node) problems.push('engines.node is not set');
  if (manifest.license !== 'MIT') problems.push('license is not MIT');
  if (manifest.repository?.directory !== 'packages/mcp-server') problems.push('repository.directory must be packages/mcp-server');
  if (Object.keys(manifest.dependencies ?? {}).length) problems.push('the package must have no runtime dependencies');
  if (!readFileSync(join(PACKAGE_DIR, 'dist/cli.js'), 'utf8').startsWith('#!/usr/bin/env node')) problems.push('dist/cli.js has no node shebang');
  return problems;
}

export function formatManifest(entry) {
  const lines = [`${entry.name}@${entry.version}  ${entry.filename}`, `size ${entry.size} B, unpacked ${entry.unpackedSize} B, ${entry.entryCount} files`, `shasum ${entry.shasum}`];
  for (const file of [...entry.files].sort((a, b) => a.path.localeCompare(b.path))) lines.push(`${String(file.size).padStart(8)}  ${file.path}`);
  return `${lines.join('\n')}\n`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const entry = packManifest();
  const text = formatManifest(entry);
  process.stdout.write(text);
  const outAt = process.argv.indexOf('--out');
  if (outAt > 0 && process.argv[outAt + 1]) writeFileSync(process.argv[outAt + 1], text);
  const problems = checkManifest(entry);
  if (problems.length) {
    process.stderr.write(`package contents check FAILED:\n${problems.map(p => `  - ${p}`).join('\n')}\n`);
    process.exit(1);
  }
  process.stdout.write('package contents check passed: allowlist only, no secrets.\n');
}
