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

/** 快照/默认布局 → 每区域的矩形(带尺寸断言用;同向多兄弟的半宽归属要真数字)。 */
interface Box {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}
const ZERO_BOX: Box = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
function boxesOfTree(root: unknown, host: { width: number; height: number }): Record<string, Box> {
  const boxes: Record<string, Box> = {};
  const walk = (node: unknown, box: { x: number; y: number; w: number; h: number }, horizontal: boolean): void => {
    const record = node as { type?: string; data?: unknown; size?: number };
    if (record?.type !== "branch") {
      const id = (record?.data as { views?: string[] })?.views?.[0];
      if (id !== undefined)
        boxes[id] = {
          left: box.x,
          top: box.y,
          right: box.x + box.w,
          bottom: box.y + box.h,
          width: box.w,
          height: box.h,
        };
      return;
    }
    const children = (record.data as { size?: number }[]) ?? [];
    const total = children.reduce((sum, child) => sum + (child.size ?? 0), 0);
    let offset = 0;
    for (const child of children) {
      const share = total > 0 ? (child.size ?? 0) / total : 1 / children.length;
      const childBox = horizontal
        ? { x: box.x + offset * box.w, y: box.y, w: share * box.w, h: box.h }
        : { x: box.x, y: box.y + offset * box.h, w: box.w, h: share * box.h };
      walk(child, childBox, !horizontal);
      offset += share;
    }
  };
  walk(root, { x: 0, y: 0, w: host.width, h: host.height }, true);
  return boxes;
}
/** 无快照时的默认树:列等宽、列内等高(defaultRatio/权重都缺省)。 */
function defaultTree(columns: readonly (readonly string[])[]): unknown {
  const column = (ids: readonly string[]) =>
    ids.length === 1
      ? { type: "leaf", data: { views: [ids[0]] } }
      : { type: "branch", data: ids.map((id) => ({ type: "leaf", data: { views: [id] }, size: 1 })) };
  const groups = columns.filter((ids) => ids.length > 0);
  if (groups.length === 1) return column(groups[0]!);
  return { type: "branch", data: groups.map((ids) => ({ ...column(ids), size: 1 })) };
}
/** 注入真实数字几何:宿主量出 width×height,区域/组的矩形按当前布局(快照优先,否则默认)换算。 */
function injectGeometry(testColumns: readonly (readonly string[])[], hostWidth = 1000, hostHeight = 600) {
  const storage = () =>
    (readSplitPreferences(localStorage, "local", "repo").page?.snapshot as { grid?: { root?: unknown } })?.grid?.root;
  const boxes = () => boxesOfTree(storage() ?? defaultTree(testColumns), { width: hostWidth, height: hostHeight });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const id = this.dataset.region ?? this.querySelector<HTMLElement>("[data-region]")?.dataset.region;
    return (id !== undefined ? boxes()[id] : undefined) ?? ZERO_BOX;
  });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.dataset.testid === "board" ? hostWidth : 0;
  });
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.dataset.testid === "board" ? hostHeight : 0;
  });
  return boxes;
}
/** 持久化快照里每个叶子沿父分支方向的尺寸。 */
function leafSizes(): Record<string, number> {
  const root = (readSplitPreferences(localStorage, "local", "repo").page?.snapshot as { grid?: { root?: unknown } })
    ?.grid?.root;
  const sizes: Record<string, number> = {};
  const walk = (node: unknown): void => {
    const record = node as { type?: string; data?: unknown; size?: number };
    if (record?.type === "branch") {
      for (const child of (record.data as unknown[]) ?? []) walk(child);
      return;
    }
    const id = (record?.data as { views?: string[] })?.views?.[0];
    if (id !== undefined && typeof record.size === "number") sizes[id] = record.size;
  };
  walk(root);
  return sizes;
}

