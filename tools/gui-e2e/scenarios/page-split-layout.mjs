import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assertUnscrolledLayout } from "./helpers.mjs";
import { requestDaemonJsonRpcAt } from "../../../packages/daemon/src/client/local-json-rpc-client.ts";

/** Real route coverage for page region docking splits (task_033760e2…). Isolated daemon data,
 * hidden Electron, actual 1440/1120 content sizes; no production mutations or host focus.
 * Docking uses real DragEvents with a DataTransfer (page.mouse cannot start an HTML5 drag).
 */

const CHILD_TASK_ID = "task-split-child",
  CHILD_TITLE = "分割布局子任务",
  SEED_FILES = 120;

async function setSize(app, page, width, height) {
  const actual = await app.evaluate(
    ({ BrowserWindow }, size) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.setSize(size.width, size.height);
      return window.getContentSize();
    },
    { width, height },
  );
  // Hidden Electron may not resize its renderer; match the real, min-width-clamped content size.
  await page.setViewportSize({ width: actual[0], height: actual[1] });
  await page.waitForFunction(([w, h]) => globalThis.innerWidth === w && globalThis.innerHeight === h, actual);
  return { requested: [width, height], actual };
}

/** 把 source 区域拖到 target 的指定半区:dragstart/dragover/drop/dragend 全走 DragEvent。 */
async function dockRegion(page, boardId, sourceId, targetId, at) {
  await page.evaluate(
    ({ boardId, sourceId, targetId, at }) => {
      const board = globalThis.document.querySelector(`[data-testid="${boardId}"]`);
      const handle = board.querySelector(`[data-testid="region-handle-${sourceId}"]`);
      const target = board.querySelector(`[data-region="${targetId}"]`);
      const dataTransfer = new globalThis.DataTransfer();
      handle.dispatchEvent(new globalThis.DragEvent("dragstart", { bubbles: true, dataTransfer }));
      const rect = target.getBoundingClientRect();
      const point = { clientX: rect.left + rect.width * at.x, clientY: rect.top + rect.height * at.y };
      target.dispatchEvent(
        new globalThis.DragEvent("dragover", { bubbles: true, cancelable: true, ...point, dataTransfer }),
      );
      target.dispatchEvent(
        new globalThis.DragEvent("drop", { bubbles: true, cancelable: true, ...point, dataTransfer }),
      );
      handle.dispatchEvent(new globalThis.DragEvent("dragend", { bubbles: true, dataTransfer }));
    },
    { boardId, sourceId, targetId, at },
  );
}

/** 拖一次但不放下(dragend 取消):预览遮罩出现又消失,布局不变。 */
async function cancelDrag(page, boardId, sourceId, targetId, at) {
  await page.evaluate(
    ({ boardId, sourceId, targetId, at }) => {
      const board = globalThis.document.querySelector(`[data-testid="${boardId}"]`);
      const handle = board.querySelector(`[data-testid="region-handle-${sourceId}"]`);
      const target = board.querySelector(`[data-region="${targetId}"]`);
      const dataTransfer = new globalThis.DataTransfer();
      handle.dispatchEvent(new globalThis.DragEvent("dragstart", { bubbles: true, dataTransfer }));
      const rect = target.getBoundingClientRect();
      target.dispatchEvent(
        new globalThis.DragEvent("dragover", {
          bubbles: true,
          cancelable: true,
          clientX: rect.left + rect.width * at.x,
          clientY: rect.top + rect.height * at.y,
          dataTransfer,
        }),
      );
      handle.dispatchEvent(new globalThis.DragEvent("dragend", { bubbles: true, dataTransfer }));
    },
    { boardId, sourceId, targetId, at },
  );
}

/** dockview 分隔条(sash)是真实 pointer 拖拽:按住中点沿轴走一段。 */
async function dragSash(page, board, delta, axis) {
  const sash = board.locator(".dv-sash.dv-enabled, .dv-sash").first();
  await sash.waitFor();
  const box = await sash.boundingBox();
  assert.ok(box, "dv-sash has no box");
  const x = box.x + box.width / 2,
    y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  const steps = 8;
  for (let index = 1; index <= steps; index += 1) {
    await page.mouse.move(
      x + (axis === "row" ? (delta * index) / steps : 0),
      y + (axis === "row" ? 0 : (delta * index) / steps),
    );
  }
  await page.mouse.up();
}

async function openChildDetail(page) {
  await page.getByRole("button", { name: /^(?:看板|Board)$/u }).click();
  const card = page.getByTestId("board-task-card").filter({ hasText: CHILD_TITLE }).first();
  await card.waitFor({ timeout: 20_000 });
  await card.click();
  await page.getByRole("button", { name: /打开完整详情|Open full details/u }).click();
  await page.getByTestId("task-detail-view").waitFor();
  await page.getByTestId("task-document-tree").waitFor();
}

