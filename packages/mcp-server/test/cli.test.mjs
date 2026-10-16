// The botmancers CLI against a fake Botmancers: configuration and startup
// failure modes (actionable, non-zero, secret-free), and the served MCP
// surface. Runs the compiled dist/cli.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startFakeBotmancers } from '../scripts/fake-botmancers.mjs';
import { mcpPost, mcpSession, rpc, runBridge, stopBridge } from '../scripts/harness.mjs';

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const SCHEMA = JSON.parse(readFileSync(new URL('../schemas/botmancers.mcp.v1.tools.json', import.meta.url), 'utf8'));
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const SERVICE_TOKEN = 'svc-0123456789abcdef-SERVICE-SECRET';
const MCP_TOKEN = 'mcp-fedcba9876543210-INBOUND-SECRET';

function env(overrides = {}) {
  const base = { PATH: process.env.PATH, HOME: process.env.HOME };
  return { ...base, BOTMANCERS_SERVICE_TOKEN: SERVICE_TOKEN, BOTMANCERS_MCP_TOKEN: MCP_TOKEN, BOTMANCERS_MCP_PORT: '0', ...overrides };
}

function assertNoSecrets(text, extra = []) {
  for (const secret of [SERVICE_TOKEN, MCP_TOKEN, ...extra]) {
    assert.ok(!text.includes(secret), `output leaked a secret: ${text}`);
  }
}

// fetch() does not let a caller set Host, so a rebound request is sent raw.
function postWithHost(url, host, token, body) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: 'POST', headers: { host, authorization: `Bearer ${token}`, 'content-type': 'application/json' } }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

const run = (args, overrides) => runBridge(process.execPath, [CLI, ...args], { env: env(overrides) });

async function closedPort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('--help and --version print to stdout and exit 0 without configuration', async () => {
  const help = await runBridge(process.execPath, [CLI, '--help'], { env: { PATH: process.env.PATH } });
  assert.equal(help.code, 0);
  assert.match(help.stdout, /Usage: botmancers/);
  for (const name of ['BOTMANCERS_URL', 'BOTMANCERS_SERVICE_TOKEN', 'BOTMANCERS_MCP_TOKEN', 'BOTMANCERS_MCP_HOST', 'BOTMANCERS_MCP_PORT']) {
    assert.match(help.stdout, new RegExp(name));
  }
  const version = await runBridge(process.execPath, [CLI, '--version'], { env: { PATH: process.env.PATH } });
  assert.equal(version.code, 0);
  assert.equal(version.stdout.trim(), VERSION);
});

test('missing configuration lists every missing setting and exits 2', async () => {
  const result = await runBridge(process.execPath, [CLI], { env: { PATH: process.env.PATH } });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /BOTMANCERS_URL is required/);
  assert.match(result.stderr, /BOTMANCERS_SERVICE_TOKEN is required/);
  assert.match(result.stderr, /BOTMANCERS_MCP_TOKEN is required/);
  assert.match(result.stderr, /botmancers --help/);
});

