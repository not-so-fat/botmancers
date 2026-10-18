// `botmancers setup --client codex|cursor|claude` and the doctor client
// checks (NOT-501), in isolated homes, for all three adapters: install,
// repeat, upgrade to a release with a changed skill, user-edit and foreign
// MCP entry conflicts, a missing client, version rollback, a write that
// fails part way (everything restored), removal, and the doctor state
// matrix with captured stdout/stderr, exit codes, and token redaction.
//
// Releases N and N+1 are real package trees (this checkout's dist/ and
// skills/, a fake app); N+1's SKILL.md differs, as a new release's would.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../scripts/product-harness.mjs';
import { makePackage } from '../scripts/managed-harness.mjs';

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const NEXT = VERSION.replace(/(\d+)$/, patch => String(Number(patch) + 1));
const SKILL = 'botmancers-collaboration';
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const mode = path => statSync(path).mode & 0o777;

let releases;
function packages() {
  if (releases) return releases;
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'botmancers-client-releases-')));
  process.on('exit', () => rmSync(root, { recursive: true, force: true }));
  const n = makePackage(join(root, VERSION), VERSION);
  const n1 = makePackage(join(root, NEXT), NEXT);
  appendFileSync(join(n1, 'skills', SKILL, 'SKILL.md'), `\n<!-- release ${NEXT} -->\n`);
  releases = { [VERSION]: n, [NEXT]: n1 };
  return releases;
}

const LAYOUT = {
  codex: user => ({ root: join(user, '.codex'), config: join(user, '.codex', 'config.toml'), skills: join(user, '.codex', 'skills') }),
  cursor: user => ({ root: join(user, '.cursor'), config: join(user, '.cursor', 'mcp.json'), skills: join(user, '.cursor', 'skills') }),
  claude: user => ({ root: join(user, '.claude'), config: join(user, '.claude.json'), skills: join(user, '.claude', 'skills') }),
};

// What a user already has before Botmancers touches the client.
function seedClient(id, user) {
  const layout = LAYOUT[id](user);
  mkdirSync(join(layout.skills, 'my-skill'), { recursive: true });
  writeFileSync(join(layout.skills, 'my-skill', 'SKILL.md'), '---\nname: my-skill\ndescription: mine\n---\nmine\n');
  if (id === 'codex') writeFileSync(layout.config, 'model = "o4"\n\n[mcp_servers.other]\ncommand = "other-mcp"\nargs = ["--x"]\n');
  if (id === 'claude') writeFileSync(layout.config, `${JSON.stringify({ numStartups: 7, projects: { '/w': { allowedTools: [] } }, mcpServers: { other: { type: 'stdio', command: 'other' } } }, null, 2)}\n`);
  // Cursor starts with no mcp.json: setup creates it owner-only.
  return layout;
}

function sandbox(t, { defaultPorts = false } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'botmancers-clients-')));
  t.after(() => {
    try { chmodSync(join(root, 'user'), 0o700); } catch { /* fine */ }
    rmSync(root, { recursive: true, force: true });
  });
  const user = join(root, 'user');
  mkdirSync(user, { recursive: true });
  const home = join(root, 'bm');
  const env = (version, extra = {}) => ({
    PATH: process.env.PATH, HOME: user, BOTMANCERS_HOME: home, BOTMANCERS_DISABLE_AUTOUPDATER: '1',
    BOTMANCERS_APP_DIR: join(packages()[version], 'app'),
    ...(defaultPorts ? {} : { BOTMANCERS_MCP_PORT: '43999', BOTMANCERS_UI_PORT: '43998' }),
    BOTMANCERS_AGENT_DECK_URL: 'http://127.0.0.1:9', ...extra,
  });
  const outputs = [];
  const bm = async (args, { version = VERSION, extra } = {}) => {
    const result = await run(process.execPath, [join(packages()[version], 'dist', 'cli.js'), ...args], { env: env(version, extra), cwd: root });
    outputs.push(result.stdout, result.stderr);
    return result;
  };
  const tokens = () => {
    const text = readFileSync(join(home, 'config/bridge.env'), 'utf8');
    return { service: /^BOTMANCERS_SERVICE_TOKEN=(\S+)$/m.exec(text)[1], mcp: /^BOTMANCERS_MCP_TOKEN=(\S+)$/m.exec(text)[1] };
  };
  const seen = new Set();
  const noLeaks = () => {
    if (existsSync(join(home, 'config/bridge.env'))) for (const token of Object.values(tokens())) seen.add(token);
    for (const output of outputs) for (const token of seen) assert.ok(!output.includes(token), `token leaked: ${output}`);
  };
  return { root, user, home, bm, tokens, noLeaks };
}