/** 展开种子目录并等到树真的滚出窗(投影落定与点击有竞态,有界重试)。 */
async function expandSeedTree(page) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await page
      .getByTestId("task-document-tree")
      .getByRole("button", { name: /split\//u })
      .click();
    try {
      await page.waitForFunction(
        () => {
          const node = globalThis.document.querySelector('[data-testid="task-document-tree-scroll"]');
          return node !== null && node.scrollHeight > node.clientHeight + 8;
        },
        null,
        { timeout: 3_000 },
      );
      return;
    } catch {
      // 展开态被清单落定重置,重试。
    }
  }
  throw new Error("seeded 120-file tree never stays expanded long enough to measure");
}

/** 折叠/恢复(返工验证):整块收起后区域从几何里消失、邻居吃满余量;收起不卸载——
 * 恢复回到同一 DOM 节点、同一宽度与同一阅读位置;折叠随布局快照持久化,重载后召回条
 * 仍在,展开回原几何。不依赖 dockview 的 maximize(隐藏窗口下不可靠)。 */
async function checkCollapseRestore(page, shot, boardId, regionId, scrollSelector) {
  const board = page.getByTestId(boardId);
  const region = () => board.locator(`[data-region="${regionId}"]`).first();
  const before = await region().boundingBox();
  assert.ok(before && before.width > 0, `collapse: ${regionId} starts visible`);
  await region().evaluate((node) => node.setAttribute("data-e2e-collapse-marker", "kept"));
  let scrollTop = 0;
  if (scrollSelector !== undefined) {
    scrollTop = await region()
      .locator(scrollSelector)
      .evaluate((node) => {
        node.scrollTop = Math.floor(node.scrollHeight / 2);
        return node.scrollTop;
      });
    assert.ok(scrollTop > 0, `collapse: ${scrollSelector} should be scrollable for the marker`);
  }
  await board.getByTestId(`region-collapse-${regionId}`).click();
  // 折叠的几何事实是宽度归零(dockview 给不可见视图 width:0,boundingBox 不返回 null)。
  const collapsedBox = await region().boundingBox();
  assert.ok(collapsedBox === null || collapsedBox.width <= 1, `collapse: ${regionId} leaves geometry`);
  await board.getByTestId(`${boardId}-collapsed`).waitFor();
  await shot(`collapse-${boardId}-${regionId}`);
  // 恢复:同一 DOM 节点(标记还在)、缓存的宽度、同一阅读位置;召回条收起。
  await board.getByTestId(`${boardId}-expand-${regionId}`).click();
  const restored = await region().boundingBox();
  assert.ok(restored, `expand: ${regionId} back in geometry`);
  assert.ok(
    Math.abs(restored.width - before.width) <= 8,
    `expand returns the cached width: ${restored.width} vs ${before.width}`,
  );
  assert.equal(
    await region().evaluate((node) => node.getAttribute("data-e2e-collapse-marker")),
    "kept",
    "expand: same DOM node, no remount",
  );
  if (scrollSelector !== undefined) {
    const topAfter = await region()
      .locator(scrollSelector)
      .evaluate((node) => node.scrollTop);
    assert.ok(Math.abs(topAfter - scrollTop) <= 1, `expand keeps the reading position: ${topAfter} vs ${scrollTop}`);
  }
  assert.equal(await board.getByTestId(`${boardId}-collapsed`).count(), 0, "expand: strip is gone");
  // 折叠随快照持久化:重载后仍是收起态(宽度归零、召回条在),展开回原宽。
  await board.getByTestId(`region-collapse-${regionId}`).click();
  await page.reload();
  await board.getByTestId(`${boardId}-collapsed`).waitFor({ timeout: 30000 });
  const reloadedHidden = await region().boundingBox();
  assert.ok(reloadedHidden === null || reloadedHidden.width <= 1, `collapse persists through reload`);
  await board.getByTestId(`${boardId}-expand-${regionId}`).click();
  const reloadedWidth = await region().boundingBox();
  assert.ok(
    reloadedWidth && Math.abs(reloadedWidth.width - before.width) <= 8,
    `expand after reload returns the cached width: ${JSON.stringify(reloadedWidth)}`,
  );
  await shot(`expand-${boardId}-${regionId}`);
}

