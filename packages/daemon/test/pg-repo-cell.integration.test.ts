// harness-test-tier: integration
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, mkdirSync } from "node:fs";
import path from "node:path";
import { pgRuntimeFixture } from "../../storage/test/postgres/pg-runtime.fixture.ts";
import { openBootstrappedRepoCell } from "./repo-settings.fixture.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import type { RepoCell } from "../src/repo-cell-types.ts";

test("a PG RepoCell writes through its worker, restarts, and keeps SQLite closed", async () => {
  const fixture = await pgRuntimeFixture(),
    rootDir = path.join(fixture.root, "repository"),
    storage = {
      backend: "postgres" as const,
      connectionString: fixture.connectionString,
      authorityConnectionString: fixture.managementConnectionString,
      scope: { tenantId: "tenant", projectId: "project", readers: ["person-1"], policyEpoch: 1 },
    },
    binding = withPolicyGroup(
      { actor: { principal: { personId: "person-1" }, executor: null }, source: "local" as const },
      "maintainer",
    );
  mkdirSync(rootDir, { recursive: true });
  const input = { rootDir: canonicalRoot(rootDir), repoId: workspaceId("pg-cell"), ownerId: "pg-center", storage };
  let cell: RepoCell | undefined;
  try {
    cell = await openBootstrappedRepoCell(input);
    const created = await cell.run(
      { kind: "task-create", taskId: "task-pg-cell", title: "PG daemon task", riskTier: "low" },
      binding,
    );
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    const read = await cell.run({ kind: "task-show", taskId: "task-pg-cell" }, binding);
    assert.equal(read.outcome, "applied", JSON.stringify(read));
    await cell.close();
    cell = undefined;
    cell = await openBootstrappedRepoCell(input);
    const reread = await cell.run({ kind: "task-show", taskId: "task-pg-cell" }, binding);
    assert.equal(reread.outcome, "applied", JSON.stringify(reread));
    assert.equal(existsSync(`${rootDir}.harness-anything-writer.lock`), false);
    assert.deepEqual(
      readdirSync(rootDir, { recursive: true })
        .map(String)
        .filter((name) => /\.sqlite(?:$|-)/u.test(name)),
      [],
    );
    console.log("PG_REPO_CELL restart=readable SQLiteFiles=0");
  } finally {
    await cell?.close();
    await fixture.pool.end();
    await fixture.close();
  }
});
