// harness-test-tier: integration
import test from "node:test";
import { pgRuntimeFixture } from "./pg-runtime.fixture.ts";
import { assertEventIndexes } from "./pg-event-index.fixture.ts";

test("PG event scalar indexes exclude unrelated history under runtime RLS", async () => {
  const fixture = await pgRuntimeFixture();
  try {
    await assertEventIndexes(fixture.pool, fixture.adminPool, "postgres");
  } finally {
    await fixture.pool.end();
    await fixture.close();
  }
});
