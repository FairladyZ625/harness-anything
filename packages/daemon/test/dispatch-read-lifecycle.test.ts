// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import type {
  AgentRuntimeEventV1,
  DispatchLifecycleRead,
  RuntimeSession,
  TaskEventV1,
  TaskProjection,
  TaskProjectionQueries,
} from "@harness-anything/kernel";
import { makeAgentRuntimeReadModel } from "../src/daemon-host/agent-runtime-read.ts";
import { readTaskDispatchRow, taskDispatchRowsSettled } from "../src/daemon-host/dispatch-read.ts";
import { dispatchLifecycleReadOf, lifecycleEvent } from "./dispatch-lifecycle-read.fixtures.ts";

function fixture(fallback?: "scheduled" | "exhausted") {
  const options = { instanceId: "worker", source: "local" as const, dispatchId: "dispatch-test" },
    admission = lifecycleEvent("R", "runtime-test", options),
    events = [admission, lifecycleEvent("S", "runtime-test", options)];
  if (fallback) {
    const outcome = lifecycleEvent("O", "runtime-test", options);
    events.push({
      ...outcome,
      payload: {
        ...outcome.payload,
        outcome: "failed",
        attempt: {
          classification: "provider_fault",
          fallbackState: fallback,
        },
      },
    } as AgentRuntimeEventV1);
  }
  let read = dispatchLifecycleReadOf(() => events)({ by: "dispatch", dispatchIds: [options.dispatchId] });
  const projection = {
    readCut: () => ({ status: "ready", watermark: 10, sourceRevision: 10 }),
    readDispatchLifecycle: () => read,
    readTaskIndex: () => ({ rows: [] }),
    readRuntimeSession: () => ({ liveness: "live", outcome: null, lastObservedAt: "2026-11-08T00:00:00.000Z" }),
    readRuntimeSessionEventsByType: () => [],
    readRuntimeDispatchByResumeSource: () => null,
    readRuntimeDispatchesByAttemptGroup: () => {
      throw new Error("single dispatch must not scan group history");
    },
    readDocument: () => ({ document: null }),
  } as unknown as TaskProjectionQueries;
  return {
    row: () =>
      readTaskDispatchRow(
        projection,
        admission as Extract<AgentRuntimeEventV1, { type: "runtime_dispatch_requested" }>,
      ),
    stale: () => {
      read = { status: "pending", watermark: 1, sourceRevision: 10 } satisfies DispatchLifecycleRead;
    },
  };
}

test("waiting fallback stays unsettled despite a closed attempt and stale live session", () => {
  const row = fixture("scheduled").row();
  assert.equal(row.lifecycle?.groupPhase, "waiting_backoff");
  assert.equal(row.lifecycle?.policy?.groupSettled, false);
  assert.equal(taskDispatchRowsSettled([row]), false);
  assert.notEqual(row.status, "running");
});

test("exhausted fallback is terminal without local stream evidence", () => {
  const row = fixture("exhausted").row();
  assert.equal(row.lifecycle?.policy?.groupSettled, true);
  assert.equal(taskDispatchRowsSettled([row]), true);
  assert.equal(row.status, "failed");
});

test("a stale lifecycle watermark is pending and never advertised live", () => {
  const f = fixture();
  f.stale();
  const row = f.row();
  assert.equal(row.lifecycle?.status, "pending");
  assert.notEqual(row.status, "running");
  assert.equal(taskDispatchRowsSettled([row]), false);
});

