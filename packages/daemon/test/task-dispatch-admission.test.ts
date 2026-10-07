// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import type { TaskProjection } from "@harness-anything/kernel";
import { stackOn, stackSnapshot } from "./stacked-dispatch.fixtures.ts";
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
    read: (id: string) => ({
      status: "ready",
      watermark: 1,
      sourceRevision: 1,
      snapshot: stackSnapshot(id, id === "task_base" ? dependencyStatus : "active"),
    }),
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

test("an explicit stacked baseline admits a consented current upstream delivery", () => {
  const upstream = stackSnapshot("task_base"),
    downstream = stackOn(stackSnapshot("task_work", "active"), upstream);
  const read = projection("accepted", "in_review");
  const stacked = {
    ...read,
    read: (id: string) => ({
      status: "ready",
      watermark: 1,
      sourceRevision: 1,
      snapshot: id === "task_base" ? upstream : downstream,
    }),
  } as unknown as TaskProjection;
  assert.doesNotThrow(() => assertTaskDispatchPrerequisites(stacked, "task_work"));
});

for (const scenario of [
  "no review",
  "no consent",
  "old iteration",
  "old submission",
  "old review digest",
  "changes requested",
  "not stacked",
  "different anchor",
  "different execution",
  "cut mismatch",
] as const) {
  test(`stacked dispatch refuses ${scenario}`, () => {
    let upstream = stackSnapshot("task_base");
    let downstream = stackOn(stackSnapshot("task_work", "active"), upstream);
    if (scenario === "no review") upstream = { ...upstream, reviews: [] };
    if (scenario === "no consent") upstream = { ...upstream, consents: [] };
    if (scenario === "old iteration") upstream = { ...upstream, task: { ...upstream.task!, iteration: 1 } };
    if (scenario === "old submission")
      upstream = {
        ...upstream,
        reviews: upstream.reviews.map((review) => ({ ...review, submissionDigest: `sha256:${"c".repeat(64)}` })),
      };
    if (scenario === "old review digest")
      upstream = {
        ...upstream,
        consents: upstream.consents.map((consent) => ({ ...consent, reviewDigest: `sha256:${"c".repeat(64)}` })),
      };
    if (scenario === "changes requested")
      upstream = {
        ...upstream,
        reviews: [...upstream.reviews, { ...upstream.reviews[0]!, reviewId: "request", verdict: "changes_requested" }],
      };
    if (scenario === "not stacked") downstream = stackSnapshot("task_work", "active");
    if (scenario === "different anchor" || scenario === "different execution") {
      downstream = {
        ...downstream,
        executions: downstream.executions.map((execution) => ({
          ...execution,
          deliveryBaseline: {
            kind: "commit",
            commitSha: scenario === "different anchor" ? "c".repeat(40) : "a".repeat(40),
            stackOn: {
              taskId: "task_base",
              executionId: scenario === "different execution" ? "old-execution" : "exe-task_base",
            },
          },
        })),
      };
    }
    const read = projection("accepted", "in_review");
    assert.throws(
      () =>
        assertTaskDispatchPrerequisites(
          {
            ...read,
            read: (id: string) => ({
              status: "ready",
              watermark: scenario === "cut mismatch" ? 2 : 1,
              sourceRevision: 1,
              snapshot: id === "task_base" ? upstream : downstream,
            }),
          } as unknown as TaskProjection,
          "task_work",
        ),
      /unresolved dispatch prerequisites/u,
    );
  });
}

test("a stacked dependency does not hide an unfinished transitive dependency", () => {
  const upstream = stackSnapshot("task_base"),
    downstream = stackOn(stackSnapshot("task_work", "active"), upstream),
    read = projection("accepted", "in_review"),
    closure = read.readTaskDependencyClosure(["task/task_work"]);
  assert.throws(
    () =>
      assertTaskDispatchPrerequisites(
        {
          ...read,
          readTaskDependencyClosure: () => ({
            ...closure,
            rows: [...closure.rows, edge("task/task_base", "task/task_deeper", "depends-on")],
          }),
          readTaskStatuses: () => ({
            ...read.readTaskStatuses(),
            rows: [...read.readTaskStatuses().rows, { taskId: "task_deeper", status: "active" }],
          }),
          read: (id: string) => ({
            status: "ready",
            watermark: 1,
            sourceRevision: 1,
            snapshot: id === "task_base" ? upstream : id === "task_work" ? downstream : stackSnapshot(id, "active"),
          }),
        } as unknown as TaskProjection,
        "task_work",
      ),
    /task_deeper \(active\)/u,
  );
});

test("ordinary done dependencies retain their completion semantics", () => {
  const read = projection("accepted", "done"),
    closure = read.readTaskDependencyClosure(["task/task_work"]);
  assert.doesNotThrow(() =>
    assertTaskDispatchPrerequisites(
      {
        ...read,
        readTaskDependencyClosure: () => ({
          ...closure,
          rows: [...closure.rows, edge("task/task_base", "task/task_deeper", "depends-on")],
        }),
        readTaskStatuses: () => ({
          ...read.readTaskStatuses(),
          rows: [...read.readTaskStatuses().rows, { taskId: "task_deeper", status: "active" }],
        }),
      } as unknown as TaskProjection,
      "task_work",
    ),
  );
});

for (const scenario of ["suspect", "cycle"] as const) {
  test(`approved stack does not clear a ${scenario} relation`, () => {
    const upstream = stackSnapshot("task_base"),
      downstream = stackOn(stackSnapshot("task_work", "active"), upstream),
      read = projection("accepted", "in_review", scenario === "suspect" ? "suspect" : "current", {
        dependencyCycle: scenario === "cycle",
      });
    assert.throws(
      () =>
        assertTaskDispatchPrerequisites(
          {
            ...read,
            read: (id: string) => ({
              status: "ready",
              watermark: 1,
              sourceRevision: 1,
              snapshot: id === "task_base" ? upstream : downstream,
            }),
          } as unknown as TaskProjection,
          "task_work",
        ),
      new RegExp(scenario, "u"),
    );
  });
}

test("a done explicit stack still requires its pinned approved cut and active relation", () => {
  const upstream = stackSnapshot("task_base", "done"),
    downstream = stackOn(stackSnapshot("task_work", "active"), upstream),
    read = projection("accepted", "done"),
    withTarget = (target: typeof upstream) =>
      ({
        ...read,
        read: (id: string) => ({
          status: "ready",
          watermark: 1,
          sourceRevision: 1,
          snapshot: id === "task_base" ? target : downstream,
        }),
      }) as unknown as TaskProjection;
  assert.doesNotThrow(() => assertTaskDispatchPrerequisites(withTarget(upstream), "task_work"));
  assert.throws(
    () => assertTaskDispatchPrerequisites(withTarget({ ...upstream, reviews: [] }), "task_work"),
    /stacked dependency/u,
  );
  assert.throws(
    () =>
      assertTaskDispatchPrerequisites(
        {
          ...withTarget(upstream),
          readTaskDependencyClosure: () => ({ status: "ready", watermark: 1, sourceRevision: 1, rows: [] }),
        } as unknown as TaskProjection,
        "task_work",
      ),
    /stacked dependency/u,
  );
});
