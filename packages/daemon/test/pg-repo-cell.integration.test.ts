// harness-test-tier: integration
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, mkdirSync } from "node:fs";
import path from "node:path";
import { pgRuntimeFixture } from "../../storage/test/postgres/pg-runtime.fixture.ts";
import { execFileSync } from "node:child_process";
import threads, { type WorkerOptions } from "node:worker_threads";
import { syncBuiltinESMExports } from "node:module";
import { openBootstrappedRepoCell } from "./repo-settings.fixture.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";
import { backfillPgReadIndexPage } from "../../storage/src/pg/pg-read-index-backfill.ts";
import { readTaskWorktreeExecutionBinding } from "../src/task-worktree.ts";
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

test("PG task starts remain applied during missing-index and pending-row lease migrations", async (t) => {
  const fixture = await pgRuntimeFixture(),
    rootDir = path.join(fixture.root, "start-repository"),
    scope = { tenantId: "start", projectId: "start", policyEpoch: 1 },
    storage = {
      backend: "postgres" as const,
      connectionString: fixture.connectionString,
      authorityConnectionString: fixture.managementConnectionString,
      scope,
    },
    binding = withPolicyGroup(
      {
        actor: { principal: { personId: "person-owner" }, executor: { kind: "agent" as const, id: "worker" } },
        source: "local" as const,
      },
      "admin",
    );
  mkdirSync(rootDir, { recursive: true });
  const input = {
    rootDir: canonicalRoot(rootDir),
    repoId: workspaceId("lease-start"),
    ownerId: "lease-start",
    storage,
  };
  execFileSync("git", ["init", "-q", rootDir]);
  execFileSync("git", ["-C", rootDir, "config", "user.name", "Lease Test"]);
  execFileSync("git", ["-C", rootDir, "config", "user.email", "lease@example.invalid"]);
  execFileSync("git", ["-C", rootDir, "commit", "--allow-empty", "-qm", "base"]);
  // Deterministically hold only the background scheduler. Reads and writes use the real worker,
  // runtime role and database. No sleeps or simulated query errors define the migration window.
  const NativeWorker = threads.Worker;
  t.mock.method(
    threads,
    "Worker",
    class extends NativeWorker {
      constructor(filename: string | URL, options: WorkerOptions = {}) {
        const writer = String(filename).includes("repo-writer-worker.") && options.workerData?.role !== "reader";
        const preload = `const schedule=globalThis.setImmediate; globalThis.setImmediate=(fn,...args)=>schedule(fn.name==='backfillReadIndexes'?()=>{}:fn,...args);`;
        super(
          filename,
          writer
            ? {
                ...options,
                execArgv: [
                  ...(options.execArgv ?? []),
                  "--import",
                  `data:text/javascript,${encodeURIComponent(preload)}`,
                ],
              }
            : options,
        );
      }
    },
  );
  syncBuiltinESMExports();
  let cell: Awaited<ReturnType<typeof openBootstrappedRepoCell>> | undefined;
  try {
    cell = await openBootstrappedRepoCell(input);
    const taskId = "task-lease-start",
      executionId = "execution-lease-start";
    const created = await cell.run({ kind: "task-create", taskId, title: "Lease migration" }, binding);
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    await cell.settlePendingMaterialization("lease migration fixture");
    const packagePath = created.packagePath!;
    await realizeTaskPlanFixture(rootDir, packagePath, (planPath: string) =>
      cell!.run({ kind: "doc-submit", paths: [planPath] }, binding),
    );
    await fixture.adminPool.query("DROP INDEX ha_projection_interval_order");
    await fixture.adminPool.query(`INSERT INTO ha_read_index_build(index_name,table_name,statement,complete)
      VALUES('ha_projection_interval_order','ha_projection_values','fixture',false)
      ON CONFLICT(index_name) DO UPDATE SET complete=false`);
    const start = () => cell!.run({ kind: "task-start", taskId, executionId }, binding);
    const read = () =>
      cell!.read("repo.tasks.document.read", { taskId, path: "task_plan.md", view: "execution", executionId });
    const first = await start();
    assert.equal(first.outcome, "applied", JSON.stringify(first));
    assert.match(String(first.warnings), /execution marker was not written.*progress/u);
    assert.equal((await read()).source, "unobservable");
    const worktree = path.join(rootDir, ".worktrees", taskId);
    assert.equal(readTaskWorktreeExecutionBinding(worktree, executionId).binding, null);
    // Real physical build completed, but historical derived acquisition fields are still pending.
    await fixture.adminPool.query(`CREATE INDEX ha_projection_interval_order ON ha_projection_values
      (tenant_id,project_id,policy_epoch,owner_id,order_revision) WHERE model='lease-interval'`);
    await fixture.adminPool.query(
      "UPDATE ha_read_index_build SET complete=true WHERE index_name='ha_projection_interval_order'",
    );
    // Release updates the prior interval and requires its migration to be ready before admission.
    // Restore that prerequisite before arranging the next start's distinct pending window.
    const released = await cell.run({ kind: "task-release", taskId }, binding);
    assert.equal(released.outcome, "applied", JSON.stringify(released));
    await fixture.adminPool.query(`INSERT INTO ha_projection_values
      (tenant_id,project_id,policy_epoch,model,owner_id,entity_id,workspace_revision,value)
      VALUES('start','start',1,'lease-interval','other','legacy',1,
        '{"taskId":"other","executionId":"old","acquiredRevision":1,"releasedRevision":2}')`);
    await fixture.adminPool.query(
      "UPDATE ha_projection_values SET read_index_version=0,order_revision=NULL WHERE entity_id='legacy'",
    );
    const second = await start();
    assert.equal(second.outcome, "applied", JSON.stringify(second));
    assert.match(String(second.warnings), /execution marker was not written.*progress/u);
    assert.equal((await read()).source, "unobservable");
    assert.equal(readTaskWorktreeExecutionBinding(worktree, executionId).binding, null);
    for (let turn = 0; ; turn++) {
      assert.ok(turn < 30);
      if ((await backfillPgReadIndexPage(fixture.pool, scope, input.repoId)).done) break;
    }
    assert.equal(
      (await read()).source,
      "unobservable",
      "completion cannot invent a marker for an earlier unobserved start",
    );
    assert.equal((await cell.run({ kind: "task-release", taskId }, binding)).outcome, "applied");
    const ready = await start();
    assert.equal(ready.outcome, "applied", JSON.stringify(ready));
    assert.doesNotMatch(String(ready.warnings), /execution marker was not written/u);
    const marker = readTaskWorktreeExecutionBinding(worktree, executionId).binding;
    assert.ok(marker);
    assert.equal((await read()).source, "execution");
    // An existing marker also becomes explicitly unobservable if the generation index is pending.
    await fixture.adminPool.query(
      "UPDATE ha_read_index_build SET complete=false WHERE index_name='ha_projection_interval_order'",
    );
    const pending = await read();
    assert.equal(pending.source, "unobservable");
    assert.equal(pending.unobservableReason, "execution_lease_generation_pending");
    await fixture.adminPool.query(
      "UPDATE ha_read_index_build SET complete=true WHERE index_name='ha_projection_interval_order'",
    );
    assert.equal((await read()).source, "execution");
    assert.deepEqual(readTaskWorktreeExecutionBinding(worktree, executionId).binding, marker);
    t.diagnostic(
      "PG_START_MIGRATION missing-tree=applied-warning data-pending=applied-warning ready=execution same-execution-reentry=verified",
    );
  } finally {
    await cell?.close();
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await fixture.pool.end();
    await fixture.close();
  }
});