function entryOf(id, layout) {
  const text = readFileSync(layout.config, 'utf8');
  if (id === 'codex') {
    const block = /^\[mcp_servers\.botmancers\]\nurl = "([^"]+)"\nhttp_headers = \{ "Authorization" = "Bearer ([^"]+)" \}$/m.exec(text);
    return block && { url: block[1], token: block[2] };
  }
  const entry = JSON.parse(text).mcpServers?.botmancers;
  if (!entry) return null;
  if (id === 'claude') assert.equal(entry.type, 'http');
  return { url: entry.url, token: entry.headers.Authorization.replace(/^Bearer /, '') };
}

const skillHashes = dir => Object.fromEntries(['SKILL.md', 'references/workflows.md'].map(rel => [rel, sha(join(dir, rel))]));
const packagedHashes = version => skillHashes(join(packages()[version], 'skills', SKILL));

for (const id of ['codex', 'cursor', 'claude']) {
  test(`${id}: an owned old-default connection refreshes, while an edited one is preserved`, async t => {
    const s = sandbox(t, { defaultPorts: true });
    const layout = seedClient(id, s.user);
    assert.equal((await s.bm(['setup'])).code, 0);

    const old = await s.bm(['setup', '--client', id], { extra: { BOTMANCERS_MCP_PORT: '43124' } });
    assert.equal(old.code, 0, old.stderr);
    assert.equal(entryOf(id, layout).url, 'http://127.0.0.1:43124/mcp');

    const doctor = await s.bm(['doctor']);
    assert.match(doctor.stdout, new RegExp(`warn +${id} +MCP entry stale \\(it still points to the old default http://127\\.0\\.0\\.1:43124/mcp\\).*repair: botmancers setup --client ${id}$`, 'm'));

    const refreshed = await s.bm(['setup']);
    assert.equal(refreshed.code, 0, refreshed.stderr);
    assert.equal(entryOf(id, layout).url, 'http://127.0.0.1:3332/mcp');
    assert.match(refreshed.stdout, /\(updated\)/);

    // Recreate the legacy URL as a user edit. Its hash no longer matches the
    // manifest, so neither explicit nor upgrade-style plain setup may rewrite it.
    if (id === 'codex') {
      writeFileSync(layout.config, readFileSync(layout.config, 'utf8').replace('url = "http://127.0.0.1:3332/mcp"', 'url = "http://127.0.0.1:43124/mcp"'));
    } else {
      const doc = JSON.parse(readFileSync(layout.config, 'utf8'));
      doc.mcpServers.botmancers.url = 'http://127.0.0.1:43124/mcp';
      writeFileSync(layout.config, `${JSON.stringify(doc, null, 2)}\n`);
    }
    const edited = sha(layout.config);
    const conflict = await s.bm(['setup', '--client', id]);
    assert.equal(conflict.code, 12);
    assert.match(conflict.stderr, /changed nothing/);
    assert.equal(sha(layout.config), edited);
    const upgradeStyle = await s.bm(['setup'], { version: NEXT });
    assert.equal(upgradeStyle.code, 0);
    assert.match(upgradeStyle.stderr, /changed nothing/);
    assert.equal(sha(layout.config), edited);
    s.noLeaks();
  });

  test(`${id}: install, repeat, upgrade, conflict, rollback, and removal keep user files and credentials`, async t => {
    const s = sandbox(t);
    const layout = seedClient(id, s.user);
    const userSkill = join(layout.skills, 'my-skill', 'SKILL.md');
    const userSkillHash = sha(userSkill);
    const installed = join(layout.skills, SKILL);
    const manifestFile = join(s.home, 'config', 'clients', `${id}.json`);

    // Install.
    const first = await s.bm(['setup', '--client', id]);
    assert.equal(first.code, 0, first.stderr);
    assert.match(first.stdout, new RegExp(`setup --client ${id}: .* is connected to Botmancers ${VERSION.replace(/\./g, '\\.')}\\.`));
    assert.match(first.stdout, /\(added\)/);
    assert.match(first.stdout, /\(installed\)/);
    const credentials = { core: sha(join(s.home, 'config/core.env')), bridge: sha(join(s.home, 'config/bridge.env')) };
    assert.deepEqual(entryOf(id, layout), { url: 'http://127.0.0.1:43999/mcp', token: s.tokens().mcp });
    assert.deepEqual(skillHashes(installed), packagedHashes(VERSION));
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
    assert.equal(manifest.version, VERSION);
    assert.deepEqual(manifest.skill.files, packagedHashes(VERSION));
    assert.equal(manifest.mcp.config, layout.config);
    assert.equal(mode(manifestFile), 0o600);
    assert.ok(!readFileSync(manifestFile, 'utf8').includes(s.tokens().mcp), 'the manifest holds no token');
    assert.equal(sha(userSkill), userSkillHash, 'user skill untouched');
    if (id === 'codex') assert.match(readFileSync(layout.config, 'utf8'), /^model = "o4"\n\n\[mcp_servers\.other\]\ncommand = "other-mcp"\nargs = \["--x"\]\n\n\[mcp_servers\.botmancers\]/);
    if (id === 'claude') {
      const doc = JSON.parse(readFileSync(layout.config, 'utf8'));
      assert.equal(doc.numStartups, 7);
      assert.deepEqual(doc.projects, { '/w': { allowedTools: [] } });
      assert.deepEqual(doc.mcpServers.other, { type: 'stdio', command: 'other' });
    }
    if (id === 'cursor') assert.equal(mode(layout.config), 0o600, 'a config file setup creates is owner-only');

    // Repeat: idempotent, byte for byte.
    const configBefore = sha(layout.config);
    const again = await s.bm(['setup', '--client', id]);
    assert.equal(again.code, 0, again.stderr);
    assert.match(again.stdout, /\(unchanged\)[\s\S]*\(unchanged\)/);
    assert.equal(sha(layout.config), configBefore);
    assert.deepEqual(skillHashes(installed), packagedHashes(VERSION));
    assert.deepEqual(JSON.parse(readFileSync(manifestFile, 'utf8')).skill, manifest.skill);

    // A plain setup of the same release changes nothing either.
    assert.equal((await s.bm(['setup'])).code, 0);
    assert.equal(sha(layout.config), configBefore);

    // Upgrade: the N+1 CLI's plain `setup` refreshes the managed skill.
    const upgraded = await s.bm(['setup'], { version: NEXT });
    assert.equal(upgraded.code, 0, upgraded.stderr);
    assert.match(upgraded.stdout, new RegExp(`is connected to Botmancers ${NEXT.replace(/\./g, '\\.')}[\\s\\S]*\\(unchanged\\)[\\s\\S]*\\(updated\\)`));
    assert.deepEqual(skillHashes(installed), packagedHashes(NEXT));
    assert.equal(JSON.parse(readFileSync(manifestFile, 'utf8')).version, NEXT);
    assert.deepEqual({ core: sha(join(s.home, 'config/core.env')), bridge: sha(join(s.home, 'config/bridge.env')) }, credentials, 'credentials kept');
    assert.equal(sha(userSkill), userSkillHash);
    assert.equal(sha(layout.config), configBefore, 'the MCP entry was already current');

    // Rollback: the N CLI puts N's skill back (it is still Botmancers-managed).
    const rolled = await s.bm(['setup', '--client', id]);
    assert.equal(rolled.code, 0, rolled.stderr);
    assert.deepEqual(skillHashes(installed), packagedHashes(VERSION));
    assert.equal(JSON.parse(readFileSync(manifestFile, 'utf8')).version, VERSION);

    // User edit: never overwritten, actionable guidance, nothing else written.
    appendFileSync(join(installed, 'SKILL.md'), '\nMy own note.\n');
    const edited = sha(join(installed, 'SKILL.md'));
    const conflict = await s.bm(['setup', '--client', id], { version: NEXT });
    assert.equal(conflict.code, 12);
    assert.match(conflict.stderr, new RegExp(`changed nothing for .*\\n  skill  .*${SKILL}/SKILL\\.md`));
    assert.match(conflict.stderr, new RegExp(`then re-run: botmancers setup --client ${id}$`, 'm'));
    assert.equal(sha(join(installed, 'SKILL.md')), edited);
    assert.equal(sha(join(installed, 'references/workflows.md')), packagedHashes(VERSION)['references/workflows.md'], 'no partial refresh');
    assert.equal(JSON.parse(readFileSync(manifestFile, 'utf8')).version, VERSION);
    // A plain setup reports the conflict but still succeeds at its own job.
    const plain = await s.bm(['setup'], { version: NEXT });
    assert.equal(plain.code, 0);
    assert.match(plain.stderr, /changed nothing for/);
    assert.equal(sha(join(installed, 'SKILL.md')), edited);

    // The user resolves it as told; the next run installs N+1.
    rmSync(join(installed, 'SKILL.md'));
    assert.equal((await s.bm(['setup', '--client', id], { version: NEXT })).code, 0);
    assert.deepEqual(skillHashes(installed), packagedHashes(NEXT));

    // A foreign "botmancers" MCP entry is never replaced.
    if (id === 'codex') writeFileSync(layout.config, readFileSync(layout.config, 'utf8').replace('url = "http://127.0.0.1:43999/mcp"', 'url = "https://my-proxy.example/mcp"'));
    else {
      const doc = JSON.parse(readFileSync(layout.config, 'utf8'));
      doc.mcpServers.botmancers.url = 'https://my-proxy.example/mcp';
      writeFileSync(layout.config, `${JSON.stringify(doc, null, 2)}\n`);
    }
    const userConfig = sha(layout.config);
    const foreign = await s.bm(['setup', '--client', id], { version: NEXT });
    assert.equal(foreign.code, 12);
    assert.match(foreign.stderr, /MCP {4}.*already has an MCP server named "botmancers" that Botmancers did not write or that was edited/);
    assert.match(foreign.stderr, /remove the "botmancers" MCP server entry from/);
    assert.equal(sha(layout.config), userConfig);

    // Removal: managed files go, the user's entry and files stay.
    const removed = await s.bm(['setup', '--client', id, '--remove'], { version: NEXT });
    assert.equal(removed.code, 0, removed.stderr);
    assert.match(removed.stdout, /Kept, because they were edited/);
    assert.ok(!existsSync(installed), 'managed skill removed');
    assert.ok(!existsSync(manifestFile));
    assert.equal(entryOf(id, layout).url, 'https://my-proxy.example/mcp', 'the edited entry was kept');
    assert.equal(sha(userSkill), userSkillHash);
    s.noLeaks();
  });

  test(`${id}: a missing client writes nothing and points at the MCP-only path`, async t => {
    const s = sandbox(t);
    const layout = LAYOUT[id](s.user);
    const result = await s.bm(['setup', '--client', id]);
    assert.equal(result.code, 11);
    assert.match(result.stderr, new RegExp(`is not set up for this user \\(.* not found\\); nothing was written`));
    assert.match(result.stderr, /Any MCP client works without the skill \(MCP-only\):\n {2}URL {5}http:\/\/127\.0\.0\.1:43999\/mcp\n {2}Header {2}Authorization: Bearer <BOTMANCERS_MCP_TOKEN from /);
    assert.ok(!existsSync(layout.root) && !existsSync(layout.config));
    assert.ok(!existsSync(join(s.home, 'config', 'clients', `${id}.json`)));
    // The home itself was set up: the MCP-only path works.
    assert.ok(existsSync(join(s.home, 'config/bridge.env')));
    s.noLeaks();
  });
}

