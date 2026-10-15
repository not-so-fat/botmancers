// NOT-491: the Botmancers MCP bridge, contract botmancers.mcp.v1.
//
// A narrowly scoped MCP tool provider over the agent conversation service
// (./agent-conversations), for an external agent authenticated as a
// service principal. Transport-neutral: handleMcpMessage takes one parsed
// JSON-RPC message and the principal the transport authenticated, and
// returns the response (null for a notification). ./mcp-http serves it as
// Streamable HTTP at /api/v0/mcp.
//
// Exactly four tools:
//   botmancers_start_task        one read-only message to an allowlisted
//                                coordinator, through the shared intake
//   botmancers_get_request       the request's status and result
//   botmancers_get_conversation  the conversation it opened
//   botmancers_health            contract, caller, and coordinator check
//
// The caller chooses no runtime authority. start_task takes only a
// coordinator name from the operator's allowlist (BOTMANCERS_MCP_COORDINATORS),
// an objective, and an idempotency key; any other field (runtime, deck,
// model, tool profile, grant, target, principal, ...) is refused before
// anything is written. The accepted message is a direct read-only
// conversation turn; implementation or review work exists only if the
// coordinator emits Wakes, which the engine authorizes under owner grants
// like any other Wake. Reads go through the same participant check as
// /api/v0, so a service sees only conversations it opened.
import db, { bots, type Principal } from './db';
import {
  AgentApiError,
  acceptAgentMessage,
  getAgentRequest,
  getAuthorizedWorkRequest,
  getConversation,
} from './agent-conversations';
import type { WorkRequest, WorkRequestState } from './engine-store';

export const MCP_CONTRACT = 'botmancers.mcp.v1';
export const MCP_COORDINATORS_ENV = 'BOTMANCERS_MCP_COORDINATORS';
// Newest first; an unknown client version is answered with the newest.
export const MCP_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'] as const;

export const MCP_SERVER_INFO = { name: 'botmancers', title: 'Botmancers', version: '1.0.0' };

const IDEMPOTENCY_KEY_MAX = 128;
const OBJECTIVE_MAX = 20000;
const ID_MAX = 200;

// ---------------------------------------------------------------------
// Tool contract.

export type TaskStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';
const TASK_STATUSES: TaskStatus[] = ['pending', 'running', 'succeeded', 'failed', 'cancelled'];

const contractField = { type: 'string', const: MCP_CONTRACT };
const coordinatorRef = {
  type: 'object',
  properties: { agent_id: { type: 'string' }, name: { type: 'string' } },
  required: ['agent_id', 'name'],
  additionalProperties: false,
};
const principalRef = {
  type: 'object',
  properties: { kind: { type: 'string', enum: ['person', 'bot', 'service'] }, id: { type: 'string' }, name: { type: ['string', 'null'] } },
  required: ['kind', 'id', 'name'],
  additionalProperties: false,
};
const errorShape = {
  type: 'object',
  properties: { code: { type: 'string' }, message: { type: 'string' }, fields: { type: 'array', items: { type: 'string' } } },
  required: ['code', 'message'],
  additionalProperties: false,
};
const statusField = {
  type: 'string',
  enum: TASK_STATUSES,
  description: 'pending (accepted, not started) | running | succeeded | failed | cancelled. The last three are terminal.',
};

function idArgument(name: string, description: string) {
  return {
    type: 'object',
    properties: { [name]: { type: 'string', minLength: 1, maxLength: ID_MAX, description } },
    required: [name],
    additionalProperties: false,
  };
}

