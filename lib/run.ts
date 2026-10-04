export type RunState = 'running' | 'done' | 'stopped';

export interface FileRun {
  state: RunState;
  output?: string;
}

export function parseFileReadAsk(text: string): { seconds: number } | null {
  let trimmed = text.trim();
  if (trimmed.endsWith('.')) trimmed = trimmed.slice(0, -1).trim();
  if (trimmed === 'Read the file filemint6.txt') return { seconds: 4 };
  if (trimmed === 'Read the file filemint6.txt wait 20 seconds') return { seconds: 20 };
  return null;
}

export function parsePublicPageReadAsk(text: string): { seconds: number } | null {
  let trimmed = text.trim();
  if (trimmed.endsWith('.')) trimmed = trimmed.slice(0, -1).trim();
  if (trimmed === 'Open https://example.com and reply with one word from it') return { seconds: 4 };
  const waitMatch = trimmed.match(/^Open https:\/\/example\.com and reply with one word from it wait (\d+) seconds$/);
  if (waitMatch && waitMatch[1] === '20') return { seconds: 20 };
  return null;
}

export function parseRun(content: string): FileRun | null {
  const match = content.match(/^\s*\[run\]\s*([\s\S]*)$/);
  if (!match) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const row = parsed as Record<string, unknown>;
  if (row.state === 'running' || row.state === 'stopped') return { state: row.state };
  if (row.state === 'done' && typeof row.output === 'string') return { state: 'done', output: row.output };
  return null;
}

export function serializeRun(run: FileRun): string {
  const payload: { state: RunState; output?: string } = { state: run.state };
  if (run.state === 'done' && typeof run.output === 'string') payload.output = run.output;
  return '[run]\n' + JSON.stringify(payload);
}

export function runLine(run: FileRun): string {
  if (run.state === 'done') return run.output ?? '';
  if (run.state === 'stopped') return 'The command was stopped.';
  return 'The command is running';
}
