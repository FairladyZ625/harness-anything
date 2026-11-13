// harness-test-tier: fast
import { lifecycleReadForSync } from "./dispatch-lifecycle-read.fixtures.ts";
import assert from "node:assert/strict";
import { emptyCompletionContract } from "../../kernel/test/domain/completion.fixtures.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { type TaskProjection, type TaskProjectionListQuery, type TaskRelationQuery } from "@harness-anything/kernel";
import { seedRelationProjection } from "../../storage/test/store/relation-graph-projection.fixtures.ts";
import {
  canonicalRoot,
  validateDaemonAgenda,
  validateDaemonRelationGraph,
} from "../src/protocol/daemon-protocol.contract.ts";
import { readTaskWipSnapshot, wipSnapshotEntries, type TaskQueryCell } from "../src/repo-cell-task-query.ts";
import { readTaskCompletion } from "../src/task-completion-read.ts";
import { parseDaemonGuiReadResult } from "../src/protocol/gui-result-validation.ts";
import {
  blockingOf,
  emptyTaskLifecycleSnapshot,
  reduceTaskEvent,
  submissionDigest,
  taskCompletionNext,
} from "@harness-anything/kernel";
import { lifecycleFixture } from "../../kernel/test/store/task-lifecycle-fixture.ts";
import { makeTaskQueryReadModel } from "../src/task-query-read.ts";
import { appendIncidentActionReceipt } from "../src/decision-incident-receipt.ts";
import { openDispatchStream } from "../src/dispatch-stream.ts";
import {
  eventEdge,
  executionRow,
  projectionStub,
  protocolTaskRow,
  readyCut,
  taskContractProjection,
  type ProjectionCut,
} from "./task-query-read.fixtures.ts";

const secondEventEdge = {
  ...eventEdge,
  relationId: "rel_event_truth_second",
  sourceRef: "task/task_event",
  targetRef: "task/task_second",
  relationType: "depends-on" as const,
  ownerRef: "task/task_event",
};
const neighborhoodQuery = () => ({
  seed: "task/task_event",
  direction: "both" as const,
  relationTypes: ["derives", "depends-on"] as const,
  maxDepth: 2,
  maxNodes: 20,
  state: "active" as const,
});

test("wide and narrow relation reads ignore an authored-only L1/L2 edge", (t) => {
  const rootDir = legacyRoot(t),
    read = queryRead(rootDir, projectionStub());

  assert.deepEqual(legacyRelationIds(rootDir), ["rel_positive"]);
  const wide = read.relationGraphNeighborhood(neighborhoodQuery()),
    narrow = read.relationGraphPage({ state: "active" });

  assert.deepEqual(wide.edges, [{ ...eventEdge, current: true }]);
  assert.deepEqual(narrow.edges, wide.edges);
  assert.deepEqual(projectionCut(wide), readyCut);
  assert.deepEqual(projectionCut(narrow), readyCut);
});

test("pending event truth stays pending and never borrows L1 readiness", (t) => {
  const rootDir = legacyRoot(t),
    pendingCut = { status: "pending" as const, watermark: 6, sourceRevision: 7 },
    result = queryRead(rootDir, projectionStub({ cut: pendingCut })).relationGraphNeighborhood(neighborhoodQuery());

  assert.deepEqual(result.edges, [{ ...eventEdge, current: true }]);
  assert.deepEqual(projectionCut(result), pendingCut);
  assert.equal(result.warnings[0]?.code, "relation_truth_unavailable");
});

test("relation filters, facets, and pages select one event-backed edge universe", () => {
  const calls: TaskRelationQuery[] = [],
    read = queryRead(process.cwd(), projectionStub({ calls, edges: [eventEdge, secondEventEdge] })),
    wide = read.relationGraphNeighborhood(neighborhoodQuery()),
    filtered = read.relationGraphPage({ relationType: "derives" }),
    first = read.relationGraphPage({ limit: 1 }),
    second = read.relationGraphPage({ limit: 1, cursor: first.page?.nextCursor }),
    facet = read.relationGraphFacet({ facet: "edges" });

  assert.deepEqual(
    filtered.edges.map(({ relationId }) => relationId),
    [eventEdge.relationId],
  );
  assert.deepEqual(
    [...first.edges, ...second.edges].map(({ relationId }) => relationId),
    wide.edges.map(({ relationId }) => relationId),
  );
  assert.deepEqual(
    facet.edges.map(({ relationId }) => relationId),
    wide.edges.map(({ relationId }) => relationId),
  );
  assert.deepEqual(projectionCut(first), readyCut);
  assert.deepEqual(projectionCut(facet), readyCut);
  assert.deepEqual(
    calls.map(({ relationType, limit, cursor }) => ({ relationType, limit, cursor })),
    [
      { relationType: "derives", limit: undefined, cursor: undefined },
      { relationType: undefined, limit: 1, cursor: undefined },
      { relationType: undefined, limit: 1, cursor: "page-2" },
      { relationType: undefined, limit: 500, cursor: undefined },
    ],
  );
});

test("task control, review queue, and decision detail expose one real cut", () => {
  const read = queryRead(process.cwd(), projectionStub()),
    tasks = read.guiTasks(),
    agenda = read.agenda(),
    detail = read.relationGraphNeighborhood(neighborhoodQuery());

  assert.deepEqual(projectionCut(tasks), readyCut);
  assert.deepEqual(projectionCut(agenda), readyCut);
  assert.deepEqual(projectionCut(detail), readyCut);
});

test("task control narrows graph, status, and decision reads to the selected lifecycle page", () => {
  const dependencyCalls: string[][] = [],
    targetCalls: { targetRefs: readonly string[]; relationType: string }[] = [],
    statusCalls: string[][] = [],
    decisionCalls: string[][] = [],
    dependency = { ...secondEventEdge, sourceRef: "task/task_event", targetRef: "task/task_blocker" },
    derives = { ...eventEdge, sourceRef: "decision/dec_event", targetRef: "task/task_event" },
    projection = projectionStub({
      taskRows: [activeTaskRow("task_event")],
      edges: [dependency, derives],
      dependencyCalls,
      targetCalls,
      statusCalls,
      decisionCalls,
    });

  const result = queryRead(process.cwd(), projection).guiTasks({ limit: 1 });

  assert.equal(result.rows.length, 1);
  assert.deepEqual(result.invalidRows, []);
  assert.deepEqual(dependencyCalls, [["task/task_event"]]);
  assert.deepEqual(targetCalls, [
    { targetRefs: ["task/task_event"], relationType: "depends-on" },
    { targetRefs: ["task/task_event"], relationType: "derives" },
  ]);
  assert.deepEqual(statusCalls, [["task_event", "task_blocker"]]);
  assert.deepEqual(decisionCalls, [["dec_event"]]);
});

test("an unparameterized guiTasks read serves one default-bounded page, never the full ledger", () => {
  const listCalls: TaskProjectionListQuery[] = [],
    projection = projectionStub({
      taskRows: Array.from({ length: 501 }, (_, index) =>
        protocolTaskRow(`task_page_${String(index).padStart(4, "0")}`),
      ),
      listCalls,
    });

  const result = queryRead(process.cwd(), projection).guiTasks();

  assert.equal(listCalls.length, 1);
  assert.equal(listCalls[0]?.presentationStatus, true);
  assert.equal(listCalls[0]?.decisionRelationsOnly, true);
  assert.equal(listCalls[0]?.taskIds?.length, 500);
  assert.equal(result.rows.length, 500);
  assert.deepEqual(result.page, { limit: 500, cursor: null, nextCursor: "task_page_0499" });
});

test("task snapshot list isolates an invalid row and continues serving valid rows", () => {
  const malformedGateWitness = {
      schema: "completion-gate-witness/v1",
      subjects: [],
      predicateType: "human/v1",
      predicate: {},
      diagnostic: "human attestation",
      witnessId: "",
      receiptId: "receipt-1",
      checkerId: "signoff",
      gateId: "signoff",
      result: "pass",
      taskId: "task_invalid",
      executionId: "execution-invalid",
      commitSha: "a".repeat(40),
      iteration: 0,
      actor: { principal: { personId: "person-owner" }, executor: null },
      source: "local",
      verifiedAt: "2026-09-01T00:00:00.000Z",
      observed: true,
      basis: {
        executionId: "execution-invalid",
        iteration: 0,
        submissionDigest: `sha256:${"a".repeat(64)}`,
        codeCommit: "a".repeat(40),
      },
      provenance: { source: "human", adapterId: "manual-attest", runId: "run-1", rawResult: "approved" },
    },
    result = queryRead(
      process.cwd(),
      projectionStub({
        taskRows: [protocolTaskRow("task_valid"), protocolTaskRow("task_invalid", [malformedGateWitness])],
      }),
    ).guiTasks();

  process.stdout.write(
    `[ROW-ISOLATION] inputRows=2 validRows=${result.rows.length} invalidRows=${result.invalidRows.length} ` +
      `field=${result.invalidRows[0]?.field ?? "missing"}\n`,
  );
  assert.deepEqual(
    result.rows.map(({ taskId }) => taskId),
    ["task_valid"],
  );
  assert.deepEqual(
    result.invalidRows.map(({ message: _message, ...diagnostic }) => diagnostic),
    [{ rowIndex: 1, taskId: "task_invalid", field: "rows[1].snapshot.gateWitnesses[0]" }],
  );
  assert.match(result.invalidRows[0]!.message, /^actual=.*Task snapshot field is invalid\.$/u);
});

test("a surface fails closed instead of stitching mismatched projection cuts", () => {
  const projection = projectionStub({ decisionCut: { ...readyCut, watermark: 8, sourceRevision: 8 } }),
    read = queryRead(process.cwd(), projection);
  assert.throws(
    () => read.relationGraphNeighborhood(neighborhoodQuery()),
    /relation graph neighborhood spans multiple event projection cuts/u,
  );
  assert.throws(() => read.guiTasks(), /task control surface spans multiple event projection cuts/u);
  assert.throws(() => read.agenda(), /review queue spans multiple event projection cuts/u);
});