async function checkLayout(page, shot, boardId, first, second, label, reopen) {
  const board = page.getByTestId(boardId);
  const box = (id) => board.locator(`[data-region="${id}"]`).first().boundingBox();
  const handle = (id) => board.getByTestId(`region-handle-${id}`);
  if (boardId === "task-detail-content-grid") {
    const geometry = await page.getByTestId("task-detail-panel-scroll").evaluate((node) => {
      const rect = node.getBoundingClientRect(),
        style = globalThis.getComputedStyle(node);
      return {
        width: rect.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
        height: rect.height - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom),
      };
    });
    await shot(`${label}-usable-${Math.round(geometry.width)}x${Math.round(geometry.height)}`);
  }
  await handle(first).waitFor();
  const initial = await box(first),
    targetBefore = await box(second);
  assert.ok(initial && targetBefore && initial.width > 0 && initial.height > 0, label);
  await shot(`${label}-before`);
  // 停靠:拖 source 到 target 的右半区,放下后两块各占 target 原宽的一半且相邻。
  // 返工收严:同向多兄弟分支也由源/目标双方显式钉半宽,不再给加权板 ±35% 谷差。
  await dockRegion(page, boardId, first, second, { x: 0.75, y: 0.5 });
  const docked = await box(first),
    targetAfter = await box(second);
  assert.ok(docked && targetAfter, `${label} docked boxes`);
  // 落位语义:源与目标各占「目标空间」的一半。源整列消失时目标支吸收源列变宽,两块
  // 平分的是加宽后的空间(仍 ≥ 原目标一半,无空洞);目标空间未变时即原宽一半。装不下
  // 两块最小宽的方向在预览与放下都被拒绝,不会出现挤出来的比例。
  const half = targetBefore.width / 2,
    tolerance = 8;
  assert.ok(
    Math.abs(docked.width - targetAfter.width) <= tolerance,
    `${label} halves are equal: ${docked.width} vs ${targetAfter.width}`,
  );
  assert.ok(
    docked.width >= half - tolerance,
    `${label} source gets at least half of the target's original width: ${docked.width} vs ${half}`,
  );
  assert.ok(
    targetAfter.width >= half - tolerance,
    `${label} target gives up half: before=${targetBefore.width} after=${targetAfter.width}`,
  );
  assert.ok(
    Math.abs(docked.x - (targetAfter.x + targetAfter.width)) < 4,
    `${label} adjacency: source should sit right of target`,
  );
  await shot(`${label}-docked`);
  // Reload preserves actual placement, not just a serialized preference.
  await page.reload();
  if (reopen) await reopen();
  await handle(first).waitFor({ timeout: 30000 });
  // 快照恢复由声明区域集协调(面板到位或读面就绪),等区域真的回到停靠位置再量。
  await page
    .waitForFunction(
      ({ boardId, first, x, y }) => {
        const node = globalThis.document.querySelector(`[data-testid="${boardId}"] [data-region="${first}"]`);
        if (node === null) return false;
        const rect = node.getBoundingClientRect();
        return Math.abs(rect.x - x) < 6 && Math.abs(rect.y - y) < 6;
      },
      { boardId, first, x: docked.x, y: docked.y },
      { timeout: 10_000 },
    )
    .catch(async (error) => {
      const reloaded = await box(first);
      throw new Error(
        `${label} reload ${JSON.stringify(reloaded)} vs docked ${JSON.stringify(docked)} storage=${await page.evaluate(() => globalThis.localStorage.getItem("harness:gui:split-layout"))}: ${error.message}`,
      );
    });
  const reloaded = await box(first);
  await shot(`${label}-reloaded`);
  // 取消(dragend 不落):遮罩出现又消失,布局不动。
  await cancelDrag(page, boardId, first, second, { x: 0.75, y: 0.5 });
  const cancelled = await box(first);
  assert.ok(
    Math.abs(cancelled.x - reloaded.x) < 6 && Math.abs(cancelled.y - reloaded.y) < 6,
    `${label} cancel: ${JSON.stringify(cancelled)} vs ${JSON.stringify(reloaded)}`,
  );
  // 键盘停靠:方向键把本区域停到该方向的相邻区域;目标装不下两块最小宽(200px×2)时
  // 停靠被诚实地拒绝、布局不动——与拖拽的预览/拒绝同一规则。可行才验「动了」并撤销。
  const leftNeighborWidth = await board.evaluate((node, sourceId) => {
    const regions = [...node.querySelectorAll("[data-region]")].map((element) => ({
      id: element.dataset.region,
      r: element.getBoundingClientRect(),
    }));
    const me = regions.find((entry) => entry.id === sourceId);
    if (me === undefined) return null;
    const neighbors = regions.filter(
      (entry) =>
        entry.id !== sourceId &&
        entry.r.right <= me.r.left + 1 &&
        entry.r.top < me.r.bottom &&
        entry.r.bottom > me.r.top,
    );
    neighbors.sort((a, b) => b.r.right - a.r.right);
    return neighbors[0]?.r.width ?? null;
  }, first);
  await handle(first).press("ArrowLeft");
  const keyboard = await box(first);
  const keyboardMoved = Math.abs(keyboard.x - cancelled.x) > 3 || Math.abs(keyboard.y - cancelled.y) > 3;
  if (leftNeighborWidth !== null && leftNeighborWidth >= 400)
    assert.ok(keyboardMoved, `${label} keyboard dock toward ${leftNeighborWidth}px neighbour`);
  else assert.ok(!keyboardMoved, `${label} keyboard dock refused for a sub-minimum target (${leftNeighborWidth}px)`);
  await shot(`${label}-keyboard`);
  // 撤销上一步停靠,再重置回默认布局。
  if (keyboardMoved) {
    await board.getByTestId(`${boardId}-controls-undo`).click();
    const undone = await box(first);
    assert.ok(
      Math.abs(undone.x - cancelled.x) < 3,
      `${label} undo: ${JSON.stringify(undone)} vs ${JSON.stringify(cancelled)}`,
    );
  }
  await board.getByTestId(`${boardId}-controls-reset`).click();
  // 任务详情按调用方固定 columns,精确回位;加权板(工作概况/总览)的默认列宽每次由
  // daemon 权重现算,只验「回到默认列结构 + 槽位清空」:source 不再贴在 target 右侧。
  // 清槽后存储可能仍留着空仓壳(connections.repo = {}),验「本页槽位不存在」而非整键为空。
  const storageCleared = async () =>
    await page.evaluate(
      () =>
        !Object.hasOwn(
          (JSON.parse(globalThis.localStorage.getItem("harness:gui:split-layout") ?? "{}").connections ?? {}).local?.[
            "gui-e2e-catalog"
          ] ?? {},
          "task-detail-docs",
        ),
    );
  if (boardId === "task-detail-content-grid") {
    await page.waitForFunction(
      ({ boardId, first, x, y }) => {
        const node = globalThis.document.querySelector(`[data-testid="${boardId}"] [data-region="${first}"]`);
        if (node === null) return false; // 重置换 key 重挂,区域短暂缺席,等它回来。
        const rect = node.getBoundingClientRect();
        return Math.abs(rect.x - x) < 3 && Math.abs(rect.y - y) < 3;
      },
      { boardId, first, x: initial.x, y: initial.y },
      { timeout: 5000 },
    );
    const reset = await box(first);
    assert.ok(
      Math.abs(reset.x - initial.x) < 3 && Math.abs(reset.y - initial.y) < 3,
      `${label} reset: initial=${JSON.stringify(initial)} actual=${JSON.stringify(reset)}`,
    );
    assert.ok(await storageCleared(), `${label} reset should clear the slot`);
  } else {
    await handle(first).waitFor({ timeout: 10_000 });
    const reset = await box(first),
      targetNow = await box(second);
    assert.ok(reset && targetNow, `${label} reset boxes`);
    assert.ok(
      Math.abs(reset.x - (targetNow.x + targetNow.width)) > 8,
      `${label} reset should leave the default columns: reset=${JSON.stringify(reset)} target=${JSON.stringify(targetNow)}`,
    );
    assert.ok(await storageCleared(), `${label} reset should clear the slot`);
  }
  await shot(`${label}-reset-default`);
  // 键盘调缝:Alt+方向键沿该轴增/减本区域尺寸(≥16px 步长)。
  const beforeResize = await box(first);
  await handle(first).press("Alt+ArrowRight");
  const keyboardResized = await box(first);
  assert.ok(
    Math.abs(keyboardResized.width - beforeResize.width) >= 12,
    `${label} keyboard seam: ${beforeResize.width} -> ${keyboardResized.width}`,
  );
  // 分隔条真实 pointer 拖拽调比例。
  const start = await box(first);
  await dragSash(page, board, -30, "row");
  const resized = await box(first);
  assert.ok(Math.abs(resized.width - start.width) > 10, `${label} sash resize`);
  await shot(`${label}-sash`);
  await board.getByTestId(`${boardId}-controls-reset`).click();
  await assertUnscrolledLayout(board);
  const contained = await board.evaluate((node) => {
    const outer = node.getBoundingClientRect();
    return [...node.querySelectorAll("[data-region]")].every((region) => {
      const box = region.getBoundingClientRect();
      return (
        box.left >= outer.left - 1 &&
        box.right <= outer.right + 1 &&
        box.top >= outer.top - 1 &&
        box.bottom <= outer.bottom + 1
      );
    });
  });
  const containDetail = await board.evaluate((node) =>
    [...node.querySelectorAll("[data-region]")].map((region) => {
      const box = region.getBoundingClientRect();
      return { id: region.dataset.region, x: box.x, y: box.y, right: box.right, bottom: box.bottom };
    }),
  );
  assert.ok(
    contained,
    `${label} all regions remain inside the page: outer=${JSON.stringify(await board.boundingBox())} regions=${JSON.stringify(containDetail)}`,
  );
  await shot(`${label}-reset`);
}