export const MCP_TOOLS = [
  {
    name: 'botmancers_start_task',
    title: 'Start a Botmancers task',
    description: 'Send one objective to an allowlisted Botmancers coordinator Agent as a new conversation. '
      + 'The coordinator answers read-only; any implementation or review it decides on runs only under the Botmancers owner\'s grants. '
      + 'Returns durable request_id and conversation_id to poll. Retrying with the same idempotency_key and objective returns the original ids.',
    inputSchema: {
      type: 'object',
      properties: {
        coordinator: { type: 'string', minLength: 1, maxLength: 100, description: 'Name of an allowlisted coordinator Agent (see botmancers_health).' },
        objective: { type: 'string', minLength: 1, maxLength: OBJECTIVE_MAX, description: 'What the coordinator should achieve, in plain language.' },
        idempotency_key: {
          type: 'string', minLength: 1, maxLength: IDEMPOTENCY_KEY_MAX, pattern: '^[A-Za-z0-9._:-]+$',
          description: 'Caller-chosen key for this task. Reuse it to retry safely; reusing it for a different objective or coordinator is a conflict.',
        },
      },
      required: ['coordinator', 'objective', 'idempotency_key'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        contract: contractField,
        request_id: { type: 'string' },
        conversation_id: { type: 'string' },
        coordinator: coordinatorRef,
        status: statusField,
        replayed: { type: 'boolean' },
      },
      required: ['contract', 'request_id', 'conversation_id', 'coordinator', 'status', 'replayed'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { 'botmancers/contract': MCP_CONTRACT },
  },
  {
    name: 'botmancers_get_request',
    title: 'Get a Botmancers task request',
    description: 'Poll the status of a request returned by botmancers_start_task. When terminal, result or failure is set.',
    inputSchema: idArgument('request_id', 'request_id returned by botmancers_start_task.'),
    outputSchema: {
      type: 'object',
      properties: {
        contract: contractField,
        request_id: { type: 'string' },
        conversation_id: { type: 'string' },
        coordinator: coordinatorRef,
        status: statusField,
        terminal: { type: 'boolean' },
        result: {
          type: ['object', 'null'],
          properties: { message_id: { type: 'string' }, content: { type: 'string' } },
          required: ['message_id', 'content'],
          additionalProperties: false,
        },
        failure: {
          type: ['object', 'null'],
          properties: { code: { type: 'string' }, message: { type: 'string' } },
          required: ['code', 'message'],
          additionalProperties: false,
        },
        created_at: { type: 'integer', description: 'Epoch milliseconds.' },
        updated_at: { type: 'integer', description: 'Epoch milliseconds.' },
      },
      required: ['contract', 'request_id', 'conversation_id', 'coordinator', 'status', 'terminal', 'result', 'failure', 'created_at', 'updated_at'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { 'botmancers/contract': MCP_CONTRACT },
  },
  {
    name: 'botmancers_get_conversation',
    title: 'Get a Botmancers task conversation',
    description: 'Read the conversation a task opened: ordered messages from the coordinator and any Agents it woke, and lifecycle events. '
      + 'status is active while any request in it is still open.',
    inputSchema: idArgument('conversation_id', 'conversation_id returned by botmancers_start_task.'),
    outputSchema: {
      type: 'object',
      properties: {
        contract: contractField,
        conversation_id: { type: 'string' },
        status: { type: 'string', enum: ['active', 'idle'] },
        open_request_count: { type: 'integer' },
        origin: { anyOf: [principalRef, { type: 'null' }] },
        participants: { type: 'array', items: principalRef },
        messages: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              seq: { type: 'integer' },
              message_id: { type: 'string' },
              sender: principalRef,
              content: { type: 'string' },
              request_id: { type: ['string', 'null'] },
              created_at: { type: 'integer' },
            },
            required: ['seq', 'message_id', 'sender', 'content', 'request_id', 'created_at'],
            additionalProperties: false,
          },
        },
        events: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              seq: { type: 'integer' },
              kind: { type: 'string' },
              request_id: { type: ['string', 'null'] },
              wake_id: { type: ['string', 'null'] },
              text: { type: 'string' },
              created_at: { type: 'integer' },
            },
            required: ['seq', 'kind', 'request_id', 'wake_id', 'text', 'created_at'],
            additionalProperties: false,
          },
        },
      },
      required: ['contract', 'conversation_id', 'status', 'open_request_count', 'origin', 'participants', 'messages', 'events'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { 'botmancers/contract': MCP_CONTRACT },
  },
  {
    name: 'botmancers_health',
    title: 'Botmancers bridge health',
    description: 'Confirm the bridge is reachable and authenticated, and list the coordinators this caller may start tasks with.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: {
      type: 'object',
      properties: {
        contract: contractField,
        status: { type: 'string', const: 'ok' },
        principal: {
          type: 'object',
          properties: { kind: { type: 'string' }, id: { type: 'string' } },
          required: ['kind', 'id'],
          additionalProperties: false,
        },
        coordinators: {
          type: 'array',
          items: {
            type: 'object',
            properties: { name: { type: 'string' }, available: { type: 'boolean' } },
            required: ['name', 'available'],
            additionalProperties: false,
          },
        },
      },
      required: ['contract', 'status', 'principal', 'coordinators'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { 'botmancers/contract': MCP_CONTRACT },
  },
] as const;

export type McpToolName = (typeof MCP_TOOLS)[number]['name'];

// ---------------------------------------------------------------------
// Tool errors: returned as tool results with isError, never as rows.

export type McpToolErrorCode =
  | 'invalid_arguments'
  | 'unsupported_field'
  | 'coordinator_not_allowed'
  | 'idempotency_conflict'
  | 'request_not_found'
  | 'conversation_not_found'
  | 'internal_error';

export class McpToolError extends Error {
  readonly code: McpToolErrorCode;
  readonly fields: string[] | undefined;
  constructor(code: McpToolErrorCode, message: string, fields?: string[]) {
    super(message);
    this.name = 'McpToolError';
    this.code = code;
    this.fields = fields;
  }
}

function fromApiError(error: AgentApiError): McpToolError {
  switch (error.code) {
    case 'idempotency_conflict':
      return new McpToolError('idempotency_conflict', 'This idempotency_key was already used for a different task.');
    case 'request_not_found':
    case 'conversation_not_found':
      return new McpToolError(error.code, error.message);
    case 'agent_not_found':
      return new McpToolError('coordinator_not_allowed', 'That coordinator is not available to this caller.');
    case 'invalid_request':
      return new McpToolError('invalid_arguments', error.message);
    default:
      return new McpToolError('internal_error', 'The request could not be processed.');
  }
}

// ---------------------------------------------------------------------
// Argument validation (the JSON schemas above, enforced server-side).

function objectArguments(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new McpToolError('invalid_arguments', 'arguments must be an object.');
  return value as Record<string, unknown>;
}

function onlyFields(args: Record<string, unknown>, allowed: string[]): void {
  const extra = Object.keys(args).filter(key => !allowed.includes(key)).sort();
  if (extra.length) {
    throw new McpToolError('unsupported_field', `Unsupported field(s): ${extra.join(', ')}. Only ${allowed.join(', ') || 'no fields'} may be given.`, extra);
  }
}

function stringField(args: Record<string, unknown>, name: string, max: number): string {
  const value = args[name];
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new McpToolError('invalid_arguments', `${name} must be a non-empty string of at most ${max} characters.`);
  }
  return value;
}

