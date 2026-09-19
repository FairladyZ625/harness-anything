// harness-test-tier: integration
import test from "node:test";
import * as shared from "./cli-lifecycle-user-journey-stress.fixture.ts";

const { assert, rmSync, clientCount, chainsPerClient, runClient, startClient, stopClient, setup } = shared;

test("eight isolated CLI clients complete 24 lifecycle chains", async (context) => {
  const fixtures = Array.from({ length: clientCount }, (_, index) => setup(index));
  const startedAt = Date.now();
  try {
    for (const fixture of fixtures) await startClient(fixture);
    const outcomes = await Promise.all(fixtures.map((fixture, index) => runClient(fixture, index)));
    const chains = outcomes.flat();
    assert.equal(chains.length, clientCount * chainsPerClient);
    assert.equal(chains.filter((chain) => chain.status === "done").length, chains.length);
    assert.equal(new Set(chains.map((chain) => chain.taskId)).size, chains.length);
    context.diagnostic(
      JSON.stringify({
        schema: "cli-lifecycle-stress/v1",
        clients: clientCount,
        chains: chains.length,
        actors: outcomes.map(({ actor }) => actor),
        elapsedMs: Date.now() - startedAt,
        chainElapsedMs: chains.map(({ elapsedMs }) => elapsedMs),
      }),
    );
  } finally {
    for (const fixture of fixtures) {
      await stopClient(fixture);
      rmSync(fixture.parent, { recursive: true, force: true });
    }
  }
});
