export default {
  id: "task-detail-open-terminal",
  feature: "task-detail",
  lane: "isolated",
  description: "Task detail launches a task-bound terminal.",
  async run({ page }) {
    if (!(await page.getByTestId("task-detail-view").isVisible())) {
      await page.getByRole("button", { name: /^(?:看板|Board)$/u }).click();
      await page.getByTestId("board-task-card").first().click();
      await page.getByRole("button", { name: /打开完整详情|Open full details/u }).click();
    }
    await page.getByTestId("task-detail-open-terminal").click();
    await page.getByTestId("terminal-view").waitFor();
    await page.locator("[data-pane-id]").first().waitFor();
  },
};
