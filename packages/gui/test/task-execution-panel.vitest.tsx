// harness-test-tier: fast
// @vitest-environment happy-dom
import { act } from "react";
import { createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskExecutionPanel } from "../src/renderer/components/taskDetail/TaskExecutionPanel.tsx";
import { runtimeCommandClient } from "../src/renderer/runtime-command-client.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";
import type { TaskRow } from "../src/renderer/model/types.ts";
import type { TaskDispatchProjectionRow } from "../src/api/renderer-dto.ts";

const { getTaskDispatches, getAgentRuntimeEvents } = vi.hoisted(() => ({
  getTaskDispatches: vi.fn(),
  getAgentRuntimeEvents: vi.fn(),
}));

vi.mock("../src/renderer/runtime-command-client.ts", () => ({
  runtimeCommandClient: {
    steer: vi.fn(),
    cancel: vi.fn(),
    spawn: vi.fn(),
  },
}));

const dispatch = (patch: Partial<TaskDispatchProjectionRow> = {}): TaskDispatchProjectionRow =>
  ({
    dispatchId: "dispatch-run",
    taskId: "task-x",
    executionId: "execution-x",
    runtimeSessionId: "runtime-run",
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

const task = {
  taskId: "task-x",
  title: "任务 X",
  projectId: "repo-a",
  activeExecutionId: "execution-x",
} as TaskRow;

const dispatchRead = (rows: readonly TaskDispatchProjectionRow[]) => ({
  ok: true,
  status: "ready" as const,
  taskId: "task-x",
  dispatches: rows,
  outcome: "unknown" as const,
  exitCode: 0,
  watermark: 1,
  sourceRevision: 1,
});
const eventsRead = (occurredAt: string) => ({
  ok: true,
  runtimeSessionId: "runtime-run",
  events: [{ cursor: "lifecycle:7", runtimeSessionId: "runtime-run", type: "runtime_session_started", occurredAt }],
  cursor: "lifecycle:7",
  sourceCursor: "lifecycle:7",
  done: true,
});

vi.mock("../src/renderer/api-client.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/renderer/api-client.ts")>();
  return { ...actual, harnessClient: { ...actual.harnessClient, getTaskDispatches } };
});
vi.mock("../src/renderer/agent-runtime-client.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/renderer/agent-runtime-client.ts")>();
  return { ...actual, agentRuntimeClient: { ...actual.agentRuntimeClient, events: getAgentRuntimeEvents } };
});

const mounted: { readonly root: Root; readonly client: QueryClient }[] = [];

async function mountPanel() {
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
        createElement(QueryClientProvider, { client }, createElement(TaskExecutionPanel, { task })),
      ),
    );
  });
  return container;
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  setActiveLocale("zh-CN");
  vi.mocked(runtimeCommandClient.steer).mockReset();
  vi.mocked(runtimeCommandClient.cancel).mockReset();
  vi.mocked(runtimeCommandClient.spawn).mockReset();
  getTaskDispatches.mockReset();
  getAgentRuntimeEvents.mockReset();
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

