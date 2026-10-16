// `botmancers install` and `botmancers upgrade`: the explicit managed-install
// commands (./managed holds the release tree, launcher, and updater).
//
//   install [--to VERSION] [--migrate-cli] [--purge-global]
//       Download botmancers@VERSION (default: npm latest) into
//       <home>/versions/VERSION, point <home>/current at it, and write the
//       ~/.local/bin/botmancers launcher. `--to` an installed older version is
//       the rollback.
//   upgrade [--check] [--to VERSION] [--yes]
//       managed: download, verify, and activate; npm-global: the prompted
//       `npm install -g botmancers@VERSION`; anything else: guidance only.
//
// Neither command touches user state under <home>. A release is never made
// current under a live product: it is recorded as pending and activates at
// the next `botmancers start`.
import { createInterface } from 'node:readline';
import { delimiter } from 'node:path';
import { packageVersion } from './contract.js';
import {
  MANAGED_INSTALL_COMMAND, PACKAGE_NAME, RESTART_ACTION, activateRelease, botmancersOnPath, compareSemver, currentManagedVersion,
  detectInstallKind, fetchLatestVersion, isAutoupdaterDisabled, isSemver, managedPaths, readUpdateState, runNpm, stageRelease,
  writeLauncher, writeUpdateState, type ManagedPaths, type NpmRunner, type StageDeps,
} from './managed.js';
import { inspect, productContext } from './product.js';

export interface UpgradeIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export interface UpgradeDeps extends StageDeps {
  latest?: () => Promise<string>;
  // npm commands that act on the user's global install (install -g, uninstall -g).
  globalNpm?: NpmRunner;
  confirm?: (question: string) => Promise<boolean>;
}

export const INSTALL_HELP = `Usage: botmancers install [--to VERSION] [--migrate-cli] [--purge-global]

Installs botmancers@VERSION (default: npm latest) into ~/.botmancers/versions/VERSION,
points ~/.botmancers/current at it, and writes the launcher ~/.local/bin/botmancers.
Your data, configuration, logs, and workdirs under ~/.botmancers are not touched.
\`--to\` an older installed version rolls back to it.

  --to VERSION     install this exact version instead of latest
  --migrate-cli    explain how to make the launcher win over an npm-global botmancers on PATH
  --purge-global   also run \`npm uninstall -g botmancers\` (the only option that does)

Automatic updates are on for managed installs: at most one npm check a day, a
background download, and activation at the next \`botmancers start\`.
Turn them off with BOTMANCERS_DISABLE_AUTOUPDATER=1.
`;

export const UPGRADE_HELP = `Usage: botmancers upgrade [--check] [--to VERSION] [--yes]

  managed      download and verify the release, then activate it (or, while the
               product runs, stage it to activate at the next start)
  npm-global   npm install -g botmancers@VERSION (asks first unless --yes)
  other        report how this copy was installed; never changes it

  --check        report the installed, latest, and pending versions only
  --to VERSION   this exact version (an older one rolls back)
  --yes          do not ask before npm install -g
`;

class ArgError extends Error {}

function parseFlags(argv: string[], flags: string[]): { to?: string; set: Set<string> } {
  const set = new Set<string>();
  let to: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--to') {
      to = argv[++i];
      if (!isSemver(to)) throw new ArgError('--to needs a version such as 0.3.0.');
    } else if (flags.includes(arg)) set.add(arg);
    else throw new ArgError(/^--?[a-z][a-z0-9-]{0,38}$/.test(arg) ? `Unknown argument ${JSON.stringify(arg)}.` : 'Unexpected argument (value not shown).');
  }
  return { to, set };
}

function ttyConfirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return Promise.resolve(false);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, answer => {
    rl.close();
    resolve(/^y/i.test(answer.trim()));
  }));
}

async function resolveTarget(env: NodeJS.ProcessEnv, to: string | undefined, deps: UpgradeDeps): Promise<string> {
  return to ?? await (deps.latest ?? (() => fetchLatestVersion(env, 10_000)))();
}

// Whether a product started from this home is live (any owned or unverifiable
// process); then `current` must not move beneath it.
async function productLive(env: NodeJS.ProcessEnv): Promise<boolean> {
  const view = await inspect(productContext(env, { stdout: () => {}, stderr: () => {} }));
  return view.state !== 'stopped';
}

type Placement = 'activated' | 'pending' | 'blocked';

