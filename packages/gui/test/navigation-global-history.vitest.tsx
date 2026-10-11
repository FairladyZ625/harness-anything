// harness-test-tier: integration
// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { useViewHistory } from "../src/renderer/navigation/useViewHistory.ts";
import { useEntityNavigation } from "../src/renderer/navigation/useEntityNavigation.ts";
import { useAppShortcuts } from "../src/renderer/navigation/useAppShortcuts.ts";
import { initialLocation } from "../src/renderer/navigation/viewHistoryStorage.ts";
import type { AppLocation } from "../src/renderer/navigation/viewHistory.ts";
import type { AppCommandApi, AppNavigationCommand } from "../src/api/app-command-contract.ts";

/**
 * 全局导航历史(业主 2026-10-11「有的页面能退能进,有的不能」):挂真实的
 * useViewHistory + useEntityNavigation + useAppShortcuts(与 App.tsx 同一接线),
 * 走主要页面与下钻路径,断言后退/前进回到正确位置。包含业主实例
 * 「任务 → 会话 → 后退回任务」与鼠标侧键(3/4)、Cmd+[/]、主进程 app-command
 * 三条触发路径落同一对 back()/forward()。
 */

interface Harness {
  readonly location: AppLocation;
  readonly canBack: boolean;
  readonly canForward: boolean;
  gotoBoard: () => void;
  openTaskDetail: (id: string) => void;
  openTaskPreview: (id: string) => void;
  navigateToEntity: (ref: string) => void;
  navigateToDecision: (id: string) => void;
  focusEntityInGraph: (ref: string) => void;
  setBoardFilterQuery: (query: string) => void;
  back: () => void;
  forward: () => void;
}

const mounted: Root[] = [];
let latest: Harness | null = null;

function Probe() {
  const { location, navigate, updateLocation, back, forward, canBack, canForward } = useViewHistory(
    "proj-nav",
    initialLocation(),
  );
  const nav = useEntityNavigation({
    navigate,
    updateLocation,
    activeRepoId: "proj-nav",
    enabledRepoIds: ["proj-nav"],
    openInRepo: () => undefined,
    onRepoUnavailable: () => undefined,
    isWorkRoot: () => false,
  });
  useAppShortcuts({
    onTogglePalette: () => undefined,
    onToggleTerminal: () => navigate({ view: "terminal", selectedId: null, previewId: null, focusedEntityRef: null }),
    onBack: back,
    onForward: forward,
  });
  latest = {
    location,
    canBack,
    canForward,
    gotoBoard: () =>
      navigate({ view: "board", focusedEntityRef: null, selectedId: null, previewId: null, drill: null }),
    openTaskDetail: nav.openTaskDetail,
    openTaskPreview: nav.openTaskPreview,
    navigateToEntity: nav.navigateToEntity,
    navigateToDecision: nav.navigateToDecision,
    focusEntityInGraph: nav.focusEntityInGraph,
    setBoardFilterQuery: (query: string) => updateLocation({ taskFilters: { ...location.taskFilters, query } }),
    back,
    forward,
  };
  return null;
}

async function mountNavigation() {
  const container = document.createElement("div");
  const root = createRoot(container);
  document.body.append(container);
  mounted.push(root);
  await act(async () => root.render(createElement(Probe)));
  return () => latest!;
}

