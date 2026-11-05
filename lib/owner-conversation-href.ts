// NOT-551: pure href helpers for owner Conversations routes.
// Kept free of Node/db imports so client components can resolve legacy
// `/?agent=` chat links without bundling server-only modules.

// Old `/?agent=` chat links resolve here. Missing direct conversation falls
// back to the Agent Conversations index; an exchange focus is preserved.
export function legacyAgentChatHref(
  agentId: string,
  conversationId: string | null | undefined,
  exchange?: string | null,
): string {
  const base = conversationId
    ? `/agents/${encodeURIComponent(agentId)}/conversations/${encodeURIComponent(conversationId)}`
    : `/agents/${encodeURIComponent(agentId)}/conversations`;
  return exchange ? `${base}?exchange=${encodeURIComponent(exchange)}` : base;
}
