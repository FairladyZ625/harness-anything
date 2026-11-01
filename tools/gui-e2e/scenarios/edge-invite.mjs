import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { KeycloakPolicyAdapter } from "@harness-anything/authorization-keycloak";
import { readFleetCenterConfig, saveFleetCenterConfig } from "../../../packages/daemon/src/fleet-center-config.ts";
import { keycloakRealm, keycloakUrl } from "../../../packages/daemon/test/keycloak.fixtures.ts";

/**
 * Settings → Repos & connections issues a multi-repository invitation through access-admin.
 * The invite form picks a member from the grant list or creates one in place; the one-time link is
 * inspected in memory only, and screenshots cover its sanitized audit row.
 */
export default {
  id: "edge-invite",
  feature: "settings",
  lane: "isolated",
  description:
    "Create an invited member from the picker, preview permission groups as folded action categories with inheritance named at the category level, issue a multi-repository edge invitation, hide its one-time link, inspect the audit row, and revoke it.",
  async run({ page, app, fixture, shot }) {
    const keyPath = path.join(fixture.userRoot, "edge-invite-key.pem"),
      certPath = path.join(fixture.userRoot, "edge-invite-cert.pem");
    await new KeycloakPolicyAdapter(
      { url: keycloakUrl, realm: keycloakRealm, resourceServerClientId: "harness-center" },
      fixture.keycloak.fetch,
    ).syncBasePolicy("fixture-admin-token");
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        keyPath,
        "-out",
        certPath,
        "-subj",
        "/CN=127.0.0.1",
        "-days",
        "1",
        "-addext",
        "subjectAltName=IP:127.0.0.1",
      ],
      { stdio: "ignore" },
    );
    // Creation needs the configured center certificate and repository registry, but not a listener socket.
    saveFleetCenterConfig(fixture.userRoot, fixture.daemonId, {
      bind: "127.0.0.1",
      port: 8443,
      externalUrl: "https://127.0.0.1:8443",
      repoId: fixture.repoId,
      keyPath,
      certPath,
      stateRoot: path.join(fixture.userRoot, "fleet-state"),
      quotaBytes: 1024 * 1024,
    });

    // 宿主机带 npm 版 ha 时,desktop 首次启动检查浮层会盖住导航;有界等待它在场并点「稍后」。
    const later = page.getByRole("dialog", { name: "Harness Anything 首次启动" }).getByRole("button", { name: "稍后" });
    await later.click({ timeout: 10_000 }).catch(() => undefined);
    await page.getByRole("button", { name: /^(?:设置|Settings)$/u }).click();
    await page.getByTestId("settings-content").waitFor();
    await page.getByRole("button", { name: /^(?:仓库与连接|Repos & connections)/u }).click();
    // Daemon refusals arrive as resolved command receipts. The GUI must show the refusal and
    // retain the last successful address before opening the invitation form.
    await page.getByTestId("connection-node-center").click();
    const externalAddress = page.getByTestId("center-external-address");
    await externalAddress.fill("https://uncovered.example.test:7545");
    await page.getByTestId("center-external-address-save").click();
    const addressStatus = page.getByTestId("center-connection-panel").getByRole("status");
    await addressStatus.waitFor();
    assert.match(await addressStatus.innerText(), /TLS certificate SAN does not cover uncovered\.example\.test/u);
    assert.doesNotMatch(await addressStatus.innerText(), /(?:已保存|address saved)/iu);
    assert.equal(readFleetCenterConfig(fixture.userRoot, fixture.daemonId)?.externalUrl, "https://127.0.0.1:8443");
    await shot("center-external-address-rejected");
    // 邀请入口在页顶,点开就是邀请面板;不再需要先点「中心节点」理解连接树。
    await page.getByTestId("invite-entry-open").click();

    await page.getByTestId("edge-invite-person-select").waitFor();
    await shot("edge-invite-picker");
    // The realm starts without this person, so the picker creates the member in the same form.
    await page.getByTestId("edge-invite-person-select").selectOption("__new__");
    await page.getByTestId("edge-invite-username").fill("edge.operator");
    await page.getByTestId("edge-invite-email").fill("edge-invite@example.test");
    await page.getByTestId("edge-invite-display-name").fill("Edge Operator");
    assert.match(await page.getByTestId("edge-invite-new-person-id").innerText(), /edge\.operator/u);
    await page.getByTestId(`edge-invite-repo-${fixture.repoId}`).check();
    await page.getByTestId("edge-invite-group-contributor").check();
    // 权限预览:动作按声明 domain 分组、默认折叠,组层汇总「本级/继承」并标注继承来源,
    // 行内只留声明的人话名 + 原始 scope。viewer 与 admin 各留折叠/展开两张验收截图。
    await page.getByTestId("edge-invite-group-preview-toggle-viewer").click();
    const viewerPreview = page.getByTestId("edge-invite-group-preview-viewer");
    await viewerPreview.getByText(/生效动作 \d+ 项|Effective actions:/u).waitFor();
    assert.equal(
      await viewerPreview.locator("details").evaluateAll((all) => all.every((node) => !node.open)),
      true,
      "categories fold by default",
    );
    await shot("edge-invite-group-preview-viewer-folded");
    await viewerPreview.locator("summary").first().click();
    await viewerPreview.getByText("读取仓库").waitFor();
    await shot("edge-invite-group-preview-viewer-open");
    await page.getByTestId("edge-invite-group-preview-toggle-viewer").click();
    await viewerPreview.waitFor({ state: "detached" });

    await page.getByTestId("edge-invite-group-preview-toggle-admin").click();
    const adminPreview = page.getByTestId("edge-invite-group-preview-admin");
    await adminPreview.getByText(/生效动作 \d+ 项|Effective actions:/u).waitFor();
    const adminCategories = adminPreview.locator("details");
    assert.ok((await adminCategories.count()) > 10, "admin preview groups its actions into categories");
    assert.equal(
      await adminCategories.evaluateAll((all) => all.every((node) => !node.open)),
      true,
      "admin categories fold by default",
    );
    // The repository category is wholly inherited from viewer: named once at the category level.
    const adminRepository = page.getByTestId("edge-invite-group-preview-admin-category-repository");
    const adminRepositorySummary = await adminRepository.locator("summary").innerText();
    assert.match(adminRepositorySummary, /继承 \d+ 项|\d+ inherited/u);
    assert.match(adminRepositorySummary, /继承自|inherited from/u);
    await shot("edge-invite-group-preview-admin-folded");
    await adminRepository.locator("summary").click();
    await adminRepository.getByText("读取仓库").waitFor();
    await shot("edge-invite-group-preview-admin-open");
    await page.getByTestId("edge-invite-group-preview-toggle-admin").click();
    await adminPreview.waitFor({ state: "detached" });

    // The invited group's preview still names the inherited action: repository-read is the viewer
    // tier's only declared action, so it is the one contributor inherits.
    await page.getByTestId("edge-invite-group-preview-toggle-contributor").click();
    const preview = page.getByTestId("edge-invite-group-preview-contributor");
    await preview.getByTestId("edge-invite-group-preview-contributor-category-repository").locator("summary").click();
    const inheritedAction = preview.getByText("repository-read", { exact: true }).first();
    assert.ok(await inheritedAction.isVisible(), "preview names the inherited action");
    await page.getByTestId("edge-invite-group-preview-toggle-contributor").click();
    await preview.waitFor({ state: "detached" });
    await shot("edge-invite-new-member");
    await page.getByTestId("edge-invite-issue").click();

    const issued = page.getByTestId("edge-invite-issued");
    try {
      await issued.waitFor({ timeout: 5_000 });
    } catch (error) {
      const alerts = await page.locator('[role="alert"]').allTextContents();
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\nInvitation alerts: ${alerts.join(" | ") || "none"}`,
      );
    }
    const linkText = await issued.locator("pre").innerText(),
      linkPrefix = "harness-edge://join/";
    assert.ok(linkText.startsWith(linkPrefix));
    const link = JSON.parse(Buffer.from(linkText.slice(linkPrefix.length), "base64url").toString("utf8"));
    assert.equal(link.version, 2);
    assert.equal(link.centerOrigin, "https://127.0.0.1:8443");
    assert.equal(typeof link.token, "string");
    assert.equal(Object.hasOwn(link, "credential"), false);

    await page.getByTestId("edge-invite-done").click();
    const audit = page.getByTestId("edge-invite-list");
    await audit.getByText("edge.operator").waitFor();
    await audit.getByText(fixture.repoId).waitFor();
    await audit.getByText("contributor").waitFor();
    assert.equal((await page.locator("body").innerText()).includes(linkText), false, "Done removes the one-time link");
    // The member read refreshed after the invitation, so the created member is now pickable by identity.
    const createdMember = page.getByTestId("edge-invite-person-select").locator('option[value="edge.operator"]');
    await createdMember.waitFor({ state: "attached" });
    await page.getByTestId("edge-invite-person-select").selectOption("edge.operator");
    assert.match(await page.getByTestId("edge-invite-person-summary").innerText(), /edge\.operator/u);
    await shot("edge-invite-existing-member");
    await shot("edge-invite-pending-audit");

    await page.locator('[data-testid^="edge-invite-revoke-"]').click();
    await audit.getByText(/Revoked|已撤销/u).waitFor();
    assert.equal(await page.locator('[data-testid^="edge-invite-revoke-"]').count(), 0);
    await shot("edge-invite-revoked-audit");

    const windows = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((window) => ({ visible: window.isVisible(), focused: window.isFocused() })),
    );
    assert.ok(windows.length > 0 && windows.every(({ visible, focused }) => !visible && !focused));
  },
};
