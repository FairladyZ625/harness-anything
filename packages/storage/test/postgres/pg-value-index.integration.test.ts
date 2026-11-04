// harness-test-tier: integration
import test from "node:test";
import { pgRuntimeFixture } from "./pg-runtime.fixture.ts";
import { assertValueIndexes } from "./pg-value-index.fixture.ts";

test("PG value indexes exclude unrelated history under runtime RLS", async () => {
  const fixture = await pgRuntimeFixture();
  try {
    await assertValueIndexes(fixture.pool, fixture.adminPool, "postgres");
  } finally {
    await fixture.pool.end();
    await fixture.close();
  }
});