test("consent waits for the provider process even after accepted review delivery", async () => {
  const { reduceDispatchLifecycle, dispatchLifecycleView } = await import("@harness-anything/kernel"),
    digest = `sha256:${"a".repeat(64)}` as const,
    options = {
      source: "local" as const,
      instanceId: "worker",
      dispatchId: "review-dispatch",
      taskId: "task-review",
      executionId: "execution-review",
      role: "reviewer" as const,
    },
    raw = lifecycleEvent("R", "review-session", options),
    admission = {
      ...raw,
      payload: {
        ...raw.payload,
        reviewTarget: { kind: "task", taskId: options.taskId, executionId: options.executionId, digest },
      },
    } as Extract<AgentRuntimeEventV1, { type: "runtime_dispatch_requested" }>;
  const admitted = reduceDispatchLifecycle(null, admission);
  assert.equal(admitted.kind, "applied");
  if (admitted.kind !== "applied") throw new Error("review admission refused");
  const started = reduceDispatchLifecycle(admitted.group, lifecycleEvent("S", "review-session", options));
  assert.equal(started.kind, "applied");
  if (started.kind !== "applied") throw new Error("review launch refused");
  const registered = reduceDispatchLifecycle(started.group, {
    schema: "task-event/v1",
    type: "review_recorded",
    workspaceRevision: started.group.revision + 1,
    payload: { review: { executionId: options.executionId, submissionDigest: digest, reviewId: "review-test" } },
  } as import("@harness-anything/kernel/internal/domain/dispatch-lifecycle.ts").DispatchLifecycleInput);
  assert.equal(registered.kind, "applied");
  if (registered.kind !== "applied") throw new Error("review registration refused");
  const view = dispatchLifecycleView(registered.group),
    projection = {
      readRuntimeDispatchesByTaskExecution: () => [{ event: admission }],
      readRuntimeSession: () => null,
      readDispatchLifecycle: () => ({
        status: "ready",
        watermark: view.revision,
        sourceRevision: view.revision,
        rows: [view],
        nextCursor: null,
      }),
    } as unknown as TaskProjectionQueries;
  const { unsettledCutReviewDispatches } = await import("../src/daemon-host/dispatch-read.ts");
  assert.equal(view.policy.groupSettled, false);
  assert.equal(view.policy.capacityDisposition, "busy");
  assert.equal(
    unsettledCutReviewDispatches({
      projection,
      taskId: options.taskId,
      executionId: options.executionId,
      submissionDigest: digest,
    }).length,
    1,
  );
});

test("both attach entry points share the central interactive policy and fail closed for pending/fence", async () => {
  const { readRuntimeCanAttach } = await import("../src/daemon-host/agent-runtime-read.ts"),
    { reduceDispatchLifecycle, dispatchLifecycleView } = await import("@harness-anything/kernel");
  const options = { instanceId: "worker", source: "local" as const, dispatchId: "dispatch-attach" },
    admitted = reduceDispatchLifecycle(null, lifecycleEvent("R", "runtime-attach", options));
  assert.ok(admitted.kind === "applied");
  const started = reduceDispatchLifecycle(admitted.group, lifecycleEvent("S", "runtime-attach", options));
  assert.ok(started.kind === "applied");
  const group = started.group,
    attempt = group.attempts[0]!;
  for (const [name, candidate, expected] of [
    ["running", group, true],
    ["settling", { ...group, attempts: [{ ...attempt, phase: "settling" as const }] }, false],
    ["owner unverified", { ...group, attempts: [{ ...attempt, fence: { ...attempt.fence, verified: false } }] }, false],
    ["pending", null, false],
  ] as const) {
    const read = candidate
      ? { status: "ready", watermark: 1, sourceRevision: 1, nextCursor: null, rows: [dispatchLifecycleView(candidate)] }
      : { status: "pending", watermark: 1, sourceRevision: 2 };
    const projection = {
      readDispatchLifecycle: () => read,
      readRuntimeInstallation: () => ({ effectiveCapabilities: ["attach"] }),
    } as unknown as TaskProjectionQueries;
    assert.equal(
      readRuntimeCanAttach(projection, { runtimeSessionId: "runtime-attach", installationId: "install" } as never),
      expected,
      name,
    );
  }
});

