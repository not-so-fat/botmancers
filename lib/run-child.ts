import { spawn, type ChildProcess } from 'child_process';
import https from 'node:https';
import fs from 'fs';
import path from 'path';
import { messages } from './db';
import { httpsPageUrl, parseRun, serializeRun } from './run';

type Live = {
  child: ChildProcess;
  stopped: boolean;
  cancelRemote?: () => void;
};

const globalRuns = globalThis as typeof globalThis & {
  __botmancerPrintRuns?: Map<string, Live>;
};

if (!globalRuns.__botmancerPrintRuns) globalRuns.__botmancerPrintRuns = new Map();
const printRuns: Map<string, Live> = globalRuns.__botmancerPrintRuns;

function printfBin(): string {
  return fs.existsSync('/usr/bin/printf') ? '/usr/bin/printf' : '/bin/printf';
}

function stillRunning(messageId: string, live: Live): boolean {
  if (live.stopped) return false;
  const current = messages.getById(messageId);
  const parsed = current ? parseRun(current.content) : null;
  return parsed?.state === 'running';
}

function markStopped(messageId: string) {
  const current = messages.getById(messageId);
  const parsed = current ? parseRun(current.content) : null;
  if (!parsed || parsed.state !== 'running') return;
  messages.replaceContent(messageId, serializeRun({ state: 'stopped' }));
}

function drop(messageId: string, child: ChildProcess) {
  const live = printRuns.get(messageId);
  if (live?.child === child) printRuns.delete(messageId);
}

export function beginPrintRun(messageId: string, word: string, seconds: number) {
  if (!/^[A-Za-z0-9]+$/.test(word)) return;
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 30) return;
  if (printRuns.has(messageId)) return;
  const current = messages.getById(messageId);
  const parsed = current ? parseRun(current.content) : null;
  if (!parsed || parsed.state !== 'running') return;

  const live: Live = { child: undefined as unknown as ChildProcess, stopped: false };
  const sleep = spawn('/bin/sleep', [String(seconds)], { stdio: 'ignore' });
  live.child = sleep;
  printRuns.set(messageId, live);

  sleep.on('error', () => {
    live.stopped = true;
    drop(messageId, sleep);
    markStopped(messageId);
  });

  sleep.on('exit', (code, signal) => {
    drop(messageId, sleep);
    if (!stillRunning(messageId, live) || signal || code !== 0) {
      if (live.stopped) markStopped(messageId);
      return;
    }
    let out = '';
    const print = spawn(printfBin(), ['%s\n', word], { stdio: ['ignore', 'pipe', 'ignore'] });
    live.child = print;
    printRuns.set(messageId, live);
    print.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
    });
    print.on('error', () => {
      live.stopped = true;
      drop(messageId, print);
      markStopped(messageId);
    });
    print.on('close', (printCode, printSignal) => {
      drop(messageId, print);
      if (!stillRunning(messageId, live) || printSignal || printCode !== 0) {
        if (live.stopped) markStopped(messageId);
        return;
      }
      if (out !== word + '\n') return;
      messages.replaceContent(messageId, serializeRun({ state: 'done', output: word }));
    });
  });
}

function fileMint6Path(): string | null {
  const root = path.resolve(process.cwd(), 'files');
  const file = path.resolve(root, 'filemint6.txt');
  const rel = path.relative(root, file);
  if (rel !== 'filemint6.txt') return null;
  if (!file.startsWith(root + path.sep)) return null;
  return file;
}

