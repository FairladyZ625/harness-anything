import assert from "node:assert/strict";
import type { TaskProjectionQueries } from "@harness-anything/kernel";
import { compileTaskProgress } from "@harness-anything/kernel";
import { compileSettingsChangedEvent } from "@harness-anything/kernel/internal/domain/settings-event.ts";
import { readSettingsFacet, writeRepositorySettingsFacet } from "@harness-anything/kernel/internal/domain/settings.ts";
import { compileFactWrite } from "@harness-anything/kernel/internal/domain/fact-event.ts";
import { lifecycleFixture } from "../../../kernel/test/store/task-lifecycle-fixture.ts";
import { fact } from "../store/relation-graph-projection.fixtures.ts";
import type { CanonicalWriteBundle } from "../../src/store/task-event-store.ts";
import type { PgTaskQueryMethods } from "../../src/pg/pg-task-query-contract.ts";

export async function appendTaskEventQueryFixtures(
  append: (bundle: CanonicalWriteBundle) => Promise<void>,
  revision: () => number,
): Promise<void> {
  const actor = lifecycleFixture({ taskId: "task-parity", executionId: "execution-parity" }).events[0]!.actor;
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
  const base = "schema: harness-anything/v1\nname: parity\nsettings: {}\n",
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
