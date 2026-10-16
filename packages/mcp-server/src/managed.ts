// The managed install: the Agent Deck / Agent Dealer contract with Botmancers
// names. Release trees live beside the product home's data, never inside it:
//
//   <home>/versions/<semver>/       `npm install --prefix` of botmancers@<semver>
//   <home>/versions/.partial-<v>    a download in progress (never made current)
//   <home>/current -> versions/<v>  the active release, replaced atomically
//   <home>/update-state.json        updater metadata (last check, pending release)
//   <home>/update.lock              held while a check, download, install, or upgrade runs
//   <home>/run/start.lock           held from a start's stopped proof until its
//                                   supervisor claims the home (and by an
//                                   explicit activation), so `current` never
//                                   moves beneath a starting product
//   ~/.local/bin/botmancers         stable launcher: exec node <home>/current/...
//
// Everything else under <home> (config, data, files, skills, logs, run, bot
// workdirs) is user state: nothing in this module reads, writes, or removes it.
//
// The auto-updater (on by default, off with BOTMANCERS_DISABLE_AUTOUPDATER=1)
// checks npm `latest` at most once per 24 hours in a detached worker, so no
// command waits on the network. It stages a newer release beside the running
// one and records it as pending. Only `botmancers start`, after proving no
// Botmancers-owned process is live, makes a pending release current (NOT-279):
// status, open, doctor, the bridge, and a running daemon never flip it.
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  accessSync, constants as fsConstants, existsSync, linkSync, lstatSync, mkdirSync, readFileSync,
  readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, sep } from 'node:path';
import { CLI_PATH, REQUIRED_APP_FILES, resolveHome } from './home.js';

export const PACKAGE_NAME = 'botmancers';
export const DISABLE_AUTOUPDATER_ENV = 'BOTMANCERS_DISABLE_AUTOUPDATER';
export const LOCAL_BIN_ENV = 'BOTMANCERS_LOCAL_BIN';
export const DEFAULT_REGISTRY = 'https://registry.npmjs.org';
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const KEEP_PREVIOUS_RELEASES = 2;
export const RESTART_ACTION = 'botmancers stop && botmancers start --daemon';
export const MANAGED_INSTALL_COMMAND = 'curl -fsSL https://raw.githubusercontent.com/not-so-fat/botmancers/main/scripts/install.sh | bash';
const REGISTRY_TIMEOUT_MS = 2500;
// Only for a lock record without its holder's start time (written by an older
// release); a recorded holder that is still the same process is never stale.
const LEGACY_LOCK_STALE_MS = 60 * 60 * 1000;
// A hung npm download is killed (and its partial tree removed) after this.
export const NPM_TIMEOUT_MS = 20 * 60 * 1000;
// Set by a start that activated a release for the new release's `start`, which
// inherits the start lock instead of waiting on its own parent.
export const START_LOCK_ENV = 'BOTMANCERS_START_LOCK_TOKEN';
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

// ---------------------------------------------------------------------
// Paths.

export interface ManagedPaths {
  home: string;
  versions: string;
  current: string;
  state: string;
  lock: string;
  startLock: string;
  localBin: string;
  launcher: string;
}

export function managedPaths(env: NodeJS.ProcessEnv): ManagedPaths {
  const home = resolveHome(env);
  const localBin = (env[LOCAL_BIN_ENV] ?? '').trim() || join(env.HOME?.trim() || homedir(), '.local', 'bin');
  return {
    home,
    versions: join(home, 'versions'),
    current: join(home, 'current'),
    state: join(home, 'update-state.json'),
    lock: join(home, 'update.lock'),
    startLock: join(home, 'run', 'start.lock'),
    localBin,
    launcher: join(localBin, 'botmancers'),
  };
}

export const versionDir = (paths: ManagedPaths, version: string) => join(paths.versions, version);
export const partialDir = (paths: ManagedPaths, version: string) => join(paths.versions, `.partial-${version}`);
export const packageDirIn = (dir: string) => join(dir, 'node_modules', PACKAGE_NAME);
export const cliEntryIn = (dir: string) => join(packageDirIn(dir), 'dist', 'cli.js');

function realOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

export function currentVersionDir(paths: ManagedPaths): string | null {
  return realOrNull(paths.current);
}

export function currentManagedVersion(paths: ManagedPaths): string | null {
  const real = currentVersionDir(paths);
  return real ? real.split(sep).pop() ?? null : null;
}

// ---------------------------------------------------------------------
// Semver.