test("runtime overview and unsettled session groups drop historical stopped groups once tasks finish or cancel", () => {
  let rev = 0;
  const stamp = <T extends Record<string, unknown>>(event: T): T => {
      rev += 1;
      return { ...event, eventId: `consumer-ev-${rev}`, workspaceRevision: rev, opId: `consumer-op-${rev}` };
    },
    events: (AgentRuntimeEventV1 | TaskEventV1)[] = [];
  const pushRuntime = (
    kind: Parameters<typeof lifecycleEvent>[0],
    sessionId: string,
    opts: Parameters<typeof lifecycleEvent>[2],
    overridePayload?: Record<string, unknown>,
  ) => {
    const base = lifecycleEvent(kind, sessionId, opts);
    events.push(
      stamp({
        ...base,
        occurredAt: "2026-11-08T00:00:00.000Z",
        payload: { ...base.payload, ...(overridePayload ?? {}) },
      }),
    );
  };
  const pushTask = (taskId: string, type: TaskEventV1["type"], payload: Record<string, unknown>) => {
    events.push(
      stamp({
        schema: "task-event/v1",
        type,
        taskId,
        actor: { principal: { personId: "owner" }, executor: null },
        source: "local",
        occurredAt: "2026-11-08T00:00:00.000Z",
        payload: { documentClaims: [], ...payload },
      }) as unknown as TaskEventV1,
    );
  };
  const baseTask = (taskId: string, status: string) => ({ taskId, title: `Task ${taskId}`, status });
  const pushExecutionStarted = (taskId: string, executionId: string) =>
    pushTask(taskId, "execution_started", {
      task: baseTask(taskId, "active"),
      execution: { executionId, taskId, state: "active" },
      lease: { executionId, version: 0 },
    });

  // 1. task-done: waiting_backoff -> closed on task_completed.
  pushExecutionStarted("task-done", "exec-done");
  pushRuntime("R", "s-done", {
    instanceId: "worker",
    source: "local",
    dispatchId: "d-done",
    taskId: "task-done",
    executionId: "exec-done",
  });
  pushRuntime("S", "s-done", { instanceId: "worker", source: "local", dispatchId: "d-done" });
  pushRuntime("X", "s-done", { instanceId: "worker", source: "local", dispatchId: "d-done" });
  pushRuntime(
    "O",
    "s-done",
    { instanceId: "worker", source: "local", dispatchId: "d-done" },
    { outcome: "failed", attempt: { classification: "provider_quota", fallbackState: "scheduled" } },
  );

  // 2. task-cancel: awaiting_ruling (after lease_released) -> closed on task_transitioned("cancelled").
  pushExecutionStarted("task-cancel", "exec-cancel");
  pushRuntime("R", "s-cancel", {
    instanceId: "worker",
    source: "local",
    dispatchId: "d-cancel",
    taskId: "task-cancel",
    executionId: "exec-cancel",
  });
  pushRuntime("S", "s-cancel", { instanceId: "worker", source: "local", dispatchId: "d-cancel" });
  pushRuntime("X", "s-cancel", { instanceId: "worker", source: "local", dispatchId: "d-cancel" });
  pushRuntime(
    "O",
    "s-cancel",
    { instanceId: "worker", source: "local", dispatchId: "d-cancel" },
    { outcome: "failed", attempt: { classification: "awaiting_ruling" } },
  );
  pushTask("task-cancel", "lease_released", {
    task: baseTask("task-cancel", "active"),
    execution: { executionId: "exec-cancel", taskId: "task-cancel" },
    releasedLease: { executionId: "exec-cancel", version: 0 },
  });

  // 3. task-nonterm: waiting_backoff remains open on non-terminal task_transitioned("blocked").
  pushExecutionStarted("task-nonterm", "exec-nonterm");
  pushRuntime("R", "s-nonterm", {
    instanceId: "worker",
    source: "local",
    dispatchId: "d-nonterm",
    taskId: "task-nonterm",
    executionId: "exec-nonterm",
  });
  pushRuntime("S", "s-nonterm", { instanceId: "worker", source: "local", dispatchId: "d-nonterm" });
  pushRuntime("X", "s-nonterm", { instanceId: "worker", source: "local", dispatchId: "d-nonterm" });
  pushRuntime(
    "O",
    "s-nonterm",
    { instanceId: "worker", source: "local", dispatchId: "d-nonterm" },
    { outcome: "failed", attempt: { classification: "provider_fault", fallbackState: "scheduled" } },
  );

  // 4. task-live: genuinely running group must stay in overview & unsettledOnly even if task transitions.
  pushExecutionStarted("task-live", "exec-live");
  pushRuntime("R", "s-live", {
    instanceId: "worker",
    source: "local",
    dispatchId: "d-live",
    taskId: "task-live",
    executionId: "exec-live",
  });
  pushRuntime("S", "s-live", { instanceId: "worker", source: "local", dispatchId: "d-live" });

  const taskStatuses = new Map<string, string>([
    ["task-done", "active"],
    ["task-cancel", "active"],
    ["task-nonterm", "active"],
    ["task-live", "active"],
  ]);
  const dispatchesBySession = new Map<string, Extract<AgentRuntimeEventV1, { type: "runtime_dispatch_requested" }>>();
  for (const event of events)
    if (event.schema === "agent-runtime-event/v1" && event.type === "runtime_dispatch_requested")
      dispatchesBySession.set(event.payload.runtimeSessionId, event);

  const sessions = (): RuntimeSession[] =>
    [
      { id: "s-done", taskId: "task-done", exeId: "exec-done", liveness: "exited", outcome: "failed" },
      { id: "s-cancel", taskId: "task-cancel", exeId: "exec-cancel", liveness: "exited", outcome: "failed" },
      { id: "s-nonterm", taskId: "task-nonterm", exeId: "exec-nonterm", liveness: "exited", outcome: "failed" },
      { id: "s-live", taskId: "task-live", exeId: "exec-live", liveness: "live", outcome: null },
    ].map((entry) => ({
      runtimeSessionId: entry.id,
      instanceId: "worker",
      installationId: "install-codex",
      kindId: "codex",
      definitionSnapshotRef: "artifact:def",
      providerSessionId: null,
      transcriptRef: null,
      launchGeneration: 1,
      liveness: entry.liveness as RuntimeSession["liveness"],
      attachable: false,
      taskBindings: [
        {
          taskId: entry.taskId,
          executionId: entry.exeId,
          providerSessionId: null,
          transcriptRef: null,
          boundAt: "2026-11-08T00:00:00.000Z",
        },
      ],
      outcome: entry.outcome as RuntimeSession["outcome"],
      exitCode: entry.outcome === null ? null : 1,
      resultRef: null,
      lastObservedAt: "2026-11-08T00:00:00.000Z",
    }));

  const readLifecycle = dispatchLifecycleReadOf(() => events);
  const projection = {
    readCut: () => ({ status: "ready", watermark: rev, sourceRevision: rev }),
    readDispatchLifecycle: readLifecycle,
    readRuntimeInstallations: () => [],
    readRuntimeInstallation: () => null,
    readRuntimeSessions: sessions,
    readRuntimeSession: (id: string) => sessions().find((s) => s.runtimeSessionId === id) ?? null,
    currentLease: () => null,
    readRuntimeDispatch: (id: string) => dispatchesBySession.get(id) ?? null,
    readLatestRuntimeDispatchBySession: (id: string) => dispatchesBySession.get(id) ?? null,
    readRuntimeDispatchEventsBySession: (id: string) =>
      dispatchesBySession.has(id) ? [dispatchesBySession.get(id)!] : [],
    readRuntimeSessionEventsByType: () => [],
    readTaskStatuses: ({ taskIds }: { readonly taskIds: readonly string[] }) => ({
      status: "ready",
      watermark: rev,
      sourceRevision: rev,
      rows: taskIds.map((taskId) => ({ taskId, status: taskStatuses.get(taskId) ?? "active" })),
    }),
    readTaskRuntimeBatch: ({ taskIds }: { readonly taskIds: readonly string[] }) => ({
      rows: taskIds.map((taskId) => ({
        taskId,
        title: `Task ${taskId}`,
        packagePath: null,
        sessions: sessions().filter((s) => s.taskBindings.some((b) => b.taskId === taskId)),
      })),
    }),
    read: (taskId: string) => ({ snapshot: { task: { title: `Task ${taskId}` } } }),
    listEntities: () => [],
  } as unknown as TaskProjection;
  const reads = makeAgentRuntimeReadModel({
    projection,
    store: { read: () => ({ revision: rev }), readContentBlob: () => null } as never,
  });

  // Before terminal task events, all four active groups are present.
  assert.deepEqual(
    reads
      .overview({})
      .sessions.map(({ runtimeSessionId }) => runtimeSessionId)
      .sort(),
    ["s-cancel", "s-done", "s-live", "s-nonterm"],
  );
  assert.deepEqual(
    reads
      .sessionGroups({ groupBy: "task", unsettledOnly: true })
      .groups.map(({ key }) => key)
      .sort(),
    ["task-cancel", "task-done", "task-live", "task-nonterm"],
  );

  // Now finish task-done, cancel task-cancel, block task-nonterm, and force-cancel task-live while running.
  pushTask("task-done", "task_completed", { task: baseTask("task-done", "done") });
  taskStatuses.set("task-done", "done");
  pushTask("task-cancel", "task_transitioned", {
    task: baseTask("task-cancel", "cancelled"),
    mutation: { command: "transition", reason: "cancelled", fields: ["status"] },
  });
  taskStatuses.set("task-cancel", "cancelled");
  pushTask("task-nonterm", "task_transitioned", {
    task: baseTask("task-nonterm", "blocked"),
    mutation: { command: "transition", reason: "blocked", fields: ["status"] },
  });
  taskStatuses.set("task-nonterm", "blocked");
  pushTask("task-live", "task_transitioned", {
    task: baseTask("task-live", "cancelled"),
    mutation: { command: "transition", reason: "cancelled", fields: ["status"] },
  });
  taskStatuses.set("task-live", "cancelled");

  assert.deepEqual(
    reads
      .overview({})
      .sessions.map(({ runtimeSessionId }) => runtimeSessionId)
      .sort(),
    ["s-live", "s-nonterm"],
  );
  assert.deepEqual(
    reads
      .sessionGroups({ groupBy: "task", unsettledOnly: true })
      .groups.map(({ key }) => key)
      .sort(),
    ["task-live", "task-nonterm"],
  );
});
