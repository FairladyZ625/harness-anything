// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import {
  compileEntityPinEvent,
  taskLifecycleWritePlan,
  type TaskEventV1,
  type WriteSource,
} from "@harness-anything/kernel";
import { makeTaskEventStore, makeTaskProjection } from "@harness-anything/storage";
import { lifecycleFixture } from "../../kernel/test/store/task-lifecycle-fixture.ts";
import { initRepo } from "../../storage/test/store/task-event-store.fixtures.ts";
import { withTempStore } from "../../storage/test/store/helpers.ts";
import {
  readPersonalPins,
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
    const addTask = (taskId: string, title: string, personId: string, end: number) => {
      const source: WriteSource = personId === bob ? { kind: "node", nodeId: "edge-bob" } : "local";
      for (const original of lifecycleFixture({ taskId, executionId: `execution-${taskId}` }).events.slice(0, end)) {
        const identified = JSON.parse(
            JSON.stringify(original)
              .replaceAll("person-owner", personId)
              .replaceAll('"source":"local"', '"source":' + JSON.stringify(source)),
          ) as TaskEventV1,
          task = identified.payload.task,
          event = {
            ...identified,
            workspaceRevision: ++revision,
            eventId: `member-work-event-${revision}`,
            opId: `member-work-${revision}`,
            source,
            payload: {
              ...identified.payload,
              task: {
                ...task,
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
          agendaPage: () => ({ awaitingYou: [], page: { limit: 500, cursor: null, nextCursor: null } }),
        }).briefs;
      assert.equal(workIndexFromProjection(projection).works[0]?.counts.executing, 1);
      assert.deepEqual(
        index.works.map((work) => [work.taskId, work.counts.executing, work.counts.done]),
        [["shared-work", 0, 1]],
      );
      assert.deepEqual(briefs[0]?.sentenceParts, [{ kind: "delivered", title: "Bob completed delivery" }]);
      assert.doesNotMatch(JSON.stringify(briefs), /Alice running implementation/u);
      assert.deepEqual(readPersonalPins(projection, { viewerPersonId: bob }), []);
      assert.equal(
        readPersonalPins(projection, { viewerPersonId: bob, scopePersonId: alice })[0]?.entityRef,
        "task/shared-work",
      );
    };
    assertMemberView();
    assert.equal(projection.rebuild().watermark, revision);
    assertMemberView();
  });
});