/** Positive when a > b. A prerelease sorts before its release. */
export function compareSemver(a: string, b: string): number {
  const parse = (value: string) => {
    const [core, pre] = value.replace(/^v/, '').split('-', 2);
    return { parts: core.split('.').map(part => Number.parseInt(part, 10) || 0), pre: pre ?? null };
  };
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < 3; i += 1) {
    const diff = (left.parts[i] ?? 0) - (right.parts[i] ?? 0);
    if (diff) return diff > 0 ? 1 : -1;
  }
  if (left.pre === right.pre) return 0;
  if (left.pre === null) return 1;
  if (right.pre === null) return -1;
  return left.pre > right.pre ? 1 : -1;
}

export const isSemver = (value: string | null | undefined): value is string => !!value && SEMVER.test(value);

// ---------------------------------------------------------------------
// Install kind.

export type InstallKind = 'managed' | 'npm-global' | 'npx' | 'project-local' | 'dev-checkout' | 'unknown';

export interface InstallInfo {
  kind: InstallKind;
  cliPath: string;
  versionDir: string | null;  // managed: the release tree this CLI runs from
}

function within(path: string, dir: string | null): boolean {
  return !!dir && (path === dir || path.startsWith(`${dir}${sep}`));
}

function globalPrefixes(env: NodeJS.ProcessEnv, spawnNpm: boolean): string[] {
  const prefixes = [env.npm_config_prefix, env.NPM_CONFIG_PREFIX, dirname(dirname(process.execPath))].filter((value): value is string => !!value?.trim());
  if (spawnNpm) {
    try {
      prefixes.push(execFileSync('npm', ['prefix', '-g'], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }).trim());
    } catch { /* npm unavailable */ }
  }
  return prefixes.map(prefix => realOrNull(prefix.trim())).filter((value): value is string => !!value);
}

// How the running CLI was installed, from where its own file lives. Cheap
// (no child process) unless `spawnNpm` asks npm for its global prefix.
export function detectInstallKind(env: NodeJS.ProcessEnv, options: { cliPath?: string; spawnNpm?: boolean } = {}): InstallInfo {
  const cliPath = realOrNull(options.cliPath ?? CLI_PATH) ?? options.cliPath ?? CLI_PATH;
  const versions = realOrNull(managedPaths(env).versions);
  if (versions && within(cliPath, versions)) {
    const rest = cliPath.slice(versions.length + 1).split(sep);
    if (!rest[0].startsWith('.') && cliPath === join(versions, rest[0], 'node_modules', PACKAGE_NAME, 'dist', 'cli.js')) {
      return { kind: 'managed', cliPath, versionDir: join(versions, rest[0]) };
    }
  }
  const packageDir = dirname(dirname(cliPath));
  if (existsSync(join(packageDir, 'src', 'cli.ts'))) return { kind: 'dev-checkout', cliPath, versionDir: null };
  const segment = `${sep}node_modules${sep}${PACKAGE_NAME}${sep}dist${sep}cli.js`;
  if (!cliPath.endsWith(segment)) return { kind: 'unknown', cliPath, versionDir: null };
  if (cliPath.includes(`${sep}_npx${sep}`)) return { kind: 'npx', cliPath, versionDir: null };
  const installRoot = cliPath.slice(0, cliPath.length - segment.length);
  for (const prefix of globalPrefixes(env, !!options.spawnNpm)) {
    if (installRoot === join(prefix, 'lib') || installRoot === prefix) return { kind: 'npm-global', cliPath, versionDir: null };
  }
  return { kind: 'project-local', cliPath, versionDir: null };
}

// ---------------------------------------------------------------------
// Update state.

export interface UpdateState {
  checkedAt: string | null;
  latest: string | null;
  pendingVersion: string | null;
  pendingIntegrity: string | null;
  stagedAt: string | null;
  // Set by an explicit rollback: the auto-updater stages nothing at or below
  // it, so the next restart does not undo the rollback. `upgrade` clears it.
  declinedVersion: string | null;
  lastError: string | null;
}

const EMPTY_STATE: UpdateState = { checkedAt: null, latest: null, pendingVersion: null, pendingIntegrity: null, stagedAt: null, declinedVersion: null, lastError: null };

export function readUpdateState(paths: ManagedPaths): UpdateState {
  try {
    const parsed = JSON.parse(readFileSync(paths.state, 'utf8')) as Partial<UpdateState>;
    const pick = (key: keyof UpdateState) => (typeof parsed[key] === 'string' ? parsed[key] as string : null);
    return {
      checkedAt: pick('checkedAt'),
      latest: pick('latest'),
      pendingVersion: pick('pendingVersion'),
      pendingIntegrity: pick('pendingIntegrity'),
      stagedAt: pick('stagedAt'),
      declinedVersion: pick('declinedVersion'),
      lastError: pick('lastError'),
    };
  } catch {
    return { ...EMPTY_STATE };
  }
}

