import assert from "node:assert/strict";

/**
 * Settings → 仓库与连接 → 中心节点 invites an edge node through the daemon's edge-join-create.
 * The invitation link is a credential: it appears once, and Done drops it from the page while the
 * row keeps tracking the join state by inviteId. Copy is asserted by presence only — clicking it
 * would write the real OS clipboard of the machine running the suite.
 */
export default {
  id: "edge-invite",
  feature: "settings",
  lane: "isolated",
  description:
    "Issue an edge invitation from the center panel: the one-time link renders once with its expiry, " +
    "Done removes it while the join row stays pending by inviteId.",
  async run({ page, shot }) {
    // 宿主机带 npm 版 ha 时,desktop 首次启动检查浮层会盖住导航;有界等待它在场并点「稍后」。
    const later = page.getByRole("dialog", { name: "Harness Anything 首次启动" }).getByRole("button", { name: "稍后" });
    await later.click({ timeout: 10_000 }).catch(() => undefined);
    await page.getByRole("button", { name: /^(?:设置|Settings)$/u }).click();
    await page.getByTestId("settings-content").waitFor();
    await page.getByRole("button", { name: /^(?:仓库与连接|Repos & connections)/u }).click();
    await page.getByTestId("connection-node-center").click();
    await page.getByTestId("center-connection-panel").waitFor();
    await page.getByTestId("edge-invite-node-id").fill("edge-gui");
    await page.getByTestId("edge-invite-center-url").fill("https://center.example.com:8443");
    await page.getByTestId("edge-invite-spki").fill("sha256:e2e-pin");
    await page.getByTestId("edge-invite-issue").click();
    const link = page.getByTestId("edge-invite-link-edge-gui");
    await link.waitFor();
    const linkText = await link.locator("code").innerText();
    assert.match(linkText, /^harness-edge:\/\/join\//u);
    await shot("edge-invite-issued");
    // The invitation row reports the daemon's answer for this inviteId, with its expiry.
    const row = page.getByTestId("edge-invite-row-edge-gui");
    await row.filter({ hasText: /有效期至|Valid until/u }).waitFor();
    await row.filter({ hasText: /待消费|Pending/u }).waitFor();
    await page.getByTestId("edge-invite-done-edge-gui").click();
    assert.equal(await page.getByTestId("edge-invite-link-edge-gui").count(), 0, "Done removes the one-time link");
    await row.waitFor();
    const pageText = await page.innerText('[data-testid="edge-invite-list"]');
    assert.ok(!pageText.includes(linkText), "the link string is gone from the page");
    await page.getByTestId("edge-invite-row-edge-gui").waitFor();
    await shot("edge-invite-dismissed");
    // The two center facts survive for the next invitation; only the node name resets.
    assert.equal(await page.getByTestId("edge-invite-node-id").inputValue(), "");
    assert.equal(await page.getByTestId("edge-invite-center-url").inputValue(), "https://center.example.com:8443");
  },
};
