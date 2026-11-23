// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { Pool } from "pg";
import { compileFactWrite, type FactMemoryClass } from "@harness-anything/kernel/internal/domain/fact-event.ts";
import { REPLAY_TASK_GRAPH } from "@harness-anything/kernel/internal/domain/task-graph.ts";
import { taskLifecycleWritePlan } from "@harness-anything/kernel/internal/domain/task-lifecycle-publication.ts";
import type { TaskCreatedEvent } from "@harness-anything/kernel/internal/domain/task-lifecycle.contract.ts";
import type { CanonicalWriteBundle } from "../../src/store/task-event-store.ts";
import {
  capabilitiesFromProbeRow,
  detectPgDialectCapabilities,
  dialectRuntimeRoleUnsafeQuery,
  ensurePoolDialectCapabilities,
} from "../../src/postgres/dialect.ts";
import {
  POSTGRES_EVENT_LEDGER_TABLES,
  ensurePostgresEventLedgerSchema,
} from "../../src/postgres/event-ledger-schema.ts";
import { makePostgresTaskEventStore } from "../../src/postgres/pg-task-event-store.ts";
import { POSTGRES_SCOPE_SCHEMA_CONTRACT } from "../../src/postgres/scope-schema.ts";
import { withPostgresTransaction } from "../../src/postgres/transaction.ts";
import { ensurePgProjectionSchema, grantPgProjectionRuntimeAccess } from "../../src/pg/pg-projection-schema.ts";
import { materializePgProjectionEvents } from "../../src/pg/pg-task-event-materialize.ts";
import { createPgTaskProjectionSource } from "../../src/pg/pg-task-source.ts";

const ADMIN_URL = process.env.HARNESS_OPENGAUSS_ADMIN_URL;
const RUNTIME_URL = process.env.HARNESS_OPENGAUSS_RUNTIME_URL;
const SKIP_REASON =
  !ADMIN_URL || !RUNTIME_URL
    ? "Set HARNESS_OPENGAUSS_ADMIN_URL and HARNESS_OPENGAUSS_RUNTIME_URL to run live openGauss integration tests"
    : false;

const actor = {
  principal: { personId: "person_og_1" },
  executor: { kind: "agent" as const, id: "codex" },
};

function makeTaskBundle(
  taskId: string,
  opId: string,
  revision: number,
  title = "OpenGauss compatibility task",
): CanonicalWriteBundle {
  const value: TaskCreatedEvent = {
    schema: "task-event/v1",
    eventId: `evt_${opId}`,
    workspaceRevision: revision,
    opId,
    taskId,
    type: "task_created",
    actor,
    source: "local",
    occurredAt: "2026-11-23T08:00:00.000Z",
    payload: {
      task: {
        schema: "task/v2",
        taskId,
        title,
        taskClass: "standard",
        status: "planned",
        graph: REPLAY_TASK_GRAPH,
        currentNode: "implementation",
        iteration: 0,
        createdBy: actor,
        completionGateIds: [],
        presetSnapshotDigest: null,
        pinned: false,
      },
    },
  };
  return {
    event: value,
    plan: taskLifecycleWritePlan(value),
    blobs: [],
  };
}

function makeFactBundle(
  factId: string,
  opId: string,
  revision: number,
  memoryClass: FactMemoryClass,
): CanonicalWriteBundle {
  return compileFactWrite({
    event: {
      schema: "fact-event/v1",
      eventId: `evt_${opId}`,
      workspaceRevision: revision,
      opId,
      factId,
      type: "fact_recorded",
      actor,
      source: "local",
      occurredAt: "2026-11-23T08:01:00.000Z",
      payload: {
        statement: `Empirical fact ${factId}`,
        evidenceSource: "opengauss-integration-test",
        observedAt: "2026-11-23T08:01:00.000Z",
        confidence: "high",
        memoryClass,
        memoryTags: ["pattern"],
        provenance: [
          {
            runtime: "unavailable",
            sessionId: null,
            transcriptReachability: "unavailable",
            boundAt: "2026-11-23T08:01:00.000Z",
          },
        ],
      },
    },
  });
}

