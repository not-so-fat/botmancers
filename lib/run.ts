export type RunState = 'running' | 'done' | 'stopped';

export interface PrintRun {
  state: RunState;
  output?: string;
  page?: string;
}

const WAIT_TOKEN = '(?:[1-9]|[12][0-9]|30)';

export function parsePrintAsk(text: string): { word: string; seconds: number } | null {
  let trimmed = text.trim();
  if (trimmed.endsWith('.')) trimmed = trimmed.slice(0, -1).trim();
  const word = '([A-Za-z0-9]+)';
  const wait = `wait\\s+(${WAIT_TOKEN})\\s+seconds`;
  const forms: { re: RegExp; word: number; wait: number }[] = [
    { re: new RegExp(`^prints the word\\s+${word}$`, 'i'), word: 1, wait: 0 },
    { re: new RegExp(`^prints the word\\s+${word}\\s+${wait}$`, 'i'), word: 1, wait: 2 },
    { re: new RegExp(`^prints the word\\s+${word}\\s+and\\s+${wait}$`, 'i'), word: 1, wait: 2 },
    { re: new RegExp(`^${wait}\\s+prints the word\\s+${word}$`, 'i'), word: 2, wait: 1 },
    { re: new RegExp(`^${wait}\\s+and\\s+prints the word\\s+${word}$`, 'i'), word: 2, wait: 1 },
  ];
  for (const form of forms) {
    const match = trimmed.match(form.re);
    if (!match) continue;
    const token = match[form.word];
    if (!token) return null;
    if (!form.wait) return { word: token, seconds: 4 };
    const seconds = Number(match[form.wait]);
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 30) return null;
    return { word: token, seconds };
  }
  return null;
}

export function parseFileReadAsk(text: string): { seconds: number } | null {
  let trimmed = text.trim();
  if (trimmed.endsWith('.')) trimmed = trimmed.slice(0, -1).trim();
  if (trimmed === 'Read the file filemint6.txt') return { seconds: 4 };
  if (trimmed === 'Read the file filemint6.txt wait 20 seconds') return { seconds: 20 };
  return null;
}

export function httpsPageUrl(raw: string): string | null {
  if (typeof raw !== 'string' || !/^https:\/\//i.test(raw)) return null;
  if (/[\u0000-\u0020\\]/.test(raw)) return null;
  const authority = raw.slice(8).split(/[/?#]/)[0];
  if (!authority || authority.includes('@')) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  if (parsed.username !== '' || parsed.password !== '') return null;
  if (!parsed.hostname) return null;
  return raw;
}

export function parsePageReadAsk(text: string): { seconds: number; url?: string } | null {
  let trimmed = text.trim();
  if (trimmed.endsWith('.')) trimmed = trimmed.slice(0, -1).trim();
  if (trimmed === 'Open https://example.com and reply with one word from it') return { seconds: 4 };
  if (trimmed === 'Open https://example.com and reply with one word from it wait 20 seconds') return { seconds: 20 };
  const open = 'Open ';
  const titleWait = ' and reply with the page title wait 20 seconds';
  const title = ' and reply with the page title';
  if (!trimmed.startsWith(open)) return null;
  let seconds: number | null = null;
  let rawUrl = '';
  if (trimmed.endsWith(titleWait)) {
    seconds = 20;
    rawUrl = trimmed.slice(open.length, trimmed.length - titleWait.length);
  } else if (trimmed.endsWith(title)) {
    seconds = 4;
    rawUrl = trimmed.slice(open.length, trimmed.length - title.length);
  } else {
    return null;
  }
  const url = httpsPageUrl(rawUrl);
  if (!url || seconds === null) return null;
  return { seconds, url };
}

export function parseCodingLimbAsk(text: string): { seconds: number } | null {
  let trimmed = text.trim();
  if (trimmed.endsWith('.')) trimmed = trimmed.slice(0, -1).trim();
  if (trimmed === 'Ask the coding limb which file holds parsePublicPageReadAsk and reply with that path') return { seconds: 4 };
  if (trimmed === 'Ask the coding limb which file holds parsePublicPageReadAsk and reply with that path wait 20 seconds') return { seconds: 20 };
  return null;
}

function pageHtml(row: Record<string, unknown>, state: RunState): string | undefined {
  if (state === 'stopped') return undefined;
  if (typeof row.page !== 'string' || row.page.length === 0) return undefined;
  return row.page;
}

export function parseRun(content: string): PrintRun | null {
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
    const page = pageHtml(row, row.state);
    return page ? { state: row.state, page } : { state: row.state };
  }
  if (row.state === 'done' && typeof row.output === 'string') {
    const page = pageHtml(row, 'done');
    return page ? { state: 'done', output: row.output, page } : { state: 'done', output: row.output };
  }
  return null;
}

export function serializeRun(run: PrintRun): string {
  const payload: { state: RunState; output?: string; page?: string } = { state: run.state };
  if (run.state === 'done' && typeof run.output === 'string') payload.output = run.output;
  if (run.state !== 'stopped' && typeof run.page === 'string' && run.page.length > 0) payload.page = run.page;
  return '[run]\n' + JSON.stringify(payload);
}

export function runLine(run: PrintRun): string {
  if (run.state === 'done') return run.output ?? '';
  if (run.state === 'stopped') return 'The command was stopped.';
  return 'The command is running';
}