/**
 * 总览(main 2026-10-04 注意力返工后)是单列注意力漏斗:「关注的工作」(主体,weight 6)叠在
 * 「执行与下钻」(紧凑工具带,weight 1.5)上。合并停靠分屏(task_033760e2)后,这块板的换序
 * 交互是停靠:把「执行与下钻」停进「关注的工作」的上半区,两块上下互换、各占半高。这里
 * 断言默认次序、above 半区预览遮罩与取消、停靠换序、重载保持、重置回位、键盘换序与列
 * 高调缝(把手 Alt+方向键与 dv-sash 指针拖拽);不做 checkLayout 的左右二分——单列板没
 * 有横向目标,works 也远高于 drill,交换像素位置的前提本来就不成立。
 */
async function checkOverviewColumn(page, shot, label) {
  const board = page.getByTestId("overview-board");
  const box = (id) => board.locator(`[data-region="${id}"]`).first().boundingBox();
  const handle = (id) => board.getByTestId(`region-handle-${id}`);
  const worksFirst = async () => {
    const [works, drill] = await Promise.all([box("works"), box("drill")]);
    assert.ok(works && drill, `${label} both overview regions must exist`);
    return works.y < drill.y;
  };
  const orderIs = (worksOnTop) =>
    page.waitForFunction(
      (top) => {
        const boardNode = globalThis.document.querySelector('[data-testid="overview-board"]');
        const works = boardNode?.querySelector('[data-region="works"]');
        const drill = boardNode?.querySelector('[data-region="drill"]');
        if (works === null || drill === null) return false;
        return works.getBoundingClientRect().y < drill.getBoundingClientRect().y === top;
      },
      worksOnTop,
      { timeout: 10_000 },
    );
  await handle("works").waitFor();
  assert.ok(await worksFirst(), `${label} works starts above the drill strip`);
  await shot(`${label}-before`);
  // 预览与取消:dragover 悬停 works 上半区时目标亮 above 半区遮罩;dragend 取消后遮罩消失、
  // 布局不动。dragstart/dragover 与 dragend 分两次注入,中间才能从外面看到遮罩。
  await page.evaluate(
    ({ sourceId, targetId }) => {
      const boardNode = globalThis.document.querySelector('[data-testid="overview-board"]');
      const source = boardNode.querySelector(`[data-testid="region-handle-${sourceId}"]`);
      const target = boardNode.querySelector(`[data-region="${targetId}"]`);
      const dataTransfer = new globalThis.DataTransfer();
      source.dispatchEvent(new globalThis.DragEvent("dragstart", { bubbles: true, dataTransfer }));
      const rect = target.getBoundingClientRect();
      target.dispatchEvent(
        new globalThis.DragEvent("dragover", {
          bubbles: true,
          cancelable: true,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height * 0.25,
          dataTransfer,
        }),
      );
    },
    { sourceId: "drill", targetId: "works" },
  );
  await board.getByTestId("region-drop-overlay-works").waitFor();
  await shot(`${label}-preview`);
  await page.evaluate(() => {
    const handleNode = globalThis.document.querySelector(
      '[data-testid="overview-board"] [data-testid="region-handle-drill"]',
    );
    handleNode.dispatchEvent(new globalThis.DragEvent("dragend", { bubbles: true }));
  });
  assert.ok((await board.getByTestId("region-drop-overlay-works").count()) === 0, `${label} cancel hides the overlay`);
  assert.ok(await worksFirst(), `${label} cancel keeps the funnel order`);
  // 换序:drill 停进 works 上半区(works 高度远超两倍最小高,方向可行),放下后 drill 在上、
  // 两块各占 works 原高的一半(停靠的半分契约,同 checkLayout 的横向半分)。
  await dockRegion(page, "overview-board", "drill", "works", { x: 0.5, y: 0.25 });
  await orderIs(false);
  const [worksBox, drillBox] = await Promise.all([box("works"), box("drill")]);
  assert.ok(
    Math.abs(worksBox.height - drillBox.height) <= 8,
    `${label} dock halves the works column: ${worksBox.height} vs ${drillBox.height}`,
  );
  await shot(`${label}-moved`);
  // Reload preserves actual placement, not just a serialized preference.
  await page.reload();
  await handle("works").waitFor({ timeout: 30_000 });
  await orderIs(false);
  await shot(`${label}-reloaded`);
  await board.getByTestId("overview-board-controls-reset").click();
  await orderIs(true);
  assert.ok(await worksFirst(), `${label} reset restores works above the drill strip`);
  // 键盘换序:drill 把手 ArrowUp 把 drill 停到上方邻居 works 的上面(方向可行才换序)。
  await handle("drill").press("ArrowUp");
  await orderIs(false);
  assert.ok(!(await worksFirst()), `${label} keyboard dock flips the stacking order`);
  await board.getByTestId("overview-board-controls-reset").click();
  await orderIs(true);
  // 列高调缝:把手 Alt+方向键沿高度增减(单列板的缝是横缝);dv-sash 指针拖拽同轴。
  const seamBefore = await box("works");
  await handle("works").press("Alt+ArrowDown");
  const seamAfter = await box("works");
  assert.ok(
    Math.abs(seamAfter.height - seamBefore.height) >= 12,
    `${label} keyboard seam: ${seamBefore.height} -> ${seamAfter.height}`,
  );
  const sashStart = await box("works");
  await dragSash(page, board, -40, "column");
  const sashResized = await box("works");
  assert.ok(Math.abs(sashResized.height - sashStart.height) > 10, `${label} sash resize`);
  await board.getByTestId("overview-board-controls-reset").click();
  await assertUnscrolledLayout(board);
  await shot(`${label}-reset`);
}

