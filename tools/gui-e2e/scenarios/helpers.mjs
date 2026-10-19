import assert from "node:assert/strict";

export async function bridgeReady(page) {
  assert.equal(await page.evaluate(() => typeof globalThis.harness), "object", "preload bridge unavailable");
  const ready = page.getByTestId("real-task-summary").or(page.getByTestId("task-empty-state"));
  const failed = page.getByTestId("task-error-state");
  await ready.or(failed).first().waitFor();
  if (await failed.isVisible()) throw new Error(await failed.innerText());
}

export async function nav(page, name, testId) {
  await page.getByRole("button", { name }).click();
  await page.getByTestId(testId).first().waitFor();
}

/**
 * 会话页在常驻工作索引有工作时默认按「工作 → 任务 → 会话」分组(PR #3790),
 * 任务组被折叠在工作桶里。只断言任务组的场景显式选「任务」维度;没有工作时
 * 默认已经是任务,这次点击是幂等的。
 */
export async function groupSessionsByTask(page) {
  const task = page.getByTestId("sessions-group-task");
  await task.waitFor();
  if ((await task.getAttribute("aria-pressed")) !== "true") await task.click();
}

// 对动画浮层断言/截图前必须等入场真正完成:Modal 等原语的面板自身是 motion 元素,
// 入场把计算样式 opacity 从 0 拉到 1(「减弱动态效果」下仍有更短的纯淡入,不取消),
// 取在中途就是半透明面板(task_2e9dedde 返工根因:机检只读声明背景 alpha,假绿)。
// 条件等待面板计算 opacity === "1";非 motion 元素(如快速切换浮层)立即成立。
export async function waitForEntrySettled(page, selector) {
  await page.waitForFunction((sel) => {
    const node = globalThis.document.querySelector(sel);
    return node !== null && globalThis.getComputedStyle(node).opacity === "1";
  }, selector);
}

/**
 * The native dialog top layer must never filter its own panel. Keep this check
 * separate from the browser evaluation so a unit test can exercise the failure
 * case without starting Electron.
 */
export function assertUnfilteredOverlayState(state, label) {
  assert.equal(state.panelFilter, "none", `${label} 面板 filter=${state.panelFilter} 必须为 none`);
  assert.equal(
    state.panelBackdropFilter,
    "none",
    `${label} 面板 backdrop-filter=${state.panelBackdropFilter} 必须为 none`,
  );
  assert.deepEqual(
    state.ancestorFilters,
    [],
    `${label} 面板祖先不能声明 filter/backdrop-filter: ${JSON.stringify(state.ancestorFilters)}`,
  );
  assert.equal(state.scrimFilter, "none", `${label} 遮罩 filter=${state.scrimFilter} 必须为 none`);
  assert.equal(
    state.scrimBackdropFilter,
    "none",
    `${label} 遮罩 backdrop-filter=${state.scrimBackdropFilter} 必须为 none; blur 只能在 dialog::backdrop`,
  );
}

// Measure the local surface: document.scrollWidth misses clipped children and
// forced scrollbars whose contents happen to fit.
export async function assertUnscrolledLayout(container, childSelector = ":scope > *") {
  const layout = await container.evaluate((node, selector) => {
    const box = node.getBoundingClientRect();
    const children = [...node.querySelectorAll(selector)]
      .filter((child) => child.getClientRects().length > 0)
      .map((child) => {
        const rect = child.getBoundingClientRect();
        return {
          left: rect.left - box.left,
          right: rect.right - box.left,
          top: rect.top - box.top,
          bottom: rect.bottom - box.top,
        };
      });
    const previous = node.scrollLeft;
    node.scrollLeft = 100;
    const scrollLeft = node.scrollLeft;
    node.scrollLeft = previous;
    return {
      width: box.width,
      height: box.height,
      client: node.clientWidth,
      scroll: node.scrollWidth,
      overflowX: globalThis.getComputedStyle(node).overflowX,
      scrollLeft,
      children,
    };
  }, childSelector);
  assert.ok(layout.width > 0 && layout.height > 0 && layout.children.length > 0, JSON.stringify(layout));
  assert.ok(
    !["auto", "scroll", "overlay"].includes(layout.overflowX),
    `surface must not scroll horizontally: ${JSON.stringify(layout)}`,
  );
  assert.ok(
    layout.scroll <= layout.client + 1 && layout.scrollLeft === 0,
    `content must fit locally: ${JSON.stringify(layout)}`,
  );
  assert.ok(
    layout.children.every(
      (child) =>
        child.left >= -1 && child.right <= layout.width + 1 && child.top >= -1 && child.bottom <= layout.height + 1,
    ),
    `visible children must remain inside the surface: ${JSON.stringify(layout)}`,
  );
  return layout;
}