test("agenda reads one narrow lifecycle page per status and no wide-assembly reads", () => {
  const listCalls: TaskProjectionListQuery[] = [],
    decisionCalls: string[][] = [],
    projection = projectionStub({
      taskRows: [protocolTaskRow("task_event", [], { status: "active" })],
      listCalls,
      decisionCalls,
    });

  const result = queryRead(process.cwd(), projection).agenda();

  assert.deepEqual(listCalls, [
    { taskIds: ["task_event"], presentationStatus: true, decisionRelationsOnly: true },
    { taskIds: [], presentationStatus: true, decisionRelationsOnly: true },
    { taskIds: [], presentationStatus: true, decisionRelationsOnly: true },
    { taskIds: [], presentationStatus: true, decisionRelationsOnly: true },
    { taskIds: [], presentationStatus: true, decisionRelationsOnly: true },
  ]);
  assert.deepEqual(decisionCalls, []);
  assert.deepEqual(
    result.waitingOnOthers.map(({ taskId }) => taskId),
    ["task_event"],
  );
});

test("attentionOnly agenda reads raw lifecycle status and skips the presentation-only pages", () => {
  const listCalls: TaskProjectionListQuery[] = [],
    decisionCalls: string[][] = [],
    projection = projectionStub({
      taskRows: [protocolTaskRow("task_event", [], { status: "active" })],
      listCalls,
      decisionCalls,
    });

  const result = queryRead(process.cwd(), projection).agenda({ attentionOnly: true });

  // Home consumes only the four waiting buckets: blocked/planned pages and the full work-root
  // scan are not read, and the three remaining pages ask for lifecycle status (index-bounded).
  assert.deepEqual(listCalls, [
    { taskIds: ["task_event"], presentationStatus: false, decisionRelationsOnly: true },
    { taskIds: [], presentationStatus: false, decisionRelationsOnly: true },
    { taskIds: [], presentationStatus: false, decisionRelationsOnly: true },
  ]);
  assert.deepEqual(decisionCalls, []);
  assert.deepEqual(result.attentionItems, []);
  assert.deepEqual(result.pinnedEntities, []);
  assert.deepEqual(validateDaemonAgenda(result), []);
});

test("agenda labels each task row with its nearest work root and --work keeps one work's subtree", () => {
  const child = (taskId: string, parentTaskId: string | null, taskClass: "standard" | "work" = "standard") => {
      const row = protocolTaskRow(taskId, [], { status: "active", taskClass });
      return {
        ...row,
        snapshot: {
          ...row.snapshot,
          task: { ...row.snapshot.task, title: `${taskId} title`, metadata: { parentTaskId } },
        },
      };
    },
    rows = [
      child("release", null, "work"),
      child("lane", "release", "standard"),
      child("leaf", "lane"),
      child("solo", null),
      child("other-leaf", "other", "standard"),
      child("other", null, "work"),
    ],
    byId = new Map(rows.map((row) => [row.taskId, row] as const)),
    stub = projectionStub({ taskRows: rows }),
    projection = {
      ...stub,
      read: (taskId: string) => ({ ...readyCut, packagePath: null, snapshot: byId.get(taskId)?.snapshot ?? {} }),
      listEntities: () => [],
      readTaskIndex: (query: TaskProjectionListQuery = {}) => {
        const scopeIds = (() => {
          if (query.scopeRootTaskId === undefined) return null;
          const ids = new Set([query.scopeRootTaskId]);
          let changed = true;
          while (changed) {
            changed = false;
            for (const row of rows) {
              const parent = row.snapshot.task.metadata.parentTaskId;
              if (parent && ids.has(parent) && !ids.has(row.taskId)) {
                ids.add(row.taskId);
                changed = true;
              }
            }
          }
          return ids;
        })();
        return {
          ...readyCut,
          rows: rows
            .filter(
              ({ taskId }) =>
                (query.taskIds === undefined || query.taskIds.includes(taskId)) &&
                (scopeIds === null || scopeIds.has(taskId)),
            )
            .map(({ taskId, snapshot: { task } }) => ({
              taskId,
              title: task.title,
              status: task.status,
              taskClass: task.taskClass,
              parentTaskId: task.metadata.parentTaskId,
              pinned: false,
              packageDisposition: "active",
              packagePath: null,
              updatedAt: "2026-08-30T00:00:00.000Z",
            })),
          warnings: [],
        };
      },
    } as unknown as TaskProjection,
    labels = (agenda: ReturnType<ReturnType<typeof queryRead>["agenda"]>) =>
      Object.fromEntries(agenda.waitingOnOthers.map(({ taskId, work }) => [taskId, work?.title ?? null]));
  assert.deepEqual(labels(queryRead(process.cwd(), projection).agenda()), {
    release: null,
    lane: "release title",
    leaf: "release title",
    solo: null,
    "other-leaf": "other title",
    other: null,
  });
  assert.deepEqual(labels(queryRead(process.cwd(), projection).agenda({ work: "release" })), {
    release: null,
    lane: "release title",
    leaf: "release title",
  });
});

test("agenda groups a changes_requested return into awaiting rework, not the in-flight line", () => {
  const taskRows = [
      reworkTaskRow("task_returned"),
      reworkTaskRow("task_resubmitted", [
        executionRow("exe_old", 0, "changes_requested"),
        executionRow("exe_new", 1, "active"),
      ]),
      leasedTaskRow("task_flying"),
      reworkTaskRow("task_accepted", [executionRow("exe_done", 0, "accepted")]),
      protocolTaskRow("task_idle", [], { status: "active" }),
    ],
    base = projectionStub({ taskRows }),
    projection = {
      ...base,
      readDispatchLifecycle: lifecycleReadForSync([
        {
          runtimeSessionId: "runtime_resubmitted",
          dispatchId: `dispatch_${createHash("sha256").update("resubmitted").digest("hex").slice(0, 24)}`,
          process: "alive",
        },
      ]),
      readTaskStatuses: (taskIds: readonly string[]) => ({
        ...readyCut,
        rows: taskIds.map((taskId) => ({ taskId, status: "active" })),
      }),
      // The restarted round has a dispatched worker, so it is genuinely in flight.
      readRuntimeDispatchesByTaskExecution: (taskId: string, executionId: string) =>
        taskId === "task_resubmitted" && executionId === "exe_new"
          ? [
              {
                outcome: null,
                event: {
                  payload: {
                    dispatchId: `dispatch_${createHash("sha256").update("resubmitted").digest("hex").slice(0, 24)}`,
                    runtimeSessionId: "runtime_resubmitted",
                  },
                },
              },
            ]
          : [],
      readRuntimeSession: () => null,
    } as unknown as TaskProjection,
    result = makeTaskQueryReadModel({
      rootDir: canonicalRoot(process.cwd()),
      projection,
      readPinnedEntities: () => [],
      judgments: {
        closeout: (() => ({ readiness: "missing", blocker: "execution", gates: [] })) as never,
        blocking: ((tasks: readonly { taskId: string }[]) =>
          tasks.map(({ taskId }) => ({
            taskId,
            state: "clear",
            label: "none",
            blockers: [],
            warnings: [],
          }))) as never,
      },
    }).agenda();

  // 阴性→阳性对照:打回任务此前四组全落空,现在只进「等我修」。
  assert.deepEqual(
    (result.awaitingRework ?? []).map(({ taskId }) => taskId),
    ["task_returned"],
  );
  assert.deepEqual(
    result.inFlight.map(({ taskId }) => taskId),
    ["task_flying", "task_resubmitted"],
  );
  for (const group of [result.waitingOnOthers, result.dispatchable])
    assert.equal(
      group.some(({ taskId }) => taskId === "task_returned"),
      false,
    );
  assert.equal(result.awaitingDecision.length, 0);
  assert.match(result.summary, /在飞线 \(2\) — status=active/u);
  assert.match(
    result.summary,
    /等我修 \(1\) — status=active 且最新 execution=changes_requested[\s\S]*- task_returned/u,
  );
  // The produced result passes the same wire validator the GUI-side parser uses.
  assert.deepEqual(validateDaemonAgenda(result), []);
});

