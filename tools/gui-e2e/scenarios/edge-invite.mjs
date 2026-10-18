import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { requestDaemonJsonRpcAt } from "../../../packages/daemon/src/client/local-json-rpc-client.ts";
import { decodeEdgeJoinLink } from "../../../packages/daemon/src/fleet/edge-join.ts";

/**
 * Settings → 仓库与连接 → 中心节点 invites an edge node through the daemon's edge-join-create.
 * 签发读的是 daemon 自己保存的 fleet 监听(证书也在其中),所以场景先用 openssl 自签证书经
 * daemon.fleet.center.start 起一个真实 TLS 监听(device-login-approval 同款种子),并把中心
 * 地址栏留空——链接里的 center URL 必须是 daemon 按监听推导出的地址,指纹也是 daemon 从
 * 该监听证书自己算的,面板没有指纹输入。邀请链接是凭据:它只出现一次,Done 后从页面消失,
 * 行仍按 inviteId 跟踪状态。复制只断言其在场——点它会写宿主机真实剪贴板。
 */
export default {
  id: "edge-invite",
  feature: "settings",
  lane: "isolated",
  description:
    "Issue an edge invitation from the center panel against the daemon's own pinned listener: " +
    "the one-time link renders once with the daemon-derived center address (the field stays empty) " +
    "and a self-computed certificate pin, the row reports expiry and pending state by inviteId, " +
    "and Done removes the link while the row stays.",
  async run({ page, shot, fixture }) {
    // 宿主机带 npm 版 ha 时,desktop 首次启动检查浮层会盖住导航;有界等待它在场并点「稍后」。
    const later = page.getByRole("dialog", { name: "Harness Anything 首次启动" }).getByRole("button", { name: "稍后" });
    await later.click({ timeout: 10_000 }).catch(() => undefined);
    const keyPath = path.join(fixture.rootDir, "edge-invite-tls.key"),
      certPath = path.join(fixture.rootDir, "edge-invite-tls.crt");
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
        "/CN=localhost",
        "-days",
        "1",
        "-addext",
        "subjectAltName=DNS:localhost,IP:127.0.0.1",
      ],
      { stdio: "ignore" },
    );
    const center = await requestDaemonJsonRpcAt(
      fixture.endpoint,
      "daemon.fleet.center.start",
      { payload: { port: 0, keyPath, certPath, repoId: fixture.repoId, quotaBytes: 64 * 1024 * 1024 } },
      1_000,
      20_000,
    );
    assert.equal(center.ok, true, JSON.stringify(center));
    await page.getByRole("button", { name: /^(?:设置|Settings)$/u }).click();
    await page.getByTestId("settings-content").waitFor();
    await page.getByRole("button", { name: /^(?:仓库与连接|Repos & connections)/u }).click();
    await page.getByTestId("connection-node-center").click();
    await page.getByTestId("center-connection-panel").waitFor();
    await page.getByTestId("edge-invite-node-id").fill("edge-gui");
    // 中心地址栏留空:地址与证书指纹都由 daemon 从刚保存的监听推导/计算。
    await page.getByTestId("edge-invite-issue").click();
    const link = page.getByTestId("edge-invite-link-edge-gui");
    await link.waitFor();
    const linkText = await link.locator("code").innerText();
    assert.match(linkText, /^harness-edge:\/\/join\//u);
    const invite = decodeEdgeJoinLink(linkText);
    assert.equal(invite.centerUrl, `https://127.0.0.1:${center.port}`, "the daemon derived the listener address");
    assert.match(invite.spkiSha256, /^sha256:/u, "the daemon pinned its own listener certificate");
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
    // Only the node name resets; the optional center address keeps what the operator left (empty).
    assert.equal(await page.getByTestId("edge-invite-node-id").inputValue(), "");
    assert.equal(await page.getByTestId("edge-invite-center-url").inputValue(), "");
  },
};
