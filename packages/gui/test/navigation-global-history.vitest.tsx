// harness-test-tier: integration
// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { useViewHistory } from "../src/renderer/navigation/useViewHistory.ts";
import { useEntityNavigation } from "../src/renderer/navigation/useEntityNavigation.ts";
import { useAppShortcuts } from "../src/renderer/navigation/useAppShortcuts.ts";
import { initialLocation } from "../src/renderer/navigation/viewHistoryStorage.ts";
import type { AppLocation, ViewHistoryState } from "../src/renderer/navigation/viewHistory.ts";
import type { AppCommandApi, AppNavigationCommand } from "../src/api/app-command-contract.ts";
import { Drawer } from "../src/renderer/components/primitives/Drawer.tsx";
import { NavigationHistoryBar } from "../src/renderer/components/NavigationHistoryBar.tsx";

/**
 * 全局导航历史(业主 2026-10-11「有的页面能退能进,有的不能」):挂真实的
 * useViewHistory + useEntityNavigation + useAppShortcuts(与 App.tsx 同一接线),
 * 走主要页面与下钻路径,断言后退/前进回到正确位置。包含业主实例
 * 「任务 → 会话 → 后退回任务」与鼠标侧键(3/4)、Cmd+[/]、主进程 app-command
 * 三条触发路径落同一对 back()/forward()。
 *
 * 预览抽屉单层语义(业主 2026-10-17「点了之后右边只有一个……要关掉好几次」):
 * 开抽屉推栈一次、层内换卡原地替换当前条目、关闭(X/Esc/点外面)一次回列表;
 * 旧存储逐次推栈攒下的连续预览条目也一次越过,不逐个回放。
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
    previewId: location.previewId,
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

// F-9280B707 的最小 App 壳:真实 Drawer(非模态外压关闭)+ 真实顶栏按钮 + 侧键监听,
// 导航面挂真实 useViewHistory + useEntityNavigation(onClose 同 App 的 closePreview)。
// 只挂导航面,不挂数据读面:抽屉开 = 当前条目 previewId 非空。
const SHELL_PROJECT = "proj-nav-shell";

interface ShellHarness {
  readonly location: AppLocation;
  readonly canForward: boolean;
  gotoBoard: () => void;
  openTaskDetail: (id: string) => void;
  openTaskPreview: (id: string) => void;
  forward: () => void;
}

let shellLatest: ShellHarness | null = null;

function PreviewShell() {
  const { location, navigate, updateLocation, back, forward, canBack, canForward, closePreview } = useViewHistory(
    SHELL_PROJECT,
    initialLocation(),
  );
  const nav = useEntityNavigation({
    navigate,
    updateLocation,
    previewId: location.previewId,
    activeRepoId: SHELL_PROJECT,
    enabledRepoIds: [SHELL_PROJECT],
    openInRepo: () => undefined,
    onRepoUnavailable: () => undefined,
    isWorkRoot: () => false,
  });
  useAppShortcuts({
    onTogglePalette: () => undefined,
    onToggleTerminal: () => undefined,
    onBack: back,
    onForward: forward,
  });
  shellLatest = {
    location,
    canForward,
    gotoBoard: () =>
      navigate({ view: "board", focusedEntityRef: null, selectedId: null, previewId: null, drill: null }),
    openTaskDetail: nav.openTaskDetail,
    openTaskPreview: nav.openTaskPreview,
    forward,
  };
  return createElement(
    "div",
    null,
    createElement(NavigationHistoryBar, { canBack, canForward, onBack: back, onForward: forward }),
    createElement(Drawer, {
      open: location.previewId !== null,
      modal: false,
      ariaLabel: "task preview",
      onClose: closePreview,
      children: createElement("p", null, "preview body"),
    }),
  );
}

async function mountPreviewShell() {
  const container = document.createElement("div");
  const root = createRoot(container);
  document.body.append(container);
  mounted.push(root);
  await act(async () => root.render(createElement(PreviewShell)));
  return () => shellLatest!;
}

/** 顶栏按钮:第一个是后退,第二个是前进(NavigationHistoryBar 的固定顺序)。 */
const barButtons = () => {
  const buttons = document.querySelectorAll('[data-testid="nav-history-bar"] button');
  expect(buttons.length).toBe(2);
  return { back: buttons[0] as HTMLButtonElement, forward: buttons[1] as HTMLButtonElement };
};
/** 真实按下序列:mousedown 先于 click(浏览器事件顺序),外压关闭监听的就是 mousedown。 */
const pressThenClick = (button: HTMLButtonElement) => {
  button.dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true }));
  button.click();
};
/** 栈指针实测值:viewHistoryStorage 持久化的 history.index(证据协议的 dump 路径)。
 * 运行期介质是 sessionStorage(本窗独立;task_48399f09c1673b4be25faed452)。 */
