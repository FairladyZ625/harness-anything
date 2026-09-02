export default {
  id: "terminal-sidebar",
  feature: "terminal-sidebar",
  lane: "isolated",
  description: "Terminal launch, attach, and sidebar resize controls are interactive.",
  async run({ page }) {
    await page.getByTestId("terminal-launch-options").click();
    await page.getByTestId("terminal-launch-options").waitFor();
    await page.keyboard.press("Escape");
    await page.getByTestId("terminal-attach").click();
    await page.getByTestId("terminal-attach-list").waitFor();
    await page.keyboard.press("Escape");
    await page.getByTestId("terminal-sidebar-resize").waitFor();
  },
};
