// NOT-476: one Botmancers worker process of the restart-recovery scenario.
// Runs inside the scenario's harness root (inherited isolated environment)
// against the scenario's fake Agent Deck over loopback HTTP.
//
//   ROLE=crash    accepts one message and exits abruptly right after the
//                 Agent Deck run id is persisted (a crash mid-run)
//   ROLE=recover  a fresh process: startup recovery, then idle
'use strict';

/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS harness consumed by standalone Node tests. */

const { createContext } = require('./engine-context.js');

const CRASH_EXIT_CODE = 70; // checked by the restart-recovery scenario

async function main() {
  const ctx = createContext(`restart-${process.env.BOTMANCERS_RESTART_ROLE}`, { remoteDeck: true });
  if (process.env.BOTMANCERS_RESTART_ROLE === 'crash') {
    ctx.lib('dispatcher.ts').setDispatchFaultHook(point => {
      if (point === 'after_run_id_persisted') process.exit(CRASH_EXIT_CODE);
    });
    const { dispatched } = ctx.service.acceptAgentMessage(ctx.PERSON, {
      agentId: process.env.BOTMANCERS_RESTART_AGENT_ID,
      content: process.env.BOTMANCERS_RESTART_CONTENT,
      idempotencyKey: 'restart-1',
    });
    await dispatched;
    throw new Error('the crash worker finished its turn instead of crashing');
  }
  await ctx.service.recoverCoordinatorLoops();
  await ctx.service.waitForAgentDispatchIdle();
  process.stdout.write(`RECOVERED ${JSON.stringify({ blocked: ctx.guards.blockedConnections })}\n`);
}

main().then(() => process.exit(0), error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
