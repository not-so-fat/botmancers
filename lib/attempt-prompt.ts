// NOT-542: deterministic AttemptPrompt rendering shared by every runtime
// adapter. A text prompt passes through verbatim; a conversation renders as
// the system prompt plus the ordered transcript (the agent's own turns as
// 'you', everyone else under their speaker label). Pure and stable: the same
// frozen prompt always renders byte-identically, so launch intents and
// idempotency hashes derived from it replay safely.
import type { AttemptPrompt } from './attempt-adapter';

export function attemptPromptText(prompt: AttemptPrompt): string {
  if (prompt.kind === 'text') return prompt.text;
  const transcript = prompt.history
    .map(entry => `[${entry.fromAgent ? 'you' : entry.speakerLabel}] ${entry.content}`)
    .join('\n\n');
  return `${prompt.system}\n\nConversation so far (reply to the last message):\n\n${transcript}`;
}
