import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import type { PoolClient, Pool } from "pg";
import type { RelationType } from "@harness-anything/kernel/internal/domain/relation-type-registry.ts";
import {
  auditRelationCycles,
  createTaskRelationProjectionTable,
  readTaskRelationPage,
} from "../../src/projection/task-query-projection.ts";
import { createRelationGraphProjectionTables } from "../../src/projection/relation-graph-projection.ts";
import {
  ensureRelationCycleAudit,
  refreshRelationCycleAudit,
} from "../../src/projection/relation-cycle-audit-projection.ts";
import {
  maintainPgRelationCycleAuditPage,
  readPgRelationCycleAudit,
  backfillPgRelationCycleAuditPage,
  PG_RELATION_CYCLE_TABLES,
} from "../../src/pg/pg-relation-cycle-audit.ts";
import { withPostgresTransaction } from "../../src/postgres/transaction.ts";
import { readRelationsInTransaction } from "../../src/pg/pg-relation-queries.ts";
import type { PgTaskProjectionSource } from "../../src/pg/pg-task-source.ts";
import { withTempStoreAsync } from "../store/helpers.ts";

interface Edge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly type: RelationType;
  readonly state?: "active" | "retired";
  readonly direction?: "directed" | "undirected";
  readonly readers?: readonly string[];
}

type Scope = {
  readonly tenantId: string;
  readonly projectId: string;
  readonly policyEpoch: number;
  readonly readers?: readonly string[];
};
interface CycleBackend {
  readonly pool: Pool;
  readonly projection: PgTaskProjectionSource;
  close(): Promise<void>;
}
type OpenBackend = (root: string, scope: Scope, repoId: string) => Promise<CycleBackend>;

