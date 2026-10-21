import assert from "node:assert/strict";
import { nav } from "./helpers.mjs";

/**
 * R8/R9 验收场景(GUI 验收 RETURN,dispatch_4298530a9dea90304dedf328):证明「点泳道块
 * 打开对应任务」与「任务预览里按需展开该任务的执行泳道」两条闭环真的在 Electron 里跑通,
 * 而不是只有单测覆盖。
 *
 * 数据用隔离 lane 的夹具(不是 canonical 只读挂载):`task-e2e-lanes` 有一轮真实派工,
 * 总览「进行中的任务」里画得出带 taskId 的块。canonical 仓库此刻只有一个 live 会话
 * (本 worker 自己),没有第二个可点的块,所以这条证据只能在隔离 lane 里种出来。
 *
 * 断言顺序与业主看到的一致:
 * ① 块有 button 语义、可读标签、点得动;② 点块落到该任务详情(复用现有导航入口);
 * ③ 同一条任务从看板开预览抽屉(业主 5.1:扫一眼就回去 → 抽屉);
 * ④ 预览里有「展开泳道」入口,展开后画出该任务的真实轮次块(不是生命周期条冒充)。
 */
export default {
  id: "overview-lane-block-open-task",
  feature: "overview",
  lane: "isolated",
  description: "Clicking a lane block opens its task; the task preview expands that task's lanes on demand.",
  async run({ page, shot, assertBackground }) {
    await nav(page, /^(?:总览|Overview)$/u, "overview-view");

    // ① 总览「执行与下钻 → 进行中的任务」:至少一块带 taskId 的真任务块(role=button)。
    await page.getByTestId("overview-drill-wip").click();
    await page.getByTestId("overview-agent-lanes").waitFor({ timeout: 20_000 });
    await page.waitForFunction(
      () =>
        [...globalThis.document.querySelectorAll('[data-testid^="overview-agent-lanes-task-"]')].some(
          (node) => node.getAttribute("role") === "button",
        ),
      null,
      { timeout: 20_000 },
    );
    const clickable = page.locator('[data-testid^="overview-agent-lanes-task-"][role="button"]').first();
    const blockLabel = await clickable.getAttribute("aria-label");
    assert.ok(blockLabel !== null && blockLabel.trim() !== "", "the clickable lane block must carry a readable label");
    // 没有 taskId 的兜底块是 role=group 的纯展示块:这里断言的是真入口,不是兜底块。
    assert.equal(await clickable.getAttribute("role"), "button");
    await shot("01-overview-lane-block-clickable");

    // ② 点块 → 该任务详情。标题必须是人话任务名(不是派工/执行 id)。
    await clickable.click();
    await page.getByTestId("task-detail-view").waitFor({ timeout: 20_000 });
    const detailTitle = (await page.locator('[data-testid="task-detail-header"] h1').first().innerText()).trim();
    assert.ok(detailTitle !== "", "the task detail must show a human task title");
    assert.ok(!/^(?:dispatch|execution|runtime)_/u.test(detailTitle), `title must not be a raw id: ${detailTitle}`);
    await shot("02-task-detail-opened-from-lane-block");

    // ③ 同一任务经看板卡片打开预览抽屉(不离开当前画面先看一眼)。
    await nav(page, /^(?:看板|Board)$/u, "board-task-card");
    await page.getByTestId("board-task-card").filter({ hasText: detailTitle }).first().click();

    // ④ 预览里的执行泳道:入口 → 展开 → 出现该任务的轮次块。
    const preview = page.locator('aside[role="dialog"]');
    await preview.waitFor({ timeout: 20_000 });
    const laneToggle = page.getByTestId("task-preview-lanes-toggle");
    await laneToggle.waitFor({ timeout: 20_000 });
    assert.equal(await laneToggle.getAttribute("aria-label"), "展开泳道");
    // 收起态只有入口,没有第二份时间线(§5.2 同一件东西只在一处展开)。
    assert.equal(await page.getByTestId("task-preview-lanes").count(), 0);
    await shot("03-task-preview-lanes-collapsed");

    await laneToggle.click();
    await page.getByTestId("task-preview-lanes").waitFor({ timeout: 20_000 });
    await page.locator('[data-testid^="task-preview-lane-task-"]').first().waitFor({ timeout: 20_000 });
    const laneStatuses = await page.evaluate(() =>
      [...globalThis.document.querySelectorAll('[data-testid^="task-preview-lane-task-"]')].map((node) =>
        node.getAttribute("data-lane-status"),
      ),
    );
    assert.ok(laneStatuses.length > 0, "the expanded preview must show at least one dispatch round");
    await shot("04-task-preview-lanes-expanded");

    // 证据必须来自后台运行:窗口全程不可见、不聚焦。
    await assertBackground();
  },
};