test('a write that fails part way restores every file of that client', { skip: process.getuid?.() === 0 && 'root ignores permissions' }, async t => {
  const s = sandbox(t);
  const layout = seedClient('claude', s.user);
  assert.equal((await s.bm(['setup'])).code, 0);
  const configBefore = sha(layout.config);
  // ~/.claude.json lives in HOME; a read-only HOME fails that write after the
  // skill files under ~/.claude/skills were already written.
  chmodSync(s.user, 0o555);
  const failed = await s.bm(['setup', '--client', 'claude']);
  chmodSync(s.user, 0o700);
  assert.equal(failed.code, 12);
  assert.match(failed.stderr, /could not write Claude Code files \(EACCES\); restored everything this run had changed/);
  assert.ok(!existsSync(join(layout.skills, SKILL)), 'the skill files written before the failure were removed');
  assert.equal(sha(layout.config), configBefore);
  assert.ok(!existsSync(join(s.home, 'config', 'clients', 'claude.json')), 'no manifest');
  assert.deepEqual(readdirSync(layout.skills), ['my-skill']);
  // Once the cause is fixed the same command succeeds.
  assert.equal((await s.bm(['setup', '--client', 'claude'])).code, 0);
  s.noLeaks();
});

test('setup argument errors exit 2; plain setup never creates client files', async t => {
  const s = sandbox(t);
  for (const [args, pattern] of [
    [['setup', '--client', 'vscode'], /unsupported client "vscode"; supported: codex, cursor, claude\. Other MCP clients need no setup/],
    [['setup', '--client'], /--client needs a value/],
    [['setup', '--remove'], /--remove needs --client/],
    [['setup', '--force'], /unknown argument --force/],
  ]) {
    const result = await s.bm(args);
    assert.equal(result.code, 2, args.join(' '));
    assert.match(result.stderr, pattern);
  }
  const layout = LAYOUT.codex(s.user);
  mkdirSync(layout.root);
  assert.equal((await s.bm(['setup'])).code, 0);
  assert.deepEqual(readdirSync(layout.root), [], 'plain setup only refreshes clients set up with --client');
  // Several clients at once, comma-separated or repeated.
  mkdirSync(LAYOUT.cursor(s.user).root);
  const both = await s.bm(['setup', '--client', 'codex,cursor', '--client', 'codex']);
  assert.equal(both.code, 0, both.stderr);
  assert.equal(both.stdout.match(/is connected to Botmancers/g).length, 2);
  s.noLeaks();
});