const sideButton = (button: number) => window.dispatchEvent(new MouseEvent("mousedown", { button, bubbles: true }));
const sideBack = () => sideButton(3);
const sideForward = () => sideButton(4);
const key = (k: string, metaKey = true) =>
  window.dispatchEvent(new KeyboardEvent("keydown", { key: k, metaKey, bubbles: true }));

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  window.sessionStorage.clear();
});
afterEach(async () => {
  await act(async () => {
    for (const root of mounted.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
  latest = null;
});

describe("全局导航历史:主要页面与下钻共用一个栈(业主 2026-10-11)", () => {
  it("任务 → 会话 → 侧键后退回任务,再退回看板,前进原路返回", async () => {
    const h = await mountNavigation();
    expect(h().location.view).toBe("overview");
    act(() => h().gotoBoard());
    act(() => h().openTaskDetail("t1"));
    // 业主实例:任务详情点「会话」(tasksessions/<id> 可寻址路由,推栈)。
    act(() => h().navigateToEntity("tasksessions/t1"));
    expect(h().location.view).toBe("sessions");
    expect(h().location.focusedEntityRef).toBe("tasksessions/t1");
    // 鼠标侧键后退:回任务详情(selectedId 复原 → TaskDetailView 重新挂载)。
    act(() => sideBack());
    expect(h().location.view).toBe("board");
    expect(h().location.selectedId).toBe("t1");
    expect(h().location.focusedEntityRef).toBe("task/t1");
    // 再退回看板列表,第三次退回总览;栈底后退为 no-op。
    act(() => sideBack());
    expect(h().location.selectedId).toBeNull();
    expect(h().location.view).toBe("board");
    act(() => sideBack());
    expect(h().location.view).toBe("overview");
    expect(h().canBack).toBe(false);
    act(() => sideBack());
    expect(h().location.view).toBe("overview");
    // 侧键前进原路返回:看板 → 任务详情 → 会话。
    act(() => sideForward());
    expect(h().location.view).toBe("board");
    act(() => sideForward());
    expect(h().location.selectedId).toBe("t1");
    act(() => sideForward());
    expect(h().location.view).toBe("sessions");
    expect(h().canForward).toBe(false);
  });

  it("关系图聚焦、决策详情、预设详情与任务详情同栈互退", async () => {
    const h = await mountNavigation();
    act(() => h().gotoBoard());
    act(() => h().focusEntityInGraph("task/t1"));
    expect(h().location.view).toBe("graph");
    act(() => h().navigateToDecision("d1"));
    expect(h().location.view).toBe("decisionDetail");
    act(() => h().navigateToEntity("preset/p1"));
    expect(h().location.view).toBe("presets");
    expect(h().location.focusedEntityRef).toBe("preset/p1");
    // 局部「返回」= 弹栈:预设详情退回决策详情,决策退回图,图退回看板。
    act(() => h().back());
    expect(h().location.view).toBe("decisionDetail");
    act(() => h().back());
    expect(h().location.view).toBe("graph");
    expect(h().location.focusedEntityRef).toBe("task/t1");
    act(() => h().back());
    expect(h().location.view).toBe("board");
  });

  it("任务预览抽屉推栈:开着抽屉按后退回到列表(修复前原地改,栈底后退失灵)", async () => {
    const h = await mountNavigation();
    act(() => h().gotoBoard());
    act(() => h().openTaskPreview("t2"));
    expect(h().location.previewId).toBe("t2");
    expect(h().canBack).toBe(true);
    // 后退关抽屉回看板;前进重新打开同一预览。
    act(() => sideBack());
    expect(h().location.previewId).toBeNull();
    expect(h().location.view).toBe("board");
    act(() => h().forward());
    expect(h().location.previewId).toBe("t2");
    // 抽屉里再点开另一个预览:各自占一条目,逐层退回。
    act(() => h().openTaskPreview("t3"));
    act(() => sideBack());
    expect(h().location.previewId).toBe("t2");
  });

  it("后退回到列表页保留当时的筛选(筛选随历史条目快照,精修不占条目)", async () => {
    const h = await mountNavigation();
    act(() => h().gotoBoard());
    act(() => h().setBoardFilterQuery("gui"));
    expect(h().canBack).toBe(true); // 精修不推栈。
    act(() => h().openTaskDetail("t1"));
    act(() => sideBack());
    expect(h().location.view).toBe("board");
    expect(h().location.taskFilters.query).toBe("gui");
  });

  it("Cmd+[ / Cmd+] 与侧键同落 back/forward;无修饰键不触发", async () => {
    const h = await mountNavigation();
    act(() => h().gotoBoard());
    act(() => h().openTaskDetail("t1"));
    act(() => key("["));
    expect(h().location.view).toBe("board");
    expect(h().location.selectedId).toBeNull();
    act(() => key("]"));
    expect(h().location.selectedId).toBe("t1");
    act(() => key("[", false));
    expect(h().location.selectedId).toBe("t1");
  });
});

describe("app-command 订阅(Windows/Linux 鼠标侧键的主进程转发)", () => {
  it("桥上有 appCommand 时订阅,back/forward 命令驱动历史,卸载即退订;无桥不订阅", async () => {
    const listeners = new Set<(command: AppNavigationCommand) => void>();
    (window as { harness?: unknown }).harness = {
      appCommand: {
        onNavigationCommand: (listener: (command: AppNavigationCommand) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      } satisfies AppCommandApi,
    };
    try {
      const h = await mountNavigation();
      act(() => h().gotoBoard());
      act(() => h().openTaskDetail("t1"));
      expect(listeners.size).toBe(1);
      for (const listener of listeners) act(() => listener("back"));
      expect(h().location.view).toBe("board");
      expect(h().location.selectedId).toBeNull();
      for (const listener of listeners) act(() => listener("forward"));
      expect(h().location.selectedId).toBe("t1");
      await act(async () => {
        for (const root of mounted.splice(0)) root.unmount();
      });
      expect(listeners.size).toBe(0);
    } finally {
      delete (window as { harness?: unknown }).harness;
    }
    // 无桥(浏览器模式):挂载不报错,导航照常。
    const h2 = await mountNavigation();
    act(() => h2().gotoBoard());
    expect(h2().location.view).toBe("board");
  });
});
