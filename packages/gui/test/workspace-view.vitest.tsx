// harness-test-tier: fast
// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WorkspaceView } from "../src/renderer/views/WorkspaceView.tsx";
import { combineWorkspaceScopePages } from "../src/renderer/workspace-scope-data.ts";
import type { WorkspaceScopeRead } from "../src/api/renderer-dto.ts";

const row = {
  taskId: "task_root",
  title: "统一体验",
  status: "active",
  taskClass: "milestone",
  parentTaskId: null,
  updatedAt: "2026-09-20T00:00:00.000Z",
  pinned: true,
  hasChildren: false,
} as const;

function scope(overrides: Partial<WorkspaceScopeRead> = {}): WorkspaceScopeRead {
  return {
    schema: "daemon.workspace-scope/v1",
    ok: true,
    status: "ready",
    root: row,
    ancestors: [],
    goalMaterial: { taskId: row.taskId, path: "task_plan.md" },
    counts: { done: 0, executing: 0, pending: 0, blocked: 0, planned: 0, cancelled: 0 },
    scope: { descendantCount: 0, executableLeafCount: 0, archivedCount: 0 },
    groups: [],
    memberTaskIds: [],
    tasks: [],
    page: { limit: 100, cursor: null, nextCursor: null },
    incompleteParentRefs: [],
    watermark: 4,
    sourceRevision: 4,
    warnings: [],
    ...overrides,
  };
}

describe("workspace view states", () => {
  it("renders honest empty collections", () => {
    const html = renderToStaticMarkup(
      <WorkspaceView scope={scope()} projectName="Harness" onOpenTask={() => {}} onOpenGroup={() => {}} />,
    );
    expect(html).toContain("暂无正在推进");
    expect(html).toContain("workspace-sidebar");
    expect(html).not.toContain("max-w-6xl");
    expect(html).toContain("min-[1750px]:grid-cols-[minmax(0,1fr)_370px]");
    expect(html).toContain("取消单列");
  });

  it("renders pending cuts and incomplete parents", () => {
    const html = renderToStaticMarkup(
      <WorkspaceView
        scope={scope({
          status: "pending",
          sourceRevision: 9,
          warnings: ["projection_missing"],
          incompleteParentRefs: ["task_parent"],
        })}
        projectName="Harness"
        onOpenTask={() => {}}
        onOpenGroup={() => {}}
      />,
    );
    expect(html).toContain("范围数据尚未完整");
    expect(html).toContain("父链不完整：task_parent");
  });

  it("keeps server-scoped pending items and exposes the next page", () => {
    const pendingTask = {
      taskId: "task_pending",
      title: "待签任务",
      canonicalStatus: "active",
      closeoutBlocker: null,
      gates: [{ name: "human", ok: false, status: "missing" }],
      iteration: 1,
      executions: [
        {
          schema: "execution/v1",
          executionId: "execution-1",
          iteration: 1,
          submission: { completionContract: { gates: [{ gateId: "human", witness: { adapterId: "manual-attest" } }] } },
        },
      ],
    } as never;
    const html = renderToStaticMarkup(
      <WorkspaceView
        scope={scope({ memberTaskIds: ["task_pending"], page: { limit: 100, cursor: null, nextCursor: "next" } })}
        projectName="Harness"
        tasks={[pendingTask]}
        onOpenTask={() => {}}
        onOpenGroup={() => {}}
        onAttest={() => {}}
        onLoadMore={() => {}}
      />,
    );
    expect(html).toContain("需要处理 · 1");
    expect(html).toContain("待签任务");
    expect(html).not.toContain("加载更多");
  });

  it("switches to full-width task and relation panels, keeping pagination actionable", () => {
    const host = document.createElement("div"),
      root = createRoot(host);
    let loaded = 0;
    act(() =>
      root.render(
        <WorkspaceView
          scope={scope({ page: { limit: 100, cursor: null, nextCursor: "next" } })}
          projectName="Harness"
          onOpenTask={() => {}}
          onOpenGroup={() => {}}
          onLoadMore={() => loaded++}
        />,
      ),
    );
    act(() => (host.querySelector("#workspace-tab-tasks") as HTMLButtonElement).click());
    expect(host.textContent).toContain("暂无子组");
    expect(host.querySelector('[data-testid="workspace-sidebar"]')).toBeNull();
    act(() => (host.querySelector('[data-testid="workspace-load-more"]') as HTMLButtonElement).click());
    expect(loaded).toBe(1);
    act(() => (host.querySelector("#workspace-tab-relations") as HTMLButtonElement).click());
    expect(host.querySelector(".react-flow")).not.toBeNull();
    expect(host.querySelector('[data-testid="workspace-load-more"]')).toBeNull();
    act(() => root.unmount());
  });

  it("combines task pages and stops on the last page cursor", () => {
    const first = scope({ tasks: [row], page: { limit: 1, cursor: null, nextCursor: "task_root" } });
    const secondRow = { ...row, taskId: "task_second", title: "第二项" };
    const combined = combineWorkspaceScopePages([
      first,
      scope({ tasks: [secondRow], page: { limit: 1, cursor: "task_root", nextCursor: null } }),
    ]);
    expect(combined?.tasks.map(({ taskId }) => taskId)).toEqual(["task_root", "task_second"]);
    expect(combined?.page.nextCursor).toBeNull();
  });
});
