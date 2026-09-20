import { bridgeReady, nav } from "./helpers.mjs";

export default {
  id: "cadence-view",
  feature: "governance-cadence",
  lane: "isolated",
  description:
    "Governance → Cadence & Pulse renders HUD, rhythm track and blockers from the observe.tail event window without console errors.",
  async run({ page }) {
    await bridgeReady(page);
    await nav(page, /^(?:研发态势|Cadence & Pulse)$/u, "cadence-hud");
    await page.getByTestId("cadence-rhythm").waitFor();
    await page.getByTestId("cadence-blockers").waitFor();
    // 节拍音轨以 fixture 台账的真实事件立行:种子任务的立项阶段来自 observe.tail,
    // 不是空列表冒充。
    const rhythm = page.getByTestId("cadence-rhythm");
    await rhythm.getByRole("button", { name: /Render the real triadic projection/u }).waitFor();
  },
};
