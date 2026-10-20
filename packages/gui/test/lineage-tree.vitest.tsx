// harness-test-tier: fast
// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { rollupSubtree } from "../src/renderer/components/agent-ui/AgentTree.tsx";
import {
  buildLineageTree,
  dispatchActivity,
  dispatchDurationMs,
  lineageTaskIds,
  taskActivity,
} from "../src/renderer/model/lineage-tree.ts";
import type { TaskDispatchProjectionRow } from "../src/api/renderer-dto.ts";
import type { TaskRow } from "../src/renderer/model/types.ts";

const NOW = Date.parse("2026-10-20T12:00:00.000Z");

const task = (taskId: string, patch: Partial<TaskRow> = {}): TaskRow =>
  ({
    taskId,
    title: `标题 ${taskId}`,
    canonicalStatus: "planned",
    lastKnownAt: "2026-10-20T10:00:00.000Z",
    createdAt: "2026-10-01T00:00:00.000Z",
    events: [],
    ...patch,
  }) as TaskRow;

const dispatch = (patch: Partial<TaskDispatchProjectionRow> = {}): TaskDispatchProjectionRow =>
  ({
    dispatchId: "dispatch-x",
    taskId: "task-root",
    executionId: "execution-x",
    runtimeSessionId: "runtime-x",
    instanceId: "instance-x",
    attemptGroupId: "attempt-x",
    attemptIndex: 0,
    provider: { instance: "instance-x", model: "glm-5.3" },
    classification: null,
    reason: null,
    fallbackState: null,
    nextDispatchId: null,
    providerSessionId: null,
    eventStreamRef: null,
    startedAt: "2026-10-20T10:00:00.000Z",
    endedAt: null,
    outcome: null,
    status: "running",
    ...patch,
  }) as TaskDispatchProjectionRow;

describe("lineage activity vocabulary", () => {
  it("maps dispatch wire statuses onto tree activities without inventing labels", () => {
    expect(dispatchActivity("running")).toBe("running");
    expect(dispatchActivity("succeeded")).toBe("done");
    expect(dispatchActivity("failed")).toBe("failed");
    expect(dispatchActivity("blocked")).toBe("awaiting");
    expect(dispatchActivity("cancelled")).toBe("cancelled");
    expect(dispatchActivity("stopped")).toBe("cancelled");
    expect(dispatchActivity("unknown")).toBe("idle");
    expect(dispatchActivity("lost")).toBe("idle");
  });

  it("maps task snapshot statuses onto tree activities", () => {
    expect(taskActivity("active")).toBe("running");
    expect(taskActivity("submitted")).toBe("awaiting");
    expect(taskActivity("in_review")).toBe("awaiting");
    expect(taskActivity("blocked")).toBe("awaiting");
    expect(taskActivity("done")).toBe("done");
    expect(taskActivity("cancelled")).toBe("cancelled");
    expect(taskActivity("planned")).toBe("idle");
    expect(taskActivity("unknown")).toBe("idle");
  });

  it("derives own duration from ended rounds and from now for running rounds", () => {
    expect(dispatchDurationMs(dispatch({ endedAt: "2026-10-20T11:00:00.000Z" }), NOW)).toBe(3_600_000);
    expect(dispatchDurationMs(dispatch(), NOW)).toBe(7_200_000);
    expect(dispatchDurationMs(dispatch({ startedAt: "not-a-date" }), NOW)).toBeUndefined();
  });
});