test('invalid URLs are refused without echoing the value', async () => {
  const cases = [
    ['not a url SECRET-IN-URL', /not a valid absolute URL/, 'SECRET-IN-URL'],
    ['http://alice:URL-PASSWORD@127.0.0.1:43123', /must not contain credentials/, 'URL-PASSWORD'],
    ['ftp://127.0.0.1/', /must use http:\/\/ or https:\/\//, null],
    ['http://127.0.0.1:43123/?token=QUERY-SECRET', /must not contain a query string/, 'QUERY-SECRET'],
  ];
  for (const [url, message, secret] of cases) {
    const result = await run([], { BOTMANCERS_URL: url });
    assert.equal(result.code, 2, url);
    assert.match(result.stderr, message);
    assertNoSecrets(result.stderr, secret ? [secret] : []);
  }
});

test('bad tokens, ports, hosts, and secret flags are configuration errors', async () => {
  const url = 'http://127.0.0.1:1';
  const cases = [
    [[], { BOTMANCERS_URL: url, BOTMANCERS_MCP_TOKEN: 'short' }, /at least 16 characters/],
    [[], { BOTMANCERS_URL: url, BOTMANCERS_MCP_TOKEN: SERVICE_TOKEN }, /must differ from BOTMANCERS_SERVICE_TOKEN/],
    [[], { BOTMANCERS_URL: url, BOTMANCERS_SERVICE_TOKEN: 'two words' }, /single printable token/],
    [['--port', '70000'], { BOTMANCERS_URL: url }, /--port must be an integer port/],
    [[], { BOTMANCERS_URL: url, BOTMANCERS_MCP_PORT: 'abc' }, /BOTMANCERS_MCP_PORT must be an integer port/],
    // A token pasted into a port setting is never echoed, not even a prefix.
    [['--port', 'FLAG-SECRET-port-token-0123456789'], { BOTMANCERS_URL: url }, /--port must be an integer port/],
    [[], { BOTMANCERS_URL: url, BOTMANCERS_MCP_PORT: 'FLAG-SECRET-port-token-0123456789' }, /BOTMANCERS_MCP_PORT must be an integer port/],
    [['--host', 'bad host!'], { BOTMANCERS_URL: url }, /--host must be an IP address or hostname/],
    [['--service-token', 'FLAG-SECRET'], { BOTMANCERS_URL: url }, /--service-token is not accepted/],
    [['--mcp-token=FLAG-SECRET'], { BOTMANCERS_URL: url }, /--mcp-token is not accepted/],
    [['--bogus'], { BOTMANCERS_URL: url }, /Unknown argument "--bogus"/],
    [['FLAG-SECRET-positional'], { BOTMANCERS_URL: url }, /Unexpected positional argument \(value not shown\)/],
  ];
  for (const [args, overrides, message] of cases) {
    const result = await run(args, overrides);
    assert.equal(result.code, 2, `${args} ${JSON.stringify(overrides)}`);
    assert.match(result.stderr, message);
    assertNoSecrets(result.stderr, ['FLAG-SECRET']);
  }
});

test('unavailable Botmancers exits 4 with an actionable message', async () => {
  const result = await run([], { BOTMANCERS_URL: `http://127.0.0.1:${await closedPort()}` });
  assert.equal(result.code, 4);
  assert.match(result.stderr, /Cannot reach Botmancers at http:\/\/127\.0\.0\.1:\d+ \(ECONNREFUSED\)\. Is the Botmancers app running/);
  assertNoSecrets(result.stderr);
});

test('a URL that is not a Botmancers MCP endpoint exits 4', async () => {
  const fake = await startFakeBotmancers({ serviceToken: SERVICE_TOKEN });
  try {
    const result = await run([], { BOTMANCERS_URL: `${fake.url}/wrong-prefix` });
    assert.equal(result.code, 4);
    assert.match(result.stderr, /does not serve a compatible MCP endpoint at \/api\/v0\/mcp \(HTTP 404\)/);
    assertNoSecrets(result.stderr);
  } finally {
    await fake.close();
  }
});

test('an unrelated MCP server, or a Botmancers missing contract tools, exits 4', async () => {
  const cases = [
    ['generic', /is an MCP endpoint but not a compatible Botmancers \(serverInfo\.name is not "botmancers"\)/],
    ['partial_tools', /not a compatible Botmancers \(missing botmancers\.mcp\.v1 tools: botmancers_start_task\)/],
  ];
  for (const [mode, message] of cases) {
    const fake = await startFakeBotmancers({ serviceToken: SERVICE_TOKEN, mode });
    try {
      const result = await run([], { BOTMANCERS_URL: fake.url });
      assert.equal(result.code, 4, `${mode}: ${result.stderr}`);
      assert.match(result.stderr, message);
      assert.doesNotMatch(result.stderr, /listening/);
      assertNoSecrets(result.stderr);
      assert.ok(!fake.received.some(entry => entry.message.method === 'tools/call'), 'preflight never calls a tool');
    } finally {
      await fake.close();
    }
  }
});

test('invalid credentials exit 5 without revealing either token', async () => {
  const fake = await startFakeBotmancers({ serviceToken: 'a-different-token-the-server-knows' });
  try {
    const result = await run([], { BOTMANCERS_URL: fake.url });
    assert.equal(result.code, 5);
    assert.match(result.stderr, /Botmancers rejected the service token \(HTTP 401 unauthenticated\)\. Check that BOTMANCERS_SERVICE_TOKEN/);
    assertNoSecrets(result.stderr);
  } finally {
    await fake.close();
  }
});

test('a Botmancers server with no service tokens configured exits 5', async () => {
  const fake = await startFakeBotmancers({ serviceToken: SERVICE_TOKEN, mode: 'unconfigured' });
  try {
    const result = await run([], { BOTMANCERS_URL: fake.url });
    assert.equal(result.code, 5);
    assert.match(result.stderr, /Set BOTMANCERS_SERVICE_TOKENS on the Botmancers server/);
    assertNoSecrets(result.stderr);
  } finally {
    await fake.close();
  }
});

test('an occupied port exits 3 with an actionable message', async () => {
  const fake = await startFakeBotmancers({ serviceToken: SERVICE_TOKEN });
  const blocker = createServer();
  await new Promise(resolve => blocker.listen(0, '127.0.0.1', resolve));
  try {
    const port = blocker.address().port;
    const result = await run([], { BOTMANCERS_URL: fake.url, BOTMANCERS_MCP_PORT: String(port) });
    assert.equal(result.code, 3);
    assert.match(result.stderr, new RegExp(`port ${port} on 127\\.0\\.0\\.1 is already in use\\. Stop the other process or choose another port`));
    assertNoSecrets(result.stderr);
  } finally {
    await new Promise(resolve => blocker.close(resolve));
    await fake.close();
  }
});

test('serves health and the MCP tool surface, forwarding tool calls with the service token', async () => {
  const fake = await startFakeBotmancers({ serviceToken: SERVICE_TOKEN });
  const started = await run([], { BOTMANCERS_URL: fake.url });
  assert.ok(started.port, started.stderr);
  const base = `http://127.0.0.1:${started.port}`;
  const url = `${base}/mcp`;
  try {
    assert.match(started.stderr, new RegExp(`botmancers ${VERSION.replace(/\./g, '\\.')}: MCP bridge listening on http://127\\.0\\.0\\.1:\\d+/mcp`));

    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: 'ok', contract: 'botmancers.mcp.v1', version: VERSION });

    const session = await mcpSession(url, MCP_TOKEN);
    assert.equal(session.initialize.status, 200);
    assert.equal(session.initialize.json.result.protocolVersion, '2025-06-18');
    assert.equal(session.initialize.json.result.serverInfo.name, 'botmancers');
    assert.equal(session.initialize.json.result.serverInfo.version, VERSION);
    assert.equal(session.initialized.status, 202);
    assert.deepEqual(session.tools.json.result.tools, SCHEMA.tools);
    assert.equal(session.health.json.result.isError, false);
    assert.equal(session.health.json.result.structuredContent.status, 'ok');

    // Botmancers saw the service token, never the MCP client's token.
    const forwarded = fake.received.filter(entry => entry.message.method === 'tools/call');
    assert.equal(forwarded.length, 1);
    assert.equal(forwarded[0].headers.authorization, `Bearer ${SERVICE_TOKEN}`);
    assert.deepEqual(forwarded[0].message.params, { name: 'botmancers_health', arguments: {} });
    assert.ok(!JSON.stringify(fake.received).includes(MCP_TOKEN));

    // Tool errors from Botmancers pass through unchanged.
    const missing = await rpc(url, MCP_TOKEN, 'tools/call', { name: 'botmancers_get_request', arguments: { request_id: 'nope' } });
    assert.equal(missing.json.result.isError, true);
    assert.equal(missing.json.result.structuredContent.error.code, 'request_not_found');

    // Unknown tools are refused locally, never forwarded.
    const before = fake.received.length;
    for (const name of ['botmancers_grant', 'toString', 'constructor']) {
      const unknown = await rpc(url, MCP_TOKEN, 'tools/call', { name, arguments: {} });
      assert.equal(unknown.json.error.code, -32602);
    }
    assert.equal(fake.received.length, before);

    const unknownMethod = await rpc(url, MCP_TOKEN, 'resources/list');
    assert.equal(unknownMethod.json.error.code, -32601);
  } finally {
    assert.equal(await stopBridge(started.child), 0);
    await fake.close();
  }
  assertNoSecrets(started.output().stderr);
});

