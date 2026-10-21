import assert from "node:assert/strict";
import { bridgeReady, nav } from "./helpers.mjs";

export default {
  id: "shell-navigation",
  feature: "shell-navigation",
  lane: "both",
  description: "Preload, projection, primary navigation, and history render without console errors.",
  async run({ page, app, shot }) {
    await bridgeReady(page);
    assert.equal(await page.getByRole("button", { name: /^(?:面板工作台|Panel Workbench)$/u }).count(), 0);
    await nav(page, /^(?:工作|Work)$/u, "work-view");
    await page.getByTestId("work-view").getByRole("status").waitFor({ state: "hidden" });
    await shot("shell-work");
    await page.getByRole("button", { name: /^(?:关系图|Graph)$/u }).click();
    await page.getByTestId("territory-chip").or(page.getByTestId("triadic-graph-empty-state")).first().waitFor();
    await shot("shell-graph");
    const modes = page.getByTestId("entity-workspace-mode-bar");
    await modes.getByRole("button", { name: "聚光灯", exact: true }).click();
    await page.getByTestId("graph-relation-basis").or(page.getByTestId("triadic-graph-empty-state")).waitFor();
    await shot("shell-graph-spotlight");
    await modes.getByRole("button", { name: /^演化史/u }).click();
    await page.getByTestId("genealogy-timeline").or(page.getByTestId("genealogy-empty")).waitFor();
    await shot("shell-graph-lineage");
    await modes.getByRole("button", { name: "领地", exact: true }).click();
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
