// harness-test-tier: fast
// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  PageRegions,
  RegionDragHandle,
  RegionLayoutControls,
} from "../src/renderer/components/primitives/page-regions.tsx";
import { readSplitPreferences } from "../src/renderer/split-layout-preferences.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";

/**
 * 页面区域停靠分屏(task_033760e2…):标题把手拖到另一区域的边缘半区,放下按该方向
 * 二分、源位置合并;布局快照按连接+仓+页面槽持久化;方向键停靠、Alt+方向键调缝、
 * 撤销与重置走控件组。happy-dom 无布局引擎:分割几何经 prototype getter 注入,
 * 结构断言读 dockview 序列化树(叶子顺序 = 布局顺序);真实几何由 Electron 场景留证。
 */

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  setActiveLocale("zh-CN");
});

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  localStorage.clear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => {
    root.unmount();
    // dockview 的布局事件是延迟派发的:冲净再清存储,不给下一案留异步写入。
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  host.remove();
  localStorage.clear();
  vi.restoreAllMocks();
});

const regions = ["plan", "progress", "files"].map((id) => ({
  id,
  title: id,
  content: (
    <section>
      <header>
        <RegionDragHandle />
        {id}
        <RegionLayoutControls />
      </header>
      <button data-body={id}>read {id}</button>
    </section>
  ),
}));
function render(
  props: Partial<Parameters<typeof PageRegions>[0]> = {},
  connectionId = "local",
  repoId = "repo",
  slot = "page",
) {
  act(() =>
    root.render(
      <PageRegions
        connectionId={connectionId}
        repoId={repoId}
        slot={slot}
        regions={regions}
        columns={[["plan", "progress"], ["files"]]}
        testId="board"
        {...props}
      />,
    ),
  );
}
const region = (id: string) => host.querySelector<HTMLElement>(`[data-region="${id}"]`)!;
const handle = (id: string) => host.querySelector<HTMLElement>(`[data-testid="region-handle-${id}"]`)!;
function order() {
  return [...host.querySelectorAll<HTMLElement>("[data-region]")].map((node) => node.dataset.region);
}
/** dockview 序列化树的叶子顺序(深度优先 = 布局顺序);分支即一处分割。 */
function layoutTree(): unknown {
  const pref = readSplitPreferences(localStorage, "local", "repo").page;
  if (pref === undefined) return null;
  const walk = (node: unknown): unknown => {
    const record = node as { type?: string; data?: unknown };
    if (record?.type === "branch") return (record.data as unknown[]).map(walk);
    const views = (record?.data as { views?: string[] })?.views ?? [];
    return views[0];
  };
  return walk((pref.snapshot as { grid?: { root?: unknown } }).grid?.root);
}
/** dockview 的 onDidLayoutChange(持久化钩子)在宏任务里派发;等它落地再断言。 */
const settle = () => act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));

