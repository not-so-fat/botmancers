// NOT-494: core health for `botmancers status` and the supervisor. Reports
// the release this server was built as (inlined by next.config at build
// time, "dev" in a checkout) and proves the engine's database answers.
// Loopback-only like every UI route (proxy.ts); no secrets, no writes.
import db from '@/lib/db';
import { botmancersHome } from '@/lib/home';
import { slackRuntimeStatus } from '@/lib/slack-runtime';

export const dynamic = 'force-dynamic';

export async function GET() {
  let engine: 'ok' | 'error' = 'ok';
  try {
    db.prepare('SELECT 1').get();
  } catch {
    engine = 'error';
  }
  return Response.json(
    {
      status: engine === 'ok' ? 'ok' : 'degraded',
      service: 'botmancers-core',
      version: process.env.BOTMANCERS_BUILD_VERSION,
      commit: process.env.BOTMANCERS_BUILD_COMMIT,
      engine,
      home: botmancersHome(),
      // NOT-518: the Slack relay's state and reason, never a token.
      slack: slackRuntimeStatus(),
    },
    { status: engine === 'ok' ? 200 : 503, headers: { 'cache-control': 'no-store' } },
  );
}
