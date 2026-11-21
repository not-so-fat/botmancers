// Reports where a botmancers pack's bytes go: compressed size, unpacked
// size, file count, bytes per top-level directory, and the largest subtrees
// of app/node_modules and app/.next.
//
//   node scripts/pack-report.mjs <tarball.tgz|pack.json> [--top N] [--json]
//
// The input is either an npm tarball (compressed size from the file itself,
// contents from its tar index) or saved `npm pack --json` /
// `npm pack --dry-run --json` output (an array whose first entry has
// filename/size/unpackedSize/entryCount/files). `--top N` (default 15)
// controls how many app/node_modules and app/.next rows print.
import { readFileSync, statSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

export const DEFAULT_TOP = 15;

// ---- input readers -------------------------------------------------------

function stripTarPrefix(name) {
  return name.replace(/^\.\//, '').replace(/^package\//, '');
}

function parseOctal(bytes, start, end) {
  const text = Buffer.from(bytes.subarray(start, end)).toString('ascii').replace(/\0.*$/, '').trim();
  if (!/^[0-7]*$/.test(text)) throw new Error('invalid tar header (size is not octal)');
  return text === '' ? 0 : parseInt(text, 8);
}

function parseName(bytes) {
  const name = Buffer.from(bytes.subarray(0, 100)).toString('utf8').replace(/\0.*$/, '');
  const prefix = Buffer.from(bytes.subarray(345, 500)).toString('utf8').replace(/\0.*$/, '');
  return prefix ? `${prefix}/${name}` : name;
}

function parsePaxPath(data) {
  // Minimal pax extended header parse: records look like
  // "<len> path=<name>\n"; only the path record matters here.
  for (const line of Buffer.from(data).toString('utf8').split('\n')) {
    const at = line.indexOf(' ');
    if (at > 0 && line.slice(at + 1).startsWith('path=')) return line.slice(at + 6);
  }
  return null;
}

// Lists the regular files in a .tgz buffer without extracting it.
// Handles ustar prefix joins, GNU longnames ('L'), and pax path records
// ('x'), which npm emits for deep node_modules paths.
export function listTarballFiles(buffer) {
  const raw = gunzipSync(buffer);
  const files = [];
  let offset = 0;
  let longName = null;
  let paxPath = null;
  while (offset + 512 <= raw.length) {
    const header = raw.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const size = parseOctal(header, 124, 136);
    const type = String.fromCharCode(header[156]);
    offset += 512;
    const data = raw.subarray(offset, offset + size);
    if (type === 'L') {
      longName = Buffer.from(data).toString('utf8').replace(/\0.*$/, '');
    } else if (type === 'x') {
      paxPath = parsePaxPath(data);
    } else if (type === '0' || type === '\0') {
      const name = longName ?? paxPath ?? parseName(header);
      longName = null;
      paxPath = null;
      if (name !== '' && !name.endsWith('/')) files.push({ path: stripTarPrefix(name), size });
    } else {
      // Directories, symlinks, pax globals, etc. carry no file bytes.
      if (type !== 'g') {
        longName = null;
        paxPath = null;
      }
    }
    offset += Math.ceil(size / 512) * 512;
  }
  return files;
}

function readTarball(spec) {
  const compressed = statSync(spec).size;
  const files = listTarballFiles(readFileSync(spec));
  return { files, compressed, source: spec };
}

function readPackJson(spec) {
  const parsed = JSON.parse(readFileSync(spec, 'utf8'));
  const entry = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!entry || !Array.isArray(entry.files)) throw new Error(`${spec}: expected npm pack --json output (an array with a files entry)`);
  const files = entry.files.map(file => ({ path: file.path, size: file.size ?? 0 }));
  return {
    files,
    compressed: entry.size ?? null,
    source: entry.filename ? `${spec} (${entry.filename})` : spec,
  };
}

export function loadPack(spec) {
  const loaded = spec.toLowerCase().endsWith('.tgz') || spec.toLowerCase().endsWith('.tar.gz')
    ? readTarball(spec)
    : readPackJson(spec);
  const unpacked = loaded.files.reduce((sum, file) => sum + file.size, 0);
  return { ...loaded, unpacked, count: loaded.files.length };
}

// ---- summary -------------------------------------------------------------

function groupBy(files, keyOf) {
  const groups = new Map();
  for (const file of files) {
    const key = keyOf(file);
    if (!key) continue;
    const group = groups.get(key) ?? { key, bytes: 0, count: 0 };
    group.bytes += file.size;
    group.count++;
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => b.bytes - a.bytes || a.key.localeCompare(b.key));
}

function topLevelKey(path) {
  const at = path.indexOf('/');
  return at < 0 ? '(root)' : path.slice(0, at);
}

function nodeModuleKey(path) {
  if (!path.startsWith('app/node_modules/')) return null;
  const parts = path.split('/');
  if (parts.length < 3) return null;
  const head = parts[2].startsWith('@') ? parts.slice(2, 4).join('/') : parts[2];
  return `app/node_modules/${head}`;
}

function nextBuildKey(path) {
  if (!path.startsWith('app/.next/')) return null;
  const parts = path.split('/');
  return parts.slice(0, Math.min(3, parts.length)).join('/');
}

export function summarize(files, { top = DEFAULT_TOP } = {}) {
  const unpacked = files.reduce((sum, file) => sum + file.size, 0);
  const prebuildFiles = files.filter(file => file.path.startsWith('app/node_modules/better-sqlite3/prebuilds/'));
  return {
    unpacked,
    count: files.length,
    topLevel: groupBy(files, file => topLevelKey(file.path)),
    nodeModules: groupBy(files, file => nodeModuleKey(file.path)).slice(0, top),
    nodeModuleGroups: groupBy(files, file => nodeModuleKey(file.path)).length,
    nextBuild: groupBy(files, file => nextBuildKey(file.path)).slice(0, top),
    nextBuildGroups: groupBy(files, file => nextBuildKey(file.path)).length,
    prebuilds: {
      bytes: prebuildFiles.reduce((sum, file) => sum + file.size, 0),
      count: prebuildFiles.length,
    },
  };
}

// ---- output --------------------------------------------------------------

export function formatBytes(bytes) {
  return `${bytes.toLocaleString('en-US')} B (${(bytes / 1024 / 1024).toFixed(2)} MiB)`;
}

function percent(bytes, total) {
  return total ? `${((bytes / total) * 100).toFixed(1).padStart(5)}%` : '  ---%';
}

function rows(groups, total) {
  const width = Math.max(...groups.map(group => group.key.length), 1);
  return groups.map(group =>
    `  ${formatBytes(group.bytes).padStart(24)}  ${percent(group.bytes, total)}  ${String(group.count).padStart(5)} files  ${group.key.padEnd(width)}`);
}

export function formatHuman(pack, summary, { top = DEFAULT_TOP } = {}) {
  const lines = [
    `pack-report: ${pack.source}`,
    `compressed: ${pack.compressed === null ? 'unknown (dry-run output has no tarball size)' : formatBytes(pack.compressed)}`,
    `unpacked:   ${formatBytes(summary.unpacked)} in ${summary.count.toLocaleString('en-US')} files`,
    '',
    'bytes per top-level directory (share of unpacked):',
    ...rows(summary.topLevel, summary.unpacked),
    '',
    `top ${top} app/node_modules packages (share of unpacked):`,
    ...rows(summary.nodeModules, summary.unpacked),
  ];
  if (summary.nodeModuleGroups > summary.nodeModules.length) {
    lines.push(`  ... and ${summary.nodeModuleGroups - summary.nodeModules.length} smaller packages`);
  }
  lines.push(
    `better-sqlite3 prebuilds: ${formatBytes(summary.prebuilds.bytes)} in ${summary.prebuilds.count} files`,
    '',
    `top ${top} app/.next subtrees (share of unpacked):`,
    ...rows(summary.nextBuild, summary.unpacked),
  );
  if (summary.nextBuildGroups > summary.nextBuild.length) {
    lines.push(`  ... and ${summary.nextBuildGroups - summary.nextBuild.length} smaller subtrees`);
  }
  return `${lines.join('\n')}\n`;
}

export function formatJson(pack, summary) {
  return `${JSON.stringify({
    source: pack.source,
    compressed: pack.compressed,
    unpacked: summary.unpacked,
    count: summary.count,
    topLevel: summary.topLevel,
    nodeModules: summary.nodeModules,
    nodeModuleGroups: summary.nodeModuleGroups,
    nextBuild: summary.nextBuild,
    nextBuildGroups: summary.nextBuildGroups,
    prebuilds: summary.prebuilds,
  }, null, 2)}\n`;
}

function usage() {
  return 'usage: node scripts/pack-report.mjs <tarball.tgz|pack.json> [--top N] [--json]\n';
}

export function parseArgs(argv) {
  const args = { spec: null, top: DEFAULT_TOP, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--top') {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 1) throw new Error('--top needs a positive integer');
      args.top = value;
    } else if (arg === '--json') {
      args.json = true;
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg.startsWith('-')) {
      throw new Error(`unknown flag ${arg}`);
    } else if (args.spec) {
      throw new Error('expected a single tarball-or-json input');
    } else {
      args.spec = arg;
    }
  }
  return args;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help || !args.spec) {
      process.stdout.write(usage());
      process.exit(args.help ? 0 : 1);
    }
    const pack = loadPack(args.spec);
    const summary = summarize(pack.files, { top: args.top });
    process.stdout.write(args.json ? formatJson(pack, summary) : formatHuman(pack, summary, { top: args.top }));
  } catch (error) {
    process.stderr.write(`pack-report: ${error.message}\n`);
    process.exit(1);
  }
}
