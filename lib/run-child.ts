import { spawn, type ChildProcess } from 'child_process';
import path from 'path';
import https from 'https';
import { messages } from './db';
import { parseRun, serializeRun } from './run';

type Live = {
  child: ChildProcess;
  stopped: boolean;
};

const globalRuns = globalThis as typeof globalThis & {
  __botmancerFileRuns?: Map<string, Live>;
};

if (!globalRuns.__botmancerFileRuns) globalRuns.__botmancerFileRuns = new Map();
const fileRuns: Map<string, Live> = globalRuns.__botmancerFileRuns;

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
  const live = fileRuns.get(messageId);
  if (live?.child === child) fileRuns.delete(messageId);
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
  if (fileRuns.has(messageId)) return;
  const current = messages.getById(messageId);
  const parsed = current ? parseRun(current.content) : null;
  if (!parsed || parsed.state !== 'running') return;
  const file = fileMint6Path();
  if (!file) return;

  const live: Live = { child: undefined as unknown as ChildProcess, stopped: false };
  const sleep = spawn('/bin/sleep', [String(seconds)], { stdio: 'ignore' });
  live.child = sleep;
  fileRuns.set(messageId, live);

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
    fileRuns.set(messageId, live);
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

export function stopFileReadRun(messageId: string) {
  const live = fileRuns.get(messageId);
  if (live) live.stopped = true;
  markStopped(messageId);
  if (!live) return;
  try {
    live.child.kill('SIGTERM');
  } catch {
    // The child already exited.
  }
  drop(messageId, live.child);
}

const globalPageRuns = globalThis as typeof globalThis & {
  __botmancerPageRuns?: Map<string, Live>;
};

if (!globalPageRuns.__botmancerPageRuns) globalPageRuns.__botmancerPageRuns = new Map();
const pageRuns: Map<string, Live> = globalPageRuns.__botmancerPageRuns;

function dropPageRun(messageId: string, child: ChildProcess) {
  const live = pageRuns.get(messageId);
  if (live?.child === child) pageRuns.delete(messageId);
}

function fetchPublicPage(url: string, allowedHostname: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 10000 }, res => {
      if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
        const location = res.headers.location;
        if (location) {
          try {
            const redirectUrl = new URL(location, url);
            if (redirectUrl.hostname !== allowedHostname) {
              reject(new Error('Redirect to different host not allowed'));
              return;
            }
          } catch {
            reject(new Error('Invalid redirect location'));
            return;
          }
        }
        reject(new Error('Redirect detected'));
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      let body = '';
      res.on('data', chunk => {
        body += chunk.toString('utf8');
        if (body.length > 100000) {
          res.destroy();
          reject(new Error('Response too large'));
        }
      });
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Timeout'));
    });
  });
}

function extractFirstWordFromHtml(html: string): string | null {
  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  if (titleMatch && titleMatch[1]) {
    const text = titleMatch[1].trim();
    const firstWord = text.split(/\s+/)[0];
    if (firstWord) return firstWord;
  }
  const h1Match = html.match(/<h1[^>]*>([^<]*)<\/h1>/i);
  if (h1Match && h1Match[1]) {
    const text = h1Match[1].trim();
    const firstWord = text.split(/\s+/)[0];
    if (firstWord) return firstWord;
  }
  return null;
}

function extractPageTitle(html: string): string | null {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!titleMatch) return null;
  
  const rawTitle = titleMatch[1]
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  
  return rawTitle || null;
}

