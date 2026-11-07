// Simulated botmancers.mcp.v2 results for the botmancers-collaboration
// routing fixtures (test/fixtures/skill-routing.json). Shared by the
// deterministic fixtures (test/skill.test.mjs) and the live client eval
// (scripts/eval-skill-routing.mjs), which serves the same results over MCP.
// Not shipped in the package.
import { readFileSync } from 'node:fs';

const SCHEMA = JSON.parse(readFileSync(new URL('../schemas/botmancers.mcp.v2.tools.json', import.meta.url), 'utf8'));
export const TOOL_NAMES = new Set(SCHEMA.tools.map(tool => tool.name));

export const CAPABILITY = {
  botmancers_list_agents: 'agents:read', botmancers_list_sessions: 'sessions:read', botmancers_list_conversations: 'conversations:read',
  botmancers_send_to_session: 'sessions:message', botmancers_create_exchange: 'exchanges:create',
  botmancers_get_exchange: 'exchanges:read', botmancers_list_exchanges: 'exchanges:read',
};
const ALL = ['agents:read', 'sessions:read', 'conversations:read', 'sessions:message', 'exchanges:read', 'exchanges:create'];
const RETRYABLE = new Set(['source_session_busy', 'agent_unavailable', 'rate_limited', 'internal_error', 'conflict']);

// A live client may poll more often than a fixture lists states: the last
// state repeats.
const next = states => (states.length > 1 ? states.shift() : states[0]);

export function makeSimulator(fixtures, scenario) {
  const byName = name => fixtures.agents.find(agent => agent.name === name);
  const errors = structuredClone(scenario.errors ?? {});
  const exchangeStates = [...(scenario.exchange ?? [])];
  const requestStates = [...(scenario.request ?? [])];
  const calls = [];
  const call = (tool, args) => {
    if (!TOOL_NAMES.has(tool)) throw new Error(`unknown tool ${tool}`);
    calls.push([tool, structuredClone(args)]);
    const code = errors[tool]?.shift();
    if (code) return { error: { code, message: `Simulated ${code}.`, retryable: RETRYABLE.has(code) } };
    switch (tool) {
      case 'botmancers_capabilities':
        return {
          // NOT-556: a service token reaches every registered Agent.
          mode: 'granted',
          agents: fixtures.agents.map(agent => ({ agent_id: agent.agent_id, capabilities: ALL })),
          operations: Object.entries(CAPABILITY).map(([name, capability]) => ({
            tool: name, capability, agent_ids: fixtures.agents.map(agent => agent.agent_id),
          })),
          polling: { initial_seconds: 2, max_seconds: 30 },
        };
      case 'botmancers_health': return { status: 'ok', coordinators: fixtures.agents.map(agent => ({ name: agent.name, available: true })) };
      case 'botmancers_list_agents': return { items: fixtures.agents, next_cursor: null };
      case 'botmancers_list_sessions': return { items: fixtures.sessions[args.agent_id] ?? [], next_cursor: null };
      case 'botmancers_list_conversations':
      case 'botmancers_list_exchanges': return { items: [], next_cursor: null };
      case 'botmancers_start_task': return { request_id: 'req-fixture-1', conversation_id: 'conv-fixture-1', replayed: false };
      case 'botmancers_get_request': {
        const status = next(requestStates);
        return { request_id: args.request_id, status, terminal: ['succeeded', 'failed', 'cancelled'].includes(status), result: status === 'succeeded' ? 'done' : null };
      }
      case 'botmancers_get_conversation': return { messages: [], status: 'idle', content_trust: 'untrusted' };
      case 'botmancers_send_to_session': return { exchange_id: 'xch-fixture-1', conversation_id: 'conv-fixture-2', replayed: false };
      case 'botmancers_create_exchange': return { exchange: { id: 'xch-fixture-1', state: 'queued' }, terminal: false, replayed: false };
      case 'botmancers_get_exchange': {
        const state = next(exchangeStates);
        const terminal = ['completed', 'failed', 'cancelled'].includes(state);
        return {
          terminal,
          content_trust: 'untrusted',
          exchange: {
            id: args.exchange_id, state,
            answer: state === 'completed' ? { content: scenario.answer ?? 'An answer.' } : null,
            failure: state === 'failed' ? scenario.failure : null,
            cancel: state === 'cancelled' ? { reason: null } : null,
          },
        };
      }
      default: throw new Error(`fixture does not simulate ${tool}`);
    }
  };
  return { call, calls, byName };
}