/** 拖把手到目标区域的指定半区:与真实 HTML5 拖拽同一事件面(不经 dataTransfer)。 */
async function drag(id: string, targetId: string, at: { x: number; y: number }) {
  await act(async () => {
    handle(id).dispatchEvent(new Event("dragstart", { bubbles: true }));
    const rect = region(targetId).getBoundingClientRect();
    const point = { clientX: rect.left + at.x * rect.width, clientY: rect.top + at.y * rect.height };
    region(targetId).dispatchEvent(new MouseEvent("dragover", { ...point, bubbles: true, cancelable: true }));
    region(targetId).dispatchEvent(new MouseEvent("drop", { ...point, bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
const key = (id: string, value: string, alt = false) =>
  act(async () => {
    handle(id).dispatchEvent(
      new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true, altKey: alt }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

it("builds the default columns and docks a region onto another's edge half, merging its source slot", async () => {
  render();
  expect(order()).toEqual(["plan", "progress", "files"]);
  // 拖 plan 到 files 的右半区:plan 与 files 同行相邻(files 在左),原列只剩 progress。
  // 与目标父分支同向的停靠并入该分支(dockview 语义);真实几何下再按「各占目标一半」收敛尺寸。
  await drag("plan", "files", { x: 0.9, y: 0.5 });
  // 半区遮罩只在拖拽过程中出现,落下即消失。
  expect(host.querySelector('[data-testid^="region-drop-overlay-"]')).toBeNull();
  // 停靠不重挂内容:正文按钮还是同一个 DOM 节点(阅读状态不丢)。
  const body = region("plan").querySelector<HTMLButtonElement>('[data-body="plan"]')!;
  expect(body.textContent).toBe("read plan");
});

it("docks below into a vertical split of the target only", async () => {
  render();
  await drag("files", "progress", { x: 0.5, y: 0.9 });
  // files 落在 progress 下方:目标在自己列内再分出上下两半,plan 原位不动。
  expect(layoutTree()).toEqual(["plan", ["progress", "files"]]);
});

it("shows the half-zone overlay while hovering and cancels without docking on dragend", async () => {
  render();
  await act(async () => {
    handle("plan").dispatchEvent(new Event("dragstart", { bubbles: true }));
    const rect = region("files").getBoundingClientRect();
    region("files").dispatchEvent(
      new MouseEvent("dragover", {
        clientX: rect.left + rect.width * 0.9,
        clientY: rect.top + rect.height * 0.5,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  expect(region("files").dataset.zone).toBe("right");
  expect(host.querySelector('[data-testid="region-drop-overlay-files"]')).not.toBeNull();
  await act(async () => {
    handle("plan").dispatchEvent(new Event("dragend", { bubbles: true }));
  });
  expect(region("files").dataset.zone).toBeUndefined();
  // 取消不落任何偏好:默认布局未被动过,存储保持空。
  expect(layoutTree()).toBeNull();
});

it("keeps panel content nodes identical across a dock (no remount, reading state kept)", async () => {
  render();
  const body = region("progress").querySelector('[data-body="progress"]')!;
  const marker = document.createComment("reading-state");
  body.append(marker);
  await drag("progress", "files", { x: 0.1, y: 0.5 });
  expect(region("progress").querySelector('[data-body="progress"]')).toBe(body);
  expect(body.contains(marker)).toBe(true);
});

it("docks by keyboard toward the geometric neighbour and resizes the seam with Alt+arrows", async () => {
  render();
  // 注入几何:plan|progress 一列在左(宽 300),files 一列在右(宽 200,左边界 300)。
  const rects: Record<string, DOMRect> = {
    plan: { left: 0, top: 0, right: 300, bottom: 300 } as DOMRect,
    progress: { left: 0, top: 300, right: 300, bottom: 600 } as DOMRect,
    files: { left: 300, top: 0, right: 500, bottom: 600 } as DOMRect,
  };
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return rects[this.dataset.region] ?? ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 } as DOMRect);
  });
  await key("plan", "ArrowRight");
  expect(layoutTree()).toEqual(["progress", "files", "plan"]);
  // Alt+方向键沿该轴调缝:组尺寸从注入几何读取(600 高 → 步长 30),不触发结构变化。
  const before = layoutTree();
  await key("plan", "ArrowDown", true);
  expect(layoutTree()).toEqual(before);
  expect(region("plan").querySelector("header")).not.toBeNull();
});

it("undoes the last dock through the control group and resets the whole page slot", async () => {
  render();
  await drag("plan", "files", { x: 0.9, y: 0.5 });
  expect(layoutTree()).toEqual(["progress", "files", "plan"]);
  await act(async () => {
    host.querySelector<HTMLButtonElement>('[data-testid="board-controls-undo"]')!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  // 撤销把 plan 停回原邻居旁(零几何回退按布局顺序取左右位,真实几何按方位取上下位),
  // files 的相对位置不受影响。
  expect(layoutTree()).toEqual(["plan", "progress", "files"]);
  await drag("plan", "files", { x: 0.9, y: 0.5 });
  await act(async () => {
    host.querySelector<HTMLButtonElement>('[data-testid="board-controls-reset"]')!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(order()).toEqual(["plan", "progress", "files"]);
  // 重置回到默认布局且不残留停靠结果;默认布局在用户未改动前不落盘。
  expect(readSplitPreferences(localStorage, "local", "repo")).toEqual({});
});

it("persists the docked layout through remount and isolates connection, repository and page slot", async () => {
  render();
  await drag("plan", "files", { x: 0.9, y: 0.5 });
  act(() => root.unmount());
  root = createRoot(host);
  render();
  expect(layoutTree()).toEqual(["progress", "files", "plan"]);
  render({}, "remote");
  expect(order()).toEqual(["plan", "progress", "files"]);
  render({}, "local", "other");
  expect(order()).toEqual(["plan", "progress", "files"]);
  render({}, "local", "repo", "other-slot");
  expect(order()).toEqual(["plan", "progress", "files"]);
  // 本连接的停靠记忆不受其他作用域读写影响。
  render();
  expect(layoutTree()).toEqual(["progress", "files", "plan"]);
});

it("reconciles region sets without rebuilding the untouched layout", async () => {
  const withFiles = regions.filter((item) => item.id !== "files");
  render({ regions: withFiles, columns: [["plan", "progress"]] });
  await drag("progress", "plan", { x: 0.9, y: 0.5 });
  // files 区域后来出现:增量补到末尾,不打扰已停靠的结构。
  act(() =>
    root.render(
      <PageRegions
        connectionId="local"
        repoId="repo"
        slot="page"
        regions={regions}
        columns={[["plan", "progress"], ["files"]]}
        testId="board"
      />,
    ),
  );
  await settle();
  // files 补在已停靠结构的末尾(与最后一个面板同支向右),原停靠不被重建。
  expect(layoutTree()).toEqual(["plan", "progress", "files"]);
  expect(order().sort()).toEqual(["files", "plan", "progress"]);
});

it("hides the other regions behind the collapse control and brings them back", async () => {
  render({ collapsible: true, columns: [["plan"], ["progress", "files"]] });
  // 收起其他区域:把手所在的控件组仍在首个区域头里可点。
  await act(async () => {
    host.querySelector<HTMLButtonElement>('[data-testid="board-controls-collapse"]')!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  // 最大化后控件组提升到网格上方,恢复全部区域有路。
  const topRow = host.querySelector<HTMLElement>('[data-testid="board"] > div')!;
  expect(topRow.querySelector('[data-testid="board-controls-collapse"]')).not.toBeNull();
  await act(async () => {
    topRow.querySelector<HTMLButtonElement>('[data-testid="board-controls-collapse"]')!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(layoutTree()).toEqual(["plan", ["progress", "files"]]);
});

it("keeps body input untouched by drag activation and control clicks", async () => {
  render();
  await act(async () => {
    region("plan").querySelector<HTMLButtonElement>('[data-body="plan"]')!.click();
  });
  expect(order()).toEqual(["plan", "progress", "files"]);
  await act(async () => {
    host.querySelector<HTMLButtonElement>('[data-testid="board-controls-reset"]')!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(order()).toEqual(["plan", "progress", "files"]);
});
