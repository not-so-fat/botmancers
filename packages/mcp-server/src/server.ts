// The standalone bridge: MCP Streamable HTTP at POST /mcp, stateless, with
// application/json responses (no session id, no server-initiated SSE
// stream, so GET and DELETE are 405), and an unauthenticated GET /healthz.
//
// initialize, ping, and tools/list are answered locally from the bundled
// botmancers.mcp.v1 schema; tools/call for a contract tool is forwarded
// unchanged to Botmancers' /api/v0/mcp with the service token. MCP clients
// authenticate to the bridge with their own bearer token and never see the
// service token.
//
// DNS-rebinding guard: when bound to a loopback address, Host must be a
// loopback host; an Origin header, when present, must be exactly
// http://<loopback Host>. The endpoint has no CORS support.
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { BridgeConfig } from './config.js';
import { isLoopbackHost } from './config.js';
import { MCP_CONTRACT, MCP_INSTRUCTIONS, MCP_PROTOCOL_VERSIONS, loadToolContract, negotiateProtocolVersion, packageVersion } from './contract.js';
import { createRedactor, type Redactor } from './redact.js';
import { UpstreamError, createUpstream, type Upstream } from './upstream.js';

export const MCP_PATH = '/mcp';
export const HEALTH_PATH = '/healthz';
export const MAX_BODY_BYTES = 256 * 1024;

export const JSON_RPC = { parseError: -32700, invalidRequest: -32600, methodNotFound: -32601, invalidParams: -32602, internalError: -32603 };

type JsonRpcId = string | number;

export interface Logger {
  info(message: string): void;
  error(message: string): void;
}

export interface BridgeOptions {
  config: BridgeConfig;
  logger?: Logger;
  upstream?: Upstream;
}

export interface Bridge {
  server: Server;
  redact: Redactor;
  upstream: Upstream;
  listen(): Promise<AddressInfo>;
  close(): Promise<void>;
}