export function relationCycleAuditCases(open: OpenBackend): Readonly<Record<string, () => Promise<void>>> {
  return {
    "PG cache matches SQLite through deep cycles, writes, retirement, replacement and scoped reads": async () => {
      await withTempStoreAsync(async (root) => {
        const scope = { tenantId: "tenant-a", projectId: "project-a", policyEpoch: 1 },
          repoId = "cycle-audit",
          backend = await open(root, scope, repoId),
          sqlite = createSqliteAudit(),
          edges: Edge[] = [];
        try {
          for (let index = 0; index < 24; index += 1)
            edges.push({
              id: `deep-${index.toString().padStart(2, "0")}`,
              source: `task/deep-${index.toString().padStart(2, "0")}`,
              target: `task/deep-${(index + 1).toString().padStart(2, "0")}`,
              type: "depends-on",
            });
          edges.push(
            { id: "deep-close", source: "task/deep-23", target: "task/deep-17", type: "depends-on" },
            { id: "super-ab", source: "decision/a", target: "decision/b", type: "supersedes" },
            { id: "super-ba", source: "decision/b", target: "decision/a", type: "supersedes" },
            { id: "exec-ab", source: "runtime-session/a", target: "task/a", type: "executes" },
            { id: "exec-ba", source: "runtime-session/b", target: "task/b", type: "executes" },
            { id: "derive-ab", source: "task/derive-a", target: "task/derive-b", type: "derives" },
            { id: "derive-ba", source: "task/derive-b", target: "task/derive-a", type: "derives" },
          );
          await insertEdges(backend.pool, scope, edges);
          for (const edge of edges) insertSqliteEdge(sqlite, edge);

          await assert.rejects(backend.projection.readRelationCycleAudit(), { code: "projection_pending" });
          assert.throws(() => auditRelationCycles(sqlite), { code: "projection_pending" });
          await maintainUntilDone(backend.pool, scope);
          refreshRelationCycleAudit(sqlite);
          assertAuditEqual(await backend.projection.readRelationCycleAudit(), auditRelationCycles(sqlite));
          assert.equal(readTaskRelationPage(sqlite, {}).rows.length, edges.length);

          await updateEdge(backend.pool, scope, "derive-ba", "task/derive-c", "active");
          updateSqliteEdge(sqlite, "derive-ba", "task/derive-c", "active");
          await assert.rejects(backend.projection.readRelationCycleAudit(), { code: "projection_pending" });
          await maintainUntilDone(backend.pool, scope);
          refreshRelationCycleAudit(sqlite);
          assertAuditEqual(await backend.projection.readRelationCycleAudit(), auditRelationCycles(sqlite));
          assert.ok(
            !(await backend.projection.readRelationCycleAudit()).issues.some(
              ({ relationType }) => relationType === "derives",
            ),
          );

          const closing = {
            id: "derive-ca",
            source: "task/derive-c",
            target: "task/derive-a",
            type: "derives" as const,
          };
          await insertEdges(backend.pool, scope, [closing]);
          insertSqliteEdge(sqlite, closing);
          await maintainUntilDone(backend.pool, scope);
          refreshRelationCycleAudit(sqlite);
          assertAuditEqual(await backend.projection.readRelationCycleAudit(), auditRelationCycles(sqlite));
          assert.deepEqual(
            (await backend.projection.readRelationCycleAudit()).issues.find(
              ({ relationType }) => relationType === "derives",
            ),
            {
              code: "relation_cycle_detected",
              relationType: "derives",
              nodeRefs: ["task/derive-a", "task/derive-b", "task/derive-c", "task/derive-a"],
              relationIds: ["derive-ab", "derive-ba", "derive-ca"],
            },
          );

          await updateEdge(backend.pool, scope, "derive-ca", "task/derive-a", "retired");
          updateSqliteEdge(sqlite, "derive-ca", "task/derive-a", "retired");
          await assert.rejects(backend.projection.readRelationCycleAudit(), { code: "projection_pending" });
          await maintainUntilDone(backend.pool, scope);
          refreshRelationCycleAudit(sqlite);
          assertAuditEqual(await backend.projection.readRelationCycleAudit(), auditRelationCycles(sqlite));
          assert.ok(
            !(await backend.projection.readRelationCycleAudit()).issues.some(
              ({ relationType }) => relationType === "derives",
            ),
          );

          const otherTenant = { tenantId: "tenant-b", projectId: "project-a", policyEpoch: 1 },
            otherProject = { tenantId: "tenant-a", projectId: "project-b", policyEpoch: 1 };
          await insertEdges(backend.pool, otherTenant, [
            { id: "deep-00", source: "task/deep-00", target: "task/deep-01", type: "depends-on" },
          ]);
          await insertEdges(backend.pool, otherProject, [
            { id: "deep-00", source: "task/deep-00", target: "task/deep-01", type: "depends-on" },
            { id: "deep-close", source: "task/deep-01", target: "task/deep-00", type: "depends-on" },
          ]);
          await maintainUntilDone(backend.pool, otherTenant);
          await maintainUntilDone(backend.pool, otherProject);
          const tenantAudit = await readScopeAudit(backend.pool, otherTenant),
            projectAudit = await readScopeAudit(backend.pool, otherProject);
          assert.deepEqual(tenantAudit, { scannedEdges: 1, issues: [] });
          assert.deepEqual(projectAudit.issues[0]?.relationType, "depends-on");
          assert.equal(projectAudit.scannedEdges, 2);
          assert.equal((await backend.projection.readRelationCycleAudit()).scannedEdges, edges.length + 1);
        } finally {
          sqlite.close();
          await backend.close();
        }
      });
    },

    "existing relation backfill commits fixed keyset pages and remains unreadable until refreshed": async () => {
      await withTempStoreAsync(async (root) => {
        const scope = { tenantId: "tenant-page", projectId: "project-page", policyEpoch: 4 },
          repoId = "cycle-page",
          backend = await open(root, scope, repoId);
        try {
          await insertEdges(
            backend.pool,
            scope,
            Array.from({ length: 5 }, (_, index) => ({
              id: `page-${index}`,
              source: `task/page-${index}`,
              target: `task/page-${index + 1}`,
              type: "depends-on" as const,
            })),
          );
          await withPostgresTransaction(
            backend.pool,
            async (client) => {
              for (const table of PG_RELATION_CYCLE_TABLES) await client.query(`DELETE FROM ${table}`);
            },
            scope,
          );
          const page = (pageSize: number) =>
            withPostgresTransaction(
              backend.pool,
              (client) => backfillPgRelationCycleAuditPage(client, scope, pageSize),
              scope,
            );
          assert.deepEqual(await page(2), { processed: 2, done: false });
          await assert.rejects(readScopeAudit(backend.pool, scope), { code: "projection_pending" });
          assert.deepEqual(await page(2), { processed: 2, done: false });
          assert.deepEqual(await page(2), { processed: 1, done: true });
          await assert.rejects(readScopeAudit(backend.pool, scope), { code: "projection_pending" });
          await maintainUntilDone(backend.pool, scope);
          assert.deepEqual(await readScopeAudit(backend.pool, scope), { scannedEdges: 5, issues: [] });
        } finally {
          await backend.close();
        }
      });
    },
    "unrelated 200 to 2000 historical edges do not amplify audit reads or one component's maintenance": async () => {
      const measurements = [];
      for (const size of [200, 2000])
        await withTempStoreAsync(async (root) => {
          const scope = { tenantId: "cost", projectId: "cost", policyEpoch: 1 },
            backend = await open(root, scope, "cost");
          try {
            await insertEdges(
              backend.pool,
              scope,
              Array.from({ length: size }, (_, index) => ({
                id: `history-${index}`,
                source: `task/history-${index}`,
                target: `task/other-${index}`,
                type: "depends-on" as const,
              })),
            );
            await maintainUntilDone(backend.pool, scope);
            const measure = async (mode: "baseline" | "read" | "write") => {
              const metrics = { clientStatements: 0, returnedRows: 0 };
              await withPostgresTransaction(
                backend.pool,
                async (client) => {
                  const measuredClient = {
                    query: async (sql: string, values?: unknown[]) => {
                      const result = await client.query(sql, values);
                      metrics.clientStatements += 1;
                      metrics.returnedRows += result.rows.length;
                      return result;
                    },
                  } as unknown as PoolClient;
                  if (mode === "baseline") {
                    // The former audit read this entire relation query before the kernel cycle scan.
                    assert.equal((await readRelationsInTransaction(measuredClient, scope, [], {})).length, size);
                  } else if (mode === "write") {
                    await measuredClient.query(
                      `INSERT INTO ha_relations(tenant_id,project_id,policy_epoch,relation_id,source_ref,target_ref,relation_type,relation_state,workspace_revision,value)
                  VALUES ($1,$2,$3,'changed','task/changed-a','task/changed-b','depends-on','active',1,'{"direction":"directed"}')`,
                      [scope.tenantId, scope.projectId, scope.policyEpoch],
                    );
                    assert.equal((await maintainPgRelationCycleAuditPage(measuredClient, scope)).done, true);
                  } else assert.equal((await readPgRelationCycleAudit(measuredClient, scope)).scannedEdges, size);
                },
                scope,
              );
              return metrics;
            };
            measurements.push({
              size,
              baseline: await measure("baseline"),
              read: await measure("read"),
              write: await measure("write"),
            });
          } finally {
            await backend.close();
          }
        });
      console.log(JSON.stringify({ relationCycleCosts: measurements, node: process.versions.node }));
      assert.ok(measurements[1]!.baseline.returnedRows > measurements[0]!.baseline.returnedRows);
      assert.deepEqual(measurements[0]!.read, measurements[1]!.read);
      assert.deepEqual(measurements[0]!.write, measurements[1]!.write);
    },
    "reader sets never reuse another visible graph's cycle witness or count": async () => {
      await withTempStoreAsync(async (root) => {
        const scope = { tenantId: "visibility", projectId: "visibility", policyEpoch: 1 },
          backend = await open(root, scope, "visibility");
        try {
          await insertEdges(backend.pool, scope, [
            { id: "a-b", source: "task/a", target: "task/b", type: "depends-on", readers: ["alice"] },
            { id: "b-a", source: "task/b", target: "task/a", type: "depends-on", readers: ["bob"] },
          ]);
          for (const readers of [[], ["alice"], ["bob"], ["bob", "alice", "alice"]]) {
            const visible = { ...scope, readers };
            await assert.rejects(readScopeAudit(backend.pool, visible), { code: "projection_pending" });
            await maintainUntilDone(backend.pool, visible);
            const audit = await readScopeAudit(backend.pool, visible);
            assert.equal(audit.scannedEdges, readers.length === 1 ? 1 : 2);
            assert.equal(audit.issues.length, readers.length === 1 ? 0 : 1);
          }
          // A visibility edit must invalidate both the old and the new visible graph.
          await withPostgresTransaction(
            backend.pool,
            (client) =>
              client.query(
                "UPDATE ha_relations SET readers=ARRAY['alice'] WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND relation_id='b-a'",
                [scope.tenantId, scope.projectId, scope.policyEpoch],
              ),
            scope,
          );
          for (const readers of [["alice"], ["bob"]]) {
            const visible = { ...scope, readers };
            await assert.rejects(readScopeAudit(backend.pool, visible), { code: "projection_pending" });
            await maintainUntilDone(backend.pool, visible);
            const audit = await readScopeAudit(backend.pool, visible);
            assert.equal(audit.scannedEdges, readers[0] === "alice" ? 2 : 0);
            assert.equal(audit.issues.length, readers[0] === "alice" ? 1 : 0);
          }
        } finally {
          await backend.close();
        }
      });
    },
  };
}

