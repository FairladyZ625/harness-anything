// harness-test-tier: integration
import test from "node:test";
import * as shared from "./cli-lifecycle-user-journey-stress.fixture.ts";
import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";

const { assert, clientCount, chainsPerClient, runClient, startClient, stopClient, setup } = shared;
const lifecycleConcurrency = 2;

async function runBounded<T>(
  items: readonly T[],
  concurrency: number,
  operation: (item: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      const item = items[currentIndex];
      if (item !== undefined) await operation(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}

test("eight isolated CLI clients complete 24 lifecycle chains", async (context) => {
  const fixtures = Array.from({ length: clientCount }, (_, index) => setup(index));
  const startedAt = Date.now();
  const stopErrors: unknown[] = [];
  try {
    // Bound daemon startup waves so 8 simultaneous bootstraps do not starve sibling CI shard lanes.
    await runBounded(fixtures, lifecycleConcurrency, startClient);
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
    await runBounded(fixtures, lifecycleConcurrency, async (fixture) => {
      try {
        await stopClient(fixture);
      } catch (error) {
        stopErrors.push(error);
      } finally {
        removeTempRepository(fixture.parent);
      }
    });
  }
  if (stopErrors.length > 0) throw stopErrors[0];
});
