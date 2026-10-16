// Bridge configuration: environment variables, with command-line flags for
// the non-secret settings. Secrets are accepted only from the environment
// (flags are visible to every local user through the process list).
import { isIP } from 'node:net';

export const ENV = {
  url: 'BOTMANCERS_URL',
  serviceToken: 'BOTMANCERS_SERVICE_TOKEN',
  mcpToken: 'BOTMANCERS_MCP_TOKEN',
  host: 'BOTMANCERS_MCP_HOST',
  port: 'BOTMANCERS_MCP_PORT',
} as const;

export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 43124;
export const MIN_MCP_TOKEN_LENGTH = 16;

export interface BridgeConfig {
  // Botmancers base URL, normalized: no trailing slash, no query or fragment.
  botmancersUrl: string;
  serviceToken: string;
  mcpToken: string;
  host: string;
  port: number;
}

export type CliCommand =
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'serve'; config: BridgeConfig };

export class ConfigError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(problems.join('\n'));
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

const FLAGS: Record<string, keyof typeof ENV> = {
  '--botmancers-url': 'url',
  '--host': 'host',
  '--port': 'port',
};

const SECRET_FLAGS = ['--service-token', '--mcp-token', '--token'];

export function isLoopbackHost(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, '').toLowerCase();
  return bare === 'localhost' || bare === '::1' || /^127(?:\.\d{1,3}){3}$/.test(bare);
}

function validToken(value: string): boolean {
  return /^[\x21-\x7e]+$/.test(value) && value.length <= 4096;
}

export function parseBotmancersUrl(raw: string): { url?: string; problem?: string } {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    // Never echo the value: an operator may have pasted a token into it.
    return { problem: `${ENV.url} is not a valid absolute URL. Expected something like http://127.0.0.1:43123.` };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { problem: `${ENV.url} must use http:// or https:// (got ${parsed.protocol}//).` };
  }
  if (parsed.username || parsed.password) {
    return { problem: `${ENV.url} must not contain credentials; put the service token in ${ENV.serviceToken} instead.` };
  }
  if (parsed.search || parsed.hash) {
    return { problem: `${ENV.url} must not contain a query string or fragment.` };
  }
  return { url: `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}` };
}

function parsePort(raw: string, source: string): { port?: number; problem?: string } {
  const trimmed = raw.trim();
  const port = /^\d+$/.test(trimmed) ? Number(trimmed) : NaN;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    return { problem: `${source} must be an integer port between 0 and 65535 (got ${JSON.stringify(trimmed.slice(0, 20))}).` };
  }
  return { port };
}

function parseHost(raw: string, source: string): { host?: string; problem?: string } {
  const host = raw.trim();
  if (isIP(host.replace(/^\[|\]$/g, '')) || /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/.test(host)) {
    return { host: host.replace(/^\[|\]$/g, '') };
  }
  return { problem: `${source} must be an IP address or hostname to bind (default ${DEFAULT_HOST}).` };
}

