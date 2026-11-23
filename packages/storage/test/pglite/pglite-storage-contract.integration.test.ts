// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pgliteIntegrationSuite } from "./pglite-runtime.fixture.ts";
import { compileEntityPinEvent } from "@harness-anything/kernel/internal/domain/entity-pin-event.ts";
import { compileEntityUpsert } from "@harness-anything/kernel/internal/domain/entity-event-compile.ts";
import {
  compileRelationCreatedEvent,
  relationEventWritePlan,
} from "@harness-anything/kernel/internal/domain/relation-event.ts";
import { lifecycleFixture } from "../../../kernel/test/store/task-lifecycle-fixture.ts";
import { taskLifecycleWritePlan } from "@harness-anything/kernel/internal/domain/task-lifecycle-publication.ts";
import { localGitWorktreeSettlement } from "../../src/store/local-version-control-system.ts";
import { createEntityStore } from "../../src/store/entity-store.ts";
import { rebuildPgProjection } from "../../src/pg/pg-task-event-materialize.ts";
import { createPGliteStorageBackend } from "../../src/pglite/storage-backend.ts";
import type { PostgresAppendHooks, PostgresEventStoreScope } from "../../src/postgres/pg-event-store.ts";
import { makePostgresTaskEventStore } from "../../src/postgres/pg-task-event-store.ts";
import { withPostgresTransaction } from "../../src/postgres/transaction.ts";
import { makeTaskEventStore } from "../../src/store/task-event-store.ts";
import { makeTaskProjection } from "../../src/projection/rebuildable-task-projection.ts";
import type { CanonicalWriteBundle } from "../../src/store/task-event-store.ts";
import {
  assertCanonicalLeaseReads,
  appendLeaseReplayFixtures,
  canonicalLeaseOracle,
} from "../postgres/pg-lease-replay.fixture.ts";
import {
  appendQueryParityFixtures,
  assertAgendaQueryParity,
  assertLeaseQueryParity,
  assertTextQueryParity,
} from "../postgres/pg-query-parity.fixture.ts";
import { assertDocumentAdmission, admissionSettingsBase } from "../store/document-admission.assertions.ts";
import { appendGatedLifecycleFixture, assertLifecycleParity } from "../postgres/pg-lifecycle.assertions.ts";
import { assertSingleSessionLedger, assertWriterFencing } from "../postgres/pg-ledger.assertions.ts";
import { bundle, eventAt, initRepo } from "../store/task-event-store.fixtures.ts";
import { relation } from "../store/relation-graph-projection.fixtures.ts";
import { removeTempRepository } from "../../../../tools/fixtures/remove-temp-repository.ts";

const scope: PostgresEventStoreScope = {
  tenantId: "tenant-pglite",
  projectId: "project-pglite",
  policyEpoch: 1,
  readers: ["reader-a"],
};

