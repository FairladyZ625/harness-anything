import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { KeycloakPolicyAdapter } from "../../../packages/daemon/src/keycloak-policy-adapter.ts";
import { saveFleetCenterConfig } from "../../../packages/daemon/src/fleet-center-config.ts";
import { keycloakRealm, keycloakUrl } from "../../../packages/daemon/test/keycloak.fixtures.ts";

/**
 * Settings → Repos & connections issues a multi-repository invitation through access-admin.
 * The one-time link is inspected in memory only; screenshots cover its sanitized audit row.
 */
export default {
  id: "edge-invite",
  feature: "settings",
  lane: "isolated",
  description:
    "Issue a multi-repository edge invitation with a permission group, hide its one-time link, inspect the audit row, and revoke it.",
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
    await page.getByTestId("connection-node-center").click();
    await page.getByTestId("center-connection-panel").waitFor();

    await page.getByTestId("edge-invite-person-id").fill("person-edge-invite");
    await page.getByTestId("edge-invite-username").fill("edge.operator");
    await page.getByTestId("edge-invite-email").fill("edge-invite@example.test");
    await page.getByTestId("edge-invite-display-name").fill("Edge Operator");
    await page.getByTestId(`edge-invite-repo-${fixture.repoId}`).check();
    await page.getByTestId("edge-invite-group-contributor").check();
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
    assert.equal(link.version, 1);
    assert.equal(typeof link.token, "string");
    assert.equal(Object.hasOwn(link, "credential"), false);

    await page.getByTestId("edge-invite-done").click();
    const audit = page.getByTestId("edge-invite-list");
    await audit.getByText("person-edge-invite").waitFor();
    await audit.getByText(fixture.repoId).waitFor();
    await audit.getByText("contributor").waitFor();
    assert.equal((await page.locator("body").innerText()).includes(linkText), false, "Done removes the one-time link");
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
