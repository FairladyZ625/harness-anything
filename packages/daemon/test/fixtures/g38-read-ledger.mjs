// Read-scale replica: seed through the same canonical bundle shapes/reducers as the
// backend parity contract. Setup is outside the measured interval.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  compileVerticalDeclarationEvent,
  compileTaskProgress,
  decodeVerticalDefinition,
  taskLifecycleWritePlan,
  compileRelationCreatedEvent,
  relationEventWritePlan,
  deriveRelationId,
  taskBootstrapWritePlan,
  sha256Text,
  stableStringify,
  compileEntityUpsert,
  createScheduleV1,
  canonicalEventCut,
  canonicalLedgerCut,
  compileScheduleDefinitionEvent,
} from "@harness-anything/kernel";
import { canonicalEventWritePlan } from "../../../storage/src/store/task-event-store.ts";
import { defaultAssets } from "@harness-anything/preset/internal/preset-resolver-common";
import { eventAt, docBundle } from "../../../storage/test/store/task-event-store.fixtures.ts";
import { lifecycleFixture } from "../../../kernel/test/store/task-lifecycle-fixture.ts";
import { appendQueryParityFixtures } from "../../../storage/test/postgres/pg-query-parity.fixture.ts";
import { appendTaskEventQueryFixtures } from "../../../storage/test/postgres/pg-task-event-parity.fixture.ts";
import { appendRuntimeQueryFixtures } from "../../../storage/test/postgres/pg-runtime-query-parity.fixture.ts";

export const READ_TASK_ID = "task_111111111111111111111111";
export const HISTORY_OUTPUT_TASK_ID = "task_333333333333333333333333";
export const READ_ACTIVE_SESSION_ID = "history-active";
export const READ_SESSION_ID = "runtime-query-session";
export const READ_DOCUMENT = `tasks/${READ_TASK_ID}-g38/artifacts/selected.md`;

