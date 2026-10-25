// NOT-518: the core server's lifecycle hook (Next calls register() once when
// the server process starts). Runs the Slack relay's native Socket Mode
// transport in this process (lib/slack-runtime: started now, stopped on
// SIGTERM/SIGINT without reconnecting). Slack stays off unless both Slack
// tokens and a valid session-shares.json are present.
// NOT-519: and the expired-share sweeper (lib/session-share-owner): once at
// start, then every minute.
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { runSlackInServer } = await import('./lib/slack-runtime');
  runSlackInServer();
  const { runShareSweeperInServer } = await import('./lib/session-share-owner');
  runShareSweeperInServer();
}