function createSqliteAudit(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  createRelationGraphProjectionTables(db);
  createTaskRelationProjectionTable(db);
  ensureRelationCycleAudit(db);
  return db;
}

function insertSqliteEdge(db: DatabaseSync, edge: Edge): void {
  const revision = Number(
    db.prepare("SELECT COALESCE(MAX(workspace_revision),0)+1 AS revision FROM relation_edge").get()!.revision,
  );
  db.prepare("INSERT INTO relation_edge VALUES (?, ?, ?, ?, ?, NULL, ?, ?, '', ?, 'current', NULL)").run(
    edge.id,
    edge.source,
    edge.target,
    edge.type,
    edge.state ?? "active",
    edge.source,
    revision,
    JSON.stringify({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      type: edge.type,
      state: edge.state ?? "active",
      direction: edge.direction ?? "directed",
      strength: "strong",
      origin: "declared",
      rationale: "Cycle fixture",
    }),
  );
}

function updateSqliteEdge(db: DatabaseSync, id: string, target: string, state: "active" | "retired"): void {
  db.prepare("UPDATE relation_edge SET target_ref=?, state=? WHERE relation_id=?").run(target, state, id);
}

async function insertEdges(pool: Pool, scope: Scope, edges: readonly Edge[]): Promise<void> {
  await withPostgresTransaction(
    pool,
    async (client) => {
      for (const [index, edge] of edges.entries())
        await client.query(
          `INSERT INTO ha_relations(tenant_id,project_id,policy_epoch,readers,relation_id,source_ref,target_ref,relation_type,relation_state,workspace_revision,value,freshness)
           VALUES ($1,$2,$3,$11::text[],$4,$5,$6,$7,$8,$9,$10::jsonb,'current')`,
          [
            scope.tenantId,
            scope.projectId,
            scope.policyEpoch,
            edge.id,
            edge.source,
            edge.target,
            edge.type,
            edge.state ?? "active",
            index + 1,
            JSON.stringify({
              id: edge.id,
              source: edge.source,
              target: edge.target,
              type: edge.type,
              state: edge.state ?? "active",
              direction: edge.direction ?? "directed",
              strength: "strong",
              origin: "declared",
              rationale: "Cycle fixture",
            }),
            edge.readers ?? [],
          ],
        );
    },
    scope,
  );
}