test("agenda flags a stopped worker without delivery, but excludes leased, submitted, and resumed executions", () => {
  const taskRow = (taskId: string, executionId: string, options: { lease?: boolean; submitted?: boolean } = {}) => {
      const row = protocolTaskRow(taskId, [], { status: "active" }),
        execution = {
          ...executionRow(executionId, 0, options.submitted ? "submitted" : "active", taskId),
          submission: options.submitted ? { commitSha: "a".repeat(40), artifacts: [] } : null,
        };
      return {
        ...row,
        packagePath: `tasks/${taskId}`,
        snapshot: {
          ...row.snapshot,
          executions: [execution],
          ...(options.lease
            ? {
                lease: {
                  schema: "lease/v1",
                  taskId,
                  executionId,
                  actor: { principal: { personId: "person-owner" }, executor: null },
                  source: "local",
                  phase: "held",
                  expiresAt: "2026-08-30T03:00:00.000Z",
                  ttlMs: 60_000,
                  version: 1,
                },
              }
            : {}),
        },
      };
    },
    dispatchIdFor = (name: string) => `dispatch_${createHash("sha256").update(name).digest("hex").slice(0, 24)}`,
    dispatch = (
      taskId: string,
      executionId: string,
      dispatchId: string,
      runtimeSessionId: string,
      options: { readonly role?: string; readonly squadId?: string } = {},
    ) => ({
      outcome: "stopped" as const,
      event: {
        occurredAt: "2026-10-22T01:00:00.000Z",
        payload: { taskId, executionId, dispatchId: dispatchIdFor(dispatchId), runtimeSessionId, ...options },
      },
    }),
    dispatches = [
      dispatch("task_unsubmitted", "exe_unsubmitted", "dispatch_unsubmitted", "runtime_unsubmitted"),
      dispatch("task_leased", "exe_leased", "dispatch_leased", "runtime_leased"),
      dispatch("task_submitted", "exe_submitted", "dispatch_submitted", "runtime_submitted"),
      dispatch("task_resumed", "exe_resumed", "dispatch_resumed", "runtime_resumed"),
      dispatch("task_reviewer", "exe_reviewer", "dispatch_reviewer", "runtime_reviewer", { role: "reviewer" }),
      dispatch("task_squad", "exe_squad", "dispatch_squad", "runtime_squad", { squadId: "squad_x" }),
    ],
    sessionEvents = new Map(
      dispatches.map(({ event }) => [
        event.payload.runtimeSessionId,
        [
          {
            schema: "agent-runtime-event/v1",
            type: "runtime_session_outcome_observed",
            payload: {
              outcome: "stopped",
              endedAt: "2026-10-22T01:01:00.000Z",
              attempt: { classification: "worker_stop" },
            },
          },
        ],
      ]),
    ),
    base = projectionStub({
      taskRows: [
        taskRow("task_unsubmitted", "exe_unsubmitted"),
        taskRow("task_leased", "exe_leased", { lease: true }),
        taskRow("task_submitted", "exe_submitted", { submitted: true }),
        taskRow("task_resumed", "exe_resumed"),
        taskRow("task_reviewer", "exe_reviewer"),
        taskRow("task_squad", "exe_squad"),
      ],
    }),
    projection = {
      ...base,
      readDispatchLifecycle: lifecycleReadForSync(
        dispatches.map(({ event }) => ({
          ...event.payload,
          attemptSettled: true,
          outcome: "stopped",
          ...(event.payload.runtimeSessionId === "runtime_resumed"
            ? { currentDispatchId: dispatchIdFor("dispatch_next") }
            : {}),
        })),
      ),
      readTaskStatuses: (taskIds: readonly string[]) => ({
        ...readyCut,
        rows: taskIds.map((taskId) => ({ taskId, status: "active" as const })),
      }),
      readRuntimeDispatchesByTaskExecution: (taskId: string, executionId: string) =>
        dispatches.filter(({ event }) => event.payload.taskId === taskId && event.payload.executionId === executionId),
      readRuntimeSessionEvents: () => {
        throw new Error("bounded session reads must use readRuntimeSessionEventsByType");
      },
      readRuntimeSessionEventsByType: (runtimeSessionId: string) => sessionEvents.get(runtimeSessionId) ?? [],
      readRuntimeDispatchByResumeSource: (dispatchId: string) =>
        dispatchId === dispatchIdFor("dispatch_resumed")
          ? { event: { payload: { dispatchId: dispatchIdFor("dispatch_next") } } }
          : null,
      readDocument: taskContractProjection,
    } as unknown as TaskProjection,
    result = makeTaskQueryReadModel({
      rootDir: canonicalRoot(process.cwd()),
      projection,
      readPinnedEntities: () => [],
      judgments: {
        closeout: (() => ({ readiness: "missing", blocker: "execution", gates: [] })) as never,
        blocking: ((tasks: readonly { taskId: string }[]) =>
          tasks.map(({ taskId }) => ({ taskId, state: "clear", label: "none", blockers: [], warnings: [] }))) as never,
      },
    }).agenda();

  assert.deepEqual(
    result.attentionItems.filter(({ kind }) => kind === "unsubmitted-delivery").map(({ ref, region }) => [ref, region]),
    [["task/task_unsubmitted", "mine"]],
  );
  // A stopped worker releases the lease and leaves the execution active for `ha task start` to
  // reconnect; no worker is running, so the in-flight "just wait" line is the wrong place.
  assert.equal(
    result.inFlight.some(({ taskId }) => taskId === "task_unsubmitted"),
    false,
  );
  assert.deepEqual(
    result.awaitingRestart
      .filter(({ taskId }) => taskId === "task_unsubmitted")
      .map(({ taskId, next }) => [taskId, next]),
    [["task_unsubmitted", "ha task start task_unsubmitted"]],
  );
  assert.deepEqual(validateDaemonAgenda(result), []);
});

test("agenda keeps a leased or live-runtime execution in flight and names start for a lapsed lease", () => {
  const taskRow = (taskId: string, executionId: string, leasePhase: "held" | "orphaned" | null = null) => {
      const row = protocolTaskRow(taskId, [], { status: "active" });
      return {
        ...row,
        packagePath: `tasks/${taskId}`,
        snapshot: {
          ...row.snapshot,
          executions: [executionRow(executionId, 0, "active", taskId)],
          ...(leasePhase === null
            ? {}
            : {
                lease: {
                  schema: "lease/v1",
                  taskId,
                  executionId,
                  actor: { principal: { personId: "person-owner" }, executor: null },
                  source: "local",
                  phase: leasePhase,
                  expiresAt: "2026-08-30T03:00:00.000Z",
                  ttlMs: 60000,
                  version: 1,
                },
              }),
        },
      };
    },
    dispatch = (
      taskId: string,
      executionId: string,
      dispatchId: string,
      runtimeSessionId: string,
      outcome: "stopped" | "failed" | null,
    ) => ({
      outcome,
      event: {
        occurredAt: "2026-10-22T01:00:00.000Z",
        payload: {
          taskId,
          executionId,
          dispatchId: `dispatch_${createHash("sha256").update(dispatchId).digest("hex").slice(0, 24)}`,
          runtimeSessionId,
        },
      },
    }),
    dispatches = [
      dispatch("task_restart", "exe_restart", "dispatch_restart", "runtime_restart", "stopped"),
      dispatch("task_failed", "exe_failed", "dispatch_failed", "runtime_failed", "failed"),
      dispatch("task_orphaned", "exe_orphaned", "dispatch_orphaned", "runtime_orphaned", "stopped"),
      dispatch("task_live", "exe_live", "dispatch_live", "runtime_live", null),
      dispatch("task_lease", "exe_lease", "dispatch_lease", "runtime_lease", "stopped"),
    ],
    base = projectionStub({
      taskRows: [
        taskRow("task_restart", "exe_restart"),
        taskRow("task_failed", "exe_failed"),
        taskRow("task_orphaned", "exe_orphaned", "orphaned"),
        taskRow("task_live", "exe_live"),
        taskRow("task_lease", "exe_lease", "held"),
      ],
    }),
    projection = {
      ...base,
      readDispatchLifecycle: lifecycleReadForSync(
        dispatches.map(({ event, outcome }) => ({
          ...event.payload,
          attemptSettled: outcome !== null,
          outcome,
          process: outcome === null ? "alive" : "exited",
        })),
      ),
      readTaskStatuses: (taskIds: readonly string[]) => ({
        ...readyCut,
        rows: taskIds.map((taskId) => ({ taskId, status: "active" as const })),
      }),
      readRuntimeDispatchesByTaskExecution: (taskId: string, executionId: string) =>
        dispatches.filter(({ event }) => event.payload.taskId === taskId && event.payload.executionId === executionId),
      readRuntimeSession: (runtimeSessionId: string) =>
        runtimeSessionId === "runtime_live"
          ? ({ runtimeSessionId, liveness: "live", outcome: null, taskBindings: [] } as never)
          : null,
      readRuntimeSessionEvents: () => [],
      readRuntimeSessionEventsByType: () => [],
      readRuntimeDispatchByResumeSource: () => null,
      readDocument: taskContractProjection,
    } as unknown as TaskProjection,
    result = makeTaskQueryReadModel({
      rootDir: canonicalRoot(process.cwd()),
      projection,
      readPinnedEntities: () => [],
      judgments: {
        closeout: (() => ({ readiness: "missing", blocker: "execution", gates: [] })) as never,
        blocking: ((tasks: readonly { taskId: string }[]) =>
          tasks.map(({ taskId }) => ({ taskId, state: "clear", label: "none", blockers: [], warnings: [] }))) as never,
      },
    }).agenda();

  assert.deepEqual(
    result.inFlight.map(({ taskId }) => taskId),
    ["task_lease", "task_live"],
  );
  assert.deepEqual(
    result.awaitingRestart.map(({ taskId, next }) => [taskId, next]),
    [
      ["task_failed", "ha task start task_failed"],
      ["task_orphaned", "ha task start task_orphaned"],
      ["task_restart", "ha task start task_restart"],
    ],
  );
  assert.match(result.summary, /在飞线 \(2\)[\s\S]*task_lease[\s\S]*task_live/u);
  assert.match(
    result.summary,
    /待你重启 \(3\)[\s\S]*task_failed[\s\S]*下一步: ha task start task_failed[\s\S]*task_orphaned[\s\S]*下一步: ha task start task_orphaned[\s\S]*task_restart[\s\S]*下一步: ha task start task_restart/u,
  );
  const inFlightSection = result.summary.split("\n\n").find((section) => section.startsWith("在飞线"));
  assert.doesNotMatch(inFlightSection ?? "", /task_restart/u);
  assert.deepEqual(validateDaemonAgenda(result), []);
});

test("agenda restart rows take the complete completion next, including contract anomalies", () => {
  const taskRow = (taskId: string, taskPatch: Readonly<Record<string, unknown>> = {}) => {
      const row = protocolTaskRow(taskId, [], { status: "active" });
      return {
        ...row,
        packagePath: `tasks/${taskId}`,
        snapshot: {
          ...row.snapshot,
          task: { ...row.snapshot.task!, ...taskPatch },
          executions: [executionRow(`exe_${taskId}`, 0, "active", taskId)],
        },
      };
    },
    dispatch = (taskId: string) => ({
      outcome: "stopped" as const,
      event: {
        occurredAt: "2026-10-22T01:00:00.000Z",
        payload: {
          taskId,
          executionId: `exe_${taskId}`,
          dispatchId: `dispatch_${createHash("sha256").update(taskId).digest("hex").slice(0, 24)}`,
          runtimeSessionId: `runtime_${taskId}`,
        },
      },
    }),
    projection = {
      ...projectionStub({
        taskRows: [taskRow("task_preset_gap", { presetSnapshotGap: true }), taskRow("task_closeout_missing")],
      }),
      readTaskStatuses: (taskIds: readonly string[]) => ({
        ...readyCut,
        rows: taskIds.map((taskId) => ({ taskId, status: "active" as const })),
      }),
      readRuntimeDispatchesByTaskExecution: (taskId: string) => [dispatch(taskId)],
      readDispatchLifecycle: lifecycleReadForSync(
        ["task_preset_gap", "task_closeout_missing"].map((taskId) => ({
          ...dispatch(taskId).event.payload,
          attemptSettled: true,
          outcome: "stopped",
        })),
      ),
      readRuntimeSession: () => null,
      readRuntimeSessionEvents: () => [],
      readRuntimeSessionEventsByType: () => [],
      readRuntimeDispatchByResumeSource: () => null,
      readDocument: (documentPath: string) =>
        documentPath.includes("task_closeout_missing")
          ? { ...readyCut, document: { body: JSON.stringify({ documents: [] }) } }
          : taskContractProjection(documentPath),
    } as unknown as TaskProjection,
    result = makeTaskQueryReadModel({
      rootDir: canonicalRoot(process.cwd()),
      projection,
      readPinnedEntities: () => [],
      judgments: {
        closeout: (() => ({ readiness: "missing", blocker: "execution", gates: [] })) as never,
        blocking: ((tasks: readonly { taskId: string }[]) =>
          tasks.map(({ taskId }) => ({ taskId, state: "clear", label: "none", blockers: [], warnings: [] }))) as never,
      },
    }).agenda();

  // The restart decision does not invent a second priority ladder: when task show would first ask
  // for a contract migration, the agenda row names that same command.
  assert.deepEqual(
    result.awaitingRestart.map(({ taskId, next }) => [taskId, next]),
    [
      ["task_closeout_missing", "ha task contract migrate --apply --task task_closeout_missing"],
      ["task_preset_gap", "ha task contract migrate --task task_preset_gap --to-preset standard-task --apply"],
    ],
  );
  assert.deepEqual(result.inFlight, []);
  assert.deepEqual(validateDaemonAgenda(result), []);
});

