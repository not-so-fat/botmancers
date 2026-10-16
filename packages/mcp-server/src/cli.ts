#!/usr/bin/env node
// `npx botmancers`: validate configuration, check that Botmancers is reachable
// and accepts the service token, then serve the MCP bridge until a signal.
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
import { ConfigError, ENV, HELP, isLoopbackHost, parseCli } from './config.js';
import { packageVersion } from './contract.js';
import { createRedactor } from './redact.js';
import { HEALTH_PATH, MCP_PATH, createBridge } from './server.js';
import { UpstreamError } from './upstream.js';

export const EXIT = { ok: 0, config: 2, listen: 3, unavailable: 4, credentials: 5 } as const;

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const processIo: CliIo = {
  stdout: text => process.stdout.write(text),
  stderr: text => process.stderr.write(text),
};

function urlHost(url: string): string {
  return new URL(url).hostname;
}

export async function main(argv: string[], env: NodeJS.ProcessEnv, io: CliIo = processIo): Promise<number | 'serving'> {
  // Redact whatever secrets the environment holds before anything is printed.
  const redact = createRedactor([env[ENV.serviceToken]?.trim(), env[ENV.mcpToken]?.trim()]);
  const err = (line: string) => io.stderr(`${redact(line)}\n`);

  let command;
  try {
    command = parseCli(argv, env);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    err('botmancers: configuration error:');
    for (const problem of error.problems) err(`  - ${problem}`);
    err('Run botmancers --help for all options.');
    return EXIT.config;
  }
  if (command.kind === 'help') {
    io.stdout(HELP);
    return EXIT.ok;
  }
  if (command.kind === 'version') {
    io.stdout(`${packageVersion()}\n`);
    return EXIT.ok;
  }

  const { config } = command;
  const bridge = createBridge({ config, logger: { info: err, error: err } });

  if (!isLoopbackHost(config.host)) {
    err(`botmancers: warning: binding ${config.host}, not loopback. Expose the bridge only on a private network or behind an HTTPS (TLS-terminating) proxy.`);
  }
  if (config.botmancersUrl.startsWith('http://') && !isLoopbackHost(urlHost(config.botmancersUrl))) {
    err(`botmancers: warning: ${ENV.url} uses plain http:// to a non-loopback host; the service token is sent unencrypted. Use https://.`);
  }

  try {
    await bridge.upstream.preflight();
  } catch (error) {
    if (!(error instanceof UpstreamError)) throw error;
    err(`botmancers: ${error.message}`);
    return error.kind === 'unauthorized' || error.kind === 'unconfigured' ? EXIT.credentials : EXIT.unavailable;
  }

  let address;
  try {
    address = await bridge.listen();
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'EADDRINUSE') {
      err(`botmancers: port ${config.port} on ${config.host} is already in use. Stop the other process or choose another port with --port or ${ENV.port}.`);
    } else if (code === 'EADDRNOTAVAIL') {
      err(`botmancers: cannot bind ${config.host}: no such local address. Check --host or ${ENV.host}.`);
    } else if (code === 'EACCES') {
      err(`botmancers: permission denied binding ${config.host}:${config.port}. Use a port above 1023.`);
    } else {
      err(`botmancers: cannot listen on ${config.host}:${config.port} (${code ?? (error as Error).message}).`);
    }
    return EXIT.listen;
  }

  const shown = address.family === 'IPv6' ? `[${address.address}]` : address.address;
  err(`botmancers ${packageVersion()}: MCP bridge listening on http://${shown}:${address.port}${MCP_PATH} (health: ${HEALTH_PATH}) -> ${config.botmancersUrl}`);

  const stop = (signal: string) => {
    err(`botmancers: ${signal} received, shutting down.`);
    bridge.close().then(() => process.exit(EXIT.ok));
  };
  process.once('SIGINT', () => stop('SIGINT'));
  process.once('SIGTERM', () => stop('SIGTERM'));
  return 'serving';
}

function invokedDirectly(): boolean {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main(process.argv.slice(2), process.env).then(
    outcome => {
      if (outcome !== 'serving') process.exitCode = outcome;
    },
    error => {
      const redact = createRedactor([process.env[ENV.serviceToken]?.trim(), process.env[ENV.mcpToken]?.trim()]);
      process.stderr.write(`botmancers: unexpected error: ${redact((error as Error)?.message ?? String(error))}\n`);
      process.exitCode = 1;
    },
  );
}