test('inbound requests are authenticated and guarded', async () => {
  const fake = await startFakeBotmancers({ serviceToken: SERVICE_TOKEN });
  const started = await run([], { BOTMANCERS_URL: fake.url });
  const url = `http://127.0.0.1:${started.port}/mcp`;
  try {
    const before = fake.received.length;
    const anonymous = await rpc(url, null, 'tools/list');
    assert.equal(anonymous.status, 401);
    assert.match(anonymous.headers.get('www-authenticate'), /^Bearer/);
    const wrong = await rpc(url, SERVICE_TOKEN, 'tools/call', { name: 'botmancers_health', arguments: {} });
    assert.equal(wrong.status, 401);
    assertNoSecrets(wrong.text);

    const rebound = await postWithHost(url, 'evil.example:80', MCP_TOKEN, { jsonrpc: '2.0', id: 1, method: 'ping' });
    assert.equal(rebound.status, 403);
    assert.equal(rebound.json.error.code, 'host_not_allowed');
    const crossOrigin = await mcpPost(url, { token: MCP_TOKEN, body: { jsonrpc: '2.0', id: 1, method: 'ping' }, headers: { origin: 'https://evil.example' } });
    assert.equal(crossOrigin.status, 403);
    assert.equal(crossOrigin.json.error.code, 'origin_not_allowed');

    const badVersion = await mcpPost(url, { token: MCP_TOKEN, body: { jsonrpc: '2.0', id: 1, method: 'ping' }, headers: { 'mcp-protocol-version': '1999-01-01' } });
    assert.equal(badVersion.status, 400);
    const parse = await mcpPost(url, { token: MCP_TOKEN, body: '{' });
    assert.equal(parse.json.error.code, -32700);
    const batch = await mcpPost(url, { token: MCP_TOKEN, body: [{ jsonrpc: '2.0', id: 1, method: 'ping' }] });
    assert.equal(batch.status, 400);
    const big = await mcpPost(url, { token: MCP_TOKEN, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'x'.repeat(300 * 1024) } }) });
    assert.equal(big.status, 413);

    const get = await fetch(url);
    assert.equal(get.status, 405);
    assert.equal(get.headers.get('allow'), 'POST');
    assert.equal(fake.received.length, before);
  } finally {
    await stopBridge(started.child);
    await fake.close();
  }
  assertNoSecrets(started.output().stderr);
});