export default {
  id: "page-split-layout",
  feature: "split-layout",
  lane: "isolated",
  description:
    "Overview, work and nested task regions move by title drag and keyboard, resize, persist, cancel and reset in hidden Electron.",
  async run({ page, app, shot, fixture, runRoot }) {
    const { endpoint, repoId, rootDir } = fixture;
    let cleanupError;
    const sizes = [];
    const resize = async (width, height) => {
      sizes.push(await setSize(app, page, width, height));
      writeFileSync(path.join(runRoot, "page-split-window-sizes.json"), `${JSON.stringify(sizes, null, 2)}\n`);
    };

    // ---- 种子:子任务(让夹具根任务成为工作根)+ 120 个任务包文件喂文件树。 ----
    const created = await requestDaemonJsonRpcAt(
      endpoint,
      "repo.task.create",
      {
        repo: { repoId },
        payload: { taskId: CHILD_TASK_ID, title: CHILD_TITLE, parentTaskId: "task-gui-smoke" },
      },
      1_000,
      30_000,
    );
    assert.equal(created.ok, true, JSON.stringify(created));
    const packagePath = String(created.packagePath);
    const seedDir = path.join(rootDir, "harness", packagePath, "split");
    mkdirSync(seedDir, { recursive: true });
    const paths = [`${packagePath}/task_plan.md`];
    const sections = [
      "Brief",
      "Goal",
      "Context",
      "Required Reading",
      "Entry Conditions",
      "Dependencies",
      "Execution Surface",
      "Constraints",
      "Checkpoint",
      "Implementation Plan",
      "Deliverable Contract",
      "Evidence Protocol",
      "Verification",
    ];
    writeFileSync(
      path.join(rootDir, "harness", packagePath, "task_plan.md"),
      `# ${CHILD_TITLE}\n\nTask Contract: harness-task v1\n\n` +
        sections
          .map(
            (heading) =>
              `## ${heading}\n\nVerify page region movement in the isolated Electron fixture. Read packages/gui/src/renderer/components/primitives/page-regions.tsx. Keep all test data in this dedicated fixture repository; do not contact production services. Capture actual geometry, reload preferences, and reset the layout.\n`,
          )
          .join("\n") +
        "\n" +
        Array.from(
          { length: 80 },
          (_, index) =>
            `Layout evidence paragraph ${index}: the plan remains readable while its region scrolls independently.\n`,
        ).join("\n"),
    );
    for (let index = 0; index < SEED_FILES; index += 1) {
      const relative = `split/seed-${index}.md`;
      writeFileSync(
        path.join(rootDir, "harness", packagePath, relative),
        `# 种子文件 ${index}\n\n给文件树一个真实的长列表:第 ${index} 号占位正文。\n`,
      );
      paths.push(`${packagePath}/${relative}`);
    }
    const submitted = await requestDaemonJsonRpcAt(
      endpoint,
      "repo.task.run",
      {
        repo: { repoId },
        payload: { action: { kind: "doc-submit", paths } },
      },
      1_000,
      60_000,
    );
    assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));

    // The isolated repository starts without a commit. Seed a real delivery like work-progress-chain.
    writeFileSync(path.join(rootDir, "layout-fixture.txt"), "Isolated page layout delivery fixture.\n");
    execFileSync("git", ["-C", rootDir, "add", "layout-fixture.txt"], { stdio: "pipe" });
    execFileSync(
      "git",
      [
        "-C",
        rootDir,
        "-c",
        "user.name=gui-e2e",
        "-c",
        "user.email=gui-e2e@local",
        "commit",
        "-m",
        "test: seed layout fixture",
      ],
      { stdio: "pipe" },
    );
    writeFileSync(path.join(rootDir, "layout-fixture.txt"), "Isolated page layout delivery with history.\n");
    execFileSync("git", ["-C", rootDir, "add", "layout-fixture.txt"], { stdio: "pipe" });
    execFileSync(
      "git",
      [
        "-C",
        rootDir,
        "-c",
        "user.name=gui-e2e",
        "-c",
        "user.email=gui-e2e@local",
        "commit",
        "-m",
        "test: deliver layout fixture",
      ],
      { stdio: "pipe" },
    );
    const commitSha = execFileSync("git", ["-C", rootDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    for (const taskId of [CHILD_TASK_ID, "task-gui-smoke"]) {
      const started = await requestDaemonJsonRpcAt(
        endpoint,
        "repo.task.run",
        {
          repo: { repoId },
          payload: { action: { kind: "task-start", taskId, executionId: `execution-layout-${taskId}` } },
        },
        1000,
        30000,
      );
      assert.equal(started.ok, true, JSON.stringify(started));
    }

    // Submit/return creates real lifecycle history; releasing a lease does not end an execution.
    for (const [taskId, taskPackage] of [
      [CHILD_TASK_ID, packagePath],
      ["task-gui-smoke", fixture.packagePath],
    ]) {
      const closeoutPath = `${taskPackage}/closeout.md`;
      writeFileSync(
        path.join(rootDir, "harness", closeoutPath),
        "# Closeout\n\n## Summary\n\nIsolated GUI layout fixture round, with no production changes.\n\n## Verification\n\nThe fixture validates public lifecycle receipts before rendering history.\n\n## Residual Risk\n\nSynthetic fixture content is only used for layout verification.\n\n## Same Mechanism Elsewhere\n\nRegion overflow is shared by the task and work timeline views.\n",
      );
      const authored = await requestDaemonJsonRpcAt(
        endpoint,
        "repo.task.run",
        { repo: { repoId }, payload: { action: { kind: "doc-submit", paths: [closeoutPath] } } },
        1000,
        30000,
      );
      assert.equal(authored.ok, true, JSON.stringify(authored));
      for (let index = 0; index < 3; index += 1) {
        const executionId = index === 0 ? `execution-layout-${taskId}` : `execution-layout-${taskId}-${index - 1}`;
        for (const action of [
          { kind: "task-submit", taskId, executionId, commitSha },
          {
            kind: "task-adjudicate",
            taskId,
            executionId,
            return: true,
            reason: "Continue the isolated layout fixture round",
          },
          { kind: "task-start", taskId, executionId: `execution-layout-${taskId}-${index}` },
        ]) {
          const receipt = await requestDaemonJsonRpcAt(
            endpoint,
            "repo.task.run",
            { repo: { repoId }, payload: { action } },
            1000,
            30000,
          );
          assert.equal(receipt.ok, true, JSON.stringify(receipt));
        }
      }
    }
    try {
      await resize(1440, 900);
      await page.getByTestId("app-sidebar").waitFor({ timeout: 30_000 });
      await openChildDetail(page);
      // 等文件清单投影追平:树里出现种子目录。
      await page.getByTestId("task-document-tree").filter({ hasText: "split/" }).waitFor({ timeout: 30_000 });

      const hidden = await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().map((window) => ({ visible: window.isVisible(), focused: window.isFocused() })),
      );
      assert.ok(
        hidden.every((window) => !window.visible && !window.focused),
        JSON.stringify(hidden),
      );
      await checkLayout(page, shot, "task-detail-content-grid", "files", "content", "task-wide");
      await expandSeedTree(page);
      const tree = await page
        .getByTestId("task-document-tree-scroll")
        .evaluate((node) => ({ height: node.clientHeight, scroll: node.scrollHeight }));
      assert.ok(tree.scroll > tree.height, "long tree scrolls inside its region");
      const timelineScroll = await page
        .getByTestId("task-progress-timeline")
        .locator("[data-region-scroll]")
        .evaluate((node) => {
          node.scrollTop = node.scrollHeight;
          return { client: node.clientHeight, scroll: node.scrollHeight, top: node.scrollTop };
        });
      assert.ok(
        timelineScroll.scroll > timelineScroll.client && timelineScroll.top > 0,
        `long timeline scrolls internally: ${JSON.stringify(timelineScroll)}`,
      );
      // 整块收起/恢复:文件树收起后区域消失、恢复回同一节点与阅读位置,折叠跨重载持久。
      await checkCollapseRestore(
        page,
        shot,
        "task-detail-content-grid",
        "files",
        '[data-testid="task-document-tree-scroll"]',
      );
      await page.getByTestId("task-overview-tab-controls-reset").click();
      await resize(1120, 800);
      await checkLayout(page, shot, "task-detail-content-grid", "files", "content", "task-narrow");
      await shot("task-plan-narrow");
      const body = await page.getByTestId("task-detail-panel-scroll").boundingBox();
      assert.ok(body.width > 300 && body.height > 160, `usable narrow body ${JSON.stringify(body)}`);
      await resize(1440, 900);
      await page.getByTestId("task-detail-work").click();
      await page.getByTestId("work-overview-board").waitFor();
      await checkLayout(page, shot, "work-overview-board", "structure", "recent", "work-wide");
      await resize(1120, 800);
      await checkLayout(page, shot, "work-overview-board", "structure", "recent", "work-narrow");
      await page.getByRole("tab", { name: /根任务|Root task/u }).click();
      await page.getByTestId("task-detail-view").waitFor();
      await checkLayout(page, shot, "task-detail-content-grid", "files", "content", "root-narrow", () =>
        page.getByRole("tab", { name: /根任务|Root task/u }).click(),
      );
      // 根任务详情的页级三块在窄窗口同样可停靠(上面 root-narrow 已验)。
      await resize(1440, 900);
      await shot("root-wide");
      // The work graph fills its own flex viewport; both narrow and wide
      // containers must fit the canvas without a horizontal scrollbar.
      await page.locator("#workspace-tab-graph").click();
      const graph = page.getByTestId("workspace-graph-scroll");
      await graph.waitFor();
      const graphLayouts = [];
      for (const width of [360, 900]) {
        await graph.evaluate((node, value) => {
          node.style.width = `${value}px`;
        }, width);
        graphLayouts.push(await assertUnscrolledLayout(graph));
        await shot(`work-graph-${width}`);
      }
      await graph.evaluate((node) => {
        node.style.width = "";
      });
      writeFileSync(path.join(runRoot, "work-graph-layout.json"), `${JSON.stringify(graphLayouts, null, 2)}\n`);

      await page.getByRole("button", { name: /^(?:总览|Overview)$/u }).click();
      await page.getByTestId("overview-board").waitFor();
      const overviewIds = await page
        .getByTestId("overview-board")
        .locator("[data-region]")
        .evaluateAll((nodes) => nodes.map((node) => node.dataset.region));
      assert.ok(overviewIds.length >= 2, `overview fixture needs multiple regions: ${overviewIds}`);
      const overviewStorageAfterDock = await page.evaluate(() =>
        globalThis.localStorage.getItem("harness:gui:split-layout"),
      );
      writeFileSync(path.join(runRoot, "overview-storage.json"), `${overviewStorageAfterDock ?? "null"}\n`);
      await checkOverviewColumn(page, shot, "overview-wide");
      await resize(1120, 800);
      await checkOverviewColumn(page, shot, "overview-narrow");
      await page.evaluate(() => globalThis.localStorage.setItem("harness-locale", "en-US"));
      await page.reload();
      await page.getByTestId("overview-board").waitFor();
      await shot("overview-en");
      await page.evaluate(() => globalThis.localStorage.setItem("harness-theme", "light"));
      await page.reload();
      await page.getByTestId("overview-board").waitFor();
      await assertUnscrolledLayout(page.getByTestId("overview-board"));
      await shot("overview-light");
      const finalWindows = await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().map((window) => ({ visible: window.isVisible(), focused: window.isFocused() })),
      );
      assert.ok(
        finalWindows.every((window) => !window.visible && !window.focused),
        JSON.stringify(finalWindows),
      );
    } finally {
      // ---- 清理:软删子任务(soft 需要 reason),不留工作根结构给同轮后续场景;
      //      清理失败不吞原始错误,挪到 finally 之外抛。 ----
      cleanupError = await requestDaemonJsonRpcAt(
        endpoint,
        "repo.task.run",
        {
          repo: { repoId },
          payload: {
            action: {
              kind: "task-delete",
              taskId: CHILD_TASK_ID,
              mode: "soft",
              reason: "scenario cleanup after split verification",
            },
          },
        },
        1_000,
        30_000,
      ).then(
        () => null,
        (error) => error,
      );
    }
    if (cleanupError !== null) throw cleanupError;
  },
};
