// harness-test-tier: fast
// @vitest-environment happy-dom
import { act } from "react";
import { createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkView } from "../src/renderer/views/WorkView.tsx";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";
import type { TaskRow } from "../src/renderer/model/types.ts";
import type { TaskDispatchProjectionRow } from "../src/api/renderer-dto.ts";

const { getTaskDispatches } = vi.hoisted(() => ({ getTaskDispatches: vi.fn() }));

vi.mock("../src/renderer/api-client.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/renderer/api-client.ts")>();
  return { ...actual, harnessClient: { ...actual.harnessClient, getTaskDispatches } };
});

const task = (taskId: string, patch: Partial<TaskRow> = {}): TaskRow =>
  ({
    taskId,
    title: `工作 ${taskId}`,
    canonicalStatus: "planned",
    taskClass: "work",
    workId: taskId,
    lastKnownAt: "2026-10-20T10:00:00.000Z",
    createdAt: "2026-10-01T00:00:00.000Z",
    events: [],
    ...patch,
  }) as TaskRow;

const dispatch = (patch: Partial<TaskDispatchProjectionRow> = {}): TaskDispatchProjectionRow =>
  ({
    dispatchId: "dispatch-w",
    taskId: "work-root",
    executionId: "execution-w",
    runtimeSessionId: "runtime-w",
    instanceId: "instance-w",
    attemptGroupId: "attempt-w",
    attemptIndex: 0,
    provider: { instance: "instance-w", model: "glm-5.3" },
    classification: null,
    reason: null,
    fallbackState: null,
    nextDispatchId: null,
    providerSessionId: null,
    eventStreamRef: null,
    startedAt: "2026-10-20T10:00:00.000Z",
    endedAt: "2026-10-20T11:00:00.000Z",
    outcome: "succeeded",
    status: "succeeded",
    agentName: "GLM Worker",
    ...patch,
  }) as TaskDispatchProjectionRow;

const mounted: { readonly root: Root; readonly client: QueryClient }[] = [];

async function mountWork(
  tasks: readonly TaskRow[],
  props: { readonly onOpenTask: (id: string) => void; readonly onNavigateEntity: (ref: string) => void },
) {
  const container = document.createElement("div"),
    root = createRoot(container),
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  document.body.append(container);
  mounted.push({ root, client });
  await act(async () => {
    root.render(
      createElement(
        StrictMode,
        null,
        createElement(
          QueryClientProvider,
          { client },
          createElement(WorkView, {
            tasks,
            repoId: "repo-a",
            ready: true,
            catalog: undefined,
            catalogError: null,
            daemonState: "ok",
            onRefreshLedger: () => {},
            agenda: undefined,
            ...props,
          }),
        ),
      ),
    );
  });
  return container;
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  setActiveLocale("zh-CN");
  getTaskDispatches.mockReset();
});

afterEach(async () => {
  await act(async () => {
    for (const { root, client } of mounted.splice(0)) {
      root.unmount();
      client.clear();
    }
  });
  document.body.replaceChildren();
});

const byTestId = (container: HTMLElement, testId: string) => {
  const found = container.querySelector(`[data-testid="${testId}"]`);
  if (found === null) throw new Error(`missing [data-testid="${testId}"]`);
  return found as HTMLElement;
};