test('doctor reports connected, missing, stale, and conflicted client states without tokens', async t => {
  const s = sandbox(t);
  const doctor = async (version = VERSION, extra) => {
    const result = await s.bm(['doctor'], { version, extra });
    const lines = Object.fromEntries(result.stdout.split('\n').map(line => /^ {2}(ok|warn|info|fail) +(codex|cursor|claude|clients) +(.*)$/.exec(line)).filter(Boolean).map(([, level, name, detail]) => [name, `${level} ${detail}`]));
    return { ...result, lines };
  };
  assert.equal((await s.bm(['setup'])).code, 0);
  const baseline = await doctor();
  assert.match(baseline.lines.clients, /^info no MCP client set up by Botmancers \(optional\): botmancers setup --client codex\|cursor\|claude/);

  for (const id of ['codex', 'cursor', 'claude']) seedClient(id, s.user);
  const detected = await doctor();
  assert.match(detected.lines.clients, /^info Codex, Cursor, Claude Code found but not connected \(optional\): botmancers setup --client codex \/ botmancers setup --client cursor \/ botmancers setup --client claude$/);
  assert.equal(detected.code, baseline.code, 'client state never changes the doctor exit code');

  assert.equal((await s.bm(['setup', '--client', 'codex,cursor,claude'])).code, 0);
  const connected = await doctor();
  for (const id of ['codex', 'cursor', 'claude']) assert.match(connected.lines[id], new RegExp(`^ok MCP connected; skill ${SKILL} ${VERSION.replace(/\./g, '\\.')} current \\(~/`));
  assert.equal(connected.lines.clients, undefined);
  assert.equal(connected.code, baseline.code);

  // After an upgrade the packaged skill is newer: stale, with the repair command.
  const stale = await doctor(NEXT);
  for (const id of ['codex', 'cursor', 'claude']) assert.match(stale.lines[id], new RegExp(`^warn MCP connected; skill ${SKILL} ${VERSION.replace(/\./g, '\\.')} stale \\(1 file differs from this release\\); repair: botmancers setup --client ${id}$`));

  // Rotated MCP token: the entry is managed but stale.
  const bridgeEnv = join(s.home, 'config/bridge.env');
  const oldMcp = s.tokens().mcp;
  writeFileSync(bridgeEnv, readFileSync(bridgeEnv, 'utf8').replace(oldMcp, `bmmcp_${'c'.repeat(64)}`));
  chmodSync(bridgeEnv, 0o600);
  const rotated = await doctor();
  s.noLeaks();
  assert.match(rotated.lines.codex, /^warn MCP entry stale \(its URL or token no longer matches this Botmancers\); skill .* current .*; repair: botmancers setup --client codex$/);
  assert.equal((await s.bm(['setup', '--client', 'codex'])).code, 0);
  assert.equal(entryOf('codex', LAYOUT.codex(s.user)).token, `bmmcp_${'c'.repeat(64)}`, 'repair writes the new token');
  assert.match((await doctor()).lines.codex, /^ok MCP connected/);

  // Missing skill and missing entry.
  rmSync(join(LAYOUT.cursor(s.user).skills, SKILL), { recursive: true });
  const cursorDoc = JSON.parse(readFileSync(LAYOUT.cursor(s.user).config, 'utf8'));
  delete cursorDoc.mcpServers.botmancers;
  writeFileSync(LAYOUT.cursor(s.user).config, JSON.stringify(cursorDoc));
  const missing = await doctor();
  assert.match(missing.lines.cursor, /^warn MCP entry missing; skill botmancers-collaboration missing \(~\/\.cursor\/skills\/botmancers-collaboration\); repair: botmancers setup --client cursor$/);

  // Conflicted.
  appendFileSync(join(LAYOUT.claude(s.user).skills, SKILL, 'references/workflows.md'), '\nmine\n');
  const conflicted = await doctor();
  assert.match(conflicted.lines.claude, /^warn conflicted: 1 skill file in ~\/\.claude\/skills\/botmancers-collaboration changed since Botmancers wrote them, so setup will not overwrite them; keep a copy of your edits, remove them, then run: botmancers setup --client claude$/);
  assert.equal(conflicted.code, baseline.code);
  assert.ok(!Object.values(conflicted.lines).some(line => line.startsWith('fail')));

  // Doctor wrote nothing to any client.
  const snapshot = ['codex', 'cursor', 'claude'].map(id => sha(LAYOUT[id](s.user).config)).join();
  await doctor();
  assert.equal(['codex', 'cursor', 'claude'].map(id => sha(LAYOUT[id](s.user).config)).join(), snapshot);

  // The client config holds the token, but no doctor or setup output ever shows it.
  for (const output of [baseline, detected, connected, stale, rotated, missing, conflicted]) {
    for (const token of [oldMcp, `bmmcp_${'c'.repeat(64)}`, s.tokens().service]) {
      assert.ok(!output.stdout.includes(token) && !output.stderr.includes(token));
    }
  }
  s.noLeaks();
});

