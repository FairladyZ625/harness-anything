import { describe, expect, it } from "vitest";
import { REPLAY_TASK_GRAPH } from "../../kernel/src/index.ts";
import type { TaskSnapshotProjectionRow } from "../src/api/renderer-dto.ts";
import { adaptProjectionRows, computeRootTaskId } from "../src/renderer/task-adapter.ts";
import type { DecisionRow, RelationEdge } from "../src/renderer/model/types.ts";

function row(overrides: Partial<TaskSnapshotProjectionRow> = {}): TaskSnapshotProjectionRow {
  const taskId = overrides.taskId ?? "task-x";
  return { taskId, workspaceRevision: 1, createdAt: "2026-08-11T23:59:00.000Z", updatedAt: "2026-08-12T00:00:00.000Z", snapshot: { revision: 1,
    task: { schema: "task/v1", taskId, title: "X", taskClass: "standard", status: "planned", graph: REPLAY_TASK_GRAPH, currentNode: "implementation", iteration: 0,
      createdBy: { principal: { personId: "person-owner" }, executor: null }, completionGateIds: [], presetSnapshotDigest: null }, executions: [], reviews: [], consents: [], codeDocWitnesses: [], gateWitnesses: [], edgesTaken: [], lease: null },
    packagePath: `tasks/${taskId}-x`, snapshotAvailability: { consents: "known", codeDocWitnesses: "known", gateWitnesses: "known" },
    closeoutAssessment: { readiness: "not_required", gates: [] },
    blockingAssessment: { taskId, state: "clear", blockers: [], warnings: [] },
    placement: { moduleKeys: ["gui"], productLines: ["harness"], parentTaskId: null, origin: "native", engine: "kernel/task-lifecycle/v1", packageDisposition: "active", provenance: [{ kind: "l2", ref: `tasks/${taskId}-x/INDEX.md` }] },
    executionEvidence: [], ...overrides };
}

const relation = (overrides: Partial<RelationEdge>): RelationEdge => ({
  relationId: "rel_0000000000000001", from: "task/task-a", to: "task/task-b", kind: "depends-on",
  direction: "directed", state: "active", provenance: "local-document", rationale: "A waits for B", ...overrides
});

describe("computeRootTaskId", () => {
  it("walks a parent chain and terminates cycles", () => {
    expect(computeRootTaskId("child", new Map([["child", "root"], ["root", undefined]]))).toBe("root");
    expect(computeRootTaskId("left", new Map([["left", "right"], ["right", "left"]]))).toBe("left");
  });
});

describe("adaptProjectionRows", () => {
  it("derives renderer state from the canonical lifecycle snapshot", () => {
    const [task] = adaptProjectionRows([row()], "repo-test");
    expect(task).toMatchObject({ taskId: "task-x", title: "X", coordinationStatus: "planned", rawStatus: "planned/implementation",
      canonicalStatus: "planned", blocking: "clear", blockingLabel: "当前投影无 active blocking relation",
      freshness: "fresh", createdAt: "2026-08-11T23:59:00.000Z", rootTaskId: "task-x", rootTitle: "X", module: "gui", moduleKeys: ["gui"], productLines: ["harness"],
      origin: "native", engine: "kernel/task-lifecycle/v1" });
  });

  it("marks a pending projection stale but usable", () => {
    expect(adaptProjectionRows([row()], "repo-test", "pending")[0]?.freshness).toBe("stale-but-usable");
  });

  it("renders authoritative closeout and blocking assessments without relation recomputation", () => {
    const input = row({ taskId: "task-a", closeoutAssessment: { readiness: "failed", executionId: "exe-a", blocker: "gate", gates: [{ gateId: "ci", status: "failed", detail: "current cut failed" }] }, blockingAssessment: { taskId: "task-a", state: "blocked", blockers: [{ relationId: "rel_0000000000000001", kind: "depends-on", sourceTaskId: "task-a", targetTaskId: "task-b" }], warnings: [] } });
    const [task] = adaptProjectionRows([input], "repo-test", "ready", { relationState: "ready", relations: [] });
    expect(task).toMatchObject({ coordinationStatus: "blocked", blocking: "blocked", closeoutReadiness: "failed", gates: [{ name: "ci", ok: false, detail: "current cut failed" }], blockers: [{ sourceTaskId: "task-a", targetTaskId: "task-b" }] });
  });

  it("prioritizes decision-derived scopes and uses the supplement for independent placement and parent roots", () => {
    const parent = row({ taskId: "task-parent", placement: { ...row().placement, moduleKeys: ["kernel"], productLines: ["platform"] } });
    const child = row({ taskId: "task-child", placement: { ...row().placement, moduleKeys: ["stale-supplement"], productLines: ["stale"], parentTaskId: "task-parent" } });
    const decision = { decisionId: "dec-scope", title: "Scope", state: "active", question: "Where?", chosen: [], rejected: [], claims: [],
      appliesTo: { modules: ["gui"], productLines: ["desktop"] } } satisfies DecisionRow;
    const tasks = adaptProjectionRows([parent, child], "repo-test", "ready", { relationState: "ready", decisions: [decision], relations: [relation({
      relationId: "rel_0000000000000004", from: "decision/dec-scope", to: "task/task-child", kind: "derives"
    })] });

    expect(tasks.find((task) => task.taskId === "task-child")).toMatchObject({
      module: "gui", moduleKeys: ["gui"], productLines: ["desktop"], parentTaskId: "task-parent",
      rootTaskId: "task-parent", rootTitle: "X", spawningDecision: "dec-scope"
    });
    expect(tasks.find((task) => task.taskId === "task-parent")).toMatchObject({ module: "kernel", productLines: ["platform"] });
  });
});
