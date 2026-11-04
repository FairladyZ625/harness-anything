// harness-test-tier: integration
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { pgRuntimeFixture } from "../../storage/test/postgres/pg-runtime.fixture.ts";
import { assertRepoCellStorage } from "./repo-cell-storage.fixture.ts";

test("a PG RepoCell writes through its worker, restarts, and keeps SQLite closed", async () => {
  const fixture = await pgRuntimeFixture(),
    rootDir = path.join(fixture.root, "repository"),
    storage = {
      backend: "postgres" as const,
      connectionString: fixture.connectionString,
      authorityConnectionString: fixture.managementConnectionString,
      scope: { tenantId: "tenant", projectId: "project", readers: ["person-1"], policyEpoch: 1 },
    };
  try {
    await assertRepoCellStorage(rootDir, storage);
    assert.equal(existsSync(`${rootDir}.harness-anything-writer.lock`), false);
    assert.deepEqual(
      readdirSync(rootDir, { recursive: true })
        .map(String)
        .filter((name) => /\.sqlite(?:$|-)/u.test(name)),
      [],
    );
    console.log("PG_REPO_CELL restart=readable SQLiteFiles=0");
  } finally {
    await fixture.pool.end();
    await fixture.close();
  }
});
