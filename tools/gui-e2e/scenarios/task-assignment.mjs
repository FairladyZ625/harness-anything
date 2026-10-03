import assert from "node:assert/strict";
import path from "node:path";
import { deriveBasePolicyGroups, effectivePolicyGroupScopes } from "@harness-anything/kernel";
import { signInAt } from "../../../packages/daemon/test/keycloak.fixtures.ts";
import { requestDaemonJsonRpcAt } from "../../../packages/daemon/src/client/local-json-rpc-client.ts";

export default {
  id: "task-assignment",
  feature: "task-detail",
  lane: "isolated",
  description: "Assign a task to a person, node and team with explicit expiry, then remove the assignment.",
  async run({ page, app, fixture, shot }) {
    const manage = (payload) =>
      requestDaemonJsonRpcAt(
        fixture.endpoint,
        "daemon.rbac.manage",
        { ...payload, repoId: fixture.repoId },
        1000,
        10000,
      );
    const node = await manage({
      operation: "node-register",
      credentialFile: path.join(fixture.userRoot, "assignment-node-credential.json"),
      nodeId: "assignment-node",
      personId: "person-gui",
      operationId: "assignment-node-create",
    });
    assert.equal(node.ok, true, JSON.stringify(node));
    const team = await manage({
      operation: "team-create",
      teamName: "Assignment team",
      operationId: "assignment-team-create",
    });
    assert.equal(team.ok, true, JSON.stringify(team));
    // Assignment selectors belong to task-assign, not the access-admin role.
    fixture.keycloak.revoke(
      "person-gui",
      fixture.repoId,
      effectivePolicyGroupScopes(deriveBasePolicyGroups(), "admin"),
    );
    fixture.keycloak.permit(
      "person-gui",
      fixture.repoId,
      effectivePolicyGroupScopes(deriveBasePolicyGroups(), "maintainer"),
    );
    signInAt(fixture.userRoot, "person-gui", []);
    const adminDenied = await manage({ operation: "node-list" });
    assert.equal(adminDenied.ok, false, JSON.stringify(adminDenied));
    await page.getByRole("button", { name: /^(?:看板|Board)$/u }).click();
    await page.getByTestId("board-task-card").filter({ hasText: "Render the real triadic projection" }).click();
    await page.getByRole("button", { name: /打开完整详情|Open full details/u }).click();
    await page.getByRole("tab", { name: /^(?:派工|Dispatch)$/u }).click();
    const panel = page.getByTestId("task-assignment-panel");
    await panel.waitFor();
    const read = async () => {
      const result = await requestDaemonJsonRpcAt(
        fixture.endpoint,
        "repo.tasks.list",
        { repo: { repoId: fixture.repoId }, payload: {} },
        1000,
        10000,
      );
      return result.rows.find((row) => row.taskId === "task-gui-smoke").snapshot.task.assignment;
    };
    for (const kind of ["person", "node", "team"]) {
      await page.getByTestId("task-assignment-kind").selectOption(kind);
      await page.waitForFunction(
        () => globalThis.document.querySelector('[data-testid="task-assignment-target"]').options.length > 1,
      );
      await page.getByTestId("task-assignment-target").selectOption({ index: 1 });
      await page.getByTestId("task-assignment-expiry").fill("2099-01-01T12:00");
      await page.getByTestId("task-assignment-save").click();
      await page.waitForFunction(
        () => !globalThis.document.querySelector('[data-testid="task-assignment-save"]').disabled,
      );
      const assignment = await read();
      assert.equal(assignment.assignee.kind, kind === "team" ? "team" : "person");
      if (kind === "node") assert.equal(assignment.assignee.nodeId, "assignment-node");
      assert.ok(assignment.expiresAt.startsWith("2099-01-01"));
    }
    const windows = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((window) => ({ visible: window.isVisible(), focused: window.isFocused() })),
    );
    assert.ok(windows.length && windows.every((window) => !window.visible && !window.focused));
    await shot("task-assignment-team");
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1120, 860));
    await page.waitForFunction(() => globalThis.innerWidth === 1120);
    assert.equal(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1), true);
    await page.getByTestId("task-assignment-kind").press("Tab");
    assert.equal(
      await page
        .getByTestId("task-assignment-target")
        .evaluate((element) => element === globalThis.document.activeElement),
      true,
    );
    await shot("task-assignment-narrow");
    await page.getByTestId("task-assignment-remove").click();
    await page.waitForFunction(
      () =>
        globalThis.document.querySelector('[data-testid="task-assignment-remove"]').disabled &&
        !globalThis.document.querySelector('[data-testid="task-assignment-save"]').disabled,
    );
    assert.equal(await read(), null);
  },
};
