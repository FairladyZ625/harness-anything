import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { prepareGuiReworkCut } from "../../../packages/gui/test-support/rework-task.mjs";
import { requestDaemonJsonRpcAt } from "../../../packages/daemon/src/client/local-json-rpc-client.ts";

export default {
  id: "task-rework",
  feature: "task-detail",
  lane: "isolated",
  description:
    "Arrange one returned round from the real task page, preserving authorization failure and canonical cut identity.",
  async run({ page, fixture, app, shot, runRoot }) {
    const cut = await prepareGuiReworkCut(fixture);
    const read = async () => {
      const receipt = await requestDaemonJsonRpcAt(
        fixture.endpoint,
        "repo.task.show",
        { repo: { repoId: fixture.repoId }, payload: { taskId: cut.taskId } },
        1000,
        10000,
      );
      assert.equal(receipt.ok, true, JSON.stringify(receipt));
      return JSON.parse(receipt.evidence);
    };
    const initial = await read(),
      target = initial.reworkTargets[0];
    assert.equal(target.executionId, cut.executionId);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900));
    await page.waitForFunction(() => globalThis.innerWidth === 1440);
    const openTask = async () => {
      await page.getByRole("button", { name: /^(?:看板|Board)$/u }).click();
      await page.getByTestId("board-task-card").filter({ hasText: cut.title }).first().click();
      await page.getByRole("button", { name: /打开完整详情|Open full details/u }).click();
      await page.getByRole("tab", { name: /^(?:派工|Dispatch)$/u }).click();
    };
    await page.getByRole("button", { name: /^(?:设置|Settings)$/u }).click();
    await page.getByRole("button", { name: /外观|Appearance/u }).click();
    await page.getByRole("button", { name: /亮色|Light/u }).click();
    await page.getByRole("button", { name: /语言|Language/u }).click();
    await page.getByLabel(/^语言$|^Language$/).selectOption("zh-CN");
    await openTask();
    const panel = page.getByTestId("task-rework-panel");
    await panel.waitFor();
    await page.getByTestId("task-rework-target").selectOption(cut.executionId);
    assert.equal(await page.getByTestId("task-rework-digest").getByTitle(target.submissionDigest).count(), 1);
    await page.getByTestId("task-rework-reason").fill("GUI owner arranges this round.");
    await page.getByTestId("task-rework-reason").press("Tab");
    assert.equal(
      await page.getByTestId("task-rework-agent").evaluate((element) => element === globalThis.document.activeElement),
      true,
    );
    fixture.keycloak.revoke("person-gui", fixture.repoId, ["task-rework"]);
    await page.getByTestId("task-rework-agent").press("Tab");
    await page.getByTestId("task-rework-submit").press("Enter");
    await page.waitForFunction(() =>
      globalThis.document
        .querySelector('[data-testid="task-rework-feedback"]')
        ?.textContent.includes("authorization_denied"),
    );
    assert.equal(await page.getByTestId("task-rework-feedback").getAttribute("role"), "alert");
    assert.equal((await read()).task.executionArrangement, undefined);
    await shot("task-rework-authorization-failure-wide");
    fixture.keycloak.permit("person-gui", fixture.repoId, ["task-rework"]);
    await page.getByTestId("task-rework-submit").click();
    await page.waitForFunction(() =>
      globalThis.document.querySelector('[data-testid="task-rework-feedback"]')?.textContent.includes("success"),
    );
    await page.waitForFunction(() =>
      globalThis.document.querySelector('[data-testid="task-rework-state"]')?.textContent.includes("交接已完成"),
    );
    const completed = await read();
    assert.equal(completed.task.executionArrangement.ready, true);
    assert.equal(completed.task.executionArrangement.executionId, cut.executionId);
    assert.equal(completed.task.executionArrangement.submissionDigest, target.submissionDigest);
    await shot("task-rework-ready-wide");
    await page.getByTestId("task-rework-submit").click();
    await page.waitForFunction(() =>
      globalThis.document.querySelector('[data-testid="task-rework-feedback"]')?.textContent.includes("success"),
    );
    const repeated = await read();
    assert.equal(repeated.task.iteration, completed.task.iteration);
    assert.equal(repeated.task.executionArrangement.id, completed.task.executionArrangement.id);
    assert.equal(repeated.executions.length, completed.executions.length);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1120, 860));
    await page.waitForFunction(() => globalThis.innerWidth === 1120);
    await page.getByRole("button", { name: /^(?:设置|Settings)$/u }).click();
    await page.getByRole("button", { name: /外观|Appearance/u }).click();
    await page.getByRole("button", { name: /暗色|Dark/u }).click();
    await openTask();
    await page.waitForFunction(() =>
      globalThis.document.querySelector('[data-testid="task-rework-state"]')?.textContent.includes("交接已完成"),
    );
    assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
    const geometry = await panel.evaluate((element) => ({
      width: element.clientWidth,
      contentWidth: element.scrollWidth,
      viewport: globalThis.innerWidth,
    }));
    assert.equal(geometry.viewport, 1120);
    assert.ok(geometry.contentWidth <= geometry.width + 1, JSON.stringify(geometry));
    const windows = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((window) => ({ visible: window.isVisible(), focused: window.isFocused() })),
    );
    assert.ok(windows.length && windows.every((window) => !window.visible && !window.focused));
    await shot("task-rework-ready-narrow");
    writeFileSync(
      path.join(runRoot, "task-rework-evidence.json"),
      JSON.stringify(
        {
          target,
          arrangement: completed.task.executionArrangement,
          repeatedArrangementId: repeated.task.executionArrangement.id,
          geometry,
          windows,
        },
        null,
        2,
      ) + "\n",
    );
  },
};
