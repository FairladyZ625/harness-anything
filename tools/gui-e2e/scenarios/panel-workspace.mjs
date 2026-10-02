import assert from "node:assert/strict";

/**
 * 可定制面板工作台(task_f82b0d6058966986403ef1b635 检查点)的真实交互旅程:
 * 预设三面板 → 拖条移动(面板内容拖拽不移动面板)→ 边缩放 → reload 恢复 → 重置回预设
 * → 画板收缩后每个浮窗仍至少留一角在画板内。几何断言的基准:
 * - 同屏比较用「相对画板左上角」的偏移,不信视口绝对坐标(reload 前后 chrome 状态可不同);
 * - 恢复断言用槽里持久化的几何做基准(浮窗 offset 位与 geometryOf 同源),合成拖拽有
 *   收尾竞态,拖后的 DOM 读数不作为恢复基准;
 * - 等待一律 waitForFunction 轮询离散几何条件,不用墙钟 sleep。
 */
const PANEL = "[data-testid='floating-panel-body']";
const DOCUMENTS_OVERLAY = ".dv-resize-container:has([data-panel-id='documents'])";

async function offsetOf(page, selector) {
  return page.evaluate((target) => {
    const grid = globalThis.document.querySelector("[data-testid='floating-panel-grid']")?.getBoundingClientRect();
    const rect = globalThis.document.querySelector(target)?.getBoundingClientRect();
    if (!grid || !rect) return null;
    return { x: rect.x - grid.x, y: rect.y - grid.y, width: rect.width, height: rect.height };
  }, selector);
}

async function offsetNear(actual, expected, tolerance = 2) {
  assert.ok(actual, "panel box must be measurable");
  for (const axis of ["x", "y", "width", "height"]) {
    assert.ok(
      Math.abs(actual[axis] - expected[axis]) <= tolerance,
      `panel ${axis} ${actual[axis]} should stay near ${expected[axis]} (±${tolerance})`,
    );
  }
}

async function waitForOffset(page, selector, expected, tolerance = 2) {
  await page.waitForFunction(
    ({ selector, expected, tolerance }) => {
      const grid = globalThis.document.querySelector("[data-testid='floating-panel-grid']")?.getBoundingClientRect();
      const rect = globalThis.document.querySelector(selector)?.getBoundingClientRect();
      if (!grid || !rect) return false;
      return (
        Math.abs(rect.x - grid.x - expected.x) <= tolerance &&
        Math.abs(rect.y - grid.y - expected.y) <= tolerance &&
        Math.abs(rect.width - expected.width) <= tolerance &&
        Math.abs(rect.height - expected.height) <= tolerance
      );
    },
    { selector, expected, tolerance },
  );
}

async function dragBy(page, locator, dx, dy) {
  const box = await locator.boundingBox();
  assert.ok(box, "drag target must be measurable");
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  const steps = 8;
  for (let index = 1; index <= steps; index += 1) {
    await page.mouse.move(startX + (dx * index) / steps, startY + (dy * index) / steps);
  }
  await page.mouse.up();
}