it("gives the source and target each exactly half of the target's width in a same-direction multi-sibling branch", async () => {
  const ids = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"].map((id) => ({
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
  // 三列(宿主 2400,每列 800),每列双成员:第二步的源(delta)离开的是根级槽,余量由
  // 第三列吸收,被停靠列宽度不变——gamma 的尺寸才能作为「无关兄弟不被挪走」的对照。
  const columns = [
    ["alpha", "beta"],
    ["gamma", "delta"],
    ["epsilon", "zeta"],
  ];
  injectGeometry(columns, 2400);
  act(() =>
    root.render(
      <PageRegions connectionId="local" repoId="repo" slot="page" regions={ids} columns={columns} testId="board" />,
    ),
  );
  await settle();
  // 第一步:gamma 停到 beta 右半区(正交包支),beta 800 → 400/400。
  await drag("gamma", "beta", { x: 0.9, y: 0.5 });
  await settle();
  expect(layoutTree()).toEqual([["alpha", ["beta", "gamma"]], "delta", ["epsilon", "zeta"]]);
  expect(leafSizes()).toEqual({ alpha: 300, beta: 400, gamma: 400, delta: 800, epsilon: 300, zeta: 300 });
  // 第二步:delta 停到 beta 右半区——beta 的父支已是水平(同向多兄弟分支),dockview 的
  // 均摊会把差额摊给邻居:修复后源与目标都钉在半宽上,gamma 的宽度不被这次停靠挪走。
  await drag("delta", "beta", { x: 0.9, y: 0.5 });
  await settle();
  expect(layoutTree()).toEqual([
    ["alpha", ["beta", "delta", "gamma"]],
    ["epsilon", "zeta"],
  ]);
  const sizes = leafSizes();
  expect(Math.abs(sizes.beta! - 200)).toBeLessThanOrEqual(1);
  expect(Math.abs(sizes.delta! - 200)).toBeLessThanOrEqual(1);
  expect(Math.abs(sizes.gamma! - 400)).toBeLessThanOrEqual(1);
});

