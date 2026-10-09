// harness-test-tier: fast
// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AppMotionConfig, MOTION_PREFERENCE_STORAGE_KEY } from "../src/renderer/motion-config.tsx";
import { PageEntryBoundary } from "../src/renderer/components/primitives/EntryBoundary.tsx";
import { WorkspaceView } from "../src/renderer/views/WorkspaceView.tsx";
import { combineWorkspaceScopePages } from "../src/renderer/workspace-scope-data.ts";
import { harnessClient } from "../src/renderer/api-client.ts";
import { readSplitPreferences } from "../src/renderer/split-layout-preferences.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";
import type { TaskRow } from "../src/renderer/model/types.ts";
import type { WorkspaceScopeRead } from "../src/api/renderer-dto.ts";
import { projectedTaskFields } from "./task-projection-fields.ts";

// 只有 EntryBoundary 直接 import "motion";替身让入场动效可观察、不依赖 happy-dom 动画。
const motionProbe = vi.hoisted(() => ({ animate: vi.fn(() => ({ complete: vi.fn() })) }));
vi.mock("motion", async (original) => ({
  ...(await original<typeof import("motion")>()),
  animate: motionProbe.animate,
}));

/**
 * 工作详情页按原型 v2(dec_AF44708E8F70F04E59FF751F9C/CH1):顶部身份 + 状态分段
 * 进度 + 标签栏(概况/任务/进展/决策与事实/检修);概况是区域板(标准 §2.1):左侧
 * 主区「等你裁决 → 阻塞与异常 → 进行中 → 接下来 → 结构与统计」各一个区域框,右列是
 * 按天收束的时间线区域;原始事件流只在检修页;实体细节进右侧抽屉。
 */

const SPLIT_STORAGE_KEY = "harness:gui:split-layout";

// React Query defaults observer notifications to a zero-delay timer. Keep this fast-tier test on
// discrete microtasks so query completion and the corresponding render can be awaited without sleeps.
notifyManager.setScheduler(queueMicrotask);

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
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function mount(node: React.ReactNode): Promise<HTMLElement> {
  // 概况内嵌的工作说明文档要读根任务清单:未打桩的清单会在 happy-dom 里走真实传输而
  // 挂起/报错。这里给一个「无 explainer」的默认清单,个案自行覆盖。
  if (!vi.isMockFunction(harnessClient.getTaskDocuments)) {
    vi.spyOn(harnessClient, "getTaskDocuments").mockResolvedValue({
      ok: true,
      status: "ready",
      taskId: "task_root",
      documents: [],
      watermark: 7,
      sourceRevision: 7,
    } as never);
  }
  const host = document.createElement("div"),
    root = createRoot(host);
  document.body.append(host);
  mounted.push(root);
  // retry:false 让失败桩立即定案(与 task-detail fixtures 同一取舍),不进指数退避。
  await act(async () =>
    root.render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        {node}
      </QueryClientProvider>,
    ),
  );
  await settle();
  return host;
}

/** 等异步查询与落点定案走完，不用墙钟定时器。 */
async function settle() {
  for (let index = 0; index < 6; index += 1) await act(async () => Promise.resolve());
}

const tab = (host: HTMLElement, key: string) => host.querySelector<HTMLButtonElement>(`#workspace-tab-${key}`)!;

