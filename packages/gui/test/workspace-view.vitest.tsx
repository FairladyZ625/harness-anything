// harness-test-tier: fast
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WorkspaceView } from "../src/renderer/views/WorkspaceView.tsx";
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
    expect(html).toContain("暂无子组");
    expect(html).toContain("暂无任务");
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
});
