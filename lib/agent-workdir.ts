// NOT-543: per-Agent working-directory helpers, moved verbatim from the
// deleted Agent Deck settings module (lib/agent-deck-settings).
//
// Runtime-neutral: each Agent's default working directory is
// ~/.botmancers/{agentID}, expanded absolute and created on demand before
// first launch. Direct launches resolve their workspace from the Agent's
// registration (default_workspace or single selected workspace, see
// directLaunchWorkspace in ./agent-registration) and create it here;
// nothing here names a deck, server, or token.
import fs from 'fs';
import os from 'os';
import path from 'path';

function homeDirForTests(explicit?: string): string {
  if (explicit && explicit.trim()) return explicit;
  const fromEnv = (process.env.HOME ?? '').trim();
  if (fromEnv) return fromEnv;
  return os.homedir();
}

// Absolute default workdir for one Agent: ~/.botmancers/{agentID}.
export function defaultBotWorkdir(agentId: string, homeDir?: string): string {
  const id = String(agentId ?? '').trim();
  if (!id) throw new Error('defaultBotWorkdir requires a bot id.');
  const home = homeDirForTests(homeDir);
  return path.resolve(home, '.botmancers', id);
}

export function expandLeadingTilde(candidate: string, homeDir?: string): string {
  if (candidate === '~') return homeDirForTests(homeDir);
  if (candidate.startsWith('~/') || candidate.startsWith('~\\')) {
    return path.join(homeDirForTests(homeDir), candidate.slice(2));
  }
  return candidate;
}

// Stored override wins (preserved verbatim after trimming, with a
// leading ~ expanded); otherwise the absolute per-Agent default.
export function resolveBotWorkdir(botId: string, override?: string | null, homeDir?: string): string {
  const text = typeof override === 'string' ? override.trim() : '';
  if (text) return expandLeadingTilde(text, homeDir);
  return defaultBotWorkdir(botId, homeDir);
}

// Creates the resolved directory on demand. Returns the path.
export function ensureBotWorkdir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Resolves (override or default) and creates the directory immediately
// before launch. Returns the absolute-or-override path that launched.
export function resolveAndEnsureBotWorkdir(botId: string, override?: string | null, homeDir?: string): string {
  const resolved = resolveBotWorkdir(botId, override, homeDir);
  ensureBotWorkdir(resolved);
  return resolved;
}
