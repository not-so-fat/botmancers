// NOT-517: how a launch-bound session context (lib/session-context) reaches
// a Claude Code or Codex launch. No database and no secret store here: the
// providers (lib/claude-session-provider, lib/codex-session-provider) build
// their launch arguments with these, from the { token, url } their
// SessionContextMinter handed them (lib/session-provider).
//
// None of these puts the secret in argv, a file, or model-visible text:
//
//   Claude Code   a per-turn 0600 --mcp-config whose header is an ${ENV}
//                 reference; the value is in the turn process's environment
//   Codex app     config.mcp_servers on thread/start or the first
//                 thread/resume, sent over the app-server's stdio protocol
//   codex exec    -c overrides naming the URL and the environment variable
//                 holding the header value (env_http_headers)

export const SESSION_CONTEXT_HEADER = 'Botmancers-Session-Context';
// The environment variable a Claude turn's --mcp-config header references.
export const SESSION_CONTEXT_ENV = 'BOTMANCERS_SESSION_CONTEXT';
// The environment variable a codex exec run's env_http_headers names. Its
// name matches Codex's default *TOKEN* shell-environment exclusion, so the
// model's shell commands never inherit it.
export const SESSION_CONTEXT_EXEC_ENV = 'BOTMANCERS_SESSION_CONTEXT_TOKEN';
// The MCP server name in every launch config, and the one tool it allows.
export const SESSION_CONTEXT_MCP_SERVER = 'botmancers';
export const SHARE_CURRENT_TOOL = 'botmancers_share_current_session';
export const SHARE_CURRENT_CLAUDE_TOOL = `mcp__${SESSION_CONTEXT_MCP_SERVER}__${SHARE_CURRENT_TOOL}`;

// A launch Botmancers did not give a context inherits none: an ambient
// value in Botmancers' own environment is never passed on.
export function withoutSessionContextEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = {} as NodeJS.ProcessEnv;
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && key !== SESSION_CONTEXT_ENV && key !== SESSION_CONTEXT_EXEC_ENV) out[key] = value;
  }
  return out;
}

// Claude Code: the per-turn --mcp-config document. The 0600 file holds no
// secret: Claude Code expands the header from the turn's environment.
export function claudeMcpConfig(url: string): Record<string, unknown> {
  return {
    mcpServers: {
      [SESSION_CONTEXT_MCP_SERVER]: { type: 'http', url, headers: { [SESSION_CONTEXT_HEADER]: `\${${SESSION_CONTEXT_ENV}}` } },
    },
  };
}

// Codex app-server: the thread/start or first thread/resume config.
export function codexThreadMcpConfig(minted: { token: string; url: string }): Record<string, unknown> {
  return { mcp_servers: { [SESSION_CONTEXT_MCP_SERVER]: { url: minted.url, http_headers: { [SESSION_CONTEXT_HEADER]: minted.token } } } };
}

// codex exec: the -c overrides (the URL and an environment variable name;
// the value itself is in the run's environment).
export function codexExecMcpArgs(minted: { url: string }): string[] {
  const key = `mcp_servers.${SESSION_CONTEXT_MCP_SERVER}`;
  return [
    '-c', `${key}.url=${JSON.stringify(minted.url)}`,
    '-c', `${key}.env_http_headers={ ${JSON.stringify(SESSION_CONTEXT_HEADER)} = ${JSON.stringify(SESSION_CONTEXT_EXEC_ENV)} }`,
  ];
}
