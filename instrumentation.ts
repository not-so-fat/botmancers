// NOT-518: the core server's lifecycle hook (Next calls register() once when
// the server process starts). Starts the Slack relay's native Socket Mode
// transport (lib/slack-runtime) in this process and stops it on shutdown,
// without reconnecting. Slack stays off unless both Slack tokens and a valid
// session-shares.json are present; BOTMANCERS_NO_AUTOPROCESS=1 (tests and
// scripts that import the engine) keeps it off as well.
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs' || process.env.BOTMANCERS_NO_AUTOPROCESS === '1') return;
  const { startSlackRuntime, stopSlackRuntime } = await import('./lib/slack-runtime');
  const shutdown = () => { stopSlackRuntime().catch(() => {}); };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  startSlackRuntime().catch(error => console.error('Slack relay:', error instanceof Error ? error.message : 'start failed'));
}
