import { nav } from "./helpers.mjs";

export default {
  id: "sessions-artifacts",
  feature: "sessions-artifacts",
  lane: "isolated",
  description: "Session and artifact workspaces render against the isolated daemon.",
  async run({ page }) {
    await nav(page, /^(?:会话|Sessions)$/u, "sessions-view");
    await nav(page, /^(?:产物|Artifacts)$/u, "artifacts-view");
  },
};
