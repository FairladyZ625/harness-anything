import { nav } from "./helpers.mjs";

export default {
  id: "overview-first-usable",
  feature: "overview",
  lane: "isolated",
  description: "Event-backed overview exposes a usable task and decision projection.",
  async run({ page }) {
    await nav(page, /^(?:总览|Overview)$/u, "real-task-summary");
    await page.getByText("Expose the triadic projection to the GUI", { exact: false }).first().waitFor();
  },
};
