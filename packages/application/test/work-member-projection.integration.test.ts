// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { serializeCanonicalEventUnchecked } from "@harness-anything/kernel/internal/domain/doc-sync-canonical-events.ts";
import {
  compileRelationCreatedEvent,
  relationEventWritePlan,
} from "@harness-anything/kernel/internal/domain/relation-event.ts";
import { relation } from "../../storage/test/store/relation-graph-projection.fixtures.ts";
import { sha256Text } from "@harness-anything/kernel/internal/integrity/stable-hash.ts";
import {
  applyTransition,
  compileEntityPinEvent,
  normalizeTaskLifecycleCommand,
  taskLifecycleWritePlan,
  type TaskEventV1,
  type WriteSource,
} from "@harness-anything/kernel";
import { makeTaskEventReader, makeTaskEventStore, makeTaskProjection } from "@harness-anything/storage";
import { sqliteLedgerPath } from "../../storage/src/store/sqlite-event-store.ts";
import { appendCollaboratorLedger } from "../../storage/test/store/collaborator-ledger.events.fixture.ts";
import { assertCollaboratorLedger } from "./collaborator-ledger.fixture.ts";
import { lifecycleFixture } from "../../kernel/test/store/task-lifecycle-fixture.ts";
import { initRepo } from "../../storage/test/store/task-event-store.fixtures.ts";
import { withTempStore, withTempStoreAsync } from "../../storage/test/store/helpers.ts";
import {
  readAgendaAwaitsPage,
  readPersonalPins,
  workspaceScopeFromProjection,
  workBriefsFromProjection,
  workIndexFromProjection,
} from "@harness-anything/application/queries";