describe("buildLineageTree", () => {
  const rows = [
    // 直接挂工作根的一轮:已收口,214K tok / 22m。
    dispatch({
      dispatchId: "dispatch-r1",
      runtimeSessionId: "runtime-r1",
      attemptIndex: 0,
      agentName: "Codex W1",
      status: "succeeded",
      endedAt: "2026-10-20T10:22:00.000Z",
      metrics: {
        inputTokens: 100_000,
        cacheReadTokens: 0,
        outputTokens: 114_000,
        totalTokens: 214_000,
        toolCallCount: 3,
        compacted: null,
      },
    }),
    // 第二轮:运行中,own 120K。
    dispatch({
      dispatchId: "dispatch-r2",
      runtimeSessionId: "runtime-r2",
      attemptIndex: 1,
      agentName: "GLM W3",
      status: "running",
      metrics: {
        inputTokens: 60_000,
        cacheReadTokens: 0,
        outputTokens: 60_000,
        totalTokens: 120_000,
        toolCallCount: 1,
        compacted: null,
      },
    }),
    // 由第二轮会话委托出的 Squad Worker:挂在 dispatch-r2 下,own 50K。
    dispatch({
      dispatchId: "dispatch-worker",
      runtimeSessionId: "runtime-worker",
      parentRuntimeSessionId: "runtime-r2",
      attemptIndex: 0,
      agentId: "agent-worker",
      squadId: "squad-plt",
      status: "done",
      endedAt: "2026-10-20T11:30:00.000Z",
      startedAt: "2026-10-20T11:00:00.000Z",
      metrics: {
        inputTokens: 25_000,
        cacheReadTokens: 0,
        outputTokens: 25_000,
        totalTokens: 50_000,
        toolCallCount: 0,
        compacted: null,
      },
    }),
    // 父会话不在批次内(父轮属于别的任务):挂回任务节点,不丢。
    dispatch({
      dispatchId: "dispatch-orphan",
      runtimeSessionId: "runtime-orphan",
      parentRuntimeSessionId: "runtime-elsewhere",
      taskId: "task-child",
      agentName: "挂靠 Worker",
      status: "cancelled",
      endedAt: "2026-10-20T09:00:00.000Z",
    }),
  ];

  it("nests work → task → dispatch rounds → delegated workers via parentRuntimeSessionId", () => {
    const tree = buildLineageTree({
      rootTask: task("task-root", { canonicalStatus: "active" }),
      tasks: [task("task-child", { parentTaskId: "task-root", canonicalStatus: "in_review" })],
      dispatches: rows,
      nowMs: NOW,
    });
    expect(tree.id).toBe("task:task-root");
    expect(tree.children?.map((child) => child.id)).toEqual([
      "task:task-child",
      "dispatch:dispatch-r1",
      "dispatch:dispatch-r2",
    ]);
    const round2 = tree.children?.find((child) => child.id === "dispatch:dispatch-r2");
    expect(round2?.children?.map((child) => child.id)).toEqual(["dispatch:dispatch-worker"]);
    const childTask = tree.children?.find((child) => child.id === "task:task-child");
    expect(childTask?.children?.map((child) => child.id)).toEqual(["dispatch:dispatch-orphan"]);
  });

  it("rolls up subtree cost from own values only: the work root sums every round exactly once", () => {
    const tree = buildLineageTree({
      rootTask: task("task-root"),
      tasks: [task("task-child", { parentTaskId: "task-root" })],
      dispatches: rows,
      nowMs: NOW,
    });
    const rollup = rollupSubtree(tree);
    // 214K + 120K + 50K + 0(无 metrics 的 cancelled 轮) = 384K;任务节点不虚构 own。
    expect(rollup.tokens).toBe(384_000);
    // 后代 = task-child + 4 个派工节点;委托 worker 只计一次。
    expect(rollup.descendants).toBe(5);
    expect(rollup.finished).toBe(false);
  });

  it("resolves the delegated worker role from agent identity, not a placeholder", () => {
    const tree = buildLineageTree({ rootTask: task("task-root"), tasks: [], dispatches: rows, nowMs: NOW });
    const worker = tree.children
      ?.find((child) => child.id === "dispatch:dispatch-r2")
      ?.children?.find((child) => child.id === "dispatch:dispatch-worker");
    expect(worker?.role).toBe("agent-worker");
    expect(worker?.ownTokens).toBe(50_000);
  });
});

describe("lineageTaskIds", () => {
  it("collects the descendant closure in input order and survives a parent cycle", () => {
    const tasks = [
      task("task-root"),
      task("task-child", { parentTaskId: "task-root" }),
      task("task-grandchild", { parentTaskId: "task-child" }),
      task("task-unrelated"),
    ];
    expect(lineageTaskIds("task-root", tasks)).toEqual(["task-root", "task-child", "task-grandchild"]);
    const cyclic = [...tasks, task("task-loop", { parentTaskId: "task-loop" })];
    expect(lineageTaskIds("task-root", cyclic)).toEqual(["task-root", "task-child", "task-grandchild"]);
  });
});
