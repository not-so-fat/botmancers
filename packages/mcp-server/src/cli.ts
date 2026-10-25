#!/usr/bin/env node
// The `botmancers` command.
//
//   botmancers [options]        the MCP bridge only (unchanged since 0.1.0)
//   botmancers mcp [options]    the same, explicitly
//   botmancers setup|start|stop|status|doctor|open
//                               the full product: UI, API, core engine, and
//                               bridge under one supervisor (./product)
//   botmancers install|upgrade  the managed install and its updates (./upgrade)
//
// Bridge mode: validate configuration, check that Botmancers is reachable
// and accepts the service token, then serve the MCP bridge until a signal.
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
import { ConfigError, ENV, HELP, isLoopbackHost, parseCli } from './config.js';
import { packageVersion } from './contract.js';
import { createRedactor } from './redact.js';
import { HEALTH_PATH, MCP_PATH, createBridge } from './server.js';
import { UpstreamError } from './upstream.js';
import { PRODUCT_EXIT, UsageError, doctor, open, parseStartArgs, productContext, start, status, stop } from './product.js';
import { SetupError, runSetup } from './setup.js';
import { ClientUsageError, mcpTarget, parseSetupArgs, setupClients } from './clients.js';
import { DISABLE_AUTOUPDATER_ENV, runUpdateCheck, scheduleAutoUpdate } from './managed.js';
import { runInstall, runUpgrade } from './upgrade.js';

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

export const PRODUCT_COMMANDS = ['setup', 'start', 'stop', 'status', 'doctor', 'open'] as const;
export const INSTALL_COMMANDS = ['install', 'upgrade'] as const;
// The detached auto-update worker (./managed scheduleAutoUpdate); not for people.
export const UPDATE_WORKER_COMMAND = '__update-check';

export const PRODUCT_HELP = `Usage: botmancers <command>

Run Botmancers (UI, API, core engine, and MCP bridge) from this package:

  setup                     Create BOTMANCERS_HOME (owner-only) and generate the
                            bridge credentials; prints Hermes and Agent Deck steps;
                            refreshes the clients set up with --client
  setup --client codex|cursor|claude [--remove]
                            Connect that client to the MCP bridge and install the
                            optional botmancers-collaboration skill (or remove both);
                            files you edited are never overwritten
  start [--daemon] [--open] Start the UI/core on 127.0.0.1:3333 and the MCP bridge
                            on 127.0.0.1:3332 under one supervisor
  stop                      Stop the supervisor, core, and bridge
  status                    Report healthy / degraded / stopped, versions, endpoints
  doctor                    Check the installation, home, ports, Hermes, Agent Deck
  open                      Open the UI in a browser
  mcp [options]             Run only the MCP bridge (same as bare \`botmancers\`)
  install [--to VERSION]    Managed install into ~/.botmancers/versions with the
                            ~/.local/bin/botmancers launcher (--help for options)
  upgrade [--check] [--to VERSION] [--yes]
                            Update this installation (managed or npm-global)

Managed installs update themselves: at most one npm check a day, a background
download, activation at the next \`botmancers start\` once nothing is running.
${DISABLE_AUTOUPDATER_ENV}=1 turns that off; \`botmancers upgrade\` still works.

Environment: BOTMANCERS_HOME (default ~/.botmancers), BOTMANCERS_UI_PORT,
BOTMANCERS_MCP_PORT. Variables exported in your shell (HERMES_*, BOTMANCERS_DB_PATH,
...) take precedence over <home>/config/core.env.

Exit codes: 0 ok, 1 degraded or check failed, 2 usage, 3 not running,
6 port in use, 7 core or bridge failed to start, 8 packaged app incomplete,
9 home not writable, 10 not set up (run botmancers setup), 11 the client is not
installed, 12 client files conflict (setup --client changed nothing).
`;