test("agenda projects incident escalation receipts, including a rejected owner write", (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-incident-agenda-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const taskId = "task_incident_agenda",
    executionId = "execution_incident_agenda",
    dispatchId = "dispatch_0123456789abcdef01234567",
    currentDispatchId = "dispatch_1123456789abcdef01234567",
    event = {
      schema: "agent-runtime-event/v1",
      type: "runtime_dispatch_requested",
      occurredAt: "2026-10-23T12:00:00.000Z",
      payload: {
        taskId,
        executionId,
        dispatchId,
        runtimeSessionId: "runtime_incident_agenda",
        attemptGroupId: dispatchId,
        attemptIndex: 0,
        startedAt: "2026-10-23T12:00:00.000Z",
      },
    } as never,
    currentEvent = {
      ...event,
      occurredAt: "2026-10-23T12:02:00.000Z",
      payload: {
        ...event.payload,
        dispatchId: currentDispatchId,
        runtimeSessionId: "runtime_incident_agenda_current",
        attemptGroupId: currentDispatchId,
        startedAt: "2026-10-23T12:02:00.000Z",
      },
    } as never,
    task = protocolTaskRow(taskId, [], { status: "active" }),
    taskWithExecution = {
      ...task,
      packagePath: `tasks/${taskId}`,
      snapshot: { ...task.snapshot, executions: [executionRow(executionId, 1, "active", taskId)] },
    };
  openDispatchStream(rootDir, {
    dispatchId,
    taskId,
    executionId,
    runtimeSessionId: "runtime_incident_agenda",
    instanceId: "instance-codex",
    startedAt: "2026-10-23T12:00:00.000Z",
    binding: { actor: { principal: { personId: "person-owner" } }, source: "local" },
  });
  appendIncidentActionReceipt(rootDir, dispatchId, {
    pointId: "runtime-incident-worker-stop",
    questionVersion: "runtime-incident-disposition/v1",
    status: "applied",
    selected: "needs_attention",
    action: "needs_attention",
    reason: "question: Decisions provider failed with decision_transport.",
    successorDispatchId: null,
    budget: { used: 0, limit: 3, source: "repository" },
    decidedAt: "2026-10-23T12:01:00.000Z",
  });
  openDispatchStream(rootDir, {
    dispatchId: currentDispatchId,
    taskId,
    executionId,
    runtimeSessionId: "runtime_incident_agenda_current",
    instanceId: "instance-codex",
    startedAt: "2026-10-23T12:02:00.000Z",
    binding: { actor: { principal: { personId: "person-owner" } }, source: "local" },
  });
  appendIncidentActionReceipt(rootDir, currentDispatchId, {
    pointId: "runtime-incident-worker-stop",
    questionVersion: "runtime-incident-disposition/v1",
    // The pre-fix executor persisted this failed result after relation-relate was rejected. Keeping
    // failed needs_attention receipts actionable also recovers incidents already on dispatch streams;
    // it rides the round's last dispatch, the one question not superseded by a later dispatch.
    status: "failed",
    selected: "needs_attention",
    action: "needs_attention",
    reason: "question: Decisions provider failed with decision_transport; owner await write settled as op_rejected.",
    successorDispatchId: null,
    budget: { used: 0, limit: 3, source: "repository" },
    decidedAt: "2026-10-23T12:03:00.000Z",
  });
  const base = projectionStub({ taskRows: [taskWithExecution] }),
    projection = {
      ...base,
      readDispatchLifecycle: lifecycleReadForSync(
        [event, currentEvent].map(({ payload }) => ({ ...payload, attemptSettled: true, outcome: "stopped" })),
      ),
      readDocuments: () => ({ documents: [] }),
      readRuntimeDispatchesByTaskExecution: () => [{ event }, { event: currentEvent }],
      readRuntimeDispatchByResumeSource: () => null,
      readRuntimeDispatchesByAttemptGroup: () => [],
    } as unknown as TaskProjection,
    result = makeTaskQueryReadModel({
      rootDir: canonicalRoot(rootDir),
      projection,
      readPinnedEntities: () => [],
      judgments: {
        closeout: (() => ({ readiness: "missing", blocker: "execution", gates: [] })) as never,
        blocking: ((tasks: readonly { taskId: string }[]) =>
          tasks.map(({ taskId }) => ({ taskId, state: "clear", label: "none", blockers: [], warnings: [] }))) as never,
      },
    }).agenda();

  assert.deepEqual(result.awaitingRuling, [
    {
      taskId,
      title: taskId,
      work: null,
      pinned: false,
      dispatchId: currentDispatchId,
      executionId,
      attention: "question",
      question:
        "question: Decisions provider failed with decision_transport; owner await write settled as op_rejected.",
      options: [],
      askedAt: "2026-10-23T12:03:00.000Z",
      blockingAssessment: {
        taskId,
        state: "unknown",
        label: "unresolved",
        blockers: [],
        warnings: ["task snapshot missing from blocking judgment"],
      },
    },
  ]);
  assert.match(result.summary, /待你处理 \(1\)/u);
  assert.match(result.summary, /Decisions provider failed with decision_transport/u);
  assert.match(result.summary, /owner await write settled as op_rejected/u);
  assert.deepEqual(validateDaemonAgenda(result), []);
});

test("agenda labels a guard escalation as needs-handling instead of an owner question", (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-incident-guard-agenda-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const taskId = "task_incident_guard",
    executionId = "execution_incident_guard",
    dispatchId = "dispatch_aa3456789abcdef012345678",
    reason =
      "needs_attention: the automatic disposition budget is exhausted. Worker stopped without a submitted delivery on round 4; automatic redispatch budget 3/3 used. Next: ha agent run worker_agent --task task_incident_guard",
    event = {
      schema: "agent-runtime-event/v1",
      type: "runtime_dispatch_requested",
      occurredAt: "2026-10-28T11:00:00.000Z",
      payload: {
        taskId,
        executionId,
        dispatchId,
        runtimeSessionId: "runtime_incident_guard",
        attemptGroupId: dispatchId,
        attemptIndex: 0,
        startedAt: "2026-10-28T11:00:00.000Z",
      },
    } as never,
    task = protocolTaskRow(taskId, [], { status: "active" }),
    taskWithExecution = {
      ...task,
      packagePath: `tasks/${taskId}`,
      snapshot: { ...task.snapshot, executions: [executionRow(executionId, 1, "active", taskId)] },
    };
  openDispatchStream(rootDir, {
    dispatchId,
    taskId,
    executionId,
    runtimeSessionId: "runtime_incident_guard",
    instanceId: "instance-codex",
    startedAt: "2026-10-28T11:00:00.000Z",
    binding: { actor: { principal: { personId: "person-owner" } }, source: "local" },
  });
  appendIncidentActionReceipt(rootDir, dispatchId, {
    pointId: "runtime-incident-worker-stop",
    questionVersion: "runtime-incident-disposition/v1",
    status: "applied",
    selected: "needs_attention",
    action: "needs_attention",
    attention: "guard",
    reason,
    successorDispatchId: null,
    budget: { used: 3, limit: 3, source: "daemon" },
    decidedAt: "2026-10-28T11:01:00.000Z",
  });
  const base = projectionStub({ taskRows: [taskWithExecution] }),
    projection = {
      ...base,
      readDispatchLifecycle: lifecycleReadForSync([{ ...event.payload, attemptSettled: true, outcome: "stopped" }]),
      readDocuments: () => ({ documents: [] }),
      readRuntimeDispatchesByTaskExecution: () => [{ event }],
      readRuntimeDispatchByResumeSource: () => null,
      readRuntimeDispatchesByAttemptGroup: () => [],
    } as unknown as TaskProjection,
    result = makeTaskQueryReadModel({
      rootDir: canonicalRoot(rootDir),
      projection,
      readPinnedEntities: () => [],
      now: () => new Date("2026-10-28T12:00:00.000Z"),
      judgments: {
        closeout: (() => ({ readiness: "missing", blocker: "execution", gates: [] })) as never,
        blocking: ((tasks: readonly { taskId: string }[]) =>
          tasks.map(({ taskId }) => ({ taskId, state: "clear", label: "none", blockers: [], warnings: [] }))) as never,
      },
    }).agenda();

  assert.deepEqual(
    result.awaitingRuling?.map(({ dispatchId: id, attention, options }) => [id, attention, options]),
    [[dispatchId, "guard", []]],
  );
  const guard = result.attentionItems.find(({ ref }) => ref === `dispatch/${dispatchId}`);
  assert.equal(guard?.kind, "needs-handling");
  assert.deepEqual(guard?.attention.reasons[0], { label: "需要 CEO 处理", contribution: 80 });
  assert.doesNotMatch(result.summary, /等你裁决 \(1\)/u);
  assert.match(result.summary, /待你处理 \(1\)/u);
  assert.match(result.summary, /需要处理: needs_attention: the automatic disposition budget is exhausted/u);
  assert.match(result.summary, /Next: ha agent run worker_agent --task task_incident_guard/u);
  assert.deepEqual(validateDaemonAgenda(result), []);
});

