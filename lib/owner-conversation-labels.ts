// Pure label helpers for owner Conversations. Kept free of Node/db imports so
// client components can use them without bundling server-only modules.

import type { OwnerConversationSummary } from './owner-conversations';

/** Legacy multi-party rows stay readable; UI must not surface Group product copy. */
export function isOwnerGroupConversation(type: OwnerConversationSummary['type']): boolean {
  return type === 'group';
}

export function ownerConversationTypeLabel(row: Pick<OwnerConversationSummary, 'type' | 'origin'>): string {
  if (row.type === 'direct') return 'Direct';
  if (isOwnerGroupConversation(row.type)) return 'Shared';
  if (row.origin?.kind === 'service') return 'External service';
  return 'Agent to agent';
}

export function ownerConversationEyebrow(row: Pick<OwnerConversationSummary, 'type' | 'origin'>): string {
  if (row.type === 'direct') return 'Direct conversation';
  if (isOwnerGroupConversation(row.type)) return 'Shared history';
  if (row.origin?.kind === 'service') return 'External-service history';
  return 'Agent-to-agent history';
}
