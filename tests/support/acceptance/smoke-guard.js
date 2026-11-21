// NOT-476/NOT-543: guardrails of the direct operator smoke
// (scripts/direct-smoke.js, docs/acceptance-harness.md).
//
// A real coding Agent runs in the working directory it is given, so the
// smoke refuses any directory that is not explicitly disposable: it must be
// named, exist, be the root of a clean Git repository, carry the
// .botmancers-disposable marker at its root, and lie outside this
// repository, the user's home directory itself, ~/.botmancers, and the
// filesystem root. The evidence file may not land in the workdir or any
// protected Botmancers state, nor overwrite an existing file. Captured
// evidence is redacted before it is printed or written.
'use strict';

/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS harness consumed by standalone Node tests. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const DISPOSABLE_MARKER = '.botmancers-disposable';
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

class GuardError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function real(file) {
  try { return fs.realpathSync(file); } catch { return path.resolve(file); }
}

function within(child, parent) {
  return child === parent || child.startsWith(parent + path.sep);
}

// Returns the resolved disposable workdir or throws a GuardError.
function validateDisposableWorkdir(workdir, { home = os.userInfo().homedir, repoRoot = REPO_ROOT } = {}) {
  if (typeof workdir !== 'string' || workdir.trim() === '') {
    throw new GuardError('workdir_missing', 'An explicit disposable workdir is required (--workdir <path>).');
  }
  const resolved = real(workdir.trim());
  let stat;
  try { stat = fs.statSync(resolved); } catch { throw new GuardError('workdir_not_found', `The workdir ${resolved} does not exist.`); }
  if (!stat.isDirectory()) throw new GuardError('workdir_not_directory', `The workdir ${resolved} is not a directory.`);
  const repo = real(repoRoot);
  const homeDir = real(home);
  if (resolved === path.parse(resolved).root) throw new GuardError('workdir_protected', 'The filesystem root is never disposable.');
  if (within(resolved, repo) || within(repo, resolved)) {
    throw new GuardError('workdir_protected', `The workdir ${resolved} overlaps the Botmancers repository ${repo}.`);
  }
  if (resolved === homeDir || within(homeDir, resolved)) throw new GuardError('workdir_protected', `The workdir ${resolved} is (or contains) the home directory.`);
  if (within(resolved, path.join(homeDir, '.botmancers'))) {
    throw new GuardError('workdir_protected', `The workdir ${resolved} is inside the Botmancers data directory ~/.botmancers.`);
  }
  if (!fs.existsSync(path.join(resolved, '.git'))) {
    throw new GuardError('workdir_not_git_root', `The workdir ${resolved} is not the root of a Git repository.`);
  }
  if (!fs.existsSync(path.join(resolved, DISPOSABLE_MARKER))) {
    throw new GuardError('workdir_not_disposable', `The workdir ${resolved} has no ${DISPOSABLE_MARKER} marker file; create it only in a repository that may be changed or deleted.`);
  }
  let status;
  try {
    status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: resolved, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    throw new GuardError('workdir_not_git_root', `Git cannot read the workdir ${resolved}.`);
  }
  if (status.trim() !== '') throw new GuardError('workdir_dirty', `The workdir ${resolved} has uncommitted changes; commit or discard them first.`);
  return resolved;
}

// Returns the resolved evidence file path or throws a GuardError. The file
// must be new, in an existing directory, and outside the workdir, this
// repository, ~/.botmancers, and every configured production path, so that
// writing it cannot change the state the smoke has just checked.
function validateEvidencePath(file, { workdir, protectedPaths = [], home = os.userInfo().homedir, repoRoot = REPO_ROOT } = {}) {
  if (typeof file !== 'string' || file.trim() === '') throw new GuardError('evidence_invalid', '--evidence needs a file path.');
  const parent = path.dirname(path.resolve(file.trim()));
  let stat;
  try { stat = fs.statSync(parent); } catch { throw new GuardError('evidence_invalid', `The evidence directory ${parent} does not exist.`); }
  if (!stat.isDirectory()) throw new GuardError('evidence_invalid', `The evidence directory ${parent} is not a directory.`);
  const target = path.join(real(parent), path.basename(file.trim()));
  const guarded = [
    ['the smoke workdir', workdir],
    ['the Botmancers repository', repoRoot],
    ['the Botmancers data directory ~/.botmancers', path.join(real(home), '.botmancers')],
    ...protectedPaths.map(entry => ['configured Botmancers state', entry]),
  ];
  for (const [label, entry] of guarded) {
    if (entry && within(target, real(entry))) throw new GuardError('evidence_protected', `The evidence file ${target} would be written inside ${label} (${real(entry)}).`);
  }
  let exists = true;
  try { fs.lstatSync(target); } catch { exists = false; }
  if (exists) throw new GuardError('evidence_exists', `The evidence file ${target} already exists; the smoke never overwrites a file.`);
  return target;
}

// Names whose values are secrets wherever they appear.
const SECRET_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|CREDENTIAL|AUTHORIZATION|BEARER)/i;
const SECRET_PATTERNS = [
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]+@/gi, '$1[REDACTED]@'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer [REDACTED]'],
  [/\bsk-[A-Za-z0-9_-]{8,}/g, '[REDACTED]'],
  [/\bgh[pousr]_[A-Za-z0-9]{16,}/g, '[REDACTED]'],
  [/\bxox[abposr]-[A-Za-z0-9-]{8,}/g, '[REDACTED]'],
];

// Secret values to scrub: the given ones plus every environment value
// whose name looks secret.
function secretValues(env = process.env, extra = []) {
  const values = Object.entries(env)
    .filter(([name, value]) => SECRET_NAME.test(name) && typeof value === 'string' && value.trim().length >= 6)
    .map(([, value]) => value.trim());
  return [...new Set([...values, ...extra.filter(value => typeof value === 'string' && value.length >= 6)])].sort((a, b) => b.length - a.length);
}

function redactText(text, secrets) {
  let out = String(text);
  for (const secret of secrets) out = out.split(secret).join('[REDACTED]');
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

// Deep copy with every secret value and secret-named field redacted.
function redact(value, secrets) {
  if (typeof value === 'string') return redactText(value, secrets);
  if (Array.isArray(value)) return value.map(item => redact(item, secrets));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      SECRET_NAME.test(key) && item !== null && item !== undefined && typeof item !== 'boolean' ? '[REDACTED]' : redact(item, secrets),
    ]));
  }
  return value;
}

module.exports = { DISPOSABLE_MARKER, GuardError, redact, redactText, secretValues, validateDisposableWorkdir, validateEvidencePath };
