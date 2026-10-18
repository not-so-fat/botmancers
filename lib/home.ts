// NOT-494: where the core engine keeps local state.
//
// The installed product (`botmancers start`) always sets BOTMANCERS_HOME
// (default ~/.botmancers), so its database, files, skills, and logs live
// beneath that home whatever directory it was launched from. A source
// checkout run without BOTMANCERS_HOME keeps the historical cwd-relative
// defaults (./botmancers.db, ./files, ./skills, ./.temporal), so an existing
// checkout's state is never moved. An explicit per-path variable always wins
// over both:
//
//   BOTMANCERS_DB_PATH      database file
//   BOTMANCERS_FILES_ROOT   artifact files root
//   BOTMANCERS_SKILLS_ROOT  local skill files root
//   HERMES_WAIT_LOG_PATH    Hermes wait log
//
// The layout below is mirrored by packages/mcp-server/src/home.ts (the CLI
// that creates the home); keep the two in step.
import path from 'path';

export const HOME_ENV = 'BOTMANCERS_HOME';

export const HOME_LAYOUT = {
  db: 'data/botmancers.db',
  files: 'files',
  skills: 'skills',
  waitLog: 'logs/specialist-waits.jsonl',
} as const;

// The configured home, absolute, or null in a checkout without one.
export function botmancersHome(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = (env[HOME_ENV] || '').trim();
  return value ? path.resolve(value) : null;
}

function override(env: NodeJS.ProcessEnv, name: string): string | null {
  const value = (env[name] || '').trim();
  return value || null;
}

export function dbPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = override(env, 'BOTMANCERS_DB_PATH');
  if (explicit) return explicit;
  const home = botmancersHome(env);
  return home ? path.join(home, HOME_LAYOUT.db) : 'botmancers.db';
}

export function filesRootPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = override(env, 'BOTMANCERS_FILES_ROOT');
  if (explicit) return path.resolve(/* turbopackIgnore: true */ explicit);
  const home = botmancersHome(env);
  return home ? path.join(/* turbopackIgnore: true */ home, HOME_LAYOUT.files) : path.resolve(process.cwd(), 'files');
}

export function skillsRootPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = override(env, 'BOTMANCERS_SKILLS_ROOT');
  if (explicit) return path.resolve(explicit);
  const home = botmancersHome(env);
  return home ? path.join(/* turbopackIgnore: true */ home, HOME_LAYOUT.skills) : path.resolve(process.cwd(), 'skills');
}

export function waitLogPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = override(env, 'HERMES_WAIT_LOG_PATH');
  if (explicit) return explicit;
  const home = botmancersHome(env);
  return home ? path.join(/* turbopackIgnore: true */ home, HOME_LAYOUT.waitLog) : path.join(process.cwd(), '.temporal', 'specialist-waits.jsonl');
}
