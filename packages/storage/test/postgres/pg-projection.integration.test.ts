// harness-test-tier: integration
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { lifecycleFixture } from "../../../kernel/test/store/task-lifecycle-fixture.ts";
import { blockingOf } from "@harness-anything/kernel/internal/domain/task-blocking.ts";
import {
  compileAgentRetired,
  compileEntityDeleted,
  compileEntityUpsert,
} from "@harness-anything/kernel/internal/domain/entity-event-compile.ts";
import { compileEntityPinEvent } from "@harness-anything/kernel/internal/domain/entity-pin-event.ts";
import { taskLifecycleWritePlan } from "@harness-anything/kernel/internal/domain/task-lifecycle-publication.ts";
import { compileFactWrite } from "@harness-anything/kernel/internal/domain/fact-event.ts";
import {
  compileDecisionWrite,
  reduceDecisionDocument,
} from "@harness-anything/kernel/internal/domain/decision-event-document.ts";
import {
  compileRelationCreatedEvent,
  compileRelationReconfirmedEvent,
  relationEventWritePlan,
  type RelationEventRecord,
} from "@harness-anything/kernel/internal/domain/relation-event.ts";
import {
  taskBootstrapWritePlan,
  taskBootstrapPackagePath,
} from "@harness-anything/kernel/internal/domain/task-bootstrap-event.ts";
import {
  MIGRATION_DOCUMENT_POLICY_ID,
  MIGRATION_IMPORT_SOURCE,
  migrationImportWritePlan,
  type MigrationImportEventV1,
} from "@harness-anything/kernel/internal/domain/migration-import-event.ts";
import type { TaskBootstrapEventV1 } from "@harness-anything/kernel/internal/domain/task-bootstrap-event.ts";
import {
  deriveRelationId,
  relationStrengthForType,
  type EntityRelationRecord,
} from "@harness-anything/kernel/internal/domain/entity-relation.ts";
import { sha256Text, stableStringify } from "@harness-anything/kernel/internal/integrity/stable-hash.ts";
import { Pool } from "pg";
import {
  createPgEntityStore,
  createPgTaskProjectionSource,
  ensurePgProjectionSchema,
  grantPgProjectionRuntimeAccess,
  materializePgProjectionEvents,
  projectionStateDigest,
  rebuildPgProjection,
} from "../../src/pg/index.ts";
import {
  POSTGRES_EVENT_LEDGER_SCHEMA_STATEMENTS,
  POSTGRES_EVENT_LEDGER_TABLES,
  createPostgresPool,
  makePostgresTaskEventStore,
  withPostgresTransaction,
} from "../../src/postgres/index.ts";
import { makeTaskProjection } from "../../src/projection/rebuildable-task-projection.ts";
import { createEntityStore } from "../../src/store/entity-store.ts";
import { makeTaskEventStore, type CanonicalWriteBundle } from "../../src/store/task-event-store.ts";
import { POSTGRES_SCOPE_SCHEMA_CONTRACT } from "../../src/postgres/scope-schema.ts";
import { appendGatedLifecycleFixture, assertLifecycleParity } from "./pg-lifecycle.assertions.ts";
import { startManagedPostgresFixture } from "./managed-postgres.fixture.ts";
import { bundle, event, initRepo } from "../store/task-event-store.fixtures.ts";
import {
  fact as factDraft,
  accepted as decisionAcceptedDraft,
  proposal as decisionDraft,
  taskCreated,
} from "../store/relation-graph-projection.fixtures.ts";
import { withTempStoreAsync } from "../store/helpers.ts";
import {
  appendQueryParityFixtures,
  assertAgendaQueryParity,
  assertLeaseQueryParity,
  assertTextQueryParity,
} from "./pg-query-parity.fixture.ts";

import {
  appendLeaseReplayFixtures,
  canonicalLeaseOracle,
  assertCanonicalLeaseReads,
} from "./pg-lease-replay.fixture.ts";

function relationFacet(record: EntityRelationRecord & RelationEventRecord): RelationEventRecord {
  const { strength: _strength, ...facet } = record;
  return facet;
}