// ---------------------------------------------------------------------
// Ownership edge cases, driven through the built module with crafted
// releases: a release that drops a file, a failed write after pruning, and
// a manifest that is not one Botmancers wrote.

const clients = () => import('../dist/clients.js');
const homeModule = () => import('../dist/home.js');
const release = (files) => Object.entries(files).map(([rel, text]) => ({ rel, data: Buffer.from(text), hash: createHash('sha256').update(text).digest('hex') }));
const OLD = release({ 'SKILL.md': 'old skill\n', 'references/workflows.md': 'flows\n', 'references/legacy/notes.md': 'legacy\n' });
const NEW = release({ 'SKILL.md': 'new skill\n', 'references/workflows.md': 'flows\n' });
const TARGET = { url: 'http://127.0.0.1:43999/mcp', token: `bmmcp_${'d'.repeat(64)}` };

async function direct(t) {
  const { homePaths } = await homeModule();
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'botmancers-clients-direct-')));
  t.after(() => {
    try { chmodSync(join(root, 'user'), 0o700); } catch { /* fine */ }
    rmSync(root, { recursive: true, force: true });
  });
  const user = join(root, 'user');
  mkdirSync(join(user, '.claude', 'skills'), { recursive: true });
  const paths = homePaths(join(root, 'bm'));
  mkdirSync(paths.config, { recursive: true });
  const env = { HOME: user };
  const skillDir = join(user, '.claude', 'skills', SKILL);
  return { user, paths, env, skillDir, config: join(user, '.claude.json'), manifestFile: join(paths.config, 'clients', 'claude.json') };
}