export function beginPublicPageReadRun(messageId: string, seconds: number, url?: string) {
  if (seconds !== 4 && seconds !== 20) return;
  if (pageRuns.has(messageId)) return;
  const current = messages.getById(messageId);
  const parsed = current ? parseRun(current.content) : null;
  if (!parsed || parsed.state !== 'running') return;

  const live: Live = { child: undefined as unknown as ChildProcess, stopped: false };
  const sleep = spawn('/bin/sleep', [String(seconds)], { stdio: 'ignore' });
  live.child = sleep;
  pageRuns.set(messageId, live);

  sleep.on('error', () => {
    live.stopped = true;
    dropPageRun(messageId, sleep);
    markStopped(messageId);
  });

  sleep.on('exit', async (code, signal) => {
    dropPageRun(messageId, sleep);
    if (live.stopped || !stillRunning(messageId, live) || signal || code !== 0) {
      if (live.stopped) markStopped(messageId);
      return;
    }

    if (live.stopped || !stillRunning(messageId, live)) {
      if (live.stopped) markStopped(messageId);
      return;
    }

    try {
      if (url) {
        // New page title extraction
        const parsedUrl = new URL(url);
        const html = await fetchPublicPage(url, parsedUrl.hostname);
        if (live.stopped || !stillRunning(messageId, live)) {
          if (live.stopped) markStopped(messageId);
          return;
        }
        const title = extractPageTitle(html);
        if (title && stillRunning(messageId, live)) {
          messages.replaceContent(messageId, serializeRun({ state: 'done', output: title }));
        }
      } else {
        // Legacy one-word extraction from example.com
        const html = await fetchPublicPage('https://example.com', 'example.com');
        if (live.stopped || !stillRunning(messageId, live)) {
          if (live.stopped) markStopped(messageId);
          return;
        }
        const word = extractFirstWordFromHtml(html);
        if (word === 'Example' && stillRunning(messageId, live)) {
          messages.replaceContent(messageId, serializeRun({ state: 'done', output: 'Example' }));
        }
      }
    } catch (error) {
      console.error('Public page fetch failed:', error);
    }
  });
}

export function stopPublicPageReadRun(messageId: string) {
  const live = pageRuns.get(messageId);
  if (live) live.stopped = true;
  markStopped(messageId);
  if (!live) return;
  try {
    live.child.kill('SIGTERM');
  } catch {
    // The child already exited.
  }
  dropPageRun(messageId, live.child);
}

const globalCodingLimbRuns = globalThis as typeof globalThis & {
  __botmancerCodingLimbRuns?: Map<string, Live & { agentId?: string; runId?: string }>;
};

if (!globalCodingLimbRuns.__botmancerCodingLimbRuns) globalCodingLimbRuns.__botmancerCodingLimbRuns = new Map();
const codingLimbRuns: Map<string, Live & { agentId?: string; runId?: string }> = globalCodingLimbRuns.__botmancerCodingLimbRuns;

function dropCodingLimbRun(messageId: string, child: ChildProcess) {
  const live = codingLimbRuns.get(messageId);
  if (live?.child === child) codingLimbRuns.delete(messageId);
}

async function cancelCursorCloudAgent(agentId: string, runId: string): Promise<void> {
  const apiKey = process.env.CURSOR_API_KEY;
  if (!apiKey) return;

  try {
    await fetch(`https://api.cursor.com/v1/agents/${agentId}/runs/${runId}/cancel`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
      },
    });
  } catch {
    // Best effort cancellation
  }
}

