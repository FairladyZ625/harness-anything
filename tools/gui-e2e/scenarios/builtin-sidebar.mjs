/* global window, document, localStorage */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { seedBuiltinSidebar } from "./builtin-sidebar-seed.mjs";
import terminalBasics from "./terminal-basics.mjs";
import { bridgeReady } from "./helpers.mjs";

// The navigation source is the inventory: adding a sidebar item adds an acceptance step.
const navSource = readFileSync(
  new URL("../../../packages/gui/src/renderer/navigation/navConfig.tsx", import.meta.url),
  "utf8",
);
const labels = JSON.parse(
  readFileSync(new URL("../../../packages/gui/src/renderer/i18n/locales/zh-CN/rebuild.json", import.meta.url), "utf8"),
);
const ids = [
  ...navSource.slice(navSource.indexOf("export const NAV_GROUPS")).matchAll(/\{ id: "([^"]+)", icon:/gu),
].map((match) => match[1]);

export default {
  id: "builtin-sidebar",
  feature: "identity-provider",
  lane: "isolated",
  identityProvider: "builtin",
  description:
    "A real builtin owner opens every sidebar page, task detail, and assignment selectors without collaboration refusal.",
  async run({ page, shot, runRoot, assertBackground, fixture }) {
    const seeded = await seedBuiltinSidebar(fixture);
    await page.evaluate(() => localStorage.setItem("harness-motion", "off"));
    await page.reload();
    await bridgeReady(page);
    const results = [];
    await page.evaluate(() => {
      globalThis.__builtinCollaborationRefusals = 0;
      window.addEventListener("harness-collaboration-required", () => globalThis.__builtinCollaborationRefusals++);
    });
    for (const id of ids) {
      const label = labels[`shell.nav.${id}`];
      assert.ok(label, `missing navigation label for ${id}`);
      await page.getByTestId("app-sidebar-scroll").getByRole("button", { name: label, exact: true }).click();
      await page.waitForFunction(
        () =>
          ![...document.querySelectorAll('[role="status"]')].some(
            (node) => node.getClientRects().length && /正在加载|加载中|Loading/u.test(node.textContent),
          ),
      );
      const errors = await page.locator('[role="alert"]').allTextContents();
      assert.deepEqual(
        errors.filter((text) => text.trim()),
        [],
        `${id}: ${errors.join("\n")}`,
      );
      assert.equal(
        await page.getByTestId("collaboration-explanation").count(),
        0,
        `${id} must remain a usable ordinary page`,
      );
      if (["overview", "work"].includes(id))
        await page.getByText("Builtin owner work", { exact: true }).first().waitFor();
      if (id === "board") await page.getByTestId("board-task-card").filter({ hasText: "Builtin child task" }).waitFor();
      const screenshot = await shot(`builtin-${id}`);
      results.push({ id, label, result: "passed", screenshot });
      writeFileSync(path.join(runRoot, "sidebar-results.json"), JSON.stringify(results, null, 2));
    }
    assert.equal(await page.evaluate(() => globalThis.__builtinCollaborationRefusals), 0);
    await page
      .getByTestId("app-sidebar-scroll")
      .getByRole("button", { name: labels["shell.nav.board"], exact: true })
      .click();
    await page.getByTestId("board-task-card").filter({ hasText: "Builtin owner task" }).click();
    await page.getByRole("button", { name: /打开完整详情|Open full details/u }).click();
    await page.getByTestId("task-detail-view").waitFor();
    await shot("builtin-task-detail");
    await page.getByRole("tab", { name: /^(?:派工|Dispatch)$/u }).click();
    await page.getByTestId("task-assignment-panel").waitFor();
    for (const kind of ["person", "node", "team"]) {
      await page.getByTestId("task-assignment-kind").selectOption(kind);
      if (kind === "person")
        await page.waitForFunction(
          () => document.querySelector('[data-testid="task-assignment-target"]').options.length === 2,
        );
      await shot(`builtin-assignee-${kind}`);
    }
    assert.equal(await page.evaluate(() => globalThis.__builtinCollaborationRefusals), 0);
    await terminalBasics.run({ page });
    await shot("builtin-terminal-lifecycle");
    await page
      .getByTestId("app-sidebar-scroll")
      .getByRole("button", { name: labels["shell.nav.todos"], exact: true })
      .click();
    const todos = page.getByTestId("todos-view");
    await todos.getByTestId("todo-text").fill("Builtin owner todo");
    await todos.getByRole("button", { name: /^(?:添加|Add)$/u }).click();
    const todo = todos.locator('[data-testid^="todo-todo_"]').filter({ hasText: "Builtin owner todo" });
    await todo.waitFor();
    await shot("builtin-todo-created");
    await todo.getByRole("button", { name: "完成：Builtin owner todo", exact: true }).click();
    await todo.waitFor({ state: "detached" });
    await shot("builtin-todo-completed");
    await page
      .getByTestId("app-sidebar-scroll")
      .getByRole("button", { name: labels["shell.nav.work"], exact: true })
      .click();
    await page.getByText("Builtin owner work", { exact: true }).last().click();
    await page.getByText("Builtin child task", { exact: true }).last().waitFor();
    await shot("builtin-work-detail");
    await page.getByTestId("sidebar-account").click();
    await page.getByTestId("identity-access-view").waitFor();
    await shot("builtin-sidebar-account");
    for (const tab of ["devices", "grants", "requests", "groups", "teams", "service", "receipts"]) {
      await page.locator(`#identity-access-tab-${tab}`).click();
      await page.waitForFunction(
        () =>
          ![...document.querySelectorAll('[role="status"]')].some(
            (node) => node.getClientRects().length && /正在加载|加载中|Loading/u.test(node.textContent),
          ),
      );
      assert.equal(await page.getByTestId("collaboration-explanation").count(), 0, `local identity tab ${tab}`);
      await shot(`builtin-identity-${tab}`);
    }
    const refused = await page.evaluate(() => globalThis.harness.access.createTeam({ teamName: "Remote team" }));
    assert.equal(refused.code ?? refused.error?.code, "identity_plugin_required", JSON.stringify(refused));
    await page.getByTestId("collaboration-explanation").waitFor();
    await shot("builtin-collaboration-refusal");
    await page.getByTestId("project-switcher").click();
    await page
      .getByTestId("quick-switcher-panel")
      .getByRole("button", { name: /管理全部|管理所有|Manage all/u })
      .click();
    await page.getByTestId("home-view").waitFor();
    assert.equal(await page.getByTestId("collaboration-explanation").count(), 0);
    await shot("builtin-home");
    writeFileSync(path.join(runRoot, "seed.json"), JSON.stringify(seeded, null, 2));
    await assertBackground();
  },
};
