// harness-test-tier: integration
// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { TaskDetailView } from "../src/renderer/views/TaskDetailView.tsx";
import type { TaskRow } from "../src/renderer/model/types.ts";
import { projectedTaskFields } from "./task-projection-fields.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";

/**
 * 议程「评审返回 / 待初审 / 任务评审中」的落点是 taskreview/<id>:任务详情直接停在评审记录
 * 所在的收口页签;普通 task/<id> 仍从概况开始。
 */
beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  setActiveLocale("zh-CN");
});
const mounted: Root[] = [];
afterEach(async () => {
  await act(async () => {
    for (const root of mounted.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

const task: TaskRow = {
  taskId: "task-rework",
  title: "被评审打回",
  projectId: "repo-a",
  coordinationStatus: "active",
  rawStatus: "active",
  freshness: "fresh",
  packageDisposition: "active",
  closeoutReadiness: "not_required",
  engine: "kernel/task-lifecycle/v1",
  source: "local-document",
  packagePath: "tasks/task-rework",
  gates: [],
  docs: [],
  ...projectedTaskFields("active"),
};

async function selectedTab(initialTab?: "closeout") {
  vi.stubGlobal("window", {
    harness: {
      getTaskDocuments: vi.fn(async () => ({ ok: true, status: "ready", taskId: task.taskId, documents: [] })),
      getTaskDocument: vi.fn(),
      getTaskCompletion: vi.fn(async () => ({ ok: true, status: "ready", completionBlocker: null })),
    },
    // 概况的 Region 是 motion 布局节点,挂载时在 window 上听 resize(与 task-detail.fixtures 同样的桩)。
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push(root);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(TaskDetailView, {
          task,
          onBack: () => undefined,
          projectName: "Harness",
          onNavigateDecision: () => undefined,
          onNavigateEntity: () => undefined,
          initialTab,
        }),
      ),
    );
  });
  return container.querySelector('[role="tab"][aria-selected="true"]')?.id;
}

describe("任务详情的评审落点", () => {
  it("initialTab=closeout 时打开即停在收口页签", async () => {
    expect(await selectedTab("closeout")).toBe("task-tab-closeout");
  });

  it("缺省仍从概况开始", async () => {
    expect(await selectedTab()).toBe("task-tab-overview");
  });
});