// Parses argv (without node and script) and env into a command. Throws
// ConfigError listing every problem, none of which contains a secret.
export function parseCli(argv: string[], env: NodeJS.ProcessEnv): CliCommand {
  const fromFlags: Partial<Record<keyof typeof ENV, string>> = {};
  const problems: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') return { kind: 'help' };
    if (arg === '-v' || arg === '--version') return { kind: 'version' };
    const eq = arg.indexOf('=');
    const name = eq > 0 ? arg.slice(0, eq) : arg;
    if (SECRET_FLAGS.includes(name)) {
      problems.push(`${name} is not accepted: pass secrets only through ${ENV.serviceToken} and ${ENV.mcpToken} environment variables.`);
      if (eq < 0) i++;
      continue;
    }
    const key = FLAGS[name];
    if (!key) {
      problems.push(`Unknown argument ${JSON.stringify(name.slice(0, 40))}. Run botmancers --help for usage.`);
      continue;
    }
    const value = eq > 0 ? arg.slice(eq + 1) : argv[++i];
    if (value === undefined || value === '') {
      problems.push(`${name} needs a value.`);
      continue;
    }
    fromFlags[key] = value;
  }

  const pick = (key: keyof typeof ENV): string | undefined => {
    const value = fromFlags[key] ?? env[ENV[key]];
    return value === undefined || value.trim() === '' ? undefined : value.trim();
  };

  const rawUrl = pick('url');
  let botmancersUrl = '';
  if (!rawUrl) {
    problems.push(`${ENV.url} is required: the Botmancers base URL, for example http://127.0.0.1:43123 (or pass --botmancers-url).`);
  } else {
    const { url, problem } = parseBotmancersUrl(rawUrl);
    if (problem) problems.push(problem);
    else botmancersUrl = url!;
  }

  const serviceToken = env[ENV.serviceToken]?.trim() ?? '';
  if (!serviceToken) {
    problems.push(`${ENV.serviceToken} is required: the bearer token whose SHA-256 digest Botmancers lists in BOTMANCERS_SERVICE_TOKENS.`);
  } else if (!validToken(serviceToken)) {
    problems.push(`${ENV.serviceToken} must be a single printable token without spaces.`);
  }

  const mcpToken = env[ENV.mcpToken]?.trim() ?? '';
  if (!mcpToken) {
    problems.push(`${ENV.mcpToken} is required: the bearer token MCP clients must send to this bridge (generate one with: openssl rand -hex 32).`);
  } else if (!validToken(mcpToken) || mcpToken.length < MIN_MCP_TOKEN_LENGTH) {
    problems.push(`${ENV.mcpToken} must be a single printable token of at least ${MIN_MCP_TOKEN_LENGTH} characters without spaces.`);
  } else if (mcpToken === serviceToken) {
    problems.push(`${ENV.mcpToken} must differ from ${ENV.serviceToken}: MCP clients must not hold the Botmancers service token.`);
  }

  let host = DEFAULT_HOST;
  const rawHost = pick('host');
  if (rawHost) {
    const parsed = parseHost(rawHost, fromFlags.host ? '--host' : ENV.host);
    if (parsed.problem) problems.push(parsed.problem);
    else host = parsed.host!;
  }

  let port = DEFAULT_PORT;
  const rawPort = pick('port');
  if (rawPort) {
    const parsed = parsePort(rawPort, fromFlags.port ? '--port' : ENV.port);
    if (parsed.problem) problems.push(parsed.problem);
    else port = parsed.port!;
  }

  if (problems.length) throw new ConfigError(problems);
  return { kind: 'serve', config: { botmancersUrl, serviceToken, mcpToken, host, port } };
}

export const HELP = `Usage: botmancers [options]

Run the Botmancers MCP bridge: a Streamable HTTP MCP server (contract
botmancers.mcp.v1) that forwards tool calls to a running Botmancers app.

Options:
  --botmancers-url <url>  Botmancers base URL            (env ${ENV.url}, required)
  --host <host>           Address to bind                (env ${ENV.host}, default ${DEFAULT_HOST})
  --port <port>           Port to bind, 0 for any free   (env ${ENV.port}, default ${DEFAULT_PORT})
  -h, --help              Show this help
  -v, --version           Show the package version

Secrets (environment only, never flags):
  ${ENV.serviceToken}   Bearer token this bridge sends to Botmancers (required)
  ${ENV.mcpToken}       Bearer token MCP clients must send to this bridge (required, >= ${MIN_MCP_TOKEN_LENGTH} chars)

Endpoints:
  POST /mcp       MCP Streamable HTTP (Authorization: Bearer $${ENV.mcpToken})
  GET  /healthz   Liveness (no authentication, no upstream call)

Example:
  ${ENV.url}=http://127.0.0.1:43123 \\
  ${ENV.serviceToken}=... ${ENV.mcpToken}=$(openssl rand -hex 32) \\
  npx botmancers

Exit codes: 0 stopped by signal, 2 configuration, 3 cannot listen,
4 Botmancers unreachable or incompatible, 5 credentials rejected.
`;