test('an edited managed file that the new release drops is a conflict: nothing changes', async t => {
  const { installClient, inspectClient } = await clients();
  const d = await direct(t);
  assert.equal(installClient('claude', d.env, d.paths, TARGET, '1.0.0', OLD).ok, true);
  const legacy = join(d.skillDir, 'references/legacy/notes.md');
  appendFileSync(legacy, 'my own note\n');
  const manifestBefore = readFileSync(d.manifestFile, 'utf8');
  const skillBefore = readFileSync(join(d.skillDir, 'SKILL.md'), 'utf8');

  assert.equal(inspectClient('claude', d.env, d.paths, TARGET, NEW).skill.state, 'conflict');
  const outcome = installClient('claude', d.env, d.paths, TARGET, '1.1.0', NEW);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.kind, 'conflict');
  assert.match(outcome.lines.join('\n'), /changed nothing for Claude Code[\s\S]*\n {2}skill {2}~\/\.claude\/skills\/botmancers-collaboration\/references\/legacy\/notes\.md\n[\s\S]*then re-run: botmancers setup --client claude$/);
  assert.equal(readFileSync(join(d.skillDir, 'SKILL.md'), 'utf8'), skillBefore, 'no partial refresh');
  assert.equal(readFileSync(legacy, 'utf8'), 'legacy\nmy own note\n');
  assert.equal(readFileSync(d.manifestFile, 'utf8'), manifestBefore, 'manifest not replaced');

  // Untouched, the dropped file is removed and its empty directory pruned.
  writeFileSync(legacy, 'legacy\n');
  assert.equal(installClient('claude', d.env, d.paths, TARGET, '1.1.0', NEW).ok, true);
  assert.ok(!existsSync(join(d.skillDir, 'references/legacy')));
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(d.manifestFile, 'utf8')).skill.files).sort(), ['SKILL.md', 'references/workflows.md']);
});