// Product commands (./product). Resolves when the command finishes; a
// foreground `start` resolves only after the product stops.
export async function productMain(command: typeof PRODUCT_COMMANDS[number], argv: string[], env: NodeJS.ProcessEnv, io: CliIo = processIo): Promise<number> {
  if (argv.includes('-h') || argv.includes('--help')) {
    io.stdout(PRODUCT_HELP);
    return PRODUCT_EXIT.ok;
  }
  try {
    const ctx = productContext(env, io);
    // The running supervisor schedules its own checks; `start` reaches it.
    if (command !== 'start') scheduleAutoUpdate(env);
    if (command !== 'start' && command !== 'setup' && argv.length) throw new UsageError(`${command} takes no arguments.`);
    switch (command) {
      case 'setup': {
        let options;
        try {
          options = parseSetupArgs(argv);
        } catch (error) {
          if (error instanceof ClientUsageError) throw new UsageError(error.message);
          throw error;
        }
        if (!options.remove) {
          const result = runSetup(ctx.paths, { ui: ctx.uiPort, mcp: ctx.mcpPort });
          ctx.io.stdout(`${result.lines.join('\n')}\n`);
        }
        const outcomes = setupClients(options, ctx.env, ctx.paths, mcpTarget(ctx.paths, ctx.mcpPort), ctx.version);
        for (const outcome of outcomes) (outcome.ok ? ctx.io.stdout : ctx.io.stderr)(`${options.remove ? '' : '\n'}${outcome.lines.join('\n')}\n`);
        // Plain setup only refreshes; its own job (the home) already succeeded.
        if (!options.clients.length) return PRODUCT_EXIT.ok;
        if (outcomes.some(outcome => outcome.kind === 'conflict')) return PRODUCT_EXIT.clientConflict;
        if (outcomes.some(outcome => outcome.kind === 'missing-client')) return PRODUCT_EXIT.clientMissing;
        return PRODUCT_EXIT.ok;
      }
      case 'start': return await start(ctx, parseStartArgs(argv));
      case 'stop': return await stop(ctx);
      case 'status': return await status(ctx);
      case 'doctor': return await doctor(ctx);
      case 'open': return await open(ctx);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`botmancers ${command}: ${error.message} Run botmancers ${command} --help.\n`);
      return PRODUCT_EXIT.usage;
    }
    if (error instanceof SetupError) {
      io.stderr(`botmancers setup: ${error.message}\n`);
      return PRODUCT_EXIT.home;
    }
    throw error;
  }
}

// Routes product commands and `mcp`; anything else is bridge mode, exactly
// as before the product commands existed.
export async function main(argv: string[], env: NodeJS.ProcessEnv, io: CliIo = processIo): Promise<number | 'serving'> {
  const [first, ...rest] = argv;
  if (first === 'mcp') return bridgeMain(rest, env, io);
  if (first === 'install') return runInstall(rest, env, io);
  if (first === 'upgrade') return runUpgrade(rest, env, io);
  if (first === UPDATE_WORKER_COMMAND) {
    await runUpdateCheck(env);
    return EXIT.ok;
  }
  if ((PRODUCT_COMMANDS as readonly string[]).includes(first)) return productMain(first as typeof PRODUCT_COMMANDS[number], rest, env, io);
  return bridgeMain(argv, env, io);
}

export async function bridgeMain(argv: string[], env: NodeJS.ProcessEnv, io: CliIo = processIo): Promise<number | 'serving'> {
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

  // The handlers go in before the listening line: a supervisor or test that
  // signals the bridge as soon as it reads that line must never beat them, or
  // the default action kills the process instead of a clean exit 0.
  const stop = (signal: string) => {
    err(`botmancers: ${signal} received, shutting down.`);
    bridge.close().then(() => process.exit(EXIT.ok));
  };
  process.once('SIGINT', () => stop('SIGINT'));
  process.once('SIGTERM', () => stop('SIGTERM'));

  const shown = address.family === 'IPv6' ? `[${address.address}]` : address.address;
  err(`botmancers ${packageVersion()}: MCP bridge listening on http://${shown}:${address.port}${MCP_PATH} (health: ${HEALTH_PATH}) -> ${config.botmancersUrl}`);
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
      if (outcome !== 'serving') {
        process.exitCode = outcome;
        // A finished product command must not linger on open handles.
        if (process.argv[2] && ([...PRODUCT_COMMANDS, ...INSTALL_COMMANDS, UPDATE_WORKER_COMMAND] as readonly string[]).includes(process.argv[2])) process.exit(outcome);
      }
    },
    error => {
      const redact = createRedactor([process.env[ENV.serviceToken]?.trim(), process.env[ENV.mcpToken]?.trim()]);
      process.stderr.write(`botmancers: unexpected error: ${redact((error as Error)?.message ?? String(error))}\n`);
      process.exitCode = 1;
    },
  );
}
