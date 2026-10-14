// NOT-487: authenticated client for the Agent Deck run HTTP API (Agent Deck
// docs/AGENT_RUN_API.md). The integration surface for canonical Attempts:
// start/status/events/cancel, plus the run-scoped candidate manifest and the
// reviewed-manifest finalizer. No call here shells out to `agent-deck run`,
// and nothing falls back to the CLI when the API fails.
//
// Credentials: the bearer is the server-only AGENT_DECK_RUN_TOKEN, read
// from the process environment at call time and placed only in the
// Authorization header of the outgoing request. It is never returned,
// stored, logged, or included in an error message; errors carry the HTTP
// status, Agent Deck's stable error_code, and a fixed or Agent Deck-authored
// message only.
//
// The server URL is the workspace Agent Deck server URL
// (lib/agent-deck-settings).
import { getAgentDeckServerUrl, normalizeAgentDeckServerUrl } from './agent-deck-settings';

export const AGENT_DECK_RUN_TOKEN_ENV = 'AGENT_DECK_RUN_TOKEN';

export type AgentDeckRunState = 'starting' | 'running' | 'ended' | 'error' | 'died' | 'canceled';
export const AGENT_DECK_TERMINAL_STATES: readonly AgentDeckRunState[] = ['ended', 'error', 'died', 'canceled'];
const RUN_STATES: readonly string[] = ['starting', 'running', 'ended', 'error', 'died', 'canceled'];

// Stable Botmancers-side failure codes. Agent Deck's own error_code is kept
// alongside in `deckCode`.
export type AgentDeckApiErrorCode =
  | 'agent_deck_token_missing'
  | 'agent_deck_unauthorized'
  | 'agent_deck_forbidden'
  | 'agent_deck_unreachable'
  | 'agent_deck_rejected'
  | 'agent_deck_invalid_response';

export class AgentDeckApiError extends Error {
  readonly code: AgentDeckApiErrorCode;
  readonly status: number | null;
  readonly deckCode: string | null;
  constructor(code: AgentDeckApiErrorCode, message: string, status: number | null = null, deckCode: string | null = null) {
    super(message.slice(0, 300));
    this.name = 'AgentDeckApiError';
    this.code = code;
    this.status = status;
    this.deckCode = deckCode;
  }
}

// Fixed, actionable text per failure code. No URL, header, or token.
export const AGENT_DECK_API_MESSAGES: Record<AgentDeckApiErrorCode, string> = {
  agent_deck_token_missing: `Agent Deck API token is not configured on the Botmancers server (set ${AGENT_DECK_RUN_TOKEN_ENV}).`,
  agent_deck_unauthorized: `Agent Deck rejected the Botmancers run token (check ${AGENT_DECK_RUN_TOKEN_ENV} and that its grant is not revoked or expired).`,
  agent_deck_forbidden: 'Agent Deck refused this run for the Botmancers grant (enable runs and finalization on the grant and allow this deck).',
  agent_deck_unreachable: 'The Agent Deck server is unreachable at the workspace Agent Deck URL (start it or correct the URL).',
  agent_deck_rejected: 'Agent Deck rejected the request.',
  agent_deck_invalid_response: 'Agent Deck returned an unexpected response.',
};

export interface AgentDeckFinalizationStatus {
  baselineRef: string;
  baselineDigest: string;
  state: 'prepared' | 'finalizing' | 'finalized';
  commit: string | null;
}

export interface AgentDeckRunStatus {
  runId: string;
  deckId: string;
  client: string;
  tools: 'readonly' | 'edit';
  state: AgentDeckRunState;
  sessionId: string | null;
  finalization: AgentDeckFinalizationStatus | null;
}

export type AgentDeckRunEvent =
  | { seq: number; type: 'text'; text: string }
  | { seq: number; type: 'tool'; name: string }
  | { seq: number; type: 'notice'; message: string; sessionId: string | null }
  | { seq: number; type: 'result'; subtype: string; result: unknown; sessionId: string | null }
  | { seq: number; type: 'end'; sessionId: string | null }
  | { seq: number; type: 'error'; message: string; sessionId: string | null }
  | { seq: number; type: 'canceled'; sessionId: string | null };

export interface AgentDeckEventsPage {
  runId: string;
  state: AgentDeckRunState;
  events: AgentDeckRunEvent[];
  nextCursor: string;
}

export interface CandidateManifestEntry {
  path: string;
  sha256: string | null;
  mode: '100644' | '100755' | null;
}

export interface AgentDeckChanges {
  runId: string;
  baselineRef: string;
  baselineDigest: string;
  baseCommit: string;
  files: CandidateManifestEntry[];
  manifestDigest: string;
}

export interface FinalizeRequestBody {
  baselineDigest: string;
  expectedBaseCommit: string;
  reviewId: string;
  commitMessage: string;
  files: CandidateManifestEntry[];
}

export interface AgentDeckFinalizeResult {
  runId: string;
  finalizationState: 'finalized';
  commit: string;
  tree: string;
  parent: string;
  manifestDigest: string;
  fileCount: number;
  reviewId: string;
}