// Makes a complete staged release current, or records it as pending while
// the product runs. Rolling back marks the newer version declined, so the
// auto-updater does not reinstate it at the next start.
async function placeRelease(paths: ManagedPaths, env: NodeJS.ProcessEnv, version: string, io: UpgradeIo, clearDeclined: boolean): Promise<Placement> {
  const previous = currentManagedVersion(paths);
  const state = readUpdateState(paths);
  const newest = [previous, state.pendingVersion, state.declinedVersion].filter(isSemver).sort(compareSemver).pop() ?? null;
  const declinedVersion = newest && compareSemver(version, newest) < 0 ? newest : clearDeclined ? null : state.declinedVersion;
  if (previous && previous !== version && await productLive(env)) {
    if (isAutoupdaterDisabled(env)) {
      io.stderr(`botmancers: ${version} is downloaded, but botmancers ${previous} is running and automatic activation is off (BOTMANCERS_DISABLE_AUTOUPDATER). Run \`botmancers stop\`, then \`botmancers upgrade --to ${version}\`.\n`);
      return 'blocked';
    }
    writeUpdateState(paths, { pendingVersion: version, pendingIntegrity: null, stagedAt: new Date().toISOString(), declinedVersion });
    io.stdout(`botmancers: ${version} is staged; botmancers ${previous} keeps running. Restart once to activate it: ${RESTART_ACTION}\n`);
    return 'pending';
  }
  activateRelease(paths, version);
  writeUpdateState(paths, { declinedVersion });
  io.stdout(`botmancers: activated ${version}${previous && previous !== version ? ` (was ${previous})` : ''}; ${paths.current} -> versions/${version}\n`);
  return 'activated';
}

async function stage(paths: ManagedPaths, env: NodeJS.ProcessEnv, version: string, io: UpgradeIo, deps: UpgradeDeps): Promise<boolean> {
  try {
    const staged = await stageRelease(paths, env, version, deps);
    io.stdout(staged.reused
      ? `botmancers: ${version} is already installed at ${staged.dir}\n`
      : `botmancers: downloaded ${PACKAGE_NAME}@${version} (${staged.integrity}) into ${staged.dir}\n`);
    return true;
  } catch (error) {
    io.stderr(`botmancers: could not install ${PACKAGE_NAME}@${version}: ${(error as Error).message}\n`);
    return false;
  }
}

function pathAdvice(paths: ManagedPaths, env: NodeJS.ProcessEnv, io: UpgradeIo, migrate: boolean): void {
  io.stdout(`Launcher: ${paths.launcher}\n`);
  const dirs = (env.PATH ?? '').split(delimiter);
  if (!dirs.includes(paths.localBin)) io.stdout(`${paths.localBin} is not on PATH. Add it, e.g.: export PATH="${paths.localBin}:$PATH"\n`);
  const first = botmancersOnPath(env)[0];
  if (first && first !== paths.launcher) {
    io.stdout(`Note: \`botmancers\` currently resolves to ${first}, which shadows the launcher.\n`);
    if (migrate) io.stdout(`To migrate: put ${paths.localBin} before ${first.slice(0, first.lastIndexOf('/'))} on PATH, or run \`botmancers install --purge-global\` to remove the npm-global copy.\n`);
  }
}

export async function runInstall(argv: string[], env: NodeJS.ProcessEnv, io: UpgradeIo, deps: UpgradeDeps = {}): Promise<number> {
  if (argv.includes('-h') || argv.includes('--help')) {
    io.stdout(INSTALL_HELP);
    return 0;
  }
  let flags;
  try {
    flags = parseFlags(argv, ['--migrate-cli', '--purge-global']);
  } catch (error) {
    io.stderr(`botmancers install: ${(error as Error).message} Run botmancers install --help.\n`);
    return 2;
  }
  const paths = managedPaths(env);
  let version: string;
  try {
    version = await resolveTarget(env, flags.to, deps);
  } catch (error) {
    io.stderr(`botmancers install: could not resolve the latest version from npm: ${(error as Error).message}\n`);
    return 1;
  }
  io.stdout(`botmancers: installing ${PACKAGE_NAME}@${version} into ${paths.versions} (data under ${paths.home} is left unchanged)\n`);
  if (!await stage(paths, env, version, io, deps)) return 1;
  const placed = await placeRelease(paths, env, version, io, !flags.to);
  writeLauncher(paths);
  pathAdvice(paths, env, io, flags.set.has('--migrate-cli'));
  if (flags.set.has('--purge-global')) {
    const result = await (deps.globalNpm ?? runNpm)(['uninstall', '-g', PACKAGE_NAME], env);
    if (result.code === 0) io.stdout('Removed the npm-global botmancers package.\n');
    else io.stderr(`botmancers: npm uninstall -g ${PACKAGE_NAME} failed (exit ${result.code}); the managed install is still active.\n`);
  }
  io.stdout(`Next: botmancers doctor && botmancers setup && botmancers start --daemon --open\n`);
  return placed === 'blocked' ? 1 : 0;
}