export function writeUpdateState(paths: ManagedPaths, patch: Partial<UpdateState>): UpdateState {
  const next = { ...readUpdateState(paths), ...patch };
  mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  const temp = `${paths.state}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, paths.state);
  return next;
}

export function isAutoupdaterDisabled(env: NodeJS.ProcessEnv): boolean {
  const value = (env[DISABLE_AUTOUPDATER_ENV] ?? '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

// ---------------------------------------------------------------------
// Release trees.

// Startup-critical package files. Every dist module cli.js reaches through
// relative imports is checked too, so a release missing any of them (the
// updater included) can never become current and break the launcher.
const REQUIRED_RELEASE_FILES = [
  'package.json', 'dist/cli.js', 'dist/managed.js', 'dist/upgrade.js', 'dist/product.js', 'dist/server.js', 'dist/setup.js', 'dist/home.js',
  'schemas/botmancers.mcp.v1.tools.json',
];
const RELATIVE_IMPORT = /\bfrom\s*['"]\.\/([\w.-]+\.js)['"]|\bimport\s*\(\s*['"]\.\/([\w.-]+\.js)['"]\s*\)/g;

function missingDistModule(dist: string): string | null {
  const seen = new Set<string>();
  const queue = ['cli.js'];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    let text: string;
    try {
      text = readFileSync(join(dist, file), 'utf8');
    } catch {
      return `missing dist/${file}`;
    }
    for (const match of text.matchAll(RELATIVE_IMPORT)) queue.push(match[1] ?? match[2]);
  }
  return null;
}

// The better-sqlite3 binary this platform loads (the prebuild its
// lib/binding.js selects, or a node-gyp build), or why there is none.
export function nativeBindingProblem(appDir: string): string | null {
  const sqlite = join(appDir, 'node_modules', 'better-sqlite3');
  if (!existsSync(join(sqlite, 'lib', 'index.js'))) return 'packaged app is missing node_modules/better-sqlite3/lib/index.js';
  const musl = process.platform === 'linux' && !(process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined)?.header?.glibcVersionRuntime;
  const target = `${musl ? 'linuxmusl' : process.platform}-${process.arch}`;
  for (const candidate of [join('prebuilds', `${target}.node`), join('build', 'Release', 'better_sqlite3.node')]) {
    try {
      if (statSync(join(sqlite, candidate)).size > 0) return null;
    } catch { /* try the next */ }
  }
  return `packaged app has no better-sqlite3 native binary for ${target} (node_modules/better-sqlite3/prebuilds/${target}.node)`;
}

// Loads the app's bundled better-sqlite3 with this Node and runs an in-memory
// query (the doctor's native check), or says why it cannot: a present but
// corrupt or incompatible binary fails here.
export function nativeLoadProblem(appDir: string): string | null {
  const sqlite = join(appDir, 'node_modules', 'better-sqlite3');
  try {
    execFileSync(process.execPath, ['-e', `const D=require(${JSON.stringify(sqlite)});const db=new D(':memory:');if(db.prepare('select 1 as one').get().one!==1)throw new Error('bad result');db.close()`], {
      cwd: appDir, stdio: ['ignore', 'ignore', 'pipe'], timeout: 15_000, encoding: 'utf8',
    });
    return null;
  } catch (error) {
    const stderr = String((error as { stderr?: string }).stderr ?? '');
    const reason = stderr.split('\n').find(line => /Error/.test(line)) ?? (error as Error).message;
    return `packaged app's better-sqlite3 does not load on ${process.platform}-${process.arch}: ${reason.trim().slice(0, 200)}`;
  }
}

// releaseProblem plus actually loading the native driver. Used before a tree
// is renamed into versions/ and before it is made current; the cheap
// releaseProblem serves listing and reporting.
export function verifiedReleaseProblem(dir: string, version: string): string | null {
  return releaseProblem(dir, version) ?? nativeLoadProblem(join(packageDirIn(dir), 'app'));
}

