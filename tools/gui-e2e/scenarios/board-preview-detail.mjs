export default {
  id: "board-preview-detail",
  feature: "board",
  lane: "isolated",
  description: "A board card opens its preview drawer and full task detail.",
  async run({ page, shot }) {
    await page.getByRole("button", { name: /^(?:看板|Board)$/u }).click();
    await page.getByTestId("board-task-card").first().click();
    await page
      .locator('aside [title^="task_"]')
      .or(page.getByRole("button", { name: /打开完整详情|Open full details/u }))
      .first()
      .click();
    await page.getByTestId("task-detail-view").waitFor();
    await page.getByTestId("task-document-tree").waitFor();
    // 默认落点(explainer 优先,task_26f9a7c4):夹具任务经 repo.task.create 落地即带
    // born-with explainer,完整详情默认停在文件页签的 explainer 预览(不再先落 task_plan)。
    await page.locator('#task-tab-files[aria-selected="true"]').waitFor();
    await page.getByTestId("html-artifact-webview").waitFor();
    await page.locator("aside[role=dialog]").waitFor({ state: "hidden" });
    await shot("task-detail-documents");
  },
};
