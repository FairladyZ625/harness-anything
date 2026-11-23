// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Pool } from "pg";
import { compileDecisionWrite } from "@harness-anything/kernel/internal/domain/decision-event-document.ts";
import { compileFactWrite, type FactMemoryClass } from "@harness-anything/kernel/internal/domain/fact-event.ts";
import { REPLAY_TASK_GRAPH } from "@harness-anything/kernel/internal/domain/task-graph.ts";
import { taskLifecycleWritePlan } from "@harness-anything/kernel/internal/domain/task-lifecycle-publication.ts";
import type { TaskCreatedEvent } from "@harness-anything/kernel/internal/domain/task-lifecycle.contract.ts";
import type { LeaseV1 } from "@harness-anything/kernel";
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
import { changePgLease } from "../../src/pg/pg-lease-cas.ts";
import { materializePgProjectionEvents, rebuildPgProjection } from "../../src/pg/pg-task-event-materialize.ts";
import { createPgTaskProjectionSource } from "../../src/pg/pg-task-source.ts";
import { migrateStorage } from "../../src/migration/engine.ts";
import { openPgMigrationEndpoint } from "../../src/migration/postgres-endpoint.ts";
import { createMigrationGrant } from "../../src/migration/postgres-grant.ts";
import { openSqliteMigrationEndpoint } from "../../src/migration/sqlite-endpoint.ts";
import { initRepo } from "../store/task-event-store.fixtures.ts";
import { removeTempRepository } from "../../../../tools/fixtures/remove-temp-repository.ts";
import { realizedDecisionBody } from "../../../../tools/fixtures/task-plan.mjs";

const ADMIN_URL = process.env.HARNESS_OPENGAUSS_ADMIN_URL;
const RUNTIME_URL = process.env.HARNESS_OPENGAUSS_RUNTIME_URL;
const B_MODE_URL = process.env.HARNESS_OPENGAUSS_B_URL;
const C_MODE_URL = process.env.HARNESS_OPENGAUSS_C_URL;
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

function makeDecisionBundle(decisionId: string, opId: string, revision: number): CanonicalWriteBundle {
  return compileDecisionWrite({
    event: {
      schema: "decision-event/v1",
      eventId: `evt_${opId}`,
      workspaceRevision: revision,
      opId,
      decisionId,
      type: "decision_proposed",
      actor,
      source: "local",
      occurredAt: "2026-11-23T08:02:00.000Z",
      payload: {
        title: `OpenGauss lock-order decision ${decisionId}`,
        question: "Does warm append acquire authority before head?",
        riskTier: "medium",
        urgency: "medium",
        vertical: "test",
        preset: "default",
        appliesTo: { modules: ["storage"], productLines: [] },
        decisionClass: "ordinary",
        chosen: [{ id: "CH1", text: "Acquire authority SHARE before touching ha_repo_heads." }],
        rejected: [{ id: "RJ1", text: "Acquire head first.", whyNot: "Deadlocks with migration freeze." }],
        body: realizedDecisionBody(`OpenGauss lock-order decision ${decisionId}`),
        claims: [],
        fulfillments: [],
        relations: [],
        provenance: [
          {
            runtime: "unavailable",
            sessionId: null,
            transcriptReachability: "unavailable",
            boundAt: "2026-11-23T08:02:00.000Z",
          },
        ],
      },
    },
    currentDecision: null,
    currentRelations: [],
    currentDocument: null,
    decisionReviewRequirement: "off",
  });
}

