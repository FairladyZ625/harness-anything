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
    // The pane only mounts after the spawn→list→attach round trip resolves; when that chain
    // rejects, the view surfaces role=alert instead. Race the two so a real spawn failure fails
    // fast with its own message instead of an opaque locator timeout, and give the spawn path a
    // bounded 60 s instead of the 20 s interaction default.
    const pane = page.locator("[data-pane-id]").first(),
      failure = page.getByTestId("terminal-view").getByRole("alert").filter({ hasText: /\S/u });
    await pane.or(failure).first().waitFor({ timeout: 60_000 });
    if (await failure.isVisible()) throw new Error(`terminal spawn failed: ${await failure.innerText()}`);
  },
};
