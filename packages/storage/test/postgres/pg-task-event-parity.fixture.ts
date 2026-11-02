import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { CanonicalEventV1, TaskProjectionQueries } from "@harness-anything/kernel";
import { compileTaskProgress } from "@harness-anything/kernel";
import { compileSettingsChangedEvent } from "@harness-anything/kernel/internal/domain/settings-event.ts";
import {
  readSettingsFacet,
  repositorySettings,
  writeRepositorySettingsFacet,
} from "@harness-anything/kernel/internal/domain/settings.ts";
import { compileScheduleDefinitionEvent } from "@harness-anything/kernel/internal/domain/schedule-event.ts";
import { createScheduleV1 } from "@harness-anything/kernel/internal/domain/schedule.ts";
import { compileVerticalDeclarationEvent } from "@harness-anything/kernel/internal/domain/vertical-declaration.ts";
import { decodeVerticalDefinition } from "@harness-anything/kernel/internal/schemas/vertical-definition.ts";
import { sha256Text } from "@harness-anything/kernel/internal/integrity/stable-hash.ts";
import { compileFactWrite } from "@harness-anything/kernel/internal/domain/fact-event.ts";
import { compileEntityPinEvent } from "@harness-anything/kernel/internal/domain/entity-pin-event.ts";
import { lifecycleFixture } from "../../../kernel/test/store/task-lifecycle-fixture.ts";
import { fact } from "../store/relation-graph-projection.fixtures.ts";
import type { CanonicalWriteBundle } from "../../src/store/task-event-store.ts";
import type { PgTaskQueryMethods } from "../../src/pg/pg-task-query-contract.ts";

export const QUERY_SETTINGS_BASE = "schema: harness-anything/v1\nname: parity\nsettings: {}\n";

export function retiredCiQueryFixtures(): readonly CanonicalEventV1[] {
  return [
    "ci-run-observation-v1/accepted",
    "ci-run-observation-v2/accepted",
    "ci-run-observation-v3/accepted",
    "ci-run-observation-v4/workflow",
  ].map((file, index) => ({
    ...JSON.parse(
      readFileSync(new URL(`../../../kernel/fixtures/canonical-events/${file}.json`, import.meta.url), "utf8"),
    ),
    workspaceRevision: index + 1,
    opId: `retired-ci-${index}`,
    eventId: `event-retired-ci-${index}`,
  }));
}

