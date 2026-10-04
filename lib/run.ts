export type RunState = 'running' | 'done' | 'stopped';

export interface FileRun {
  state: RunState;
  output?: string;
  html?: string;
}

export function parseFileReadAsk(text: string): { seconds: number } | null {
  let trimmed = text.trim();
  if (trimmed.endsWith('.')) trimmed = trimmed.slice(0, -1).trim();
  if (trimmed === 'Read the file filemint6.txt') return { seconds: 4 };
  if (trimmed === 'Read the file filemint6.txt wait 20 seconds') return { seconds: 20 };
  return null;
}

export function parsePublicPageReadAsk(text: string): { seconds: number; url?: string } | null {
  let trimmed = text.trim();
  if (trimmed.endsWith('.')) trimmed = trimmed.slice(0, -1).trim();
  
  // Legacy one-word extraction from example.com
  if (trimmed === 'Open https://example.com and reply with one word from it') return { seconds: 4 };
  const legacyWaitMatch = trimmed.match(/^Open https:\/\/example\.com and reply with one word from it wait (\d+) seconds$/);
  if (legacyWaitMatch && legacyWaitMatch[1] === '20') return { seconds: 20 };
  
  // New page title extraction from any https URL
  const titleMatch = trimmed.match(/^Open (https:\/\/[^\s]+) and reply with the page title$/);
  if (titleMatch) {
    const url = titleMatch[1];
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:') return null;
      if (parsed.username || parsed.password) return null;
      return { seconds: 4, url };
    } catch {
      return null;
    }
  }
  
  const titleWaitMatch = trimmed.match(/^Open (https:\/\/[^\s]+) and reply with the page title wait (\d+) seconds$/);
  if (titleWaitMatch && titleWaitMatch[2] === '20') {
    const url = titleWaitMatch[1];
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:') return null;
      if (parsed.username || parsed.password) return null;
      return { seconds: 20, url };
    } catch {
      return null;
    }
  }
  
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
  if (row.state === 'running' || row.state === 'stopped') {
    return {
      state: row.state,
      html: typeof row.html === 'string' ? row.html : undefined
    };
  }
  if (row.state === 'done' && typeof row.output === 'string') {
    return {
      state: 'done',
      output: row.output,
      html: typeof row.html === 'string' ? row.html : undefined
    };
  }
  return null;
}

export function serializeRun(run: FileRun): string {
  const payload: { state: RunState; output?: string; html?: string } = { state: run.state };
  if (run.state === 'done' && typeof run.output === 'string') payload.output = run.output;
  if (typeof run.html === 'string') payload.html = run.html;
  return '[run]\n' + JSON.stringify(payload);
}

export function runLine(run: FileRun): string {
  if (run.state === 'done') return run.output ?? '';
  if (run.state === 'stopped') return 'The command was stopped.';
  return 'The command is running';
}
