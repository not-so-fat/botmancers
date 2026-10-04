import { spawn } from 'child_process';

interface JsonRpc {
  jsonrpc: '2.0';
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message?: string };
}

export interface McpInvocation {
  name: string;
  args: Record<string, unknown>;
  text: string;
}

export function parseToolInvocation(userText: string, toolNames: string[]): { name: string; args: Record<string, unknown> } | null {
  const jsonMatch = userText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  let args: Record<string, unknown>;
  try {
    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    args = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const ordered = [...toolNames].sort((a, b) => b.length - a.length);
  for (const name of ordered) {
    const at = userText.indexOf(name);
    if (at < 0) continue;
    const before = at === 0 ? '' : userText[at - 1];
    const after = userText[at + name.length] || '';
    if (before && /[A-Za-z0-9_]/.test(before)) continue;
    if (after && /[A-Za-z0-9_]/.test(after)) continue;
    return { name, args };
  }
  return null;
}

function frame(msg: JsonRpc): string {
  const json = JSON.stringify(msg);
  return `Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`;
}

export async function mcpTurn(
  command: string,
  args: string[],
  userText: string
): Promise<{ tools: string[]; invocation?: McpInvocation } | null> {
  if (!userText.includes('{')) return null;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = Buffer.alloc(0);
    let nextId = 1;
    const pending = new Map<number, (msg: JsonRpc) => void>();
    let settled = false;

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      reject(error);
    };

    const finish = (value: { tools: string[]; invocation?: McpInvocation } | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolve(value);
    };

    const timer = setTimeout(() => fail(new Error('MCP server timed out')), 8000);

    child.stdin.on('error', () => undefined);
    child.on('error', (error) => fail(error));
    child.on('exit', (code) => {
      if (!settled) fail(new Error(`MCP server exited ${code}`));
    });

    const send = (msg: JsonRpc) => {
      child.stdin.write(frame(msg));
    };

    const request = (method: string, params?: unknown) => {
      const id = nextId++;
      return new Promise<JsonRpc>((res, rej) => {
        pending.set(id, (msg) => {
          if (msg.error) rej(new Error(msg.error.message || 'MCP error'));
          else res(msg);
        });
        send({ jsonrpc: '2.0', id, method, params });
      });
    };

    child.stdout.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      while (true) {
        const headerEnd = buf.indexOf('\r\n\r\n');
        if (headerEnd < 0) break;
        const header = buf.slice(0, headerEnd).toString('utf8');
        const match = header.match(/Content-Length:\s*(\d+)/i);
        if (!match) {
          fail(new Error('MCP response missing Content-Length'));
          return;
        }
        const len = Number(match[1]);
        const start = headerEnd + 4;
        if (buf.length < start + len) break;
        const body = buf.slice(start, start + len).toString('utf8');
        buf = buf.slice(start + len);
        let msg: JsonRpc;
        try {
          msg = JSON.parse(body) as JsonRpc;
        } catch (error) {
          fail(error instanceof Error ? error : new Error('Bad MCP JSON'));
          return;
        }
        if (typeof msg.id === 'number' && pending.has(msg.id)) {
          const done = pending.get(msg.id);
          pending.delete(msg.id);
          if (done) done(msg);
        }
      }
    });

    void (async () => {
      try {
        await request('initialize', {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'botmancers', version: '0.1.0' },
        });
        send({ jsonrpc: '2.0', method: 'notifications/initialized' });
        const listed = await request('tools/list');
        const result = listed.result as { tools?: { name: string }[] } | undefined;
        const tools = (result?.tools || []).map(tool => tool.name).filter(Boolean);
        const wanted = parseToolInvocation(userText, tools);
        if (!wanted) {
          finish({ tools });
          return;
        }
        const called = await request('tools/call', { name: wanted.name, arguments: wanted.args });
        const callResult = called.result as { content?: { text?: string }[]; isError?: boolean } | undefined;
        const text = (callResult?.content || []).map(part => part.text || '').join('');
        if (callResult?.isError) {
          fail(new Error(text || 'MCP tool error'));
          return;
        }
        finish({
          tools,
          invocation: { name: wanted.name, args: wanted.args, text },
        });
      } catch (error) {
        fail(error instanceof Error ? error : new Error('MCP failed'));
      }
    })();
  });
}
