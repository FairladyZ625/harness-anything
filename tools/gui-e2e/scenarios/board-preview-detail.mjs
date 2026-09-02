export default {
  id: "board-preview-detail",
  feature: "board",
  lane: "isolated",
  description: "A board card opens its preview drawer and full task detail.",
  async run({ page }) {
    await page.getByRole("button", { name: /^(?:看板|Board)$/u }).click();
    await page.getByTestId("board-task-card").first().click();
    await page
      .locator('aside [title^="task_"]')
      .or(page.getByRole("button", { name: /打开完整详情|Open full details/u }))
      .first()
      .click();
    await page.getByTestId("task-detail-view").waitFor();
  },
};
