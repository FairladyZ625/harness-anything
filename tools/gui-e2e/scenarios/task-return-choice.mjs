import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { requestDaemonJsonRpcAt } from "../../../packages/daemon/src/client/local-json-rpc-client.ts";
import { bridgeReady } from "./helpers.mjs";

export default {
  id: "task-return-choice",
  feature: "board",
  lane: "isolated",
  description:
    "Returning a submitted task requires explicit worker mode and feedback, and cancellation writes nothing.",
  async run({ page, fixture, shot, app }) {
    const taskId = "task-gui-smoke";
    let deliveryCommitSha = null;
    for (const action of [
      { kind: "task-start", taskId },
      { kind: "task-submit", taskId },
    ]) {
      if (action.kind === "task-submit") {
        writeFileSync(
          path.join(fixture.rootDir, "harness", fixture.packagePath, "closeout.md"),
          "# Closeout\n\n## Summary\n\nReturn dialog fixture is ready.\n\n## Verification\n\nIsolated GUI task flow.\n\n## Residual Risk\n\nNo production writes.\n\n## Same Mechanism Elsewhere\n\nTask detail and work overview share the return dialog.\n",
        );
        writeFileSync(path.join(fixture.rootDir, "delivery-review.txt"), "delivery diff is observable\n");
        execFileSync("git", ["-C", fixture.rootDir, "add", "--", "delivery-review.txt"]);
        execFileSync("git", [
          "-C",
          fixture.rootDir,
          "-c",
          "user.name=GUI E2E Fixture",
          "-c",
          "user.email=gui-e2e-fixture@example.invalid",
          "commit",
          "--allow-empty",
          "-m",
          "test: return dialog delivery",
        ]);
        action.commitSha = execFileSync("git", ["-C", fixture.rootDir, "rev-parse", "HEAD"], {
          encoding: "utf8",
        }).trim();
        deliveryCommitSha = action.commitSha;
      }
      const receipt = await requestDaemonJsonRpcAt(
        fixture.endpoint,
        "repo.task.run",
        { repo: { repoId: fixture.repoId }, payload: { action } },
        1000,
        10000,
      );
      assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
    }
    const deliveryDiff = await requestDaemonJsonRpcAt(
      fixture.endpoint,
      "repo.tasks.deliveryDiff.read",
      { repo: { repoId: fixture.repoId }, payload: { taskId } },
      1000,
      10000,
    );
    assert.equal(deliveryDiff.ok, true, JSON.stringify(deliveryDiff));
    assert.equal(deliveryDiff.commitSha, deliveryCommitSha, JSON.stringify(deliveryDiff));
    assert.ok(deliveryDiff.files?.length > 0, JSON.stringify(deliveryDiff));
    await bridgeReady(page);
    const rendererDiff = await page.evaluate(
      async ({ repoId, taskId }) => {
        if (!globalThis.harness?.getTaskDeliveryDiff) return { missing: true };
        return globalThis.harness.getTaskDeliveryDiff({ repoId, taskId });
      },
      { repoId: fixture.repoId, taskId },
    );
    assert.ok(rendererDiff?.files?.length > 0, JSON.stringify(rendererDiff));
    await page.getByRole("button", { name: /^(?:看板|Board)$/u }).click();
    await page.getByTestId("board-task-card").filter({ hasText: "Render the real triadic projection" }).first().click();
    await page
      .locator('aside [title^="task_"]')
      .or(page.getByRole("button", { name: /打开完整详情|Open full details/u }))
      .first()
      .click();
    await page.getByRole("tab", { name: /收口与门|Closeout|收口/u }).click();
    assert.equal(await page.getByTestId("task-delivery-diff-count").innerText(), "1");
    const diff = page.locator('[data-testid="annotate-diff"]:visible').first();
    await diff.waitFor();
    await diff.scrollIntoViewIfNeeded();
    await shot("task-closeout-diff-review");
    await page.getByTestId("task-triage-return").click();
    const dialog = page.getByTestId("task-return-dialog");
    await dialog.waitFor();
    assert.equal(await page.getByTestId("task-return-resume").isDisabled(), true);
    assert.equal(await page.getByTestId("task-return-fresh").isDisabled(), true);
    await dialog.getByRole("textbox").fill("Correct the parser edge case and retain the verified evidence.");
    assert.equal(await page.getByTestId("task-return-resume").isEnabled(), true);
    assert.equal(await page.getByTestId("task-return-fresh").isEnabled(), true);
    for (const width of [1440, 1120]) {
      await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 900), width);
      const bounds = await dialog.evaluate((element) => ({
        width: element.clientWidth,
        scrollWidth: element.scrollWidth,
      }));
      assert.ok(bounds.scrollWidth <= bounds.width);
      await shot(`task-return-choice-${width}`);
    }
    const windows = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((window) => ({ visible: window.isVisible(), focused: window.isFocused() })),
    );
    assert.ok(windows.every((window) => !window.visible && !window.focused));
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    assert.equal(await page.getByTestId("task-triage-return").isVisible(), true);
  },
};
