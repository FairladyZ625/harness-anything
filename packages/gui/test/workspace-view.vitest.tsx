// harness-test-tier: fast
// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { WorkspaceView } from "../src/renderer/views/WorkspaceView.tsx";
import { combineWorkspaceScopePages } from "../src/renderer/workspace-scope-data.ts";
import { harnessClient } from "../src/renderer/api-client.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";
import type { TaskRow } from "../src/renderer/model/types.ts";
import type { WorkspaceScopeRead } from "../src/api/renderer-dto.ts";
import { projectedTaskFields } from "./task-projection-fields.ts";

/**
 * 工作详情页按原型 v2(dec_AF44708E8F70F04E59FF751F9C/CH1):顶部身份 + 状态分段
 * 进度 + 标签栏(概况/任务/进展/决策与事实/检修);概况按「等你裁决 → 没有 agent
 * 在跑 → 按天收束的进展 → 接下来」叙事排列,右栏状态数字与子组树;原始事件流只在
 * 检修页;实体细节进右侧抽屉。
 */

const scopeRow = (taskId: string, patch: Partial<WorkspaceScopeRead["tasks"][number]> = {}) =>
  ({
    taskId,
    title: `T ${taskId}`,
    status: "active",
    taskClass: "implementation",
    parentTaskId: "task_root",
    updatedAt: "2026-09-30T08:00:00.000Z",
    pinned: false,
    hasChildren: false,
    ...patch,
  }) as const;

function scope(overrides: Partial<WorkspaceScopeRead> = {}): WorkspaceScopeRead {
  return {
    schema: "daemon.workspace-scope/v1",
    ok: true,
    status: "ready",
    root: scopeRow("task_root", {
      title: "统一体验",
      taskClass: "work",
      parentTaskId: null,
      status: "active",
      hasChildren: true,
    }),
    ancestors: [],
    goalMaterial: { taskId: "task_root", path: "task_plan.md" },
    counts: { done: 0, executing: 0, pending: 0, blocked: 0, planned: 0, cancelled: 0 },
    scope: { descendantCount: 0, executableLeafCount: 0, archivedCount: 0 },
    groups: [],
    memberTaskIds: [],
    eventSummaries: [],
    eventWindowComplete: true,
    tasks: [],
    page: { limit: 100, cursor: null, nextCursor: null },
    incompleteParentRefs: [],
    watermark: 4,
    sourceRevision: 4,
    warnings: [],
    ...overrides,
  };
}

const row = (taskId: string, patch: Partial<TaskRow> = {}): TaskRow =>
  ({
    taskId,
    title: `T ${taskId}`,
    projectId: "p",
    coordinationStatus: "active",
    rawStatus: "active",
    freshness: "fresh",
    packageDisposition: "active",
    closeoutReadiness: "not_required",
    engine: "local",
    source: "local-document",
    lastKnownAt: "2026-09-30T10:00:00.000Z",
    gates: [],
    docs: [],
    ...projectedTaskFields(patch.coordinationStatus ?? "active"),
    ...patch,
  }) as TaskRow;

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
  vi.restoreAllMocks();
});

async function mount(node: React.ReactNode): Promise<HTMLElement> {
  const host = document.createElement("div"),
    root = createRoot(host);
  document.body.append(host);
  mounted.push(root);
  await act(async () => root.render(<QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>));
  return host;
}

const tab = (host: HTMLElement, key: string) => host.querySelector<HTMLButtonElement>(`#workspace-tab-${key}`)!;