export default {
  id: "panel-workspace",
  feature: "panel-workspace",
  lane: "isolated",
  description:
    "Workbench panels float on one canvas: titlebar-only drag, edge resize, reload restores the saved layout, reset returns the preset, and a shrunk canvas keeps every panel reachable.",
  async run({ page, shot }) {
    await page.getByRole("button", { name: /^(?:面板工作台|Panel Workbench)$/u }).click();
    await page.locator("[data-testid='floating-panel-grid']").waitFor();
    await page.locator(PANEL).first().waitFor();
    assert.equal(await page.locator(PANEL).count(), 3, "preset exposes documents/graph/timeline panels");

    const documentsBody = "[data-testid='floating-panel-body'][data-panel-id='documents']";
    const container = page.locator(".dv-resize-container").filter({ has: page.locator(documentsBody) });
    await container.locator(".dv-floating-titlebar").waitFor();

    const preset = await offsetOf(page, documentsBody);

    // 拖动只能从顶部拖条发起:按住拖条移动,面板跟手。
    await dragBy(page, container.locator(".dv-floating-titlebar"), 120, 48);
    const moved = await offsetOf(page, documentsBody);
    assert.ok(moved.x - preset.x > 60 && moved.y - preset.y > 20, "titlebar drag must move the panel");

    // 面板内容上的拖拽(图节点/选字一类)不移动面板。
    await dragBy(page, page.locator(documentsBody), 90, -60);
    await offsetNear(await offsetOf(page, documentsBody), moved);

    // 四边缩放:右边柄加宽。
    await dragBy(page, container.locator(".dv-resize-handle-right"), 80, 0);
    const resized = await offsetOf(page, documentsBody);
    assert.ok(resized.width - moved.width > 40, "edge resize must widen the panel");
    await shot("panel-workspace-arranged");

    // 拖/缩结束即落盘;槽里的几何就是恢复的契约基准。
    const stored = await page.evaluate(() => {
      const keys = Object.keys(globalThis.localStorage).filter((key) => key.startsWith("harness:gui:panel-workspace:"));
      if (keys.length !== 1) return null;
      try {
        return JSON.parse(globalThis.localStorage.getItem(keys[0]))?.layout?.documents ?? null;
      } catch {
        return null;
      }
    });
    assert.ok(stored, "dragged layout must be persisted before reload");

    // 重启(reload + 同一临时 profile)后按保存的几何恢复:浮窗回到槽里的 offset 位。
    await page.reload();
    await page.getByRole("button", { name: /^(?:面板工作台|Panel Workbench)$/u }).click();
    await waitForOffset(page, DOCUMENTS_OVERLAY, stored);
    await page.getByTestId("panel-documents-task").locator("option").first().waitFor({ state: "attached" });
    await page.getByTestId("panel-documents-body").waitFor();
    await shot("panel-workspace-restored");

    // 重置布局:清掉偏好,回预设几何。
    await page.getByTestId("panel-workbench-reset").click();
    await waitForOffset(page, documentsBody, preset, 4);

    // Every exposed edge/corner must actually resize, not merely exist in the DOM.
    await container.locator(".dv-floating-titlebar").click();
    await dragBy(page, container.locator(".dv-resize-handle-bottom"), 0, -240);
    await dragBy(page, container.locator(".dv-floating-titlebar"), 80, 80);
    for (const [direction, dx, dy] of [
      ["top", 0, -16],
      ["right", 16, 0],
      ["bottom", 0, 16],
      ["left", -16, 0],
      ["topleft", -16, -16],
      ["topright", 16, -16],
      ["bottomleft", -16, 16],
      ["bottomright", 16, 16],
    ]) {
      const before = await offsetOf(page, documentsBody);
      await dragBy(page, container.locator(`.dv-resize-handle-${direction}`), dx, dy);
      const after = await offsetOf(page, documentsBody);
      if (dx !== 0) assert.ok(after.width > before.width + 5, `${direction} must resize width`);
      if (dy !== 0) assert.ok(after.height > before.height + 5, `${direction} must resize height`);
    }
    const beforeMaximize = await offsetOf(page, documentsBody);
    await container.getByTestId("floating-panel-maximize").click();
    await page.waitForFunction(
      ({ selector, width }) => globalThis.document.querySelector(selector).getBoundingClientRect().width > width,
      { selector: documentsBody, width: beforeMaximize.width },
    );
    const maximized = await offsetOf(page, documentsBody);
    assert.ok(maximized.width > beforeMaximize.width, "maximize must expand the panel");
    await container.getByTestId("floating-panel-maximize").click();
    await waitForOffset(page, documentsBody, beforeMaximize, 4);

    // Fault injection is confined to this isolated renderer profile, not the user's storage.
    await page.evaluate(() => {
      const original = Storage.prototype.setItem;
      globalThis.__restorePanelStorage = () => {
        Storage.prototype.setItem = original;
      };
      Storage.prototype.setItem = function (key, value) {
        if (key.startsWith("harness:gui:panel-workspace:"))
          throw new DOMException("Test quota exhausted", "QuotaExceededError");
        return original.call(this, key, value);
      };
    });
    try {
      await dragBy(page, container.locator(".dv-floating-titlebar"), 16, 0);
      await page.getByTestId("floating-panel-persist-status").waitFor();
      await shot("panel-workspace-save-error");
    } finally {
      await page.evaluate(() => {
        globalThis.__restorePanelStorage();
        delete globalThis.__restorePanelStorage;
      });
    }
    await dragBy(page, container.locator(".dv-floating-titlebar"), 16, 0);
    await page.getByTestId("floating-panel-persist-status").waitFor({ state: "hidden" });

    // 画板收缩后每个浮窗至少留一角在画板内。主窗口有 1120×720 的最小尺寸,窗口本身
    // 缩不进去;直接收画板元素,驱动 dockview 的 ResizeObserver → layout →
    // constrainBounds 路径——侧栏展开挤占画板走的是同一机制。
    await page.evaluate(() => {
      const grid = globalThis.document.querySelector("[data-testid='floating-panel-grid']");
      grid.style.width = "700px";
      grid.style.height = "460px";
    });
    const reachable = await page.waitForFunction(() => {
      const canvas = globalThis.document.querySelector("[data-testid='floating-panel-grid']");
      if (!canvas) return false;
      const bounds = canvas.getBoundingClientRect();
      if (bounds.width > 720) return false;
      return [...canvas.querySelectorAll(".dv-resize-container")].every((node) => {
        const rect = node.getBoundingClientRect();
        return (
          rect.left < bounds.right && rect.right > bounds.left && rect.top < bounds.bottom && rect.bottom > bounds.top
        );
      });
    });
    assert.ok(await reachable.jsonValue(), "every panel must stay reachable after the canvas shrinks");
    await shot("panel-workspace-narrow-recovered");
    await page.evaluate(() => {
      const grid = globalThis.document.querySelector("[data-testid='floating-panel-grid']");
      grid.style.width = "";
      grid.style.height = "";
    });
  },
};
