// harness-test-tier: integration
import test from "node:test";
import { pgRuntimeFixture } from "./pg-runtime.fixture.ts";
import { assertDecisionSearchEdges } from "./decision-search-edges.fixture.ts";
test("PG positions retain SQLite's complete Unicode61 literal phrase contract", async () => {
  const fixture = await pgRuntimeFixture();
  try {
    await assertDecisionSearchEdges(fixture.adminPool, "postgres");
  } finally {
    await fixture.pool.end();
    await fixture.close();
  }
});