describe("work page header", () => {
  it("renders identity, segmented progress, key numbers and the tab bar with counts", () => {
    const submittedRow = (taskId: string) =>
      row(taskId, { coordinationStatus: "submitted", parentTaskId: "task_root" });
    const html = renderToStaticMarkup(
      <WorkspaceView
        scope={scope({
          counts: { done: 9, executing: 2, pending: 3, blocked: 0, planned: 1, cancelled: 1 },
          scope: { descendantCount: 16, executableLeafCount: 16, archivedCount: 0 },
          memberTaskIds: ["task_w1", "task_w2", "task_w3"],
        })}
        projectName="Harness"
        tasks={[submittedRow("task_w1"), submittedRow("task_w2"), submittedRow("task_w3")]}
        onOpenTask={() => {}}
      />,
    );
    expect(html).toContain("统一体验");
    expect(html).toMatch(/<h1[^>]*>统一体验<\/h1>/u);
    // 分段条按状态构成着色。
    expect(html).toContain('data-segment="done"');
    expect(html).toContain('data-segment="active"');
    // 关键数字:完成 / 可执行叶子。
    expect(html).toContain(">9</b>/16 完成 · 56%");
    // 标签栏五页 + 计数;「N 待你」只在有待裁决时出现。
    expect(html).toContain("概况");
    expect(html).toContain("任务");
    expect(html).toContain("进展");
    expect(html).toContain("决策与事实");
    expect(html).toContain("检修");
    expect(html).toContain("3 待你");
    expect(html).toContain('placeholder="搜本工作的任务…  /"');
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
      />,
    );
    expect(html).toContain("范围数据尚未完整");
    expect(html).toContain("父链不完整：task_parent");
  });

  it("expands the one-line goal from the task plan Brief", async () => {
    const documentSpy = vi.spyOn(harnessClient, "getTaskDocument").mockResolvedValue({
      status: "ready",
      body: "## Brief\n\n让业主一眼看到最急的事。\n\n## Goal\n\n其余内容。",
      worktreeBody: null,
      uncommitted: false,
    } as never);
    const host = await mount(
      <WorkspaceView scope={scope()} repoId="repo" projectName="Harness" onOpenTask={() => {}} />,
    );
    expect(documentSpy).toHaveBeenCalledWith(expect.objectContaining({ taskId: "task_root" }));
    await vi.waitFor(() => expect(host.querySelector('[data-testid="workspace-mission"]')).not.toBeNull());
    const mission = host.querySelector<HTMLDivElement>('[data-testid="workspace-mission"]')!;
    expect(mission.textContent).toContain("让业主一眼看到最急的事。");
    expect(mission.getAttribute("aria-expanded")).toBe("false");
    await act(async () => mission.click());
    expect(mission.getAttribute("aria-expanded")).toBe("true");
  });
});

