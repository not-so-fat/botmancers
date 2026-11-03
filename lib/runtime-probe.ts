// NOT-543: local runtime capability probe, moved from the deleted Agent
// Deck CLI adapter (lib/agent-deck-run) minus the launcher check.
//
// A coding Agent is advertised only after its own local launch path is
// verified: its provider binary answers `<binary> --version`. No launcher
// CLI is involved: direct Sessions talk to the provider binary itself.
// Unverified providers stay valid registration targets but are not
// advertised. Hermes is advertised only when its gateway configuration is
// present.
import { execFile } from 'child_process';
import { AGENTS, agentTransport, type BotAgent } from './bot-definition';
import { loadHermesConfig } from './hermes';

export const CODING_PROVIDERS = ['codex', 'claude', 'cursor', 'muse'] as const;

export type CodingProvider = (typeof CODING_PROVIDERS)[number];

export class ProviderBinaryError extends Error {
  readonly code = 'invalid-provider';
  constructor(value: unknown) {
    super(`Invalid provider: ${JSON.stringify(String(value))}. Expected one of ${CODING_PROVIDERS.join('|')}.`);
  }
}

export function parseCodingProvider(value: unknown): CodingProvider {
  if (typeof value === 'string' && (CODING_PROVIDERS as readonly string[]).includes(value)) {
    return value as CodingProvider;
  }
  throw new ProviderBinaryError(value);
}

// Each provider maps to its own local binary. The cursor/muse binary
// names follow the same `<name> --version` convention as codex/claude; a
// wrong name fails closed here (binary missing, not advertised) rather
// than launching something unexpected.
const PROVIDER_PROBE_COMMANDS: Record<CodingProvider, string[]> = {
  codex: ['codex', '--version'],
  claude: ['claude', '--version'],
  cursor: ['cursor', '--version'],
  muse: ['muse', '--version'],
};

export function probeCommandFor(provider: CodingProvider | string): string[] {
  return PROVIDER_PROBE_COMMANDS[parseCodingProvider(provider)];
}

export interface RuntimeProbeOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type RuntimeProbeProcess = (argv: string[]) => Promise<RuntimeProbeOutput>;

function defaultRuntimeProbeProcess(argv: string[]): Promise<RuntimeProbeOutput> {
  const [command, ...args] = argv;
  return new Promise(resolve => {
    execFile(command, args, { maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        resolve({ stdout: '', stderr: `Command not found: ${command}`, exitCode: 127 });
        return;
      }
      resolve({
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
        exitCode: error && typeof (error as { code?: unknown }).code === 'number'
          ? (error as unknown as { code: number }).code
          : error ? 1 : 0,
      });
    });
  });
}

let runtimeProbeProcess: RuntimeProbeProcess = defaultRuntimeProbeProcess;

export function setRuntimeProbeProcess(process: RuntimeProbeProcess | null): void {
  runtimeProbeProcess = process ?? defaultRuntimeProbeProcess;
}

export function resetRuntimeProbeProcessForTests(): void {
  runtimeProbeProcess = defaultRuntimeProbeProcess;
}

export async function probeProviderBinary(provider: CodingProvider | string): Promise<boolean> {
  const argv = probeCommandFor(provider);
  try {
    const binary = await runtimeProbeProcess(argv);
    return binary.exitCode === 0;
  } catch {
    return false;
  }
}

// Only launch paths whose probe is ready are advertised. Unverified
// providers remain valid registration targets but are listed here only
// after verification.
export async function listAvailableProviders(): Promise<CodingProvider[]> {
  const available: CodingProvider[] = [];
  for (const provider of CODING_PROVIDERS) {
    if (await probeProviderBinary(provider)) available.push(provider);
  }
  return available;
}

let hermesAdapterProbe: () => boolean = () => loadHermesConfig() !== null;

export function setHermesAdapterProbe(probe: (() => boolean) | null): void {
  hermesAdapterProbe = probe ?? (() => loadHermesConfig() !== null);
}

export async function probeAgent(agent: BotAgent): Promise<boolean> {
  if (agentTransport(agent) === 'hermes-gateway') {
    try {
      return hermesAdapterProbe();
    } catch {
      return false;
    }
  }
  return probeProviderBinary(agent);
}

export async function listAvailableAgents(): Promise<BotAgent[]> {
  const available: BotAgent[] = [];
  for (const agent of AGENTS) {
    if (await probeAgent(agent)) available.push(agent);
  }
  return available;
}
