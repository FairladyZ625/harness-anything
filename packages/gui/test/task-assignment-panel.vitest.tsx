// harness-test-tier: fast
// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TaskAssignmentPanel } from "../src/renderer/components/taskDetail/TaskAssignmentPanel.tsx";
import { harnessClient } from "../src/renderer/api-client.ts";
import type { TaskRow } from "../src/renderer/model/types.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";
import { projectedTaskFields } from "./task-projection-fields.ts";

/**
 * 指派面板的就地执行字段(task_1bafbf09 返工):普通 viewer 不读全 realm 指派目录
 * 也能从任务快照的结构字段看到当前持有人/节点/期限;资格与租约独立说明。
 */

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  setActiveLocale("zh-CN");
});

const makeTask = (overrides: Partial<TaskRow> = {}): TaskRow => ({
  taskId: "task-panel",
  title: "Panel task",
  projectId: "p",
  coordinationStatus: "active",
  rawStatus: "active",
  freshness: "fresh",
  packageDisposition: "active",
  closeoutReadiness: "not_required",
  engine: "local",
  source: "local-document",
  lastKnownAt: "2026-07-09T00:00:00.000Z",
  gates: [],
  docs: [],
  ...projectedTaskFields("active", { archived: false }),
  ...overrides,
});

function mountPanel(task: TaskRow, withNavigation = true) {
  const directory = vi.spyOn(harnessClient, "getTaskAssignmentDirectory").mockResolvedValue({
    schema: "task-assignment-directory/v1",
    people: [],
    nodes: [],
    teams: [],
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const host = document.createElement("div");
  const root = createRoot(host);
  const navigated: string[] = [];
  act(() =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <TaskAssignmentPanel
          task={task}
          {...(withNavigation
            ? {
                onNavigateEntity: (ref: string) => {
                  navigated.push(ref);
                },
              }
            : {})}
        />
      </QueryClientProvider>,
    ),
  );
  return {
    host,
    root,
    navigated,
    directory,
    text: () => host.textContent ?? "",
  };
}

describe("TaskAssignmentPanel 当前执行(就地字段)", () => {
  it("结构字段直读:持有人、会话跳转、来源节点、phase 与期限;资格与租约独立说明", () => {
    const view = mountPanel(
      makeTask({
        assignment: {
          assignee: { kind: "person", personId: "person_ada" },
          expiresAt: "2026-10-02T00:00:00.000Z",
        },
        leaseActor: {
          principal: { personId: "person_bo" },
          executor: { kind: "agent", id: "runtime-session:runtime_cafe1234" },
        },
        leaseSource: { kind: "node", nodeId: "edge-mac" },
        leasePhase: "held",
        leaseExpiresAt: "2026-10-05T00:00:00.000Z",
      }),
    );
    const holder = view.host.querySelector('[data-testid="task-assignment-holder"]')!;
    expect(holder.textContent).toContain("person_bo");
    expect(holder.textContent).toContain("edge-mac");
    expect(holder.textContent).toContain("held");
    expect(holder.textContent).toContain("10-05");
    // 独立性说明:资格到期不构成可抢
    expect(view.text()).toContain("不打断已持有的租约");
    // 会话跳转走实体出口
    const sessionLink = holder.querySelector<HTMLButtonElement>('button[title*="runtime_cafe1234"]');
    expect(sessionLink).not.toBeNull();
    act(() => sessionLink!.click());
    expect(view.navigated).toEqual(["session/runtime_cafe1234"]);
    view.directory.mockRestore();
    act(() => view.root.unmount());
  });

  it("无租约显示空态;没有导航出口时执行会话仍可见(IdText,不给链接)", () => {
    const idle = mountPanel(
      makeTask({
        assignment: { assignee: { kind: "person", personId: "person_ada" }, expiresAt: "2026-10-02T00:00:00.000Z" },
      }),
    );
    expect(idle.host.querySelector('[data-testid="task-assignment-holder"]')!.textContent).toContain("无人持有租约");
    idle.directory.mockRestore();
    act(() => idle.root.unmount());

    const noNav = mountPanel(
      makeTask({
        leaseActor: {
          principal: { personId: "person_bo" },
          executor: { kind: "agent", id: "runtime-session:runtime_dead" },
        },
        leaseSource: { kind: "node", nodeId: "edge-n" },
        leasePhase: "orphaned",
      }),
      false,
    );
    const holder = noNav.host.querySelector('[data-testid="task-assignment-holder"]')!;
    expect(holder.textContent).toContain("runtime_dead");
    expect(holder.querySelector("button")).toBeNull();
    expect(holder.textContent).toContain("orphaned");
    noNav.directory.mockRestore();
    act(() => noNav.root.unmount());
  });
});
