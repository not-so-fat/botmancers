// NOT-476: disposable acceptance harness for the canonical conversation /
// Wake engine (docs/acceptance-harness.md).
//
// One harness owns one temporary root:
//
//   <root>/db/botmancers.db   BOTMANCERS_DB_PATH
//   <root>/data/files         BOTMANCERS_FILES_ROOT (artifacts)
//   <root>/home               HOME (so ~/.botmancers/<agent> workdirs land here)
//   <root>/workspace          a disposable Git repository (one commit)
//   <root>/bin                PATH: only node and git, so no coding runtime
//                             (claude, codex, cursor, muse) is reachable
//   <root>/logs               scenario stdout/stderr
//
// The environment handed to scenario processes is built from scratch, not
// inherited: no Hermes, Cursor, or other credentials, no user
// HOME or Git config. `finish(ok)` removes the root after a passing run and
// keeps it (with FAILED.txt naming what failed) after a failing one.
'use strict';

/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS harness consumed by standalone Node tests. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const ROOT_PREFIX = 'botmancers-acceptance-';

// The state a normal Botmancers install reads and writes, including any
// explicitly configured database or data root wherever it lives. The harness
// never opens these; the isolation self-test proves they are untouched.
function productionPaths(env = process.env) {
  const realHome = os.userInfo().homedir;
  const paths = [
    path.join(REPO_ROOT, 'botmancers.db'),
    path.join(REPO_ROOT, 'botmancers.db-wal'),
    path.join(REPO_ROOT, 'botmancers.db-shm'),
    path.join(REPO_ROOT, 'files'),
    path.join(realHome, '.botmancers'),
  ];
  if (env.BOTMANCERS_DB_PATH) {
    const db = path.resolve(env.BOTMANCERS_DB_PATH);
    paths.push(db, `${db}-wal`, `${db}-shm`);
  }
  if (env.BOTMANCERS_FILES_ROOT) paths.push(path.resolve(env.BOTMANCERS_FILES_ROOT));
  return [...new Set(paths)];
}

