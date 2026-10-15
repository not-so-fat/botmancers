// NOT-475: the Wake safety outcomes the owner's thread shows from the
// projected conversation read model (lib/conversation-projection). Pure, so
// the thread and its tests agree on what is visible and what is actionable.
//
// Shown: a blocked Wake (with Allow / Deny only while it is still the
// latest word on its request), a rejected Wake, a stopped lineage, a Wake
// the owner (or a recovered target) admitted, an owner Deny, and allowed
// work waiting for capacity. Ordinary request lifecycle stays out of the
// thread; the messages already tell that story.

export interface WakeEventView {
  eventId: string;
  kind: string;
  requestId: string | null;
  wakeId: string | null;
  text: string;
  data: Record<string, unknown>;
  createdAt: number;
}

export type WakeNoticeTone = 'blocked' | 'rejected' | 'allowed' | 'denied' | 'waiting' | 'stopped';

export interface WakeNotice {
  eventId: string;
  wakeId: string | null;
  tone: WakeNoticeTone;
  text: string;
  // Allow / Deny offered for this notice now.
  actionable: boolean;
  createdAt: number;
}

function toneOf(event: WakeEventView): WakeNoticeTone | null {
  switch (event.kind) {
    case 'wake_blocked': return 'blocked';
    case 'wake_rejected': return 'rejected';
    case 'lineage_stopped': return 'stopped';
    // Admitted out of a block (owner Allow, recovered target).
    case 'wake_accepted': return typeof event.data.reason === 'string' ? 'allowed' : null;
    case 'request_cancelled': return event.data.reason === 'grant_denied' ? 'denied' : null;
    case 'request_queued': return event.data.waiting_for === 'capacity' ? 'waiting' : null;
    default: return null;
  }
}

export function wakeNotices(events: WakeEventView[]): WakeNotice[] {
  const notices: WakeNotice[] = [];
  events.forEach((event, index) => {
    const tone = toneOf(event);
    if (!tone) return;
    const actions = Array.isArray(event.data.actions) ? event.data.actions : [];
    // Any later event on the same request (accepted, cancelled, re-blocked)
    // supersedes this block.
    const superseded = event.requestId !== null
      && events.slice(index + 1).some(later => later.requestId === event.requestId);
    notices.push({
      eventId: event.eventId,
      wakeId: event.wakeId,
      tone,
      text: event.text,
      actionable: tone === 'blocked' && !!event.wakeId && actions.includes('allow') && actions.includes('deny') && !superseded,
      createdAt: event.createdAt,
    });
  });
  return notices;
}
