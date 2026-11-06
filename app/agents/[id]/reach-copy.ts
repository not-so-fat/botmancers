// Copy helpers for the Overview "Use from a coding agent" card. Kept outside
// page.tsx so the exact copied strings and the clipboard failure path can be
// tested without a browser (Next.js page files may not export helpers).

export const BRIDGE_CLIENTS = [
  { id: 'cursor', label: 'Cursor' },
  { id: 'codex', label: 'Codex' },
  { id: 'claude', label: 'Claude Code' },
] as const;

export type BridgeClientId = (typeof BRIDGE_CLIENTS)[number]['id'];

export function setupCommand(id: BridgeClientId) {
  return `botmancers setup --client ${id}`;
}

export function askAgentPrompt(agentName: string) {
  return `Use Botmancers to ask ${agentName}: <your question>`;
}

type ClipboardWriter = { writeText(text: string): Promise<void> };

/** Writes text to the clipboard; resolves true only when the write succeeded. */
export async function copyText(text: string, clipboard?: ClipboardWriter): Promise<boolean> {
  try {
    const target = clipboard ?? navigator.clipboard;
    await target.writeText(text);
    return true;
  } catch {
    return false;
  }
}