const shellHistory = () => {
  const raw = window.sessionStorage.getItem(`harness-view-history:${SHELL_PROJECT}`);
  expect(raw).toBeTruthy();
  return (JSON.parse(raw!) as { history: ViewHistoryState }).history;
};
const shellHistoryIndex = () => shellHistory().index;
const shellHistoryEntries = () => shellHistory().entries;
const key = (k: string, metaKey = true) =>
  window.dispatchEvent(new KeyboardEvent("keydown", { key: k, metaKey, bubbles: true }));

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
});
afterEach(async () => {
  await act(async () => {
    for (const root of mounted.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
  latest = null;
  shellLatest = null;
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
    // 抽屉里再点开另一个预览:原地替换当前条目、不推栈,后退一次即回列表
    // (业主 2026-10-17:只有一个抽屉,不再逐层回放看过的预览)。
    act(() => h().openTaskPreview("t3"));
    expect(h().location.previewId).toBe("t3");
    act(() => sideBack());
    expect(h().location.previewId).toBeNull();
    expect(h().location.view).toBe("board");
  });

  it("连点三行只有一个抽屉条目:一次 Esc 回列表,后退栈里没有中间预览(业主 2026-10-17)", async () => {
    const h = await mountPreviewShell();
    act(() => h().gotoBoard());
    act(() => h().openTaskPreview("t1"));
    act(() => h().openTaskPreview("t2"));
    act(() => h().openTaskPreview("t3"));
    expect(h().location.previewId).toBe("t3");
    // 连点三行只在栈上留下一条预览条目(后两次换卡原地替换)。
    const previews = shellHistoryEntries().filter((entry) => entry.previewId !== null);
    expect(previews).toHaveLength(1);
    expect(previews[0]!.previewId).toBe("t3");
    // 一次 Esc(X 键/点外面同一 onClose 出口)即回看板列表;前进重开最后那张卡。
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(h().location.view).toBe("board");
    expect(h().location.previewId).toBeNull();
    expect(shellHistoryIndex()).toBe(1);
    expect(h().canForward).toBe(true);
    act(() => h().forward());
    expect(h().location.previewId).toBe("t3");
  });

  it("旧存储连点攒下的连续预览条目:换卡原地替换,一次关闭越过整段回列表", async () => {
    const entry = (previewId: string | null): AppLocation => ({ ...initialLocation(), view: "board", previewId });
    window.localStorage.setItem(
      `harness-view-history:${SHELL_PROJECT}`,
      JSON.stringify({
        schema: "gui-view-history/v1",
        history: { entries: [entry(null), entry("t1"), entry("t2")], index: 2 },
      }),
    );
    const h = await mountPreviewShell();
    // 旧栈顶带抽屉恢复:抽屉开着,栈里还压着两条旧预览条目。
    expect(h().location.previewId).toBe("t2");
    act(() => h().openTaskPreview("t3"));
    expect(h().location.previewId).toBe("t3");
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(h().location.view).toBe("board");
    expect(h().location.previewId).toBeNull();
    // 一次关闭越过 t2/t1 整段旧预览条目,直回列表,不逐个回放。
    expect(shellHistoryIndex()).toBe(0);
  });

  it("小队编排下钻(squadrun/<id>)推栈:后退回上一位置,前进重开(评审 F2)", async () => {
    const h = await mountNavigation();
    act(() => h().gotoBoard());
    act(() => h().navigateToEntity("squadrun/run-1"));
    expect(h().location.view).toBe("sessions");
    expect(h().location.focusedEntityRef).toBe("squadrun/run-1");
    act(() => sideBack());
    expect(h().location.view).toBe("board");
    expect(h().location.focusedEntityRef).toBeNull();
    act(() => sideForward());
    expect(h().location.focusedEntityRef).toBe("squadrun/run-1");
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

describe("抽屉开着时顶栏前进/后退恰好一步(F-9280B707)", () => {
  // 复现链与业主实例一致:看板开预览 → 完整详情 → 后退回抽屉 → 顶栏前进。
  // 修前:非模态抽屉的外压关闭挂在 window mousedown,按下瞬间先 onClose→back()
  // 弹一次栈,click 里按钮自己的前进/后退再动一次——前进净位移为零(停在抽屉),
  // 后退两步;侧键(App 级 mousedown button 3/4)与外压同一次按下各弹一次,同样两步。
  async function mountAtPreviewOpenFromDetail() {
    const h = await mountPreviewShell();
    act(() => h().gotoBoard());
    act(() => h().openTaskPreview("t2"));
    act(() => h().openTaskDetail("t2"));
    expect(shellHistoryIndex()).toBe(3);
    // 详情页抽屉关着,顶栏后退无干扰:回到预览条目。
    act(() => pressThenClick(barButtons().back));
    expect(h().location.previewId).toBe("t2");
    expect(shellHistoryIndex()).toBe(2);
    return h;
  }

  it("业主实例:抽屉开着点顶栏前进,恰好前进一步回详情(修前净位移为零停在抽屉)", async () => {
    const h = await mountAtPreviewOpenFromDetail();
    act(() => pressThenClick(barButtons().forward));
    expect(h().location.selectedId).toBe("t2");
    expect(h().location.previewId).toBeNull();
    expect(shellHistoryIndex()).toBe(3);
  });

  it("抽屉开着点顶栏后退,恰好后退一步回看板(修前外压与按钮各弹一次 = 两步)", async () => {
    const h = await mountAtPreviewOpenFromDetail();
    act(() => pressThenClick(barButtons().back));
    expect(h().location.view).toBe("board");
    expect(h().location.selectedId).toBeNull();
    expect(h().location.previewId).toBeNull();
    expect(shellHistoryIndex()).toBe(1);
  });

  it("抽屉开着按侧键后退恰好一步;前进原路重开抽屉(修前侧键与外压双弹)", async () => {
    const h = await mountAtPreviewOpenFromDetail();
    act(() => sideBack());
    expect(h().location.view).toBe("board");
    expect(h().location.previewId).toBeNull();
    expect(shellHistoryIndex()).toBe(1);
    // 前进原路返回:预览条目未被就地改写,抽屉重开。
    act(() => sideForward());
    expect(h().location.previewId).toBe("t2");
    expect(shellHistoryIndex()).toBe(2);
  });

  it("点抽屉外空白仍关闭并恰好弹一次(收窄不改变空白按压的既有行为)", async () => {
    const h = await mountPreviewShell();
    act(() => h().gotoBoard());
    act(() => h().openTaskPreview("t2"));
    expect(shellHistoryIndex()).toBe(2);
    const blank = document.createElement("div");
    document.body.append(blank);
    act(() => blank.dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true })));
    blank.remove();
    expect(h().location.view).toBe("board");
    expect(h().location.previewId).toBeNull();
    expect(shellHistoryIndex()).toBe(1);
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
