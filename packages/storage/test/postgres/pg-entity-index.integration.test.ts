// harness-test-tier: integration
import test from "node:test";
import { pgRuntimeFixture } from "./pg-runtime.fixture.ts";
import { assertEntityIndexes } from "./pg-entity-index.fixture.ts";

test("PG current declarations skip 100k deleted identities and require complete rebuild after a writer gap", async () => {
  const fixture = await pgRuntimeFixture();
  try {
    await assertEntityIndexes(fixture.pool, fixture.adminPool, "postgres");
  } finally {
    await fixture.pool.end();
    await fixture.close();
  }
});