export function beginFileReadRun(messageId: string, seconds: number) {
  if (seconds !== 4 && seconds !== 20) return;
  if (printRuns.has(messageId)) return;
  const current = messages.getById(messageId);
  const parsed = current ? parseRun(current.content) : null;
  if (!parsed || parsed.state !== 'running') return;
  const file = fileMint6Path();
  if (!file) return;

  const live: Live = { child: undefined as unknown as ChildProcess, stopped: false };
  const sleep = spawn('/bin/sleep', [String(seconds)], { stdio: 'ignore' });
  live.child = sleep;
  printRuns.set(messageId, live);

  sleep.on('error', () => {
    live.stopped = true;
    drop(messageId, sleep);
    markStopped(messageId);
  });

  sleep.on('exit', (code, signal) => {
    drop(messageId, sleep);
    if (live.stopped || !stillRunning(messageId, live) || signal || code !== 0) {
      if (live.stopped) markStopped(messageId);
      return;
    }
    const catPath = fileMint6Path();
    if (!catPath || live.stopped) {
      if (live.stopped) markStopped(messageId);
      return;
    }
    let out = '';
    const cat = spawn('/bin/cat', [catPath], { stdio: ['ignore', 'pipe', 'ignore'] });
    live.child = cat;
    printRuns.set(messageId, live);
    cat.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
    });
    cat.on('error', () => {
      live.stopped = true;
      drop(messageId, cat);
      markStopped(messageId);
    });
    cat.on('close', (catCode, catSignal) => {
      drop(messageId, cat);
      if (!stillRunning(messageId, live) || catSignal || catCode !== 0) {
        if (live.stopped) markStopped(messageId);
        return;
      }
      const word = out.endsWith('\n') ? out.slice(0, -1) : '';
      if (out !== word + '\n' || word !== 'filemint6') return;
      messages.replaceContent(messageId, serializeRun({ state: 'done', output: word }));
    });
    if (live.stopped || !stillRunning(messageId, live)) {
      try {
        cat.kill('SIGTERM');
      } catch {
        // The child already exited.
      }
    }
  });
}


const EXAMPLE_PAGE = 'https://example.com';

function curlBin(): string | null {
  if (fs.existsSync('/usr/bin/curl')) return '/usr/bin/curl';
  if (fs.existsSync('/bin/curl')) return '/bin/curl';
  return null;
}

function exampleWord(html: string): string | null {
  const title = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  const h1 = html.match(/<h1[^>]*>([^<]*)<\/h1>/i);
  const first = (raw: string | undefined) => {
    const text = (raw || '').replace(/\s+/g, ' ').trim();
    return text.split(' ')[0] || '';
  };
  const titleWord = first(title?.[1]);
  const h1Word = first(h1?.[1]);
  if (titleWord !== 'Example' && h1Word !== 'Example') return null;
  if (!html.includes('Example')) return null;
  return 'Example';
}

function htmlTitle(html: string): string | null {
  const title = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  if (!title) return null;
  const text = (title[1] ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text;
}

export function beginPageReadRun(messageId: string, seconds: number, pageUrl?: string) {
  if (seconds !== 4 && seconds !== 20) return;
  let target = EXAMPLE_PAGE;
  let wholeTitle = false;
  if (pageUrl !== undefined) {
    if (httpsPageUrl(pageUrl) !== pageUrl) return;
    target = pageUrl;
    wholeTitle = true;
  }
  if (printRuns.has(messageId)) return;
  const current = messages.getById(messageId);
  const parsed = current ? parseRun(current.content) : null;
  if (!parsed || parsed.state !== 'running') return;

  const live: Live = { child: undefined as unknown as ChildProcess, stopped: false };
  const sleep = spawn('/bin/sleep', [String(seconds)], { stdio: 'ignore' });
  live.child = sleep;
  printRuns.set(messageId, live);

  sleep.on('error', () => {
    live.stopped = true;
    drop(messageId, sleep);
    markStopped(messageId);
  });

  sleep.on('exit', (code, signal) => {
    drop(messageId, sleep);
    if (live.stopped || !stillRunning(messageId, live) || signal || code !== 0) {
      if (live.stopped) markStopped(messageId);
      return;
    }
    const bin = curlBin();
    if (!bin || live.stopped || !stillRunning(messageId, live)) {
      if (live.stopped) markStopped(messageId);
      else markStopped(messageId);
      return;
    }
    let out = '';
    const curl = spawn(bin, [
      '--silent',
      '--show-error',
      '--fail',
      '--max-time', '20',
      '--max-redirs', '0',
      '--proto', '=https',
      '--proto-redir', '=https',
      target,
    ], {
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent', NODE_ENV: 'production' },
    });
    live.child = curl;
    printRuns.set(messageId, live);
    curl.stdout?.on('data', (chunk: Buffer) => {
      if (out.length < 262144) out += chunk.toString('utf8');
    });
    curl.on('error', () => {
      live.stopped = true;
      drop(messageId, curl);
      markStopped(messageId);
    });
    curl.on('close', (curlCode, curlSignal) => {
      drop(messageId, curl);
      if (live.stopped || !stillRunning(messageId, live)) return;
      if (curlSignal || curlCode !== 0) {
        markStopped(messageId);
        return;
      }
      const output = wholeTitle ? htmlTitle(out) : exampleWord(out);
      if (!output || (!wholeTitle && output !== 'Example')) {
        markStopped(messageId);
        return;
      }
      if (live.stopped || !stillRunning(messageId, live)) return;
      if (!wholeTitle) {
        messages.replaceContent(messageId, serializeRun({ state: 'done', output }));
        return;
      }
      const page = out;
      messages.replaceContent(messageId, serializeRun({ state: 'running', page }));
      if (live.stopped || !stillRunning(messageId, live)) {
        if (live.stopped) markStopped(messageId);
        return;
      }
      const pause = spawn('/bin/sleep', ['8'], { stdio: 'ignore' });
      live.child = pause;
      printRuns.set(messageId, live);
      pause.on('error', () => {
        live.stopped = true;
        drop(messageId, pause);
        markStopped(messageId);
      });
      pause.on('exit', (pauseCode, pauseSignal) => {
        drop(messageId, pause);
        if (live.stopped || !stillRunning(messageId, live) || pauseSignal || pauseCode !== 0) {
          if (live.stopped) markStopped(messageId);
          return;
        }
        messages.replaceContent(messageId, serializeRun({ state: 'done', output, page }));
      });
      if (live.stopped || !stillRunning(messageId, live)) {
        try {
          pause.kill('SIGTERM');
        } catch {
          // The child already exited.
        }
      }
    });
    if (live.stopped || !stillRunning(messageId, live)) {
      try {
        curl.kill('SIGTERM');
      } catch {
        // The child already exited.
      }
    }
  });
}

const CURSOR_HOST = 'api.cursor.com';
const CODING_LIMB_PROMPT = 'Which file holds the function parsePublicPageReadAsk in not-so-fat/botmancers? Reply with that path. Do not edit files, commit, push, or open a pull request.';
const CODING_LIMB_FAILED = 'The coding limb failed.';
const CODING_LIMB_TIMEOUT = 'The coding limb timed out.';
const CODING_LIMB_NO_KEY = 'The coding limb could not run.';

type CursorIds = { agentId: string; runId: string };

function cursorId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(value)) return null;
  return value;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null;
  return value as Record<string, unknown>;
}

