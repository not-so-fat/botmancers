// One-line roster preview of an agent's latest message.
import { parseRun, runLine } from './run';
import { agentEventDisplay } from './bot-runtime-ui';
import { classifyRuntimeFailure } from './runtime-failure';

export function latestLine(content?: string) {
  if (!content) return '';
  const run = parseRun(content);
  if (run) return runLine(run);
  // NOT-449: a known runtime failure previews as its short state, never
  // as the raw sentinel attributed to the agent.
  const failure = classifyRuntimeFailure(content);
  if (failure) return failure.title;
  const event = agentEventDisplay(content);
  if (event) return `${event.label} ${event.detail}`.replace(/\s+/g, ' ').trim();
  return content.replace(/\s+/g, ' ').trim();
}