test("terminal dispatch receipts leave the awaiting-ruling queue", (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-incident-terminal-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const submission = { schema: "submission/v1", submissionDigest: `sha256:${"a".repeat(64)}` },
    dispatchOf = (suffix: string, taskId: string, executionId: string, at: string) => ({
      event: {
        schema: "agent-runtime-event/v1",
        type: "runtime_dispatch_requested",
        occurredAt: at,
        payload: {
          taskId,
          executionId,
          dispatchId: `dispatch_${suffix}`,
          runtimeSessionId: `runtime_${suffix}`,
          attemptGroupId: `dispatch_${suffix}`,
          attemptIndex: 0,
          startedAt: at,
        },
      } as never,
    }),
    needsAttentionReceipt = (suffix: string, at: string, action: "needs_attention" | "no_action" = "needs_attention") =>
      appendIncidentActionReceipt(rootDir, `dispatch_${suffix}`, {
        pointId: "runtime-incident-worker-stop",
        questionVersion: "runtime-incident-disposition/v1",
        status: "applied",
        selected: action,
        action,
        reason:
          action === "needs_attention"
            ? `question: dispatch_${suffix} needs an owner disposition.`
            : `Owner dismissed dispatch_${suffix}: the delivery landed through a later dispatch.`,
        successorDispatchId: null,
        budget: null,
        decidedAt: at,
      }),
    openStream = (suffix: string, taskId: string, executionId: string, at: string) =>
      openDispatchStream(rootDir, {
        dispatchId: `dispatch_${suffix}`,
        taskId,
        executionId,
        runtimeSessionId: `runtime_${suffix}`,
        instanceId: "instance-codex",
        startedAt: at,
        binding: { actor: { principal: { personId: "person-owner" } }, source: "local" },
      }),
    dispatchesByExecution = new Map<string, unknown[]>(),
    rowsFor = (taskId: string, executions: readonly unknown[]) => {
      const row = protocolTaskRow(taskId, [], { status: "active" });
      return { ...row, snapshot: { ...row.snapshot, executions: [...executions] } };
    };
  // task_terminal_submitted: the receipt's own execution already carries a submission (task_63acdc95's
  // three stale receipts all had this shape — changes_requested rounds with a delivery in them).
  openStream("a00000000000000000000000", "task_terminal_submitted", "execution_submitted", "2026-10-22T15:22:43.000Z");
  needsAttentionReceipt("a00000000000000000000000", "2026-10-22T15:23:00.000Z");
  dispatchesByExecution.set("execution_submitted", [
    dispatchOf(
      "a00000000000000000000000",
      "task_terminal_submitted",
      "execution_submitted",
      "2026-10-22T15:22:43.000Z",
    ),
  ]);
  // task_terminal_superseded: a fresh dispatch followed the incident inside the same round, so the
  // round moved past the incident even though the execution never submitted.
  openStream(
    "b00000000000000000000000",
    "task_terminal_superseded",
    "execution_superseded",
    "2026-10-23T11:29:44.000Z",
  );
  needsAttentionReceipt("b00000000000000000000000", "2026-10-23T11:30:00.000Z");
  openStream(
    "b00000000000000000000001",
    "task_terminal_superseded",
    "execution_superseded",
    "2026-10-23T11:51:01.000Z",
  );
  dispatchesByExecution.set("execution_superseded", [
    dispatchOf(
      "b00000000000000000000000",
      "task_terminal_superseded",
      "execution_superseded",
      "2026-10-23T11:29:44.000Z",
    ),
    dispatchOf(
      "b00000000000000000000001",
      "task_terminal_superseded",
      "execution_superseded",
      "2026-10-23T11:51:01.000Z",
    ),
  ]);
  // task_terminal_replaced: the incident's round was replaced by a later iteration (abandoned, no
  // submission of its own), so the task's newest question lives in the later round.
  openStream(
    "c00000000000000000000000",
    "task_terminal_replaced",
    "execution_replaced_old",
    "2026-10-22T15:37:23.000Z",
  );
  needsAttentionReceipt("c00000000000000000000000", "2026-10-22T15:38:00.000Z");
  dispatchesByExecution.set("execution_replaced_old", [
    dispatchOf(
      "c00000000000000000000000",
      "task_terminal_replaced",
      "execution_replaced_old",
      "2026-10-22T15:37:23.000Z",
    ),
  ]);
  // task_terminal_dismissed: a live incident the owner already closed with a reason — the receipt's
  // action is no_action, so it no longer awaits a ruling.
  openStream("d00000000000000000000000", "task_terminal_dismissed", "execution_dismissed", "2026-10-24T05:56:47.000Z");
  needsAttentionReceipt("d00000000000000000000000", "2026-10-24T06:10:00.000Z", "no_action");
  dispatchesByExecution.set("execution_dismissed", [
    dispatchOf(
      "d00000000000000000000000",
      "task_terminal_dismissed",
      "execution_dismissed",
      "2026-10-24T05:56:47.000Z",
    ),
  ]);
  // task_incident_live: the control — last dispatch of the current, unsubmitted round; still listed.
  openStream("e00000000000000000000000", "task_incident_live", "execution_live", "2026-10-24T04:19:35.000Z");
  needsAttentionReceipt("e00000000000000000000000", "2026-10-24T05:56:47.000Z");
  dispatchesByExecution.set("execution_live", [
    dispatchOf("e00000000000000000000000", "task_incident_live", "execution_live", "2026-10-24T04:19:35.000Z"),
  ]);
  const projection = {
      ...projectionStub({
        taskRows: [
          rowsFor("task_terminal_submitted", [
            { ...executionRow("execution_submitted", 0, "changes_requested", "task_terminal_submitted"), submission },
          ]),
          rowsFor("task_terminal_superseded", [
            executionRow("execution_superseded", 0, "active", "task_terminal_superseded"),
          ]),
          rowsFor("task_terminal_replaced", [
            executionRow("execution_replaced_old", 0, "abandoned", "task_terminal_replaced"),
            executionRow("execution_replaced_new", 1, "active", "task_terminal_replaced"),
          ]),
          rowsFor("task_terminal_dismissed", [
            executionRow("execution_dismissed", 0, "active", "task_terminal_dismissed"),
          ]),
          rowsFor("task_incident_live", [executionRow("execution_live", 0, "active", "task_incident_live")]),
        ],
      }),
      readDispatchLifecycle: lifecycleReadForSync(
        [...dispatchesByExecution.values()]
          .flat()
          .map(({ event }) => ({ ...event.payload, attemptSettled: true, outcome: "stopped" })),
      ),
      readDocuments: () => ({ documents: [] }),
      readRuntimeDispatchesByTaskExecution: (_taskId: string, executionId: string) =>
        dispatchesByExecution.get(executionId) ?? [],
      readRuntimeDispatchByResumeSource: () => null,
      readRuntimeDispatchesByAttemptGroup: () => [],
    } as unknown as TaskProjection,
    result = makeTaskQueryReadModel({
      rootDir: canonicalRoot(rootDir),
      projection,
      readPinnedEntities: () => [],
      judgments: {
        closeout: (() => ({ readiness: "missing", blocker: "execution", gates: [] })) as never,
        blocking: ((tasks: readonly { taskId: string }[]) =>
          tasks.map(({ taskId }) => ({ taskId, state: "clear", label: "none", blockers: [], warnings: [] }))) as never,
      },
    }).agenda();

  assert.deepEqual(
    result.awaitingRuling.map(({ taskId, dispatchId }) => [taskId, dispatchId]),
    [["task_incident_live", "dispatch_e00000000000000000000000"]],
  );
  assert.deepEqual(validateDaemonAgenda(result), []);
});

test("agenda adds idle active tasks after seven days and ranks indexed downstream blockers", () => {
  const stale = protocolTaskRow("task_stale", [], { status: "active" }),
    recent = { ...protocolTaskRow("task_recent", [], { status: "active" }), updatedAt: "2026-09-25T00:00:00.000Z" },
    downstream = (id: string) => ({
      ...secondEventEdge,
      relationId: `rel_${id}`,
      sourceRef: `task/${id}`,
      targetRef: "task/task_stale",
    }),
    targetCalls: { targetRefs: readonly string[]; relationType: string }[] = [],
    baseProjection = projectionStub({
      taskRows: [stale, recent],
      edges: [downstream("child_a"), downstream("child_b")],
      targetCalls,
    }),
    projection = {
      ...baseProjection,
      readTaskStatuses: (taskIds: readonly string[]) => ({
        ...readyCut,
        rows: taskIds.map((taskId) => ({ taskId, status: "active" as const })),
      }),
    } as unknown as TaskProjection,
    result = makeTaskQueryReadModel({
      rootDir: canonicalRoot(process.cwd()),
      projection,
      readPinnedEntities: () => [],
      now: () => new Date("2026-09-29T12:00:00.000Z"),
      judgments: {
        closeout: (() => ({ readiness: "missing", blocker: "execution", gates: [] })) as never,
        blocking: ((tasks: readonly { taskId: string }[]) =>
          tasks.map(({ taskId }) => ({ taskId, state: "clear", label: "none", blockers: [], warnings: [] }))) as never,
      },
    }).agenda();

  assert.deepEqual(
    result.stalled.map(({ taskId }) => taskId),
    ["task_stale"],
  );
  assert.equal(result.attentionItems[0]?.ref, "task/task_stale");
  assert.deepEqual(result.attentionItems[0]?.attention.reasons, [
    { label: "进行中停滞", contribution: 40 },
    { label: "阻塞 2 个下游任务", contribution: 24 },
    { label: "31 天无活动（每天 +2，封顶 20）", contribution: 20 },
  ]);
  assert.match(result.summary, /注意力顺序（前 7 条） \(1\)[\s\S]*\[84\] task_stale/u);
  assert.ok(targetCalls.some(({ relationType }) => relationType === "depends-on"));
  assert.deepEqual(validateDaemonAgenda(result), []);
});

