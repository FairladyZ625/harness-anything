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
    // The keyboard shortcut is covered by the renderer unit test. Use the pane action here so the
    // isolated Electron journey remains stable when xterm owns focus or the host intercepts chords.
    await page.getByRole("button", { name: /向右分屏|Split right/u }).first().click();
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
    await page
      .locator("[data-pane-id]")
      .last()
      .getByRole("button", { name: /关闭 pane|Close pane/u })
      .click();
    assert.equal(page.context().pages().length, 1);
  },
};