export async function runUpgrade(argv: string[], env: NodeJS.ProcessEnv, io: UpgradeIo, deps: UpgradeDeps = {}): Promise<number> {
  if (argv.includes('-h') || argv.includes('--help')) {
    io.stdout(UPGRADE_HELP);
    return 0;
  }
  let flags;
  try {
    flags = parseFlags(argv, ['--check', '--yes', '-y']);
  } catch (error) {
    io.stderr(`botmancers upgrade: ${(error as Error).message} Run botmancers upgrade --help.\n`);
    return 2;
  }
  const check = flags.set.has('--check');
  const install = detectInstallKind(env, { spawnNpm: true });
  const paths = managedPaths(env);
  const installed = install.kind === 'managed' ? currentManagedVersion(paths) ?? packageVersion() : packageVersion();
  let target: string;
  try {
    target = await resolveTarget(env, flags.to, deps);
  } catch (error) {
    io.stderr(`botmancers upgrade: could not resolve the latest version from npm: ${(error as Error).message}\n`);
    return 1;
  }
  io.stdout(`Install:  ${install.kind} (${install.cliPath})\nCurrent:  ${installed}\n${flags.to ? 'Target' : 'Latest'}:   ${target}\n`);
  if (install.kind === 'managed') {
    const pending = readUpdateState(paths).pendingVersion;
    if (pending && pending !== installed) io.stdout(`Pending:  ${pending} (staged; activates at the next botmancers start)\n`);
  }
  const newer = compareSemver(target, installed) > 0;
  if (!flags.to && !newer) {
    io.stdout('Already on the latest version.\n');
    return 0;
  }
  if (check) {
    io.stdout(newer ? `Update available. Run: botmancers upgrade${flags.to ? ` --to ${target}` : ''}\n` : `Run: botmancers upgrade --to ${target}\n`);
    return 0;
  }

  if (install.kind === 'managed') {
    if (!await stage(paths, env, target, io, deps)) return 1;
    const placed = await placeRelease(paths, env, target, io, true);
    return placed === 'blocked' ? 1 : 0;
  }

  if (install.kind === 'npm-global') {
    const command = `npm install -g ${PACKAGE_NAME}@${target}`;
    const yes = flags.set.has('--yes') || flags.set.has('-y');
    if (!yes && !await (deps.confirm ?? ttyConfirm)(`Upgrade the npm-global botmancers with "${command}"? [y/N] `)) {
      io.stdout(`Not upgraded. To upgrade, run: ${command}   (or: botmancers upgrade --yes)\nTip: ${MANAGED_INSTALL_COMMAND}  # managed install with safe auto-updates; data unchanged\n`);
      return 0;
    }
    const result = await (deps.globalNpm ?? runNpm)(['install', '-g', `${PACKAGE_NAME}@${target}`], env);
    if (result.code !== 0) {
      io.stderr(`botmancers: ${command} failed (exit ${result.code}): ${result.stderr.trim().split('\n').slice(-3).join(' ')}\n`);
      return 1;
    }
    io.stdout(`Upgraded the npm-global botmancers to ${target}. A running product keeps its version until: ${RESTART_ACTION}\n`);
    return 0;
  }

  const how = install.kind === 'npx' ? `run npx botmancers@${target} instead`
    : install.kind === 'project-local' ? `run npm install botmancers@${target} in that project`
      : install.kind === 'dev-checkout' ? 'update the checkout with git and rebuild'
        : 'reinstall it the way it was installed';
  io.stderr(`botmancers: this copy is a ${install.kind} install and does not update itself; ${how}.\nRecommended: ${MANAGED_INSTALL_COMMAND}  (managed install with safe auto-updates; data unchanged)\n`);
  return 1;
}

