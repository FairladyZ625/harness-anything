// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import type { TaskProjection } from "../../kernel/src/index.ts";
import { workspaceSummaryFromProjection } from "../src/workspace-summary-read.ts";

test("workspace summary uses the native projection aggregate without listing task or decision entities", () => {
  let nativeReads = 0;
  const projection = {
    readWorkspaceSummary: () => {
      nativeReads += 1;
      return {
        status: "ready",
        summary: {
          tasks: { total: 1, byStatus: { planned: 0, active: 1, blocked: 0, in_review: 0, done: 0, cancelled: 0, unknown: 0 } },
          decisions: { total: 1, inboxCount: 1, byState: { proposed: 1 }, groups: [{ id: "proposed", states: ["proposed"], decisionIds: ["dec-1"], count: 1 }] },
        },
        watermark: 7,
        sourceRevision: 7,
      } as const;
    },
    list: () => { throw new Error("workspace summary must not list full task snapshots"); },
    readDecisions: () => { throw new Error("workspace summary must not list full decision snapshots"); },
  } as unknown as TaskProjection;

  const result = workspaceSummaryFromProjection(projection);
  assert.equal(nativeReads, 1);
  assert.deepEqual({ status: result.status, taskTotal: result.tasks.total, decisionTotal: result.decisions.total }, { status: "ready", taskTotal: 1, decisionTotal: 1 });
});