export async function seedReadLedger({ append, beginHistory = () => {} }, dimension, size) {
  let next = 1,
    dispatchSource,
    plannedCut = canonicalLedgerCut("g38-read", null);
  const currentCut = () => plannedCut;
  const fixDispatchIds = (value) => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (
        /(?:^dispatchId$|DispatchId$)/u.test(key) &&
        typeof child === "string" &&
        !/^dispatch_[a-f0-9]{24}$/u.test(child)
      )
        value[key] = `dispatch_${sha256Text(child).slice(0, 24)}`;
      else fixDispatchIds(child);
    }
  };
  const add = async (bundle) => {
    fixDispatchIds(bundle.event);
    if (bundle.event.type === "runtime_installation_observed") bundle.event.payload.capabilities = ["attach"];
    if (bundle.event.opId === "history-large-event")
      assert.equal(Buffer.byteLength(bundle.event.payload.text), size * 16);
    if (bundle.event.payload?.task) bundle.event.payload.task.packageDisposition = "active";
    if (bundle.event.type === "runtime_session_outcome_observed") {
      const body = "Finished fixture\n",
        claim = { sha256: sha256Text(body), size: Buffer.byteLength(body), mediaType: "text/plain; charset=utf-8" };
      Object.assign(bundle.event.payload, {
        resultRef: `artifact:runtime-result/sha256/${claim.sha256}`,
        result: claim,
        exitCode: bundle.event.payload.exitCode ?? 0,
      });
      if (bundle.event.payload.reasonCode === null) delete bundle.event.payload.reasonCode;
      bundle.plan = canonicalEventWritePlan(bundle.event, "agent-runtime/v1", bundle.event.opId);
      bundle.blobs = [{ ...claim, body }];
    }
    if (bundle.event.schema === "agent-runtime-event/v1")
      bundle.plan = canonicalEventWritePlan(bundle.event, "agent-runtime/v1", bundle.event.opId);
    if (bundle.event.type === "runtime_dispatch_requested") dispatchSource = bundle.event;
    await append(bundle);
    const { opId: _opId, ...identity } = canonicalEventCut("g38-read", bundle.event);
    plannedCut = identity;
    next = bundle.event.workspaceRevision + 1;
  };
  // Full-source audits need exactly k canonical inputs, not the RPC catalog fixture.
  if (dimension === "source-events") {
    beginHistory();
    for (let index = 0; index < size; index++) {
      const event = eventAt(next);
      await add({ event, plan: taskLifecycleWritePlan(event), blobs: [] });
    }
    return { revision: next - 1, baseRevision: 0, growth: size };
  }
  // A real installed vertical and Settings keep the production read runtime's catalog,
  // completion and query judgments active; no fake early-return/failed-action measurements.
  await add(
    compileVerticalDeclarationEvent({
      type: "vertical_declared",
      definition: decodeVerticalDefinition(JSON.parse(readFileSync(`${defaultAssets}/vertical.json`, "utf8"))),
      eventId: "read-vertical",
      opId: "read-vertical",
      workspaceRevision: next,
      actor: { principal: { personId: "person-g38" }, executor: null },
      source: "local",
      occurredAt: "2026-11-04T00:00:00.000Z",
    }),
  );
  await appendQueryParityFixtures(add, () => next);
  const created = eventAt(next);
  created.taskId = READ_TASK_ID;
  created.payload.task.taskId = READ_TASK_ID;
  created.payload.task.title = "G38";
  const snapshotValue = {
      schema: "preset-snapshot/v1",
      id: "standard-task",
      completion: { sources: {}, gates: {}, closeoutDefaults: {} },
    },
    digest = `sha256:${sha256Text(stableStringify(snapshotValue))}`,
    snapshotBody = `${stableStringify({ ...snapshotValue, digest })}\n`,
    body = "Selected output\n",
    snapshotClaim = {
      digest,
      sha256: sha256Text(snapshotBody),
      size: Buffer.byteLength(snapshotBody),
      mediaType: "application/json",
    },
    documentClaim = {
      path: READ_DOCUMENT,
      sha256: sha256Text(body),
      size: Buffer.byteLength(body),
      mediaType: "text/markdown",
      owner: "doc-sync",
      policyId: "markdown-body-replaceable/v1",
    };
  created.schema = "task-bootstrap-event/v1";
  created.type = "task_bootstrapped";
  created.payload.task.presetSnapshotDigest = digest;
  created.payload.presetSnapshotClaim = snapshotClaim;
  created.payload.initialDocumentClaims = [documentClaim];
  await add({
    event: created,
    plan: taskBootstrapWritePlan(created),
    blobs: [
      { ...snapshotClaim, body: snapshotBody },
      { ...documentClaim, body },
    ],
  });
  for (const [taskId, executionId] of [
    ["task-parity", "execution-parity"],
    ["history-task", "history-execution"],
  ]) {
    for (const source of lifecycleFixture({ taskId, executionId }).events.slice(0, 2)) {
      const event = {
        ...source,
        workspaceRevision: next,
        opId: `seed-${taskId}-${source.type}`,
        eventId: `seed-${taskId}-${source.type}`,
      };
      await add({ event, plan: taskLifecycleWritePlan(event), blobs: [] });
    }
  }
  await appendTaskEventQueryFixtures(add, () => next);
  await appendRuntimeQueryFixtures(add, () => next);
  await add(
    compileScheduleDefinitionEvent({
      type: "schedule_created",
      schedule: createScheduleV1({
        scheduleId: "g38-schedule",
        name: "G38 selected schedule",
        mode: "detect",
        spec: {
          trigger: { kind: "interval", everyMs: 60000, anchorAt: "2026-12-01T00:00:00.000Z" },
          target: { kind: "agent", agentId: "g38-agent" },
          mission: "Read-scale fixture",
        },
        actor: created.actor,
        occurredAt: "2026-11-04T00:00:00.000Z",
      }),
      eventId: "read-schedule",
      opId: "read-schedule",
      workspaceRevision: next,
      actor: created.actor,
      source: "local",
      occurredAt: "2026-11-04T00:00:00.000Z",
    }),
  );

  for (const [entityKind, entity] of [
    [
      "agent",
      {
        schema: "agent-declaration/v1",
        id: "g38-agent",
        name: "G38 Agent",
        instructions: "Read-scale selected agent",
        runtimes: [{ type: "codex" }],
      },
    ],
    [
      "squad",
      {
        schema: "squad-declaration/v1",
        id: "g38-squad",
        name: "G38 Squad",
        leader: "g38-agent",
        workers: ["g38-agent"],
        leaderTurnBudget: 8,
        roster: "# G38 squad\n",
      },
    ],
    ["todo", { id: "todo_222222222222222222222222", text: "G38 selected todo", completed: false, archived: false }],
  ])
    await add(
      compileEntityUpsert({
        entityKind,
        entity,
        eventId: `read-${entityKind}`,
        opId: `read-${entityKind}`,
        workspaceRevision: next,
        actor: created.actor,
        source: "local",
        occurredAt: "2026-11-04T00:00:00.000Z",
      }),
    );

  const historyTask = eventAt(next);
  historyTask.taskId = HISTORY_OUTPUT_TASK_ID;
  Object.assign(historyTask.payload.task, { taskId: HISTORY_OUTPUT_TASK_ID, title: "G38 History" });
  await add({ event: historyTask, plan: taskLifecycleWritePlan(historyTask), blobs: [] });
  await add(
    docBundle(
      { currentCut },
      "Selected historical task output\n",
      next,
      "history-selected",
      `tasks/${HISTORY_OUTPUT_TASK_ID}-g38-history/artifacts/selected.md`,
    ),
  );

  const settledSession = async (id, settled = true) => {
    const start = {
      schema: "agent-runtime-event/v1",
      type: "runtime_session_started",
      eventId: `session-${id}`,
      opId: `session-${id}`,
      workspaceRevision: next,
      occurredAt: "2026-08-01T00:00:00.000Z",
      actor: { principal: { personId: "person-g38" }, executor: null },
      source: "local",
      payload: {
        runtimeSessionId: `history-${id}`,
        instanceId: "runtime-query-instance",
        installationId: "runtime-query-installation",
        kindId: "codex",
        definitionSnapshotRef: "artifact:runtime-definitions/codex/v1",
        taskBinding: { taskId: "history-task", executionId: "history-execution" },
        launchGeneration: 1,
        attachable: !settled,
      },
    };
    await add({ event: start, plan: canonicalEventWritePlan(start, "agent-runtime/v1", start.opId), blobs: [] });
    if (!settled) return;
    const exited = {
      ...start,
      eventId: `exited-${id}`,
      opId: `exited-${id}`,
      workspaceRevision: next,
      type: "runtime_session_exited",
      payload: { runtimeSessionId: `history-${id}` },
    };
    await add({ event: exited, plan: canonicalEventWritePlan(exited, "agent-runtime/v1", exited.opId), blobs: [] });
    const outcome = {
      ...start,
      eventId: `outcome-${id}`,
      opId: `outcome-${id}`,
      workspaceRevision: next,
      type: "runtime_session_outcome_observed",
      payload: { runtimeSessionId: `history-${id}`, outcome: "succeeded", reasonCode: null, resultRef: null },
    };
    await add({
      event: outcome,
      plan: null, // add() attaches the complete result claim before compiling this plan.
      blobs: [],
    });
  };
  await settledSession("active", false);
  const activeDispatch = structuredClone(dispatchSource);
  Object.assign(activeDispatch, {
    eventId: "read-active-dispatch",
    opId: "read-active-dispatch",
    workspaceRevision: next,
    occurredAt: "2026-11-05T00:00:00.000Z",
  });
  Object.assign(activeDispatch.payload, {
    dispatchId: "read-active-dispatch",
    dispatchKey: "read-active",
    runtimeSessionId: READ_ACTIVE_SESSION_ID,
    taskId: "history-task",
    executionId: "history-execution",
    attemptGroupId: "read-active",
    attemptIndex: 1,
    startedAt: "2026-11-05T00:00:00.000Z",
  });
  delete activeDispatch.payload.reviewTarget;
  await add({
    event: activeDispatch,
    plan: canonicalEventWritePlan(activeDispatch, "agent-runtime/v1", activeDispatch.opId),
    blobs: [],
  });

  const baseRevision = next - 1;
  beginHistory();
  // Each dispatch has its own settled session, as a real completed launch does.
  // The runtime-only axis isolates session cost; selected subjects stay fixed on both axes.
  // Fixed-width ids/body metadata prevent decimal-id growth looking like IO noise.
  for (let index = 0; index < size; index++) {
    const id = String(index).padStart(8, "0");
    if (dimension === "runtime-sessions") {
      await settledSession(id);
    } else if (dimension === "task-outputs") {
      await add(
        docBundle(
          { currentCut },
          "Historical output\n",
          next,
          `output-${id}`,
          `tasks/${HISTORY_OUTPUT_TASK_ID}-g38-history/artifacts/${id}.md`,
        ),
      );
    } else if (dimension === "dispatches") {
      await settledSession(id);
      const event = structuredClone(dispatchSource);
      Object.assign(event, {
        workspaceRevision: next,
        opId: `dispatch-${id}`,
        eventId: `dispatch-${id}`,
        occurredAt: "2026-08-01T00:00:00.000Z",
      });
      Object.assign(event.payload, {
        dispatchId: `dispatch-history-${id}`,
        dispatchKey: `history-${id}`,
        runtimeSessionId: `history-${id}`,
        attemptGroupId: `history-attempt-${id}`,
        attemptIndex: 1,
        taskId: "history-task",
        executionId: "history-execution",
        startedAt: "2026-08-01T00:00:00.000Z",
      });
      delete event.payload.resumedFromDispatchId;
      delete event.payload.reviewTarget;
      await add({ event, plan: canonicalEventWritePlan(event, "agent-runtime/v1", event.opId), blobs: [] });
    } else if (dimension === "relations") {
      const identity = {
        source: `task/history-${id}`,
        target: `task/other-${id}`,
        type: "depends-on",
        direction: "directed",
      };
      const event = compileRelationCreatedEvent({
        opId: `relation-${id}`,
        workspaceRevision: next,
        actor: created.actor,
        source: "local",
        occurredAt: "2026-08-01T00:00:00.000Z",
        record: {
          ...identity,
          relation_id: deriveRelationId(identity),
          origin: "declared",
          state: "active",
          rationale: "Historical relation",
          targetObservedVersion: null,
        },
      });
      await add({ event, plan: relationEventWritePlan(event), blobs: [] });
    }
  }
  if (dimension === "event-bytes") {
    // Fixed event count and fixed selected results, only an unrelated event body grows.
    await add(
      compileTaskProgress({
        taskId: "history-task",
        executionId: "history-execution",
        packagePath: "tasks/history-task-fixture",
        text: "x".repeat(size * 16),
        evidence: [],
        currentDocument: null,
        activeLease: null,
        startRecoveryAvailable: false,
        asOwner: true,
        taskCreatedBy: lifecycleFixture().events[0].actor,
        actor: lifecycleFixture().events[0].actor,
        source: "local",
        eventId: "history-large-event",
        opId: "history-large-event",
        workspaceRevision: next,
        occurredAt: "2026-08-01T00:00:00.000Z",
      }),
    );
  }
  return {
    revision: next - 1,
    baseRevision,
    growth:
      dimension === "event-bytes"
        ? 1
        : size * (dimension === "runtime-sessions" ? 3 : dimension === "dispatches" ? 4 : 1),
  };
}