test("agenda splits awaiting work by next action and keeps every row in exactly one group", () => {
  const result = makeTaskQueryReadModel({
    rootDir: canonicalRoot(process.cwd()),
    projection: projectionStub({
      taskRows: [
        statusTaskRow("task_wait_adjudicate", "submitted", [
          executionRow("exe_submitted", 0, "submitted", "task_wait_adjudicate"),
        ]),
        statusTaskRow("task_under_review", "in_review", [
          executionRow("exe_review", 0, "submitted", "task_under_review"),
        ]),
        reworkTaskRow("task_returned"),
      ],
      decisionAgenda: [
        {
          decisionId: "dec_split",
          title: "Split the agenda groups",
          riskTier: "medium",
          urgency: "high",
          proposedAt: "2026-09-20T00:00:00.000Z",
        },
      ],
    }),
    readPinnedEntities: () => [],
    judgments: {
      closeout: (() => ({ readiness: "missing", blocker: "execution", gates: [] })) as never,
      blocking: ((tasks: readonly { taskId: string }[]) =>
        tasks.map(({ taskId }) => ({
          taskId,
          state: "clear",
          label: "none",
          blockers: [],
          warnings: [],
        }))) as never,
    },
  }).agenda();

  // 三种 task 状态各落各组；默认免审的 proposed decision 只落待裁组，互不重复。
  assert.deepEqual(
    result.awaitingAdjudication.map(({ taskId }) => taskId),
    ["task_wait_adjudicate"],
  );
  assert.deepEqual(
    result.underReview.map(({ taskId }) => taskId),
    ["task_under_review"],
  );
  assert.deepEqual(
    result.awaitingRework.map(({ taskId }) => taskId),
    ["task_returned"],
  );
  assert.deepEqual(
    result.awaitingDecision.map(({ decisionId }) => decisionId),
    ["dec_split"],
  );
  assert.equal(
    result.awaitingAdjudication.some(({ executionId }) => executionId === "exe_review"),
    false,
  );
  assert.equal(
    result.underReview.some(({ executionId }) => executionId === "exe_submitted"),
    false,
  );
  assert.match(result.summary, /待派审 \(1\)[\s\S]*task_wait_adjudicate/u);
  assert.match(result.summary, /评审中 \(1\)[\s\S]*task_under_review/u);
  assert.match(result.summary, /待裁 Decision \(1\)[\s\S]*dec_split/u);
  // The produced result passes the same wire validator the GUI-side parser uses.
  assert.deepEqual(validateDaemonAgenda(result), []);
});

test("agenda lists awaits addressed to the reader first and moves the held task out of the dispatch queue", () => {
  const awaitsEdge = (relationId: string, sourceRef: string, personId: string, rationale: string) => ({
      ...eventEdge,
      relationId,
      sourceRef,
      targetRef: `person/${personId}`,
      relationType: "awaits" as const,
      targetObservedVersion: null,
      currentTargetVersion: null,
      rationale,
      ownerRef: sourceRef,
    }),
    edges = [
      awaitsEdge("rel_ask_owner", "task/task_held", "owner", "acceptance: 请亲自上手验收总览页"),
      awaitsEdge("rel_ask_other", "task/task_other", "someone_else", "question: 另一个人的问题"),
      { ...awaitsEdge("rel_answered", "task/task_free", "owner", "consent: 已答复"), state: "retired" as const },
      { ...awaitsEdge("rel_followed", "task/task_moved", "owner", "question: 已跟进"), state: "retired" as const },
    ],
    planned = (taskId: string) => protocolTaskRow(taskId),
    readModel = (principalId?: string) =>
      makeTaskQueryReadModel({
        rootDir: canonicalRoot(process.cwd()),
        projection: projectionStub({
          edges,
          taskRows: [planned("task_held"), planned("task_other"), planned("task_free"), planned("task_moved")],
        }),
        readPinnedEntities: () => [],
        judgments: {
          closeout: (() => ({ readiness: "missing", blocker: "execution", gates: [] })) as never,
          // 状态读桩为空,这里直接给出三条 planned 任务,让真实 kernel 判定消费 awaits 边。
          blocking: (_tasks, relations, state) =>
            blockingOf(
              ["task_held", "task_other", "task_free", "task_moved"].map((taskId) => ({ taskId, status: "planned" })),
              relations,
              state,
            ),
        },
      }).agenda(principalId === undefined ? {} : { principalId }),
    result = readModel("owner");

  // 只收指向读者本人的 active awaits;retired(已答复)与别人的请求不进「等你处理」。
  assert.deepEqual(result.awaitingYou, [
    {
      relationId: "rel_ask_owner",
      relationRevision: 5,
      sourceRef: "task/task_held",
      title: "task_held",
      status: "planned",
      personId: "owner",
      askKind: "acceptance",
      question: "请亲自上手验收总览页",
      askedAt: "2026-09-28T00:00:00.000Z",
      askedBy: "codex-sol",
    },
  ]);
  // 已答复的边只对源实体归属人(task 创建者 person-owner)列出;答复后源已写过的(task_moved)出列。
  assert.deepEqual(result.answeredForYou, []);
  const owner = readModel("person-owner");
  assert.deepEqual(owner.answeredForYou, [
    {
      relationId: "rel_answered",
      sourceRef: "task/task_free",
      title: "task_free",
      status: "planned",
      personId: "owner",
      askKind: "consent",
      question: "已答复",
      answer: "同意",
      answeredAt: "2026-09-28T01:00:00.000Z",
      answeredBy: "codex-sol",
    },
  ]);
  assert.match(
    owner.summary,
    /已答复，待你跟进 \(1\)[\s\S]*答（codex-sol @ [^）]+）: 同意\n {2}下一步: ha task show task_free/u,
  );
  assert.deepEqual(validateDaemonAgenda(owner), []);
  // 被 active awaits 挂住的任务(不论等谁)离开可派队列,进「球在别人手里」并带上原因。
  assert.deepEqual(
    result.dispatchable.map(({ taskId }) => taskId),
    ["task_free", "task_moved"],
  );
  assert.deepEqual(
    result.waitingOnOthers.map(({ taskId }) => taskId),
    ["task_held", "task_other"],
  );
  assert.match(result.summary, /📌 重点关注 \(0\)[\s\S]*等你处理 \(1\)[\s\S]*待裁 Decision \(0\)[\s\S]*在飞线/u);
  assert.match(
    result.summary,
    /- \[acceptance\] task\/task_held task_held \[planned\] — 请亲自上手验收总览页\n {2}答复: ha relation unrelate rel_ask_owner --reason "<答复>" --expected-version 5/u,
  );
  assert.match(result.summary, /- task_held task_held（阻塞: 等 owner acceptance: 请亲自上手验收总览页）/u);
  assert.deepEqual(validateDaemonAgenda(result), []);
  // 读绑定没有 principal 时不猜读者:「等你处理」为空,阻塞判定照旧。
  const anonymous = readModel();
  assert.deepEqual(anonymous.awaitingYou, []);
  assert.deepEqual(
    anonymous.dispatchable.map(({ taskId }) => taskId),
    ["task_free", "task_moved"],
  );
});

test("awaits anchored on terminal sources leave both queues while open sources stay", () => {
  const awaitsEdge = (relationId: string, sourceRef: string, personId: string, rationale: string) => ({
      ...eventEdge,
      relationId,
      sourceRef,
      targetRef: `person/${personId}`,
      relationType: "awaits" as const,
      targetObservedVersion: null,
      currentTargetVersion: null,
      rationale,
      ownerRef: sourceRef,
    }),
    edges = [
      // active asks:终态源(cancelled task、in_effect decision)与开放源(planned、proposed)对照。
      awaitsEdge("rel_ask_cancelled", "task/task_cancelled_src", "owner", "acceptance: 已取消任务上的验收"),
      awaitsEdge("rel_ask_in_effect", "decision/dec_in_effect", "owner", "consent: 已生效决策的同意"),
      awaitsEdge("rel_ask_open", "task/task_open_src", "owner", "acceptance: 开放任务验收"),
      awaitsEdge("rel_ask_proposed", "decision/dec_proposed", "owner", "consent: 待裁决策同意"),
      // answered(retired):源实体在答复之前就已终态且答复后再无写入——快照里 19 条滞留的形状。
      {
        ...awaitsEdge("rel_answered_done", "task/task_done_src", "owner", "consent: 已答复的终态任务"),
        state: "retired" as const,
      },
      {
        ...awaitsEdge("rel_answered_rejected", "decision/dec_rejected", "owner", "question: 已答复的已驳回决策"),
        state: "retired" as const,
      },
      {
        ...awaitsEdge("rel_answered_open", "task/task_planned_src", "owner", "question: 已答复的开放任务"),
        state: "retired" as const,
      },
      {
        ...awaitsEdge("rel_answered_proposed", "decision/dec_proposed_b", "owner", "reopen: 已答复的待裁决策"),
        state: "retired" as const,
      },
    ],
    stub = projectionStub({
      edges,
      taskRows: [
        protocolTaskRow("task_cancelled_src", [], { status: "cancelled" }),
        protocolTaskRow("task_open_src", [], { status: "planned" }),
        protocolTaskRow("task_done_src", [], { status: "done" }),
        protocolTaskRow("task_planned_src", [], { status: "planned" }),
      ],
      decisions: {
        dec_in_effect: { state: "in_effect", proposerPersonId: "person-owner" },
        dec_proposed: { state: "proposed", proposerPersonId: "person-owner" },
        dec_rejected: { state: "rejected", proposerPersonId: "person-owner" },
        dec_proposed_b: { state: "proposed", proposerPersonId: "person-owner" },
      },
    }),
    readModel = (principalId: string) =>
      makeTaskQueryReadModel({
        rootDir: canonicalRoot(process.cwd()),
        projection: stub,
        readPinnedEntities: () => [],
        judgments: {
          closeout: (() => ({ readiness: "missing", blocker: "execution", gates: [] })) as never,
          blocking: (() => []) as never,
        },
      }).agenda({ principalId });

  // 终态源的 active 提问不再等读者处理;开放源照常。
  assert.deepEqual(
    readModel("owner").awaitingYou.map(({ sourceRef }) => sourceRef),
    ["task/task_open_src", "decision/dec_proposed"],
  );
  // 答复后源实体已终态的,没有跟进对象,不进「已答复待跟进」;planned/proposed 源照常等下一次写入。
  assert.deepEqual(
    readModel("person-owner").answeredForYou.map(({ sourceRef }) => sourceRef),
    ["task/task_planned_src", "decision/dec_proposed_b"],
  );
  assert.deepEqual(validateDaemonAgenda(readModel("person-owner")), []);
  assert.match(readModel("person-owner").summary, /已答复，待你跟进 \(2\)/u);
});

