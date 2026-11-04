import { NextResponse } from 'next/server';
import db from '@/lib/db';
import { agentExists } from '@/lib/session-catalog';
import { ProviderSessionError, syncAgentSessionHistory } from '@/lib/provider-sessions';
import { agentSessionsSyncedAt, endAgentSync, tryBeginAgentSync } from '@/lib/session-sync-refresh';

// NOT-545: the owner's manual refresh of one Agent's session catalog. Runs
// one full-history sync (lib/provider-sessions syncAgentSessionHistory,
// already page-capped) and returns what it did plus the catalog's new
// freshness. Behind the owner boundary (proxy.ts): a mutating request, so
// same-origin proof is required. 409 sync_in_progress when a sync for this
// Agent is already running (the loop's or another manual one); 404 for an
// unknown Agent.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    if (!agentExists(db, id)) return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    if (!tryBeginAgentSync(id)) {
      return NextResponse.json(
        { error: { code: 'sync_in_progress', message: 'A session sync for this Agent is already running.' } },
        { status: 409 }
      );
    }
    try {
      const synced = await syncAgentSessionHistory(db, id);
      return NextResponse.json({
        imported: synced.imported,
        updated: synced.updated,
        rejected_out_of_scope: synced.rejected_out_of_scope,
        complete: synced.complete,
        synced_at: agentSessionsSyncedAt(db, id),
      });
    } catch (error) {
      if (error instanceof ProviderSessionError && error.code === 'agent_not_found') {
        return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
      }
      if (
        error instanceof ProviderSessionError
        && (error.code === 'provider_unavailable' || error.code === 'unsupported' || error.code === 'scope_missing')
      ) {
        // Nothing to sync from: the Agent has no session provider, the
        // provider cannot list, or no scope selects anything. An empty
        // sync, not a failure.
        return NextResponse.json({
          imported: [],
          updated: [],
          rejected_out_of_scope: 0,
          complete: true,
          synced_at: agentSessionsSyncedAt(db, id),
        });
      }
      throw error;
    } finally {
      endAgentSync(id);
    }
  } catch (error) {
    console.error('Error syncing agent sessions:', error);
    return NextResponse.json({ error: 'Failed to sync sessions' }, { status: 500 });
  }
}