test('Botmancers failures after startup become JSON-RPC errors without secrets', async () => {
  const fake = await startFakeBotmancers({ serviceToken: SERVICE_TOKEN });
  const started = await run([], { BOTMANCERS_URL: fake.url });
  const url = `http://127.0.0.1:${started.port}/mcp`;
  try {
    await fake.close();
    const down = await rpc(url, MCP_TOKEN, 'tools/call', { name: 'botmancers_health', arguments: {} });
    assert.equal(down.status, 200);
    assert.equal(down.json.error.code, -32603);
    assert.equal(down.json.error.data.code, 'botmancers_unreachable');
    assert.match(down.json.error.message, /Cannot reach Botmancers/);
    assertNoSecrets(down.text);
  } finally {
    await stopBridge(started.child);
  }
  const { stderr } = started.output();
  assert.match(stderr, /tools\/call botmancers_health failed: Cannot reach Botmancers/);
  assertNoSecrets(stderr);

  const limited = await startFakeBotmancers({ serviceToken: SERVICE_TOKEN, mode: 'rate_limited' });
  const again = await run([], { BOTMANCERS_URL: limited.url });
  try {
    const response = await rpc(`http://127.0.0.1:${again.port}/mcp`, MCP_TOKEN, 'tools/call', { name: 'botmancers_health', arguments: {} });
    assert.equal(response.status, 429);
    assert.equal(response.headers.get('retry-after'), '7');
    assert.equal(response.json.error.code, 'rate_limited');
  } finally {
    await stopBridge(again.child);
    await limited.close();
  }
});

