// BOTMANCERS_HOME (default ~/.botmancers): everything the installed product
// writes. The core engine derives the same data/files/skills/logs paths from
// BOTMANCERS_HOME in lib/home.ts of the Botmancers app; keep the two layouts
// in step. Existing explicit path variables (BOTMANCERS_DB_PATH, ...) are
// passed through to the engine untouched and still win.
//
//   <home>/config/core.env     engine configuration: the bridge's service-token
//                              digest, plus anything the operator adds (Hermes)
//   <home>/config/bridge.env   the bridge's two bearer tokens (raw)
//   <home>/data/               SQLite database and WAL
//   <home>/files/ skills/      artifacts and local skills
//   <home>/logs/               supervisor, core, and bridge logs
//   <home>/run/product.json    run metadata of the supervised product
import { existsSync, mkdirSync, readFileSync, statSync, chmodSync, writeFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HOME_ENV = 'BOTMANCERS_HOME';
export const APP_DIR_ENV = 'BOTMANCERS_APP_DIR';
export const UI_PORT_ENV = 'BOTMANCERS_UI_PORT';
export const DEFAULT_UI_PORT = 43123;
export const PRODUCT_HOST = '127.0.0.1';

export const HOME_DIRS = ['config', 'data', 'files', 'skills', 'logs', 'run'] as const;

export interface HomePaths {
  home: string;
  config: string;
  coreEnv: string;
  bridgeEnv: string;
  data: string;
  db: string;
  files: string;
  skills: string;
  logs: string;
  supervisorLog: string;
  uiLog: string;
  mcpLog: string;
  run: string;
  runFile: string;
}

export function resolveHome(env: NodeJS.ProcessEnv): string {
  const configured = (env[HOME_ENV] ?? '').trim();
  return resolve(configured || join(env.HOME?.trim() || homedir(), '.botmancers'));
}

export function homePaths(home: string): HomePaths {
  return {
    home,
    config: join(home, 'config'),
    coreEnv: join(home, 'config', 'core.env'),
    bridgeEnv: join(home, 'config', 'bridge.env'),
    data: join(home, 'data'),
    db: join(home, 'data', 'botmancers.db'),
    files: join(home, 'files'),
    skills: join(home, 'skills'),
    logs: join(home, 'logs'),
    supervisorLog: join(home, 'logs', 'supervisor.log'),
    uiLog: join(home, 'logs', 'core.log'),
    mcpLog: join(home, 'logs', 'bridge.log'),
    run: join(home, 'run'),
    runFile: join(home, 'run', 'product.json'),
  };
}

// The packaged standalone app (UI, API routes, core engine). The override
// exists for tests and for running a locally assembled app.
export function appDir(env: NodeJS.ProcessEnv): string {
  const override = (env[APP_DIR_ENV] ?? '').trim();
  return override ? resolve(override) : fileURLToPath(new URL('../app', import.meta.url));
}

export const CLI_PATH = fileURLToPath(new URL('./cli.js', import.meta.url));

// Paths the packaged app must contain before `start` will launch it.
export const REQUIRED_APP_FILES = [
  'server.js',
  'package.json',
  'BUILD_INFO.json',
  '.next/BUILD_ID',
  '.next/static',
  'public',
  'node_modules/next/package.json',
  'node_modules/better-sqlite3/package.json',
] as const;

export function missingAppFiles(dir: string): string[] {
  return REQUIRED_APP_FILES.filter(entry => !existsSync(join(dir, entry)));
}

export interface BuildInfo {
  version: string;
  commit: string;
}

export function readBuildInfo(dir: string): BuildInfo | null {
  try {
    const info = JSON.parse(readFileSync(join(dir, 'BUILD_INFO.json'), 'utf8')) as Partial<BuildInfo>;
    return typeof info.version === 'string' ? { version: info.version, commit: String(info.commit ?? 'unknown') } : null;
  } catch {
    return null;
  }
}

// Minimal KEY=value files: comments and blank lines ignored, no expansion.
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const at = line.indexOf('=');
    if (at <= 0) continue;
    const key = line.slice(0, at).trim().replace(/^export\s+/, '');
    let value = line.slice(at + 1).trim();
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) out[key] = value;
  }
  return out;
}

export function readEnvFile(path: string): Record<string, string> | null {
  try {
    return parseEnvFile(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

// Owner-only, atomically replaced.
export function writePrivateFile(path: string, text: string): void {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, text, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
}

export function ensurePrivateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

export function modeOf(path: string): number | null {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return null;
  }
}

// Never echoes the value: a token pasted into the wrong variable must not print.
export function portFrom(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = (env[name] ?? '').trim();
  if (!value) return fallback;
  const port = /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new RangeError(`${name} must be an integer port between 1 and 65535.`);
  return port;
}