test("agenda counts a cut as reviewed only by an approval of its current submission with no undisposed disagreement", () => {
  const commitSha = "c".repeat(40),
    submission = (claim: string) => ({
      commitSha,
      completionClaim: claim,
      deliverables: [],
      outputs: [],
      verificationNotes: [],
      knownGaps: [],
      residualRisks: [],
      completionContract: emptyCompletionContract,
    }),
    submitted = (taskId: string, claim: string) => ({
      ...executionRow(`exe_${taskId}`, 0, "submitted", taskId),
      submittedAt: "2026-08-30T01:00:00.000Z",
      submission: submission(claim),
    }),
    review = (taskId: string, reviewId: string, verdict: string, claim: string) => ({
      schema: "review/v1",
      reviewId,
      taskId,
      executionId: `exe_${taskId}`,
      verdict,
      commitSha,
      iteration: 0,
      submissionDigest: submissionDigest(submission(claim) as never),
      reviewedAt: "2026-08-30T01:30:00.000Z",
    }),
    reviewedRow = (taskId: string, claim: string, reviews: readonly unknown[], reviewDispositions?: unknown[]) => {
      const row = statusTaskRow(taskId, "in_review", [submitted(taskId, claim)]);
      return {
        ...row,
        snapshot: { ...row.snapshot, reviews: [...reviews], ...(reviewDispositions ? { reviewDispositions } : {}) },
      };
    },
    disposition = (taskId: string, reviewIds: readonly string[]) => ({
      schema: "review-disposition/v1",
      dispositionId: `disposition_${taskId}`,
      taskId,
      executionId: `exe_${taskId}`,
      iteration: 0,
      submissionDigest: submissionDigest(submission("current") as never),
      disposedReviewIds: [...reviewIds],
      rationale: "Out of this cut's scope.",
    }),
    result = makeTaskQueryReadModel({
      rootDir: canonicalRoot(process.cwd()),
      projection: projectionStub({
        taskRows: [
          reviewedRow("task_settled", "current", [review("task_settled", "r_ok", "approved", "current")]),
          // Approved before an amendment that kept the commit: the approval is of the old submission.
          reviewedRow("task_amended", "current", [review("task_amended", "r_old", "approved", "before amend")]),
          reviewedRow("task_disagreed", "current", [
            review("task_disagreed", "r_yes", "approved", "current"),
            review("task_disagreed", "r_no", "changes_requested", "current"),
          ]),
          reviewedRow(
            "task_disposed",
            "current",
            [
              review("task_disposed", "r_yes", "approved", "current"),
              review("task_disposed", "r_no", "changes_requested", "current"),
            ],
            [disposition("task_disposed", ["r_no"])],
          ),
        ],
      }),
      readPinnedEntities: () => [],
      judgments: {
        closeout: (() => ({ readiness: "missing", blocker: "execution", gates: [] })) as never,
        blocking: ((tasks: readonly { taskId: string }[]) =>
          tasks.map(({ taskId }) => ({ taskId, state: "clear", label: "none", blockers: [], warnings: [] }))) as never,
      },
    }).agenda();

  assert.deepEqual(
    result.underReview.map(({ taskId }) => taskId),
    ["task_amended", "task_disagreed"],
  );
  assert.deepEqual(validateDaemonAgenda(result), []);
});

test("task reads conclude active when event truth never stated packageDisposition", () => {
  const row = taskRowWithoutDisposition(),
    projection = projectionStub({ taskRows: [row] }),
    cell = { projection } as unknown as TaskQueryCell;

  assert.equal(wipSnapshotEntries(cell, "task_missing")[0]?.packageDisposition, "active");
  const imported = activeTaskRow("task_imported") as { snapshot: { task: Record<string, unknown> } };
  delete imported.snapshot.task.packageDisposition;
  const tasks = queryRead(process.cwd(), projectionStub({ taskRows: [imported] })).guiTasks();
  assert.equal(tasks.invalidRows.length, 0);
  assert.match(JSON.stringify(tasks.rows), /"packageDisposition":"active"/u);
});

test("task WIP read returns daemon-counted leaves and root assessments", (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "task-wip-read-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const projection = projectionStub({
      taskRows: [
        protocolTaskRow("task_leaf", [], { status: "active" }),
        protocolTaskRow("task_work", [], { status: "blocked", taskClass: "work" }),
        protocolTaskRow("task_derived", [], { status: "in_review" }),
      ],
      childCounts: { task_leaf: 0, task_work: 2, task_derived: 4 },
    }),
    result = readTaskWipSnapshot({ rootDir, projection } as unknown as TaskQueryCell);

  assert.deepEqual(
    result.counted.map(({ taskId }) => taskId),
    ["task_leaf"],
  );
  assert.deepEqual(result.roots, [
    { taskId: "task_work", reason: "declared", directChildCount: 2, threshold: 3 },
    { taskId: "task_derived", reason: "derived", directChildCount: 4, threshold: 3 },
  ]);
  assert.equal(result.limit, 30);
  assert.equal(result.limitLabel, "settings.tasks.wipLimit");
});

test("the real WIP producer output passes the protocol validator, with or without roots", (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "task-wip-contract-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const wipOf = (taskRows: readonly unknown[]) =>
    readTaskWipSnapshot({
      rootDir,
      projection: projectionStub({ taskRows, childCounts: { task_leaf: 0, task_work: 2 } }),
    } as unknown as TaskQueryCell);

  // Contrast 1 — no root: a leaf-only worktable validates.
  const noRoots = wipOf([protocolTaskRow("task_leaf", [], { status: "submitted" })]);
  assert.deepEqual(noRoots.roots, []);
  assert.equal(noRoots.counted[0]?.status, "submitted");
  assert.deepEqual(parseDaemonGuiReadResult("repo.tasks.wip", noRoots), noRoots);

  // Contrast 2 — legit root: the producer's four-field root row validates through the same
  // parser the GUI client uses. This is the row the old exact-key-count check rejected.
  const withRoots = wipOf([
    protocolTaskRow("task_leaf", [], { status: "active" }),
    protocolTaskRow("task_work", [], { status: "blocked", taskClass: "work" }),
  ]);
  assert.deepEqual(withRoots.roots, [{ taskId: "task_work", reason: "declared", directChildCount: 2, threshold: 3 }]);
  assert.deepEqual(parseDaemonGuiReadResult("repo.tasks.wip", withRoots), withRoots);

  // Contrast 3 — forward-compat: self-describing extension fields pass at every level while the
  // declared fields keep their mapping; the client ignores what it does not know.
  const extended = {
    ...withRoots,
    schema: "task-wip/v2",
    counted: withRoots.counted.map((row) => ({ ...row, annotation: "newer-daemon" })),
    roots: [{ ...withRoots.roots[0]!, diagnostic: { deferred: 1 } }],
  };
  assert.deepEqual(parseDaemonGuiReadResult("repo.tasks.wip", extended), extended);

  // Contrast 4 — fail closed: a missing required field is still refused, extra keys or not.
  const { threshold: _threshold, ...missingField } = extended;
  assert.throws(() => parseDaemonGuiReadResult("repo.tasks.wip", missingField), /task WIP fields/u);
  const missingRowField = { ...withRoots, roots: [{ taskId: "task_work", reason: "declared" }] };
  assert.throws(() => parseDaemonGuiReadResult("repo.tasks.wip", missingRowField), /task WIP snapshot/u);
});

test("relation graph validator accepts the canonical cut and rejects invented fields", () => {
  const result = queryRead(process.cwd(), projectionStub()).relationGraphNeighborhood(neighborhoodQuery());
  assert.deepEqual(validateDaemonRelationGraph(result), []);
  assert.match(
    validateDaemonRelationGraph({ ...result, projection: { schema: "event-projection-cut/v1", ...readyCut } })[0]!,
    /entity=.*field=projection .*actual=/u,
  );
  const { sourceRevision: _sourceRevision, ...missingCut } = result;
  assert.match(validateDaemonRelationGraph(missingCut)[0]!, /entity=.*field=sourceRevision .*actual=/u);
});

function queryRead(rootDir: string, projection: TaskProjection) {
  return makeTaskQueryReadModel({
    rootDir: canonicalRoot(rootDir),
    projection,
    readPinnedEntities: () => [],
    judgments: {
      closeout: (() => ({ readiness: "missing", blocker: "execution", gates: [] })) as never,
      blocking: (() => []) as never,
    },
  });
}

