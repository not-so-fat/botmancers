// The Botmancers side of the bridge: JSON-RPC messages POSTed to the app's
// /api/v0/mcp endpoint with the service token. Failures are classified so
// the CLI and the MCP surface can say what to fix, without echoing secrets.
import { MCP_CONTRACT, MCP_CONTRACT_V1, MCP_PROTOCOL_VERSIONS, isOptionalTool, loadToolContract, toolContractOf } from './contract.js';

// The serverInfo.name the Botmancers app reports from initialize.
export const MCP_SERVER_NAME = 'botmancers';

export const UPSTREAM_PATH = '/api/v0/mcp';
export const UPSTREAM_TIMEOUT_MS = 30_000;

export type UpstreamFailureKind =
  | 'unreachable'      // network error or timeout
  | 'unauthorized'     // 401/403: token unknown or not a service principal
  | 'unconfigured'     // 503 authentication_unavailable: no service tokens on the server
  | 'incompatible'     // 404/405/415/400 protocol mismatch: not a Botmancers MCP endpoint
  | 'rate_limited'     // 429
  | 'error';           // any other non-2xx or unparseable body

export class UpstreamError extends Error {
  readonly kind: UpstreamFailureKind;
  readonly status: number | null;
  readonly retryAfter: string | null;
  constructor(kind: UpstreamFailureKind, message: string, status: number | null = null, retryAfter: string | null = null) {
    super(message);
    this.name = 'UpstreamError';
    this.kind = kind;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export interface UpstreamOptions {
  botmancersUrl: string;
  serviceToken: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

function errorCodeOf(body: unknown): string | null {
  const code = (body as { error?: { code?: unknown } } | null)?.error?.code;
  return typeof code === 'string' ? code.slice(0, 60) : null;
}

export function createUpstream(options: UpstreamOptions) {
  const endpoint = `${options.botmancersUrl}${UPSTREAM_PATH}`;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? UPSTREAM_TIMEOUT_MS;

  async function send(message: Record<string, unknown>): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          authorization: `Bearer ${options.serviceToken}`,
          'mcp-protocol-version': MCP_PROTOCOL_VERSIONS[0],
        },
        body: JSON.stringify(message),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
      });
    } catch (error) {
      const cause = (error as { cause?: { code?: string } }).cause?.code ?? (error as Error).name;
      throw new UpstreamError('unreachable', `Cannot reach Botmancers at ${options.botmancersUrl} (${cause}). Is the Botmancers app running, and is BOTMANCERS_URL correct?`);
    }
    const text = await response.text().catch(() => '');
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    const code = errorCodeOf(body);
    if (response.status === 401 || response.status === 403) {
      throw new UpstreamError('unauthorized',
        `Botmancers rejected the service token (HTTP ${response.status}${code ? ` ${code}` : ''}). Check that BOTMANCERS_SERVICE_TOKEN matches an entry of BOTMANCERS_SERVICE_TOKENS on the Botmancers server.`,
        response.status);
    }
    if (response.status === 503 && code === 'authentication_unavailable') {
      throw new UpstreamError('unconfigured',
        'Botmancers has no valid service tokens configured. Set BOTMANCERS_SERVICE_TOKENS on the Botmancers server (see the README).',
        response.status);
    }
    if (response.status === 429) {
      throw new UpstreamError('rate_limited', 'Botmancers rate-limited this bridge; retry later.', 429, response.headers.get('retry-after'));
    }
    if (response.status === 404 || response.status === 405 || (response.status === 400 && code === 'unsupported_protocol_version')) {
      throw new UpstreamError('incompatible',
        `Botmancers at ${options.botmancersUrl} does not serve a compatible MCP endpoint at ${UPSTREAM_PATH} (HTTP ${response.status}). Check BOTMANCERS_URL and upgrade Botmancers.`,
        response.status);
    }
    const isRpc = body && typeof body === 'object' && (body as { jsonrpc?: unknown }).jsonrpc === '2.0';
    if (!isRpc) {
      throw new UpstreamError('error',
        `Botmancers answered HTTP ${response.status}${code ? ` ${code}` : ''} without a JSON-RPC response.`,
        response.status);
    }
    return body as Record<string, unknown>;
  }

  // initialize and tools/list round trips: authenticate, then confirm the
  // endpoint is Botmancers and offers every bundled tool: all of
  // botmancers.mcp.v1 and all of botmancers.mcp.v2, including the v2
  // (agent_id) path of botmancers_get_conversation. No tool is called, so
  // preflight writes nothing and is not rate-limited.
  async function preflight(): Promise<{ serverVersion: string | null }> {
    const incompatible = (why: string) => new UpstreamError('incompatible',
      `${options.botmancersUrl}${UPSTREAM_PATH} is an MCP endpoint but not a compatible Botmancers (${why}). Check BOTMANCERS_URL and upgrade Botmancers.`);
    const init = await send({
      jsonrpc: '2.0',
      id: 'botmancers-bridge-preflight',
      method: 'initialize',
      params: { protocolVersion: MCP_PROTOCOL_VERSIONS[0], capabilities: {}, clientInfo: { name: 'botmancers-bridge', version: '0' } },
    });
    const result = init.result as { serverInfo?: { name?: unknown; version?: unknown }; capabilities?: { tools?: unknown } } | undefined;
    if (!result) throw new UpstreamError('incompatible', `Botmancers at ${options.botmancersUrl} refused MCP initialize.`);
    if (result.serverInfo?.name !== MCP_SERVER_NAME) throw incompatible(`serverInfo.name is not "${MCP_SERVER_NAME}"`);
    if (!result.capabilities?.tools || typeof result.capabilities.tools !== 'object') throw incompatible('no tools capability');

    const list = await send({ jsonrpc: '2.0', id: 'botmancers-bridge-preflight-tools', method: 'tools/list', params: {} });
    const offered = (list.result as { tools?: unknown } | undefined)?.tools;
    if (!Array.isArray(offered)) throw incompatible('tools/list returned no tools');
    const byName = new Map(offered.map(tool => [(tool as { name?: unknown } | null)?.name, tool as { inputSchema?: { properties?: Record<string, unknown> } }]));
    const bundled = loadToolContract().tools.filter(tool => !isOptionalTool(tool));
    const missing = (contract: string) => bundled.filter(tool => toolContractOf(tool) === contract && !byName.has(tool.name)).map(tool => tool.name);
    const missingV1 = missing(MCP_CONTRACT_V1);
    if (missingV1.length) throw incompatible(`missing ${MCP_CONTRACT_V1} tools: ${missingV1.join(', ')}`);
    const missingV2 = missing(MCP_CONTRACT);
    const v2Total = bundled.filter(tool => toolContractOf(tool) === MCP_CONTRACT).length;
    if (missingV2.length === v2Total) {
      throw incompatible(`it serves only ${MCP_CONTRACT_V1}; this bridge needs ${MCP_CONTRACT} (missing ${missingV2.join(', ')}). Upgrade Botmancers to a release that serves ${MCP_CONTRACT}`);
    }
    if (missingV2.length) throw incompatible(`missing ${MCP_CONTRACT} tools: ${missingV2.join(', ')}`);
    if (!byName.get('botmancers_get_conversation')?.inputSchema?.properties?.agent_id) {
      throw incompatible(`botmancers_get_conversation lacks the ${MCP_CONTRACT} agent_id path`);
    }

    const version = result.serverInfo.version;
    return { serverVersion: typeof version === 'string' ? version : null };
  }

  return { endpoint, send, preflight };
}

export type Upstream = ReturnType<typeof createUpstream>;
