// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import test from "node:test";
import { resolveHarnessLayout } from "@harness-anything/kernel";
import { openPersistentWriterEpoch, readLedgerWriterEpoch } from "@harness-anything/storage";
import { withTempStoreAsync } from "../../storage/test/store/helpers.ts";
import { countSqliteWork } from "../../storage/test/store/sqlite-work-counter.fixture.ts";
import { openRepoWriterCell } from "../src/repo-cell-open.ts";
import { acquireWorkspaceLock } from "../src/repo-cell-lock.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { installSqliteWorkProbe, resetSqliteWork, snapshotSqliteWork } from "./fixtures/g38-sqlite-work.mjs";
import { policyTestCenter } from "./keycloak-policy.fixtures.ts";
import { openBootstrappedRepoCell } from "./repo-settings.fixture.ts";
import { seedLegacyReadIndexEvents } from "./online-read-index.fixture.ts";

test("real writer attach executes zero backfill pages and constant SQL work at 10000/100000 events", async (t) => {
  installSqliteWorkProbe();
  const counts = [];
  for (const events of [10000, 100000])
    await withTempStoreAsync(async (root) => {
      execFileSync("git", ["init", "-q", root]);
      const rootDir = canonicalRoot(root),
        repoId = workspaceId(`attach-cost-${events}`),
        ownerId = "attach-cost",
        input = { rootDir, repoId, ownerId };
      await (await openBootstrappedRepoCell(input)).close();
      seedLegacyReadIndexEvents(root, events);
      const stateRoot = path.join(resolveHarnessLayout(root).localRoot, "cost-writer-epochs"),
        authority = openPersistentWriterEpoch({ stateRoot, holderId: ownerId }),
        lease = authority.acquire(repoId, readLedgerWriterEpoch(repoId, root));
      authority.close();
      resetSqliteWork();
      const lock = await acquireWorkspaceLock(rootDir),
        // Native VM probe owns the scan observation; result counting adds no observer SQL.
        work = countSqliteWork(t, false),
        started = performance.now(),
        phases: {
          phase: string;
          elapsedMs: number;
          sql: ReturnType<typeof work.totals>;
          native: ReturnType<typeof snapshotSqliteWork>;
        }[] = [];
      const cell = await openRepoWriterCell(
        {
          ...input,
          onOpenProgress: (progress) =>
            phases.push({
              phase: progress.phase,
              elapsedMs: performance.now() - started,
              sql: work.totals("attach"),
              native: snapshotSqliteWork(),
            }),
          keycloakCenter: policyTestCenter,
          defaultWriterEpochFence: {
            schema: "harness-writer-epoch-fence/v1",
            stateRoot,
            repoId,
            holderId: lease.holderId,
            epoch: lease.epoch,
          },
        },
        lock,
      );
      const attachMs = performance.now() - started,
        attach = work.totals("attach"),
        native = snapshotSqliteWork();
      work.stop();
      try {
        // This is the actual writer open used by the proxy worker. No setImmediate maintenance turn
        // has run at this promise boundary; inspection is synchronous and outside the measured work.
        const inspect = new DatabaseSync(resolveHarnessLayout(root).taskProjectionPath, { readOnly: true });
        try {
          assert.equal(cell.status().state, "attached");
          assert.equal(inspect.prepare("SELECT revision FROM runtime_read_index_progress").get()!.revision, 0);
          assert.equal(inspect.prepare("SELECT count(*) AS n FROM runtime_dispatch_index").get()!.n, 0);
          const grouped = new Map<
            string,
            { calls: number; returnedRows: number; indexInputRows: number; elapsedMs: number }
          >();
          for (const statement of work.statements) {
            const group = grouped.get(statement.sql) ?? {
              calls: 0,
              returnedRows: 0,
              indexInputRows: 0,
              elapsedMs: 0,
            };
            group.calls++;
            group.returnedRows += statement.returnedRows;
            group.indexInputRows += statement.indexInputRows;
            group.elapsedMs += statement.elapsedMs;
            grouped.set(statement.sql, group);
          }
          counts.push({
            events,
            attachMs,
            attach,
            native,
            phases,
            nonExecutionRemainderMs: attachMs - attach.elapsedMs,
            statements: [...grouped].map(([sql, group]) => ({ sql, ...group })),
          });
        } finally {
          inspect.close();
        }
      } finally {
        await cell.close();
      }
    });
  t.diagnostic(`WRITER_ATTACH_COUNTS ${JSON.stringify(counts)}`);
  // Native VM/page counts include SQLite's internal scans and trigger work, unlike result rows.
  assert.equal(counts[0]!.native.sqliteVmSteps, counts[1]!.native.sqliteVmSteps);
  assert.equal(counts[0]!.native.sqliteScanPages, counts[1]!.native.sqliteScanPages);
  assert.equal(counts[0]!.attach.returnedRows, counts[1]!.attach.returnedRows);
  assert.equal(counts[0]!.attach.statements, counts[1]!.attach.statements);
});
