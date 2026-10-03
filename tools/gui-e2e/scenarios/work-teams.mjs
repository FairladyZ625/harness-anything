import assert from "node:assert/strict";

export default {
  id: "work-teams",
  feature: "identity-access",
  lane: "isolated",
  description: "Create a native Keycloak team and change membership through the identity page.",
  async run({ page, app, shot }) {
    await page.getByRole("button", { name: /^(?:账号与访问控制|Identity & access)$/u }).click();
    await page.getByRole("tab", { name: /^(?:工作组|Work teams)$/u }).click();
    await page.getByTestId("access-team-name").fill("Build team");
    await page.getByTestId("access-team-save").click();
    const team = page.locator("[data-dense-row]").filter({ hasText: "Build team" });
    await team.waitFor();
    await team.click();
    const member = page.locator('fieldset input[type="checkbox"]').first();
    await member.click();
    await page.getByTestId("access-team-save").waitFor({ state: "visible" });
    await page.waitForFunction(() => !globalThis.document.querySelector('[data-testid="access-team-save"]').disabled);
    await page.waitForFunction(() => globalThis.document.querySelector('fieldset input[type="checkbox"]').checked);
    assert.equal(await member.isChecked(), true);
    const windows = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((window) => ({ visible: window.isVisible(), focused: window.isFocused() })),
    );
    assert.ok(windows.length > 0 && windows.every((window) => !window.visible && !window.focused));
    await shot("work-team-member");
    await member.click();
    await page.waitForFunction(() => !globalThis.document.querySelector('[data-testid="access-team-save"]').disabled);
    await page.waitForFunction(() => !globalThis.document.querySelector('fieldset input[type="checkbox"]').checked);
    assert.equal(await member.isChecked(), false);
    await page.getByTestId("access-team-delete").click();
    await team.waitFor({ state: "detached" });
    assert.equal(await page.getByRole("alert").count(), 0);
  },
};
