// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import type { AgentRuntimeEventV1, DispatchLifecycleRead, TaskProjectionQueries } from "@harness-anything/kernel";
import { readTaskDispatchRow, taskDispatchRowsSettled } from "../src/dispatch-read.ts";
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
  const { unsettledCutReviewDispatches } = await import("../src/dispatch-read.ts");
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
  const { readRuntimeCanAttach } = await import("../src/agent-runtime-read.ts"),
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
