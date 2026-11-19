// harness-test-tier: integration
import assert from "node:assert/strict";
import { appendBootstrapQueryFixture } from "../postgres/query-bootstrap.fixture.ts";
import test from "node:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  compileEntityPinEvent,
  relationIsCurrent,
  taskLifecycleWritePlan,
  type TaskEventV1,
} from "@harness-anything/kernel";
import { lifecycleFixture } from "../../../kernel/test/store/task-lifecycle-fixture.ts";
import {
  canonicalEventWritePlan,
  makeTaskEventStore,
  type CanonicalWriteBundle,
} from "../../src/store/task-event-store.ts";
import { makeTaskProjection, makeTaskProjectionReader } from "../../src/projection/rebuildable-task-projection.ts";
import { pgliteIntegrationSuite } from "./pglite-runtime.fixture.ts";
import { docBundle, initRepo } from "../store/task-event-store.fixtures.ts";
import { withTempStoreAsync } from "../store/helpers.ts";
import { appendLeaseReplayFixtures } from "../postgres/pg-lease-replay.fixture.ts";
import { appendQueryParityFixtures } from "../postgres/pg-query-parity.fixture.ts";
import { appendRuntimeQueryFixtures, assertRuntimeQueryParity } from "../postgres/pg-runtime-query-parity.fixture.ts";
import {
  appendTaskEventQueryFixtures,
  assertTaskEventQueryParity,
  QUERY_SETTINGS_BASE,
} from "../postgres/pg-task-event-parity.fixture.ts";
import { appendGraphQueryFixtures, assertCompleteQueryParity } from "../postgres/pg-complete-query-parity.fixture.ts";
import { assertTaskIndexQueryParity } from "../postgres/pg-task-index-parity.fixture.ts";
import { assertRelationQueryParity } from "../postgres/pg-relation-query-parity.fixture.ts";
import { assertValueQueryParity } from "../postgres/pg-value-query-parity.fixture.ts";
import { appendRecoveryQueryFixtures, assertRecoveryQueryContract } from "../runtime-recovery-query.assertions.ts";
import {
  alice,
  bob,
  edgeA,
  edgeB,
  first,
  second,
  appendCollaboratorLedger,
  migratedTaskPinBundle,
} from "../store/collaborator-ledger.events.fixture.ts";
import { runtimeProviderEvents } from "../runtime-provider-bytes.assertions.ts";

