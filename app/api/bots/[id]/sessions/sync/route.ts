import { NextResponse } from 'next/server';
import db from '@/lib/db';
import { agentExists } from '@/lib/session-catalog';
import { agentProviderCapabilities, ProviderSessionError, recordSyncCompleted, recordSyncFailed, syncAgentSessionHistory } from '@/lib/provider-sessions';
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
      // NOT-547: the drawer reads the last outcome from GET .../sessions.
      recordSyncCompleted(db, id, {
        imported: synced.imported.length,
        rejected_out_of_scope: synced.rejected_out_of_scope,
        complete: synced.complete,
        now: Date.now(),
      });
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
      // NOT-547: the empty-success classification matches
      // syncHistoryAtRegistration (lib/provider-sessions): only a provider
      // that can never list ('unsupported') or an Agent with no session
      // provider at all (Hermes, whose agentContext is
      // 'provider_unavailable') completes empty. A missing CLI, a missing
      // scope, or a broken listing is a failure: it records sync_failed so
      // the drawer keeps its reason and Retry instead of showing the
      // misleading empty list.
      let empty = error instanceof ProviderSessionError && error.code === 'unsupported';
      if (!empty && error instanceof ProviderSessionError && error.code === 'provider_unavailable') {
        try {
          empty = agentProviderCapabilities(db, id) === null;
        } catch {
          empty = false;
        }
      }
      if (empty) {
        recordSyncCompleted(db, id, { imported: 0, rejected_out_of_scope: 0, complete: true, now: Date.now() });
        return NextResponse.json({
          imported: [],
          updated: [],
          rejected_out_of_scope: 0,
          complete: true,
          synced_at: agentSessionsSyncedAt(db, id),
        });
      }
      try {
        recordSyncFailed(db, id, {
          error_code: error instanceof ProviderSessionError ? error.code : 'provider_failed',
          now: Date.now(),
        });
      } catch { /* the sync error itself is the response; a broken audit must not mask it */ }
      throw error;
    } finally {
      endAgentSync(id);
    }
  } catch (error) {
    console.error('Error syncing agent sessions:', error);
    return NextResponse.json({ error: 'Failed to sync sessions' }, { status: 500 });
  }
}