async function updateEdge(
  pool: Pool,
  scope: Scope,
  id: string,
  target: string,
  state: "active" | "retired",
): Promise<void> {
  await withPostgresTransaction(
    pool,
    (client) =>
      client.query(
        `UPDATE ha_relations SET target_ref=$1,relation_state=$2 WHERE tenant_id=$3 AND project_id=$4 AND policy_epoch=$5 AND relation_id=$6`,
        [target, state, scope.tenantId, scope.projectId, scope.policyEpoch, id],
      ),
    scope,
  );
}

async function maintainUntilDone(pool: Pool, scope: Scope): Promise<void> {
  for (let page = 0; page < 100; page += 1) {
    const result = await withPostgresTransaction(
      pool,
      (client) => maintainPgRelationCycleAuditPage(client, scope),
      scope,
    );
    if (result.done) return;
  }
  assert.fail("relation cycle maintenance did not finish within 100 committed pages");
}

async function readScopeAudit(pool: Pool, scope: Scope) {
  return withPostgresTransaction(pool, (client) => readPgRelationCycleAudit(client, scope), scope);
}

function assertAuditEqual(
  pg: { readonly scannedEdges: number; readonly issues: readonly unknown[] },
  sqlite: { readonly scannedEdges: number; readonly issues: readonly unknown[] },
): void {
  assert.equal(pg.scannedEdges, sqlite.scannedEdges);
  assert.deepEqual(pg.issues, sqlite.issues);
}