async function assertNoAuthorityRow(adminPool: Pool, targetRepoId: string, message: string): Promise<void> {
  const rows = await adminPool.query<{ repo_id: string }>(
    "SELECT repo_id FROM public.ha_repo_writer_epochs WHERE repo_id = $1",
    [targetRepoId],
  );
  assert.equal(rows.rows.length, 0, message);
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
      policyEpoch: 0,
      readers: [] as string[],
    };
    const tenantB = {
      tenantId: `tenant_b_${suffix}`,
      projectId: "proj_1",
      policyEpoch: 0,
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

        // Fail-closed guard for non-PG compatibility modes (A / B / C)
        for (const mode of ["A", "B", "C"] as const) {
          assert.throws(
            () =>
              capabilitiesFromProbeRow({
                version_text: capabilities!.serverVersion,
                server_version: "9.2.4",
                server_version_num: String(capabilities!.serverVersionNum),
                sql_compatibility: mode,
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
            `expected sql_compatibility=${mode} to fail closed`,
          );
        }
        // Live non-PG database fail-closed verification when B/C DB URLs are supplied
        for (const [label, url] of [
          ["B", B_MODE_URL],
          ["C", C_MODE_URL],
        ] as const) {
          if (!url) continue;
          const nonPgPool = new Pool({ connectionString: url, max: 1 });
          try {
            const nonPgClient = await nonPgPool.connect();
            try {
              await assert.rejects(
                detectPgDialectCapabilities(nonPgClient),
                (error: unknown) =>
                  (error as { code?: string }).code === "pg_dialect_incompatible" &&
                  error instanceof Error &&
                  new RegExp(`sql_compatibility='${label}'`, "u").test(error.message),
                `live openGauss ${label}-mode database must fail closed`,
              );
            } finally {
              nonPgClient.release();
            }
          } finally {
            await nonPgPool.end();
          }
        }

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
      const readBlob =
        (client: import("pg").PoolClient) =>
        async (sha256: string): Promise<Uint8Array | null> =>
          (
            await client.query<{ body: Buffer }>(
              "SELECT body FROM ha_content_blobs WHERE tenant_id=$1 AND project_id=$2 AND sha256=$3",
              [tenantA.tenantId, tenantA.projectId, sha256],
            )
          ).rows[0]?.body ?? null;
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
            readContentBlob: readBlob(client),
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

      // 6. G9-01: Empty lease writes SQL NULL, and lease reserve + currentLeaseForExecution handle both SQL NULL and historical JSON null
      const taskLegacyNullId = `task_og_legacy_${suffix}`;
      const r4 = await storeA.append(
        makeTaskBundle(taskLegacyNullId, `op_og_4_${suffix}`, 4, "Legacy JSON null task"),
        3,
        fence,
      );
      assert.equal(r4.revision, 4);
      const eventsAfterTask2 = (await storeA.execute({
        operation: "events",
        afterRevision: 3,
      })) as readonly import("@harness-anything/kernel").CanonicalEventV1[];
      await withPostgresTransaction(
        runtimePool,
        async (client) => {
          await materializePgProjectionEvents(client, tenantA, { events: eventsAfterTask2, revision: 4 });
          // Verify newly materialized empty lease is stored as SQL NULL (not JSON 'null'::jsonb)
          const rawCheck = await client.query<{ is_sql_null: boolean }>(
            "SELECT raw_lease IS NULL AS is_sql_null FROM ha_task_snapshots WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND task_id=$4",
            [tenantA.tenantId, tenantA.projectId, tenantA.policyEpoch, taskId],
          );
          assert.equal(rawCheck.rows[0]?.is_sql_null, true, "new empty lease must be stored as SQL NULL");
          // Simulate a historical row storing JSON null scalar ('null'::jsonb)
          await client.query(
            "UPDATE ha_task_snapshots SET raw_lease='null'::jsonb WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND task_id=$4",
            [tenantA.tenantId, tenantA.projectId, tenantA.policyEpoch, taskLegacyNullId],
          );
        },
        tenantA,
      );
      const leaseNow = "2026-11-23T08:05:00.000Z";
      assert.equal(await sourceA.currentLease(taskId, leaseNow), null);
      assert.equal(await sourceA.currentLease(taskLegacyNullId, leaseNow), null);
      assert.equal(await sourceA.currentLeaseForExecution("exe_nonexistent", leaseNow), null);
      const lease: LeaseV1 = {
        schema: "lease/v1",
        taskId,
        executionId: `exe_og_${suffix}`,
        actor,
        source: "local",
        phase: "reserving",
        version: 0,
        ttlMs: 3_600_000,
        expiresAt: "2026-11-23T09:05:00.000Z",
      };
      const reserved = await changePgLease({
        pool: runtimePool,
        scope: tenantA,
        repoId,
        operation: "reserve",
        expected: lease,
        now: leaseNow,
      });
      assert.equal(reserved.phase, "reserving");
      assert.equal(
        (await sourceA.currentLeaseForExecution(lease.executionId, leaseNow))?.executionId,
        lease.executionId,
      );
      const held = await changePgLease({
        pool: runtimePool,
        scope: tenantA,
        repoId,
        operation: "activate",
        expected: reserved,
        now: leaseNow,
      });
      assert.equal(held.phase, "held");
      const released = await changePgLease({
        pool: runtimePool,
        scope: tenantA,
        repoId,
        operation: "release",
        expected: held,
        now: leaseNow,
      });
      assert.equal(released.phase, "released");
      const afterRelease = await sourceA.currentLeaseForExecution(lease.executionId, leaseNow);
      assert.equal(afterRelease?.phase, "released");
      assert.equal(afterRelease?.version, released.version);

      // 7. G9-02, G9-03, G9-05 & G9-06: Scoped authority-share guard, deterministic pre-head-UPDATE authority->head lock order, readStateDigest, and cold migration
      // 7a. G9-05: ha_acquire_repo_writer_epoch_share must fail closed (42501) and leave zero authority rows for read-only, unscoped, or mismatched-scope sessions
      const checkGrant = await createMigrationGrant(adminPool, `grant_check_${suffix}`, [tenantA]);
      try {
        const roRepoId = `repo_ro_denied_${suffix}`;
        await withPostgresTransaction(
          checkGrant.pool,
          async (client) => {
            await assert.rejects(
              client.query("SELECT public.ha_acquire_repo_writer_epoch_share($1, $2, $3, $4)", [
                tenantA.tenantId,
                tenantA.projectId,
                tenantA.policyEpoch,
                roRepoId,
              ]),
              (error: unknown) => (error as { code?: string }).code === "42501",
              "read-only migration grant role must not invoke ha_acquire_repo_writer_epoch_share even with matching scope GUCs",
            );
          },
          tenantA,
        );
        await assertNoAuthorityRow(
          adminPool,
          roRepoId,
          "read-only migration grant denial must not leave an authority row",
        );
        await assert.rejects(
          checkGrant.pool.query("SELECT public.ha_inherit_repo_writer_epoch()"),
          (error: unknown) => (error as { code?: string }).code === "42501",
        );
      } finally {
        await checkGrant.close();
      }
      await assert.rejects(
        runtimePool.query("SELECT public.ha_inherit_repo_writer_epoch()"),
        (error: unknown) => (error as { code?: string }).code === "42501",
      );
      // Legacy 1-arg unguarded overload must not exist
      await assert.rejects(
        runtimePool.query("SELECT public.ha_acquire_repo_writer_epoch_share($1)", [repoId]),
        (error: unknown) => (error as { code?: string }).code === "42883",
        "legacy 1-arg ha_acquire_repo_writer_epoch_share(text) must not exist",
      );
      // Unscoped runtime session (no ha.* GUCs) must be rejected with 42501 and leave zero authority rows
      const unscopedRepoId = `repo_unscoped_${suffix}`;
      const unscopedFenceClient = await runtimePool.connect();
      try {
        await assert.rejects(
          unscopedFenceClient.query("SELECT public.ha_acquire_repo_writer_epoch_share($1, $2, $3, $4)", [
            tenantA.tenantId,
            tenantA.projectId,
            tenantA.policyEpoch,
            unscopedRepoId,
          ]),
          (error: unknown) => (error as { code?: string }).code === "42501",
          "unscoped runtime session must fail closed with 42501",
        );
        await assert.rejects(
          unscopedFenceClient.query("SELECT public.ha_acquire_repo_writer_epoch_share($1, $2, $3, $4)", [
            null,
            null,
            null,
            unscopedRepoId,
          ]),
          (error: unknown) => (error as { code?: string }).code === "42501",
          "null scope arguments must fail closed with 42501 instead of returning NULL via STRICT",
        );
      } finally {
        unscopedFenceClient.release();
      }
      await assertNoAuthorityRow(
        adminPool,
        unscopedRepoId,
        "unscoped runtime denial must not create a ha_repo_writer_epochs row",
      );
      // Scoped runtime session (tenantB) with mismatched tenant/project/policy_epoch or blank repo_id must fail closed with 42501 and leave zero authority rows
      const crossTenantRepoId = `repo_cross_tenant_${suffix}`;
      const crossProjectRepoId = `repo_cross_project_${suffix}`;
      const crossEpochRepoId = `repo_cross_epoch_${suffix}`;
      for (const [label, args] of [
        ["mismatched tenant_id", [tenantA.tenantId, tenantA.projectId, tenantA.policyEpoch, crossTenantRepoId]],
        ["mismatched project_id", [tenantB.tenantId, "proj_other", tenantB.policyEpoch, crossProjectRepoId]],
        ["mismatched policy_epoch", [tenantB.tenantId, tenantB.projectId, tenantB.policyEpoch + 1, crossEpochRepoId]],
        ["blank target_repo_id", [tenantB.tenantId, tenantB.projectId, tenantB.policyEpoch, "   "]],
      ] as const) {
        await withPostgresTransaction(
          runtimePool,
          async (client) => {
            await assert.rejects(
              client.query("SELECT public.ha_acquire_repo_writer_epoch_share($1, $2, $3, $4)", [...args]),
              (error: unknown) => (error as { code?: string }).code === "42501",
              `${label} must fail closed with 42501`,
            );
          },
          tenantB,
        );
      }
      await assertNoAuthorityRow(
        adminPool,
        crossTenantRepoId,
        "mismatched tenant denial must not create a ha_repo_writer_epochs row",
      );
      await assertNoAuthorityRow(
        adminPool,
        crossProjectRepoId,
        "mismatched project denial must not create a ha_repo_writer_epochs row",
      );
      await assertNoAuthorityRow(
        adminPool,
        crossEpochRepoId,
        "mismatched policy_epoch denial must not create a ha_repo_writer_epochs row",
      );

      // 7b. readStateDigest matches across online materialization vs full rebuild
      // Clear the synthetic legacy JSON null and released lease on the two tasks by rebuilding cleanly from canonical events
      const canonicalEventsA = (await storeA.execute({
        operation: "events",
        afterRevision: 0,
      })) as readonly import("@harness-anything/kernel").CanonicalEventV1[];
      await withPostgresTransaction(
        runtimePool,
        async (client) => {
          await rebuildPgProjection(client, tenantA, {
            events: canonicalEventsA,
            sourceRevision: 4,
            readContentBlob: readBlob(client),
          });
        },
        tenantA,
      );
      const digestBefore = await sourceA.readStateDigest();
      assert.match(digestBefore ?? "", /^sha256:[a-f0-9]{64}$/u);
      await withPostgresTransaction(
        runtimePool,
        async (client) => {
          await rebuildPgProjection(client, tenantA, {
            events: canonicalEventsA,
            sourceRevision: 4,
            readContentBlob: readBlob(client),
          });
        },
        tenantA,
      );
      assert.equal(await sourceA.readStateDigest(), digestBefore, "readStateDigest must be stable across rebuild");

      // 7c. G9-06: Warm append (existing ha_repo_heads row) vs concurrent migration freeze staged BEFORE UPDATE ha_repo_heads (zero wall-clock timers)
      const migrationRoot = mkdtempSync(path.join(tmpdir(), "ha-og-migration-"));
      try {
        initRepo(migrationRoot);
        const ogSource = await openPgMigrationEndpoint({ pool: adminPool, repoId, scope: tenantA });
        const sqliteTarget = openSqliteMigrationEndpoint({
          rootDir: migrationRoot,
          role: "target",
          repoId,
          scope: tenantA,
        });
        try {
          const warmBundle = makeDecisionBundle(`dec_OG_${suffix}`, `op_og_warm_${suffix}`, 5);
          let warmCommitted = false;
          await assert.rejects(
            migrateStorage({
              repoId,
              runId: `og_race_${suffix}`,
              exportDirectory: path.join(migrationRoot, "export-race"),
              target: sqliteTarget,
              source: {
                ...ogSource,
                async change(expected, next, activate) {
                  if (next.phase !== "freezing") return ogSource.change(expected, next, activate);
                  const enteredBeforeHeadUpdate = Promise.withResolvers<void>();
                  const releaseBeforeHeadUpdate = Promise.withResolvers<void>();
                  const warmStore = makePostgresTaskEventStore({
                    pool: runtimePool,
                    repoId,
                    scope: tenantA,
                    async readAuthoredDocument() {
                      // Runs inside authorizeReplacements: AFTER authority SHARE + SELECT ha_repo_heads FOR UPDATE,
                      // and STRICTLY BEFORE INSERT ha_events / UPDATE ha_repo_heads.
                      enteredBeforeHeadUpdate.resolve();
                      await releaseBeforeHeadUpdate.promise;
                      return null;
                    },
                    async project(client, value) {
                      await materializePgProjectionEvents(client, tenantA, {
                        ...value,
                        readContentBlob: readBlob(client),
                      });
                    },
                  });
                  const warmAppend = warmStore.append(warmBundle, 4, fence).then((res) => {
                    warmCommitted = true;
                    return res;
                  });
                  await enteredBeforeHeadUpdate.promise;

                  let freezing: Promise<unknown> | null = null;
                  let released = false;
                  let failed = false;
                  const releaseWarmAppend = () => {
                    if (released) return;
                    released = true;
                    releaseBeforeHeadUpdate.resolve();
                  };
                  try {
                    // Deterministic zero-timer proof #1: BEFORE UPDATE ha_repo_heads runs, warmAppend must already hold
                    // BOTH ha_repo_heads FOR UPDATE and ha_repo_writer_epochs FOR SHARE (under head-first order,
                    // ha_repo_writer_epochs FOR UPDATE NOWAIT would succeed here instead of throwing 55P03).
                    const probeClient = await adminPool.connect();
                    try {
                      await probeClient.query("BEGIN");
                      try {
                        await assert.rejects(
                          probeClient.query(
                            "SELECT repo_id FROM public.ha_repo_heads WHERE tenant_id=$1 AND project_id=$2 AND repo_id=$3 FOR UPDATE NOWAIT",
                            [tenantA.tenantId, tenantA.projectId, repoId],
                          ),
                          (error: unknown) => (error as { code?: string }).code === "55P03",
                          "warm append must hold ha_repo_heads FOR UPDATE before UPDATE ha_repo_heads",
                        );
                      } finally {
                        await probeClient.query("ROLLBACK");
                      }
                      await probeClient.query("BEGIN");
                      try {
                        await assert.rejects(
                          probeClient.query(
                            "SELECT repo_id FROM public.ha_repo_writer_epochs WHERE repo_id=$1 FOR UPDATE NOWAIT",
                            [repoId],
                          ),
                          (error: unknown) => (error as { code?: string }).code === "55P03",
                          "warm append must already hold ha_repo_writer_epochs FOR SHARE before UPDATE ha_repo_heads",
                        );
                      } finally {
                        await probeClient.query("ROLLBACK");
                      }
                    } finally {
                      probeClient.release();
                    }

                    // Deterministic zero-timer proof #2: Start migration freeze BEFORE UPDATE ha_repo_heads and observe
                    // via pg_locks + pg_stat_activity that freeze blocks on ha_repo_writer_epochs
                    // (never acquiring authority and blocking on ha_repo_heads, which would deadlock on resume).
                    let freezeFinished = false;
                    freezing = ogSource.change(expected, next, activate).then(
                      () => {
                        freezeFinished = true;
                        return null;
                      },
                      (error: unknown) => {
                        freezeFinished = true;
                        return error;
                      },
                    );
                    let blockedOnAuthority = false;
                    let blockedOnHead = false;
                    for (let attempt = 0; attempt < 500 && !freezeFinished && !blockedOnAuthority; attempt += 1) {
                      const waiting = await adminPool.query<{ query: string }>(
                        `SELECT a.query
                         FROM pg_catalog.pg_stat_activity a
                         JOIN pg_catalog.pg_locks l ON l.pid = a.pid
                         WHERE a.datname = current_database()
                           AND a.pid <> pg_backend_pid()
                           AND NOT l.granted`,
                      );
                      blockedOnAuthority = waiting.rows.some((row) => row.query.includes("ha_repo_writer_epochs"));
                      blockedOnHead = waiting.rows.some((row) => row.query.includes("ha_repo_heads"));
                      assert.equal(
                        blockedOnHead,
                        false,
                        "lock inversion: freeze acquired authority and blocked on ha_repo_heads before head UPDATE",
                      );
                    }
                    assert.equal(
                      blockedOnAuthority,
                      true,
                      "migration freeze must be deterministically observed blocked on ha_repo_writer_epochs in pg_locks",
                    );
                    assert.equal(
                      freezeFinished,
                      false,
                      "migration freeze must wait for in-flight warm append holding authority SHARE lock",
                    );
                  } catch (error) {
                    failed = true;
                    throw error;
                  } finally {
                    releaseWarmAppend();
                    const res = await warmAppend.catch((error: unknown) => {
                      if (!failed) throw error;
                      return null;
                    });
                    if (!failed) assert.equal(res?.revision, 5);
                    if (failed) await freezing?.catch(() => undefined);
                  }
                  const freezeError = await freezing!;
                  assert.ok(freezeError, "freeze must reject stale preflight cut after warm append commits");
                  throw freezeError;
                },
              },
            }),
            (error: unknown) => (error as { code?: string }).code === "storage_migration_mismatch",
          );
          assert.equal(warmCommitted, true);
          assert.equal(await ogSource.state(), null, "failed freeze must leave source unfrozen");

          // 7d. Full cold migration export (invokes createMigrationGrant + auditPgProjectionRows + replay verification) -> SQLite target
          const exported = await ogSource.export(`og_cold_${suffix}`);
          assert.equal(exported.length, 1);
          assert.equal(exported[0]?.events.length, 5);
          await migrateStorage({
            repoId,
            runId: `og_cold_${suffix}`,
            exportDirectory: path.join(migrationRoot, "export-cold"),
            source: ogSource,
            target: sqliteTarget,
          });
          assert.equal(await sqliteTarget.marker(`og_cold_${suffix}`), true);
          const migratedTuples = await sqliteTarget.export(`og_cold_${suffix}`);
          assert.equal(migratedTuples.length, 1);
          assert.equal(migratedTuples[0]?.events.length, 5);
          assert.deepEqual(migratedTuples[0]?.cut, exported[0]?.cut);
          assert.deepEqual(migratedTuples[0]?.projection, exported[0]?.projection);

          // 7e. Once frozen/migrated, subsequent warm append must fail closed with storage_migration_read_only
          await assert.rejects(
            storeA.append(
              makeFactBundle(
                `F-${(Number(suffix.slice(-8)) + 3).toString().padStart(8, "0")}`,
                `op_og_after_freeze_${suffix}`,
                6,
                "semantic",
              ),
              5,
              fence,
            ),
            (error: unknown) =>
              (error as { code?: string }).code === "revision_conflict" &&
              error instanceof Error &&
              /storage_migration_read_only/u.test(error.message),
          );
        } finally {
          await sqliteTarget.close();
          await ogSource.close();
        }
      } finally {
        removeTempRepository(migrationRoot);
      }
    } finally {
      await runtimePool.end();
      await adminPool.end();
    }
  },
);