pgliteIntegrationSuite("PGlite storage contract", () => {
  test("PGlite runs the shared PostgreSQL ledger admission and transaction contracts", async (t) => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "ha-pglite-ledger-contract-")),
      dataDir = mkdtempSync(path.join(tmpdir(), "ha-pglite-ledger-data-")),
      repoId = "pglite-ledger-contract";
    initRepo(rootDir);
    writeFileSync(path.join(rootDir, "harness/harness.yaml"), admissionSettingsBase);
    const backend = await createPGliteStorageBackend({
      repoId,
      storage: { backend: "pglite", dataDir, scope },
      readAuthoredDocument: (target) => {
        const node = localGitWorktreeSettlement.readNode(path.join(rootDir, "harness", target));
        return node && { ...node, nodeKind: node.mode === "120000" ? "symbolic-link" : "file" };
      },
    });
    const sqlite = makeTaskEventStore({ repoId: "parity-repo", rootDir }),
      fence = (epoch: number, holderId = "pglite-writer") => ({ repoId, holderId, epoch });
    try {
      await t.test(
        "shared document admission preserves blobs, heads, outcomes, replay and refusal atomicity",
        async () => {
          await assertDocumentAdmission({
            rootDir,
            docStore: sqlite,
            append: async (candidate) => {
              const expectedRevision = (await backend.eventStore.readHead())?.revision ?? 0;
              return backend.eventStore.append(candidate, expectedRevision, fence(1));
            },
            snapshot: async () => {
              const rows = [];
              for (const table of [
                "ha_repo_heads",
                "ha_events",
                "ha_command_outcomes",
                "ha_content_blobs",
                "ha_document_heads",
                "ha_replication_positions",
              ]) {
                const values =
                  table === "ha_content_blobs"
                    ? [scope.tenantId, scope.projectId]
                    : [scope.tenantId, scope.projectId, repoId];
                rows.push(
                  (
                    await backend.db.query(
                      `SELECT * FROM ${table} WHERE tenant_id=$1 AND project_id=$2${table === "ha_content_blobs" ? "" : " AND repo_id=$3"} ORDER BY 1,2,3`,
                      values,
                    )
                  ).rows,
                );
              }
              return rows;
            },
          });
        },
      );

      const make = (repoId: string, otherScope = scope, hooks: PostgresAppendHooks = {}) =>
        makePostgresTaskEventStore({ pool: backend.pool, repoId, scope: otherScope, ...hooks });
      await assertSingleSessionLedger(t, { make, sqlite, inspect: backend.pool });
      await t.test("shared writer epoch, holder, revision and repository fencing", async () => {
        const repoId = "race-repo",
          store = make(repoId);
        await store.append(bundle(eventAt(1)), 0, { repoId, holderId: "center-writer", epoch: 1 });
        await assertWriterFencing(store, repoId);
      });
    } finally {
      await backend.close();
      await sqlite.drain();
      removeTempRepository(rootDir);
      removeTempRepository(dataDir);
    }
  });

  test("PGlite runs shared lifecycle replay, entity, graph and query parity assertions", async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "ha-pglite-projection-contract-")),
      dataDir = mkdtempSync(path.join(tmpdir(), "ha-pglite-projection-data-")),
      repoId = "pglite-projection-contract";
    initRepo(rootDir);
    const backend = await createPGliteStorageBackend({ repoId, storage: { backend: "pglite", dataDir, scope } }),
      sqliteEvents = makeTaskEventStore({ repoId, rootDir }),
      sqliteProjection = makeTaskProjection({ rootDir, eventStore: sqliteEvents }),
      sqliteEntities = createEntityStore(sqliteEvents);
    let nextRevision = 1;
    const fence = { repoId, holderId: "pglite-projection-writer", epoch: 1 },
      append = async (candidate: CanonicalWriteBundle) => {
        await backend.eventStore.append(candidate, nextRevision - 1, fence);
        sqliteEvents.append(candidate);
        nextRevision += 1;
      };
    try {
      const leaseCases = await appendLeaseReplayFixtures(append, () => nextRevision);
      await appendQueryParityFixtures(append, () => nextRevision);

      const createdAgent = compileEntityUpsert({
          eventId: "pglite-agent-event",
          opId: "pglite-agent-op",
          workspaceRevision: nextRevision,
          actor: { principal: { personId: "pglite-contract" }, executor: null },
          source: "local",
          occurredAt: "2026-08-11T00:10:00.000Z",
          entityKind: "agent",
          entity: {
            schema: "agent-declaration/v1",
            id: "pglite-agent",
            name: "PGlite Agent",
            instructions: "Shared entity projection contract",
            runtimes: [{ type: "codex" }],
          },
        }),
        createdSquad = compileEntityUpsert({
          eventId: "pglite-squad-event",
          opId: "pglite-squad-op",
          workspaceRevision: nextRevision + 1,
          actor: { principal: { personId: "pglite-contract" }, executor: null },
          source: "local",
          occurredAt: "2026-08-11T00:11:00.000Z",
          entityKind: "squad",
          entity: {
            schema: "squad-declaration/v1",
            id: "pglite-squad",
            name: "PGlite Squad",
            leader: "pglite-agent",
            workers: ["pglite-agent"],
            leaderTurnBudget: 8,
            roster: "# PGlite Squad\n",
          },
        });
      await append(createdAgent);
      await append(createdSquad);

      for (const value of lifecycleFixture({ taskId: "task-work-root", executionId: "execution-work-root" }).events) {
        const event = {
          ...value,
          eventId: `pglite-work-root-${nextRevision}`,
          opId: `pglite-work-root-${nextRevision}`,
          workspaceRevision: nextRevision,
        };
        await append({ event, plan: taskLifecycleWritePlan(event), blobs: [] });
      }

      await appendGatedLifecycleFixture(append, () => nextRevision, backend.projection);

      const taskCreatedEvent = sqliteEvents
          .read()
          .events.find((value) => value.schema === "task-event/v1" && value.taskId === "task-lease-submit"),
        taskVersion = taskCreatedEvent?.workspaceRevision;
      assert.equal(taskCreatedEvent?.type, "task_created");
      assert.equal(typeof taskVersion, "number");
      const { strength: _strength, ...relationFacet } = relation({
          source: "decision/dec_E2/CH1",
          target: "task/task-lease-submit",
          type: "derives",
        }),
        relationRecord = { ...relationFacet, targetObservedVersion: taskVersion! },
        related = compileRelationCreatedEvent({
          record: relationRecord,
          actor: { principal: { personId: "pglite-contract" }, executor: null },
          source: "local",
          opId: "pglite-graph-edge",
          occurredAt: "2026-08-11T00:12:00.000Z",
          workspaceRevision: nextRevision,
        });
      await append({ event: related, plan: relationEventWritePlan(related), blobs: [] });

      const todoId = "todo_0123456789abcdef01234567",
        entityRef = `todo/${todoId}`,
        memberEvent = (personId: string) => ({
          workspaceRevision: nextRevision,
          actor: { principal: { personId }, executor: null },
          source: { kind: "node" as const, nodeId: "edge-parity" },
          occurredAt: "2026-08-11T00:14:00.000Z",
          eventId: `pglite-member-event-${nextRevision}`,
          opId: `pglite-member-op-${nextRevision}`,
        });
      await append(
        compileEntityUpsert({
          ...memberEvent("person_alice"),
          entityKind: "todo",
          entity: { id: todoId, text: "Shared projection", completed: false, archived: false },
        }),
      );
      for (const [personId, pinned] of [
        ["person_alice", true],
        ["person_bob", true],
        ["person_bob", false],
      ] as const)
        await append(compileEntityPinEvent({ ...memberEvent(personId), entityRef, pinned }));

      const assertCollaboratorParity = async () => {
        const alice = await backend.projection.listPinnedEntities("person_alice");
        assert.deepEqual(alice, sqliteProjection.listPinnedEntities("person_alice"));
        assert.deepEqual(
          alice.map((row) => row.entityRef),
          [entityRef],
        );
        assert.deepEqual(await backend.projection.listPinnedEntities("person_bob"), []);
        const todo = await backend.projection.getEntity("todo", todoId);
        assert.equal(todo?.createdByPersonId, "person_alice");
        assert.equal(todo?.originNodeId, "edge-parity");
        assert.deepEqual(todo, sqliteProjection.getEntity("todo", todoId));
        const query = { taskIds: ["task-work-root"], withAttribution: true };
        assert.deepEqual(
          (await backend.projection.readTaskIndex(query)).rows,
          sqliteProjection.readTaskIndex(query).rows,
        );
      };

      sqliteProjection.catchUp();
      await assertCollaboratorParity();
      await assertLifecycleParity(backend.projection, sqliteProjection, "task-work-root");
      await assertLifecycleParity(backend.projection, sqliteProjection, "task-gated-parity");
      assert.equal((await backend.projection.readSnapshot("task-gated-parity"))!.gateWitnesses.length, 1);
      const canonicalLeases = canonicalLeaseOracle(sqliteProjection, leaseCases);
      await assertCanonicalLeaseReads(backend.projection, canonicalLeases);
      await assertLeaseQueryParity(backend.projection, sqliteProjection, backend.pool, scope);
      await assertTextQueryParity(backend.projection, sqliteProjection);
      await assertAgendaQueryParity(backend.projection, sqliteProjection);

      for (const { taskId } of leaseCases)
        assert.deepEqual(await backend.projection.readSnapshot(taskId), sqliteProjection.read(taskId).snapshot);
      assert.deepEqual((await backend.projection.readRelations({})).rows, sqliteProjection.readRelationQuery({}).rows);
      const pgRelation = (await backend.projection.readRelations({ source: "decision/dec_E2/CH1" })).rows.find(
        (row) => row.relationId === related.relationId,
      );
      assert.equal(pgRelation?.targetRef, "task/task-lease-submit");

      for (const [kind, id] of [
        ["agent", "pglite-agent"],
        ["squad", "pglite-squad"],
      ] as const) {
        const pgValue = await backend.entities.get(kind, id),
          { extensionMetadata: _metadata, ...canonicalPgValue } = pgValue!;
        assert.deepEqual(sqliteEntities.get(kind, id), canonicalPgValue);
        assert.deepEqual(
          (await backend.entities.list(kind)).find((entity) => entity.id === id),
          pgValue,
        );
      }

      const projectionEvents = (await backend.eventStore.execute({
          operation: "events",
        })) as readonly import("@harness-anything/kernel").CanonicalEventV1[],
        beforeRebuild = await backend.projection.readSnapshot("task-lease-submit"),
        sourceRevision = projectionEvents.at(-1)?.workspaceRevision ?? 0;
      await withPostgresTransaction(
        backend.pool,
        (client) =>
          rebuildPgProjection(client, scope, {
            events: projectionEvents,
            sourceRevision,
            sourceHeadRevision: sourceRevision,
            readContentBlob: async (sha256) => {
              const row = (
                await client.query<{ readonly body: Buffer }>(
                  "SELECT body FROM ha_content_blobs WHERE tenant_id=$1 AND project_id=$2 AND sha256=$3",
                  [scope.tenantId, scope.projectId, sha256],
                )
              ).rows[0];
              return row?.body === undefined ? null : Uint8Array.from(row.body);
            },
          }),
        scope,
      );
      await assertCollaboratorParity();
      assert.deepEqual(await backend.projection.readSnapshot("task-lease-submit"), beforeRebuild);
      assert.deepEqual(await backend.projection.readCut(), {
        status: "ready",
        watermark: sourceRevision,
        sourceRevision,
      });
      await assertLifecycleParity(backend.projection, sqliteProjection, "task-work-root");
      await assertLifecycleParity(backend.projection, sqliteProjection, "task-gated-parity");
      await assertCanonicalLeaseReads(backend.projection, canonicalLeases);
      assert.equal((await backend.entities.get("agent", "pglite-agent"))?.id, "pglite-agent");
    } finally {
      sqliteProjection.close();
      await backend.close();
      await sqliteEvents.drain();
      removeTempRepository(rootDir);
      removeTempRepository(dataDir);
    }
  });
});
