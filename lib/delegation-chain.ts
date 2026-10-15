// NOT-477: durable delegation accounting for UI thread turns
// (delegation_chains, engine migration 15). One chain per user message in
// a UI thread: handoffs count against the depth limit, delegated turns
// against the budget, Stop marks it stopped, and each handoff pushes a
// caller frame the delegate's reply returns to. Every read and write goes
// to the database, so a restart keeps Stop, the limits, and the pending
// report-backs; nothing is held in process memory. A later user message
// starts a fresh chain (its own row); the earlier row is left as it was.
import db from './db';

export interface DelegationFrame {
  delegateId: string;
  callerId: string;
}

export interface DelegationChainState {
  userMessageId: string;
  handoffs: number;
  turns: number;
  stopped: boolean;
  frames: DelegationFrame[];
}

interface ChainRow {
  conversation_id: string;
  user_message_id: string;
  handoffs: number;
  turns: number;
  stopped: number;
  frames: string;
}

function stateOf(row: ChainRow): DelegationChainState {
  return {
    userMessageId: row.user_message_id,
    handoffs: row.handoffs,
    turns: row.turns,
    stopped: row.stopped === 1,
    frames: JSON.parse(row.frames) as DelegationFrame[],
  };
}

export class DelegationChain {
  constructor(readonly conversationId: string, readonly userMessageId: string) {}

  private row(): ChainRow {
    return db.prepare('SELECT * FROM delegation_chains WHERE conversation_id = ? AND user_message_id = ?')
      .get(this.conversationId, this.userMessageId) as ChainRow;
  }

  private update(sql: string, ...args: unknown[]): void {
    db.prepare(`UPDATE delegation_chains SET ${sql}, updated_at = ? WHERE conversation_id = ? AND user_message_id = ?`)
      .run(...args, Date.now(), this.conversationId, this.userMessageId);
  }

  get handoffs(): number { return this.row().handoffs; }
  get turns(): number { return this.row().turns; }
  get stopped(): boolean { return this.row().stopped === 1; }
  get frames(): DelegationFrame[] { return stateOf(this.row()).frames; }

  addHandoffs(count: number): void { this.update('handoffs = handoffs + ?', count); }
  addTurns(count: number): void { this.update('turns = turns + ?', count); }
  stop(): void { this.update('stopped = 1'); }

  pushFrame(frame: DelegationFrame): void {
    db.transaction(() => {
      this.update('frames = ?', JSON.stringify([...this.frames, frame]));
    }).immediate();
  }

  // The caller the delegate's reply returns to (latest frame), if any.
  callerFor(delegateId: string): string | null {
    const frames = this.frames;
    for (let i = frames.length - 1; i >= 0; i--) {
      if (frames[i].delegateId === delegateId) return frames[i].callerId;
    }
    return null;
  }

  // Removes and returns the delegate's latest caller frame.
  popCaller(delegateId: string): string | null {
    return db.transaction((): string | null => {
      const frames = this.frames;
      for (let i = frames.length - 1; i >= 0; i--) {
        if (frames[i].delegateId === delegateId) {
          const callerId = frames[i].callerId;
          frames.splice(i, 1);
          this.update('frames = ?', JSON.stringify(frames));
          return callerId;
        }
      }
      return null;
    }).immediate();
  }

  state(): DelegationChainState {
    return stateOf(this.row());
  }
}

// The chain of this user message, created (empty) on first use.
export function chainFor(conversationId: string, userMessageId: string): DelegationChain {
  const now = Date.now();
  db.prepare(`
    INSERT OR IGNORE INTO delegation_chains (conversation_id, user_message_id, created_at, updated_at)
    VALUES (?, ?, ?, ?)
  `).run(conversationId, userMessageId, now, now);
  return new DelegationChain(conversationId, userMessageId);
}

// The chain of this user message, or null when none was started.
export function existingChain(conversationId: string, userMessageId: string): DelegationChain | null {
  const found = db.prepare('SELECT 1 FROM delegation_chains WHERE conversation_id = ? AND user_message_id = ?')
    .get(conversationId, userMessageId);
  return found ? new DelegationChain(conversationId, userMessageId) : null;
}

// The conversation's most recently started chain, as plain values.
export function latestChainState(conversationId: string): DelegationChainState | null {
  const row = db.prepare(
    'SELECT * FROM delegation_chains WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1'
  ).get(conversationId) as ChainRow | undefined;
  return row ? stateOf(row) : null;
}
