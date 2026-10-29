import { requestDaemonJsonRpcAt } from "../../../packages/daemon/src/client/local-json-rpc-client.ts";
import assert from "node:assert/strict";
import { createAcceptedDecision } from "./decision-fixtures.mjs";

export default {
  id: "repository-todos",
  feature: "repository-todos",
  lane: "isolated",
  description: "Quick todos, completion disappearance, archive recovery and optional two-way attachment.",
  async run({ page, app, shot, consoleFailures, fixture }) {
    await page
      .getByRole("button", { name: /^(?:待办清单|Todos)$/u })
      .click()
      .catch((error) => {
        throw new Error(`${error.message}\nRenderer: ${consoleFailures.join("\n")}`, { cause: error });
      });
    const view = page.getByTestId("todos-view");
    await view.waitFor();
    const title = "Check the release notes";
    await view.getByTestId("todo-text").fill(title);
    await view.getByRole("button", { name: /^(?:添加|Add)$/u }).click();
    const row = view.locator('[data-testid^="todo-todo_"]').filter({ hasText: title });
    await row.waitFor();
    await shot("todos-open");
    await row.getByRole("checkbox").click();
    await row.waitFor({ state: "detached" });
    await view.getByRole("button", { name: /已完成与归档|Completed and archived/u }).click();
    await row.waitFor();
    await shot("todos-completed");
    await row.getByRole("button", { name: /^(?:找回|Restore)$/u }).click();
    await row.waitFor({ state: "detached" });
    await view.getByRole("button", { name: /返回未完成|Back to open/u }).click();
    await row.waitFor();
    await row.getByRole("button", { name: /^(?:归档|Archive)$/u }).click();
    await row.waitFor({ state: "detached" });
    await view.getByRole("button", { name: /已完成与归档|Completed and archived/u }).click();
    await row.getByRole("button", { name: /^(?:找回|Restore)$/u }).click();
    await row.waitFor({ state: "detached" });
    await view.getByRole("button", { name: /返回未完成|Back to open/u }).click();
    await row.getByRole("button", { name: /详情与关联|Details and relations/u }).click();
    await row.getByRole("textbox", { name: /关联实体引用|Related entity ref/u }).fill("task/task-gui-smoke");
    await row.getByRole("button", { name: /^(?:添加关联|Add relation)$/u }).click();
    const link = row.getByRole("button", { name: /task-gui-smoke/u });
    await link.waitFor();
    const windows = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((window) => ({ visible: window.isVisible(), focused: window.isFocused() })),
    );
    assert.ok(windows.length && windows.every((window) => !window.visible && !window.focused));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1120, 860));
    await page.waitForFunction(() => globalThis.innerWidth === 1120);
    assert.equal(await view.evaluate((element) => element.scrollWidth <= element.clientWidth + 1), true);
    await shot("todos-related-narrow");
    await link.click();
    const attached = page.getByTestId("attached-todos");
    await attached.getByText(title, { exact: true }).waitFor();
    await shot("task-attached-todos");
    const decisionId = await createAcceptedDecision(fixture.endpoint, fixture.repoId, "Todo promotion work direction");
    const work = await requestDaemonJsonRpcAt(
      fixture.endpoint,
      "repo.task.create",
      {
        repo: { repoId: fixture.repoId },
        payload: {
          title: "Todo promotion work",
          taskId: "task_todo_work",
          presetId: "create-work",
          taskClass: "work",
          decisionRef: decisionId,
        },
      },
      1000,
      10000,
    );
    assert.equal(work.ok, true, JSON.stringify(work));
    await page
      .getByTestId("app-sidebar-scroll")
      .getByRole("button", { name: /^(?:待办清单|Todos)$/u })
      .click();
    await row.getByRole("button", { name: /详情与关联|Details and relations/u }).click();
    await row.getByRole("textbox", { name: /工作根任务 ID|Work root task ID/u }).fill("task_todo_work");
    await row.getByRole("button", { name: /升级为任务|Promote to task/u }).click();
    await row.waitFor({ state: "detached" });
    await view.getByRole("button", { name: /已完成与归档|Completed and archived/u }).click();
    await row.waitFor();
    await row.getByRole("button", { name: /详情与关联|Details and relations/u }).click();
    await row.getByRole("button", { name: /详情与关联|Details and relations/u }).click();
    await row
      .getByRole("button", { name: /^task\//u })
      .nth(1)
      .waitFor();
    await shot("todos-promoted");
  },
};