// One objective, however the caller's client encoded line endings and
// surrounding whitespace.
export function normalizeObjective(value: string): string {
  return value.replace(/\r\n?/g, '\n').normalize('NFC').trim();
}

// ---------------------------------------------------------------------
// Coordinator allowlist.

export function allowlistedCoordinatorNames(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env[MCP_COORDINATORS_ENV] ?? '').split(',').map(name => name.trim()).filter(Boolean);
}

function resolveCoordinator(name: string): { id: string; name: string } {
  const bot = bots.getByName(name);
  const allowed = bot && allowlistedCoordinatorNames().some(entry => bots.getByName(entry)?.id === bot.id);
  if (!bot || !allowed) throw new McpToolError('coordinator_not_allowed', 'That coordinator is not available to this caller.');
  return { id: bot.id, name: bot.name };
}

function coordinatorOf(request: WorkRequest): { agent_id: string; name: string } {
  const bot = bots.getById(request.target_agent_id);
  return { agent_id: request.target_agent_id, name: bot ? bot.name : request.target_agent_id };
}

// ---------------------------------------------------------------------
// Views.

export function taskStatusOf(state: WorkRequestState): TaskStatus {
  switch (state) {
    case 'running':
    case 'waiting':
      return 'running';
    case 'completed':
      return 'succeeded';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'pending';
  }
}

const TERMINAL: TaskStatus[] = ['succeeded', 'failed', 'cancelled'];