test("canonical Work, edge and Pin events produce a member's brief before and after rebuilding", () => {
  withTempStore((rootDir) => {
    initRepo(rootDir);
    const eventStore = makeTaskEventStore({ rootDir, repoId: "member-work" }),
      projection = makeTaskProjection({ rootDir, eventStore }),
      alice = "person_alice",
      bob = "person_bob";
    let revision = 0;
    const addTask = (taskId: string, title: string, personId: string, end: number, handoff = false) => {
      const source: WriteSource = personId === bob ? { kind: "node", nodeId: "edge-bob" } : "local";
      for (const original of lifecycleFixture({ taskId, executionId: `execution-${taskId}` }).events.slice(0, end)) {
        const handedOff = handoff && original.type === "execution_started",
          originalSource: WriteSource = handedOff ? "remote_direct" : source,
          identified = JSON.parse(
            JSON.stringify(original)
              .replaceAll("person-owner", handedOff ? alice : personId)
              .replaceAll('"source":"local"', '"source":' + JSON.stringify(originalSource)),
          ) as TaskEventV1,
          task = identified.payload.task,
          event = {
            ...identified,
            workspaceRevision: ++revision,
            eventId: `member-work-event-${revision}`,
            opId: `member-work-${revision}`,
            source: originalSource,
            payload: {
              ...identified.payload,
              task: {
                ...task,
                createdBy: { ...task.createdBy, principal: { personId } },
                title,
                taskClass: taskId === "shared-work" ? "work" : "standard",
                metadata: {
                  idempotencyKey: null,
                  parentTaskId: taskId === "shared-work" ? null : "shared-work",
                  workKind: null,
                  riskTier: null,
                  urgency: null,
                  verticalId: "software",
                  presetId: "standard-task",
                  profileId: "baseline",
                  moduleKey: null,
                  slug: taskId,
                  surfaces: [],
                  fromLegacyId: null,
                  ...task.metadata,
                },
              },
            },
          } as TaskEventV1;
        const plan = taskLifecycleWritePlan(event);
        eventStore.append({ event, plan, blobs: [] });
        projection.apply(event, plan);
      }
    };
    addTask("shared-work", "Defect fixes", alice, 1);
    addTask("alice-execution", "Alice running implementation", alice, 2);
    addTask("bob-completed", "Bob completed delivery", bob, 6);
    addTask("bob-handoff", "Handed off to Alice", bob, 2, true);

    const pin = compileEntityPinEvent({
      entityRef: "task/shared-work",
      pinned: true,
      actor: { principal: { personId: alice }, executor: null },
      source: "local",
      workspaceRevision: ++revision,
      opId: "shared-work-pin",
      eventId: "shared-work-pin-event",
      occurredAt: "2026-08-11T00:06:00.000Z",
    });
    eventStore.append(pin);
    projection.apply(pin.event, pin.plan);
    const assertMemberView = () => {
      const scope = { scopePersonId: bob, filterNodeId: "edge-bob" },
        index = workIndexFromProjection(projection, scope),
        briefs = workBriefsFromProjection({
          ...scope,
          projection,
          now: () => new Date("2026-08-12T00:00:00.000Z"),
        }).briefs;
      assert.equal(workIndexFromProjection(projection).works[0]?.counts.executing, 2);
      assert.ok(index.works[0]?.memberTaskIds.includes("bob-handoff"), "creator sees the shared Work");
      const combined = workIndexFromProjection(projection, { scopePersonId: alice, filterNodeId: "edge-bob" });
      assert.deepEqual(combined.works, [], "Alice's node-less handoff cannot inherit Bob's node");
      const active = projection.readTaskIndex({ taskIds: ["bob-handoff"], withAttribution: true }).rows[0]!;
      assert.equal(active.activeOrLatestPersonId, alice);
      assert.equal(active.activeOrLatestNodeId, null);
      assert.ok(active.originActivityAt);
      assert.ok(active.activeOrLatestActivityAt);
      const listed = projection.list({ taskIds: ["bob-handoff"] }).rows[0]!;
      assert.equal(listed.activeOrLatestPersonId, alice);
      assert.equal(Object.hasOwn(listed, "originActivityAt"), false);
      assert.equal(Object.hasOwn(listed, "activeOrLatestActivityAt"), false);
      assert.equal(
        workspaceScopeFromProjection(projection, { rootTaskId: "shared-work", ...scope }).counts.executing,
        0,
      );
      assert.deepEqual(
        index.works.map((work) => [work.taskId, work.counts.executing, work.counts.done]),
        [["shared-work", 0, 1]],
      );
      assert.deepEqual(briefs[0]?.sentenceParts, [{ kind: "delivered", title: "Bob completed delivery" }]);
      assert.doesNotMatch(JSON.stringify(briefs), /Alice running implementation|Handed off to Alice/u);
      assert.deepEqual(readPersonalPins(projection, { viewerPersonId: bob }), []);
      assert.equal(
        readPersonalPins(projection, { viewerPersonId: bob, scopePersonId: alice })[0]?.entityRef,
        "task/shared-work",
      );
    };
    assertMemberView();
    assert.equal(projection.rebuild().watermark, revision);
    assertMemberView();

    const actor = { principal: { personId: alice }, executor: null },
      source = { kind: "node", nodeId: "edge-bob" } as const,
      taskIds = ["bob-question", "bob-cancelled-question"],
      now = () => new Date("2026-08-12T00:00:00.000Z");
    for (const [index, taskId] of taskIds.entries()) {
      addTask(taskId, index === 0 ? "Confirm Work rollout" : "Retired question source", bob, 1);
      const { strength: _strength, ...record } = relation({
        source: `task/${taskId}`,
        target: `person/${bob}`,
        type: "awaits",
      });
      const edge = compileRelationCreatedEvent({
        record: {
          ...record,
          targetObservedVersion: `keycloak-user:${bob}:fixture-bob`,
          rationale: "consent: Is rollout ready?",
        },
        actor,
        source,
        workspaceRevision: ++revision,
        occurredAt: "2026-08-11T00:06:00.000Z",
        opId: `work-ask-${taskId}`,
      });
      const plan = relationEventWritePlan(edge);
      eventStore.append({ event: edge, plan, blobs: [] });
      projection.apply(edge, plan);
    }
    const cancelledId = taskIds[1]!,
      snapshot = projection.read(cancelledId).snapshot,
      { event: cancelled } = applyTransition(
        snapshot,
        {
          ...normalizeTaskLifecycleCommand(
            { workspaceId: "member-work", actor, source, expectedRevision: snapshot.revision },
            { type: "TransitionTask", taskId: cancelledId, status: "cancelled", reason: "Withdrawn question" },
          ),
          workspaceRevision: ++revision,
          eventId: "cancelled-work-ask",
          occurredAt: "2026-08-11T00:07:00.000Z",
        },
        {},
      );
    const cancelPlan = taskLifecycleWritePlan(cancelled);
    eventStore.append({ event: cancelled, plan: cancelPlan, blobs: [] });
    projection.apply(cancelled, cancelPlan);

    const assertAgendaHandoff = () => {
      const scope = { scopePersonId: bob, filterNodeId: "edge-bob" },
        agenda = readAgendaAwaitsPage(projection, { ...scope, viewerPersonId: alice, limit: 1 }),
        briefs = workBriefsFromProjection({ ...scope, projection, principalId: alice, now }).briefs;
      assert.deepEqual(
        agenda.awaitingYou.map(({ sourceRef, question }) => [sourceRef, question]),
        [["task/bob-question", "Is rollout ready?"]],
      );
      assert.deepEqual(briefs[0]?.asks, agenda.awaitingYou);
      const allBriefs = workBriefsFromProjection({ projection, viewerPersonId: bob, now }).briefs;
      assert.deepEqual(allBriefs[0]?.asks, agenda.awaitingYou);
      assert.equal(allBriefs[0]?.taskId, "shared-work");
      assert.ok(allBriefs[0]?.openTasks.some(({ taskId }) => taskId === "alice-execution"));
      assert.equal(briefs[0]?.bucket, "waiting");
      assert.deepEqual(
        readAgendaAwaitsPage(projection, { ...scope, viewerPersonId: alice, filterNodeId: "center" }).awaitingYou,
        [],
      );
    };
    assertAgendaHandoff();
    assert.equal(projection.rebuild().watermark, revision);
    assertAgendaHandoff();
    projection.close();
  });
});