pgliteIntegrationSuite("complete synchronous query parity", () => {
  test("PGlite and SQLite run the same query contracts as PostgreSQL", async () => {
    await withTempStoreAsync(async (rootDir) => {
      initRepo(rootDir);
      writeFileSync(join(rootDir, "harness", "harness.yaml"), QUERY_SETTINGS_BASE);
      const repoId = "pglite-query-parity",
        storage = {
          backend: "pglite" as const,
          dataDir: join(rootDir, "database"),
          materialize: false,
          scope: { tenantId: "query", projectId: "query", policyEpoch: 1 },
        },
        embedded = makeTaskEventStore({ repoId, rootDir, storage }),
        sqlite = makeTaskEventStore({ repoId, rootDir }),
        projection = makeTaskProjection({ rootDir, eventStore: sqlite });
      let revision = 1;
      const append = async (candidate: CanonicalWriteBundle) => {
        embedded.append(candidate);
        sqlite.append(candidate);
        revision++;
      };
      try {
        const edge = { kind: "node", nodeId: "node-edge-a" } as const;
        for (const original of lifecycleFixture({ taskId: "task-parity", executionId: "execution-parity" }).events) {
          const event = { ...original, source: edge };
          await append({ event, plan: taskLifecycleWritePlan(event), blobs: [] });
        }
        await appendBootstrapQueryFixture(
          append,
          () => revision,
          lifecycleFixture({ taskId: "task-parity", executionId: "execution-parity" }).events[0]!.actor,
        );
        await appendLeaseReplayFixtures(append, () => revision);
        await appendQueryParityFixtures(append, () => revision);
        await appendRuntimeQueryFixtures(append, () => revision, edge);
        await appendTaskEventQueryFixtures(append, () => revision);
        await appendGraphQueryFixtures(append, () => revision);
        await appendRecoveryQueryFixtures(append, () => revision);
        // Legal provider ids may contain NUL. The fleet summary projection must read them on both
        // backends; a jsonb cast or a whole-event narrow projection would reject the event.
        let providerRevision = (embedded.readHead()?.revision ?? 0) + 1;
        for (const event of runtimeProviderEvents()) {
          const next = providerRevision++,
            adjusted = { ...event, workspaceRevision: next, eventId: `provider-${next}`, opId: `provider-op-${next}` },
            candidate = {
              event: adjusted,
              plan: canonicalEventWritePlan(adjusted, "agent-runtime/v1", `provider-op-${next}`),
              blobs: [],
            };
          embedded.append(candidate);
          sqlite.append(candidate);
          // Provider events advance the same canonical head as the helper above; keep the next
          // document bundle's expected revision in step with it.
          revision++;
        }
        // A task-package artifact gives the timeline index a document on both backends to compare.
        await append(
          docBundle(
            sqlite,
            "# Parity artifact\n",
            revision,
            "parity-artifact",
            "tasks/task-parity-fixture/artifacts/parity.md",
          ),
        );
        projection.catchUp();
        const reader = makeTaskProjectionReader({ repoId, storage });
        try {
          reader.withSession((queries) => {
            assertRuntimeQueryParity(queries, projection, edge.nodeId);
            assertTaskIndexQueryParity(queries, projection);
            assertRelationQueryParity(queries, projection);
            assertTaskEventQueryParity(queries, projection);
            assertValueQueryParity(queries, projection);
            assertCompleteQueryParity(queries, projection);
            assertRecoveryQueryContract(queries);
            for (const taskIds of [[], ["missing"], ["task-parity"], ["task-parity", "task-graph-a"]])
              assert.deepEqual(
                queries.readEventSummaries(0, 3, { taskIds }),
                projection.readEventSummaries(0, 3, { taskIds }),
              );
            const sqliteTask = projection.list({ taskIds: ["task-parity"] }).rows[0]!,
              pgTask = queries.list({ taskIds: ["task-parity"] }).rows[0]!;
            for (const row of [sqliteTask, pgTask]) {
              assert.equal(row.createdByPersonId, "person-owner");
              assert.equal(row.originNodeId, edge.nodeId);
              assert.equal(row.activeOrLatestNodeId, "center");
              assert.equal(row.activeOrLatestPersonId, "person-owner");
              assert.equal(row.snapshot.lease, null);
            }
            const window = Math.max(0, revision - 51),
              fields = { fleetNodeIds: [edge.nodeId, "node-query-a", "missing"] },
              sqliteFleet = projection.readEventSummaries(window, 50, fields),
              pgFleet = queries.readEventSummaries(window, 50, fields);
            assert.deepEqual(pgFleet.fleetActivity, sqliteFleet.fleetActivity);
            for (const fleet of [sqliteFleet, pgFleet]) {
              const node = fleet.fleetActivity?.find(({ nodeId }) => nodeId === edge.nodeId);
              assert.ok(node?.recentTasks.some(({ taskId }) => taskId === "task-parity"));
              assert.ok(node?.recentDispatches.some(({ dispatchId }) => dispatchId === "runtime-query-a"));
              assert.ok(
                node?.recentEvents.some(
                  ({ type, personId }) => type === "task_completed" && personId === "person-owner",
                ),
              );
              assert.ok(
                !fleet.events.some(({ type, taskId }) => type === "task_completed" && taskId === "task-parity"),
              );
              assert.deepEqual(fleet.fleetActivity?.at(-1), {
                nodeId: "missing",
                recentTasks: [],
                recentDispatches: [],
                recentEvents: [],
              });
            }
            const fleetSummary = queries.readEventSummaries(0, 100, "fleet");
            assert.ok(
              fleetSummary.events.some((event) => event.eventId.startsWith("provider-")),
              "PGlite fleet summary reads the accepted NUL provider event",
            );
          });
          assertRecoveryQueryContract(projection);
          assert.ok(
            projection
              .readEventSummaries(0, 100, "fleet")
              .events.some((event) => event.eventId.startsWith("provider-")),
            "SQLite fleet summary reads the accepted NUL provider event",
          );
        } finally {
          reader.close();
        }
      } finally {
        projection.close();
        await embedded.drain();
        await sqlite.drain();
      }
    });
  });

  test("PGlite exposes collaborator decision and billing queries over accepted events", async () => {
    await withTempStoreAsync(async (rootDir) => {
      initRepo(rootDir);
      const repoId = "pglite-collaborator-ledger",
        storage = {
          backend: "pglite" as const,
          dataDir: join(rootDir, "database"),
          materialize: false,
          scope: { tenantId: "collaborators", projectId: "collaborators", policyEpoch: 1 },
        },
        embedded = makeTaskEventStore({ repoId, rootDir, storage });
      try {
        await appendCollaboratorLedger(
          (bundle) => {
            embedded.append(bundle);
          },
          () => (embedded.readHead()?.revision ?? 0) + 1,
        );
        const reader = makeTaskProjectionReader({ repoId, storage });
        try {
          reader.withSession((queries) => {
            const all = queries.listDecisions().decisions;
            const ids = all.map(({ decisionId }) => decisionId).sort();
            assert.deepEqual(ids, ["dec_ALICE_ONLY", "dec_AWAITS_BOB", "dec_BOB_ONLY"]);
            const involvement = (personId: string) => {
              const asks = new Set(
                queries
                  .readRelationQuery({
                    target: `person/${personId}`,
                    relationType: "awaits",
                    state: "active",
                  })
                  .rows.filter(relationIsCurrent)
                  .map(({ sourceRef }) => sourceRef),
              );
              return all
                .filter(
                  ({ decisionId, proposer }) =>
                    proposer.principal.personId === personId || asks.has(`decision/${decisionId}`),
                )
                .map(({ decisionId }) => decisionId)
                .sort();
            };
            assert.deepEqual(involvement(alice), ["dec_ALICE_ONLY", "dec_AWAITS_BOB"]);
            assert.deepEqual(involvement(bob), ["dec_AWAITS_BOB", "dec_BOB_ONLY"]);
            assert.deepEqual(involvement("person_unrelated"), []);

            for (const taskIds of [undefined, ["billing-task-a", "billing-task-b"]]) {
              const window = taskIds === undefined ? {} : { taskIds };
              const rows = [];
              const cursors = [];
              let cursor: { startedAt: string; dispatchId: string } | undefined;
              do {
                const page = queries.readRuntimeDispatchPage({
                  ...window,
                  startedAtGte: first,
                  limit: 1,
                  ...(cursor ? { cursor } : {}),
                });
                rows.push(...page.rows);
                cursors.push(page.nextCursor);
                cursor = page.nextCursor ?? undefined;
              } while (cursor && rows.length < 5);
              assert.deepEqual(cursors, [
                { startedAt: first, dispatchId: "billing-alice-dispatch" },
                { startedAt: first, dispatchId: "billing-millis-dispatch" },
                { startedAt: "2026-11-19T03:00:00.100Z", dispatchId: "billing-later-dispatch" },
                null,
              ]);
              assert.deepEqual(
                rows.map(({ event, metrics }) => [
                  event.actor.principal.personId,
                  event.source,
                  event.payload.startedAt,
                  metrics?.totalTokens,
                ]),
                [
                  [alice, { kind: "node", nodeId: edgeA }, undefined, 15],
                  [alice, { kind: "node", nodeId: edgeA }, first, 5],
                  [alice, { kind: "node", nodeId: edgeA }, "2026-11-19T03:00:00.1Z", 8],
                  [bob, { kind: "node", nodeId: edgeB }, second, 27],
                ],
              );
            }
            assert.deepEqual(
              queries
                .readRuntimeDispatchPage({ startedAtGte: second, limit: 1 })
                .rows.map(({ metrics }) => metrics?.totalTokens),
              [27],
            );
          });
        } finally {
          reader.close();
        }
      } finally {
        await embedded.drain();
      }
    });
  });
  test("personal migrated Pin agrees in SQLite and PGlite", async () => {
    await withTempStoreAsync(async (rootDir) => {
      initRepo(rootDir);
      const repoId = "pglite-personal-pin-lease",
        storage = {
          backend: "pglite" as const,
          dataDir: join(rootDir, "database"),
          materialize: false,
          scope: { tenantId: "personal-pin-lease", projectId: "personal-pin-lease", policyEpoch: 1 },
        },
        embedded = makeTaskEventStore({ repoId, rootDir, storage }),
        sqlite = makeTaskEventStore({ repoId, rootDir });
      let revision = 0;
      const projection = makeTaskProjection({ rootDir, eventStore: sqlite }),
        reader = makeTaskProjectionReader({ repoId, storage });
      const append = (bundle: CanonicalWriteBundle) => {
        embedded.append(bundle);
        sqlite.append(bundle);
        projection.apply(bundle.event, bundle.plan);
      };
      try {
        const pinTaskId = "task-migrated-pin",
          entityRef = `task/${pinTaskId}`;
        append(migratedTaskPinBundle(pinTaskId, ++revision));
        const readPins = () =>
          reader.withSession((queries) => [queries.listPinnedEntities(alice), queries.listPinnedEntities(bob)]);
        assert.deepEqual(readPins(), [[{ entityRef, pinnedAt: first, pinnedBy: alice }], []]);
        for (const personId of [bob, alice]) {
          append(
            compileEntityPinEvent({
              actor: { principal: { personId }, executor: null },
              source: "local",
              workspaceRevision: ++revision,
              opId: `unpin-${personId}`,
              eventId: `event-unpin-${personId}`,
              occurredAt: first,
              entityRef,
              pinned: false,
            }),
          );
          const expected = personId === alice ? [] : [{ entityRef, pinnedAt: first, pinnedBy: alice }];
          assert.deepEqual(readPins(), [expected, []]);
          assert.deepEqual(projection.listPinnedEntities(alice), expected);
        }
      } finally {
        reader.close();
        projection.close();
        await embedded.drain();
        await sqlite.drain();
      }
    });
  });
  test("task index selects the current operator across held and reserving lease expiry", async () => {
    await withTempStoreAsync(async (rootDir) => {
      initRepo(rootDir);
      const repoId = "pglite-clocked-ownership",
        storage = {
          backend: "pglite" as const,
          dataDir: join(rootDir, "database"),
          materialize: false,
          scope: { tenantId: "clocked-ownership", projectId: "clocked-ownership", policyEpoch: 1 },
        },
        embedded = makeTaskEventStore({ repoId, rootDir, storage }),
        sqlite = makeTaskEventStore({ repoId, rootDir });
      let at = "2026-08-11T00:45:00.000Z",
        revision = 0;
      const now = () => at,
        local = makeTaskProjection({ rootDir, eventStore: sqlite, now }),
        pg = makeTaskProjection({ rootDir, eventStore: embedded, storage, now }),
        heldTask = "task-clocked-held",
        reservingTask = "task-clocked-reserving",
        operator = { principal: { personId: bob }, executor: null },
        latestAt = "2026-08-11T00:44:00.000Z",
        [created, started] = lifecycleFixture({ taskId: heldTask }).events;
      assert.ok(created?.type === "task_created" && started?.type === "execution_started");
      const appendTask = (original: TaskEventV1) => {
        const event = {
          ...original,
          eventId: `event-clocked-${++revision}`,
          opId: `op-clocked-${revision}`,
          workspaceRevision: revision,
        };
        const bundle = { event, plan: taskLifecycleWritePlan(event), blobs: [] };
        embedded.append(bundle);
        sqlite.append(bundle);
        local.apply(event, bundle.plan);
      };
      try {
        appendTask(created);
        appendTask(started);
        appendTask({
          ...started,
          type: "task_amended",
          actor: operator,
          source: { kind: "node", nodeId: edgeB },
          occurredAt: latestAt,
          payload: {
            task: { ...started.payload.task, title: "New operator activity" },
            mutation: { command: "amend", reason: "Cross-node activity", fields: ["title"] },
            documentClaims: [],
          },
        });
        const reserving = lifecycleFixture({ taskId: reservingTask }).events[0]!;
        assert.equal(reserving.type, "task_created");
        if (reserving.type !== "task_created") throw new Error("Reservation fixture requires creation");
        appendTask(reserving);
        const expiresAt = started.payload.lease.expiresAt;
        for (const projection of [local, pg]) {
          projection.reserveLease(
            {
              ...started.payload.lease,
              phase: "reserving",
              taskId: reservingTask,
              executionId: "execution-clocked-reserving",
              actor: operator,
              source: { kind: "node", nodeId: edgeB },
              version: 0,
            },
            at,
          );
        }
        const attribution = (projection: Pick<typeof local, "readTaskIndex">) =>
          projection
            .readTaskIndex({ withAttribution: true, taskIds: [heldTask, reservingTask] })
            .rows.map(({ taskId, activeOrLatestPersonId, activeOrLatestNodeId, activeOrLatestActivityAt }) => [
              taskId,
              activeOrLatestPersonId,
              activeOrLatestNodeId,
              activeOrLatestActivityAt,
            ]);
        const acquiredAt = new Date(Date.parse(expiresAt) - started.payload.lease.ttlMs).toISOString();
        const before = [
          [heldTask, "person-owner", "center", acquiredAt],
          [reservingTask, bob, edgeB, acquiredAt],
        ];
        assert.deepEqual(attribution(local), before);
        assert.deepEqual(attribution(pg), before);
        at = expiresAt;
        const after = [
          [heldTask, bob, edgeB, latestAt],
          [reservingTask, "person-owner", "center", reserving.occurredAt],
        ];
        assert.deepEqual(attribution(local), after);
        assert.deepEqual(attribution(pg), after);
      } finally {
        pg.close();
        local.close();
        await embedded.drain();
        await sqlite.drain();
      }
    });
  });
});