/** 受控 textarea 赋值:绕过 React 的 valueTracker,再派发 input 事件。 */
function setDraft(container: HTMLElement, value: string) {
  const textarea = byTestId(container, "task-execution-steering-textarea") as HTMLTextAreaElement;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("TaskExecutionPanel", () => {
  it("renders dispatch rounds as timed steps with a retry entry on the failed round", async () => {
    getTaskDispatches.mockResolvedValue(
      dispatchRead([
        dispatch({
          dispatchId: "dispatch-f1",
          attemptIndex: 0,
          agentName: "Codex W1",
          status: "failed",
          endedAt: "2026-10-20T10:40:00.000Z",
        }),
        dispatch({ dispatchId: "dispatch-run", attemptIndex: 1, agentName: "GLM W3", status: "running" }),
      ]),
    );
    getAgentRuntimeEvents.mockResolvedValue(eventsRead("2026-08-23T10:30:00.000Z"));
    const container = await mountPanel();
    await vi.waitFor(() => expect(byTestId(container, "task-execution-plan-step-dispatch-f1")).toBeTruthy());
    expect(container.textContent).toContain("第 1 轮 · Codex W1");
    expect(container.textContent).toContain("第 2 轮 · GLM W3");
    // 失败步带重试入口;重试走 runtime spawn 的 resume 通道(dispatchId + dispatchKey)。
    await act(async () => {
      byTestId(container, "task-execution-plan-retry-dispatch-f1").click();
    });
    expect(runtimeCommandClient.spawn).toHaveBeenCalledWith(
      "repo-a",
      expect.objectContaining({ dispatchId: "dispatch-f1" }),
    );
  });

  it("steers the running session through the runtime channel and absorbs the note when the session advances", async () => {
    getTaskDispatches.mockResolvedValue(dispatchRead([dispatch({ agentName: "GLM W3" })]));
    // 会话在 steer 送达之后又推进了一条生命周期事件 → 纸条吸收。
    getAgentRuntimeEvents.mockResolvedValue(eventsRead("2099-01-01T00:00:00.000Z"));
    vi.mocked(runtimeCommandClient.steer).mockResolvedValue({
      schema: "command-receipt/v2",
      ok: true,
      outcome: "applied",
      opId: "op-1",
    });
    const container = await mountPanel();
    await vi.waitFor(() => expect(byTestId(container, "task-execution-steering-textarea")).toBeTruthy());

    await act(async () => {
      setDraft(container, "先补上回归测试再继续");
    });
    await act(async () => {
      byTestId(container, "task-execution-steering-enqueue").click();
    });
    // 追加指令写入走统一 runtime 客户端:目标运行会话 + 原文 prompt。
    await vi.waitFor(() =>
      expect(runtimeCommandClient.steer).toHaveBeenCalledWith("repo-a", {
        runtimeSessionId: "runtime-run",
        prompt: "先补上回归测试再继续",
      }),
    );
    // 会话推进后纸条滑入对应轮次步骤卡(absorbed),不再留在队列。
    await vi.waitFor(() =>
      expect(byTestId(container, "task-execution-plan-step-dispatch-run").textContent).toContain(
        "先补上回归测试再继续",
      ),
    );
  });

  it("keeps the note queued with the real error when the steer write fails — no fake receipt", async () => {
    getTaskDispatches.mockResolvedValue(dispatchRead([dispatch({ agentName: "GLM W3" })]));
    getAgentRuntimeEvents.mockResolvedValue(eventsRead("2099-01-01T00:00:00.000Z"));
    vi.mocked(runtimeCommandClient.steer).mockRejectedValue(
      new Error("runtime_steer_unsupported: zhipu-a2a does not support runtime steering."),
    );
    const container = await mountPanel();
    await vi.waitFor(() => expect(byTestId(container, "task-execution-steering-textarea")).toBeTruthy());
    await act(async () => {
      setDraft(container, "停止当前方向");
    });
    await act(async () => {
      byTestId(container, "task-execution-steering-enqueue").click();
    });
    await vi.waitFor(() =>
      expect(byTestId(container, "task-execution-note-errors").textContent).toContain("runtime_steer_unsupported"),
    );
    // 失败的纸条仍在待吸收队列里,可撤回重试。
    expect(container.querySelector('[data-testid^="task-execution-steering-note-"]')).not.toBeNull();
  });

  it("interrupts through the cancel channel of the runtime client", async () => {
    getTaskDispatches.mockResolvedValue(dispatchRead([dispatch({ agentName: "GLM W3" })]));
    getAgentRuntimeEvents.mockResolvedValue(eventsRead("2026-08-23T10:30:00.000Z"));
    vi.mocked(runtimeCommandClient.cancel).mockResolvedValue({
      schema: "command-receipt/v2",
      ok: true,
      outcome: "applied",
      opId: "op-2",
    });
    const container = await mountPanel();
    await vi.waitFor(() => expect(byTestId(container, "task-execution-steering-interrupt")).toBeTruthy());
    await act(async () => {
      byTestId(container, "task-execution-steering-interrupt").click();
    });
    expect(runtimeCommandClient.cancel).toHaveBeenCalledWith("repo-a", "runtime-run");
  });
});