test('rollback recreates pruned directories when a later write fails', { skip: process.getuid?.() === 0 && 'root ignores permissions' }, async t => {
  const { installClient } = await clients();
  const d = await direct(t);
  assert.equal(installClient('claude', d.env, d.paths, TARGET, '1.0.0', OLD).ok, true);
  const before = Object.fromEntries(OLD.map(file => [file.rel, sha(join(d.skillDir, file.rel))]));
  const configBefore = sha(d.config);
  const manifestBefore = readFileSync(d.manifestFile, 'utf8');
  // A rotated token makes the ~/.claude.json write necessary; it comes after
  // the dropped file was removed and references/legacy/ pruned, and a
  // read-only HOME fails it.
  chmodSync(d.user, 0o555);
  const outcome = installClient('claude', d.env, d.paths, { ...TARGET, token: `bmmcp_${'e'.repeat(64)}` }, '1.1.0', NEW);
  chmodSync(d.user, 0o700);
  assert.equal(outcome.ok, false);
  assert.match(outcome.lines[0], /could not write Claude Code files \(EACCES\); restored everything this run had changed\./);
  assert.deepEqual(Object.fromEntries(OLD.map(file => [file.rel, sha(join(d.skillDir, file.rel))])), before, 'every file, including the pruned one, is back');
  assert.equal(mode(join(d.skillDir, 'references/legacy/notes.md')), 0o644);
  assert.equal(sha(d.config), configBefore);
  assert.equal(readFileSync(d.manifestFile, 'utf8'), manifestBefore);
});

