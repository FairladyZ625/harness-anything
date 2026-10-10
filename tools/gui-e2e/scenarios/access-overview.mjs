/* global window */
import assert from "node:assert/strict";

export default {
  id: "access-overview",
  feature: "identity-access",
  lane: "isolated",
  description:
    "One member row across scopes; grants and membership require confirmation; human role summaries at two widths.",
  async run({ page, app, fixture, shot }) {
    fixture.keycloak.node("compute-example", "person-bo");
    await page.evaluate(async (repoId) => {
      const api = window.harness.access.forRepository(repoId);
      for (const grant of [
        { personId: "person-ada", groupId: "viewer", resource: repoId },
        { personId: "person-ada", groupId: "contributor", resource: "example-repo" },
        { personId: "person-bo", groupId: "admin", resource: repoId },
      ]) {
        const reply = await api.grant(grant);
        if (!reply.ok) throw new Error(reply.code);
      }
    }, fixture.repoId);
    await page.getByRole("button", { name: /^(?:账号与访问控制|Identity & access)$/u }).click();
    await page.getByTestId("access-grant-list").waitFor();
    assert.match(await page.locator('[data-person-id="person-bo"]').textContent(), /(?:节点|Node).*compute-example/u);
    const ada = page.locator('[data-person-id="person-ada"]');
    assert.equal(await ada.count(), 1);
    assert.match(await ada.textContent(), /example-repo/u);
    for (const [width, height] of [
      [1600, 1000],
      [1280, 800],
    ]) {
      await app.evaluate(
        ({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(...size),
        [width, height],
      );
      await page.waitForFunction(
        (size) => window.innerWidth === size[0] && window.innerHeight === size[1],
        [width, height],
      );
      const controls = await ada.locator("button[data-control-size]").evaluateAll((buttons) =>
        buttons.map((button) => {
          const rect = button.getBoundingClientRect();
          return { height: rect.height, width: rect.width, size: button.dataset.controlSize };
        }),
      );
      assert.ok(controls.every(({ height, width, size }) => height >= 28 && width >= 28 && size === "md"));
      await shot(`members-${width}`);
      await ada.getByTestId("access-grant-open-person-ada").click();
      await page.getByTestId("access-grant-group").selectOption("maintainer");
      await page.getByTestId("access-grant-submit").click();
      const before = await page.evaluate(
        async (repoId) => window.harness.access.forRepository(repoId).grants(),
        fixture.repoId,
      );
      assert.ok(!before.grants.some((grant) => grant.personId === "person-ada" && grant.groupId === "maintainer"));
      await shot(`grant-confirm-${width}`);
      await page.getByRole("button", { name: /^(?:取消|Cancel)$/u }).click();
      await page
        .getByTestId("access-grant-form")
        .getByRole("button", { name: /^(?:关闭|Close)$/u })
        .click();
      await page.getByRole("tab", { name: /^(?:角色说明|Roles)$/u }).click();
      await page.getByTestId("access-group-base-rule").waitFor();
      await page
        .getByTestId("access-group-list")
        .getByRole("button", { name: /maintainer/u })
        .click();
      const editor = page.getByTestId("access-group-editor");
      const domains = editor.locator("details > summary");
      assert.ok((await domains.count()) >= 2);
      assert.match(await domains.first().textContent(), /\(\d+\)/u);
      assert.equal(await editor.locator("details").first().getAttribute("open"), null);
      await domains.first().click();
      assert.ok((await editor.locator("details[open] p").count()) > 0);
      await shot(`role-actions-${width}`);
      await domains.first().click();
      await shot(`roles-${width}`);
      await page.getByRole("tab", { name: /^(?:服务与会话|Service & session)$/u }).click();
      await page.getByTestId("access-session-lifetime").waitFor();
      await shot(`service-${width}`);
      await page.getByRole("tab", { name: /^(?:工作组|Work teams)$/u }).click();
      await page.getByTestId("access-team-new").waitFor();
      await shot(`teams-empty-${width}`);
      await page.getByRole("tab", { name: /^(?:审计回执|Audit receipts)$/u }).click();
      await page.getByTestId("access-receipts").waitFor();
      await shot(`receipts-${width}`);
      await page.getByRole("tab", { name: /^(?:成员与权限|Members & access)$/u }).click();
    }
    await ada.getByTestId("access-grant-open-person-ada").click();
    await page.getByTestId("access-grant-group").selectOption("maintainer");
    await page.getByTestId("access-grant-submit").click();
    await page.getByTestId("access-change-confirm").click();
    await ada.getByText(/^(?:维护（maintainer）|Maintain \(maintainer\))$/u).waitFor();
    await ada.getByTestId("access-revoke-maintainer").click();
    assert.equal(await ada.getByText(/^(?:维护（maintainer）|Maintain \(maintainer\))$/u).count(), 1);
    await page.getByTestId("access-change-confirm").click();
    await ada.getByText(/^(?:维护（maintainer）|Maintain \(maintainer\))$/u).waitFor({ state: "detached" });
    await shot("access-confirmed-and-revoked");
  },
};
