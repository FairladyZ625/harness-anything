import assert from "node:assert/strict";

export default {
  id: "settings-appearance",
  feature: "settings",
  lane: "isolated",
  description:
    "UI scale and light/dark theme controls update computed appearance; the repository tab's presentation group " +
    "carries the watched-works activity-days setting.",
  async run({ page, shot }) {
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
    await page.getByRole("button", { name: /暗色|Dark/u }).click();
    assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
    // 仓库设置页的「呈现」组承载总览「关注的工作活动天数」(2026-10-11 意见 4):数字
    // 控件来自声明元数据,默认值 3 如实显示在名称旁。
    // 页签名带副标题(如「Repository · Rules shared by everyone」):按前缀匹配。
    await page.getByRole("button", { name: /^Repository|^仓库/u }).click();
    const field = page.locator('[data-testid="settings-overviewWatchedActivityDays-input"]');
    await field.waitFor({ timeout: 10_000 });
    assert.equal(await field.inputValue(), "3");
    await shot("settings-watched-activity-days");
  },
};
