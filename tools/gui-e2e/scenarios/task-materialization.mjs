import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { requestDaemonJsonRpcAt } from "../../../packages/daemon/src/daemon-host/client/local-json-rpc-client.ts";

export default {
  id: "task-materialization",
  feature: "task-detail",
  lane: "isolated",
  description:
    "A node policy skips a task package; the hidden desktop restores it through the declared materialize action.",
  async run({ page, app, shot, fixture }) {
    const repo = { repoId: fixture.repoId },
      taskId = "task_materialization_gui",
      title = "按需物化任务文档";
    await page.getByRole("button", { name: /^(?:设置|Settings)$/u }).click();
    await page.getByTestId("settings-content").waitFor();
    await page.getByTestId("settings-tab-repository").click();
    const policy = page.getByTestId("settings-taskMaterializationPolicy-select");
    await policy.waitFor();
    await policy.selectOption("none");
    await page.getByTestId("settings-repository-save").click();
    await page.waitForFunction(async (repoId) => {
      const read = await globalThis.window.harness.request("getSettings", { repoId });
      return read.settings?.nodeTaskMaterializationPolicy === "none";
    }, fixture.repoId);
    await policy.scrollIntoViewIfNeeded();
    await shot("node-materialization-setting");
    const created = await requestDaemonJsonRpcAt(
      fixture.endpoint,
      "repo.task.create",
      { repo, payload: { taskId, title } },
      1000,
      30000,
    );
    assert.equal(created.ok, true, JSON.stringify(created));
    const packagePath = created.packagePath;
    assert.equal(typeof packagePath, "string", JSON.stringify(created));
    const plan = path.join(fixture.rootDir, "harness", packagePath, "task_plan.md");
    assert.equal(existsSync(plan), false);
    await page.getByRole("button", { name: /^(?:看板|Board)$/u }).click();
    const card = page.getByTestId("board-task-card").filter({ hasText: title }).first();
    await card.waitFor({ timeout: 20000 });
    await card.click();
    await page.getByRole("button", { name: /打开完整详情|Open full details/u }).click();
    await page.getByTestId("task-detail-view").waitFor();
    await page.getByTestId("drawer-backdrop").waitFor({ state: "hidden" });
    const button = page.getByTestId("task-materialize");
    await button.waitFor();
    await page.waitForFunction(
      () => globalThis.document.querySelector('[data-testid="task-materialize"]')?.disabled === false,
    );
    await shot("task-materialization-skipped");
    await button.click();
    await page.waitForFunction(() => globalThis.document.querySelector('[data-testid="task-materialize"]') === null);
    assert.equal(existsSync(plan), true);
    await shot("task-materialization-restored");
    const windows = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((window) => ({ visible: window.isVisible(), focused: window.isFocused() })),
    );
    assert.ok(
      windows.length > 0 && windows.every((window) => !window.visible && !window.focused),
      JSON.stringify(windows),
    );
  },
};
