// harness-test-tier: integration
import { join } from "node:path";
import test from "node:test";
import { assertInboxBackendParity, assertInboxReopenedReads } from "../inbox-parity.assertions.ts";
import { pgRuntimeFixture } from "./pg-runtime.fixture.ts";

test("(e) real PostgreSQL answers every Inbox read exactly like SQLite, before and after reopening", async () => {
  const fixture = await pgRuntimeFixture(),
    rootDir = join(fixture.root, "workspace"),
    repoId = "pg-inbox",
    storage = {
      backend: "postgres" as const,
      connectionString: fixture.connectionString,
      scope: { tenantId: "tenant", projectId: "project", readers: ["person-fixture"], policyEpoch: 1 },
    };
  try {
    const expected = await assertInboxBackendParity({ rootDir, repoId, storage });
    await assertInboxReopenedReads({ rootDir, repoId, storage, expected });
  } finally {
    await fixture.pool.end();
    await fixture.close();
  }
});
