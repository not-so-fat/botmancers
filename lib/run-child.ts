import { spawn, type ChildProcess } from 'child_process';
import path from 'path';
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
