import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { nav } from "./helpers.mjs";

export default {
  id: "runtime-handoff",
  feature: "runtime-handoff",
  lane: "isolated",
  description:
    "Stopped Codex session exposes explicit handoff actions and displays a real ineligible-source rejection.",
  async run({ page, app, shot }) {
    const visible = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().some((w) => w.isVisible() || w.isFocused()),
    );
    assert.equal(visible, false);
    await nav(page, /^(?:会话|Sessions)$/u, "sessions-view");
    const group = page.getByTestId("session-group-task-e2e-single");
    await group.waitFor();
    await page.getByTestId("session-group-toggle-task-e2e-single").click();
    const hash = createHash("sha256").update("gui-e2e-catalog\0single-1").digest("hex");
    await page.getByTestId(`rail-session-runtime_${hash.slice(24, 48)}`).click();
    const panel = page.getByTestId("runtime-handoff");
    await panel.waitFor();
    await panel.getByTestId("handoff-instance").click();
    await panel.getByTestId("handoff-instance").fill("target-codex");
    assert.equal(await panel.getByTestId("handoff-instance").inputValue(), "target-codex");
    await panel.getByTestId("handoff-prompt").fill("Continue the same conversation.");
    await panel.getByTestId("handoff-export").click();
    await panel
      .getByRole("status")
      .filter({ hasText: /opted-in|ineligible|runtime_handoff/u })
      .waitFor();
    assert.equal(await panel.getByTestId("handoff-claim").isEnabled(), true);
    await shot("runtime-handoff-rejected-source");
  },
};