/** Accepted historical carriers: reducers discard retired fields; event_index returns their original payloads. */
export function historicalEventQueryFixtures() {
  const task = lifecycleFixture({ taskId: "historical-task" }).events[0]!;
  assert.equal(task.type, "task_created");
  const actor = task.actor,
    occurredAt = "2026-10-20T00:00:00.000Z",
    schedule = compileScheduleDefinitionEvent({
      type: "schedule_created",
      schedule: createScheduleV1({
        scheduleId: "historical-schedule",
        name: "Historical schedule",
        mode: "detect",
        spec: {
          trigger: { kind: "interval", everyMs: 60_000, anchorAt: occurredAt },
          target: { kind: "agent", agentId: "codex" },
          mission: "Historical event query parity",
        },
        actor,
        occurredAt,
      }),
      eventId: "event-historical-schedule",
      opId: "historical-schedule",
      workspaceRevision: 2,
      actor,
      source: "local",
      occurredAt,
    }),
    settingsBody = readFileSync(
      new URL("../../../kernel/fixtures/settings-migration/retired-settings-before.yaml", import.meta.url),
      "utf8",
    ),
    settings = repositorySettings(readSettingsFacet(settingsBody)),
    settingsBundle = compileSettingsChangedEvent({
      settings,
      baseDocumentBody: settingsBody,
      candidateDocumentBody: writeRepositorySettingsFacet(settingsBody, settings),
      eventId: "event-historical-settings",
      opId: "historical-settings",
      workspaceRevision: 3,
      actor,
      source: "local",
      occurredAt,
    }),
    vertical = compileVerticalDeclarationEvent({
      type: "vertical_declared",
      definition: decodeVerticalDefinition(
        JSON.parse(
          readFileSync(
            new URL("../../../kernel/fixtures/schemas/vertical-definition/valid.json", import.meta.url),
            "utf8",
          ),
        ),
      ),
      eventId: "event-historical-vertical",
      opId: "historical-vertical",
      workspaceRevision: 4,
      actor,
      source: "local",
      occurredAt,
    });
  // These shapes come from the existing retired-shape cold-rebuild fixture, not new-write inputs.
  const retiredTask = {
      ...task,
      workspaceRevision: 1,
      payload: { ...task.payload, task: { ...task.payload.task, closeoutOverrides: { fact: false, codeDoc: true } } },
    },
    retiredSchedule = {
      ...schedule.event,
      payload: {
        ...schedule.event.payload,
        schedule: {
          ...schedule.event.payload.schedule,
          status: { ...schedule.event.payload.schedule.status, ciObserve: { workflow: "rewrite-ci" } },
        },
      },
    },
    retiredSettings = {
      ...settingsBundle.event,
      payload: {
        ...settingsBundle.event.payload,
        settings: {
          ...settings,
          workerPermissions: {
            ...settings.workerPermissions,
            ciRead: true,
            artifactRead: true,
            pullRequest: true,
            merge: true,
            repositorySettings: true,
            gitlab: true,
          },
          delivery: { ...settings.delivery, platform: "github" },
          ci: { workflows: ["rewrite-ci"] },
          gates: [
            ...settings.gates,
            {
              gateId: "ci",
              adapter: "github-actions",
              branch: "main",
              event: "push",
              coverage: "descendant",
              selection: "newest",
            },
          ],
        },
        harnessDocumentClaim: {
          ...settingsBundle.event.payload.harnessDocumentClaim,
          sha256: sha256Text(settingsBody),
          size: Buffer.byteLength(settingsBody),
        },
      },
    },
    retiredVertical = {
      ...vertical.event,
      payload: {
        ...vertical.event.payload,
        declaration: {
          ...vertical.event.payload.declaration,
          definition: {
            ...vertical.event.payload.declaration.definition,
            completion: {
              ...vertical.event.payload.declaration.definition.completion,
              closeoutDefaults: { codeDoc: true },
              sources: { ci: { kind: "github-actions", predicateType: "ci/succeeded", resultSchema: {} } },
              gates: { ci: { source: "ci", appliesTo: "code" } },
            },
          },
        },
      },
    };
  const verticalBody = `${JSON.stringify(retiredVertical.payload.declaration, null, 2)}\n`,
    verticalClaim = {
      ...retiredVertical.payload.declarationDocumentClaim,
      sha256: sha256Text(verticalBody),
      size: Buffer.byteLength(verticalBody),
    };
  return {
    events: [
      retiredTask,
      retiredSchedule,
      retiredSettings,
      { ...retiredVertical, payload: { ...retiredVertical.payload, declarationDocumentClaim: verticalClaim } },
    ] as readonly CanonicalEventV1[],
    blobs: new Map(
      [
        ...schedule.blobs,
        ...settingsBundle.blobs,
        { ...verticalClaim, body: verticalBody },
        { sha256: sha256Text(settingsBody), body: settingsBody },
      ].map(({ sha256, body }) => [sha256, Buffer.from(body)]),
    ),
  };
}

export function historicalEventQueryContract(queries: TaskProjectionQueries, events: readonly CanonicalEventV1[]) {
  const canonical = queries.readCanonicalEvents(0, 500),
    operations = events.map(({ opId }) => queries.readOperation(opId)?.event),
    replica = queries.readReplicaBasis(0),
    head = queries.readReplicaBasis(null).headEvent,
    schedules = queries.readScheduleEvents(),
    byId = queries.readScheduleEvents("historical-schedule");
  assert.deepEqual(head, events.at(-1), "replica head retains this carrier's retired fields");
  assert.deepEqual(canonical.events, events, "canonical history retains retired carrier fields");
  assert.deepEqual(operations, events, "operation history retains retired carrier fields");
  assert.deepEqual(replica.events, events, "replica history retains retired carrier fields");
  assert.deepEqual(
    schedules.events,
    events.filter(({ schema }) => schema === "schedule-event/v1"),
  );
  assert.deepEqual(byId, schedules);
  return {
    canonical,
    operations,
    replicaEvents: replica.events,
    head,
    schedules,
    byId,
    task: queries.read("historical-task").snapshot,
    schedule: queries.getEntity("schedule", "historical-schedule"),
    settings: queries.getEntity("settings", "repository"),
  };
}

