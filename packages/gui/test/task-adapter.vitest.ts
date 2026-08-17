import { describe, expect, it } from "vitest";
import { REPLAY_TASK_GRAPH } from "../../kernel/src/index.ts";
import type { TaskSnapshotProjectionRow } from "../src/api/renderer-dto.ts";
import { adaptProjectionRows, computeRootTaskId } from "../src/renderer/task-adapter.ts";
import type { DecisionRow, RelationEdge } from "../src/renderer/model/types.ts";

function row(overrides: Partial<TaskSnapshotProjectionRow> = {}): TaskSnapshotProjectionRow {
  const taskId = overrides.taskId ?? "task-x";
  return { taskId, workspaceRevision: 1, updatedAt: "2026-08-12T00:00:00.000Z", snapshot: { revision: 1,
    task: { schema: "task/v1", taskId, title: "X", taskClass: "standard", status: "planned", graph: REPLAY_TASK_GRAPH, currentNode: "implementation", iteration: 0,
      createdBy: { principal: { personId: "person-owner" }, executor: null }, completionGateIds: [], presetSnapshotDigest: null }, executions: [], reviews: [], consents: [], codeDocWitnesses: [], gateWitnesses: [], edgesTaken: [], lease: null },
    packagePath: `tasks/${taskId}-x`, snapshotAvailability: { consents: "known", codeDocWitnesses: "known", gateWitnesses: "known" },
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
      freshness: "fresh", rootTaskId: "task-x", rootTitle: "X", module: "gui", moduleKeys: ["gui"], productLines: ["harness"],
      origin: "native", engine: "kernel/task-lifecycle/v1" });
  });

  it("marks a pending projection stale but usable", () => {
    expect(adaptProjectionRows([row()], "repo-test", "pending")[0]?.freshness).toBe("stale-but-usable");
  });

  it("derives the blocked display lane from the canonical depends-on direction", () => {
    const rows = [row({ taskId: "task-a" }), row({ taskId: "task-b" }), row({ taskId: "task-c", snapshot: {
      ...row().snapshot, task: { ...row().snapshot.task!, taskId: "task-c", status: "done" }
    } })];
    const relations = [
      relation({ from: "task/task-a", to: "task/task-b", kind: "depends-on" }),
      relation({ relationId: "rel_0000000000000002", from: "task/task-b", to: "task/task-c", kind: "depends-on" })
    ];
    const tasks = adaptProjectionRows(rows, "repo-test", "ready", { relationState: "ready", relations });

    // `task A depends-on task B`: A (the source) is blocked; a done target stops blocking.
    expect(tasks.find((task) => task.taskId === "task-a")).toMatchObject({
      canonicalStatus: "planned", coordinationStatus: "blocked", blocking: "blocked",
      blockers: [{ relationId: "rel_0000000000000001", sourceTaskId: "task-a", targetTaskId: "task-b" }]
    });
    expect(tasks.find((task) => task.taskId === "task-b")?.blocking).toBe("clear");
    expect(tasks.find((task) => task.taskId === "task-c")?.blocking).toBe("clear");
  });

  it("ignores the retired blocks mirror: only depends-on expresses task blocking", () => {
    // Before slice 4 the adapter read `blocks` with the opposite endpoint orientation;
    // the kernel registry now refuses that triple, and the adapter no longer derives
    // direction per verb. A legacy blocks edge must not block either endpoint.
    const rows = [row({ taskId: "task-a" }), row({ taskId: "task-b" })];
    const relations = [relation({ from: "task/task-a", to: "task/task-b", kind: "blocks" })];
    const tasks = adaptProjectionRows(rows, "repo-test", "ready", { relationState: "ready", relations });
    expect(tasks.map((task) => task.blocking)).toEqual(["clear", "clear"]);
  });

  it("fails closed to unknown for unavailable relation truth, malformed blocking edges, and missing endpoints", () => {
    const unavailable = adaptProjectionRows([row()], "repo-test", "ready", { relationState: "loading", relations: [] })[0]!;
    expect(unavailable).toMatchObject({ blocking: "unknown", coordinationStatus: "planned", blockingLabel: "阻塞关系未能确定",
      module: "unassigned", moduleKeys: [], productLines: [], placementWarning: "relation projection 未就绪，无法判定 derived placement" });

    const tasks = adaptProjectionRows([row({ taskId: "task-a" }), row({ taskId: "task-b" })], "repo-test", "ready", {
      relationState: "ready",
      relations: [
        relation({ direction: "undirected" }),
        relation({ relationId: "rel_0000000000000003", from: "task/task-missing", to: "task/task-a" })
      ]
    });
    expect(tasks.map(({ blocking }) => blocking)).toEqual(["unknown", "unknown"]);
    expect(tasks[0]?.blockingWarnings).toEqual(expect.arrayContaining([expect.stringContaining("task-missing")]));
  });

  it("recomputes active dependency cycles and shows every node as blocked with a cycle warning", () => {
    const tasks = adaptProjectionRows([row({ taskId: "task-a" }), row({ taskId: "task-b" })], "repo-test", "ready", {
      relationState: "ready",
      relations: [
        relation({ kind: "depends-on" }),
        relation({ relationId: "rel_0000000000000002", kind: "depends-on", from: "task/task-b", to: "task/task-a" })
      ]
    });
    expect(tasks.map(({ blocking }) => blocking)).toEqual(["blocked", "blocked"]);
    expect(tasks.every((task) => task.blockingWarnings.some((warning) => warning.includes("cycle")))).toBe(true);
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
