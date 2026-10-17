// `botmancers setup --client codex|cursor|claude`: connect an MCP client to
// the local bridge and install the optional botmancers-collaboration skill
// in the place that client loads skills from.
//
// Ownership: Botmancers manages only what it wrote. Each install records
// <home>/config/clients/<client>.json with the package version, the SHA-256
// of every skill file it wrote, and the SHA-256 of the MCP server entry it
// wrote. A re-run replaces a file or entry only when it still has the
// recorded hash (unmodified since Botmancers wrote it) or already has the
// wanted content; anything else is a conflict, and nothing of that client
// is written. Files Botmancers never wrote are not touched. A write that
// fails part way restores everything already written for that client.
//
//   codex   $CODEX_HOME (default ~/.codex): config.toml [mcp_servers.botmancers], skills/
//   cursor  ~/.cursor: mcp.json mcpServers.botmancers, skills/
//   claude  $CLAUDE_CONFIG_DIR (default ~/.claude): skills/; user MCP servers in
//           ~/.claude.json (or $CLAUDE_CONFIG_DIR/.claude.json) mcpServers.botmancers
//
// The skill holds no credentials. The MCP entry carries the bridge's MCP
// token, as a hand-written client configuration would; nothing here prints it.
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENV } from './config.js';
import { PRODUCT_HOST, type HomePaths, ensurePrivateDir, readEnvFile, writePrivateFile } from './home.js';

export const SKILL_NAME = 'botmancers-collaboration';
export const MCP_SERVER_NAME = 'botmancers';
export const CLIENT_IDS = ['codex', 'cursor', 'claude'] as const;
export type ClientId = typeof CLIENT_IDS[number];

export const PACKAGED_SKILL_DIR = fileURLToPath(new URL(`../skills/${SKILL_NAME}`, import.meta.url));

const LABELS: Record<ClientId, string> = { codex: 'Codex', cursor: 'Cursor', claude: 'Claude Code' };

export interface ClientLayout {
  id: ClientId;
  label: string;
  root: string;        // must exist: the client is installed for this user
  config: string;      // its MCP configuration file
  format: 'toml' | 'json';
  skillDir: string;
}

export function isClientId(value: string): value is ClientId {
  return (CLIENT_IDS as readonly string[]).includes(value);
}

export function clientLayout(id: ClientId, env: NodeJS.ProcessEnv): ClientLayout {
  const home = env.HOME?.trim() || homedir();
  const label = LABELS[id];
  if (id === 'codex') {
    const root = env.CODEX_HOME?.trim() || join(home, '.codex');
    return { id, label, root, config: join(root, 'config.toml'), format: 'toml', skillDir: join(root, 'skills', SKILL_NAME) };
  }
  if (id === 'cursor') {
    const root = join(home, '.cursor');
    return { id, label, root, config: join(root, 'mcp.json'), format: 'json', skillDir: join(root, 'skills', SKILL_NAME) };
  }
  const custom = env.CLAUDE_CONFIG_DIR?.trim();
  const root = custom || join(home, '.claude');
  return { id, label, root, config: custom ? join(custom, '.claude.json') : join(home, '.claude.json'), format: 'json', skillDir: join(root, 'skills', SKILL_NAME) };
}

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

// ---------------------------------------------------------------------
// The packaged skill

export interface SkillFile {
  rel: string;   // POSIX path inside the skill directory
  data: Buffer;
  hash: string;
}

export function packagedSkill(dir = PACKAGED_SKILL_DIR): SkillFile[] {
  const files: SkillFile[] = [];
  const walk = (path: string) => {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        const data = readFileSync(full);
        files.push({ rel: relative(dir, full).split(sep).join('/'), data, hash: sha256(data) });
      }
    }
  };
  walk(dir);
  return files;
}

// ---------------------------------------------------------------------
// Ownership manifest

export interface ClientManifest {
  schema: 1;
  client: ClientId;
  version: string;
  installed_at: string;
  skill: { dir: string; files: Record<string, string> };
  mcp: { config: string; name: string; hash: string };
}

