// Shared by the package tests and the clean-install smoke: run the CLI as a
// child process and talk to it as a minimal MCP client. Not shipped.
import { spawn } from 'node:child_process';

// Runs a command to completion (or until it prints the listening line).
// Resolves { code, stdout, stderr, port, child } — port and child are set
// only when the bridge started serving.
export function runBridge(command, args, { env, cwd, timeoutMs = 20_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`timed out: ${command} ${args.join(' ')}\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, timeoutMs);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => {
      stderr += chunk;
      const match = /listening on http:\/\/\S+?:(\d+)\/mcp/.exec(stderr);
      if (match && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ code: null, stdout, stderr, port: Number(match[1]), child, output: () => ({ stdout, stderr }) });
      }
    });
    child.on('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, port: null, child: null });
    });
  });
}

export function stopBridge(child) {
  return new Promise(resolve => {
    if (child.exitCode !== null) return resolve(child.exitCode);
    child.once('exit', code => resolve(code));
    child.kill('SIGTERM');
  });
}

let nextId = 1;

export async function mcpPost(url, { token, body, headers = {} } = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: response.status, headers: response.headers, json, text };
}

export function rpc(url, token, method, params = {}) {
  return mcpPost(url, { token, body: { jsonrpc: '2.0', id: nextId++, method, params } });
}

// The handshake an MCP client performs, then the health/tool surface.
export async function mcpSession(url, token) {
  const initialize = await rpc(url, token, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'botmancers-smoke', version: '0' },
  });
  const initialized = await mcpPost(url, { token, body: { jsonrpc: '2.0', method: 'notifications/initialized' } });
  const tools = await rpc(url, token, 'tools/list');
  const health = await rpc(url, token, 'tools/call', { name: 'botmancers_health', arguments: {} });
  return { initialize, initialized, tools, health };
}