function cursorRequest(method: string, apiPath: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const key = process.env.CURSOR_API_KEY;
  if (typeof key !== 'string' || key.length === 0) return Promise.reject(new Error('missing'));
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: CURSOR_HOST,
        port: 443,
        method,
        path: apiPath,
        headers: {
          Authorization: 'Bearer ' + key,
          Accept: 'application/json',
          ...(payload
            ? { 'Content-Type': 'application/json', 'Content-Length': String(payload.length) }
            : {}),
        },
        timeout: 20000,
      },
      (res) => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400) {
          res.resume();
          reject(new Error('redirect'));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size <= 1000000) chunks.push(chunk);
        });
        res.on('end', () => {
          if (size > 1000000) {
            reject(new Error('large'));
            return;
          }
          const text = Buffer.concat(chunks).toString('utf8');
          let json: unknown = null;
          if (text) {
            try {
              json = JSON.parse(text);
            } catch {
              json = null;
            }
          }
          resolve({ status, json });
        });
      },
    );
    req.on('error', () => reject(new Error('network')));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
    if (payload) req.end(payload);
    else req.end();
  });
}

function launchedIds(json: unknown): CursorIds | null {
  const body = recordOf(json);
  const agent = recordOf(body?.agent);
  const run = recordOf(body?.run);
  const agentId = cursorId(agent?.id);
  const runId = cursorId(run?.id);
  if (!agentId || !runId) return null;
  return { agentId, runId };
}

function storeCodingResult(messageId: string, live: Live, output: string) {
  if (live.stopped || !stillRunning(messageId, live)) return;
  messages.replaceContent(messageId, serializeRun({ state: 'done', output }));
}