export function beginCodingLimbRun(messageId: string, seconds: number) {
  if (seconds !== 4 && seconds !== 20) return;
  if (codingLimbRuns.has(messageId)) return;
  const current = messages.getById(messageId);
  const parsed = current ? parseRun(current.content) : null;
  if (!parsed || parsed.state !== 'running') return;

  const live: Live & { agentId?: string; runId?: string } = { 
    child: undefined as unknown as ChildProcess, 
    stopped: false, 
    agentId: undefined, 
    runId: undefined 
  };
  const sleep = spawn('/bin/sleep', [String(seconds)], { stdio: 'ignore' });
  live.child = sleep;
  codingLimbRuns.set(messageId, live);

  sleep.on('error', () => {
    live.stopped = true;
    dropCodingLimbRun(messageId, sleep);
    markStopped(messageId);
  });

  sleep.on('exit', async (code, signal) => {
    dropCodingLimbRun(messageId, sleep);
    if (live.stopped || !stillRunning(messageId, live) || signal || code !== 0) {
      if (live.stopped) markStopped(messageId);
      return;
    }

    if (live.stopped || !stillRunning(messageId, live)) {
      if (live.stopped) markStopped(messageId);
      return;
    }

    const promptText = 'Which file holds parsePublicPageReadAsk in not-so-fat/botmancers? Reply with the path. Do not edit, commit, push, or open a pull request.';

    try {
      const apiKey = process.env.CURSOR_API_KEY;
      if (!apiKey) {
        if (!live.stopped && stillRunning(messageId, live)) {
          messages.replaceContent(messageId, serializeRun({ state: 'done', output: 'Error: CURSOR_API_KEY not set' }));
        }
        return;
      }

      const createResponse = await fetch('https://api.cursor.com/v1/agents', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          prompt: {
            text: promptText
          },
          repos: [
            {
              url: 'https://github.com/not-so-fat/botmancers',
              startingRef: 'main'
            }
          ],
          autoCreatePR: false,
          mode: 'plan'
        }),
      });

      if (live.stopped || !stillRunning(messageId, live)) {
        if (live.stopped) markStopped(messageId);
        return;
      }

      if (!createResponse.ok) {
        if (!live.stopped && stillRunning(messageId, live)) {
          messages.replaceContent(
            messageId,
            serializeRun({ state: 'done', output: `Create failed: ${createResponse.status}` })
          );
        }
        return;
      }

      const createData = await createResponse.json();
      const agentId = createData.agent?.id;
      const runId = createData.run?.id;

      if (!agentId || !runId) {
        if (!live.stopped && stillRunning(messageId, live)) {
          messages.replaceContent(messageId, serializeRun({ state: 'done', output: 'Error: No agent or run ID returned' }));
        }
        return;
      }

      live.agentId = agentId;
      live.runId = runId;

      if (live.stopped || !stillRunning(messageId, live)) {
        await cancelCursorCloudAgent(agentId, runId);
        if (live.stopped) markStopped(messageId);
        return;
      }

      let pollAttempts = 0;
      const maxPollAttempts = 120;

      while (pollAttempts < maxPollAttempts) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        pollAttempts++;

        if (live.stopped || !stillRunning(messageId, live)) {
          await cancelCursorCloudAgent(agentId, runId);
          if (live.stopped) markStopped(messageId);
          return;
        }

        const statusResponse = await fetch(`https://api.cursor.com/v1/agents/${agentId}/runs/${runId}`, {
          headers: {
            'Authorization': `Bearer ${apiKey}`,
          },
        });

        if (!statusResponse.ok) {
          if (!live.stopped && stillRunning(messageId, live)) {
            messages.replaceContent(
              messageId,
              serializeRun({ state: 'done', output: `Poll failed: ${statusResponse.status}` })
            );
          }
          return;
        }

        const statusData = await statusResponse.json();

        if (live.stopped || !stillRunning(messageId, live)) {
          await cancelCursorCloudAgent(agentId, runId);
          if (live.stopped) markStopped(messageId);
          return;
        }

        if (statusData.status === 'FINISHED') {
          if (typeof statusData.result === 'string' && stillRunning(messageId, live)) {
            messages.replaceContent(messageId, serializeRun({ state: 'done', output: statusData.result }));
            return;
          }
          if (!live.stopped && stillRunning(messageId, live)) {
            messages.replaceContent(messageId, serializeRun({ state: 'done', output: 'Error: No result in response' }));
          }
          return;
        }

        if (statusData.status === 'FAILED' || statusData.status === 'CANCELLED') {
          if (!live.stopped && stillRunning(messageId, live)) {
            messages.replaceContent(messageId, serializeRun({ state: 'done', output: `Run ${statusData.status.toLowerCase()}` }));
          }
          return;
        }
      }

      if (!live.stopped && stillRunning(messageId, live)) {
        messages.replaceContent(messageId, serializeRun({ state: 'done', output: 'Timeout waiting for result' }));
      }
    } catch (error) {
      if (!live.stopped && stillRunning(messageId, live)) {
        const errorMsg = error instanceof Error ? error.message.slice(0, 40) : 'Unknown';
        messages.replaceContent(messageId, serializeRun({ state: 'done', output: `Network error: ${errorMsg}` }));
      }
    }
  });
}

export function stopCodingLimbRun(messageId: string) {
  const live = codingLimbRuns.get(messageId);
  if (live) {
    live.stopped = true;
    if (live.agentId && live.runId) {
      cancelCursorCloudAgent(live.agentId, live.runId).catch(() => {});
    }
  }
  markStopped(messageId);
  if (!live) return;
  try {
    live.child.kill('SIGTERM');
  } catch {
    // The child already exited.
  }
  dropCodingLimbRun(messageId, live.child);
}
