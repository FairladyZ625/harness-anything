import { bridgeReady, nav } from "./helpers.mjs";

export default {
  id: "cadence-view",
  feature: "governance-cadence",
  lane: "isolated",
  description:
    "Governance → Cadence & Pulse renders HUD, rhythm track and blockers from the observe.tail event window; " +
    "a rhythm row expands in place (stage funnel + micro event chain) and its detail link routes to task detail, " +
    "without console errors.",
  async run({ page }) {
    await bridgeReady(page);
    await nav(page, /^(?:研发态势|Cadence & Pulse)$/u, "cadence-hud");
    await page.getByTestId("cadence-rhythm").waitFor();
    await page.getByTestId("cadence-blockers").waitFor();
    // 节拍音轨以 fixture 台账的真实事件立行:种子任务的立项阶段来自 observe.tail,
    // 不是空列表冒充。
    const rhythm = page.getByTestId("cadence-rhythm");
    const seededRow = rhythm.getByRole("button", { name: /Render the real triadic projection/u });
    await seededRow.waitFor();
    // 点击行 = 原地展开深度分析(阶段耗时漏斗 + 微型事件链),不路由跳走。
    await seededRow.click();
    await page.getByTestId("cadence-rhythm-detail").waitFor();
    await page.getByTestId("cadence-funnel").waitFor();
    await page.getByTestId("cadence-micro").waitFor();
    // 展开头部的「进入详情」外链才路由到任务详情。
    await page.getByRole("button", { name: /进入详情|Open detail/u }).click();
    await page.getByTestId("task-detail-view").waitFor();
  },
};