// Why a release tree cannot run, or null when it is complete: the CLI and
// every module it loads (update support included), the bridge schema, and the
// packaged UI/core runtime with this platform's native driver, all at the
// directory's version.
export function releaseProblem(dir: string, version: string): string | null {
  const pkg = packageDirIn(dir);
  for (const file of REQUIRED_RELEASE_FILES) {
    if (!existsSync(join(pkg, file))) return `missing ${file}`;
  }
  const module = missingDistModule(join(pkg, 'dist'));
  if (module) return module;
  try {
    const manifest = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')) as { name?: string; version?: string };
    if (manifest.name !== PACKAGE_NAME || manifest.version !== version) return `package.json is ${manifest.name}@${manifest.version}, expected ${PACKAGE_NAME}@${version}`;
  } catch {
    return 'unreadable package.json';
  }
  const app = join(pkg, 'app');
  const missing = REQUIRED_APP_FILES.filter(entry => !existsSync(join(app, entry)));
  if (missing.length) return `packaged app is missing ${missing.join(', ')}`;
  const native = nativeBindingProblem(app);
  if (native) return native;
  try {
    const info = JSON.parse(readFileSync(join(app, 'BUILD_INFO.json'), 'utf8')) as { version?: string };
    if (info.version !== version) return `packaged app is version ${info.version}, expected ${version}`;
  } catch {
    return 'unreadable app/BUILD_INFO.json';
  }
  return null;
}

export interface Release {
  version: string;
  dir: string;
  complete: boolean;
  problem: string | null;
}

export function listReleases(paths: ManagedPaths): Release[] {
  let names: string[];
  try {
    names = readdirSync(paths.versions, { withFileTypes: true }).filter(entry => entry.isDirectory() && !entry.name.startsWith('.')).map(entry => entry.name);
  } catch {
    return [];
  }
  return names.filter(isSemver).sort((a, b) => compareSemver(b, a)).map(version => {
    const dir = versionDir(paths, version);
    const problem = releaseProblem(dir, version);
    return { version, dir, complete: !problem, problem };
  });
}

const LAUNCHER = `#!/usr/bin/env bash
# botmancers managed launcher: runs the release <home>/current points at.
# Written by \`botmancers install\`; safe to re-create with it.
set -euo pipefail
HOME_DIR="\${BOTMANCERS_HOME:-$HOME/.botmancers}"
BIN="$HOME_DIR/current/node_modules/botmancers/dist/cli.js"
if [ ! -f "$BIN" ]; then
  echo "botmancers: managed install broken (missing $BIN). Re-run: ${MANAGED_INSTALL_COMMAND}" >&2
  exit 1
fi
exec node "$BIN" "$@"
`;

export function writeLauncher(paths: ManagedPaths): void {
  mkdirSync(paths.localBin, { recursive: true });
  const temp = `${paths.launcher}.${process.pid}.tmp`;
  writeFileSync(temp, LAUNCHER, { mode: 0o755 });
  renameSync(temp, paths.launcher);
}

export function launcherInstalled(paths: ManagedPaths): boolean {
  try {
    return readFileSync(paths.launcher, 'utf8') === LAUNCHER;
  } catch {
    return false;
  }
}

// Points `current` at a complete release: a new symlink renamed over the old
// one, so every reader sees either the old or the new target. Never call it
// while a Botmancers process from this home may be live (see product.start).
export function activateRelease(paths: ManagedPaths, version: string): void {
  const target = versionDir(paths, version);
  const problem = verifiedReleaseProblem(target, version);
  if (problem) throw new Error(`cannot activate ${version}: ${problem}`);
  try {
    if (!lstatSync(paths.current).isSymbolicLink()) throw new Error(`${paths.current} is not a symlink; remove it and re-run botmancers install`);
  } catch (error) {
    if ((error as { code?: string }).code !== 'ENOENT') throw error;
  }
  const temp = `${paths.current}.${process.pid}.tmp`;
  rmSync(temp, { force: true });
  symlinkSync(join('versions', version), temp, 'dir');
  renameSync(temp, paths.current);
  writeLauncher(paths);
  const state = readUpdateState(paths);
  if (state.pendingVersion && compareSemver(state.pendingVersion, version) <= 0) {
    writeUpdateState(paths, { pendingVersion: null, pendingIntegrity: null, stagedAt: null });
  }
  pruneReleases(paths);
}

// Keeps the active release, the pending one, and the newest KEEP_PREVIOUS_RELEASES
// other complete releases. Removes older releases, incomplete trees, and
// partial downloads that no running updater holds.
export function pruneReleases(paths: ManagedPaths): string[] {
  const current = currentManagedVersion(paths);
  const pending = readUpdateState(paths).pendingVersion;
  const releases = listReleases(paths);
  const keep = new Set([current, pending].filter(Boolean) as string[]);
  for (const release of releases.filter(r => r.complete && !keep.has(r.version)).slice(0, KEEP_PREVIOUS_RELEASES)) keep.add(release.version);
  const removed: string[] = [];
  for (const release of releases) {
    if (keep.has(release.version)) continue;
    rmSync(release.dir, { recursive: true, force: true });
    removed.push(release.version);
  }
  if (!lockHeld(paths)) {
    try {
      for (const name of readdirSync(paths.versions)) {
        if (name.startsWith('.partial-')) {
          rmSync(join(paths.versions, name), { recursive: true, force: true });
          removed.push(name);
        }
      }
    } catch { /* no versions dir */ }
  }
  return removed;
}