test("SQLite collaborator queries read persisted decisions, question pages and historical dispatch billing", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const repoId = "collaborator-ledger";
    const eventStore = makeTaskEventStore({ rootDir, repoId });
    const revisions = await appendCollaboratorLedger(
      (bundle) => {
        eventStore.append(bundle);
      },
      () => (eventStore.readHead()?.revision ?? 0) + 1,
    );
    await eventStore.drain();

    // Persist bytes from the older runtime-session writer and then open the ledger cold.
    const db = new DatabaseSync(sqliteLedgerPath(rootDir, 3));
    try {
      const row = db.prepare("SELECT event_json FROM event WHERE revision=?");
      const write = db.prepare("UPDATE event SET event_json=?,digest=? WHERE revision=?");
      for (const revision of revisions) {
        const event = JSON.parse(String(row.get(revision)?.event_json));
        event.source = `runtime-session/${event.payload.runtimeSessionId}`;
        const bytes = serializeCanonicalEventUnchecked(event);
        write.run(bytes, `sha256:${sha256Text(bytes)}`, revision);
      }
    } finally {
      db.close();
    }

    const reader = makeTaskEventReader({ rootDir, repoId, generation: 3 }),
      projection = makeTaskProjection({ rootDir, eventStore: reader });
    try {
      assert.equal(projection.rebuild().watermark, reader.readHead()?.revision);
      assertCollaboratorLedger(projection);
    } finally {
      projection.close();
      await reader.drain();
    }
  });
});