function principalView(principal: Principal) {
  const bot = principal.kind === 'bot' ? bots.getById(principal.id) : undefined;
  return { kind: principal.kind, id: principal.id, name: bot ? bot.name : null };
}

function startTask(principal: Principal, raw: unknown) {
  const args = objectArguments(raw);
  onlyFields(args, ['coordinator', 'objective', 'idempotency_key']);
  const coordinatorName = stringField(args, 'coordinator', 100);
  const objective = normalizeObjective(stringField(args, 'objective', OBJECTIVE_MAX));
  const key = stringField(args, 'idempotency_key', IDEMPOTENCY_KEY_MAX);
  if (!/^[A-Za-z0-9._:-]+$/.test(key)) throw new McpToolError('invalid_arguments', 'idempotency_key may contain only letters, digits, and . _ : -');
  if (!objective) throw new McpToolError('invalid_arguments', 'objective must not be blank.');
  const coordinator = resolveCoordinator(coordinatorName);
  // The shared intake's (principal, key) idempotency, in a namespace of
  // its own so bridge keys never collide with direct /api/v0 messages.
  // Its fingerprint covers coordinator and objective: a different one
  // under the same key is a conflict.
  const { accepted } = acceptAgentMessage(principal, {
    agentId: coordinator.id,
    content: objective,
    idempotencyKey: `mcp:${key}`,
    conversationId: null,
  });
  const request = getAuthorizedWorkRequest(principal, accepted.requestId);
  return {
    contract: MCP_CONTRACT,
    request_id: accepted.requestId,
    conversation_id: accepted.conversationId,
    coordinator: { agent_id: coordinator.id, name: coordinator.name },
    status: taskStatusOf(request.state),
    replayed: accepted.replayed,
  };
}

function getRequest(principal: Principal, raw: unknown) {
  const args = objectArguments(raw);
  onlyFields(args, ['request_id']);
  const requestId = stringField(args, 'request_id', ID_MAX);
  const request = getAuthorizedWorkRequest(principal, requestId);
  const view = getAgentRequest(principal, requestId);
  const status = taskStatusOf(request.state);
  return {
    contract: MCP_CONTRACT,
    request_id: view.requestId,
    conversation_id: view.conversationId,
    coordinator: coordinatorOf(request),
    status,
    terminal: TERMINAL.includes(status),
    result: status === 'succeeded' && view.reply ? { message_id: view.reply.messageId, content: view.reply.content } : null,
    failure: status === 'failed' || status === 'cancelled'
      ? { code: view.failure?.code || request.state, message: view.failure?.message || '' }
      : null,
    created_at: view.createdAt,
    updated_at: view.updatedAt,
  };
}

function getConversationTool(principal: Principal, raw: unknown) {
  const args = objectArguments(raw);
  onlyFields(args, ['conversation_id']);
  const conversationId = stringField(args, 'conversation_id', ID_MAX);
  const view = getConversation(principal, conversationId);
  const open = (db.prepare(
    "SELECT COUNT(*) AS n FROM work_requests WHERE source_conversation_id = ? AND state IN ('queued', 'blocked', 'running', 'waiting')"
  ).get(view.conversationId) as { n: number }).n;
  return {
    contract: MCP_CONTRACT,
    conversation_id: view.conversationId,
    status: open > 0 ? 'active' : 'idle',
    open_request_count: open,
    origin: view.origin ? principalView(view.origin) : null,
    participants: view.participants.map(principalView),
    messages: view.messages.map(message => ({
      seq: message.seq,
      message_id: message.messageId,
      sender: principalView(message.sender),
      content: message.content,
      request_id: message.requestId,
      created_at: message.createdAt,
    })),
    // Projection events without their internal data (attempts, runtime
    // and session identifiers stay inside Botmancers).
    events: view.events.map(event => ({
      seq: event.seq,
      kind: event.kind,
      request_id: event.requestId,
      wake_id: event.wakeId,
      text: event.text,
      created_at: event.createdAt,
    })),
  };
}

function health(principal: Principal, raw: unknown) {
  onlyFields(objectArguments(raw), []);
  return {
    contract: MCP_CONTRACT,
    status: 'ok' as const,
    principal: { kind: principal.kind, id: principal.id },
    coordinators: allowlistedCoordinatorNames().map(name => {
      const bot = bots.getByName(name);
      return { name: bot ? bot.name : name, available: !!bot };
    }),
  };
}

