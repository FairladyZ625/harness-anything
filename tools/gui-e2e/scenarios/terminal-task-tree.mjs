export default {
  id: "terminal-task-tree",
  feature: "terminal-task-tree",
  lane: "isolated",
  description: "Task tree searches seeded tasks and binds the selected task.",
  async run({ page }) {
    await page.getByRole("button", { name: /^(?:终端|Terminal)$/u }).click();
    await page.getByTestId("terminal-launch-options").click();
    await page.getByTestId("terminal-task-tree").click();
    const search = page.getByTestId("terminal-task-tree-search");
    await search.fill("triadic");
    const hit = page.locator('[role="treeitem"][data-task-id][data-hit="true"]').first();
    await hit.waitFor();
    await hit.click();
  },
};
