// harness-test-tier: integration
import test from "node:test";
import { pgRuntimeFixture } from "./pg-runtime.fixture.ts";
import { assertTaskStatusCost } from "./pg-task-status-cost.fixture.ts";

test("PG raw and presentation task reads exclude unrelated task history", async () => {
  const fixture = await pgRuntimeFixture();
  try {
    await assertTaskStatusCost(fixture.pool, fixture.adminPool, "postgres");
  } finally {
    await fixture.pool.end();
    await fixture.close();
  }
});
