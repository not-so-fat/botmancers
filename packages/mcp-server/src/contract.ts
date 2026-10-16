// The botmancers.mcp.v1 tool contract, as captured by the Botmancers app in
// docs/contracts/mcp-bridge-v1.tools.json and shipped here as a versioned
// schema file. The bridge serves tools/list from it and forwards only these
// tool names to Botmancers; it never alters the contract.
import { readFileSync } from 'node:fs';

export const MCP_CONTRACT = 'botmancers.mcp.v1';

// Newest first; an unknown client version is answered with the newest.
// Same list as the Botmancers app's /api/v0/mcp endpoint.
export const MCP_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'] as const;

export const MCP_INSTRUCTIONS = 'Botmancers bridge (botmancers.mcp.v1). Start a task with botmancers_start_task, then poll botmancers_get_request '
  + 'until terminal and read botmancers_get_conversation; it stays active while the coordinator\'s follow-up work is open.';

export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

export interface ToolContract {
  contract: string;
  tools: McpTool[];
}

export const TOOL_SCHEMA_URL = new URL('../schemas/botmancers.mcp.v1.tools.json', import.meta.url);

export function loadToolContract(): ToolContract {
  const parsed = JSON.parse(readFileSync(TOOL_SCHEMA_URL, 'utf8')) as ToolContract;
  if (parsed.contract !== MCP_CONTRACT || !Array.isArray(parsed.tools)) {
    throw new Error(`The bundled tool schema is not ${MCP_CONTRACT}; reinstall the botmancers package.`);
  }
  return parsed;
}

export function negotiateProtocolVersion(requested: unknown): string {
  return typeof requested === 'string' && (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
    ? requested
    : MCP_PROTOCOL_VERSIONS[0];
}

export const PACKAGE_JSON_URL = new URL('../package.json', import.meta.url);

export function packageVersion(): string {
  return (JSON.parse(readFileSync(PACKAGE_JSON_URL, 'utf8')) as { version: string }).version;
}