describe("overview narrative", () => {
  const baseScope = scope({
    counts: { done: 0, executing: 1, pending: 1, blocked: 0, planned: 1, cancelled: 0 },
    scope: { descendantCount: 3, executableLeafCount: 3, archivedCount: 0 },
    memberTaskIds: ["task_wait", "task_solo", "task_next"],
    tasks: [
      scopeRow("task_wait", { status: "submitted" }),
      scopeRow("task_solo"),
      scopeRow("task_next", { status: "planned" }),
    ],
  });

  it("puts submitted cuts in the hero with real adjudication actions", async () => {
    const onAdjudicate = vi.fn(),
      host = await mount(
        <WorkspaceView
          scope={baseScope}
          projectName="Harness"
          tasks={[row("task_wait", { coordinationStatus: "submitted", parentTaskId: "task_root" })]}
          onOpenTask={() => {}}
          onAdjudicate={onAdjudicate}
        />,
      );
    const hero = host.querySelector('[data-testid="work-hero"]')!;
    expect(hero.textContent).toContain("等你裁决");
    expect(hero.textContent).toContain("1");
    expect(hero.textContent).toContain("T task_wait");
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[data-testid="work-hero-forward-task_wait"]')!.click(),
    );
    expect(onAdjudicate).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "task_wait" }),
      "forward",
      expect.any(String),
    );
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="work-hero-return-task_wait"]')!.click());
    expect(onAdjudicate).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "task_wait" }),
      "return",
      expect.any(String),
    );
  });

  it("renders single-action attest rows without crashing and attests on click", async () => {
    // 回归:只有一个动作按钮的行,children 是单元素不是数组(Electron 实测 QA 工作曾崩在 .map)。
    const onAttest = vi.fn(),
      host = await mount(
        <WorkspaceView
          scope={scope({
            memberTaskIds: ["task_gate"],
            tasks: [scopeRow("task_gate", { status: "active" })],
          })}
          projectName="Harness"
          tasks={[
            row("task_gate", {
              gates: [{ name: "human", ok: false, status: "missing" }],
              iteration: 1,
              executions: [
                {
                  schema: "execution/v1",
                  executionId: "execution-1",
                  iteration: 1,
                  submission: {
                    completionContract: { gates: [{ gateId: "human", witness: { adapterId: "manual-attest" } }] },
                  },
                },
              ] as never,
            }),
          ]}
          onOpenTask={() => {}}
          onAttest={onAttest}
        />,
      );
    const hero = host.querySelector('[data-testid="work-hero"]')!;
    expect(hero.textContent).toContain("门禁 human");
    const attest = host.querySelector<HTMLButtonElement>('[data-task-row="task_gate"] button')!;
    expect(attest.textContent).toContain("签注");
    await act(async () => attest.click());
    expect(onAttest).toHaveBeenCalledWith({ taskId: "task_gate" }, "human", "approve");
  });

  it("flags active tasks with no agent running, judged from lease and executions", async () => {
    const host = await mount(
      <WorkspaceView
        scope={baseScope}
        projectName="Harness"
        tasks={[
          row("task_solo", { parentTaskId: "task_root" }),
          row("task_wait", { coordinationStatus: "submitted", parentTaskId: "task_root" }),
          row("task_leased", {
            parentTaskId: "task_root",
            leaseHolder: "person_x",
            lastKnownAt: "2026-09-30T11:00:00.000Z",
          }),
        ]}
        onOpenTask={() => {}}
      />,
    );
    const warn = host.querySelector('[data-testid="work-stalled"]')!;
    expect(warn.textContent).toContain("标着在做，但没有 agent 在跑");
    expect(warn.textContent).toContain("T task_solo");
    expect(warn.textContent).not.toContain("T task_leased");
  });

  it("collapses progress into day digests and lists planned work as pills", async () => {
    const host = await mount(
      <WorkspaceView
        scope={{
          ...baseScope,
          eventSummaries: [
            {
              eventId: "e1",
              schema: "task-event/v1",
              type: "execution_started",
              occurredAt: "2026-09-30T02:05:00.000Z",
              workspaceRevision: 1,
              taskId: "task_solo",
              payload: {},
            },
            {
              eventId: "e2",
              schema: "task-event/v1",
              type: "task_completed",
              occurredAt: "2026-09-30T03:00:00.000Z",
              workspaceRevision: 2,
              taskId: "task_solo",
              payload: {},
            },
          ],
        }}
        projectName="Harness"
        tasks={[row("task_solo"), row("task_next", { coordinationStatus: "planned", pinned: true })]}
        onOpenTask={() => {}}
      />,
    );
    const days = host.querySelectorAll("[data-day]");
    expect(days.length).toBeGreaterThanOrEqual(1);
    expect(host.textContent).toContain("完成 1 个任务");
    // 每个任务一条路径,状态标签用箭头串起。
    expect(host.textContent).toContain("开始");
    expect(host.textContent).toContain("完成");
    const pills = host.querySelector('[data-testid="work-next"]')!;
    expect(pills.textContent).toContain("T task_next");
  });

  it("keeps the rail with clickable status numbers and the subgroup tree", async () => {
    const host = await mount(
      <WorkspaceView
        scope={{
          ...baseScope,
          groups: [scopeRow("task_group", { title: "G 一", hasChildren: true })],
          tasks: [
            scopeRow("task_wait", { status: "submitted" }),
            scopeRow("task_solo", { parentTaskId: "task_group" }),
          ],
        }}
        projectName="Harness"
        tasks={[
          row("task_wait", { coordinationStatus: "submitted" }),
          row("task_solo", { parentTaskId: "task_group" }),
        ]}
        onOpenTask={() => {}}
      />,
    );
    const rail = host.querySelector('[data-testid="workspace-rail"]')!;
    expect(rail.textContent).toContain("状态");
    expect(rail.textContent).toContain("结构");
    // 点状态数字 → 任务页按该状态筛好。
    await act(async () => rail.querySelector<HTMLButtonElement>('[data-status-filter="submitted"]')!.click());
    expect(host.querySelector('[data-testid="workspace-rail"]')).toBeNull();
    expect(tab(host, "tasks").getAttribute("aria-selected")).toBe("true");
    expect(host.textContent).toContain("T task_wait");
    // 点子组 → 任务页只看该组。
    await act(async () => tab(host, "overview").click());
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[data-testid="workspace-rail"] [data-group-filter="task_group"]')!.click(),
    );
    expect(host.textContent).toContain("子组：G 一");
    expect(host.textContent).toContain("T task_solo");
    expect(host.textContent).not.toContain("T task_wait");
  });

  it("opens a task row into the right drawer", async () => {
    const host = await mount(
      <WorkspaceView scope={baseScope} projectName="Harness" tasks={[row("task_solo")]} onOpenTask={() => {}} />,
    );
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[data-testid="work-stalled"] [data-task-row="task_solo"]')!.click(),
    );
    const drawer = host.querySelector('[role="dialog"]')!;
    expect(drawer.textContent).toContain("T task_solo");
  });
});

