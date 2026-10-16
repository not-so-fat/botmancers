// Library surface of the `botmancers` package: the botmancers.mcp.v1 MCP
// bridge. The `botmancers` binary (./cli) is the supported entry point; these
// exports let a Node program embed the same bridge.
export {
  MCP_CONTRACT,
  MCP_PROTOCOL_VERSIONS,
  TOOL_SCHEMA_URL,
  loadToolContract,
  negotiateProtocolVersion,
  packageVersion,
  type McpTool,
  type ToolContract,
} from './contract.js';
export {
  DEFAULT_HOST,
  DEFAULT_PORT,
  ENV,
  ConfigError,
  isLoopbackHost,
  parseBotmancersUrl,
  parseCli,
  type BridgeConfig,
  type CliCommand,
} from './config.js';
export { createRedactor, REDACTED, type Redactor } from './redact.js';
export { UPSTREAM_PATH, UpstreamError, createUpstream, type Upstream, type UpstreamFailureKind } from './upstream.js';
export { HEALTH_PATH, MAX_BODY_BYTES, MCP_PATH, createBridge, type Bridge, type BridgeOptions, type Logger } from './server.js';
export { EXIT, main } from './cli.js';