export const manifestPath = (paths: HomePaths, id: ClientId) => join(paths.config, 'clients', `${id}.json`);

export function readManifest(paths: HomePaths, id: ClientId): ClientManifest | null {
  try {
    const manifest = JSON.parse(readFileSync(manifestPath(paths, id), 'utf8')) as ClientManifest;
    return manifest && manifest.schema === 1 && manifest.client === id ? manifest : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------
// The MCP server entry

export interface McpTarget {
  url: string;
  token: string;
}

export function mcpTarget(paths: HomePaths, mcpPort: number): McpTarget | null {
  const token = readEnvFile(paths.bridgeEnv)?.[ENV.mcpToken];
  return token ? { url: `http://${PRODUCT_HOST}:${mcpPort}/mcp`, token } : null;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function jsonEntry(id: ClientId, target: McpTarget): Record<string, unknown> {
  const headers = { Authorization: `Bearer ${target.token}` };
  return id === 'claude' ? { type: 'http', url: target.url, headers } : { url: target.url, headers };
}

const tomlString = (value: string) => JSON.stringify(value);

function tomlEntry(target: McpTarget): string {
  return [
    `[mcp_servers.${MCP_SERVER_NAME}]`,
    `url = ${tomlString(target.url)}`,
    `http_headers = { "Authorization" = ${tomlString(`Bearer ${target.token}`)} }`,
  ].join('\n');
}

// What the configuration currently holds under the Botmancers server name.
interface EntryState {
  found: 'absent' | 'present' | 'unmanageable';
  hash: string | null;
  reason?: string;
  // Rewrites the file text with the entry replaced, added (entry), or removed (null).
  rewrite: (entry: string | Record<string, unknown> | null) => string;
}

const TOML_HEADER = /^\s*\[\s*([^\]]*?)\s*\]\s*(?:#.*)?$/;
const tomlKey = (key: string) => key.split('.').map(part => part.trim().replace(/^"(.*)"$/, '$1')).join('.');

function tomlState(text: string): EntryState {
  const lines = text.split('\n');
  let table = '';
  let start = -1;
  let end = lines.length;
  let other: string | null = null;
  lines.forEach((line, index) => {
    const header = TOML_HEADER.exec(line);
    if (header && !line.trim().startsWith('[[')) {
      table = tomlKey(header[1]);
      if (start >= 0 && end === lines.length && index > start) end = index;
      if (table === `mcp_servers.${MCP_SERVER_NAME}`) {
        if (start >= 0) other = 'it defines [mcp_servers.botmancers] twice';
        else start = index;
      } else if (table.startsWith(`mcp_servers.${MCP_SERVER_NAME}.`)) other = `it has a [${header[1].trim()}] table`;
      return;
    }
    if (line.trim().startsWith('[[')) {
      if (start >= 0 && end === lines.length && index > start) end = index;
      table = '';
      return;
    }
    const key = /^\s*([A-Za-z0-9_."-]+?)\s*=/.exec(line);
    if (!key) return;
    const full = tomlKey(table ? `${table}.${key[1]}` : key[1]);
    if (full.startsWith(`mcp_servers.${MCP_SERVER_NAME}`) && !(start >= 0 && table === `mcp_servers.${MCP_SERVER_NAME}`)) {
      other = `it sets mcp_servers.${MCP_SERVER_NAME} outside a [mcp_servers.${MCP_SERVER_NAME}] table`;
    }
  });
  if (start >= 0) while (end > start + 1 && !lines[end - 1].trim()) end -= 1;
  const block = start >= 0 ? lines.slice(start, end).join('\n') : null;
  const rewrite = (entry: string | Record<string, unknown> | null) => {
    const replacement = entry === null ? [] : String(entry).split('\n');
    if (start >= 0) {
      const next = [...lines.slice(0, start), ...replacement, ...lines.slice(end)];
      if (entry === null) {
        // Drop the blank line the block leaves behind.
        while (start < next.length && start > 0 && !next[start].trim() && !next[start - 1].trim()) next.splice(start, 1);
      }
      return next.join('\n');
    }
    if (entry === null) return text;
    const body = text.replace(/\s*$/, '');
    return `${body ? `${body}\n\n` : ''}${replacement.join('\n')}\n`;
  };
  if (other) return { found: 'unmanageable', hash: null, reason: other, rewrite };
  return block === null ? { found: 'absent', hash: null, rewrite } : { found: 'present', hash: sha256(block.trim()), rewrite };
}

function jsonState(text: string): EntryState {
  let doc: Record<string, unknown>;
  try {
    doc = text.trim() ? JSON.parse(text) : {};
  } catch {
    return { found: 'unmanageable', hash: null, reason: 'it is not valid JSON', rewrite: () => text };
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { found: 'unmanageable', hash: null, reason: 'it is not a JSON object', rewrite: () => text };
  const servers = doc.mcpServers;
  if (servers !== undefined && (!servers || typeof servers !== 'object' || Array.isArray(servers))) {
    return { found: 'unmanageable', hash: null, reason: 'its mcpServers is not an object', rewrite: () => text };
  }
  const entry = (servers as Record<string, unknown> | undefined)?.[MCP_SERVER_NAME];
  const rewrite = (next: string | Record<string, unknown> | null) => {
    const copy = { ...doc, mcpServers: { ...((servers as Record<string, unknown>) ?? {}) } } as Record<string, unknown> & { mcpServers: Record<string, unknown> };
    if (next === null) delete copy.mcpServers[MCP_SERVER_NAME];
    else copy.mcpServers[MCP_SERVER_NAME] = next;
    if (next === null && servers === undefined) delete (copy as Record<string, unknown>).mcpServers;
    return `${JSON.stringify(copy, null, 2)}\n`;
  };
  return entry === undefined ? { found: 'absent', hash: null, rewrite } : { found: 'present', hash: sha256(stable(entry)), rewrite };
}

function readConfig(layout: ClientLayout): { text: string; exists: boolean; problem?: string } {
  try {
    const info = lstatSync(layout.config);
    if (!info.isFile()) return { text: '', exists: true, problem: 'it is not a regular file' };
    return { text: readFileSync(layout.config, 'utf8'), exists: true };
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return { text: '', exists: false };
    return { text: '', exists: true, problem: `it cannot be read (${(error as { code?: string }).code ?? 'error'})` };
  }
}

function entryState(layout: ClientLayout, text: string): EntryState {
  return layout.format === 'toml' ? tomlState(text) : jsonState(text);
}

function wantedEntry(layout: ClientLayout, target: McpTarget): { value: string | Record<string, unknown>; hash: string } {
  if (layout.format === 'toml') {
    const value = tomlEntry(target);
    return { value, hash: sha256(value.trim()) };
  }
  const value = jsonEntry(layout.id, target);
  return { value, hash: sha256(stable(value)) };
}

// ---------------------------------------------------------------------
// Inspection: the one view behind setup, removal, and doctor

export type PartState = 'current' | 'stale' | 'missing' | 'conflict' | 'absent';

export interface ClientView {
  layout: ClientLayout;
  installed: boolean;          // the client's own directory exists
  manifest: ClientManifest | null;
  mcp: { state: PartState; reason?: string };
  skill: { state: PartState; conflicts: string[]; changes: number };
}

function fileHash(path: string): string | null | 'not-a-file' {
  try {
    const info = lstatSync(path);
    if (!info.isFile()) return 'not-a-file';
    return sha256(readFileSync(path));
  } catch {
    return null;
  }
}

export function inspectClient(id: ClientId, env: NodeJS.ProcessEnv, paths: HomePaths, target: McpTarget | null, skill = packagedSkill()): ClientView {
  const layout = clientLayout(id, env);
  const manifest = readManifest(paths, id);
  const installed = existsSync(layout.root);

  let mcp: ClientView['mcp'];
  const config = readConfig(layout);
  const state = config.problem ? null : entryState(layout, config.text);
  if (config.problem) mcp = { state: 'conflict', reason: `${layout.config}: ${config.problem}` };
  else if (state!.found === 'unmanageable') mcp = { state: 'conflict', reason: `${layout.config}: ${state!.reason}` };
  else if (state!.found === 'absent') mcp = { state: manifest ? 'missing' : 'absent' };
  else if (target && state!.hash === wantedEntry(layout, target).hash) mcp = { state: 'current' };
  else if (manifest && state!.hash === manifest.mcp.hash) mcp = { state: 'stale', reason: 'its URL or token no longer matches this Botmancers' };
  else mcp = { state: 'conflict', reason: `${layout.config} already has an MCP server named "${MCP_SERVER_NAME}" that Botmancers did not write or that was edited` };

  const conflicts: string[] = [];
  let changes = 0;
  let present = 0;
  let dirProblem: string | null = null;
  try {
    const info = lstatSync(layout.skillDir);
    if (!info.isDirectory()) dirProblem = `${layout.skillDir} is not a directory`;
  } catch { /* absent */ }
  if (dirProblem) conflicts.push(dirProblem);
  else {
    for (const file of skill) {
      const current = fileHash(join(layout.skillDir, file.rel));
      if (current !== null) present += 1;
      if (current === file.hash) continue;
      changes += 1;
      if (current === null) continue;
      if (current !== 'not-a-file' && manifest?.skill.files[file.rel] === current) continue;
      conflicts.push(join(layout.skillDir, file.rel));
    }
    for (const [rel, hash] of Object.entries(manifest?.skill.files ?? {})) {
      if (skill.some(file => file.rel === rel)) continue;
      if (fileHash(join(layout.skillDir, rel)) === hash) changes += 1;  // a managed file this version no longer ships
    }
  }
  let skillState: PartState;
  if (conflicts.length) skillState = 'conflict';
  else if (!changes) skillState = 'current';
  else if (!present) skillState = manifest ? 'missing' : 'absent';
  else skillState = 'stale';
  return { layout, installed, manifest, mcp, skill: { state: skillState, conflicts, changes } };
}

// ---------------------------------------------------------------------
// Install, refresh, and remove

export interface ClientOutcome {
  ok: boolean;
  kind: 'installed' | 'removed' | 'missing-client' | 'conflict';
  lines: string[];
}

const home = (path: string, env: NodeJS.ProcessEnv) => {
  const base = env.HOME?.trim() || homedir();
  return path.startsWith(`${base}${sep}`) ? `~${path.slice(base.length)}` : path;
};

export const repairCommand = (id: ClientId) => `botmancers setup --client ${id}`;

export function mcpOnlyLines(target: { url: string }, paths: HomePaths): string[] {
  return [
    'Any MCP client works without the skill (MCP-only):',
    `  URL     ${target.url}`,
    `  Header  Authorization: Bearer <${ENV.mcpToken} from ${paths.bridgeEnv}>`,
    '  The botmancers_* tool descriptions name every step: capabilities, list Agents and sessions, act, poll.',
  ];
}

function conflictLines(view: ClientView, env: NodeJS.ProcessEnv, removing: boolean): string[] {
  const id = view.layout.id;
  const lines = [`botmancers setup --client ${id}: changed nothing for ${view.layout.label}; these are not Botmancers-managed or were edited since Botmancers wrote them:`];
  if (view.mcp.state === 'conflict') lines.push(`  MCP    ${view.mcp.reason}`);
  for (const path of view.skill.conflicts) lines.push(`  skill  ${home(path, env)}`);
  lines.push(
    'Botmancers never overwrites them. To let it manage them again, keep a copy of anything you want,',
    view.mcp.state === 'conflict'
      ? `remove the "${MCP_SERVER_NAME}" MCP server entry from ${home(view.layout.config, env)} and the files listed above, then re-run: ${repairCommand(id)}${removing ? ' --remove' : ''}`
      : `remove the files listed above, then re-run: ${repairCommand(id)}${removing ? ' --remove' : ''}`,
  );
  return lines;
}

// Writes go through this journal so a failure restores what was there.
class Journal {
  private undo: Array<() => void> = [];

  write(path: string, data: string | Buffer, mode?: number): void {
    const before = existsSync(path) ? { data: readFileSync(path), mode: statSync(path).mode & 0o777 } : null;
    const madeDirs = this.mkdirs(dirname(path));
    const temp = `${path}.botmancers-${process.pid}.tmp`;
    writeFileSync(temp, data, { mode: mode ?? before?.mode ?? 0o644 });
    chmodSync(temp, mode ?? before?.mode ?? 0o644);
    renameSync(temp, path);
    this.undo.push(() => {
      if (before) {
        writeFileSync(path, before.data, { mode: before.mode });
        chmodSync(path, before.mode);
      } else rmSync(path, { force: true });
      for (const dir of madeDirs.reverse()) try { rmdirSync(dir); } catch { /* not empty */ }
    });
  }

  remove(path: string): void {
    const before = readFileSync(path);
    const mode = statSync(path).mode & 0o777;
    rmSync(path);
    this.undo.push(() => writeFileSync(path, before, { mode }));
  }

  private mkdirs(dir: string): string[] {
    const made: string[] = [];
    let at = dir;
    while (!existsSync(at)) {
      made.unshift(at);
      at = dirname(at);
    }
    for (const path of made) mkdirSync(path);
    return made;
  }

  rollback(): void {
    for (const step of this.undo.reverse()) {
      try { step(); } catch { /* best effort */ }
    }
  }
}

function writeManifest(paths: HomePaths, manifest: ClientManifest): void {
  ensurePrivateDir(join(paths.config, 'clients'));
  writePrivateFile(manifestPath(paths, manifest.client), `${JSON.stringify(manifest, null, 2)}\n`);
}

function pruneEmpty(dir: string, stop: string): void {
  let at = dir;
  while (at.startsWith(`${stop}${sep}`)) {
    try { rmdirSync(at); } catch { return; }
    at = dirname(at);
  }
}

export function installClient(id: ClientId, env: NodeJS.ProcessEnv, paths: HomePaths, target: McpTarget, version: string, skill = packagedSkill()): ClientOutcome {
  const view = inspectClient(id, env, paths, target, skill);
  const { layout } = view;
  if (!view.installed) {
    return {
      ok: false,
      kind: 'missing-client',
      lines: [
        `botmancers setup --client ${id}: ${layout.label} is not set up for this user (${home(layout.root, env)} not found); nothing was written.`,
        `Install and open ${layout.label} once, then re-run: ${repairCommand(id)}`,
        ...mcpOnlyLines(target, paths),
      ],
    };
  }
  if (view.mcp.state === 'conflict' || view.skill.state === 'conflict') return { ok: false, kind: 'conflict', lines: conflictLines(view, env, false) };

  const wanted = wantedEntry(layout, target);
  const journal = new Journal();
  const files: Record<string, string> = {};
  try {
    for (const file of skill) {
      const path = join(layout.skillDir, file.rel);
      if (fileHash(path) !== file.hash) journal.write(path, file.data, 0o644);
      files[file.rel] = file.hash;
    }
    for (const [rel, hash] of Object.entries(view.manifest?.skill.files ?? {})) {
      const path = join(layout.skillDir, rel);
      if (!(rel in files) && fileHash(path) === hash) {
        journal.remove(path);
        pruneEmpty(dirname(path), layout.skillDir);
      }
    }
    if (view.mcp.state !== 'current') {
      const config = readConfig(layout);
      // A configuration file this command creates holds the token: owner-only.
      journal.write(layout.config, entryState(layout, config.text).rewrite(wanted.value), config.exists ? undefined : 0o600);
    }
    writeManifest(paths, {
      schema: 1, client: id, version, installed_at: new Date().toISOString(),
      skill: { dir: layout.skillDir, files },
      mcp: { config: layout.config, name: MCP_SERVER_NAME, hash: wanted.hash },
    });
  } catch (error) {
    journal.rollback();
    const code = (error as { code?: string }).code ?? (error as Error).message;
    return {
      ok: false,
      kind: 'conflict',
      lines: [
        `botmancers setup --client ${id}: could not write ${layout.label} files (${code}); restored everything this run had changed.`,
        `Fix the permissions under ${home(layout.root, env)}${layout.config.startsWith(layout.root) ? '' : ` and of ${home(layout.config, env)}`}, then re-run: ${repairCommand(id)}`,
      ],
    };
  }

  const verb = (state: PartState, fresh: string) => (state === 'current' ? 'unchanged' : state === 'absent' ? fresh : 'updated');
  return {
    ok: true,
    kind: 'installed',
    lines: [
      `botmancers setup --client ${id}: ${layout.label} is connected to Botmancers ${version}.`,
      `  MCP    ${home(layout.config, env)} "${MCP_SERVER_NAME}" -> ${target.url} (${verb(view.mcp.state, 'added')})`,
      `  skill  ${home(layout.skillDir, env)} ${SKILL_NAME} ${version} (${verb(view.skill.state, 'installed')})`,
      `  owner  ${manifestPath(paths, id)} records what Botmancers manages; edited files are never overwritten.`,
      `Restart ${layout.label} (or reload its MCP servers) to pick up changes. Remove with: ${repairCommand(id)} --remove`,
    ],
  };
}

export function removeClient(id: ClientId, env: NodeJS.ProcessEnv, paths: HomePaths): ClientOutcome {
  const view = inspectClient(id, env, paths, null);
  const { layout, manifest } = view;
  if (!manifest) {
    return { ok: true, kind: 'removed', lines: [`botmancers setup --client ${id} --remove: Botmancers has not set up ${layout.label}; nothing to remove.`] };
  }
  const kept: string[] = [];
  const journal = new Journal();
  try {
    for (const [rel, hash] of Object.entries(manifest.skill.files)) {
      const path = join(manifest.skill.dir, rel);
      const current = fileHash(path);
      if (current === null) continue;
      if (current === hash) {
        journal.remove(path);
        pruneEmpty(dirname(path), dirname(manifest.skill.dir));
      } else kept.push(path);
    }
    const config = readConfig(layout);
    const state = config.problem ? null : entryState(layout, config.text);
    if (state?.found === 'present' && state.hash === manifest.mcp.hash) journal.write(layout.config, state.rewrite(null));
    else if (state?.found === 'present' || config.problem || state?.found === 'unmanageable') kept.push(`${layout.config} "${MCP_SERVER_NAME}" MCP server entry`);
  } catch (error) {
    journal.rollback();
    return { ok: false, kind: 'conflict', lines: [`botmancers setup --client ${id} --remove: could not change ${layout.label} files (${(error as { code?: string }).code ?? (error as Error).message}); restored them.`] };
  }
  rmSync(manifestPath(paths, id), { force: true });
  const lines = [`botmancers setup --client ${id} --remove: removed the Botmancers MCP connection and the ${SKILL_NAME} skill from ${layout.label}.`];
  if (kept.length) {
    lines.push('Kept, because they were edited after Botmancers wrote them (Botmancers no longer manages them):');
    for (const path of kept) lines.push(`  ${home(path, env)}`);
  }
  return { ok: true, kind: 'removed', lines };
}

// ---------------------------------------------------------------------
// doctor

export type DoctorLine = ['ok' | 'warn' | 'info', string, string];

export function clientDoctorLines(env: NodeJS.ProcessEnv, paths: HomePaths, target: McpTarget | null): DoctorLine[] {
  const out: DoctorLine[] = [];
  const skill = packagedSkill();
  const detected: ClientId[] = [];
  for (const id of CLIENT_IDS) {
    const view = inspectClient(id, env, paths, target, skill);
    const { layout, manifest } = view;
    if (!manifest) {
      if (view.installed) detected.push(id);
      continue;
    }
    const where = home(layout.skillDir, env);
    if (!view.installed) {
      out.push(['warn', id, `${layout.label} was set up by Botmancers ${manifest.version}, but ${home(layout.root, env)} is gone; reinstall ${layout.label}, or forget it: ${repairCommand(id)} --remove`]);
      continue;
    }
    if (view.mcp.state === 'conflict' || view.skill.state === 'conflict') {
      const what = [view.mcp.state === 'conflict' ? 'its "botmancers" MCP entry' : '', view.skill.conflicts.length ? `${view.skill.conflicts.length} skill file${view.skill.conflicts.length > 1 ? 's' : ''} in ${where}` : '']
        .filter(Boolean).join(' and ');
      out.push(['warn', id, `conflicted: ${what} changed since Botmancers wrote them, so setup will not overwrite them; keep a copy of your edits, remove them, then run: ${repairCommand(id)}`]);
      continue;
    }
    const mcp = view.mcp.state === 'current' ? 'MCP connected' : view.mcp.state === 'missing' ? 'MCP entry missing' : `MCP entry stale (${view.mcp.reason})`;
    const skillText = view.skill.state === 'current'
      ? `skill ${SKILL_NAME} ${manifest.version} current (${where})`
      : view.skill.state === 'missing' ? `skill ${SKILL_NAME} missing (${where})`
        : `skill ${SKILL_NAME} ${manifest.version} stale (${view.skill.changes} file${view.skill.changes > 1 ? 's' : ''} differ from this release)`;
    const healthy = view.mcp.state === 'current' && view.skill.state === 'current';
    out.push([healthy ? 'ok' : 'warn', id, `${mcp}; ${skillText}${healthy ? '' : `; repair: ${repairCommand(id)}`}`]);
  }
  if (detected.length) {
    out.push(['info', 'clients', `${detected.map(id => LABELS[id]).join(', ')} found but not connected (optional): ${detected.map(repairCommand).join(' / ')}`]);
  } else if (!out.length) {
    out.push(['info', 'clients', `no MCP client set up by Botmancers (optional): ${repairCommand('codex')}|cursor|claude, or connect any MCP client by hand`]);
  }
  return out;
}

// ---------------------------------------------------------------------
// `botmancers setup [--client codex|cursor|claude ...] [--remove]`

export interface SetupOptions {
  clients: ClientId[];
  remove: boolean;
}

export class ClientUsageError extends Error {}

export function parseSetupArgs(argv: string[]): SetupOptions {
  const clients: ClientId[] = [];
  let remove = false;
  for (let at = 0; at < argv.length; at += 1) {
    const arg = argv[at];
    const inline = arg.startsWith('--client=') ? arg.slice('--client='.length) : null;
    if (arg === '--client' || inline !== null) {
      const value = inline ?? argv[++at];
      if (!value) throw new ClientUsageError('--client needs a value: codex, cursor, or claude.');
      for (const name of value.split(',').map(part => part.trim()).filter(Boolean)) {
        if (!isClientId(name)) {
          throw new ClientUsageError(`unsupported client "${name}"; supported: ${CLIENT_IDS.join(', ')}. Other MCP clients need no setup: point them at the bridge URL with the MCP token header (botmancers setup prints both).`);
        }
        if (!clients.includes(name)) clients.push(name);
      }
    } else if (arg === '--remove') remove = true;
    else throw new ClientUsageError(`unknown argument ${arg}.`);
  }
  if (remove && !clients.length) throw new ClientUsageError('--remove needs --client codex|cursor|claude.');
  return { clients, remove };
}

// Plain `botmancers setup` refreshes the clients Botmancers already set up
// (for example after an upgrade); `--client` installs or refreshes the named ones.
export function setupClients(options: SetupOptions, env: NodeJS.ProcessEnv, paths: HomePaths, target: McpTarget | null, version: string): ClientOutcome[] {
  if (options.remove) return options.clients.map(id => removeClient(id, env, paths));
  const ids = options.clients.length ? options.clients : CLIENT_IDS.filter(id => readManifest(paths, id));
  if (!target) return ids.map(id => ({ ok: false, kind: 'conflict' as const, lines: [`botmancers setup --client ${id}: the bridge credentials are missing; run botmancers setup first.`] }));
  const skill = packagedSkill();
  return ids.map(id => installClient(id, env, paths, target, version, skill));
}
