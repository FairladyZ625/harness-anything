// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import type { PoolClient } from "pg";
import { relationTypeDeclarations } from "@harness-anything/kernel/internal/domain/relation-type-registry.ts";
import {
  PG_RELATION_CYCLE_TABLES,
  readPgRelationCycleAudit,
  relationCycleAuditDdl,
} from "../../src/pg/pg-relation-cycle-audit.ts";
import { PG_PROJECTION_AUDIT_TABLES, PG_PROJECTION_TABLES, projectionDdl } from "../../src/pg/pg-projection-schema.ts";

test("PG cycle cache declares six scoped tables and limits mirrored edges to declared acyclic types", () => {
  const ddl = relationCycleAuditDdl().join("\n"),
    acyclic = relationTypeDeclarations
      .filter(({ acyclic }) => acyclic)
      .map(({ type }) => `'${type}'`)
      .join(",");
  assert.deepEqual(PG_RELATION_CYCLE_TABLES, [
    "ha_relation_cycle_edge",
    "ha_relation_cycle_count",
    "ha_relation_cycle_dirty",
    "ha_relation_cycle_component",
    "ha_relation_cycle_member",
    "ha_relation_cycle_result",
  ]);
  for (const table of PG_RELATION_CYCLE_TABLES) {
    assert.ok((PG_PROJECTION_TABLES as readonly string[]).includes(table));
    assert.match(ddl, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`, "u"));
  }
  assert.ok(!(PG_PROJECTION_AUDIT_TABLES as readonly string[]).includes("ha_relation_cycle_dirty"));
  assert.match(ddl, new RegExp(`IF NEW\\.relation_type IN \\(${acyclic}\\)`, "u"));
  assert.match(ddl, /backfill_cursor text[\s\S]*backfill_complete boolean/u);
  assert.doesNotMatch(ddl, /SELECT[\s\S]*FROM ha_relations/u);
  assert.match(projectionDdl().join("\n"), /CREATE TABLE IF NOT EXISTS ha_relation_cycle_result/u);
});

test("PG cycle audit reads only scoped cache rows and refuses dirty or unbackfilled state", async () => {
  const queries: string[] = [],
    scope = { tenantId: "tenant-a", projectId: "project-a", policyEpoch: 1 },
    mode: { value: "ready" | "backfill-pending" | "dirty" } = { value: "ready" },
    client = {
      query: async (sql: string) => {
        queries.push(sql);
        if (sql.includes("FROM ha_relation_cycle_count"))
          return {
            rows: [
              { edge_count: mode.value === "ready" ? "17" : "3", backfill_complete: mode.value !== "backfill-pending" },
            ],
            rowCount: 1,
          };
        if (sql.includes("FROM ha_relation_cycle_dirty"))
          return mode.value === "dirty" ? { rows: [{ dirty: 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
        return { rows: [{ issue_json: { code: "relation_cycle_detected" } }], rowCount: 1 };
      },
    } as unknown as PoolClient;
  assert.deepEqual(await readPgRelationCycleAudit(client, scope), {
    scannedEdges: 17,
    issues: [{ code: "relation_cycle_detected" }],
  });
  assert.doesNotMatch(queries.join("\n"), /ha_relations/u);
  assert.ok(queries.every((sql) => /tenant_id=\$1 AND project_id=\$2 AND policy_epoch=\$3/u.test(sql)));

  queries.length = 0;
  mode.value = "backfill-pending";
  await assert.rejects(readPgRelationCycleAudit(client, scope), { code: "projection_pending" });
  assert.equal(queries.length, 1);

  queries.length = 0;
  mode.value = "dirty";
  await assert.rejects(readPgRelationCycleAudit(client, scope), { code: "projection_pending" });
  assert.equal(queries.length, 2);
});
