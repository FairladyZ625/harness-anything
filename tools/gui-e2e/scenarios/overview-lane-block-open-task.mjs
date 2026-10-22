import assert from "node:assert/strict";
import { nav } from "./helpers.mjs";

/**
 * 总览任务列表与任务预览泳道场景:证明任务行能打开对应任务,任务预览里能按需展开
 * 该任务的执行泳道,而不是只有单测覆盖。
 *
 * 数据用隔离 lane 的夹具(不是 canonical 只读挂载):`task-e2e-lanes` 有一轮真实派工,
 * 总览「在跑的任务」里有真实任务行。canonical 仓库此刻没有稳定的任务样本,
 * 所以这条证据只能在隔离 lane 里种出来。
 *
 * 断言顺序与业主看到的一致:
 * ① 总览任务行可点且标题可读;② 点行落到该任务详情(复用现有导航入口);
 * ③ 同一条任务从看板开预览抽屉(业主 5.1:扫一眼就回去 → 抽屉);
 * ④ 预览里有「展开泳道」入口,展开后画出该任务的真实轮次块(不是生命周期条冒充)。
 */
export default {
  id: "overview-task-preview-lanes",
  feature: "overview",
  lane: "isolated",
  description: "A running task row opens its task; the task preview expands that task's lanes on demand.",
  async run({ page, shot, assertBackground }) {
    await nav(page, /^(?:总览|Overview)$/u, "overview-view");

    // ① 总览「在跑的任务」:真实任务名一行展示,点击行进入任务详情。
    const runningRow = page.locator('[data-running-row="task-e2e-lanes"]');
    await runningRow.waitFor({ timeout: 20_000 });
    const rowText = (await runningRow.innerText()).trim();
    assert.ok(rowText.includes("并行 Agent 泳道时间线"), `the running row must show its task title: ${rowText}`);
    await shot("01-overview-running-task-row");

    // ② 点块 → 该任务详情。标题必须是人话任务名(不是派工/执行 id)。
    await runningRow.click();
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