export async function appendTaskEventQueryFixtures(
  append: (bundle: CanonicalWriteBundle) => Promise<void>,
  revision: () => number,
): Promise<void> {
  const actor = lifecycleFixture({ taskId: "task-parity", executionId: "execution-parity" }).events[0]!.actor;
  for (const [index, entityRef, pinned] of [
    [0, "task/task-parity", true],
    [1, "fact/F-11111111", true],
    [2, "decision/dec_PG_PARITY", true],
    [3, "decision/dec_PG_PARITY", false],
  ] as const)
    await append(
      compileEntityPinEvent({
        entityRef,
        pinned,
        eventId: `event-query-pin-${index}`,
        opId: `operation-query-pin-${index}`,
        workspaceRevision: revision(),
        actor,
        source: "local",
        occurredAt: `2026-09-02T23:59:0${index}.000Z`,
      }),
    );
  const progress = compileTaskProgress({
    taskId: "task-parity",
    executionId: "execution-parity",
    packagePath: "tasks/task-parity-fixture",
    text: "query parity progress",
    evidence: [],
    currentDocument: null,
    activeLease: null,
    startRecoveryAvailable: false,
    asOwner: true,
    taskCreatedBy: actor,
    actor,
    source: "local",
    eventId: "event-query-progress",
    opId: "operation-query-progress",
    workspaceRevision: revision(),
    occurredAt: "2026-09-03T00:00:00.000Z",
  });
  await append(progress);
  const base = QUERY_SETTINGS_BASE,
    settings = { ...readSettingsFacet(base), locale: "zh-CN" as const };
  await append(
    compileSettingsChangedEvent({
      settings,
      baseDocumentBody: base,
      candidateDocumentBody: writeRepositorySettingsFacet(base, settings),
      eventId: "event-query-settings",
      opId: "operation-query-settings",
      workspaceRevision: revision(),
      actor,
      source: "local",
      occurredAt: "2026-09-03T00:00:01.000Z",
    }),
  );
  const draft = fact(revision());
  await append(
    compileFactWrite({
      event: {
        ...draft,
        factId: "F-44444444",
        payload: {
          ...draft.payload,
          statement: "契約驗證",
          evidenceSource: "測試",
          registersDomainType: "verification",
        },
      },
    }),
  );
}

type EventQueries = Pick<
  TaskProjectionQueries,
  | "readTaskEventExists"
  | "readTaskSubmissionOperation"
  | "readTaskCompletion"
  | "readProgress"
  | "readSettingsEvent"
  | "listFactDomainTypes"
>;
function eventContract(queries: EventQueries) {
  assert.equal(queries.readTaskEventExists("task-parity"), true);
  assert.equal(queries.readTaskEventExists("missing"), false);
  assert.equal(queries.readTaskSubmissionOperation("missing", "missing"), null);
  assert.equal(queries.readTaskCompletion("missing", null), null);
  const progress = queries.readProgress("task-parity"),
    settings = queries.readSettingsEvent(),
    types = queries.listFactDomainTypes();
  assert.equal(progress.rows.length, 1);
  assert.equal(progress.rows[0]?.payload.text, "query parity progress");
  assert.equal(settings?.type, "settings_changed");
  assert.equal(types.domainTypes[0]?.domainType, "verification");
  return {
    progress,
    settings,
    types,
    submission: queries.readTaskSubmissionOperation("task-parity", "execution-parity"),
    completion: queries.readTaskCompletion("task-parity", "execution-parity"),
    emptyProgress: queries.readProgress("missing"),
    wrongExecution: queries.readTaskCompletion("task-parity", "missing"),
  };
}
export function assertTaskEventQueryParity(pg: PgTaskQueryMethods, sqlite: TaskProjectionQueries): void {
  assert.deepEqual(eventContract(pg), eventContract(sqlite));
}
