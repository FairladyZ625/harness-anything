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
    // 业主验收要求设置项截图为中文界面:空夹具的 locale 未设置,仓库面板加载时会把
    // 界面回放成声明默认 en-US——先在语言页签把本机语言切成中文(写的是隔离夹具)。
    await page.getByRole("button", { name: /语言|Language/u }).click();
    await page.getByLabel(/^语言$|^Language$/).selectOption("zh-CN");
    // 仓库设置页的「呈现」组承载总览「关注的工作活动天数」(2026-10-11 意见 4):数字
    // 控件来自声明元数据,默认值 3 如实显示在名称旁。
    // 页签名带副标题(如「Repository · Rules shared by everyone」):按前缀匹配;
    // 「仓库 」带空格避免同时命中「仓库与连接」页签。
    await page.getByRole("button", { name: /^Repository |^仓库 /u }).click();
    const field = page.locator('[data-testid="settings-overviewWatchedActivityDays-input"]');
    await field.waitFor({ timeout: 10_000 });
    // 语言切换的 settings 写会让设置读失效重取:数字框在草稿值到达前短暂显示回退值 1,
    // 等值就位再断言(条件等待,不睡墙钟)。
    await page.waitForFunction(
      (testId) => globalThis.document.querySelector(`[data-testid="${testId}"]`)?.value === "3",
      "settings-overviewWatchedActivityDays-input",
      { timeout: 10_000 },
    );
    assert.equal(await field.inputValue(), "3");
    // 设置内容区是内层滚动容器,fullPage 截图只按文档高度截:不滚动的话拍到的是页顶。
    // 把「呈现」组标题滚入视口,组内唯一行(该字段)随组进入画面。
    await page.getByText("呈现", { exact: true }).first().scrollIntoViewIfNeeded();
    await shot("settings-watched-activity-days");
  },
};
