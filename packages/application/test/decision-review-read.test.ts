// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import type { DecisionProjectionRow, DispatchLifecycleView, TaskProjection } from "@harness-anything/kernel";
import { decisionFullListRows } from "../src/queries/decision-review-read.ts";

test("full decision lists use at most two projection reads for 200 decisions", () => {
  const decisions = Array.from({ length: 200 }, (_, i) => ({
    decisionId: `dec_${i}`,
    state: "in_effect",
    riskTier: "low",
    body: null,
    reviews: i === 0 ? [{ reviewId: "review-dispatch-0", reportRef: "artifact:report", findings: [] }] : [],
  })) as unknown as readonly DecisionProjectionRow[];
  const events = decisions.map(({ decisionId }, i) => ({
    payload: {
      dispatchId: `dispatch-${i}`,
      runtimeSessionId: `session-${i}`,
      agentName: "reviewer",
      reviewTarget: { kind: "decision", decisionId, digest: `digest-${i}` },
    },
  })) as unknown as ReturnType<TaskProjection["readRuntimeDispatchesByDecisions"]>;
  let reads = 0;
  let matched = events;
  const projection = {
    readRuntimeDispatchesByDecision: () => {
      reads++;
      return [];
    },
    readRuntimeDispatchesByDecisions: (ids) => {
      reads++;
      assert.deepEqual(
        ids,
        decisions.map(({ decisionId }) => decisionId),
      );
      return matched;
    },
    readDispatchLifecycle: (query) => {
      reads++;
      assert.deepEqual(query, { by: "dispatch-batch", dispatchIds: events.map(({ payload }) => payload.dispatchId) });
      return {
        status: "ready",
        watermark: 10,
        sourceRevision: 10,
        nextCursor: null,
        rows: [
          { attempt: { dispatchId: "dispatch-1", outcome: "failed" }, groupDispatchIds: ["dispatch-1"] },
          {
            attempt: { dispatchId: "dispatch-0", outcome: null },
            groupDispatchIds: ["dispatch-0"],
            policy: { processAlive: true },
          },
        ] as unknown as DispatchLifecycleView[],
      };
    },
  } satisfies Pick<
    TaskProjection,
    "readRuntimeDispatchesByDecision" | "readRuntimeDispatchesByDecisions" | "readDispatchLifecycle"
  >;
  const list = (rows: readonly DecisionProjectionRow[] = decisions) =>
    decisionFullListRows({
      rootDir: "/fixture",
      projection: projection as unknown as TaskProjection,
      decisions: rows,
      readiness: [],
      requirement: "off",
    });

  const result = list();
  assert.equal(reads, 2);
  assert.equal(result.length, 200);
  assert.deepEqual(result[0]?.reviewDispatches, [
    {
      dispatchId: "dispatch-0",
      runtimeSessionId: "session-0",
      status: "running",
      reviewContentDigest: "digest-0",
      reportRef: "artifact:report",
      reviewer: "reviewer",
      findingCount: 0,
    },
  ]);
  assert.equal(result[1]?.reviewDispatches[0]?.status, "failed");
  assert.equal(result[2]?.reviewDispatches[0]?.status, "unknown");

  reads = 0;
  matched = [];
  assert.ok(list().every(({ reviewDispatches }) => reviewDispatches.length === 0));
  assert.equal(reads, 1);
  assert.deepEqual(list([]), []);
  assert.equal(reads, 1);
});
