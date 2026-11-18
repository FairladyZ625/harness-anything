import assert from "node:assert/strict";

export default {
  id: "terminal-sidebar",
  feature: "terminal-sidebar",
  lane: "isolated",
  readOnly: true,
  description: "Terminal launch, attach, and sidebar resize controls are interactive.",
  async run({ page }) {
    await page.getByRole("button", { name: /^(?:终端|Terminal)$/u }).click();
    const sidebar = page.getByTestId("terminal-sidebar");
    await sidebar.waitFor();

    await page.getByTestId("terminal-launch-options").click();
    const launchPanel = page.getByTestId("terminal-launch-options-panel");
    await launchPanel.waitFor();
    const tmuxButton = launchPanel.locator("button", { hasText: /^TMUX$/iu });
    const directButton = launchPanel.locator("button", { hasText: /^(?:直连|Direct)$/u });
    await tmuxButton.click();
    assert.equal(await tmuxButton.getAttribute("aria-pressed"), "true");
    await directButton.click();
    assert.equal(await directButton.getAttribute("aria-pressed"), "true");
    await page.keyboard.press("Escape");
    await launchPanel.waitFor({ state: "detached" });

    await page.getByTestId("terminal-attach").click();
    const attachPanel = page.getByTestId("terminal-attach-panel");
    await attachPanel.waitFor();
    await page.getByTestId("terminal-attach-list").waitFor();
    await page.keyboard.press("Escape");
    await attachPanel.waitFor({ state: "detached" });

    const resizeHandle = page.getByTestId("terminal-sidebar-resize");
    await resizeHandle.waitFor();
    const beforeBox = await sidebar.boundingBox();
    const handleBox = await resizeHandle.boundingBox();
    assert.ok(beforeBox && handleBox, "terminal sidebar and resize handle must have bounding boxes");
    await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(handleBox.x + handleBox.width / 2 + 64, handleBox.y + handleBox.height / 2);
    await page.mouse.up();
    const afterBox = await sidebar.boundingBox();
    assert.ok(afterBox && afterBox.width > beforeBox.width + 20, "dragging sidebar resize must widen terminal sidebar");
  },
};