it("refuses a dock whose target cannot hold two minimum panes and shows no half-zone overlay for it", async () => {
  const ids = ["alpha", "beta", "gamma"].map((id) => ({
    id,
    title: id,
    content: (
      <section>
        <header>
          <RegionDragHandle />
          {id}
        </header>
        <button data-body={id}>read {id}</button>
      </section>
    ),
  }));
  injectGeometry([["alpha", "beta"], ["gamma"]]);
  act(() =>
    root.render(
      <PageRegions
        connectionId="local"
        repoId="repo"
        slot="page"
        regions={ids}
        columns={[["alpha", "beta"], ["gamma"]]}
        testId="board"
      />,
    ),
  );
  await settle();
  // 宿主收窄到 500px:各列 250px < 2×200px 最小宽,右半区停靠装不下两块。
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.dataset.testid === "board" ? 500 : 0;
  });
  const narrow = boxesOfTree(defaultTree([["alpha", "beta"], ["gamma"]]), { width: 500, height: 600 });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const id = this.dataset.region ?? this.querySelector<HTMLElement>("[data-region]")?.dataset.region;
    return (id !== undefined ? narrow[id] : undefined) ?? ZERO_BOX;
  });
  await act(async () => {
    handle("gamma").dispatchEvent(new Event("dragstart", { bubbles: true }));
    const rect = narrow.beta!;
    region("beta").dispatchEvent(
      new MouseEvent("dragover", {
        clientX: rect.left + rect.width * 0.9,
        clientY: rect.top + rect.height * 0.5,
        bubbles: true,
        cancelable: true,
      }),
    );
    region("beta").dispatchEvent(
      new MouseEvent("drop", {
        clientX: rect.left + rect.width * 0.9,
        clientY: rect.top + rect.height * 0.5,
        bubbles: true,
        cancelable: true,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  // 预览不亮(该方向不可行)、放下是 no-op:布局与存储都不动。
  expect(region("beta").dataset.zone).toBeUndefined();
  expect(host.querySelector('[data-testid="region-drop-overlay-beta"]')).toBeNull();
  expect(order()).toEqual(["alpha", "beta", "gamma"]);
  expect(layoutTree()).toBeNull();
});

it("restores the docked snapshot only after the declared region set is complete, batch by batch without timers", async () => {
  render();
  await drag("plan", "files", { x: 0.9, y: 0.5 });
  await settle();
  expect(order()).toEqual(["progress", "files", "plan"]);
  const saved = readSplitPreferences(localStorage, "local", "repo").page?.snapshot;
  act(() => root.unmount());
  root = createRoot(host);
  const renderBatch = (present: readonly string[], settled: boolean) =>
    act(() =>
      root.render(
        <PageRegions
          connectionId="local"
          repoId="repo"
          slot="page"
          regions={regions.filter((item) => present.includes(item.id))}
          columns={[["plan", "progress"], ["files"]]}
          settled={settled}
          testId="board"
        />,
      ),
    );
  // 第一批只到 plan:快照面板未齐、也未声明就绪——按默认布局活,不恢复。
  renderBatch(["plan"], false);
  await settle();
  expect(order()).toEqual(["plan"]);
  // 第二批到 progress:仍缺 files,继续等(不把 files 提前从快照里删掉)。
  renderBatch(["plan", "progress"], false);
  await settle();
  expect(order()).toEqual(["plan", "progress"]);
  // 第三批 files 到位:快照面板全部在场即无损恢复——不需要声明,也不需要等定时器。
  renderBatch(["plan", "progress", "files"], false);
  await settle();
  expect(order()).toEqual(["progress", "files", "plan"]);
  // 声明就绪后仍缺席的面板才是真的不显示:剪掉恢复,且不提前覆盖存储里的原快照。
  act(() => root.unmount());
  root = createRoot(host);
  renderBatch(["plan", "progress"], true);
  await settle();
  expect(order()).toEqual(["progress", "plan"]);
  expect(readSplitPreferences(localStorage, "local", "repo").page?.snapshot).toEqual(saved);
});

it("collapses a region with its DOM kept and restores it to the same node and size through the strip", async () => {
  render();
  const body = region("plan").querySelector<HTMLButtonElement>('[data-body="plan"]')!;
  const marker = document.createComment("reading-state");
  body.append(marker);
  await act(async () => {
    host.querySelector<HTMLButtonElement>('[data-testid="region-collapse-plan"]')!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  // 折叠:召回条出现、面板 DOM 保留(收起不是卸载)、偏好记 visible:false。
  expect(host.querySelector('[data-testid="board-collapsed"]')).not.toBeNull();
  expect(host.querySelector('[data-testid="board-expand-plan"]')).not.toBeNull();
  expect(region("plan")).not.toBeNull();
  expect(body.contains(marker)).toBe(true);
  const collapsedSnapshot = readSplitPreferences(localStorage, "local", "repo").page?.snapshot as {
    grid?: { root?: unknown };
  };
  const planLeafVisible = (node: unknown): boolean | undefined => {
    const record = node as { type?: string; data?: unknown; visible?: boolean };
    if (record?.type === "branch") return ((record.data as unknown[]) ?? []).some((child) => planLeafVisible(child));
    return (record?.data as { views?: string[] })?.views?.[0] === "plan" ? record.visible !== false : undefined;
  };
  expect(planLeafVisible(collapsedSnapshot?.grid?.root)).toBe(false);
  // 恢复:同一 DOM 节点(阅读状态原样),召回条消失。
  await act(async () => {
    host.querySelector<HTMLButtonElement>('[data-testid="board-expand-plan"]')!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(host.querySelector('[data-testid="board-collapsed"]')).toBeNull();
  expect(region("plan").querySelector('[data-body="plan"]')).toBe(body);
  // 折叠随快照持久化:重挂后仍是收起态,召回条仍可恢复(重挂后是新文档,另取正文节点)。
  await act(async () => {
    host.querySelector<HTMLButtonElement>('[data-testid="region-collapse-plan"]')!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  act(() => root.unmount());
  root = createRoot(host);
  render();
  await settle();
  expect(host.querySelector('[data-testid="board-expand-plan"]')).not.toBeNull();
  const reloadedBody = region("plan").querySelector<HTMLButtonElement>('[data-body="plan"]')!;
  await act(async () => {
    host.querySelector<HTMLButtonElement>('[data-testid="board-expand-plan"]')!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(host.querySelector('[data-testid="board-collapsed"]')).toBeNull();
  expect(region("plan").querySelector('[data-body="plan"]')).toBe(reloadedBody);
});

it("reorders the untouched default layout by declared columns without remounting any region", async () => {
  render();
  await settle();
  const body = region("progress").querySelector<HTMLButtonElement>('[data-body="progress"]')!;
  const marker = document.createComment("reading-state");
  body.append(marker);
  // daemon 权重变化(总览列序重排):files 列提到最前。未动过的布局跟随列序,但面板
  // DOM 原地搬家——正文节点与滚动/阅读状态保持。
  act(() =>
    root.render(
      <PageRegions
        connectionId="local"
        repoId="repo"
        slot="page"
        regions={regions}
        columns={[["files"], ["plan", "progress"]]}
        testId="board"
      />,
    ),
  );
  await settle();
  expect(order()).toEqual(["files", "plan", "progress"]);
  expect(region("progress").querySelector('[data-body="progress"]')).toBe(body);
  expect(body.contains(marker)).toBe(true);
  // 换回原列序同样只搬不挂;没有用户改动就不落任何偏好。
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
  expect(order()).toEqual(["plan", "progress", "files"]);
  expect(region("progress").querySelector('[data-body="progress"]')).toBe(body);
  expect(layoutTree()).toBeNull();
});