// ---------------------------------------------------------------------
// Registry and staging.

export function registryUrl(env: NodeJS.ProcessEnv): string {
  return ((env.npm_config_registry ?? env.NPM_CONFIG_REGISTRY ?? '').trim() || DEFAULT_REGISTRY).replace(/\/+$/, '');
}

async function registryJson(env: NodeJS.ProcessEnv, path: string, timeoutMs = REGISTRY_TIMEOUT_MS): Promise<Record<string, unknown>> {
  const response = await fetch(`${registryUrl(env)}/${path}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`registry ${path}: HTTP ${response.status}`);
  return await response.json() as Record<string, unknown>;
}

export async function fetchLatestVersion(env: NodeJS.ProcessEnv, timeoutMs = REGISTRY_TIMEOUT_MS): Promise<string> {
  const body = await registryJson(env, `${PACKAGE_NAME}/latest`, timeoutMs);
  if (!isSemver(body.version as string)) throw new Error('registry returned no valid latest version');
  return body.version as string;
}

export async function fetchIntegrity(env: NodeJS.ProcessEnv, version: string): Promise<string> {
  const body = await registryJson(env, `${PACKAGE_NAME}/${version}`, 15_000);
  const integrity = (body.dist as { integrity?: string } | undefined)?.integrity;
  if (body.version !== version || !integrity?.startsWith('sha512-')) throw new Error(`registry has no sha512 integrity for ${PACKAGE_NAME}@${version}`);
  return integrity;
}

export type NpmRunner = (args: string[], env: NodeJS.ProcessEnv) => Promise<{ code: number; stderr: string }>;

export const runNpm: NpmRunner = (args, env) => new Promise(resolve => {
  const child = spawn('npm', args, { env, stdio: ['ignore', 'ignore', 'pipe'], shell: process.platform === 'win32' });
  let stderr = '';
  const timer = setTimeout(() => {
    stderr += `\nnpm did not finish in ${NPM_TIMEOUT_MS / 60_000} minutes`;
    child.kill('SIGKILL');
  }, NPM_TIMEOUT_MS);
  timer.unref();
  child.stderr?.on('data', chunk => { stderr += chunk; });
  child.once('error', error => { clearTimeout(timer); resolve({ code: 1, stderr: error.message }); });
  child.once('close', code => { clearTimeout(timer); resolve({ code: code ?? 1, stderr }); });
});

export interface StageDeps {
  npm?: NpmRunner;
  integrity?: (version: string) => Promise<string>;
}

export interface Staged {
  version: string;
  dir: string;
  integrity: string | null;
  reused: boolean;
}

// Installs botmancers@version into versions/.partial-<v>, checks that npm's
// lockfile records the registry's sha512 integrity and that the tree is a
// complete release, then renames it to versions/<v>. A failed or interrupted
// download leaves no versions/<v>; the partial tree is removed on failure and
// by the next prune otherwise.
export async function stageRelease(paths: ManagedPaths, env: NodeJS.ProcessEnv, version: string, deps: StageDeps = {}): Promise<Staged> {
  if (!isSemver(version)) throw new Error(`not a release version: ${JSON.stringify(version)}`);
  const finalDir = versionDir(paths, version);
  if (!verifiedReleaseProblem(finalDir, version)) return { version, dir: finalDir, integrity: lockedIntegrity(finalDir), reused: true };
  const expected = await (deps.integrity ?? (v => fetchIntegrity(env, v)))(version);
  const partial = partialDir(paths, version);
  mkdirSync(paths.versions, { recursive: true, mode: 0o700 });
  rmSync(partial, { recursive: true, force: true });
  mkdirSync(partial, { recursive: true });
  writeFileSync(join(partial, 'package.json'), `${JSON.stringify({ name: 'botmancers-managed-release', private: true }, null, 2)}\n`);
  try {
    const npmEnv = { ...env, npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false' };
    const result = await (deps.npm ?? runNpm)(['install', '--prefix', partial, '--ignore-scripts', '--registry', registryUrl(env), `${PACKAGE_NAME}@${version}`], npmEnv);
    if (result.code !== 0) throw new Error(`npm install ${PACKAGE_NAME}@${version} failed (exit ${result.code}): ${result.stderr.trim().split('\n').slice(-3).join(' ').slice(0, 400)}`);
    const actual = lockedIntegrity(partial);
    if (actual !== expected) throw new Error(`integrity mismatch for ${PACKAGE_NAME}@${version}: registry ${expected}, installed ${actual ?? 'none'}`);
    const problem = verifiedReleaseProblem(partial, version);
    if (problem) throw new Error(`downloaded ${PACKAGE_NAME}@${version} is incomplete: ${problem}`);
    rmSync(finalDir, { recursive: true, force: true });
    renameSync(partial, finalDir);
    return { version, dir: finalDir, integrity: actual, reused: false };
  } catch (error) {
    rmSync(partial, { recursive: true, force: true });
    throw error;
  }
}

// The sha512 npm recorded for the installed botmancers tarball.
export function lockedIntegrity(dir: string): string | null {
  for (const file of ['package-lock.json', join('node_modules', '.package-lock.json')]) {
    try {
      const lock = JSON.parse(readFileSync(join(dir, file), 'utf8')) as { packages?: Record<string, { integrity?: string }> };
      const integrity = lock.packages?.[`node_modules/${PACKAGE_NAME}`]?.integrity;
      if (integrity) return integrity;
    } catch { /* try the next */ }
  }
  return null;
}

// ---------------------------------------------------------------------
// Locks. update.lock: one check, download, install, or upgrade per home at a
// time (they share versions/.partial-<v> and update-state.json). start.lock:
// a start's stopped proof, any `current` switch, and the supervisor's claim
// on the home happen inside it. A lock is held for as long as its recorded
// holder (pid plus start time, so a recycled pid does not count) is alive,
// however long that takes; a lock whose holder is gone is stale.

interface LockInfo {
  pid?: number;
  started?: string;
  at?: number;
  token?: string;
  // A lock about to be handed to a successor stays live until this time even
  // if its owner dies first (see beginHandOff).
  handoffUntil?: number;
}

function readLock(path: string): LockInfo | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as LockInfo;
  } catch {
    return null;
  }
}

// The start time ps reports for pid, or null when ps cannot tell.
function startedAt(pid: number): string | null {
  try {
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, LC_ALL: 'C' } });
    return out.trim().replace(/ +/g, ' ') || null;
  } catch {
    return null;
  }
}

function pidLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === 'EPERM';
  }
}

function lockLive(path: string): LockInfo | null {
  const info = readLock(path);
  // An announced hand-off keeps the lock live for its lease even when the
  // owner dies before the successor adopts it; the lease bounds how long a
  // crash can block other starts.
  if (info?.handoffUntil && info.handoffUntil > Date.now()) return info;
  if (!info?.pid || !pidLive(info.pid)) return null;
  if (!info.started) return Date.now() - (info.at ?? 0) > LEGACY_LOCK_STALE_MS ? null : info;
  const started = startedAt(info.pid);
  // A live pid whose start time differs is a recycled pid; when ps cannot
  // tell, the live holder stays authoritative.
  return started && started !== info.started ? null : info;
}

function lockHeld(paths: ManagedPaths): boolean {
  return !!lockLive(paths.lock);
}

const lockRecord = (pid: number, token: string, handoffUntil?: number) => JSON.stringify({ pid, started: startedAt(pid) ?? undefined, at: Date.now(), token, handoffUntil });

// Rewrites the lock at `path` (still holding `token`) as owned by `pid`, in
// one rename, so ownership never lapses between the two processes.
function recordOwner(path: string, token: string, pid: number, handoffUntil?: number): boolean {
  if (readLock(path)?.token !== token) return false;
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, lockRecord(pid, token, handoffUntil), { mode: 0o600 });
  try {
    renameSync(temp, path);
    return true;
  } catch {
    rmSync(temp, { force: true });
    return false;
  }
}

export const HANDOFF_LEASE_MS = 30_000;

// Announces, BEFORE the successor is spawned, that this held lock is about to
// be handed to it by token. From now on the lock stays live for the lease
// even if this process dies at any point (before or after the spawn); the
// successor adopts it with acquireFileLock(path, { inherit: token }).
export function beginHandOff(path: string, token: string, leaseMs = HANDOFF_LEASE_MS): boolean {
  return recordOwner(path, token, process.pid, Date.now() + leaseMs);
}

// Hands a held lock to another live process (the CLI an activating start
// execs into): from now on the lock lives exactly as long as that process,
// whether or not this one exits first. The new holder adopts it with
// acquireFileLock(path, { inherit: token }).
export function handOffFileLock(path: string, token: string, pid: number): boolean {
  return recordOwner(path, token, pid);
}

export type Unlock = () => void;

function releaser(path: string, token: string): Unlock {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (readLock(path)?.token === token) rmSync(path, { force: true });
  };
}

// Takes the lock at `path`, or null when a live holder has it. `inherit`
// adopts a lock handed to this process by token (by handOffFileLock, or from
// a live parent that did not hand it off): the record is rewritten with this
// process as its owner, and this process releases it.
export function acquireFileLock(path: string, options: { inherit?: string } = {}): { release: Unlock; token: string } | null {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (options.inherit) {
    const held = readLock(path);
    const ours = held?.token === options.inherit && (held.pid === process.pid || lockLive(path));
    if (ours && recordOwner(path, options.inherit, process.pid)) return { release: releaser(path, options.inherit), token: options.inherit };
  }
  const token = randomUUID();
  // Published complete with link(), so a waiter never reads a half-written
  // lock and mistakes it for stale.
  const temp = `${path}.${process.pid}.${token}.tmp`;
  writeFileSync(temp, lockRecord(process.pid, token), { mode: 0o600 });
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        linkSync(temp, path);
        return { token, release: releaser(path, token) };
      } catch (error) {
        if ((error as { code?: string }).code !== 'EEXIST' || lockLive(path) || !removeStaleLock(path)) return null;
      }
    }
    return null;
  } finally {
    rmSync(temp, { force: true });
  }
}

// Moves a stale lock aside, and puts it back if another process replaced it
// with a live one in between. True when the path is free to take.
function removeStaleLock(path: string): boolean {
  const stale = readLock(path);
  const aside = `${path}.${process.pid}.${randomUUID()}.stale`;
  try {
    renameSync(path, aside);
  } catch {
    return true;
  }
  const moved = readLock(aside);
  if (moved?.token !== stale?.token || lockLive(aside)) {
    try { linkSync(aside, path); } catch { /* someone else holds it now */ }
    rmSync(aside, { force: true });
    return false;
  }
  rmSync(aside, { force: true });
  return true;
}

// Polls for the lock until `timeoutMs`; calls onWait once if it has to wait.
export async function waitForFileLock(path: string, options: { timeoutMs: number; inherit?: string; onWait?: () => void }): Promise<{ release: Unlock; token: string } | null> {
  const deadline = Date.now() + options.timeoutMs;
  let waited = false;
  for (;;) {
    const lock = acquireFileLock(path, options);
    if (lock || Date.now() >= deadline) return lock;
    if (!waited) options.onWait?.();
    waited = true;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

export function acquireLock(paths: ManagedPaths): Unlock | null {
  return acquireFileLock(paths.lock)?.release ?? null;
}

// ---------------------------------------------------------------------
// The auto-updater.

export interface Clock {
  now: () => number;
}

const systemClock: Clock = { now: () => Date.now() };

export function checkDue(paths: ManagedPaths, clock: Clock = systemClock): boolean {
  const checkedAt = Date.parse(readUpdateState(paths).checkedAt ?? '');
  if (!Number.isFinite(checkedAt)) return true;
  const age = clock.now() - checkedAt;
  return age < 0 || age >= CHECK_INTERVAL_MS;
}

export type AutoUpdateSkip = 'disabled' | 'not-managed' | 'not-due';

// Called on product command entry and by the running supervisor. Returns at
// once: when a check is due it starts the detached `__update-check` worker
// and never waits for it.
export function scheduleAutoUpdate(env: NodeJS.ProcessEnv, options: { clock?: Clock; cliPath?: string; spawnWorker?: (cliPath: string, env: NodeJS.ProcessEnv) => void } = {}): AutoUpdateSkip | 'scheduled' {
  if (isAutoupdaterDisabled(env)) return 'disabled';
  const install = detectInstallKind(env, { cliPath: options.cliPath });
  if (install.kind !== 'managed') return 'not-managed';
  const paths = managedPaths(env);
  if (!checkDue(paths, options.clock) || lockHeld(paths)) return 'not-due';
  (options.spawnWorker ?? spawnWorker)(install.cliPath, env);
  return 'scheduled';
}

function spawnWorker(cliPath: string, env: NodeJS.ProcessEnv): void {
  try {
    const child = spawn(process.execPath, [cliPath, '__update-check'], { env, detached: true, stdio: 'ignore', cwd: managedPaths(env).home });
    child.once('error', () => {});
    child.unref();
  } catch { /* never let the updater break a command */ }
}

export interface CheckDeps extends StageDeps {
  clock?: Clock;
  latest?: () => Promise<string>;
}

export type CheckOutcome =
  | { result: 'disabled' | 'not-managed' | 'not-due' | 'busy' | 'up-to-date' | 'declined' }
  | { result: 'staged'; version: string; reused: boolean }
  | { result: 'error'; error: string };

// The worker body: one throttled check, and a download when npm `latest` is
// newer than both the active release and any rolled-back-from version.
// Writes only update-state.json, update.lock, and versions/.
export async function runUpdateCheck(env: NodeJS.ProcessEnv, deps: CheckDeps = {}, cliPath?: string): Promise<CheckOutcome> {
  if (isAutoupdaterDisabled(env)) return { result: 'disabled' };
  if (detectInstallKind(env, { cliPath }).kind !== 'managed') return { result: 'not-managed' };
  const paths = managedPaths(env);
  const clock = deps.clock ?? systemClock;
  if (!checkDue(paths, clock)) return { result: 'not-due' };
  const release = acquireLock(paths);
  if (!release) return { result: 'busy' };
  try {
    if (!checkDue(paths, clock)) return { result: 'not-due' };
    const checkedAt = new Date(clock.now()).toISOString();
    writeUpdateState(paths, { checkedAt });
    let latest: string;
    try {
      latest = await (deps.latest ?? (() => fetchLatestVersion(env)))();
    } catch (error) {
      writeUpdateState(paths, { lastError: `update check failed: ${(error as Error).message}` });
      return { result: 'error', error: (error as Error).message };
    }
    const state = writeUpdateState(paths, { latest, lastError: null });
    const current = currentManagedVersion(paths);
    if (current && compareSemver(latest, current) <= 0) return { result: 'up-to-date' };
    if (state.declinedVersion && compareSemver(latest, state.declinedVersion) <= 0) return { result: 'declined' };
    try {
      const staged = await stageRelease(paths, env, latest, deps);
      writeUpdateState(paths, { pendingVersion: latest, pendingIntegrity: staged.integrity, stagedAt: new Date(clock.now()).toISOString(), lastError: null });
      return { result: 'staged', version: latest, reused: staged.reused };
    } catch (error) {
      writeUpdateState(paths, { lastError: `staging ${latest} failed: ${(error as Error).message}` });
      return { result: 'error', error: (error as Error).message };
    }
  } finally {
    release();
  }
}

// A staged release that `start` may activate: the updater is enabled, this
// CLI is the managed one, and the release tree is complete.
export function activatablePending(env: NodeJS.ProcessEnv, cliPath?: string): string | null {
  if (isAutoupdaterDisabled(env)) return null;
  if (detectInstallKind(env, { cliPath }).kind !== 'managed') return null;
  const paths = managedPaths(env);
  const { pendingVersion: pending, declinedVersion } = readUpdateState(paths);
  if (!isSemver(pending) || pending === currentManagedVersion(paths) || pending === declinedVersion) return null;
  return releaseProblem(versionDir(paths, pending), pending) ? null : pending;
}

// ---------------------------------------------------------------------
// Reporting.

// Every executable `botmancers` on PATH, in order. The first one is what a
// shell runs. npx's temporary bin directories (prepended only while npx runs
// a command, e.g. the install.sh bootstrap) are not a user's PATH.
export function botmancersOnPath(env: NodeJS.ProcessEnv): string[] {
  const found: string[] = [];
  for (const dir of (env.PATH ?? '').split(delimiter).filter(dir => dir && !dir.includes(`${sep}_npx${sep}`))) {
    const candidate = join(dir, 'botmancers');
    try {
      accessSync(candidate, fsConstants.X_OK);
      if (statSync(candidate).isFile() && !found.includes(candidate)) found.push(candidate);
    } catch { /* keep looking */ }
  }
  return found;
}

export interface ManagedReport {
  install: InstallInfo;
  paths: ManagedPaths;
  launcher: boolean;
  resolved: string | null;  // the `botmancers` a shell runs
  shadowedBy: string | null;  // set when PATH resolves to something other than the managed launcher
  current: string | null;
  pending: string | null;
  autoupdate: boolean;
  state: UpdateState;
}

export function managedReport(env: NodeJS.ProcessEnv, cliPath?: string): ManagedReport {
  const paths = managedPaths(env);
  const install = detectInstallKind(env, { cliPath });
  const onPath = botmancersOnPath(env);
  const launcher = launcherInstalled(paths);
  const resolved = onPath[0] ?? null;
  const shadowedBy = launcher && resolved && realOrNull(resolved) !== realOrNull(paths.launcher) ? resolved : null;
  const state = readUpdateState(paths);
  const current = currentManagedVersion(paths);
  const pending = isSemver(state.pendingVersion) && state.pendingVersion !== current && state.pendingVersion !== state.declinedVersion && !releaseProblem(versionDir(paths, state.pendingVersion), state.pendingVersion) ? state.pendingVersion : null;
  return { install, paths, launcher, resolved, shadowedBy, current, pending, autoupdate: !isAutoupdaterDisabled(env), state };
}
