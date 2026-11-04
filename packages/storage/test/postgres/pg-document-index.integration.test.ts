// harness-test-tier: integration
import test from "node:test";
import { pgRuntimeFixture } from "./pg-runtime.fixture.ts";
import { assertDocumentIndex } from "./pg-document-index.fixture.ts";

test("PG document prefix reads scan the matching range under runtime RLS", async () => {
  const fixture = await pgRuntimeFixture();
  try {
    await assertDocumentIndex(fixture.pool, fixture.adminPool, "postgres");
  } finally {
    await fixture.pool.end();
    await fixture.close();
  }
});
