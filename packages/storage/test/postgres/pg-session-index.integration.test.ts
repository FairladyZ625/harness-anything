// harness-test-tier: integration
import test from "node:test";
import { pgRuntimeFixture } from "./pg-runtime.fixture.ts";
import { assertSessionIndexes } from "./pg-session-index.fixture.ts";

test("PG task sessions and batches exclude unrelated session history", async () => {
  const fixture = await pgRuntimeFixture();
  try {
    await assertSessionIndexes(fixture.pool, fixture.adminPool, "postgres");
  } finally {
    await fixture.pool.end();
    await fixture.close();
  }
});