function legacyRoot(t: TestContext): string {
  const rootDir = mkdtempSync(path.join(tmpdir(), "g3b-read-truth-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  seedRelationProjection(path.join(rootDir, ".harness/cache/projections.sqlite"));
  return rootDir;
}

function legacyRelationIds(rootDir: string): readonly string[] {
  const db = new DatabaseSync(path.join(rootDir, ".harness/cache/projections.sqlite"), { readOnly: true });
  try {
    return db
      .prepare("SELECT relation_id FROM relation_edges ORDER BY relation_id")
      .all()
      .map((row) => String(row.relation_id));
  } finally {
    db.close();
  }
}

function projectionCut(value: ProjectionCut): ProjectionCut {
  return { status: value.status, watermark: value.watermark, sourceRevision: value.sourceRevision };
}

function activeTaskRow(taskId: string) {
  return protocolTaskRow(taskId);
}

function reworkTaskRow(
  taskId: string,
  executions: readonly unknown[] = [executionRow("exe_returned", 0, "changes_requested", taskId)],
) {
  const row = protocolTaskRow(taskId, [], { status: "active" });
  return { ...row, snapshot: { ...row.snapshot, executions: [...executions] } };
}

/** 指定 task 状态 + 自带 executions 的行:submitted / in_review 页的待办分组用。 */
function statusTaskRow(taskId: string, status: "submitted" | "in_review", executions: readonly unknown[]) {
  const row = protocolTaskRow(taskId, [], { status });
  return { ...row, snapshot: { ...row.snapshot, executions: [...executions] } };
}

function leasedTaskRow(taskId: string) {
  const row = protocolTaskRow(taskId, [], { status: "active" });
  return {
    ...row,
    snapshot: {
      ...row.snapshot,
      lease: {
        schema: "lease/v1",
        taskId,
        executionId: "exe_leased",
        actor: { principal: { personId: "person-owner" }, executor: null },
        source: "local",
        phase: "held",
        expiresAt: "2026-08-30T03:00:00.000Z",
        ttlMs: 60000,
        version: 1,
      },
    },
  };
}

function taskRowWithoutDisposition() {
  return {
    taskId: "task_missing",
    packagePath: null,
    generation: "v1",
    workspaceRevision: 7,
    createdAt: null,
    completedAt: null,
    updatedAt: "2026-08-30T00:00:00.000Z",
    snapshot: {
      revision: 7,
      task: { title: "Missing", status: "active", taskClass: "standard" },
      executions: [],
      reviews: [],
      edgesTaken: [],
      lease: null,
      decisionRelations: [],
    },
  };
}

test("single-task completion read carries the canonical next and validates its read cut", () => {
  const snapshot = reduceTaskEvent(
      {
        revision: 0,
        task: null,
        executions: [],
        reviews: [],
        consents: [],
        gateWitnesses: [],
        edgesTaken: [],
        lease: null,
      },
      lifecycleFixture().events[0]!,
    ),
    taskId = snapshot.task!.taskId,
    reads: string[] = [],
    projection = {
      read: (id: string) => {
        reads.push(id);
        return { ...readyCut, snapshot, packagePath: "tasks/task-1" };
      },
      readPresetSnapshot: () => ({ snapshot: null, status: "ready" }),
      readTaskChildCounts: () => ({}),
      getEntity: () => null,
      readDocument: (documentPath: string) => ({
        ...readyCut,
        document: {
          body: documentPath.endsWith("task-contract.json")
            ? JSON.stringify({
                documents: [
                  {
                    slot: "task.closeout",
                    path: "closeout.md",
                    templateRef: "template://planning/closeout@1",
                    locale: "en-US",
                  },
                ],
              })
            : "",
        },
      }),
      readRelationQuery: () => ({ ...readyCut, rows: [] }),
    } as unknown as TaskProjection,
    result = readTaskCompletion(projection, taskId);
  const canonical = taskCompletionNext(snapshot, {
    closeout: "ready",
    closeoutPath: "tasks/task-1/closeout.md",
    eligibleDirtyPaths: [],
    projectionStatus: "ready",
  });
  assert.ok(reads.length > 0);
  assert.ok(
    reads.every((id) => id === taskId),
    "only the selected task is read",
  );
  assert.deepEqual(result.completionNext, canonical.next);
  // The structured blocker travels beside its guidance so readers judge the stage without parsing prose.
  assert.deepEqual(
    result.completionBlocker,
    canonical.blocker === null ? null : { code: canonical.blocker.code, gate: canonical.blocker.gate },
  );
  assert.equal(result.completionNext?.action, `ha task start ${taskId}`);
  assert.deepEqual(parseDaemonGuiReadResult("repo.tasks.completion.read", result), result);
  assert.throws(
    () =>
      parseDaemonGuiReadResult("repo.tasks.completion.read", {
        ...result,
        completionNext: { ...result.completionNext, readCut: { revision: "wrong" } },
      }),
    /completionNext/,
  );
  assert.throws(
    () =>
      parseDaemonGuiReadResult("repo.tasks.completion.read", {
        ...result,
        completionBlocker: { code: "review_pending" },
      }),
    /completionBlocker/,
  );
  assert.throws(
    () => parseDaemonGuiReadResult("repo.tasks.completion.read", { ...result, completionNext: null }),
    /completionBlocker/,
  );
  assert.throws(() => parseDaemonGuiReadResult("repo.tasks.completion.read", { ok: true, taskId }));
  assert.deepEqual(
    parseDaemonGuiReadResult("repo.tasks.completion.read", {
      ok: true,
      taskId,
      completionNext: null,
      completionBlocker: null,
      factRetirement: null,
    }),
    { ok: true, taskId, completionNext: null, completionBlocker: null, factRetirement: null },
  );
  // factRetirement is additive: absent on older producers it parses through, present it is
  // validated shape-by-shape.
  const legacy = { ok: true, taskId, completionNext: null, completionBlocker: null };
  assert.deepEqual(parseDaemonGuiReadResult("repo.tasks.completion.read", legacy), legacy);
  assert.throws(
    () =>
      parseDaemonGuiReadResult("repo.tasks.completion.read", {
        ...legacy,
        factRetirement: { undischarged: [{ factRef: 1 }] },
      }),
    /factRetirement/,
  );
});

test("a ready submitted low-risk cut exposes ha task complete instead of a null next", () => {
  const submitted = lifecycleFixture({
      closeoutGates: { review: false, consent: false, factDisposition: false },
    })
      .events.slice(0, 3)
      .reduce(reduceTaskEvent, emptyTaskLifecycleSnapshot()),
    // A task-package-only cut has no repository commit, so completion does not wait for a merge.
    snapshot = {
      ...submitted,
      executions: submitted.executions.map((execution) =>
        execution.submission ? { ...execution, submission: { ...execution.submission, commitSha: null } } : execution,
      ),
    },
    taskId = snapshot.task!.taskId,
    projection = {
      read: () => ({ ...readyCut, snapshot, packagePath: "tasks/task-1" }),
      readPresetSnapshot: () => ({ snapshot: null, status: "ready" }),
      readTaskChildCounts: () => ({}),
      getEntity: () => null,
      readDocument: (documentPath: string) => ({
        ...readyCut,
        document: {
          body: documentPath.endsWith("task-contract.json")
            ? JSON.stringify({
                documents: [
                  {
                    slot: "task.closeout",
                    path: "closeout.md",
                    templateRef: "template://planning/closeout@1",
                    locale: "en-US",
                  },
                ],
              })
            : "",
        },
      }),
      readRelationQuery: () => ({ ...readyCut, rows: [] }),
    } as unknown as TaskProjection,
    result = readTaskCompletion(projection, taskId);
  assert.equal(result.completionBlocker, null);
  assert.equal(result.completionNext?.action, `ha task complete ${taskId}`);
  assert.match(result.completionNext?.reason ?? "", /lifted independent review and consent/u);
  // The read names the same step a reader can execute; it no longer reads as blocker-free but empty.
  assert.deepEqual(parseDaemonGuiReadResult("repo.tasks.completion.read", result), result);
});

test("agenda marks a second escalation on one task as a shape signal until a newer premise review", () => {
  const taskId = "task_shape_signal",
    packagePath = `tasks/${taskId}`,
    ruling = (suffix: string, createdAt: string) => ({
      path: `${packagePath}/artifacts/rulings/dispatch_${suffix}.md`,
      body: JSON.stringify({
        schema: "worker-escalation/v1",
        status: "awaiting",
        dispatchId: `dispatch_${suffix}`,
        question: `Does collection ${suffix} also get a migration-window exception?`,
        options: ["Extend the exception", "Build the index before switching readers"],
        createdAt,
      }),
    }),
    premiseFact = (statement: string, occurredAt: string) => ({
      ref: "fact/F-PREMISE1",
      taskId,
      factId: "F-PREMISE1",
      statement,
      evidenceSource: "review:premise",
      observedAt: occurredAt,
      occurredAt,
      state: "standing",
      archived: false,
      invalidated: false,
    }),
    agendaFor = (rulings: readonly { path: string; body: string }[], facts: readonly unknown[]) => {
      const row = protocolTaskRow(taskId, [], { status: "active" }),
        base = projectionStub({ taskRows: [{ ...row, packagePath }] }),
        projection = {
          ...base,
          readDocuments: (prefix: string) => ({
            documents: rulings.filter(({ path: candidate }) => candidate.startsWith(prefix)),
          }),
          readDocument: (documentPath: string) => {
            const found = rulings.find(({ path: candidate }) => candidate === documentPath);
            return found ? { ...readyCut, document: { body: found.body } } : base.readDocument(documentPath);
          },
          readRuntimeDispatchById: () => null,
          readRuntimeDispatchesByTaskExecution: () => [],
          readRuntimeDispatchByResumeSource: () => null,
          readRuntimeDispatchesByAttemptGroup: () => [],
          searchFacts: (filters: { taskId?: string }) => ({
            ...readyCut,
            facts: filters.taskId === taskId ? facts : [],
          }),
        } as unknown as TaskProjection;
      return makeTaskQueryReadModel({
        rootDir: canonicalRoot(process.cwd()),
        projection,
        readPinnedEntities: () => [],
        judgments: {
          closeout: (() => ({ readiness: "missing", blocker: "execution", gates: [] })) as never,
          blocking: ((tasks: readonly { taskId: string }[]) =>
            tasks.map(({ taskId }) => ({
              taskId,
              state: "clear",
              label: "none",
              blockers: [],
              warnings: [],
            }))) as never,
        },
      }).agenda();
    },
    signalOf = (result: ReturnType<typeof agendaFor>) =>
      result.attentionItems.find(({ ref, title }) => ref === `task/${taskId}` && title.includes("形状信号"));
  const first = ruling("a00000000000000000000001", "2026-11-05T10:56:59.001Z"),
    second = ruling("a00000000000000000000002", "2026-11-05T12:56:33.279Z");

  const single = agendaFor([first], []);
  assert.equal(signalOf(single), undefined, "one escalation is not a shape yet");

  const repeated = agendaFor([first, second], []);
  assert.equal(signalOf(repeated)?.kind, "needs-handling", JSON.stringify(repeated.attentionItems));
  assert.match(repeated.summary, /形状信号 \(1\)/u);
  assert.match(repeated.summary, /2 次 escalation/u);
  assert.match(repeated.summary, /ha fact record --task task_shape_signal --source review:premise/u);
  assert.deepEqual(validateDaemonAgenda(repeated), []);

  // A premise review that predates the latest escalation did not see it.
  const stale = agendaFor(
    [first, second],
    [premiseFact("restart: yes alternative: none sunk-cost: no conclusion: continue", "2026-11-05T11:00:00.000Z")],
  );
  assert.ok(signalOf(stale), "a review before the second escalation does not clear it");

  const unanswered = agendaFor([first, second], [premiseFact("conclusion: continue", "2026-11-05T13:00:00.000Z")]);
  assert.ok(signalOf(unanswered), "a review that skips the three questions does not clear it");

  const reviewed = agendaFor(
    [first, second],
    [
      premiseFact(
        "restart: no, measure the attach pause first. alternative: schedule upgrades off-peak. " +
          "sunk-cost: twenty rounds, which is not a reason. conclusion: narrow",
        "2026-11-05T13:00:00.000Z",
      ),
    ],
  );
  assert.equal(signalOf(reviewed), undefined, JSON.stringify(reviewed.attentionItems));
  assert.match(reviewed.summary, /形状信号 \(0\)/u);
});
