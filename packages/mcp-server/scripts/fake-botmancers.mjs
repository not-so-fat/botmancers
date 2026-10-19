// A fake Botmancers app for tests and the clean-install smoke: just enough
// of POST /api/v0/mcp (service-token auth, initialize, tools/call) to drive
// the bridge. Not shipped in the package. mode 'generic' impersonates an
// unrelated MCP server; 'partial_tools' a Botmancers missing a v1 tool;
// 'v1_only' a Botmancers that serves only botmancers.mcp.v1; 'partial_v2'
// one missing two v2 tools; 'no_v2_path' one whose get_conversation lacks
// the v2 agent_id path. Any other mode serves the full bundled v2 list.
// A v2 tools/call is echoed back so a test can see it arrived unchanged.
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';

const TOOLS = JSON.parse(readFileSync(new URL('../schemas/botmancers.mcp.v2.tools.json', import.meta.url), 'utf8')).tools;
const V1_TOOLS = JSON.parse(readFileSync(new URL('../schemas/botmancers.mcp.v1.tools.json', import.meta.url), 'utf8')).tools;
export const PARTIAL_V2_MISSING = ['botmancers_send_to_session', 'botmancers_list_exchanges'];

function toolsFor(mode) {
  if (mode === 'generic') return [{ name: 'add', inputSchema: { type: 'object' } }];
  if (mode === 'partial_tools') return TOOLS.filter(tool => tool.name !== 'botmancers_start_task');
  if (mode === 'v1_only') return V1_TOOLS;
  // NOT-507: a Botmancers from before the optional pin tools.
  if (mode === 'v2_without_pins') return TOOLS.filter(tool => tool._meta?.['botmancers/optional'] !== true);
  if (mode === 'partial_v2') return TOOLS.filter(tool => !PARTIAL_V2_MISSING.includes(tool.name));
  if (mode === 'no_v2_path') return TOOLS.map(tool => (tool.name === 'botmancers_get_conversation' ? V1_TOOLS.find(v1 => v1.name === tool.name) : tool));
  return TOOLS;
}

export async function startFakeBotmancers({ serviceToken, mode = 'ok', host = '127.0.0.1' } = {}) {
  const received = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const json = (status, body, headers = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(JSON.stringify(body));
      };
      if (req.url !== '/api/v0/mcp') return json(404, { error: { code: 'not_found', message: 'Not found' } });
      if (req.method !== 'POST') return json(405, { error: { code: 'method_not_allowed', message: 'POST only' } });
      let message;
      try {
        message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return json(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      }
      received.push({ headers: req.headers, message });
      if (mode === 'unconfigured') return json(503, { error: { code: 'authentication_unavailable', message: 'No service tokens.' } });
      if (mode === 'unauthorized' || (mode !== 'generic' && req.headers.authorization !== `Bearer ${serviceToken}`)) {
        return json(401, { error: { code: 'unauthenticated', message: 'Unknown credential.' } }, { 'www-authenticate': 'Bearer realm="botmancers"' });
      }
      const { id, method, params } = message;
      if (method === 'initialize') {
        const serverInfo = mode === 'generic' ? { name: 'add', version: '0.0.1' } : { name: 'botmancers', title: 'Botmancers', version: '1.0.0' };
        return json(200, { jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo } });
      }
      if (method === 'tools/list') {
        return json(200, { jsonrpc: '2.0', id, result: { tools: toolsFor(mode) } });
      }
      if (method === 'tools/call') {
        if (mode === 'rate_limited') return json(429, { error: { code: 'rate_limited', message: 'Too many tool calls; retry later.' } }, { 'retry-after': '7' });
        if (params?.name === 'botmancers_health') {
          const structured = { contract: 'botmancers.mcp.v1', status: 'ok', principal: { kind: 'service', id: 'fake-service' }, coordinators: [{ name: 'Tank', available: true }] };
          return json(200, { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(structured) }], structuredContent: structured, isError: false } });
        }
        if (TOOLS.some(tool => tool.name === params?.name && tool._meta?.['botmancers/contract'] === 'botmancers.mcp.v2')) {
          const echoed = { contract: 'botmancers.mcp.v2', echo: params };
          return json(200, { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(echoed) }], structuredContent: echoed, isError: false } });
        }
        const structured = { contract: 'botmancers.mcp.v1', error: { code: 'request_not_found', message: 'Request not found.' } };
        return json(200, { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(structured) }], structuredContent: structured, isError: true } });
      }
      return json(200, { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
    });
  });
  await new Promise(resolve => server.listen(0, host, resolve));
  const { port } = server.address();
  return {
    url: `http://${host}:${port}`,
    port,
    received,
    close: () => new Promise(resolve => {
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}