function rpcError(id: JsonRpcId | null, code: number, message: string, data?: unknown) {
  return { jsonrpc: '2.0' as const, id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(text);
}

function envelope(res: ServerResponse, status: number, code: string, message: string, headers: Record<string, string> = {}): void {
  sendJson(res, status, { error: { code, message } }, headers);
}

class BodyTooLarge extends Error {}

function readBody(req: IncomingMessage): Promise<string> {
  const declared = req.headers['content-length'];
  if (declared !== undefined && !(/^\d+$/.test(declared.trim()) && Number(declared) <= MAX_BODY_BYTES)) {
    return Promise.reject(new BodyTooLarge());
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > MAX_BODY_BYTES) {
        req.pause();
        reject(new BodyTooLarge());
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

export const defaultLogger: Logger = {
  info: message => process.stderr.write(`${message}\n`),
  error: message => process.stderr.write(`${message}\n`),
};

export function createBridge(options: BridgeOptions): Bridge {
  const { config } = options;
  const redact = createRedactor([config.serviceToken, config.mcpToken]);
  const base = options.logger ?? defaultLogger;
  const logger: Logger = { info: m => base.info(redact(m)), error: m => base.error(redact(m)) };
  const upstream = options.upstream ?? createUpstream({ botmancersUrl: config.botmancersUrl, serviceToken: config.serviceToken });
  const contract = loadToolContract();
  const toolNames = new Set(contract.tools.map(tool => tool.name));
  const version = packageVersion();
  const expectedToken = digest(config.mcpToken);
  const loopbackOnly = isLoopbackHost(config.host);

  function authorized(req: IncomingMessage): boolean {
    const match = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(req.headers.authorization ?? '');
    if (!match || match[1].length > 4096) return false;
    return timingSafeEqual(digest(match[1]), expectedToken);
  }

  // Null when Host and Origin are trusted, else [code, message].
  function rebindingRefusal(req: IncomingMessage): [string, string] | null {
    const host = (req.headers.host ?? '').trim().toLowerCase();
    if (loopbackOnly && !isLoopbackHost(host.replace(/:\d+$/, ''))) {
      return ['host_not_allowed', 'The request did not arrive on a loopback host.'];
    }
    const origin = req.headers.origin;
    if (origin === undefined) return null;
    if (isLoopbackHost(host.replace(/:\d+$/, '')) && origin.trim().toLowerCase() === `http://${host}`) return null;
    return ['origin_not_allowed', 'Cross-origin requests are not accepted.'];
  }

  async function handleMessage(message: unknown): Promise<{ status: number; body?: unknown; headers?: Record<string, string> }> {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      return { status: 400, body: rpcError(null, JSON_RPC.invalidRequest, 'Invalid Request') };
    }
    const { jsonrpc, id, method, params } = message as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
    const hasId = typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id));
    if (jsonrpc !== '2.0' || (id !== undefined && !hasId)) return { status: 400, body: rpcError(null, JSON_RPC.invalidRequest, 'Invalid Request') };
    if (typeof method !== 'string') {
      // A response to a server request; this server sends none.
      return hasId ? { status: 202 } : { status: 400, body: rpcError(null, JSON_RPC.invalidRequest, 'Invalid Request') };
    }
    if (!hasId) return { status: 202 };
    const requestId = id as JsonRpcId;
    const p = (params && typeof params === 'object' && !Array.isArray(params) ? params : {}) as Record<string, unknown>;
    switch (method) {
      case 'initialize':
        return {
          status: 200,
          body: {
            jsonrpc: '2.0',
            id: requestId,
            result: {
              protocolVersion: negotiateProtocolVersion(p.protocolVersion),
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: 'botmancers', title: 'Botmancers', version },
              instructions: MCP_INSTRUCTIONS,
            },
          },
        };
      case 'ping':
        return { status: 200, body: { jsonrpc: '2.0', id: requestId, result: {} } };
      case 'tools/list':
        return { status: 200, body: { jsonrpc: '2.0', id: requestId, result: { tools: contract.tools } } };
      case 'tools/call': {
        const name = p.name;
        if (typeof name !== 'string' || !toolNames.has(name)) {
          return { status: 200, body: rpcError(requestId, JSON_RPC.invalidParams, `Unknown tool: ${typeof name === 'string' ? name.slice(0, 100) : String(name)}`) };
        }
        try {
          const answer = await upstream.send({ jsonrpc: '2.0', id: requestId, method, params: p });
          return { status: 200, body: answer };
        } catch (error) {
          if (!(error instanceof UpstreamError)) throw error;
          logger.error(`botmancers: tools/call ${name} failed: ${error.message}`);
          if (error.kind === 'rate_limited') {
            return {
              status: 429,
              body: { error: { code: 'rate_limited', message: 'Too many tool calls; retry later.' } },
              headers: error.retryAfter ? { 'retry-after': error.retryAfter } : {},
            };
          }
          return { status: 200, body: rpcError(requestId, JSON_RPC.internalError, redact(error.message), { code: `botmancers_${error.kind}` }) };
        }
      }
      default:
        return { status: 200, body: rpcError(requestId, JSON_RPC.methodNotFound, 'Method not found') };
    }
  }

  async function handleMcpPost(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const refusal = rebindingRefusal(req);
    if (refusal) return envelope(res, 403, refusal[0], refusal[1]);
    if (!authorized(req)) {
      return envelope(res, 401, 'unauthenticated', 'Send Authorization: Bearer <BOTMANCERS_MCP_TOKEN>.', { 'www-authenticate': 'Bearer realm="botmancers"' });
    }
    const protocol = req.headers['mcp-protocol-version'];
    if (typeof protocol === 'string' && !(MCP_PROTOCOL_VERSIONS as readonly string[]).includes(protocol)) {
      return envelope(res, 400, 'unsupported_protocol_version', `Supported MCP protocol versions: ${MCP_PROTOCOL_VERSIONS.join(', ')}.`);
    }
    const accept = req.headers.accept;
    if (accept && !/application\/json|application\/\*|\*\/\*/i.test(accept)) {
      return envelope(res, 406, 'not_acceptable', 'This server answers with application/json.');
    }
    let text: string;
    try {
      text = await readBody(req);
    } catch (error) {
      if (error instanceof BodyTooLarge) {
        res.setHeader('connection', 'close');
        return envelope(res, 413, 'payload_too_large', 'The message is too large.');
      }
      throw error;
    }
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      return sendJson(res, 400, rpcError(null, JSON_RPC.parseError, 'Parse error'));
    }
    if (Array.isArray(message)) return sendJson(res, 400, rpcError(null, JSON_RPC.invalidRequest, 'Batched messages are not supported.'));
    const answer = await handleMessage(message);
    if (answer.body === undefined) {
      res.writeHead(answer.status);
      res.end();
      return;
    }
    sendJson(res, answer.status, answer.body, answer.headers);
  }

  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    const route = async () => {
      if (path === HEALTH_PATH) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return envelope(res, 405, 'method_not_allowed', 'Use GET.', { allow: 'GET, HEAD' });
        return sendJson(res, 200, { status: 'ok', contract: MCP_CONTRACT, version });
      }
      if (path === MCP_PATH) {
        if (req.method === 'POST') return handleMcpPost(req, res);
        return envelope(res, 405, 'method_not_allowed', 'This MCP endpoint accepts POST only (no server-initiated stream or session).', { allow: 'POST' });
      }
      return envelope(res, 404, 'not_found', `Not found. The MCP endpoint is POST ${MCP_PATH}.`);
    };
    route().catch(error => {
      logger.error(`botmancers: internal error: ${(error as Error).message}`);
      if (!res.headersSent) envelope(res, 500, 'internal_error', 'The request could not be processed.');
      else res.end();
    });
  });

  return {
    server,
    redact,
    upstream,
    listen: () => new Promise((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      server.once('error', onError);
      server.listen(config.port, config.host, () => {
        server.off('error', onError);
        resolve(server.address() as AddressInfo);
      });
    }),
    close: () => new Promise(resolve => {
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}