export interface StartRunBody {
  deckId: string;
  client: string;
  cwd: string;
  prompt: string;
  tools: 'readonly' | 'edit';
  resumeSessionId?: string;
  prepareFinalization?: boolean;
}

export interface AgentDeckHttpRequest {
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export interface AgentDeckHttpResponse {
  status: number;
  json: () => Promise<unknown>;
}

export type AgentDeckApiFetch = (url: string, init: AgentDeckHttpRequest) => Promise<AgentDeckHttpResponse>;

function defaultFetch(url: string, init: AgentDeckHttpRequest): Promise<AgentDeckHttpResponse> {
  return fetch(url, init as RequestInit).then(response => ({ status: response.status, json: () => response.json() as Promise<unknown> }));
}

let apiFetch: AgentDeckApiFetch = defaultFetch;
let serverUrlOverride: string | null = null;

// Test seams: the HTTP transport and the server URL. Pass null to restore.
export function setAgentDeckApiFetch(next: AgentDeckApiFetch | null): void {
  apiFetch = next ?? defaultFetch;
}

export function setAgentDeckApiServerUrlForTests(url: string | null): void {
  serverUrlOverride = url === null ? null : normalizeAgentDeckServerUrl(url);
}

export function agentDeckRunToken(): string | null {
  const value = process.env[AGENT_DECK_RUN_TOKEN_ENV];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export function hasAgentDeckRunToken(): boolean {
  return agentDeckRunToken() !== null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function failureFor(status: number, body: Record<string, unknown> | null): AgentDeckApiError {
  const deckCode = str(body?.error_code);
  const deckMessage = str(body?.error);
  if (status === 401) return new AgentDeckApiError('agent_deck_unauthorized', AGENT_DECK_API_MESSAGES.agent_deck_unauthorized, status, deckCode);
  if (status === 403) {
    return new AgentDeckApiError('agent_deck_forbidden', `${AGENT_DECK_API_MESSAGES.agent_deck_forbidden}${deckCode ? ` (${deckCode})` : ''}`, status, deckCode);
  }
  return new AgentDeckApiError(
    'agent_deck_rejected',
    `Agent Deck rejected the request (${status}${deckCode ? ` ${deckCode}` : ''})${deckMessage ? `: ${deckMessage}` : '.'}`,
    status,
    deckCode
  );
}

async function call(method: 'GET' | 'POST', path: string, options: { body?: unknown; idempotencyKey?: string; signal?: AbortSignal } = {}): Promise<Record<string, unknown>> {
  const token = agentDeckRunToken();
  if (!token) throw new AgentDeckApiError('agent_deck_token_missing', AGENT_DECK_API_MESSAGES.agent_deck_token_missing);
  const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: 'application/json' };
  if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const url = `${serverUrlOverride ?? getAgentDeckServerUrl()}${path}`;
  let response: AgentDeckHttpResponse;
  try {
    response = await apiFetch(url, {
      method,
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch {
    // The transport error text can name the URL; it is not surfaced.
    throw new AgentDeckApiError('agent_deck_unreachable', AGENT_DECK_API_MESSAGES.agent_deck_unreachable);
  }
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = record(await response.json());
  } catch {
    parsed = null;
  }
  if (response.status < 200 || response.status >= 300 || parsed?.success !== true) {
    if (response.status >= 200 && response.status < 300) {
      throw new AgentDeckApiError('agent_deck_invalid_response', AGENT_DECK_API_MESSAGES.agent_deck_invalid_response, response.status);
    }
    throw failureFor(response.status, parsed);
  }
  const data = record(parsed.data);
  if (!data) throw new AgentDeckApiError('agent_deck_invalid_response', AGENT_DECK_API_MESSAGES.agent_deck_invalid_response, response.status);
  return data;
}

function invalid(what: string): AgentDeckApiError {
  return new AgentDeckApiError('agent_deck_invalid_response', `${AGENT_DECK_API_MESSAGES.agent_deck_invalid_response} (${what})`);
}

function runState(value: unknown): AgentDeckRunState {
  if (typeof value !== 'string' || !RUN_STATES.includes(value)) throw invalid('run state');
  return value as AgentDeckRunState;
}

const SHA256 = /^[0-9a-f]{64}$/;
const GIT_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const BASELINE_REF = /^bl_[0-9a-f]{24}$/;

function finalizationStatus(value: unknown): AgentDeckFinalizationStatus | null {
  if (value === null || value === undefined) return null;
  const input = record(value);
  if (!input || typeof input.baselineRef !== 'string' || !BASELINE_REF.test(input.baselineRef)
    || typeof input.baselineDigest !== 'string' || !SHA256.test(input.baselineDigest)
    || !['prepared', 'finalizing', 'finalized'].includes(String(input.state))) {
    throw invalid('finalization status');
  }
  const commit = typeof input.commit === 'string' && GIT_OID.test(input.commit) ? input.commit : null;
  return { baselineRef: input.baselineRef, baselineDigest: input.baselineDigest, state: input.state as AgentDeckFinalizationStatus['state'], commit };
}

// A candidate path is repository-relative POSIX: never absolute, never a
// traversal, never inside .git. Anything else is not a public manifest.
export function isRepositoryRelativePath(path: unknown): path is string {
  if (typeof path !== 'string' || path.length === 0 || path.length > 1024) return false;
  if (path.startsWith('/') || path.includes('\\') || /^[A-Za-z]:/.test(path) || path.includes('\u0000')) return false;
  return path.split('/').every(segment => segment.length > 0 && segment !== '.' && segment !== '..' && segment !== '.git');
}

function manifestEntry(value: unknown): CandidateManifestEntry {
  const input = record(value);
  if (!input || Object.keys(input).some(key => !['path', 'sha256', 'mode'].includes(key))) throw invalid('manifest entry');
  if (!isRepositoryRelativePath(input.path)) throw invalid('manifest path');
  const deleted = input.sha256 === null && input.mode === null;
  const present = typeof input.sha256 === 'string' && SHA256.test(input.sha256) && (input.mode === '100644' || input.mode === '100755');
  if (!deleted && !present) throw invalid('manifest digest or mode');
  return { path: input.path, sha256: input.sha256 as string | null, mode: input.mode as CandidateManifestEntry['mode'] };
}

export async function startAgentDeckRun(body: StartRunBody, idempotencyKey: string): Promise<{ runId: string; state: AgentDeckRunState }> {
  const data = await call('POST', '/api/agent-runs', { body, idempotencyKey });
  const runId = str(data.runId);
  if (!runId) throw invalid('runId');
  return { runId, state: runState(data.state) };
}

export async function getAgentDeckRun(runId: string): Promise<AgentDeckRunStatus> {
  const data = await call('GET', `/api/agent-runs/${encodeURIComponent(runId)}`);
  return {
    runId: str(data.runId) ?? runId,
    deckId: String(data.deckId ?? ''),
    client: String(data.client ?? ''),
    tools: data.tools === 'edit' ? 'edit' : 'readonly',
    state: runState(data.state),
    sessionId: str(data.sessionId),
    finalization: finalizationStatus(data.finalization),
  };
}

export async function getAgentDeckRunEvents(runId: string, after: string | null): Promise<AgentDeckEventsPage> {
  const query = after ? `?after=${encodeURIComponent(after)}` : '';
  const data = await call('GET', `/api/agent-runs/${encodeURIComponent(runId)}/events${query}`);
  if (!Array.isArray(data.events)) throw invalid('events');
  return {
    runId: str(data.runId) ?? runId,
    state: runState(data.state),
    events: data.events.filter((event): event is AgentDeckRunEvent => !!record(event) && typeof (event as { type?: unknown }).type === 'string'),
    nextCursor: typeof data.nextCursor === 'string' ? data.nextCursor : (after ?? '0'),
  };
}

export async function cancelAgentDeckRun(runId: string): Promise<AgentDeckRunState> {
  const data = await call('POST', `/api/agent-runs/${encodeURIComponent(runId)}/cancel`);
  return runState(data.state);
}

export async function getAgentDeckRunChanges(runId: string): Promise<AgentDeckChanges> {
  const data = await call('GET', `/api/agent-runs/${encodeURIComponent(runId)}/changes`);
  if (typeof data.baselineRef !== 'string' || !BASELINE_REF.test(data.baselineRef)) throw invalid('baselineRef');
  if (typeof data.baselineDigest !== 'string' || !SHA256.test(data.baselineDigest)) throw invalid('baselineDigest');
  if (typeof data.baseCommit !== 'string' || !GIT_OID.test(data.baseCommit)) throw invalid('baseCommit');
  if (typeof data.manifestDigest !== 'string' || !SHA256.test(data.manifestDigest)) throw invalid('manifestDigest');
  if (!Array.isArray(data.files)) throw invalid('files');
  return {
    runId: str(data.runId) ?? runId,
    baselineRef: data.baselineRef,
    baselineDigest: data.baselineDigest,
    baseCommit: data.baseCommit,
    // Kept in Agent Deck's order: the ordered manifest is the evidence.
    files: data.files.map(manifestEntry),
    manifestDigest: data.manifestDigest,
  };
}

export async function finalizeAgentDeckRun(runId: string, body: FinalizeRequestBody, idempotencyKey: string): Promise<AgentDeckFinalizeResult> {
  const data = await call('POST', `/api/agent-runs/${encodeURIComponent(runId)}/finalize`, { body, idempotencyKey });
  if (data.finalizationState !== 'finalized' || typeof data.commit !== 'string' || !GIT_OID.test(data.commit)
    || typeof data.tree !== 'string' || !GIT_OID.test(data.tree)
    || typeof data.manifestDigest !== 'string' || !SHA256.test(data.manifestDigest)) {
    throw invalid('finalize result');
  }
  return {
    runId: str(data.runId) ?? runId,
    finalizationState: 'finalized',
    commit: data.commit,
    tree: data.tree,
    parent: typeof data.parent === 'string' ? data.parent : '',
    manifestDigest: data.manifestDigest,
    fileCount: typeof data.fileCount === 'number' ? data.fileCount : body.files.length,
    reviewId: typeof data.reviewId === 'string' ? data.reviewId : body.reviewId,
  };
}