function waitPoll(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function finishCodingLimb(messageId: string, live: Live) {
  if (live.stopped || !stillRunning(messageId, live)) return;
  const key = process.env.CURSOR_API_KEY;
  if (typeof key !== 'string' || key.length === 0) {
    storeCodingResult(messageId, live, CODING_LIMB_NO_KEY);
    return;
  }
  const remote: { ids: CursorIds | null; sent: boolean } = { ids: null, sent: false };
  live.cancelRemote = () => {
    const ids = remote.ids;
    if (!ids || remote.sent) return;
    remote.sent = true;
    void cursorRequest('POST', '/v1/agents/' + ids.agentId + '/runs/' + ids.runId + '/cancel').catch(() => {
      // Cancel is best-effort.
    });
  };
  if (live.stopped || !stillRunning(messageId, live)) return;
  let launched: { status: number; json: unknown };
  try {
    launched = await cursorRequest('POST', '/v1/agents', {
      prompt: { text: CODING_LIMB_PROMPT },
      repos: [
        {
          url: 'https://github.com/not-so-fat/botmancers',
          startingRef: 'main',
        },
      ],
      autoCreatePR: false,
      mode: 'plan',
    });
  } catch {
    storeCodingResult(messageId, live, CODING_LIMB_FAILED);
    return;
  }
  const ids = launchedIds(launched.json);
  if (ids) remote.ids = ids;
  if (live.stopped || !stillRunning(messageId, live)) {
    if (ids) live.cancelRemote();
    return;
  }
  if (launched.status < 200 || launched.status >= 300 || !ids) {
    storeCodingResult(messageId, live, CODING_LIMB_FAILED);
    return;
  }
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    if (live.stopped || !stillRunning(messageId, live)) return;
    let polled: { status: number; json: unknown };
    try {
      polled = await cursorRequest('GET', '/v1/agents/' + ids.agentId + '/runs/' + ids.runId);
    } catch {
      if (live.stopped || !stillRunning(messageId, live)) return;
      await waitPoll(2000);
      continue;
    }
    if (live.stopped || !stillRunning(messageId, live)) return;
    if (polled.status < 200 || polled.status >= 300) {
      storeCodingResult(messageId, live, CODING_LIMB_FAILED);
      return;
    }
    const row = recordOf(polled.json);
    const status = typeof row?.status === 'string' ? row.status : '';
    if (status === 'FINISHED') {
      const result = row?.result;
      if (typeof result === 'string' && result.length > 0) storeCodingResult(messageId, live, result);
      else storeCodingResult(messageId, live, CODING_LIMB_FAILED);
      return;
    }
    if (status === 'ERROR' || status === 'CANCELLED' || status === 'EXPIRED') {
      if (live.stopped || !stillRunning(messageId, live)) return;
      storeCodingResult(messageId, live, CODING_LIMB_FAILED);
      return;
    }
    await waitPoll(2000);
  }
  if (live.stopped || !stillRunning(messageId, live)) return;
  try {
    live.cancelRemote?.();
  } catch {
    // Cancel is best-effort.
  }
  storeCodingResult(messageId, live, CODING_LIMB_TIMEOUT);
}

export function beginCodingLimbRun(messageId: string, seconds: number) {
  if (seconds !== 4 && seconds !== 20) return;
  if (printRuns.has(messageId)) return;
  const current = messages.getById(messageId);
  const parsed = current ? parseRun(current.content) : null;
  if (!parsed || parsed.state !== 'running') return;

  const live: Live = { child: undefined as unknown as ChildProcess, stopped: false };
  const sleep = spawn('/bin/sleep', [String(seconds)], { stdio: 'ignore' });
  live.child = sleep;
  printRuns.set(messageId, live);

  sleep.on('error', () => {
    live.stopped = true;
    drop(messageId, sleep);
    markStopped(messageId);
  });

  sleep.on('exit', (code, signal) => {
    drop(messageId, sleep);
    if (live.stopped || !stillRunning(messageId, live) || signal || code !== 0) {
      if (live.stopped) markStopped(messageId);
      return;
    }
    const holder = spawn('/bin/sleep', ['600'], { stdio: 'ignore' });
    live.child = holder;
    printRuns.set(messageId, live);
    holder.on('error', () => {
      live.stopped = true;
      drop(messageId, holder);
      markStopped(messageId);
    });
    holder.on('exit', () => {
      drop(messageId, holder);
    });
    void (async () => {
      try {
        await finishCodingLimb(messageId, live);
      } catch {
        storeCodingResult(messageId, live, CODING_LIMB_FAILED);
      } finally {
        try {
          holder.kill('SIGTERM');
        } catch {
          // The child already exited.
        }
      }
    })();
  });
}

export function stopPrintRun(messageId: string) {
  const live = printRuns.get(messageId);
  if (live) live.stopped = true;
  markStopped(messageId);
  if (live?.cancelRemote) {
    try {
      live.cancelRemote();
    } catch {
      // Cancel is best-effort.
    }
  }
  if (!live) return;
  try {
    live.child.kill('SIGTERM');
  } catch {
    // The child already exited.
  }
  drop(messageId, live.child);
}
