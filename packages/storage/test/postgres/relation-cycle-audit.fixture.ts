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
import { taskCreated } from "../store/relation-graph-projection.fixtures.ts";
import type { TaskEventV1 } from "@harness-anything/kernel";
import { materializePgProjectionEvents } from "../../src/pg/pg-task-event-materialize.ts";
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
    "ordinary target amendments preserve a ready cycle audit without extra maintenance": async () => {
      await withTempStoreAsync(async (root) => {
        const scope = { tenantId: "amend", projectId: "amend", policyEpoch: 1 },
          backend = await open(root, scope, "amend"),
          created = taskCreated(1, "target");
        try {
          await withPostgresTransaction(
            backend.pool,
            (client) => materializePgProjectionEvents(client, scope, { revision: 1, events: [created] }),
            scope,
          );
          await insertEdges(backend.pool, scope, [
            { id: "a-target", source: "task/a", target: "task/target", type: "depends-on" },
          ]);
          await maintainUntilDone(backend.pool, scope);
          const before = await readScopeAudit(backend.pool, scope);
          assert.equal(created.type, "task_created");
          if (created.type !== "task_created") throw new Error("fixture must create a task");
          const amended: TaskEventV1 = {
            ...created,
            eventId: "amended",
            opId: "amended",
            workspaceRevision: 2,
            type: "task_amended",
            payload: {
              task: { ...created.payload.task, title: "New title" },
              mutation: { command: "amend", reason: "title", fields: ["title"] },
              documentClaims: [],
            },
          };
          await withPostgresTransaction(
            backend.pool,
            (client) => materializePgProjectionEvents(client, scope, { revision: 2, events: [amended] }),
            scope,
          );
          assert.deepEqual(await readScopeAudit(backend.pool, scope), before);
          await updateEdge(backend.pool, scope, "a-target", "task/other", "active");
          await assert.rejects(readScopeAudit(backend.pool, scope), { code: "projection_pending" });
          await maintainUntilDone(backend.pool, scope);
          assert.deepEqual(await readScopeAudit(backend.pool, scope), before);
        } finally {
          await backend.close();
        }
      });
    },
    "dirty pages merge into old cyclic components beyond the selected page without duplicate members": async () => {
      await withTempStoreAsync(async (root) => {
        const scope = { tenantId: "dirty-pages", projectId: "dirty-pages", policyEpoch: 1 },
          backend = await open(root, scope, "dirty-pages"),
          sqlite = createSqliteAudit(),
          cycle: Edge[] = [
            { id: "z12", source: "task/z1", target: "task/z2", type: "depends-on" },
            { id: "z21", source: "task/z2", target: "task/z1", type: "depends-on" },
          ],
          added: Edge[] = [
            { id: "az", source: "task/a", target: "task/z1", type: "depends-on" },
            ...Array.from({ length: 128 }, (_, i) => ({
              id: `f${i}`,
              source: `task/b${String(i).padStart(3, "0")}`,
              target: `task/c${String(i).padStart(3, "0")}`,
              type: "depends-on" as const,
            })),
          ];
        try {
          await insertEdges(backend.pool, scope, cycle);
          for (const edge of cycle) insertSqliteEdge(sqlite, edge);
          await maintainUntilDone(backend.pool, scope);
          refreshRelationCycleAudit(sqlite);
          await insertEdges(backend.pool, scope, added);
          for (const edge of added) insertSqliteEdge(sqlite, edge);
          await assert.rejects(
            withPostgresTransaction(
              backend.pool,
              async (client) => {
                await maintainPgRelationCycleAuditPage(client, scope);
                throw new Error("rollback after cross-page refresh");
              },
              scope,
            ),
            /rollback after cross-page refresh/u,
          );
          await maintainUntilDone(backend.pool, scope);
          refreshRelationCycleAudit(sqlite);
          assertAuditEqual(await readScopeAudit(backend.pool, scope), auditRelationCycles(sqlite));
          // Repeating maintenance must be idempotent after the cross-page merge.
          await maintainUntilDone(backend.pool, scope);
          await updateEdge(backend.pool, scope, "z21", "task/z1", "retired");
          updateSqliteEdge(sqlite, "z21", "task/z1", "retired");
          await maintainUntilDone(backend.pool, scope);
          refreshRelationCycleAudit(sqlite);
          assertAuditEqual(await readScopeAudit(backend.pool, scope), auditRelationCycles(sqlite));
        } finally {
          sqlite.close();
          await backend.close();
        }
      });
    },
    "repairing one cyclic component never reads all 200 or 2000 historical cycle summaries": async () => {
      const costs = [];
      for (const size of [200, 2000])
        await withTempStoreAsync(async (root) => {
          const scope = { tenantId: "cycle-winner-cost", projectId: "cycle-winner-cost", policyEpoch: 1 },
            backend = await open(root, scope, "cycle-winner-cost"),
            sqlite = createSqliteAudit(),
            edges: Edge[] = Array.from({ length: size }, (_, i) => {
              // Deliberately mix case and punctuation: binary SQL ordering is not localeCompare.
              const prefix = ["A", "a_", "a-", "ä"][i % 4]!,
                key = `${prefix}${String(i).padStart(4, "0")}`;
              return [
                { id: `cycle-${i}-a`, source: `task/${key}/a`, target: `task/${key}/b`, type: "depends-on" as const },
                { id: `cycle-${i}-b`, source: `task/${key}/b`, target: `task/${key}/a`, type: "depends-on" as const },
              ];
            }).flat();
          try {
            await insertEdges(backend.pool, scope, edges);
            for (const edge of edges) insertSqliteEdge(sqlite, edge);
            await maintainUntilDone(backend.pool, scope);
            refreshRelationCycleAudit(sqlite);
            const first = await readScopeAudit(backend.pool, scope);
            assertAuditEqual(first, auditRelationCycles(sqlite));
            const retired = first.issues[0]!.relationIds[0]!,
              target = edges.find(({ id }) => id === retired)!.target,
              counters = { size, clientStatements: 0, returnedRows: 0, summaryRows: 0 };
            await withPostgresTransaction(
              backend.pool,
              async (client) => {
                const measured = {
                  query: async (sql: string, values?: unknown[]) => {
                    const result = await client.query(sql, values);
                    counters.clientStatements++;
                    counters.returnedRows += result.rows.length;
                    if (/SELECT[^;]*issue_json[^;]*FROM ha_relation_cycle_component/u.test(sql))
                      counters.summaryRows += result.rows.length;
                    return result;
                  },
                } as unknown as PoolClient;
                await measured.query(
                  "UPDATE ha_relations SET relation_state='retired' WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND relation_id=$4",
                  [scope.tenantId, scope.projectId, scope.policyEpoch, retired],
                );
                assert.equal((await maintainPgRelationCycleAuditPage(measured, scope)).done, true);
              },
              scope,
            );
            costs.push(counters);
            updateSqliteEdge(sqlite, retired, target, "retired");
            refreshRelationCycleAudit(sqlite);
            assertAuditEqual(await readScopeAudit(backend.pool, scope), auditRelationCycles(sqlite));
          } finally {
            sqlite.close();
            await backend.close();
          }
        });
      console.log(JSON.stringify({ cyclicComponentRepairCosts: costs, node: process.versions.node }));
      for (const cost of costs) {
        assert.ok(cost.summaryRows <= 1, "a local repair returns at most the winning cycle summary");
        assert.ok(
          cost.returnedRows <= 10 * Math.ceil(Math.log2(cost.size + 1)) + 32,
          "summary maintenance must use a logarithmic index path",
        );
      }
    },
    "cycle winner order survives internal-node removals and rotations with kernel collation": async () => {
      await withTempStoreAsync(async (root) => {
        const scope = { tenantId: "winner-order", projectId: "winner-order", policyEpoch: 1 },
          backend = await open(root, scope, "winner-order"),
          sqlite = createSqliteAudit(),
          keys = ["a_", "A", "a-", "ä", "Z", "z", "a9", "a10", "a2", "b", "B", "é", "e", "c", "C", "d", "D"],
          edges: Edge[] = keys.flatMap((key, i) => [
            { id: `order-${i}-a`, source: `task/${key}/a`, target: `task/${key}/b`, type: "depends-on" as const },
            { id: `order-${i}-b`, source: `task/${key}/b`, target: `task/${key}/a`, type: "depends-on" as const },
          ]);
        try {
          await insertEdges(backend.pool, scope, edges);
          for (const edge of edges) insertSqliteEdge(sqlite, edge);
          await maintainUntilDone(backend.pool, scope);
          refreshRelationCycleAudit(sqlite);
          assertAuditEqual(await readScopeAudit(backend.pool, scope), auditRelationCycles(sqlite));
          for (const i of [8, 4, 12, 2, 6, 10, 14, 0, 16, 1, 3, 5, 7, 9, 11, 13, 15]) {
            const edge = edges[i * 2]!;
            await updateEdge(backend.pool, scope, edge.id, edge.target, "retired");
            updateSqliteEdge(sqlite, edge.id, edge.target, "retired");
            await maintainUntilDone(backend.pool, scope);
            refreshRelationCycleAudit(sqlite);
            assertAuditEqual(await readScopeAudit(backend.pool, scope), auditRelationCycles(sqlite));
          }
          assert.deepEqual((await readScopeAudit(backend.pool, scope)).issues, []);
          // Empty index -> insertion must establish a fresh root.
          await updateEdge(backend.pool, scope, edges[0]!.id, edges[0]!.target, "active");
          updateSqliteEdge(sqlite, edges[0]!.id, edges[0]!.target, "active");
          await maintainUntilDone(backend.pool, scope);
          refreshRelationCycleAudit(sqlite);
          assertAuditEqual(await readScopeAudit(backend.pool, scope), auditRelationCycles(sqlite));
        } finally {
          sqlite.close();
          await backend.close();
        }
      });
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