describe("work page header", () => {
  it("renders identity, segmented progress, key numbers and the tab bar with counts", () => {
    const submittedRow = (taskId: string) =>
      row(taskId, { coordinationStatus: "submitted", parentTaskId: "task_root" });
    const html = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <WorkspaceView
          scope={scope({
            counts: { done: 9, executing: 2, pending: 3, blocked: 0, planned: 1, cancelled: 1 },
            scope: { descendantCount: 16, executableLeafCount: 16, archivedCount: 0 },
            memberTaskIds: ["task_w1", "task_w2", "task_w3"],
          })}
          projectName="Harness"
          tasks={[submittedRow("task_w1"), submittedRow("task_w2"), submittedRow("task_w3")]}
          onOpenTask={() => {}}
        />
      </QueryClientProvider>,
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

  it("offers a pin toggle for the work itself next to the title", async () => {
    const setPin = vi.fn();
    const host = await mount(
      <WorkspaceView
        scope={scope()}
        projectName="Harness"
        tasks={[row("task_root", { pinned: false })]}
        onOpenTask={() => {}}
        onSetTaskPin={setPin}
      />,
    );
    const toggle = host.querySelector<HTMLButtonElement>('[data-testid="workspace-root-pin"]');
    // 三行化(chrome S4):置顶收成图标钮(PinButton compact),可访问名进 aria-label。
    expect(toggle?.getAttribute("aria-label")).toContain("置顶");
    await act(async () => toggle!.click());
    expect(setPin).toHaveBeenCalledWith(expect.objectContaining({ taskId: "task_root" }), true);
  });

  it("renders pending cuts and incomplete parents", () => {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <WorkspaceView
          scope={scope({
            status: "pending",
            sourceRevision: 9,
            warnings: ["projection_missing"],
            incompleteParentRefs: ["task_parent"],
          })}
          projectName="Harness"
          onOpenTask={() => {}}
        />
      </QueryClientProvider>,
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
    const warn = host.querySelector('[data-testid="work-stuck"]')!;
    expect(warn.textContent).toContain("阻塞与异常");
    expect(warn.textContent).toContain("无 agent 1");
    expect(warn.textContent).toContain("标着在做，但没有 agent 在跑");
    expect(warn.textContent).toContain("T task_solo");
    expect(warn.textContent).not.toContain("T task_leased");
  });

  it("puts every block of the overview in a region frame, with a movable timeline in its own default column", async () => {
    const host = await mount(
      <WorkspaceView
        scope={{
          ...baseScope,
          memberTaskIds: [...baseScope.memberTaskIds, "task_run", "task_blocked"],
          eventSummaries: [
            {
              eventId: "e1",
              schema: "task-event/v1",
              type: "execution_started",
              occurredAt: "2026-09-30T02:05:00.000Z",
              workspaceRevision: 1,
              taskId: "task_run",
              payload: {},
            },
          ],
        }}
        projectName="Harness"
        tasks={[
          row("task_wait", { coordinationStatus: "submitted" }),
          row("task_solo"),
          row("task_run", { leaseHolder: "person_x" }),
          row("task_blocked", {
            coordinationStatus: "blocked",
            blockers: [
              { relationId: "rel_1", kind: "depends-on", sourceTaskId: "task_blocked", targetTaskId: "task_run" },
            ],
          }),
          row("task_next", { coordinationStatus: "planned" }),
        ]}
        onOpenTask={() => {}}
      />,
    );
    const board = host.querySelector('[data-testid="work-overview-board"]')!;
    // 区域集合与固定顺序;每个区域都是 Region 原语(玻璃面板 + 区内滚动的行体)。
    const regions = [...board.querySelectorAll<HTMLElement>("[data-region]")];
    expect(regions.map((region) => region.dataset.region)).toEqual([
      "mine",
      "stuck",
      "run",
      "next",
      "structure",
      "explainer",
      "recent",
    ]);
    for (const region of regions) {
      const section = region.querySelector(":scope > section[data-entry-region]")!;
      expect(section.querySelector("h2")).not.toBeNull();
      expect(section.children[1]!.firstElementChild!.className).toContain("overflow-y-auto");
    }
    // 没有散排:板上的标题、行、按天进展都在某个区域框里。
    for (const element of board.querySelectorAll("h2, h3, [data-task-row], [data-day], [data-group-filter]"))
      expect(element.closest("section[data-entry-region]")).not.toBeNull();
    // 时间线是板上独立区域(dockview 列),不混在主区里。
    const timeline = host.querySelector('[data-testid="work-timeline"]')!;
    expect(timeline.closest('[data-testid="work-overview-board"]')).not.toBeNull();
    expect(timeline.closest('[data-testid="work-overview-main"]')).toBeNull();
    expect(timeline.querySelectorAll("[data-day]")).toHaveLength(1);
    // 阻塞的任务进「阻塞与异常」并报卡点;有 agent 在跑的进「进行中」并报执行者。
    const stuck = host.querySelector('[data-testid="work-stuck"]')!;
    expect(stuck.querySelector('[data-task-row="task_blocked"]')!.textContent).toContain("被「T task_run」卡住");
    expect(stuck.querySelector('[data-task-row="task_run"]')).toBeNull();
    const running = host.querySelector('[data-testid="work-running"]')!;
    expect(running.querySelector('[data-task-row="task_run"]')!.textContent).toContain("执行者 person_x");
    expect(running.querySelector('[data-task-row="task_solo"]')).toBeNull();
  });

  /** 一条最小事件,喂给「最近进展」时间线让它落位。 */
  const eventSummary = (taskId: string) => ({
    eventId: `e-${taskId}`,
    schema: "task-event/v1",
    type: "execution_started",
    occurredAt: "2026-09-30T02:05:00.000Z",
    workspaceRevision: 1,
    taskId,
    payload: {},
  });

  // 停靠分屏(task_033760e2…):把手拖到另一区域的边缘半区,方向键停靠;布局按连接+仓记忆。
  it("docks the timeline region by handle drag and keyboard, then undoes and resets", async () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(804);
    const host = await mount(
      <WorkspaceView
        scope={{ ...baseScope, eventSummaries: [eventSummary("task_solo")] }}
        repoId="repo"
        connectionId="local"
        projectName="Harness"
        tasks={[row("task_wait", { coordinationStatus: "submitted", parentTaskId: "task_root" })]}
        onOpenTask={() => {}}
      />,
    );
    const board = host.querySelector<HTMLElement>('[data-testid="work-overview-board"]')!;
    const region = (id: string) => board.querySelector<HTMLElement>(`[data-region="${id}"]`)!;
    const handle = (id: string) => board.querySelector<HTMLElement>(`[data-testid="region-handle-${id}"]`)!;
    const defaultOrder = [...board.querySelectorAll<HTMLElement>("[data-region]")].map((node) => node.dataset.region);

    // 拖时间线到「我的工作」的右半区(零几何默认右半区):放下成左右分割,遮罩消失。
    await act(async () => {
      handle("recent").dispatchEvent(new Event("dragstart", { bubbles: true }));
      region("mine").dispatchEvent(
        new MouseEvent("dragover", { clientX: 0, clientY: 0, bubbles: true, cancelable: true }),
      );
    });
    expect(region("mine").dataset.zone).toBe("right");
    await act(async () => {
      region("mine").dispatchEvent(new MouseEvent("drop", { clientX: 0, clientY: 0, bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(region("mine").dataset.zone).toBeUndefined();
    // 布局快照按真实键 work-overview 落盘;区域集合不变。
    const stored = readSplitPreferences(localStorage, "local", "repo")["work-overview"];
    expect(stored).toBeDefined();
    const flatOrder = (node: unknown, into: string[] = []): string[] => {
      const record = node as { type?: string; data?: unknown };
      if (record?.type === "branch") for (const child of (record.data as unknown[]) ?? []) flatOrder(child, into);
      else {
        const view = (record?.data as { views?: string[] })?.views?.[0];
        if (view !== undefined) into.push(view);
      }
      return into;
    };
    expect(flatOrder((stored!.snapshot as { grid?: { root?: unknown } }).grid?.root).sort()).toEqual(
      [...defaultOrder].sort(),
    );
    // 时间线区域仍在板上,正文行与把手不丢。
    expect(region("recent").querySelector('[data-testid="region-handle-recent"]')).not.toBeNull();

    // 撤销上一步停靠:时间线回到独立列。
    await act(async () => {
      board.querySelector<HTMLButtonElement>('[data-testid="work-overview-board-controls-undo"]')!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const undone = flatOrder(
      (readSplitPreferences(localStorage, "local", "repo")["work-overview"]!.snapshot as { grid?: { root?: unknown } })
        .grid?.root,
    );
    expect(undone.indexOf("recent")).toBeGreaterThan(undone.indexOf("structure"));

    // 重置:默认布局回来,本页槽位清空(重置会换 key 重挂,重查板节点)。
    await act(async () => {
      board.querySelector<HTMLButtonElement>('[data-testid="work-overview-board-controls-reset"]')!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(readSplitPreferences(localStorage, "local", "repo")["work-overview"]).toBeUndefined();
    const rebuilt = host.querySelector<HTMLElement>('[data-testid="work-overview-board"]')!;
    await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));
    expect([...rebuilt.querySelectorAll("[data-region]")].map((node) => (node as HTMLElement).dataset.region)).toEqual(
      defaultOrder,
    );
  });

  // task_fb3ba20d66…(返工):分割偏好按连接+仓隔离。App 传的是 system status 仓行的
  // connectionId;同 repoId 的两个连接(如 remote-proxy 改挂)读写/重置互不串用。
  it("addresses overview docking preferences by the live connection so same-repo connections stay isolated", async () => {
    localStorage.removeItem(SPLIT_STORAGE_KEY);
    const mountOverview = (connectionId: string) =>
      mount(
        <WorkspaceView
          scope={{ ...baseScope, eventSummaries: [eventSummary("task_solo")] }}
          repoId="repo"
          connectionId={connectionId}
          projectName="Harness"
          tasks={[row("task_wait", { coordinationStatus: "submitted", parentTaskId: "task_root" })]}
          onOpenTask={() => {}}
        />,
      );
    const dockTimeline = async (host: HTMLElement) => {
      const board = host.querySelector<HTMLElement>('[data-testid="work-overview-board"]')!;
      const recent = board.querySelector<HTMLElement>('[data-region="recent"]')!;
      await act(async () => {
        board
          .querySelector<HTMLElement>('[data-testid="region-handle-recent"]')!
          .dispatchEvent(new Event("dragstart", { bubbles: true }));
        board
          .querySelector<HTMLElement>('[data-region="mine"]')!
          .dispatchEvent(new MouseEvent("dragover", { clientX: 0, clientY: 0, bubbles: true, cancelable: true }));
        board
          .querySelector<HTMLElement>('[data-region="mine"]')!
          .dispatchEvent(new MouseEvent("drop", { clientX: 0, clientY: 0, bubbles: true, cancelable: true }));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(recent).not.toBeNull();
    };
    const remote = await mountOverview("remote-abc123def456");
    await dockTimeline(remote);
    expect(readSplitPreferences(localStorage, "remote-abc123def456", "repo")["work-overview"]).toBeDefined();
    // 重挂同一连接:停靠布局从快照恢复(快照等区域集稳定后去抖应用,等它落地)。
    const reloaded = await mountOverview("remote-abc123def456");
    await act(async () => {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (reloaded.querySelector("[data-region]") !== null) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    });
    const regionsAfterReload = [...reloaded.querySelectorAll<HTMLElement>("[data-region]")].map(
      (n) => n.dataset.region,
    );
    expect(regionsAfterReload).toContain("recent");
    // 同 repoId 换连接:不沿用上一连接的停靠,后续写动也不覆盖它。
    const local = await mountOverview("local");
    await dockTimeline(local);
    expect(readSplitPreferences(localStorage, "local", "repo")["work-overview"]).toBeDefined();
    expect(readSplitPreferences(localStorage, "remote-abc123def456", "repo")["work-overview"]).toBeDefined();
    // 重置只清当前连接的槽。
    await act(async () => {
      local.querySelector<HTMLButtonElement>('[data-testid="work-overview-board-controls-reset"]')!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(readSplitPreferences(localStorage, "local", "repo")).toEqual({});
    expect(readSplitPreferences(localStorage, "remote-abc123def456", "repo")["work-overview"]).toBeDefined();
    localStorage.removeItem(SPLIT_STORAGE_KEY);
  });

  it("drops empty regions instead of leaving empty frames", async () => {
    const host = await mount(<WorkspaceView scope={scope()} projectName="Harness" onOpenTask={() => {}} />);
    const keys = [...host.querySelectorAll<HTMLElement>("[data-region]")].map((region) => region.dataset.region);
    // 工作说明区域是「该有而无」的空态(未选仓库),不是可丢的空框,常驻。
    expect(keys).toEqual(["structure", "explainer"]);
  });

  it("collapses progress into day digests and lists planned work as two-line rows", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-01T10:00:00.000Z"));
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
    // 「接下来」是区域里的两行条目(不是会溢出的标签串);全是待开工,不重复挂状态标签。
    const next = host.querySelector('[data-testid="work-next"] [data-task-row="task_next"] .grid')!;
    expect(next.className).toContain("min-h-14");
    expect(next.textContent).toContain("T task_next");
    expect(next.textContent).toContain("最后活动 1 天前");
    expect(next.textContent).not.toContain("计划中");
  });

  it("lays out every progress day on the overview (no first-2-days cap) and shows the executor on a second line", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-01T10:00:00.000Z"));
    // v2(标准 §1.8):概况的按天进展全部天直接铺开,不截前两天。
    const day = (index: number) => [
      {
        eventId: `d${index}-1`,
        schema: "task-event/v1",
        type: "execution_started",
        occurredAt: `2026-09-2${index}T02:00:00.000Z`,
        workspaceRevision: index * 2,
        taskId: "task_solo",
        payload: {},
      },
    ];
    const host = await mount(
      <WorkspaceView
        scope={{
          ...baseScope,
          memberTaskIds: [...baseScope.memberTaskIds, "task_exec"],
          eventSummaries: [...day(6), ...day(7), ...day(8)],
        }}
        projectName="Harness"
        tasks={[row("task_solo"), row("task_exec", { leaseHolder: "person_x" })]}
        onOpenTask={() => {}}
      />,
    );
    expect(host.querySelectorAll("[data-day]")).toHaveLength(3);
    // 任务页里每条都是宽松两行(§2.4):有执行者的第二行报执行者,没有的只报最近活动。
    await act(async () => host.querySelector<HTMLButtonElement>("#workspace-tab-tasks")!.click());
    const execRow = host.querySelector('[data-task-row="task_exec"] .grid')!;
    expect(execRow.className).toContain("min-h-14");
    expect(execRow.textContent).toContain("执行者 person_x");
    const soloRow = host.querySelector('[data-task-row="task_solo"] .grid')!;
    expect(soloRow.className).toContain("min-h-14");
    expect(soloRow.textContent).toContain("最后活动 1 天前");
    expect(soloRow.textContent).not.toContain("执行者");
  });

  it("renders every task entry as two lines: status + pre-colon title, then executor · blocker · last activity · supplement", async () => {
    const lines = (host: HTMLElement, taskId: string) => {
      const grid = host.querySelector(`[data-task-row="${taskId}"] .grid`)!;
      return {
        grid,
        first: grid.querySelector("span.block.truncate.text-text")!.textContent,
        second: grid.querySelector("span.block.text-text-faint")!.textContent,
      };
    };
    const host = await mount(
      <WorkspaceView
        scope={{ ...baseScope, memberTaskIds: [...baseScope.memberTaskIds, "task_await", "task_dep"] }}
        projectName="Harness"
        tasks={[
          row("task_solo", {
            title: "收口链路缺口：兄弟任务解决后第二条卡在 declare-executor",
            leaseHolder: "person_x",
          }),
          row("task_await", {
            blockers: [
              {
                relationId: "rel_1",
                kind: "awaits",
                sourceTaskId: "task_await",
                personId: "zeyu",
                askKind: "question",
                question: "两行里放不放长描述",
              },
            ],
          }),
          row("task_dep", {
            blockers: [
              { relationId: "rel_2", kind: "depends-on", sourceTaskId: "task_dep", targetTaskId: "task_solo" },
              { relationId: "rel_3", kind: "depends-on", sourceTaskId: "task_dep", targetTaskId: "task_await" },
            ],
          }),
        ]}
        onOpenTask={() => {}}
      />,
    );
    await act(async () => tab(host, "tasks").click());
    // 第一行只有状态与冒号前的标题;冒号后的长描述退到第二行末尾。
    const solo = lines(host, "task_solo");
    expect(solo.grid.className).toContain("min-h-14");
    expect(solo.first).toBe("收口链路缺口");
    expect(solo.second).toMatch(
      /^执行者 person_x · 最后活动 \d+ (分钟|小时|天)前 · 兄弟任务解决后第二条卡在 declare-executor$/u,
    );
    // 等待原因:awaits 边报等谁、问了什么;depends-on 边报被哪个任务卡住,其余条数带上。
    expect(lines(host, "task_await").second).toContain("等 zeyu 答复：两行里放不放长描述");
    expect(lines(host, "task_dep").second).toContain("被「收口链路缺口」卡住 等 1 项");
  });

  it("renders overview action entries as two lines with the reason on the faint second line", async () => {
    const host = await mount(
      <WorkspaceView
        scope={baseScope}
        projectName="Harness"
        tasks={[row("task_solo", { title: "停滞任务标题：补充说明" })]}
        onOpenTask={() => {}}
      />,
    );
    const grid = host.querySelector('[data-testid="work-stuck"] [data-task-row="task_solo"] .grid')!;
    expect(grid.className).toContain("min-h-14");
    expect(grid.querySelector("span.block.truncate.text-text")!.textContent).toBe("停滞任务标题");
    expect(grid.querySelector("span.block.text-text-faint")!.textContent).toMatch(
      /最后活动 \d+ (分钟|小时|天)前 · 补充说明$/u,
    );
  });

  it("keeps clickable status numbers and the subgroup tree in the structure region", async () => {
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
    const rail = host.querySelector('[data-testid="work-structure"]')!;
    expect(rail.textContent).toContain("结构与统计");
    // 状态标签完整换行显示:不用省略号截断,列宽预留整词换行(验收:标签必须完整可读)。
    const labels = [...rail.querySelectorAll<HTMLSpanElement>("[data-status-filter] > span")];
    expect(labels.length).toBeGreaterThan(0);
    for (const label of labels) {
      expect(label.className).not.toContain("truncate");
      expect(label.className).toContain("break-words");
    }
    expect(labels[0]!.closest("div")!.className).toContain("minmax(6rem,1fr)");
    expect(rail.querySelector('[data-status-filter="submitted"]')!.textContent).toContain("待初审");
    expect(rail.querySelector('[data-status-filter="submitted"] > span')!.textContent).toContain("Submitted");
    // 点状态数字 → 任务页按该状态筛好。
    await act(async () => rail.querySelector<HTMLButtonElement>('[data-status-filter="submitted"]')!.click());
    expect(host.querySelector('[data-testid="work-structure"]')).toBeNull();
    expect(tab(host, "tasks").getAttribute("aria-selected")).toBe("true");
    expect(host.textContent).toContain("T task_wait");
    // 点子组 → 任务页只看该组。
    await act(async () => tab(host, "overview").click());
    await act(async () =>
      host
        .querySelector<HTMLButtonElement>('[data-testid="work-structure"] [data-group-filter="task_group"] button')!
        .click(),
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
      host.querySelector<HTMLButtonElement>('[data-testid="work-stuck"] [data-task-row="task_solo"] button')!.click(),
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

  it("shows filter chips with counts and groups by subgroup; done work sinks behind a divider", async () => {
    const host = await openTasks();
    // FilterChips 的计数:全部 4,活跃 1,计划中 1,已完成 2。
    const chipTexts = [...host.querySelectorAll("button[aria-pressed]")].map((chip) => chip.textContent);
    expect(chipTexts.join("|")).toContain("全部4");
    expect(chipTexts.join("|")).toContain("活跃1");
    expect(chipTexts.join("|")).toContain("已完成2");
    // v2(标准 §1.4):有未完成的组默认展开;已完成项沉到「已完成 N」分隔线之后照常显示。
    const group = host.querySelector('[data-group="task_group"]')!;
    expect(group.textContent).toContain("T task_live");
    expect(group.querySelector('[data-task-row="task_d1"]')).not.toBeNull();
    expect(group.textContent).toContain("已完成 / 取消 2 个");
    expect(group.querySelector('[data-testid="completed-divider"]')).not.toBeNull();
    // 零散任务组同样在列。
    expect(host.querySelector('[data-group="_loose"]')!.textContent).toContain("T task_p");
    // 每行的相对时间来自行的 at 字段,不能是 NaN。
    const row = host.querySelector('[data-task-row="task_live"]')!;
    expect(row.textContent).not.toContain("NaN");
    expect(row.textContent).toMatch(/\d+ (分钟|小时|天)/u);
  });

  it("exposes the next page after the full task list", async () => {
    let loaded = 0;
    const host = await openTasks({ onLoadMore: () => loaded++ });
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

describe("work explainer tab and overview preview", () => {
  const EXPLAINER_PATH = "artifacts/explainer.html";
  const DATA_URL_PREFIX = "data:text/html;charset=utf-8,";

  const listWith = (explainer: boolean) => ({
    ok: true,
    status: "ready" as const,
    taskId: "task_root",
    documents: [
      { path: "task_plan.md", blobSha256: "d".repeat(64), size: 20, mediaType: "text/markdown", uncommitted: false },
      ...(explainer
        ? [
            {
              path: EXPLAINER_PATH,
              blobSha256: "1".repeat(64),
              size: 60,
              mediaType: "text/html",
              uncommitted: false,
            },
          ]
        : []),
    ],
    watermark: 7,
    sourceRevision: 7,
  });

  /** 根任务文档读桩:explainer 正文带 taskId,用来证明两入口同源、切工作不串内容。 */
  function installDocuments({ explainer = true }: { readonly explainer?: boolean } = {}) {
    vi.spyOn(harnessClient, "getTaskDocuments").mockImplementation(
      async ({ taskId }: { taskId: string }) => ({ ...listWith(explainer), taskId }) as never,
    );
    vi.spyOn(harnessClient, "getTaskDocument").mockImplementation(
      async ({ taskId, path }: { taskId: string; path: string }) =>
        ({
          ok: true,
          status: "ready",
          taskId,
          path,
          body: path === EXPLAINER_PATH ? `<h1>living ${taskId}</h1>` : "# plan",
          blobSha256: `sha256:${"d".repeat(64)}`,
          contentKind: "text",
          mediaType: "text/html",
          size: 60,
          bytes: null,
          repositoryPath: `harness/tasks/${taskId}/${path}`,
          worktreeBody: null,
          uncommitted: false,
          watermark: 7,
          sourceRevision: 7,
        }) as never,
    );
  }

  const webviewSrc = (host: HTMLElement) => {
    const src = host.querySelector<HTMLElement>('[data-testid="html-artifact-webview"]')?.getAttribute("src");
    return src === undefined || src === null ? null : decodeURIComponent(src.slice(DATA_URL_PREFIX.length));
  };
  const explainerState = (host: HTMLElement) =>
    host.querySelector<HTMLElement>('[data-testid="work-explainer-document"]')?.getAttribute("data-state") ?? null;
  const scopeWithRoot = (rootId: string) =>
    scope({
      root: scopeRow(rootId, {
        title: "统一体验",
        taskClass: "work",
        parentTaskId: null,
        status: "active",
        hasChildren: true,
      }),
    });

  it("lands on the overview with the explainer embedded when the root task package has one", async () => {
    installDocuments();
    const host = await mount(
      <WorkspaceView scope={scope()} repoId="repo" projectName="Harness" onOpenTask={() => {}} />,
    );
    // 首次进入默认选中概况(不再异步跳去工作说明),有 explainer 也不例外。
    expect(tab(host, "overview").getAttribute("aria-selected")).toBe("true");
    expect(host.querySelector('[data-testid="work-overview-board"]')).not.toBeNull();
    // 概况直接内嵌该根工作的 explainer 正文,不是只有入口按钮。
    const webview = host.querySelector<HTMLElement>('[data-testid="html-artifact-webview"]');
    expect(webview?.getAttribute("data-artifact-path")).toBe(EXPLAINER_PATH);
    expect(webviewSrc(host)).toContain("<h1>living task_root</h1>");
    // 隔离策略原样搬运:独立 partition、禁脚本,概况内嵌不放宽安全边界。
    expect(webview?.getAttribute("partition")).toBe("html-artifact-preview");
    expect(webview?.getAttribute("webpreferences")).toContain("javascript=no");
  });

  it("opens the full explainer tab from the overview preview and shows the same content", async () => {
    installDocuments();
    const host = await mount(
      <WorkspaceView scope={scope()} repoId="repo" projectName="Harness" onOpenTask={() => {}} />,
    );
    const openFull = host.querySelector<HTMLButtonElement>('[data-testid="work-explainer-open-full"]');
    expect(openFull?.textContent).toContain("打开完整工作说明");
    await act(async () => openFull!.click());
    const explainerTab = tab(host, "explainer");
    expect(explainerTab.getAttribute("aria-selected")).toBe("true");
    expect(explainerTab.textContent).toContain("工作说明");
    // 独立页签与概况预览是同一查询键的同一份正文、同一个隔离 renderer。
    expect(explainerState(host)).toBeNull();
    expect(webviewSrc(host)).toContain("<h1>living task_root</h1>");
  });

  it("shows the overview immediately while the manifest is still pending", async () => {
    installDocuments();
    const list = vi.spyOn(harnessClient, "getTaskDocuments");
    let release: ((value: unknown) => void) | undefined;
    list.mockImplementation(() => new Promise((resolve) => (release = resolve)));
    const host = await mount(
      <WorkspaceView scope={scope()} repoId="repo" projectName="Harness" onOpenTask={() => {}} />,
    );
    // 清单未定案不再整页占位:概况首屏即渲染,内嵌工作说明区域自己处在读态。
    expect(host.querySelector('[data-testid="work-overview-board"]')).not.toBeNull();
    expect(explainerState(host)).toBe("list-pending");
    expect(host.querySelector('[data-testid="html-artifact-webview"]')).toBeNull();
    await act(async () => {
      release?.(listWith(true));
    });
    await settle();
    expect(tab(host, "overview").getAttribute("aria-selected")).toBe("true");
    expect(webviewSrc(host)).toContain("<h1>living task_root</h1>");
  });

  it("lands on the overview and marks the explainer missing when the package has none", async () => {
    installDocuments({ explainer: false });
    const host = await mount(
      <WorkspaceView scope={scope()} repoId="repo" projectName="Harness" onOpenTask={() => {}} />,
    );
    expect(tab(host, "overview").getAttribute("aria-selected")).toBe("true");
    expect(host.querySelector('[data-testid="work-overview-board"]')).not.toBeNull();
    // 缺失是可见的产品信息:概况区域与页签都如实报「还没有」,不冒充空白成功。
    expect(explainerState(host)).toBe("missing");
    await act(async () => tab(host, "explainer").click());
    expect(explainerState(host)).toBe("missing");
    expect(host.querySelector('[data-testid="html-artifact-webview"]')).toBeNull();
  });

  it("tells a manifest read failure apart from a missing explainer", async () => {
    vi.spyOn(harnessClient, "getTaskDocuments").mockRejectedValue(new Error("daemon unreachable"));
    const host = await mount(
      <WorkspaceView scope={scope()} repoId="repo" projectName="Harness" onOpenTask={() => {}} />,
    );
    // 清单读失败按「无 explainer」定案落回概况,但状态面如实报失败,不冒充缺失。
    expect(tab(host, "overview").getAttribute("aria-selected")).toBe("true");
    const state = host.querySelector<HTMLElement>('[data-testid="work-explainer-document"]');
    expect(state?.getAttribute("data-state")).toBe("list-error");
    expect(state?.querySelector('[role="alert"]')).not.toBeNull();
    expect(state?.textContent).toContain("daemon unreachable");
  });

  it("tells a pending manifest projection apart from a missing explainer", async () => {
    vi.spyOn(harnessClient, "getTaskDocuments").mockResolvedValue({
      ...listWith(false),
      status: "pending",
    } as never);
    const host = await mount(
      <WorkspaceView scope={scope()} repoId="repo" projectName="Harness" onOpenTask={() => {}} />,
    );
    expect(tab(host, "overview").getAttribute("aria-selected")).toBe("true");
    expect(explainerState(host)).toBe("list-not-ready");
    expect(host.textContent).toContain("工作说明清单投影尚未追平");
  });

  it("surfaces a body read failure without faking an empty page", async () => {
    vi.spyOn(harnessClient, "getTaskDocuments").mockResolvedValue(listWith(true) as never);
    vi.spyOn(harnessClient, "getTaskDocument").mockRejectedValue(new Error("blob store offline"));
    const host = await mount(
      <WorkspaceView scope={scope()} repoId="repo" projectName="Harness" onOpenTask={() => {}} />,
    );
    const state = host.querySelector<HTMLElement>('[data-testid="work-explainer-document"]');
    expect(state?.getAttribute("data-state")).toBe("body-error");
    expect(state?.querySelector('[role="alert"]')).not.toBeNull();
    expect(state?.textContent).toContain("blob store offline");
    expect(host.querySelector('[data-testid="html-artifact-webview"]')).toBeNull();
  });

  it("does not carry one work's explainer into another work", async () => {
    installDocuments();
    const host = document.createElement("div");
    const root = createRoot(host);
    document.body.append(host);
    mounted.push(root);
    const client = new QueryClient();
    const element = (rootId: string) => (
      <QueryClientProvider client={client}>
        <WorkspaceView scope={scopeWithRoot(rootId)} repoId="repo" projectName="Harness" onOpenTask={() => {}} />
      </QueryClientProvider>
    );
    await act(async () => root.render(element("task_root")));
    await settle();
    expect(webviewSrc(host)).toContain("<h1>living task_root</h1>");
    // 同一实例换工作根(不靠重挂载):查询键换到新根,加载中如实停在读态,不显示旧正文。
    await act(async () => root.render(element("task_other")));
    await settle();
    expect(webviewSrc(host)).toContain("<h1>living task_other</h1>");
    expect(webviewSrc(host)).not.toContain("living task_root");
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

describe("tab panel wiring (TabPanel 原语)", () => {
  it("pairs the panel with the Tabs ids and plays the shared entry motion on tab switch", async () => {
    motionProbe.animate.mockClear();
    // 动效偏好「始终开启」:偏好现在由 AppMotionConfig 持有并写回 localStorage(照主题的做法)。
    localStorage.setItem(MOTION_PREFERENCE_STORAGE_KEY, "on");
    const host = await mount(
      <AppMotionConfig>
        <PageEntryBoundary identity="work-page">
          <WorkspaceView scope={scope()} projectName="Harness" onOpenTask={() => {}} />
        </PageEntryBoundary>
      </AppMotionConfig>,
    );
    try {
      // 与 Tabs 的 idPrefix 配对:id/aria 随页签走(与 TaskDetailView 同一接法)。
      const panel = host.querySelector("#workspace-panel")!;
      expect(panel.getAttribute("role")).toBe("tabpanel");
      expect(panel.getAttribute("aria-labelledby")).toBe("workspace-tab-overview");
      // 初次挂载不播;切页签播一次轻量入场(#3163 语义)。
      expect(motionProbe.animate).not.toHaveBeenCalled();
      await act(async () => tab(host, "tasks").click());
      expect(panel.getAttribute("aria-labelledby")).toBe("workspace-tab-tasks");
      expect(motionProbe.animate).toHaveBeenCalled();
    } finally {
      localStorage.removeItem(MOTION_PREFERENCE_STORAGE_KEY);
    }
  });
});

describe("layout adapts without guessed viewport constants(原则 9)", () => {
  it("fills the local-graph canvas from the flex chain instead of calc(100vh) and a fixed min width", async () => {
    const host = await mount(<WorkspaceView scope={scope()} projectName="Harness" onOpenTask={() => {}} />);
    await act(async () => tab(host, "graph").click());
    const scroll = host.querySelector('[data-testid="workspace-graph-scroll"]')!;
    expect(scroll.className).toContain("min-h-0");
    expect(scroll.className).toContain("flex-1");
    // 画布宽度跟随容器,不再有横向滚动容器与 52rem 下限。
    // Real canvas geometry and scrollbar behavior: page-split-layout Electron scenario.
    expect(scroll.className).toContain("overflow-hidden");
    const canvas = host.querySelector('[data-testid="workspace-graph-canvas"]')!;
    expect(canvas.className).toContain("h-full");
    expect(canvas.className).not.toMatch(/calc\(100vh|min-w-\[/u);
  });

  it("gives the root-task panel its height from the flex chain, not a viewport guess", async () => {
    const host = await mount(
      <WorkspaceView
        scope={scope()}
        projectName="Harness"
        onOpenTask={() => {}}
        renderRootTask={() => <p>root detail</p>}
      />,
    );
    await act(async () => tab(host, "root").click());
    const panel = host.querySelector('[data-testid="workspace-root-task"]')!;
    expect(panel.className).toContain("flex-1");
    expect(panel.className).toContain("min-h-0");
    expect(panel.className).not.toMatch(/calc\(100vh|min-h-\[\d+px\]/u);
  });

  it("keeps the in-page search a fixed compact control in the header tab row (chrome S4)", async () => {
    const host = await mount(<WorkspaceView scope={scope()} projectName="Harness" onOpenTask={() => {}} />);
    const search = host.querySelector('[data-testid="workspace-search"]')!;
    // 三行化:搜索与页签同行,固定 210px/24px 紧凑档,窄屏随行折行,不再吃 flex-1。
    expect(search.className).toContain("w-[210px]");
    expect(search.className).toContain("h-6");
    expect(search.className).toContain("shrink-0");
    expect(search.className).not.toContain("flex-1");
    // 搜索仍与页签同属页头行。
    expect(search.closest("header")).not.toBeNull();
  });
});
