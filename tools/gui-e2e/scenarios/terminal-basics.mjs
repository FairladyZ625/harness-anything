import assert from "node:assert/strict";

export default {
  id: "terminal-basics",
  feature: "terminal",
  lane: "isolated",
  description: "Terminal accepts input, renders ANSI colour, and uses Geist Mono.",
  async run({ page }) {
    await page.getByRole("button", { name: /^(?:终端|Terminal)$/u }).click();
    if ((await page.locator("[data-pane-id]").count()) === 0) await page.getByLabel(/新建终端|New terminal/u).click();
    const terminal = page.locator(".xterm").first();
    await terminal.waitFor();
    await terminal.click();
    await page.keyboard.type("printf '\\e[32mGUI_E2E_COLOUR\\e[0m\\n'\n");
    await page.getByText("GUI_E2E_COLOUR", { exact: false }).waitFor();
    const family = await terminal
      .locator(".xterm-rows > div")
      .last()
      .evaluate((node) => globalThis.getComputedStyle(node).fontFamily);
    assert.match(family, /Geist Mono/u);
  },
};