test('a non-loopback bind and plain-http remote Botmancers print warnings', async () => {
  const fake = await startFakeBotmancers({ serviceToken: SERVICE_TOKEN });
  const started = await run(['--host', '0.0.0.0'], { BOTMANCERS_URL: fake.url });
  try {
    assert.ok(started.port, started.stderr);
    assert.match(started.stderr, /warning: binding 0\.0\.0\.0, not loopback\. Expose the bridge only on a private network or behind an HTTPS/);
  } finally {
    await stopBridge(started.child);
    await fake.close();
  }
  const remote = await run([], { BOTMANCERS_URL: 'http://botmancers.invalid:9', BOTMANCERS_MCP_PORT: '0' });
  assert.match(remote.stderr, /uses plain http:\/\/ to a non-loopback host/);
});

// NOT-494: the product command router must leave bridge mode untouched.
test('`botmancers mcp` behaves exactly like bare `botmancers`', async () => {
  const cases = [
    [[], { PATH: process.env.PATH }],
    [['--help'], { PATH: process.env.PATH }],
    [['--version'], { PATH: process.env.PATH }],
    [['--port', 'nope'], env({ BOTMANCERS_URL: 'http://127.0.0.1:9' })],
    [['--token', 'x'], env({ BOTMANCERS_URL: 'http://127.0.0.1:9' })],
    [[], env({ BOTMANCERS_URL: 'http://127.0.0.1:9' })],
  ];
  for (const [args, environment] of cases) {
    const bare = await runBridge(process.execPath, [CLI, ...args], { env: environment });
    const explicit = await runBridge(process.execPath, [CLI, 'mcp', ...args], { env: environment });
    assert.equal(explicit.code, bare.code, `exit code for ${args.join(' ') || '(no args)'}`);
    assert.equal(explicit.stdout, bare.stdout);
    assert.equal(explicit.stderr, bare.stderr);
  }

  const fake = await startFakeBotmancers({ serviceToken: SERVICE_TOKEN });
  try {
    for (const prefix of [[], ['mcp']]) {
      const started = await runBridge(process.execPath, [CLI, ...prefix], { env: env({ BOTMANCERS_URL: fake.url }) });
      assert.ok(started.port, `${prefix.join(' ') || 'bare'} serves`);
      const session = await mcpSession(`http://127.0.0.1:${started.port}/mcp`, MCP_TOKEN);
      assert.equal(session.health.json.result.structuredContent.status, 'ok');
      assert.equal(await stopBridge(started.child), 0);
    }
  } finally {
    await fake.close();
  }
});

test('bare `botmancers --help` points to the product commands without changing bridge usage', async () => {
  const help = await runBridge(process.execPath, [CLI, '--help'], { env: { PATH: process.env.PATH } });
  assert.match(help.stdout, /^Usage: botmancers \[options\]/);
  assert.match(help.stdout, /botmancers setup && botmancers start --daemon/);
});
