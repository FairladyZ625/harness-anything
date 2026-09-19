import { nav } from "./helpers.mjs";

export default {
  id: "decisions",
  feature: "decisions",
  lane: "isolated",
  description: "Decision approval and pool surfaces render seeded projections.",
  async run({ page }) {
    // The pool nav button carries a live badge count in its accessible name, so match a prefix.
    await nav(page, /^(?:待办签发|Approvals|Sign-offs)/u, "attestation-pool-total");
    await page.getByTestId("attestation-pool-domain-decisions").click();
    await page.getByText("Expose the triadic projection to the GUI", { exact: false }).first().waitFor();
    await page.getByTestId("attestation-pool-focus-entry").click();
    await page.getByText(/决策待裁 · 专注模式|Pending decisions · focus mode/u).waitFor();
  },
};
