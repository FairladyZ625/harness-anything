import { nav } from "./helpers.mjs";

export default {
  id: "decisions",
  feature: "decisions",
  lane: "isolated",
  description: "Decision approval and pool surfaces render seeded projections.",
  async run({ page }) {
    // The pool nav button carries a live badge count in its accessible name, so match a prefix.
    await nav(page, /^(?:待办签发|Approvals|Sign-offs)/u, "attestation-pool-total");
    // The pool domains are underline Tabs since the visual-baseline rework (PR #3129); the tab
    // accessible name carries a live count suffix, so match the label prefix.
    await page.getByRole("tab", { name: /^(?:决策待裁|Decisions to judge)/u }).click();
    await page.getByText("Expose the triadic projection to the GUI", { exact: false }).first().waitFor();
    await page.getByTestId("attestation-pool-focus-entry").click();
    await page.getByText(/决策待裁 · 专注模式|Pending decisions · focus mode/u).waitFor();
  },
};