const HANDLERS: Record<McpToolName, (principal: Principal, args: unknown) => Record<string, unknown>> = {
  botmancers_start_task: startTask,
  botmancers_get_request: getRequest,
  botmancers_get_conversation: getConversationTool,
  botmancers_health: health,
};

export interface McpToolResult {
  content: { type: 'text'; text: string }[];
  structuredContent: Record<string, unknown>;
  isError: boolean;
  [key: string]: unknown;
}

function toolResult(structured: Record<string, unknown>, isError: boolean): McpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(structured) }], structuredContent: structured, isError };
}

export function callMcpTool(principal: Principal, name: McpToolName, args: unknown): McpToolResult {
  try {
    return toolResult(HANDLERS[name](principal, args), false);
  } catch (error) {
    const failure = error instanceof McpToolError
      ? error
      : error instanceof AgentApiError
        ? fromApiError(error)
        : null;
    if (!failure) console.error('MCP bridge tool error:', error);
    const shown = failure ?? new McpToolError('internal_error', 'The request could not be processed.');
    return toolResult({
      contract: MCP_CONTRACT,
      error: { code: shown.code, message: shown.message, ...(shown.fields ? { fields: shown.fields } : {}) },
    }, true);
  }
}

// ---------------------------------------------------------------------
// JSON-RPC.

export type JsonRpcId = string | number;

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: JsonRpcId | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export const JSON_RPC = { parseError: -32700, invalidRequest: -32600, methodNotFound: -32601, invalidParams: -32602, internalError: -32603 };

export function jsonRpcError(id: JsonRpcId | null, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

export function negotiateProtocolVersion(requested: unknown): string {
  return typeof requested === 'string' && (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
    ? requested
    : MCP_PROTOCOL_VERSIONS[0];
}

const INSTRUCTIONS = 'Botmancers bridge (botmancers.mcp.v1). Start a task with botmancers_start_task, then poll botmancers_get_request '
  + 'until terminal and read botmancers_get_conversation; it stays active while the coordinator\'s follow-up work is open.';

// One parsed JSON-RPC message from an authenticated principal. Returns the
// response, or null for a notification or a client response.
export function handleMcpMessage(principal: Principal, message: unknown): JsonRpcResponse | null {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return jsonRpcError(null, JSON_RPC.invalidRequest, 'Invalid Request');
  }
  const { jsonrpc, id, method, params } = message as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  const hasId = typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id));
  if (jsonrpc !== '2.0' || (id !== undefined && !hasId)) return jsonRpcError(null, JSON_RPC.invalidRequest, 'Invalid Request');
  if (typeof method !== 'string') {
    // A response to a server request; this server sends none.
    return hasId ? null : jsonRpcError(null, JSON_RPC.invalidRequest, 'Invalid Request');
  }
  if (!hasId) return null;
  const requestId = id as JsonRpcId;
  const p = (params && typeof params === 'object' && !Array.isArray(params) ? params : {}) as Record<string, unknown>;
  switch (method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id: requestId,
        result: {
          protocolVersion: negotiateProtocolVersion(p.protocolVersion),
          capabilities: { tools: { listChanged: false } },
          serverInfo: MCP_SERVER_INFO,
          instructions: INSTRUCTIONS,
        },
      };
    case 'ping':
      return { jsonrpc: '2.0', id: requestId, result: {} };
    case 'tools/list':
      return { jsonrpc: '2.0', id: requestId, result: { tools: MCP_TOOLS } };
    case 'tools/call': {
      const name = p.name;
      if (typeof name !== 'string' || !(name in HANDLERS)) {
        return jsonRpcError(requestId, JSON_RPC.invalidParams, `Unknown tool: ${typeof name === 'string' ? name.slice(0, 100) : String(name)}`);
      }
      return { jsonrpc: '2.0', id: requestId, result: callMcpTool(principal, name as McpToolName, p.arguments) };
    }
    default:
      return jsonRpcError(requestId, JSON_RPC.methodNotFound, 'Method not found');
  }
}