test("PG and SQLite projections agree on lifecycle judgments, graphs, entities, cut and replay", async (t) => {
  const fixture = await startManagedPostgresFixture();
  const pools: Pool[] = [];
  try {
    const database = `ha_projection_${randomUUID().replaceAll("-", "")}`;
    await fixture.adminPool.query(`CREATE DATABASE "${database}"`);
    const adminPool = new Pool({ host: "127.0.0.1", port: fixture.port, user: "postgres", database, max: 1 });
    pools.push(adminPool);
    const runtimePassword = randomUUID().replaceAll("-", ""),
      runtimePool = createPostgresPool(
        `postgres://${POSTGRES_SCOPE_SCHEMA_CONTRACT.roles.runtime}:${runtimePassword}@127.0.0.1:${fixture.port}/${database}`,
        { max: 4 },
      );
    pools.push(runtimePool);
    const { roles, roleAttributes } = POSTGRES_SCOPE_SCHEMA_CONTRACT;
    await adminPool.query(`CREATE ROLE "${roles.schemaOwner}" ${roleAttributes.schemaOwner}`);
    await adminPool.query(`CREATE ROLE "${roles.runtime}" ${roleAttributes.runtime} PASSWORD '${runtimePassword}'`);
    await adminPool.query(`CREATE ROLE "${roles.migration}" ${roleAttributes.migration}`);
    await adminPool.query(`GRANT CREATE ON SCHEMA public TO "${roles.schemaOwner}"`);
    await withPostgresTransaction(adminPool, async (client) => {
      await client.query(`SET ROLE "${roles.schemaOwner}"`);
      try {
        for (const statement of POSTGRES_EVENT_LEDGER_SCHEMA_STATEMENTS) await client.query(statement);
        await ensurePgProjectionSchema(client);
      } finally {
        await client.query("RESET ROLE");
      }
      await grantPgProjectionRuntimeAccess(client);
      for (const table of POSTGRES_EVENT_LEDGER_TABLES)
        await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON "${table}" TO "${roles.runtime}"`);
    });
    let expectedRevision = 2;
    const repoId = "pg-projection-repo",
      ledgerScope = { tenantId: "tenant-a", projectId: "project-a", policyEpoch: 7, readers: ["reader-a", "reader-b"] },
      projectionScope = { ...ledgerScope, readers: ["reader-a"] },
      canonicalBundles: CanonicalWriteBundle[] = [bundle(event)],
      replayEvents: import("@harness-anything/kernel").CanonicalEventV1[] = [event],
      projectEvent = async (
        client: import("pg").PoolClient,
        input: {
          readonly revision: number;
          readonly events: readonly import("@harness-anything/kernel").CanonicalEventV1[];
        },
      ) => {
        for (const value of input.events) {
          const readers =
            value.schema === "task-event/v1" && value.taskId === "task-reader-b" ? ["reader-b"] : ["reader-a"];
          await materializePgProjectionEvents(
            client,
            { ...projectionScope, readers },
            { revision: input.revision, events: [value] },
          );
        }
      },
      eventStore = makePostgresTaskEventStore({
        pool: runtimePool,
        repoId,
        scope: ledgerScope,
        project: projectEvent,
      });
    await eventStore.append(bundle(event), 0, { repoId, holderId: "projection-test", epoch: 1 });
    const appendCanonical = async (value: CanonicalWriteBundle) => {
      await eventStore.append(value, expectedRevision - 1, { repoId, holderId: "projection-test", epoch: 1 });
      canonicalBundles.push(value);
      replayEvents.push(value.event);
      expectedRevision += 1;
    };
    const source = createPgTaskProjectionSource({
      pool: runtimePool,
      repoId,
      scope: projectionScope,
    });
    const read = await source.read(event.taskId),
      list = await source.list({ taskIds: [event.taskId] }),
      cut = await source.readCut();
    assert.equal(read.status, "ready");
    assert.equal(read.snapshot.task?.taskId, event.taskId);
    assert.deepEqual(
      list.rows.map((row) => row.taskId),
      [event.taskId],
    );
    assert.deepEqual(cut, { status: "ready", watermark: 1, sourceRevision: 1 });

    const parityEvents = lifecycleFixture({ taskId: "task-parity", executionId: "execution-parity" }).events.map(
      (value, index) => ({
        ...value,
        eventId: `pg-parity-${value.eventId}`,
        opId: `pg-parity-${value.opId}`,
        workspaceRevision: index + 2,
      }),
    );
    for (const value of parityEvents) {
      await appendCanonical({ event: value, plan: taskLifecycleWritePlan(value), blobs: [] });
    }
    await appendGatedLifecycleFixture(appendCanonical, () => expectedRevision, source);
    for (const id of ["replay-agent", "deleted-agent", "retired-agent"]) {
      const declaration = compileEntityUpsert({
        eventId: `event-${id}`,
        opId: `op-${id}`,
        workspaceRevision: expectedRevision,
        actor: { principal: { personId: "projection-test" }, executor: null },
        source: "local",
        occurredAt: "2026-08-11T00:01:00.000Z",
        entityKind: "agent",
        entity: {
          schema: "agent-declaration/v1",
          id,
          name: id,
          instructions: "projection replay",
          runtimes: [{ type: "codex" }],
        },
      });
      await appendCanonical(declaration);
      if (id === "deleted-agent") {
        const deleted = compileEntityDeleted({
          eventId: "event-delete-agent",
          opId: "op-delete-agent",
          workspaceRevision: expectedRevision,
          actor: { principal: { personId: "projection-test" }, executor: null },
          source: "local",
          occurredAt: "2026-08-11T00:02:00.000Z",
          entityKind: "agent",
          entityId: id,
          baseBlobSha256: declaration.event.payload.declarationDocumentClaim.sha256,
          reason: "exercise canonical projection deletion",
        });
        await appendCanonical(deleted);
      } else if (id === "retired-agent") {
        const retired = compileAgentRetired({
          eventId: "event-retire-agent",
          opId: "op-retire-agent",
          workspaceRevision: expectedRevision,
          actor: { principal: { personId: "projection-test" }, executor: null },
          source: "local",
          occurredAt: "2026-08-11T00:03:00.000Z",
          entityId: id,
          priorVersion: expectedRevision - 1,
          retiredAt: "2026-08-11T00:03:00.000Z",
          reason: "exercise canonical retirement projection",
        });
        await appendCanonical(retired);
      }
    }
    await appendCanonical(
      compileEntityUpsert({
        eventId: "pg-replay-squad",
        opId: "pg-replay-squad",
        workspaceRevision: expectedRevision,
        actor: event.actor,
        source: "local",
        occurredAt: "2026-08-11T00:04:00.000Z",
        entityKind: "squad",
        entity: {
          schema: "squad-declaration/v1",
          id: "replay-squad",
          name: "Replay Squad",
          leader: "replay-agent",
          workers: ["replay-agent"],
          leaderTurnBudget: 8,
          roster: "# Replay Squad",
        },
      }),
    );

    const taskBlocked = taskCreated(expectedRevision, "task-blocked"),
      taskBlocker = taskCreated(expectedRevision + 1, "task-blocker");
    await appendCanonical({ event: taskBlocked, plan: taskLifecycleWritePlan(taskBlocked), blobs: [] });
    await appendCanonical({ event: taskBlocker, plan: taskLifecycleWritePlan(taskBlocker), blobs: [] });
    const blockedRelationIdentity = {
        source: "task/task-blocked",
        target: "task/task-blocker",
        type: "depends-on" as const,
        direction: "directed" as const,
      },
      blockedRelationRecord: EntityRelationRecord & RelationEventRecord = {
        relation_id: deriveRelationId(blockedRelationIdentity),
        ...blockedRelationIdentity,
        strength: relationStrengthForType(blockedRelationIdentity.type),
        origin: "declared",
        state: "active",
        rationale: "The dependent task waits for the prerequisite.",
        targetObservedVersion: taskBlocker.workspaceRevision,
      },
      blockedRelation = compileRelationCreatedEvent({
        record: relationFacet(blockedRelationRecord),
        actor: event.actor,
        source: "local",
        opId: "pg-parity-depends-on",
        occurredAt: "2026-08-11T00:20:00.000Z",
        workspaceRevision: expectedRevision,
      });
    await appendCanonical({ event: blockedRelation, plan: relationEventWritePlan(blockedRelation), blobs: [] });

    const refinesIdentity = {
        source: "task/task-blocked",
        target: "task/task-blocker",
        type: "relates" as const,
        direction: "directed" as const,
      },
      refinesRecord: EntityRelationRecord & RelationEventRecord = {
        relation_id: deriveRelationId(refinesIdentity),
        ...refinesIdentity,
        strength: relationStrengthForType(refinesIdentity.type),
        origin: "declared",
        state: "active",
        rationale: "The target version is pinned for this relation.",
        targetObservedVersion: taskBlocker.workspaceRevision,
      },
      refinesRelation = compileRelationCreatedEvent({
        record: relationFacet(refinesRecord),
        actor: event.actor,
        source: "local",
        opId: "pg-parity-refines",
        occurredAt: "2026-08-11T00:20:01.000Z",
        workspaceRevision: expectedRevision,
      });
    await appendCanonical({ event: refinesRelation, plan: relationEventWritePlan(refinesRelation), blobs: [] });

    const blockerStartBase = lifecycleFixture({
        taskId: taskBlocker.taskId,
        executionId: "execution-blocker",
      }).events.find((value) => value.type === "execution_started")!,
      blockerStart = {
        ...blockerStartBase,
        eventId: "pg-blocker-start",
        opId: "pg-blocker-start",
        workspaceRevision: expectedRevision,
      };
    await appendCanonical({ event: blockerStart, plan: taskLifecycleWritePlan(blockerStart), blobs: [] });
    const staleRefines = await source.readRelations({ relationType: "relates" });
    assert.equal(staleRefines.rows.find((row) => row.relationId === refinesRecord.relation_id)?.freshness, "suspect");
    const currentDependency = await source.readRelations({ relationType: "depends-on" });
    assert.equal(
      currentDependency.rows.find((row) => row.relationId === blockedRelationRecord.relation_id)?.freshness,
      "current",
    );
    const refinesReconfirmed = compileRelationReconfirmedEvent({
      relationId: refinesRecord.relation_id,
      priorTargetVersion: taskBlocker.workspaceRevision,
      targetObservedVersion: blockerStart.workspaceRevision,
      rationale: "Reconfirmed against the current blocker revision.",
      actor: event.actor,
      source: "local",
      opId: "pg-parity-refines-reconfirmed",
      occurredAt: "2026-08-11T00:20:02.000Z",
      workspaceRevision: expectedRevision,
    });
    await appendCanonical({ event: refinesReconfirmed, plan: relationEventWritePlan(refinesReconfirmed), blobs: [] });
    assert.equal(
      (await source.readRelations({ relationType: "relates" })).rows.find(
        (row) => row.relationId === refinesRecord.relation_id,
      )?.freshness,
      "current",
    );

    const derivesIdentity = {
        source: "decision/dec_PG_PARITY/CH1",
        target: "task/task-blocked",
        type: "derives" as const,
        direction: "directed" as const,
      },
      derivesRecord: EntityRelationRecord & RelationEventRecord = {
        relation_id: deriveRelationId(derivesIdentity),
        ...derivesIdentity,
        strength: relationStrengthForType(derivesIdentity.type),
        origin: "declared",
        state: "active",
        rationale: "The task follows the proposed decision.",
        targetObservedVersion: taskBlocked.workspaceRevision,
      };

    const taskWorkRoot = taskCreated(expectedRevision, "task-work-root"),
      childCreatedBase = taskCreated(expectedRevision + 1, "task-work-child"),
      childCreated = {
        ...childCreatedBase,
        payload: {
          task: {
            ...childCreatedBase.payload.task,
            metadata: {
              idempotencyKey: null,
              parentTaskId: taskWorkRoot.taskId,
              workKind: "test",
              riskTier: "low",
              urgency: null,
              verticalId: "software/coding",
              presetId: "standard-task",
              profileId: "baseline",
              moduleKey: null,
              slug: "task-work-child",
              surfaces: [],
              fromLegacyId: null,
            },
          },
        },
      },
      childStartBase = lifecycleFixture({ taskId: childCreated.taskId, executionId: "execution-child" }).events.find(
        (value) => value.type === "execution_started",
      )!,
      childStart = {
        ...childStartBase,
        eventId: "pg-work-child-start",
        opId: "pg-work-child-start",
        workspaceRevision: expectedRevision + 2,
        payload: {
          ...childStartBase.payload,
          task: { ...childStartBase.payload.task, metadata: childCreated.payload.task.metadata },
        },
      };
    await appendCanonical({ event: taskWorkRoot, plan: taskLifecycleWritePlan(taskWorkRoot), blobs: [] });
    await appendCanonical({ event: childCreated, plan: taskLifecycleWritePlan(childCreated), blobs: [] });
    await appendCanonical({ event: childStart, plan: taskLifecycleWritePlan(childStart), blobs: [] });

    const bootstrapTaskId = "task-bootstrap-projection",
      bootstrapTaskBase = taskCreated(expectedRevision, bootstrapTaskId),
      presetValue = { schema: "preset-snapshot/v1", id: "projection-replay" },
      presetDigest = `sha256:${sha256Text(stableStringify(presetValue))}` as const,
      presetBody = `${stableStringify({ ...presetValue, digest: presetDigest })}\n`,
      bootstrapDocumentBody = "# Projection bootstrap\n",
      bootstrapDocumentPath = `tasks/${bootstrapTaskId}-projection-bootstrap/task_plan.md`,
      bootstrapEvent: TaskBootstrapEventV1 = {
        schema: "task-bootstrap-event/v1",
        eventId: "pg-bootstrap-projection",
        workspaceRevision: expectedRevision,
        opId: "pg-bootstrap-projection",
        taskId: bootstrapTaskId,
        type: "task_bootstrapped",
        actor: event.actor,
        source: "local",
        occurredAt: "2026-08-11T00:21:00.000Z",
        payload: {
          task: { ...bootstrapTaskBase.payload.task, presetSnapshotDigest: presetDigest },
          presetSnapshotClaim: {
            digest: presetDigest,
            sha256: sha256Text(presetBody),
            size: Buffer.byteLength(presetBody),
            mediaType: "application/json",
          },
          initialDocumentClaims: [
            {
              path: bootstrapDocumentPath,
              sha256: sha256Text(bootstrapDocumentBody),
              size: Buffer.byteLength(bootstrapDocumentBody),
              mediaType: "text/markdown",
              owner: "doc-sync",
              policyId: "markdown-body-replaceable/v1",
            },
          ],
        },
      };
    assert.equal(taskBootstrapPackagePath(bootstrapEvent), `tasks/${bootstrapTaskId}-projection-bootstrap`);
    await appendCanonical({
      event: bootstrapEvent,
      plan: taskBootstrapWritePlan(bootstrapEvent),
      blobs: [
        {
          sha256: bootstrapEvent.payload.presetSnapshotClaim.sha256,
          size: bootstrapEvent.payload.presetSnapshotClaim.size,
          mediaType: "application/json",
          body: presetBody,
        },
        {
          sha256: sha256Text(bootstrapDocumentBody),
          size: Buffer.byteLength(bootstrapDocumentBody),
          mediaType: "text/markdown",
          body: bootstrapDocumentBody,
        },
      ],
    });
    const bootstrapStartBase = lifecycleFixture({
        taskId: bootstrapTaskId,
        executionId: "execution-bootstrap",
      }).events.find((value) => value.type === "execution_started")!,
      bootstrapStart = {
        ...bootstrapStartBase,
        eventId: "pg-bootstrap-start",
        opId: "pg-bootstrap-start",
        workspaceRevision: expectedRevision,
      };
    await appendCanonical({ event: bootstrapStart, plan: taskLifecycleWritePlan(bootstrapStart), blobs: [] });
    const pinned = compileEntityPinEvent({
      entityRef: `task/${bootstrapTaskId}`,
      pinned: true,
      eventId: "pg-bootstrap-pin",
      opId: "pg-bootstrap-pin",
      workspaceRevision: expectedRevision,
      actor: event.actor,
      source: "local",
      occurredAt: "2026-08-11T00:22:00.000Z",
    });
    await appendCanonical(pinned);

    const importedTaskId = "task-migrated-projection",
      importedTask = taskCreated(expectedRevision, importedTaskId).payload.task,
      importedDocumentBody = "# Imported projection task\n",
      importedDocumentPath = `tasks/${importedTaskId}-legacy/INDEX.md`,
      importedTaskEvent: MigrationImportEventV1 = {
        schema: "migration-import-event/v1",
        eventId: "pg-migration-task",
        workspaceRevision: expectedRevision,
        opId: "pg-migration-task",
        type: "entity_migrated",
        actor: event.actor,
        source: MIGRATION_IMPORT_SOURCE,
        occurredAt: "2026-08-11T00:23:00.000Z",
        payload: {
          migratedFrom: "task_migrated_projection",
          generation: "v0",
          entity: {
            kind: "task",
            provenance: "imported_snapshot",
            task: importedTask,
            originalStatus: importedTask.status,
            packagePath: `tasks/${importedTaskId}-legacy`,
            documentClaim: {
              path: importedDocumentPath,
              sha256: sha256Text(importedDocumentBody),
              size: Buffer.byteLength(importedDocumentBody),
              mediaType: "text/markdown",
              policyId: MIGRATION_DOCUMENT_POLICY_ID,
            },
          },
        },
      };
    await appendCanonical({
      event: importedTaskEvent,
      plan: migrationImportWritePlan(importedTaskEvent),
      blobs: [
        {
          sha256: sha256Text(importedDocumentBody),
          size: Buffer.byteLength(importedDocumentBody),
          mediaType: "text/markdown",
          body: importedDocumentBody,
        },
      ],
    });

    const factWrite = compileFactWrite({ event: factDraft(expectedRevision) });
    await appendCanonical(factWrite);
    const proposed = decisionDraft(expectedRevision, "dec_PG_PARITY"),
      decisionWrite = compileDecisionWrite({
        event: {
          ...proposed,
          payload: { ...proposed.payload, provenance: factDraft(expectedRevision).payload.provenance },
        },
        currentDecision: null,
        currentRelations: [],
        currentDocument: null,
        decisionReviewRequirement: "off",
      });
    await appendCanonical(decisionWrite);
    const derivesRelation = compileRelationCreatedEvent({
      record: relationFacet(derivesRecord),
      actor: event.actor,
      source: "local",
      opId: "pg-parity-derives",
      occurredAt: "2026-08-13T00:00:00.000Z",
      workspaceRevision: expectedRevision,
    });
    await appendCanonical({ event: derivesRelation, plan: relationEventWritePlan(derivesRelation), blobs: [] });
    assert.equal(
      (await source.readRelations({ relationType: "derives" })).rows.find(
        (row) => row.relationId === derivesRecord.relation_id,
      )?.freshness,
      "suspect",
    );
    const acceptedWrite = compileDecisionWrite({
      event: decisionAcceptedDraft(expectedRevision, "dec_PG_PARITY"),
      currentDecision: reduceDecisionDocument(null, decisionWrite.event),
      currentRelations: (await source.readDecision("dec_PG_PARITY")).decision!.relations,
      currentDocument: {
        blobSha256: decisionWrite.event.payload.decisionDocumentClaim.sha256,
        body: decisionWrite.body,
      },
      decisionReviewRequirement: "off",
    });
    await appendCanonical(acceptedWrite);
    const blockedStartBase = lifecycleFixture({ taskId: "task-blocked", executionId: "execution-blocked" }).events.find(
        (value) => value.type === "execution_started",
      )!,
      blockedStart = {
        ...blockedStartBase,
        eventId: "pg-blocked-start",
        opId: "pg-blocked-start",
        workspaceRevision: expectedRevision,
      };
    await appendCanonical({ event: blockedStart, plan: taskLifecycleWritePlan(blockedStart), blobs: [] });
    assert.equal(
      (await source.readRelations({ relationType: "derives" })).rows.find(
        (row) => row.relationId === derivesRecord.relation_id,
      )?.freshness,
      "current",
    );

    const readerATask = taskCreated(expectedRevision, "task-reader-a"),
      readerBBase = taskCreated(expectedRevision + 1, "task-reader-b"),
      readerBTask = {
        ...readerBBase,
        payload: {
          task: {
            ...readerBBase.payload.task,
            metadata: { ...childCreated.payload.task.metadata, parentTaskId: "task-reader-a", slug: "task-reader-b" },
          },
        },
      };
    await appendCanonical({ event: readerATask, plan: taskLifecycleWritePlan(readerATask), blobs: [] });
    await appendCanonical({ event: readerBTask, plan: taskLifecycleWritePlan(readerBTask), blobs: [] });
    const readerBStartBase = lifecycleFixture({
        taskId: "task-reader-b",
        executionId: "execution-reader-b",
      }).events.find((value) => value.type === "execution_started")!,
      readerBStart = {
        ...readerBStartBase,
        eventId: "pg-reader-b-start",
        opId: "pg-reader-b-start",
        workspaceRevision: expectedRevision,
        payload: {
          ...readerBStartBase.payload,
          task: { ...readerBStartBase.payload.task, metadata: readerBTask.payload.task.metadata },
        },
      };
    await appendCanonical({ event: readerBStart, plan: taskLifecycleWritePlan(readerBStart), blobs: [] });
    const allReadersSource = createPgTaskProjectionSource({
      pool: runtimePool,
      repoId,
      scope: { ...projectionScope, readers: [] },
    });
    assert.equal((await source.read("task-reader-a", true)).snapshot.task?.status, "planned");
    assert.equal((await allReadersSource.read("task-reader-a", true)).snapshot.task?.status, "active");
    assert.equal(
      (await source.list({ taskIds: ["task-reader-a"], presentationStatus: true })).rows[0]?.snapshot.task?.status,
      "planned",
    );
    await allReadersSource.close();

    const readerBSource = createPgTaskProjectionSource({
      pool: runtimePool,
      repoId,
      scope: { ...ledgerScope, readers: ["reader-b"] },
    });
    assert.equal((await source.read("task-reader-a")).snapshot.task?.taskId, "task-reader-a");
    assert.equal((await source.read("task-reader-b")).snapshot.task, null);
    assert.equal(await source.currentLease("task-reader-b", "2026-08-11T00:30:00.000Z"), null);
    assert.equal(await source.currentLeaseForExecution("execution-reader-b", "2026-08-11T00:30:00.000Z"), null);
    assert.equal((await readerBSource.read("task-reader-b")).snapshot.task?.taskId, "task-reader-b");
    assert.equal((await readerBSource.read("task-reader-a")).snapshot.task, null);
    assert.deepEqual(await source.readCut(), {
      status: "ready",
      watermark: expectedRevision - 1,
      sourceRevision: expectedRevision - 1,
    });

    const workRootRead = await source.list({ taskIds: ["task-work-root"], presentationStatus: true });
    assert.equal(workRootRead.rows[0]?.snapshot.task?.status, "active");
    const pinnedRead = await source.readSnapshot(bootstrapTaskId);
    assert.equal(pinnedRead?.task?.pinned, true);
    const importedRead = await source.read(importedTaskId);
    assert.equal(importedRead.snapshot.task?.taskId, importedTaskId);
    assert.equal(importedRead.packagePath, `tasks/${importedTaskId}-legacy`);
    const exactUpdatedAt = (await source.list({ taskIds: ["task-work-child"] })).rows[0]!.updatedAt;
    assert.deepEqual(
      (
        await source.list({ taskIds: ["task-work-child"], updatedAfter: exactUpdatedAt, updatedBefore: exactUpdatedAt })
      ).rows.map((row) => row.taskId),
      ["task-work-child"],
    );
    await assert.rejects(source.list({ limit: 0 }), /query page limit must be an integer/u);
    await assert.rejects(source.list({ limit: 1.5 }), /query page limit must be an integer/u);
    await assert.rejects(source.list({ limit: 4097 }), /query page limit must be an integer/u);

    let interleavedWrite = false;
    const interleavingPool = {
      connect: async () => {
        const client = await runtimePool.connect();
        return new Proxy(client, {
          get(target, property) {
            if (property === "query") {
              const query = Reflect.get(target, property, target) as (...args: unknown[]) => Promise<unknown>;
              return async (...args: unknown[]) => {
                const result = await query.apply(target, args),
                  statement =
                    typeof args[0] === "string"
                      ? args[0]
                      : String((args[0] as { readonly text?: string } | undefined)?.text ?? "");
                if (!interleavedWrite && statement.includes("FROM ha_projection_meta")) {
                  interleavedWrite = true;
                  const concurrentTask = taskCreated(expectedRevision, "task-cut-interleave");
                  await appendCanonical({
                    event: concurrentTask,
                    plan: taskLifecycleWritePlan(concurrentTask),
                    blobs: [],
                  });
                }
                return result;
              };
            }
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
    } as unknown as Pool;
    const interleavingSource = createPgTaskProjectionSource({
      pool: interleavingPool,
      repoId,
      scope: projectionScope,
    });
    const cutBeforeInterleave = expectedRevision - 1,
      interleavedList = await interleavingSource.list({ taskIds: ["task-cut-interleave"] });
    assert.equal(interleavedWrite, true);
    assert.deepEqual(
      {
        status: interleavedList.status,
        watermark: interleavedList.watermark,
        sourceRevision: interleavedList.sourceRevision,
        rowCount: interleavedList.rows.length,
      },
      { status: "ready", watermark: cutBeforeInterleave, sourceRevision: cutBeforeInterleave, rowCount: 0 },
    );
    const visibleAfterInterleave = await source.list({ taskIds: ["task-cut-interleave"] });
    assert.equal(visibleAfterInterleave.sourceRevision, cutBeforeInterleave + 1);
    assert.equal(visibleAfterInterleave.rows[0]?.taskId, "task-cut-interleave");
    await interleavingSource.close();

    await appendQueryParityFixtures(appendCanonical, () => expectedRevision);
    const leaseCases = await appendLeaseReplayFixtures(appendCanonical, () => expectedRevision);
    let releasedLeases: readonly import("@harness-anything/kernel").LeaseV1[] = [];
    const entities = createPgEntityStore({ pool: runtimePool, scope: projectionScope });
    assert.equal((await entities.get("agent", "replay-agent"))?.id, "replay-agent");
    assert.equal(await entities.get("agent", "deleted-agent"), null);
    assert.equal((await entities.get("agent", "retired-agent"))?.value.lifecycleState, "retired");
    assert.equal((await entities.get("squad", "replay-squad"))?.id, "replay-squad");
    const postgresSnapshotsBeforeRebuild = await source.list(),
      postgresSnapshot = await source.readSnapshot("task-parity");
    assert.ok(postgresSnapshot);
    const beforeRebuildDigest = await withPostgresTransaction(
      runtimePool,
      async (client) => {
        const rows = await client.query<{ snapshot: import("@harness-anything/kernel").TaskLifecycleSnapshot }>(
          "SELECT snapshot FROM ha_task_snapshots ORDER BY task_id",
        );
        return projectionStateDigest(rows.rows.map((row) => row.snapshot));
      },
      projectionScope,
    );
    await withTempStoreAsync(async (rootDir) => {
      initRepo(rootDir);
      const sqliteEvents = makeTaskEventStore({ repoId: "projection-parity", rootDir });
      for (const value of canonicalBundles) sqliteEvents.append(value);
      const sqliteProjection = makeTaskProjection({ rootDir, eventStore: sqliteEvents });
      sqliteProjection.catchUp();
      const sqliteEntities = createEntityStore(sqliteEvents),
        sqliteSnapshots = sqliteProjection.list({
          taskIds: postgresSnapshotsBeforeRebuild.rows.map((row) => row.taskId),
        });
      await assertLifecycleParity(source, sqliteProjection, "task-parity");
      await assertLifecycleParity(source, sqliteProjection, "task-gated-parity");
      assert.equal((await source.readSnapshot("task-gated-parity"))!.gateWitnesses.length, 1);
      const unrestrictedSource = createPgTaskProjectionSource({
        pool: runtimePool,
        repoId,
        scope: { ...projectionScope, readers: [] },
      });
      const relationsPg = await unrestrictedSource.readRelations(),
        relationsSqlite = sqliteProjection.readRelationQuery({});
      assert.deepEqual(relationsPg.rows, relationsSqlite.rows);
      assert.deepEqual(
        (await source.readRelations({ taskOwned: true })).rows,
        sqliteProjection.readTaskRelations().rows,
      );
      assert.deepEqual(
        blockingOf(
          [
            { taskId: "task-blocked", status: (await source.readSnapshot("task-blocked"))!.task!.status },
            { taskId: "task-blocker", status: (await source.readSnapshot("task-blocker"))!.task!.status },
          ],
          relationsPg.rows,
        ),
        blockingOf(
          [
            { taskId: "task-blocked", status: sqliteProjection.read("task-blocked").snapshot.task!.status },
            { taskId: "task-blocker", status: sqliteProjection.read("task-blocker").snapshot.task!.status },
          ],
          relationsSqlite.rows,
        ),
      );
      await unrestrictedSource.close();
      assert.deepEqual(await source.list(), {
        ...sqliteSnapshots,
        status: "ready",
        watermark: expectedRevision - 1,
        sourceRevision: expectedRevision - 1,
      });
      assert.deepEqual(
        (await source.list({ taskIds: ["task-work-root"], presentationStatus: true })).rows,
        sqliteProjection.list({ taskIds: ["task-work-root"], presentationStatus: true }).rows,
      );
      assert.deepEqual((await source.searchFacts({})).facts, sqliteProjection.searchFacts({}).facts);
      assert.deepEqual(
        (await source.searchFacts({ memoryClass: "semantic" })).facts,
        sqliteProjection.searchFacts({ memoryClass: "semantic" }).facts,
      );
      assert.deepEqual(await source.readDecision("dec_PG_PARITY"), sqliteProjection.readDecision("dec_PG_PARITY"));
      assert.deepEqual(
        (await source.listDecisionAgendaPage({ state: "in_effect", limit: 10 })).decisions,
        sqliteProjection.listDecisionAgendaPage({ state: "in_effect", limit: 10 }).decisions,
      );
      const pgAgent = await entities.get("agent", "replay-agent");
      const { extensionMetadata: _extensionMetadata, ...canonicalPgAgent } = pgAgent!;
      assert.deepEqual(sqliteEntities.get("agent", "replay-agent"), canonicalPgAgent);
      assert.equal(await sqliteEntities.get("agent", "deleted-agent"), null);
      assert.equal((await sqliteEntities.get("agent", "retired-agent"))?.value.lifecycleState, "retired");
      const { extensionMetadata: _retiredMetadata, ...retiredPgAgent } = (await entities.get(
        "agent",
        "retired-agent",
      ))!;
      assert.deepEqual(sqliteEntities.get("agent", "retired-agent"), retiredPgAgent);
      assert.equal(
        (await source.list({ taskIds: ["task-parity"], updatedAfter: "2026-08-11T00:00:00.000Z" })).rows.length,
        1,
      );
      assert.deepEqual(
        (await source.list({ limit: 2, pinnedFirst: true })).rows.map((row) => row.taskId),
        sqliteProjection.list({ limit: 2, pinnedFirst: true }).rows.map((row) => row.taskId),
      );
      assert.deepEqual(
        (await source.list({ limit: 2, pinnedFirst: true })).page,
        sqliteProjection.list({ limit: 2, pinnedFirst: true }).page,
      );
      assert.throws(() => sqliteProjection.list({ limit: 0 }), /query page limit must be an integer/u);
      assert.throws(() => sqliteProjection.list({ limit: 1.5 }), /query page limit must be an integer/u);
      process.stdout.write(
        "PG_SQLITE_PARITY snapshots gateWitnesses reviews consents closeoutReadiness taskBoardPlacement blockingOf equal\n",
      );
      releasedLeases = canonicalLeaseOracle(sqliteProjection, leaseCases);
      await t.test("R10 canonical submit, release, renewal, amendment and retirement agree", () =>
        assertCanonicalLeaseReads(source, releasedLeases),
      );
      await t.test("R10 lease phases and explicit time agree", () =>
        assertLeaseQueryParity(source, sqliteProjection, runtimePool, projectionScope),
      );
      await t.test("R11 literal Unicode text search agrees", () => assertTextQueryParity(source, sqliteProjection));
      await t.test("R12 agenda ordering, cursors and limits agree", () =>
        assertAgendaQueryParity(source, sqliteProjection),
      );
      sqliteProjection.close();
    });

    await withPostgresTransaction(
      runtimePool,
      async (client) => {
        for (const table of [
          "ha_task_snapshots",
          "ha_decisions",
          "ha_facts",
          "ha_relations",
          "ha_agents",
          "ha_squads",
          "ha_projection_meta",
        ])
          await client.query(`DELETE FROM ${table} WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3`, [
            projectionScope.tenantId,
            projectionScope.projectId,
            projectionScope.policyEpoch,
          ]);
      },
      projectionScope,
    );
    assert.deepEqual(await source.readCut(), {
      status: "pending",
      watermark: 0,
      sourceRevision: expectedRevision - 1,
    });

    await withPostgresTransaction(
      runtimePool,
      (client) =>
        rebuildPgProjection(client, projectionScope, {
          events: replayEvents,
          sourceRevision: expectedRevision - 1,
          sourceHeadRevision: expectedRevision - 1,
          readEventReaders: (value) =>
            value.schema === "task-event/v1" && value.taskId === "task-reader-b" ? ["reader-b"] : ["reader-a"],
          readContentBlob: async (sha256) => {
            const result = await client.query<{ readonly body: Buffer }>(
              `SELECT body FROM ha_content_blobs WHERE tenant_id=$1 AND project_id=$2 AND sha256=$3`,
              [projectionScope.tenantId, projectionScope.projectId, sha256],
            );
            return result.rows[0]?.body ? Uint8Array.from(result.rows[0].body) : null;
          },
        }),
      projectionScope,
    );
    await t.test("R10 canonical released leases survive cold replay", () =>
      assertCanonicalLeaseReads(source, releasedLeases),
    );
    assert.deepEqual(await source.list(), postgresSnapshotsBeforeRebuild);
    assert.deepEqual(await source.readSnapshot("task-parity"), postgresSnapshot);
    assert.equal((await source.read("task-reader-b")).snapshot.task, null);
    assert.equal((await readerBSource.read("task-reader-b")).snapshot.task?.taskId, "task-reader-b");
    await readerBSource.close();
    assert.equal((await entities.get("agent", "replay-agent"))?.id, "replay-agent");
    assert.equal(await entities.get("agent", "deleted-agent"), null);
    assert.equal((await entities.get("agent", "retired-agent"))?.value.lifecycleState, "retired");
    assert.equal((await entities.get("squad", "replay-squad"))?.id, "replay-squad");
    const rebuiltMeta = await withPostgresTransaction(
      runtimePool,
      async (client) =>
        client.query<{ readonly state_digest: string }>(
          `SELECT state_digest FROM ha_projection_meta
           WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND projection_name='task/v1'`,
          [projectionScope.tenantId, projectionScope.projectId, projectionScope.policyEpoch],
        ),
      projectionScope,
    );
    assert.equal(rebuiltMeta.rows[0]?.state_digest, beforeRebuildDigest);
    await withPostgresTransaction(
      runtimePool,
      (client) =>
        client.query(
          `UPDATE ha_projection_meta SET watermark=$1
           WHERE tenant_id=$2 AND project_id=$3 AND policy_epoch=$4 AND projection_name='task/v1'`,
          [expectedRevision, projectionScope.tenantId, projectionScope.projectId, projectionScope.policyEpoch],
        ),
      projectionScope,
    );
    await assert.rejects(source.readCut(), /projection watermark .* exceeds ledger head/u);
    await withPostgresTransaction(
      runtimePool,
      (client) =>
        client.query(
          `UPDATE ha_projection_meta SET watermark=$1
           WHERE tenant_id=$2 AND project_id=$3 AND policy_epoch=$4 AND projection_name='task/v1'`,
          [expectedRevision - 1, projectionScope.tenantId, projectionScope.projectId, projectionScope.policyEpoch],
        ),
      projectionScope,
    );
    // An index plan needs a selective population, not the two-row lifecycle fixture.
    // This disposable fixture also distinguishes non-leakproof JSONB GIN planning from
    // the runtime's scalar equality index under FORCE ROW LEVEL SECURITY.
    await adminPool.query(
      "INSERT INTO ha_facts (tenant_id,project_id,policy_epoch,fact_id,workspace_revision,value) " +
        "SELECT $1,$2,$3,'plan-' || n,0,jsonb_build_object('memoryClass','episodic','ordinal',n) " +
        "FROM generate_series(1,2048) AS n",
      [projectionScope.tenantId, projectionScope.projectId, projectionScope.policyEpoch],
    );
    // Flush GIN's bulk-insert pending list before comparing steady-state access paths.
    await adminPool.query("VACUUM (ANALYZE) ha_facts");
    const operator = await adminPool.query<{ proleakproof: boolean }>(
      "SELECT proleakproof FROM pg_proc WHERE oid='jsonb_contains(jsonb,jsonb)'::regprocedure",
    );
    assert.equal(operator.rows[0]?.proleakproof, false);
    const explain = await withPostgresTransaction(
      adminPool,
      async (client) => {
        await client.query("SET LOCAL enable_seqscan = off");
        return client.query<{ readonly "QUERY PLAN": readonly { readonly Plan: unknown }[] }>(
          `EXPLAIN (FORMAT JSON) SELECT fact_id FROM ha_facts
           WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND value @> $4::jsonb`,
          [
            projectionScope.tenantId,
            projectionScope.projectId,
            projectionScope.policyEpoch,
            '{"memoryClass":"semantic"}',
          ],
        );
      },
      projectionScope,
    );
    assert.match(JSON.stringify(explain.rows[0]?.["QUERY PLAN"]), /ha_facts_value_gin/u);
    const runtimeExplain = await withPostgresTransaction(
      runtimePool,
      (client) =>
        client.query<{ readonly "QUERY PLAN": readonly { readonly Plan: unknown }[] }>(
          "EXPLAIN (FORMAT JSON) SELECT fact_id FROM ha_facts " +
            "WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND memory_class=$4 " +
            "AND readers && $5::text[]",
          [projectionScope.tenantId, projectionScope.projectId, projectionScope.policyEpoch, "semantic", ["reader-a"]],
        ),
      projectionScope,
    );
    assert.match(JSON.stringify(runtimeExplain.rows[0]?.["QUERY PLAN"]), /ha_facts_memory_class/u);
    process.stdout.write("PG_INDEX_PLANS admin_jsonb=ha_facts_value_gin runtime_rls=ha_facts_memory_class\n");

    const hidden = createPgTaskProjectionSource({
      pool: runtimePool,
      repoId,
      scope: { tenantId: "tenant-b", projectId: "project-a", policyEpoch: 7, readers: ["reader-a"] },
    });
    assert.equal((await hidden.read(event.taskId)).snapshot.task, null);
    for (const scope of [
      { ...projectionScope, projectId: "project-b" },
      { ...projectionScope, policyEpoch: 8 },
    ]) {
      const hiddenScope = createPgTaskProjectionSource({ pool: runtimePool, repoId, scope }),
        hiddenEntities = createPgEntityStore({ pool: runtimePool, scope });
      assert.equal((await hiddenScope.read(event.taskId)).snapshot.task, null);
      assert.equal(await hiddenEntities.get("agent", "replay-agent"), null);
      await hiddenScope.close();
      await hiddenEntities.close();
    }
    await entities.persist({
      kind: "agent",
      id: "codex",
      value: {
        schema: "agent-declaration/v1",
        id: "codex",
        name: "Codex",
        instructions: "work",
        runtimes: [{ type: "codex" }],
      },
      workspaceRevision: 2,
      documentPath: "agents/codex.json",
      documentSha256: "sha256:entity",
      extensionMetadata: { team: "platform" },
    });
    assert.deepEqual((await entities.get("agent", "codex"))?.extensionMetadata, { team: "platform" });
    await source.close();
    await hidden.close();
    await entities.close();
  } finally {
    await Promise.all(pools.map((pool) => pool.end()));
    await fixture.close();
  }
});