test('a structurally invalid manifest is reported, never trusted, and repaired by setup', async t => {
  const { installClient, inspectClient, clientDoctorLines, removeClient, setupClients } = await clients();
  const d = await direct(t);
  assert.equal(installClient('claude', d.env, d.paths, TARGET, '1.0.0', NEW).ok, true);
  const valid = JSON.parse(readFileSync(d.manifestFile, 'utf8'));
  const broken = [
    ['no skill.files', { ...valid, skill: { dir: valid.skill.dir } }],
    ['no mcp.hash', { ...valid, mcp: { config: valid.mcp.config, name: 'botmancers' } }],
    ['escaping path', { ...valid, skill: { ...valid.skill, files: { '../../outside': valid.skill.files['SKILL.md'] } } }],
    ['not an object', [1, 2]],
    ['not JSON', null],
  ];
  for (const [label, doc] of broken) {
    writeFileSync(d.manifestFile, doc === null ? '{"schema":1,' : JSON.stringify(doc));
    const view = inspectClient('claude', d.env, d.paths, TARGET, NEW);
    assert.equal(view.manifest, null, label);
    assert.ok(view.manifestProblem, label);
    const doctor = clientDoctorLines(d.env, d.paths, TARGET).find(([, name]) => name === 'claude');
    assert.equal(doctor[0], 'warn', label);
    assert.match(doctor[2], /ownership manifest .*claude\.json cannot be trusted \(.+\); Botmancers treats Claude Code files as user-owned until it is rebuilt; repair: botmancers setup --client claude$/, label);
    assert.ok(!doctor[2].includes(TARGET.token));
    const removal = removeClient('claude', d.env, d.paths);
    assert.equal(removal.ok, false, label);
    assert.match(removal.lines[0], /--remove: changed nothing; the ownership manifest .* cannot be trusted/);
    assert.ok(existsSync(join(d.skillDir, 'SKILL.md')), `${label}: removal deleted nothing`);
  }
  // Plain setup still selects a client whose manifest file is untrusted.
  const [selected] = setupClients({ clients: [], remove: false }, d.env, d.paths, TARGET, '1.0.0');
  assert.match(selected.lines[0], /botmancers setup --client claude:/);
  // Files still match this release: setup rebuilds the manifest.
  const repaired = installClient('claude', d.env, d.paths, TARGET, '1.0.0', NEW);
  assert.equal(repaired.ok, true, repaired.lines.join('\n'));
  assert.deepEqual(JSON.parse(readFileSync(d.manifestFile, 'utf8')).skill, valid.skill);

  // When files differ from this release, an untrusted manifest makes them conflicts.
  writeFileSync(d.manifestFile, '{}');
  const conflict = installClient('claude', d.env, d.paths, TARGET, '1.1.0', OLD);
  assert.equal(conflict.ok, false);
  assert.match(conflict.lines.join('\n'), /owner {2}the ownership manifest cannot be trusted/);
  assert.equal(readFileSync(join(d.skillDir, 'SKILL.md'), 'utf8'), 'new skill\n');
});
