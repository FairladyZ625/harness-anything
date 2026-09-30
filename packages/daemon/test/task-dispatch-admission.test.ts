// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import type { TaskProjection } from "@harness-anything/kernel";
import { assertTaskDispatchPrerequisites } from "../src/task-dispatch-admission.ts";

const edge = (sourceRef: string, targetRef: string, relationType: "derives" | "depends-on") => ({
  relationId: `rel-${relationType}`,
  workspaceRevision: 1,
  sourceRef,
  targetRef,
  relationType,
  direction: "directed" as const,
  strength: "strong" as const,
  origin: "declared" as const,
  state: "active" as const,
  targetObservedVersion: null,
  currentTargetVersion: null,
  freshness: "current" as const,
  rationale: "fixture",
  ownerRef: sourceRef,
  sourcePath: "fixture",
  recordIndex: 0,
});

function projection(
  decisionState: string,
  dependencyStatus: string,
  dependencyFreshness: "current" | "suspect" = "current",
  options: {
    readonly decisionMissing?: boolean;
    readonly dependencyCycle?: boolean;
    readonly derivesFreshness?: "current" | "suspect";
    readonly pending?: boolean;
  } = {},
): TaskProjection {
  const dependencyRows = [
    { ...edge("task/task_work", "task/task_base", "depends-on"), freshness: dependencyFreshness },
    ...(options.dependencyCycle ? [edge("task/task_base", "task/task_work", "depends-on")] : []),
  ];
  return {
    readTaskRelationsByTargets: () => ({
      status: "ready",
      rows: [
        {
          ...edge("decision/dec_gate/CH1", "task/task_work", "derives"),
          freshness: options.derivesFreshness ?? "current",
        },
      ],
      watermark: 1,
      sourceRevision: 1,
    }),
    readTaskDependencyClosure: () => ({
      status: options.pending ? "pending" : "ready",
      rows: dependencyRows,
      watermark: 1,
      sourceRevision: 1,
    }),
    readDecisions: () => ({
      status: "ready",
      decisions: options.decisionMissing ? [] : [{ decisionId: "dec_gate", state: decisionState }],
      watermark: 1,
      sourceRevision: 1,
    }),
    readTaskStatuses: () => ({
      status: "ready",
      rows: [
        { taskId: "task_work", status: "active" },
        { taskId: "task_base", status: dependencyStatus },
      ],
      watermark: 1,
      sourceRevision: 1,
    }),
  } as unknown as TaskProjection;
}

test("task dispatch reports proposed decisions and unfinished dependencies", () => {
  assert.throws(
    () => assertTaskDispatchPrerequisites(projection("proposed", "active"), "task_work"),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "task_dispatch_prerequisite_unmet" &&
      /ha decision accept dec_gate; task_base \(active\)/u.test(error.message),
  );
});

test("task dispatch remains admissible after both prerequisites resolve", () => {
  assert.doesNotThrow(() => assertTaskDispatchPrerequisites(projection("accepted", "done"), "task_work"));
});

test("task dispatch refuses a suspect strong dependency instead of treating done as resolved", () => {
  assert.throws(
    () => assertTaskDispatchPrerequisites(projection("accepted", "done", "suspect"), "task_work"),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "task_dispatch_prerequisite_unmet" &&
      /suspect/u.test(error.message),
  );
});

test("task dispatch refuses dependency cycles even when every task is done", () => {
  assert.throws(
    () =>
      assertTaskDispatchPrerequisites(
        projection("accepted", "done", "current", { dependencyCycle: true }),
        "task_work",
      ),
    /cycle/u,
  );
});

test("task dispatch refuses missing decisions and a pending projection cut", () => {
  assert.throws(
    () =>
      assertTaskDispatchPrerequisites(
        projection("accepted", "done", "current", { decisionMissing: true }),
        "task_work",
      ),
    /deriving decision dec_gate is missing/u,
  );
  assert.throws(
    () => assertTaskDispatchPrerequisites(projection("accepted", "done", "current", { pending: true }), "task_work"),
    /projection cut unavailable/u,
  );
});

test("accepted stale derives is resolved while proposed stale derives keeps its accept guidance", () => {
  assert.doesNotThrow(() =>
    assertTaskDispatchPrerequisites(
      projection("accepted", "done", "current", { derivesFreshness: "suspect" }),
      "task_work",
    ),
  );
  assert.throws(
    () =>
      assertTaskDispatchPrerequisites(
        projection("proposed", "done", "current", { derivesFreshness: "suspect" }),
        "task_work",
      ),
    /ha decision accept dec_gate; derives relation rel-derives is suspect/u,
  );
});
