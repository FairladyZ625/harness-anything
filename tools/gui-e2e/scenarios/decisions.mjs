import assert from "node:assert/strict";
import { nav } from "./helpers.mjs";

export default {
  id: "decisions",
  feature: "decisions",
  lane: "isolated",
  description:
    "Decision approval and pool surfaces render seeded projections; the decision body tab fills its pane with the shared reader.",
  async run({ page, shot }) {
    // The pool nav button carries a live badge count in its accessible name, so match a prefix.
    await nav(page, /^(?:待办签发|Approvals|Sign-offs)/u, "attestation-pool-total");
    // The pool domains are underline Tabs since the visual-baseline rework (PR #3129); the tab
    // accessible name carries a live count suffix, so match the label prefix.
    await page.getByRole("tab", { name: /^(?:决策待裁|Decisions to judge)/u }).click();
    await page.getByText("Expose the triadic projection to the GUI", { exact: false }).first().waitFor();

    // ——— 决策正文页签(chrome 收敛 S1):行 → 抽屉 → 抽屉内决策 ID 链接进完整详情 ———
    // DocReader 默认 fill:正文区撑满页签面板,滚动收在阅读器内部,不再被 55cqb 卡截断。
    await page.getByText("Expose the triadic projection to the GUI", { exact: false }).first().click();
    await page.getByRole("dialog").getByRole("button", { name: "decision/dec_gui_smoke" }).first().click();
    await page.getByTestId("decision-body-document").waitFor();
    const reader = page.getByTestId("doc-reader").first();
    await reader.waitFor();
    const fill = await reader.evaluate((node) => {
      // 量具是页签面板(定高):收缩包裹的直接父层在卡形态下也会贴住 reader,量不出截断。
      const panel = node.closest('[data-testid="decision-panel-body"]');
      if (panel === null) return { ratio: 0, note: "decision-panel-body missing" };
      const own = node.getBoundingClientRect();
      const host = panel.getBoundingClientRect();
      const pad =
        parseFloat(globalThis.getComputedStyle(panel).paddingBottom || "0") +
        parseFloat(globalThis.getComputedStyle(panel).paddingTop || "0");
      return { ratio: own.height / Math.max(1, host.height - pad) };
    });
    assert.ok(
      fill.ratio > 0.9,
      `decision body reader must fill its pane (fill ratio ${fill.ratio.toFixed(2)}), not sit in a capped card`,
    );
    await shot("decision-detail-body");

    // ——— 原有覆盖:决策池 → 专注裁决模式 ———
    await nav(page, /^(?:待办签发|Approvals|Sign-offs)/u, "attestation-pool-total");
    await page.getByRole("tab", { name: /^(?:决策待裁|Decisions to judge)/u }).click();
    await page.getByText("Expose the triadic projection to the GUI", { exact: false }).first().waitFor();
    await page.getByTestId("attestation-pool-focus-entry").click();
    await page.getByText(/决策待裁 · 专注模式|Pending decisions · focus mode/u).waitFor();
  },
};
