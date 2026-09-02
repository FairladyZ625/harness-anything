import assert from "node:assert/strict";

export default {
  id: "terminal-panes",
  feature: "terminal-panes",
  lane: "isolated",
  description: "Terminal panes split, expose context menu, and close without closing the window.",
  async run({ page }) {
    await page.getByRole("button", { name: /^(?:终端|Terminal)$/u }).click();
    if ((await page.locator("[data-pane-id]").count()) === 0) {
      await page.getByLabel(/新建终端|New terminal/u).click();
      await page.locator("[data-pane-id]").first().waitFor();
    }
    await page.locator("[data-pane-id]").first().click();
    const before = await page.locator("[data-pane-id]").count();
    await page.keyboard.press("Control+Meta+ArrowRight");
    await page.waitForFunction(
      (count) => globalThis.document.querySelectorAll("[data-pane-id]").length > count,
      before,
    );
    const panes = page.locator("[data-pane-id]");
    await panes.first().locator("[draggable]").dragTo(panes.last());
    assert.equal(await panes.count(), before + 1, "drag rearrange must preserve both panes");
    await page.locator("[data-pane-id]").last().click({ button: "right" });
    await page.getByTestId("terminal-pane-menu").waitFor();
    await page.keyboard.press("Escape");
    await page.keyboard.press("Meta+W");
    assert.equal(page.context().pages().length, 1);
  },
};
