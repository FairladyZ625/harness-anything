import assert from "node:assert/strict";
import { nav } from "./helpers.mjs";

/**
 * 总览板的停靠分屏交互(task_033760e2 的合并停靠;2026-10-11 业主意见返工后的默认板):
 * 「执行与下钻」占左上格、「最新产物」叠其下同列、「关注的工作」独占右列。这里断言
 * 默认次序、left 半区预览遮罩与取消、works 停进 drill 左半区的换序(两块各占 drill 原宽
 * 一半的半分契约)、重载保持、重置回位、键盘换序与列宽调缝(把手 Alt+方向键与 dv-sash
 * 指针拖拽;右列的缝是竖缝)。从 page-split-layout 拆出:一功能一场景,工作页/任务
 * 详情板的检查互不阻塞。
 */
async function checkOverviewBoard(page, shot, label, halfSplitAccepts) {
  const board = page.getByTestId("overview-board");
  const box = (id) => board.locator(`[data-region="${id}"]`).first().boundingBox();
  const handle = (id) => board.getByTestId(`region-handle-${id}`);
  const orderIs = (drillLeft) =>
    page.waitForFunction(
      (left) => {
        const boardNode = globalThis.document.querySelector('[data-testid="overview-board"]');
        const works = boardNode?.querySelector('[data-region="works"]');
        const drill = boardNode?.querySelector('[data-region="drill"]');
        if (works === null || drill === null) return false;
        return drill.getBoundingClientRect().x < works.getBoundingClientRect().x === left;
      },
      drillLeft,
      { timeout: 10_000 },
    );
  // 默认序(drule 左上格、artifacts 叠其下同列、works 独占右列)是 dockview 异步排布的
  // 收敛结果(面板先挂载再按列序 arrange):用等待而不是一次性断言,排布在途时不误判。
  const defaultOrderSettled = () =>
    page.waitForFunction(
      () => {
        const boardNode = globalThis.document.querySelector('[data-testid="overview-board"]');
        const by = (id) =>
          [...(boardNode?.querySelectorAll("[data-region]") ?? [])]
            .find((node) => node.dataset.region === id)
            ?.getBoundingClientRect();
        const works = by("works"),
          drill = by("drill"),
          artifacts = by("artifacts");
        if (!works || !drill || !artifacts) return false;
        return (
          drill.x < works.x &&
          Math.abs(drill.x - artifacts.x) <= 2 &&
          drill.bottom <= artifacts.y + 1 &&
          works.left >= drill.right - 1
        );
      },
      { timeout: 10_000 },
    );
  await handle("works").waitFor();
  await defaultOrderSettled();
  await shot(`${label}-before`);
  // 预览与取消:dragover 悬停 drill 左半区时目标亮 left 半区遮罩;dragend 取消后遮罩消失、
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
          clientX: rect.left + rect.width * 0.25,
          clientY: rect.top + rect.height / 2,
          dataTransfer,
        }),
      );
    },
    { sourceId: "works", targetId: "drill" },
  );
  if (halfSplitAccepts) {
    await board.getByTestId("region-drop-overlay-drill").waitFor();
    await shot(`${label}-preview`);
    await page.evaluate(() => {
      const handleNode = globalThis.document.querySelector(
        '[data-testid="overview-board"] [data-testid="region-handle-works"]',
      );
      handleNode.dispatchEvent(new globalThis.DragEvent("dragend", { bubbles: true }));
    });
    assert.ok(
      (await board.getByTestId("region-drop-overlay-drill").count()) === 0,
      `${label} cancel hides the overlay`,
    );
    await defaultOrderSettled();
  } else {
    // 窄窗下 drill 列装不下两块最小宽(2×200px):left 半区被诚实拒绝——没有预览遮罩、
    // 布局不动。停靠/重载/键盘/调缝的完整契约在宽窗一档覆盖。
    await page.waitForTimeout(250);
    assert.ok(
      (await board.getByTestId("region-drop-overlay-drill").count()) === 0,
      `${label} a drill cell under twice the minimum width must refuse the left-half preview`,
    );
    await page.evaluate(() => {
      const handleNode = globalThis.document.querySelector(
        '[data-testid="overview-board"] [data-testid="region-handle-works"]',
      );
      handleNode.dispatchEvent(new globalThis.DragEvent("dragend", { bubbles: true }));
    });
    await defaultOrderSettled();
    await shot(`${label}-refused`);
    return;
  }
  // 换序:works 停进 drill 左半区(drill 宽度远超两倍最小宽,方向可行),放下后 works 在左、
  // 两块各占 drill 原宽的一半(停靠的半分契约)。
  await dockRegion(page, "overview-board", "works", "drill", { x: 0.25, y: 0.5 });
  await orderIs(false);
  const [worksBox, drillBox] = await Promise.all([box("works"), box("drill")]);
  assert.ok(
    Math.abs(worksBox.width - drillBox.width) <= 8,
    `${label} dock halves the drill cell: ${worksBox.width} vs ${drillBox.width}`,
  );
  await shot(`${label}-moved`);
  // Reload preserves actual placement, not just a serialized preference.
  await page.reload();
  await handle("works").waitFor({ timeout: 30_000 });
  await orderIs(false);
  await shot(`${label}-reloaded`);
  await board.getByTestId("overview-board-controls-reset").click();
  await orderIs(true);
  await defaultOrderSettled();
  // 键盘换序:works 把手 ArrowLeft 把 works 停到左邻 drill 的左侧(方向可行才换序)。
  await handle("works").press("ArrowLeft");
  await orderIs(false);
  const [keyedWorks, keyedDrill] = await Promise.all([box("works"), box("drill")]);
  assert.ok(keyedWorks.x < keyedDrill.x, `${label} keyboard dock flips the column order`);
  await board.getByTestId("overview-board-controls-reset").click();
  await orderIs(true);
  // 列宽调缝:把手 Alt+方向键沿宽度增减(右列的缝是竖缝);dv-sash 指针拖拽同轴。方向取
  // ArrowLeft(收 works):收缩侧的余量是无条件的(增长侧会被左列的最小宽卡住)。
  const seamBefore = await box("works");
  await handle("works").press("Alt+ArrowLeft");
  const seamAfter = await box("works");
  assert.ok(
    Math.abs(seamAfter.width - seamBefore.width) >= 12,
    `${label} keyboard seam: ${seamBefore.width} -> ${seamAfter.width}`,
  );
  const sashStart = await box("works");
  await dragSash(page, board, sashStart, -40, "row");
  const sashResized = await box("works");
  assert.ok(Math.abs(sashResized.width - sashStart.width) > 10, `${label} sash resize`);
  await board.getByTestId("overview-board-controls-reset").click();
  await shot(`${label}-reset`);
}

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

