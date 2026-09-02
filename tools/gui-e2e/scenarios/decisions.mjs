export default {
  id: "decisions",
  feature: "decisions",
  lane: "isolated",
  description: "Decision approval and pool surfaces render seeded projections.",
  async run({ page }) {
    await page.getByRole("button", { name: /决策批准|Decisions/u }).click();
    await page.getByRole("main").getByText("决策批准", { exact: true }).waitFor();
    await page.getByRole("button", { name: /决策池|Decision pool/u }).click();
    await page.getByText("Expose the triadic projection to the GUI", { exact: false }).first().waitFor();
  },
};
