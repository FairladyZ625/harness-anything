import assert from "node:assert/strict";
import { bridgeReady, nav } from "./helpers.mjs";

export default {
  id: "shell-navigation",
  feature: "shell-navigation",
  lane: "both",
  description: "Preload, projection, primary navigation, and history render without console errors.",
  async run({ page, app }) {
    await bridgeReady(page);
    await nav(page, /^(?:看板|Board)$/u, "board-task-card");
    await nav(page, /^(?:会话|Sessions)$/u, "sessions-view");
    await nav(page, /^(?:Agent · 含 Squad|Agents · Squads)$/u, "agent-squad-view");
    const history = page.getByTestId("nav-history-bar");
    await history.getByRole("button", { name: /(?:后退|Back)/u }).click();
    await page.getByTestId("sessions-view").waitFor();
    await history.getByRole("button", { name: /(?:前进|Forward)/u }).click();
    await page.getByTestId("agent-squad-view").waitFor();
    const windows = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((window) => ({ visible: window.isVisible(), focused: window.isFocused() })),
    );
    assert.ok(windows.length > 0);
    assert.ok(
      windows.every((window) => !window.visible && !window.focused),
      "Automated windows must stay hidden and unfocused",
    );
  },
};
