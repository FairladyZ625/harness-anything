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
import { REPOSITORY_READ_TABLES_SQL } from "../../storage/src/projection/projection-tables.ts";
import {
  backfillRuntimeReadIndexPage,
  ensureRuntimeMemberIndex,
} from "../../storage/src/projection/runtime-member-index.ts";
import { openRepoWriterCell } from "../src/repo-cell-open.ts";
import { acquireWorkspaceLock } from "../src/repo-cell-lock.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { installSqliteWorkProbe, resetSqliteWork, snapshotSqliteWork } from "./fixtures/g38-sqlite-work.mjs";
import { policyTestCenter } from "./keycloak-policy.fixtures.ts";
import { openBootstrappedRepoCell } from "./repo-settings.fixture.ts";
import { seedLegacyReadIndexEvents } from "./online-read-index.fixture.ts";

for (const missingLegacy of [false, true])
  test(`real writer attach executes zero backfill pages and constant SQL work at 10000/100000 events (missing legacy=${missingLegacy})`, async (t) => {
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
        if (missingLegacy) {
          const cache = new DatabaseSync(resolveHarnessLayout(root).taskProjectionPath);
          try {
            for (const row of cache
              .prepare(
                "SELECT name FROM sqlite_master WHERE type='index' AND (name LIKE 'event_index_runtime_member_%' OR name LIKE 'event_index_runtime_dispatch_key%')",
              )
              .all())
              cache.exec(`DROP INDEX ${row.name}`);
            for (const row of cache
              .prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'runtime_dispatch_%'")
              .all())
              cache.exec(`DROP TRIGGER ${row.name}`);
            cache.exec(
              "ALTER TABLE event_index DROP COLUMN dispatch_key; ALTER TABLE event_index DROP COLUMN runtime_session_present",
            );
          } finally {
            cache.close();
          }
        }
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
              missingLegacy,
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

test("the legacy table cut-over has constant native work after 1000/10000 copied rows", (t) => {
  installSqliteWorkProbe();
  const counts = [];
  for (const events of [1000, 10000]) {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("PRAGMA foreign_keys=ON");
      db.exec(REPOSITORY_READ_TABLES_SQL);
      const insert = db.prepare("INSERT INTO event_index(op_id,workspace_revision,event_json) VALUES(?,?,'{}')");
      db.exec("BEGIN");
      for (let n = 1; n <= events; n++) insert.run(`op-${n}`, n);
      db.exec("COMMIT");
      ensureRuntimeMemberIndex(db);
      let processed = 0;
      while (processed < events) processed += backfillRuntimeReadIndexPage(db).processed;
      resetSqliteWork();
      const page = backfillRuntimeReadIndexPage(db),
        native = snapshotSqliteWork();
      assert.deepEqual(page, { processed: 0, done: true });
      assert.equal(db.prepare("SELECT count(*) AS n FROM event_index").get()!.n, events);
      assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name='runtime_event_index_retired'").get());
      counts.push({ events, ...native });
    } finally {
      db.close();
    }
  }
  t.diagnostic(`LEGACY_CUTOVER_COUNTS ${JSON.stringify(counts)}`);
  assert.equal(counts[0]!.sqliteVmSteps, counts[1]!.sqliteVmSteps);
  assert.equal(counts[0]!.sqliteScanPages, counts[1]!.sqliteScanPages);
});
