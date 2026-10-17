// Shared by the product tests and the product install smoke: run CLI
// commands to completion, find free ports, and build a fake packaged app (a
// tiny core that answers /api/health and the /api/v0/mcp subset the bridge
// needs) for the supervisor's failure modes. Not shipped.
import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url));
export const CLI = join(PACKAGE_DIR, 'dist/cli.js');
export const SCHEMA_PATH = join(PACKAGE_DIR, 'schemas/botmancers.mcp.v2.tools.json');

// Runs `command args` to completion. Resolves { code, stdout, stderr }.
export function run(command, args, { env, cwd, timeoutMs = 90_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`timed out: ${command} ${args.join(' ')}\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, timeoutMs);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

export function cli(args, options = {}) {
  return run(process.execPath, [options.cliPath ?? CLI, ...args], options);
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

export function listenOn(port) {
  return new Promise((resolve, reject) => {
    const server = createServer(socket => socket.destroy());
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

export async function waitFor(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return false;
}

// The fake core. FAKE_APP_MODE (passed through the supervisor's environment):
// ok | exit (dies at startup) | reject-mcp (refuses the bridge's service
// token). FAKE_APP_VERSION overrides the reported version. It dumps the
// environment it received to <home>/logs/fake-core-env.json.
const FAKE_SERVER = String.raw`'use strict';
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const info = JSON.parse(fs.readFileSync(path.join(__dirname, 'BUILD_INFO.json'), 'utf8'));
const TOOLS = JSON.parse(fs.readFileSync(__SCHEMA__, 'utf8')).tools;
const mode = process.env.FAKE_APP_MODE || 'ok';
if (process.env.BOTMANCERS_HOME) {
  fs.writeFileSync(path.join(process.env.BOTMANCERS_HOME, 'logs', 'fake-core-env.json'), JSON.stringify(process.env));
}
if (mode === 'exit') {
  console.error('fake core: failing at startup on purpose');
  process.exit(1);
}
const digests = (process.env.BOTMANCERS_SERVICE_TOKENS || '').split(/[,\s]+/).filter(Boolean).map(entry => entry.slice(entry.indexOf('=') + 1));
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    if (req.url === '/api/health') {
      return json(res, 200, { status: 'ok', service: 'botmancers-core', version: process.env.FAKE_APP_VERSION || info.version, commit: info.commit, engine: 'ok', home: process.env.BOTMANCERS_HOME || null });
    }
    if (req.url !== '/api/v0/mcp' || req.method !== 'POST') return json(res, 404, { error: { code: 'not_found', message: 'Not found' } });
    const bearer = (/^Bearer (\S+)$/.exec(req.headers.authorization || '') || [])[1] || '';
    const digest = 'sha256:' + crypto.createHash('sha256').update(bearer).digest('hex');
    if (mode === 'reject-mcp' || !digests.includes(digest)) return json(res, 401, { error: { code: 'unauthenticated', message: 'Authentication failed.' } });
    const { id, method, params } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (method === 'initialize') return json(res, 200, { jsonrpc: '2.0', id, result: { protocolVersion: params.protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'botmancers', version: '1.0.0' } } });
    if (method === 'tools/list') return json(res, 200, { jsonrpc: '2.0', id, result: { tools: TOOLS } });
    if (method === 'tools/call' && params.name === 'botmancers_health') {
      const structured = { contract: 'botmancers.mcp.v1', status: 'ok', principal: { kind: 'service', id: 'botmancers-bridge' }, coordinators: [] };
      return json(res, 200, { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(structured) }], structuredContent: structured, isError: false } });
    }
    return json(res, 200, { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
  });
});
server.listen(Number(process.env.PORT), process.env.HOSTNAME || '127.0.0.1');
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`;

export const FAKE_PREBUILD_PLATFORMS = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'linuxmusl-x64', 'linuxmusl-arm64', 'win32-x64', 'win32-arm64'];

const NATIVE_TARGET = `${process.platform === 'linux' && !process.report.getReport().header.glibcVersionRuntime ? 'linuxmusl' : process.platform}-${process.arch}`;
const nativeBinaryOf = real => {
  const binding = createRequire(join(real, 'lib', 'binding.js'))('./binding.js');
  return binding.getPrebuildPath() ?? join(real, 'build', 'Release', 'better_sqlite3.node');
};

export function makeFakeApp(dir, { version, commit = 'fake' }) {
  for (const sub of ['.next/static/chunks', 'public', 'node_modules/next', 'node_modules/better-sqlite3']) mkdirSync(join(dir, sub), { recursive: true });
  writeFileSync(join(dir, 'server.js'), FAKE_SERVER.replace('__SCHEMA__', JSON.stringify(SCHEMA_PATH)));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fake-botmancers-app', private: true, type: 'commonjs' }));
  writeFileSync(join(dir, 'BUILD_INFO.json'), JSON.stringify({ name: 'botmancers', version, commit }));
  writeFileSync(join(dir, '.next/BUILD_ID'), 'fake');
  writeFileSync(join(dir, 'node_modules/next/package.json'), JSON.stringify({ name: 'next', version: '0.0.0' }));
  // The real better-sqlite3 (the files build-app.mjs ships) with this
  // platform's real prebuild, so release and doctor checks really load it and
  // run a query; other platforms get placeholder binaries.
  const sqlite = join(dir, 'node_modules/better-sqlite3');
  const real = dirname(createRequire(join(PACKAGE_DIR, 'package.json')).resolve('better-sqlite3/package.json'));
  for (const entry of ['package.json', 'LICENSE', 'lib']) cpSync(join(real, entry), join(sqlite, entry), { recursive: true });
  mkdirSync(join(sqlite, 'prebuilds'), { recursive: true });
  for (const platform of FAKE_PREBUILD_PLATFORMS) writeFileSync(join(sqlite, `prebuilds/${platform}.node`), 'fake native binary');
  cpSync(nativeBinaryOf(real), join(sqlite, `prebuilds/${NATIVE_TARGET}.node`));
  return dir;
}