// Every path recursively, at any depth, by metadata only: existence, inode,
// size, mtime, and ctime (which any write advances, even a same-size rewrite
// with a restored mtime), plus the repository's Git status. File contents are
// never opened. A before/after pair must be equal.
function snapshotProductionState(paths = productionPaths()) {
  const entries = {};
  const visit = file => {
    let stat;
    try { stat = fs.lstatSync(file); } catch { entries[file] = 'absent'; return; }
    if (stat.isDirectory()) {
      entries[file] = `dir:${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}`;
      let names = [];
      try { names = fs.readdirSync(file).sort(); } catch (error) { entries[file] += `:unreadable:${error.code}`; }
      for (const name of names) visit(path.join(file, name));
    } else if (stat.isSymbolicLink()) {
      entries[file] = `link:${fs.readlinkSync(file)}:${stat.ctimeMs}`;
    } else {
      entries[file] = `file:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    }
  };
  for (const file of paths) visit(file);
  let gitStatus;
  try {
    gitStatus = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: REPO_ROOT, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
  } catch (error) {
    gitStatus = `unavailable: ${error.message}`;
  }
  return { entries, gitStatus };
}

function diffSnapshots(before, after) {
  const changes = [];
  const keys = new Set([...Object.keys(before.entries), ...Object.keys(after.entries)]);
  for (const key of [...keys].sort()) {
    if (before.entries[key] !== after.entries[key]) changes.push(`${key}: ${before.entries[key] ?? 'absent'} -> ${after.entries[key] ?? 'absent'}`);
  }
  if (before.gitStatus !== after.gitStatus) changes.push(`repository git status changed:\n${before.gitStatus}---\n${after.gitStatus}`);
  return changes;
}

function which(command) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const candidate = path.join(dir, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch { /* keep looking */ }
  }
  return null;
}

// A PATH with only node and git: anything else a scenario tried to spawn
// (claude, codex, ...) would fail with ENOENT.
function buildBin(binDir) {
  fs.mkdirSync(binDir, { recursive: true });
  const tools = { node: process.execPath, git: which('git') };
  for (const [name, target] of Object.entries(tools)) {
    if (!target) throw new Error(`acceptance harness needs ${name} on PATH`);
    fs.symlinkSync(target, path.join(binDir, name));
  }
  // macOS git shims (xcrun) need /usr/bin; it holds no coding runtime.
  return [binDir, '/usr/bin', '/bin'].join(path.delimiter);
}

function initWorkspace(dir, env) {
  fs.mkdirSync(dir, { recursive: true });
  const git = (...args) => execFileSync('git', args, { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'README.md'), '# Disposable acceptance workspace\n\nCreated by the Botmancers acceptance harness. Safe to delete.\n');
  fs.writeFileSync(path.join(dir, '.botmancers-disposable'), 'This workspace was created for a Botmancers test and may be deleted.\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'acceptance baseline');
  return git('rev-parse', 'HEAD').trim();
}

// Environment for a scenario process: built from scratch (no inherited
// credentials), pointing every Botmancers path into the harness root.
function isolatedEnvFor(layout, extra = {}) {
  return {
    PATH: layout.pathEnv,
    HOME: layout.home,
    TMPDIR: os.tmpdir(),
    LANG: 'C.UTF-8',
    TZ: 'UTC',
    NODE_ENV: 'test',
    BOTMANCERS_DB_PATH: layout.dbPath,
    BOTMANCERS_FILES_ROOT: layout.filesRoot,
    BOTMANCERS_NO_AUTOPROCESS: '1',
    BOTMANCERS_ACCEPTANCE_ROOT: layout.root,
    BOTMANCERS_ACCEPTANCE_WORKSPACE: layout.workspace,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: layout.gitConfig,
    GIT_AUTHOR_NAME: 'Botmancers Acceptance',
    GIT_AUTHOR_EMAIL: 'acceptance@botmancers.invalid',
    GIT_COMMITTER_NAME: 'Botmancers Acceptance',
    GIT_COMMITTER_EMAIL: 'acceptance@botmancers.invalid',
    ...extra,
  };
}

function createHarness(name, options = {}) {
  const base = options.baseDir || os.tmpdir();
  const root = fs.mkdtempSync(path.join(base, `${ROOT_PREFIX}${String(name).replace(/[^a-z0-9-]/gi, '-')}-`));
  const layout = {
    root,
    dbPath: path.join(root, 'db', 'botmancers.db'),
    filesRoot: path.join(root, 'data', 'files'),
    home: path.join(root, 'home'),
    workspace: path.join(root, 'workspace'),
    logs: path.join(root, 'logs'),
    gitConfig: path.join(root, 'gitconfig'),
    pathEnv: null,
  };
  for (const dir of [path.dirname(layout.dbPath), layout.filesRoot, layout.home, layout.logs]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(layout.gitConfig, '[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n');
  layout.pathEnv = buildBin(path.join(root, 'bin'));
  const baseEnv = isolatedEnvFor(layout);
  layout.baseCommit = initWorkspace(layout.workspace, baseEnv);

  let finished = false;
  const harness = {
    ...layout,
    env: (extra = {}) => isolatedEnvFor(layout, extra),
    // Removes the root after success; after failure keeps it and records
    // why, returning the preserved path.
    finish(ok, details = '') {
      if (finished) return ok ? null : root;
      finished = true;
      if (ok && !options.keep) {
        fs.rmSync(root, { recursive: true, force: true });
        return null;
      }
      fs.writeFileSync(path.join(root, ok ? 'KEPT.txt' : 'FAILED.txt'), [
        `scenario: ${name}`,
        `result: ${ok ? 'passed (kept on request)' : 'FAILED'}`,
        `database: ${layout.dbPath}`,
        `data root: ${layout.filesRoot}`,
        `workspace: ${layout.workspace}`,
        `logs: ${layout.logs}`,
        '',
        details,
      ].join('\n'));
      return root;
    },
  };
  return harness;
}

module.exports = {
  REPO_ROOT,
  ROOT_PREFIX,
  createHarness,
  diffSnapshots,
  productionPaths,
  snapshotProductionState,
};
