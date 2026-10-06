import assert from "node:assert/strict";
import { requestDaemonJsonRpcAt } from "../../../packages/daemon/src/client/local-json-rpc-client.ts";

const TASK_ID = "task-explainer-landing";
const TITLE = "任务页默认打开 living explainer";

/**
 * #task_26f9a7c4 默认落点(explainer 优先):任务包带 artifacts/explainer.html 时——repo.task.create
 * 落任务即物化 explainer 骨架(kernel task-bootstrap 的 task.explainer 槽位)——从看板这种
 * 不带显式落点的入口打开任务详情,直接停在文件页签并选中 explainer 的隔离 webview 预览,
 * 不先落在概况的 task_plan。阴性对照(无 explainer 仍落概况)由 board-preview-detail 等依赖
 * 概况落点的场景与 packages/gui/test/task-detail-expression.vitest.ts 覆盖。
 */
export default {
  id: "task-detail-explainer-default",
  feature: "task-detail",
  lane: "isolated",
  description: "Opening a task whose package has artifacts/explainer.html lands on the files tab at that explainer.",
  async run({ page, app, shot, fixture }) {
    // 场景自建专属任务:born-with explainer 就是真实生产形态,不依赖夹具任务在板上的排序。
    const created = await requestDaemonJsonRpcAt(
      fixture.endpoint,
      "repo.task.create",
      { repo: { repoId: fixture.repoId }, payload: { taskId: TASK_ID, title: TITLE } },
      1_000,
      30_000,
    );
    assert.equal(created.ok, true, JSON.stringify(created));

    await page.getByRole("button", { name: /^(?:看板|Board)$/u }).click();
    const card = page.getByTestId("board-task-card").filter({ hasText: TITLE }).first();
    await card.waitFor({ timeout: 20_000 });
    await card.click();
    await page.getByRole("button", { name: /打开完整详情|Open full details/u }).click();
    await page.getByTestId("task-detail-view").waitFor();
    // 看板入口不带显式落点:等默认落点定案为文件页签(清单到达前正文停在占位)。
    await page.locator('#task-tab-files[aria-selected="true"]').waitFor();
    assert.equal(
      await page.getByTestId("html-artifact-webview").getAttribute("data-artifact-path"),
      "artifacts/explainer.html",
      "the explainer must be the default landing document",
    );
    await shot("task-explainer-default-landing");
    // 后台验收(gui-e2e 桌面焦点纪律):全程隐藏窗口,交互与截图走 Playwright/CDP。
    const hidden = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((window) => ({ visible: window.isVisible(), focused: window.isFocused() })),
    );
    assert.ok(
      hidden.every((window) => !window.visible && !window.focused),
      JSON.stringify(hidden),
    );
  },
};