async function dragSash(page, board, anchor, delta, axis) {
  const target = await board.evaluate(
    (node, { anchor: region, axis: dragAxis }) => {
      const box = (element) => element.getBoundingClientRect();
      const vertical = (rect) => rect.height >= rect.width,
        // 沿横轴拖 -> 拖竖缝;沿纵轴拖 -> 拖横缝。
        orientation = dragAxis === "row" ? vertical : (rect) => !vertical(rect),
        along = (rect) => (dragAxis === "row" ? rect.left + rect.width / 2 : rect.top + rect.height / 2),
        lo = dragAxis === "row" ? region.x : region.y,
        hi = dragAxis === "row" ? region.x + region.width : region.y + region.height,
        crosses = (rect) =>
          dragAxis === "row"
            ? rect.bottom > region.y && rect.top < region.y + region.height
            : rect.right > region.x && rect.left < region.x + region.width;
      const sash = [...node.querySelectorAll(".dv-sash")]
        .map((element) => ({ element, rect: box(element) }))
        .filter(({ rect }) => orientation(rect) && crosses(rect) && along(rect) >= lo - 2 && along(rect) <= hi + 2)[0];
      if (!sash) return null;
      const cross = dragAxis === "row" ? sash.rect.width / 2 : sash.rect.height / 2,
        fixed = dragAxis === "row" ? sash.rect.left + sash.rect.width / 2 : sash.rect.top + sash.rect.height / 2;
      for (const fraction of [0.85, 0.7, 0.5, 0.3, 0.15]) {
        const variable =
          dragAxis === "row"
            ? Math.min(region.y + region.height * fraction, sash.rect.bottom - cross - 1)
            : Math.min(region.x + region.width * fraction, sash.rect.right - cross - 1);
        const point =
          dragAxis === "row"
            ? { x: fixed, y: Math.max(sash.rect.top + cross + 1, variable) }
            : { y: fixed, x: Math.max(sash.rect.left + cross + 1, variable) };
        const hit = globalThis.document.elementFromPoint(point.x, point.y);
        if (hit === sash.element || sash.element.contains(hit)) return { point };
      }
      return null;
    },
    { anchor, axis },
  );
  assert.ok(target, `no ${axis === "row" ? "vertical" : "horizontal"} sash borders the measured region`);
  const { x, y } = target.point;
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

export default {
  id: "overview-split-board",
  feature: "overview",
  lane: "isolated",
  description:
    "The overview board's dock interactions on the 2026-10-11 default arrangement (drill top-left, artifacts " +
    "stacked below, works owning the right column): left-half preview and cancel, docking works into drill's " +
    "left half halves the drill cell, reload persists, reset restores, keyboard docks and the vertical seam " +
    "resizes by handle Alt+arrows and sash drag.",
  async run({ page, app, shot }) {
    await nav(page, /^(?:总览|Overview)$/u, "overview-view");
    await checkOverviewBoard(page, shot, "overview-board-wide", true);
    const actual = await app.evaluate(
      ({ BrowserWindow }, size) => {
        const window = BrowserWindow.getAllWindows()[0];
        window.setSize(size.width, size.height);
        return window.getContentSize();
      },
      { width: 1120, height: 800 },
    );
    await page.setViewportSize({ width: actual[0], height: actual[1] });
    await page.waitForFunction(([w, h]) => globalThis.innerWidth === w && globalThis.innerHeight === h, actual);
    await checkOverviewBoard(page, shot, "overview-board-narrow", false);
    await page.evaluate(() => globalThis.localStorage.setItem("harness-locale", "en-US"));
    await page.reload();
    await page.getByTestId("overview-board").waitFor();
    await shot("overview-board-en");
    await page.evaluate(() => globalThis.localStorage.setItem("harness-theme", "light"));
    await page.reload();
    await page.getByTestId("overview-board").waitFor();
    await shot("overview-board-light");
    const finalWindows = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((window) => ({ visible: window.isVisible(), focused: window.isFocused() })),
    );
    assert.ok(
      finalWindows.every((window) => !window.visible && !window.focused),
      JSON.stringify(finalWindows),
    );
  },
};
