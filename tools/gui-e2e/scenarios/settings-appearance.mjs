import assert from "node:assert/strict";

export default {
  id: "settings-appearance",
  feature: "settings",
  lane: "isolated",
  description: "UI scale and light/dark theme controls update computed appearance.",
  async run({ page }) {
    await page.getByRole("button", { name: /^(?:设置|Settings)$/u }).click();
    await page.getByTestId("settings-content").waitFor();
    await page.getByRole("button", { name: /外观|Appearance/u }).click();
    const body = page.locator(".ui-body").first();
    const before = await body.evaluate((node) => globalThis.getComputedStyle(node).fontSize);
    await page.getByRole("button", { name: /宽松|Comfortable/u }).click();
    const after = await body.evaluate((node) => globalThis.getComputedStyle(node).fontSize);
    assert.notEqual(after, before);
    await page.getByRole("button", { name: /亮色|Light/u }).click();
    assert.equal(await page.locator("html").getAttribute("data-theme"), "light");
    await page.getByRole("button", { name: /深色|Dark/u }).click();
    assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
  },
};