test(
  "openGauss 5.0+ live compatibility: dialect probe, ledger, projection, index scan, and RLS isolation",
  { skip: SKIP_REASON },
  async () => {
    const adminPool = new Pool({ connectionString: ADMIN_URL, max: 4 });
    const runtimePool = new Pool({ connectionString: RUNTIME_URL, max: 4 });
    const suffix = `${Date.now()}`;
    const repoId = `repo_og_${suffix}`;
    const fence = { repoId, holderId: "og-center-writer", epoch: 1 };
    const tenantA = {
      tenantId: `tenant_a_${suffix}`,
      projectId: "proj_1",
      policyEpoch: 1,
      readers: [] as string[],
    };
    const tenantB = {
      tenantId: `tenant_b_${suffix}`,
      projectId: "proj_1",
      policyEpoch: 1,
      readers: [] as string[],
    };

    try {
      // 1. Dialect capability probe & schema initialization
      const adminClient = await adminPool.connect();
      let capabilities;
      try {
        capabilities = await detectPgDialectCapabilities(adminClient);
        assert.equal(capabilities.engine, "opengauss");
        assert.equal(capabilities.sqlCompatibility, "PG");
        assert.equal(capabilities.supportsOnConflict, false);
        assert.equal(capabilities.supportsRlsWithCheck, false);
        assert.equal(capabilities.supportsForceRls, true);
        assert.equal(capabilities.supportsXlogLocation, true);

        // Fail-closed guard for Oracle-mode databases
        assert.throws(
          () =>
            capabilitiesFromProbeRow({
              version_text: capabilities!.serverVersion,
              server_version: "9.2.4",
              server_version_num: String(capabilities!.serverVersionNum),
              sql_compatibility: "A",
              has_pg_lsn: false,
              has_xid8: false,
              has_wal_flush_lsn: false,
              has_xlog_location: true,
              has_current_setting_2arg: false,
              has_gen_random_uuid: false,
              has_starts_with: false,
              has_cardinality: false,
              has_to_regclass: false,
              has_row_security_active: false,
              has_jsonb_to_recordset: false,
              has_jsonb_build_object: false,
              has_jsonb_set: false,
              has_transaction_timeout: false,
              has_rolbypassrls: false,
              has_stat_rep_flush_lsn: false,
              has_stat_rep_receiver_flush: true,
              has_pg_policies: false,
              has_pg_rlspolicies: true,
            }),
          (error: unknown) => (error as { code?: string }).code === "pg_dialect_incompatible",
        );

        await ensurePostgresEventLedgerSchema(adminClient, capabilities);
        await ensurePgProjectionSchema(adminClient, { indexBuild: "isolated", capabilities });

        const runtimeRole = POSTGRES_SCOPE_SCHEMA_CONTRACT.roles.runtime;
        const migrationRole = POSTGRES_SCOPE_SCHEMA_CONTRACT.roles.migration;
        for (const role of [runtimeRole, migrationRole]) {
          const exists = await adminClient.query<{ exists: boolean }>(
            "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists",
            [role],
          );
          assert.equal(exists.rows[0]?.exists, true, `expected role ${role} to be provisioned before live test`);
        }
        await adminClient.query(`GRANT USAGE ON SCHEMA public TO "${runtimeRole}", "${migrationRole}"`);
        for (const table of POSTGRES_EVENT_LEDGER_TABLES) {
          await adminClient.query(
            `GRANT SELECT, INSERT, UPDATE, DELETE ON "${table}" TO "${runtimeRole}", "${migrationRole}"`,
          );
        }
        await grantPgProjectionRuntimeAccess(adminClient);

        const adminUnsafe = await adminClient.query<{ unsafe: boolean }>(dialectRuntimeRoleUnsafeQuery(capabilities));
        assert.equal(adminUnsafe.rows[0]?.unsafe, true, "admin role must be flagged unsafe for runtime");
      } finally {
        adminClient.release();
      }

      // 2. Verify runtime role safety check passes
      const rtCheckClient = await runtimePool.connect();
      try {
        const rtCaps = await ensurePoolDialectCapabilities(runtimePool, rtCheckClient);
        assert.equal(rtCaps.engine, "opengauss");
        const rtUnsafe = await rtCheckClient.query<{ unsafe: boolean }>(dialectRuntimeRoleUnsafeQuery(rtCaps));
        assert.equal(rtUnsafe.rows[0]?.unsafe, false, "runtime role must be non-owner without rolsystemadmin");
      } finally {
        rtCheckClient.release();
      }

      // 3. Event ledger append, idempotent duplicate replay, op_conflict, revision_conflict, LSN/watermark
      const storeA = makePostgresTaskEventStore({ pool: runtimePool, scope: tenantA, repoId });
      const taskId = `task_og_${suffix}`;
      const taskBundle = makeTaskBundle(taskId, `op_og_1_${suffix}`, 1);
      const r1 = await storeA.append(taskBundle, 0, fence);
      assert.equal(r1.status, "applied");
      assert.equal(r1.revision, 1);

      // Idempotent duplicate replay (must not advance revision)
      const r1Dup = await storeA.append(taskBundle, 0, fence);
      assert.equal(r1Dup.status, "applied");
      assert.equal(r1Dup.revision, 1);
      assert.equal((await storeA.readHead())?.revision, 1);

      // Divergent intent on same opId -> op_conflict
      await assert.rejects(
        storeA.append(makeTaskBundle(taskId, `op_og_1_${suffix}`, 1, "Different title"), 0, fence),
        (error: unknown) => (error as { code?: string }).code === "op_conflict",
      );

      // Stale expectedRevision -> revision_conflict
      const factId1 = `F-${suffix.slice(-8).toUpperCase()}`;
      const factId2 = `F-${(Number(suffix.slice(-8)) + 1).toString().padStart(8, "0")}`;
      const fact1Bundle = makeFactBundle(factId1, `op_og_2_${suffix}`, 2, "semantic");
      await assert.rejects(
        storeA.append(fact1Bundle, 0, fence),
        (error: unknown) => (error as { code?: string }).code === "revision_conflict",
      );

      // Append two facts with distinct memoryClass values
      const r2 = await storeA.append(fact1Bundle, 1, fence);
      assert.equal(r2.status, "applied");
      assert.equal(r2.revision, 2);

      const fact2Bundle = makeFactBundle(factId2, `op_og_3_${suffix}`, 3, "procedural");
      const r3 = await storeA.append(fact2Bundle, 2, fence);
      assert.equal(r3.status, "applied");
      assert.equal(r3.revision, 3);

      // Verify LSN confirmation function and watermark advancement
      await withPostgresTransaction(
        runtimePool,
        async (client) => {
          const lsnCheck = await client.query<{ confirmed: boolean }>(
            "SELECT ha_is_lsn_sync_confirmed(pg_current_xlog_location()) AS confirmed",
          );
          assert.equal(lsnCheck.rows[0]?.confirmed, true);
          const wm = await client.query<{ confirmed_revision: string }>(
            "SELECT confirmed_revision::text FROM ha_repo_sync_watermarks WHERE tenant_id=$1 AND project_id=$2 AND repo_id=$3",
            [tenantA.tenantId, tenantA.projectId, repoId],
          );
          assert.equal(Number(wm.rows[0]?.confirmed_revision), 3);
        },
        tenantA,
      );

      // 4. Projection materialization + reads + ha_facts.memory_class B-Tree index under forced RLS
      const eventsA = (await storeA.execute({
        operation: "events",
        afterRevision: 0,
      })) as readonly import("@harness-anything/kernel").CanonicalEventV1[];
      assert.equal(eventsA.length, 3);
      await withPostgresTransaction(
        runtimePool,
        async (client) => {
          await materializePgProjectionEvents(client, tenantA, {
            events: eventsA,
            revision: 3,
          });
        },
        tenantA,
      );

      const sourceA = createPgTaskProjectionSource({ pool: runtimePool, scope: tenantA, repoId });
      const readTask = await sourceA.read(taskId);
      assert.equal(readTask.snapshot.task?.taskId, taskId);
      assert.equal(readTask.snapshot.task?.title, "OpenGauss compatibility task");

      const semanticFacts = await sourceA.searchFacts({ memoryClass: "semantic" });
      assert.equal(semanticFacts.facts.length, 1);
      assert.equal(semanticFacts.facts[0]?.factId, factId1);

      // Verify ha_facts.memory_class B-Tree index scan under forced RLS
      await withPostgresTransaction(
        runtimePool,
        async (client) => {
          await client.query("SET LOCAL enable_seqscan = off");
          const explain = await client.query<{ "QUERY PLAN": unknown }>(
            `EXPLAIN (FORMAT JSON)
             SELECT fact_id, value FROM ha_facts
             WHERE tenant_id = $1 AND project_id = $2 AND policy_epoch = $3 AND memory_class = $4`,
            [tenantA.tenantId, tenantA.projectId, tenantA.policyEpoch, "semantic"],
          );
          const planText = JSON.stringify(explain.rows[0]?.["QUERY PLAN"]);
          assert.match(
            planText,
            /ha_facts_memory_class/u,
            `expected ha_facts_memory_class index scan, got: ${planText}`,
          );
        },
        tenantA,
      );

      // 5. Multi-tenant RLS positive & negative isolation (including cross-tenant INSERT/UPDATE blocked with 42501)
      // 5a. Tenant B cannot see Tenant A's events, tasks, or facts
      await withPostgresTransaction(
        runtimePool,
        async (client) => {
          const eventsB = await client.query("SELECT event_id FROM ha_events WHERE tenant_id = $1", [tenantA.tenantId]);
          assert.equal(eventsB.rows.length, 0, "tenant B must see 0 rows of tenant A in ha_events");
          const factsB = await client.query("SELECT fact_id FROM ha_facts WHERE tenant_id = $1", [tenantA.tenantId]);
          assert.equal(factsB.rows.length, 0, "tenant B must see 0 rows of tenant A in ha_facts");
          const tasksB = await client.query("SELECT task_id FROM ha_task_snapshots WHERE tenant_id = $1", [
            tenantA.tenantId,
          ]);
          assert.equal(tasksB.rows.length, 0, "tenant B must see 0 rows of tenant A in ha_task_snapshots");
        },
        tenantB,
      );

      // 5b. Cross-tenant INSERT must fail with SQLSTATE 42501 (enforced by ha_enforce_scope_write_check trigger)
      await withPostgresTransaction(
        runtimePool,
        async (client) => {
          await assert.rejects(
            client.query(
              `INSERT INTO ha_facts (tenant_id, project_id, policy_epoch, readers, fact_id, workspace_revision, value)
               VALUES ($1, $2, $3, '{}', 'F-ILLEGAL', 1, '{"memoryClass":"decision_context"}'::jsonb)`,
              [tenantA.tenantId, tenantA.projectId, tenantA.policyEpoch],
            ),
            (error: unknown) => (error as { code?: string }).code === "42501",
            "cross-tenant INSERT must be rejected with SQLSTATE 42501",
          );
        },
        tenantB,
      );

      // 5c. Tenant B can write its own row, but cross-tenant UPDATE changing tenant_id must fail with 42501
      await withPostgresTransaction(
        runtimePool,
        async (client) => {
          await client.query(
            `INSERT INTO ha_facts (tenant_id, project_id, policy_epoch, readers, fact_id, workspace_revision, value)
             VALUES ($1, $2, $3, '{}', 'F-TENANT-B', 1, '{"memoryClass":"decision_context"}'::jsonb)`,
            [tenantB.tenantId, tenantB.projectId, tenantB.policyEpoch],
          );
          await assert.rejects(
            client.query(
              `UPDATE ha_facts SET tenant_id = $1 WHERE tenant_id = $2 AND project_id = $3 AND policy_epoch = $4 AND fact_id = 'F-TENANT-B'`,
              [tenantA.tenantId, tenantB.tenantId, tenantB.projectId, tenantB.policyEpoch],
            ),
            (error: unknown) => (error as { code?: string }).code === "42501",
            "cross-tenant UPDATE must be rejected with SQLSTATE 42501",
          );
        },
        tenantB,
      );

      // 5d. Unscoped runtime session (no ha.* GUCs set) sees 0 rows and cannot INSERT (SQLSTATE 42501)
      const unscopedClient = await runtimePool.connect();
      try {
        const hidden = await unscopedClient.query("SELECT fact_id FROM ha_facts");
        assert.equal(hidden.rows.length, 0, "unscoped runtime session must see 0 rows");
        await assert.rejects(
          unscopedClient.query(
            `INSERT INTO ha_facts (tenant_id, project_id, policy_epoch, readers, fact_id, workspace_revision, value)
             VALUES ($1, $2, $3, '{}', 'F-UNSCOPED', 1, '{}'::jsonb)`,
            [tenantA.tenantId, tenantA.projectId, tenantA.policyEpoch],
          ),
          (error: unknown) => (error as { code?: string }).code === "42501",
          "unscoped INSERT must be rejected with SQLSTATE 42501",
        );
      } finally {
        unscopedClient.release();
      }
    } finally {
      await runtimePool.end();
      await adminPool.end();
    }
  },
);