describe("WorkView lineage tree", () => {
  it("expands a work card into a live lineage tree with subtree cost rollup", async () => {
    getTaskDispatches.mockResolvedValue({
      ok: true,
      status: "ready",
      taskIds: ["work-root", "task-child"],
      unavailableTaskIds: [],
      dispatches: [
        dispatch({
          dispatchId: "d-1",
          runtimeSessionId: "runtime-1",
          taskId: "task-child",
          agentName: "GLM Worker",
          metrics: {
            inputTokens: 100_000,
            cacheReadTokens: 0,
            outputTokens: 100_000,
            totalTokens: 200_000,
            toolCallCount: 1,
            compacted: null,
          },
        }),
        dispatch({
          dispatchId: "d-worker",
          runtimeSessionId: "runtime-worker",
          parentRuntimeSessionId: "runtime-1",
          taskId: "task-child",
          agentName: undefined,
          agentId: "agent-worker",
          squadId: "squad-plt",
          metrics: {
            inputTokens: 50_000,
            cacheReadTokens: 0,
            outputTokens: 50_000,
            totalTokens: 100_000,
            toolCallCount: 0,
            compacted: null,
          },
        }),
      ],
      outcome: "succeeded",
      exitCode: 0,
      page: { sourceLimit: 500, cursor: null, nextCursor: null },
      watermark: 1,
      sourceRevision: 1,
    });
    const tasks = [
      task("work-root", { canonicalStatus: "active" }),
      task("task-child", {
        parentTaskId: "work-root",
        workId: "work-root",
        taskClass: "standard",
        canonicalStatus: "in_review",
      }),
    ];
    const onOpenTask = vi.fn(),
      onNavigateEntity = vi.fn();
    const container = await mountWork(tasks, { onOpenTask, onNavigateEntity });

    await act(async () => {
      byTestId(container, "work-lineage-toggle-work-root").click();
    });
    const tree = await vi.waitFor(() => byTestId(container, "work-lineage-tree-work-root"));
    // 工作根 Rollup:两轮 own 各计一次,Σ 300K tok。
    expect(tree.textContent).toContain("Σ 300K tok");
    expect(tree.textContent).toContain("GLM Worker");
    expect(tree.textContent).toContain("agent-worker");
  });

  it("opens the child task detail from a task node and the session transcript from a worker node", async () => {
    getTaskDispatches.mockResolvedValue({
      ok: true,
      status: "ready",
      taskIds: ["work-root", "task-child"],
      unavailableTaskIds: [],
      dispatches: [dispatch({ dispatchId: "d-1", runtimeSessionId: "runtime-1", agentName: "GLM Worker" })],
      outcome: "succeeded",
      exitCode: 0,
      page: { sourceLimit: 500, cursor: null, nextCursor: null },
      watermark: 1,
      sourceRevision: 1,
    });
    const tasks = [
      task("work-root", { canonicalStatus: "active" }),
      task("task-child", { parentTaskId: "work-root", workId: "work-root", taskClass: "standard" }),
    ];
    const onOpenTask = vi.fn(),
      onNavigateEntity = vi.fn();
    const container = await mountWork(tasks, { onOpenTask, onNavigateEntity });

    await act(async () => {
      byTestId(container, "work-lineage-toggle-work-root").click();
    });
    await vi.waitFor(() => byTestId(container, "work-lineage-tree-work-root"));
    // 子任务节点 → 对应任务详情。
    await act(async () => {
      byTestId(container, "work-lineage-tree-work-root-tree-row-task:task-child").click();
    });
    expect(onOpenTask).toHaveBeenCalledWith("task-child");
    // 派工(Worker)节点 → 会话转录实体。
    await act(async () => {
      byTestId(container, "work-lineage-tree-work-root-tree-row-dispatch:d-1").click();
    });
    expect(onNavigateEntity).toHaveBeenCalledWith("session/runtime-1");
  });

  it("surfaces lineage read failures as themselves instead of an empty tree", async () => {
    getTaskDispatches.mockRejectedValue(new Error("bridge unavailable"));
    const onOpenTask = vi.fn(),
      onNavigateEntity = vi.fn();
    const container = await mountWork([task("work-root", { canonicalStatus: "active" })], {
      onOpenTask,
      onNavigateEntity,
    });
    await act(async () => {
      byTestId(container, "work-lineage-toggle-work-root").click();
    });
    await vi.waitFor(() =>
      expect(byTestId(container, "work-lineage-tree-work-root-error").textContent).toContain("bridge unavailable"),
    );
  });

  it("loads descendants beyond the first 500 tasks instead of cutting off their dispatch history", async () => {
    getTaskDispatches.mockImplementation(async (payload) => ({
      ok: true,
      status: "ready",
      taskIds: payload.taskIds,
      unavailableTaskIds: [],
      dispatches: [],
      outcome: "unknown",
      exitCode: 0,
      watermark: 1,
      sourceRevision: 1,
      page: { limit: 16, cursor: null, nextCursor: null },
    }));
    const tasks = [
      task("work-root"),
      ...Array.from({ length: 501 }, (_, index) =>
        task(`child-${index}`, {
          parentTaskId: "work-root",
          workId: "work-root",
          taskClass: "standard",
        }),
      ),
    ];
    const container = await mountWork(tasks, { onOpenTask: vi.fn(), onNavigateEntity: vi.fn() });
    await act(async () => byTestId(container, "work-lineage-toggle-work-root").click());
    await vi.waitFor(
      () => expect(new Set(getTaskDispatches.mock.calls.flatMap(([payload]) => payload.taskIds)).size).toBe(502),
      { timeout: 10_000 },
    );
    expect(
      getTaskDispatches.mock.calls.every(([payload]) => payload.taskIds.length <= 500 && payload.limit === 16),
    ).toBe(true);
  });
});