describe("tasks tab", () => {
  const groupScope = scope({
    counts: { done: 2, executing: 1, pending: 0, blocked: 0, planned: 1, cancelled: 0 },
    scope: { descendantCount: 4, executableLeafCount: 4, archivedCount: 0 },
    memberTaskIds: ["task_live", "task_d1", "task_d2", "task_p"],
    groups: [scopeRow("task_group", { title: "G 一", hasChildren: true })],
    tasks: [
      scopeRow("task_live", { parentTaskId: "task_group" }),
      scopeRow("task_d1", { parentTaskId: "task_group", status: "done" }),
      scopeRow("task_d2", { parentTaskId: "task_group", status: "done" }),
      scopeRow("task_p", { status: "planned" }),
    ],
    page: { limit: 100, cursor: null, nextCursor: "task_p" },
  });

  async function openTasks(extra: Record<string, unknown> = {}) {
    const host = await mount(
      <WorkspaceView
        scope={groupScope}
        projectName="Harness"
        tasks={[
          row("task_live"),
          row("task_d1", { coordinationStatus: "done" }),
          row("task_d2", { coordinationStatus: "done" }),
          row("task_p", { coordinationStatus: "planned" }),
        ]}
        onOpenTask={() => {}}
        {...extra}
      />,
    );
    await act(async () => tab(host, "tasks").click());
    return host;
  }

  it("shows filter chips with counts and groups by subgroup, collapsing finished work", async () => {
    const host = await openTasks();
    // FilterChips 的计数:全部 4,活跃 1,计划中 1,已完成 2。
    const chipTexts = [...host.querySelectorAll("button[aria-pressed]")].map((chip) => chip.textContent);
    expect(chipTexts.join("|")).toContain("全部4");
    expect(chipTexts.join("|")).toContain("活跃1");
    expect(chipTexts.join("|")).toContain("已完成2");
    // 有未完成的组默认展开且只列未完成项;已完成收成一行。
    const group = host.querySelector('[data-group="task_group"]')!;
    expect(group.textContent).toContain("T task_live");
    expect(group.querySelector('[data-task-row="task_d1"]')).toBeNull();
    expect(group.textContent).toContain("已完成 / 取消 2 个 · 展开");
    // 零散任务组同样在列。
    expect(host.querySelector('[data-group="_loose"]')!.textContent).toContain("T task_p");
    // 每行的相对时间来自行的 at 字段,不能是 NaN。
    const row = host.querySelector('[data-task-row="task_live"]')!;
    expect(row.textContent).not.toContain("NaN");
    expect(row.textContent).toMatch(/\d+ (分钟|小时|天)/u);
  });

  it("expands a finished group on demand and exposes the next page", async () => {
    let loaded = 0;
    const host = await openTasks({ onLoadMore: () => loaded++ });
    await act(async () => host.querySelector<HTMLButtonElement>('[data-group-done-toggle="task_group"]')!.click());
    expect(host.querySelector('[data-group="task_group"]')!.querySelector('[data-task-row="task_d1"]')).not.toBeNull();
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="workspace-load-more"]')!.click());
    expect(loaded).toBe(1);
  });

  it("filters by search and switches to the tasks tab on input", async () => {
    const host = await mount(
      <WorkspaceView
        scope={groupScope}
        projectName="Harness"
        tasks={[row("task_live"), row("task_p", { coordinationStatus: "planned" })]}
        onOpenTask={() => {}}
      />,
    );
    const search = host.querySelector<HTMLInputElement>('[data-testid="workspace-search"]')!;
    expect(tab(host, "tasks").getAttribute("aria-selected")).toBe("false");
    await act(async () => {
      search.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "live");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(tab(host, "tasks").getAttribute("aria-selected")).toBe("true");
    expect(host.textContent).toContain("T task_live");
    expect(host.querySelector('[data-task-row="task_p"]')).toBeNull();
    // 命中片段高亮。
    expect(host.querySelector("[data-search-hit]")?.textContent).toBe("live");
  });

  it("focuses the page search on /", async () => {
    const host = await mount(<WorkspaceView scope={groupScope} projectName="Harness" onOpenTask={() => {}} />);
    const search = host.querySelector<HTMLInputElement>('[data-testid="workspace-search"]')!;
    expect(search).not.toBe(document.activeElement);
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "/" }));
    });
    expect(search).toBe(document.activeElement);
  });
});

describe("page assembly", () => {
  it("combines task pages and stops on the last page cursor", () => {
    const first = scope({ tasks: [scopeRow("task_root")], page: { limit: 1, cursor: null, nextCursor: "task_root" } }),
      combined = combineWorkspaceScopePages([
        first,
        scope({ tasks: [scopeRow("task_second")], page: { limit: 1, cursor: "task_root", nextCursor: null } }),
      ]);
    expect(combined?.tasks.map(({ taskId }) => taskId)).toEqual(["task_root", "task_second"]);
    expect(combined?.page.nextCursor).toBeNull();
  });
});
