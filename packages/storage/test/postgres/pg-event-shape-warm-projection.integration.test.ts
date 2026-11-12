// harness-test-tier: integration
import test from "node:test";
import { pgRuntimeFixture } from "./pg-runtime.fixture.ts";
import { assertCrossRepoShapeReplay } from "./event-shape-warm-replay.fixture.ts";

test("PG replays a new low-revision migration without losing another repository's warm state", async () => {
  const fixture = await pgRuntimeFixture();
  try {
    await assertCrossRepoShapeReplay(fixture.pool);
  } finally {
    try {
      await fixture.pool.end();
    } finally {
      await fixture.close();
    }
  }
});
