// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { compileEntityUpsert } from "@harness-anything/kernel/internal/domain/entity-event-compile.ts";
import {
  compileRelationCreatedEvent,
  relationEventWritePlan,
} from "@harness-anything/kernel/internal/domain/relation-event.ts";
import { localGitWorktreeSettlement } from "../../src/store/local-version-control-system.ts";
import { createEntityStore } from "../../src/store/entity-store.ts";
import { createPGliteStorageBackend } from "../../src/pglite/storage-backend.ts";
import { makePostgresTaskEventStore } from "../../src/postgres/pg-task-event-store.ts";
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
import { bundle, eventAt, initRepo } from "../store/task-event-store.fixtures.ts";
import { relation } from "../store/relation-graph-projection.fixtures.ts";

const scope = { tenantId: "tenant-pglite", projectId: "project-pglite", policyEpoch: 1, readers: ["reader-a"] };

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
  const sqlite = makeTaskEventStore({ repoId, rootDir }),
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

    await t.test("epoch changes fence stale writers and a projection failure rolls back ledger rows", async () => {
      const next = eventAt(10);
      await backend.eventStore.append(bundle(next), 9, fence(2));
      await assert.rejects(backend.eventStore.append(bundle(eventAt(11)), 10, fence(1)), {
        code: "revision_conflict",
      });
      await assert.rejects(backend.eventStore.append(bundle(eventAt(11)), 10, fence(2, "stale-holder")), {
        code: "revision_conflict",
      });
      await assert.rejects(backend.eventStore.append(bundle(eventAt(11)), 9, fence(2)), {
        code: "revision_conflict",
      });
      assert.equal((await backend.eventStore.readHead())?.revision, 10);

      const rollbackRepoId = "pglite-rollback-contract",
        failing = makePostgresTaskEventStore({
          pool: backend.pool,
          repoId: rollbackRepoId,
          scope,
          project: async () => {
            throw new Error("projection failed");
          },
        });
      await assert.rejects(
        failing.append(bundle(eventAt(1)), 0, { repoId: rollbackRepoId, holderId: "rollback-writer", epoch: 1 }),
        /projection failed/u,
      );
      assert.equal(await failing.readHead(), null);
      assert.deepEqual(await failing.execute({ operation: "events" }), []);
      assert.equal(await failing.execute({ operation: "outcome", opId: eventAt(1).opId }), null);
      const rollbackRows = await backend.db.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM ha_replication_positions WHERE tenant_id=$1 AND project_id=$2 AND repo_id=$3",
        [scope.tenantId, scope.projectId, rollbackRepoId],
      );
      assert.equal(rollbackRows.rows[0]?.count, "0");
    });
  } finally {
    await backend.close();
    await sqlite.drain();
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
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

    sqliteProjection.catchUp();
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
  } finally {
    sqliteProjection.close();
    await backend.close();
    await sqliteEvents.drain();
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
});
