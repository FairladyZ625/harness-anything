import assert from "node:assert/strict";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * 「仓库与连接」的邀请入口:页顶入口直接开邀请面板,不经过「中心节点」;
 * 连接树再长也不能把中心行与「添加连接」推出 1440×900 视口;本机缺登录证书时,
 * 同一入口改成说明 + 一个配置动作,而不是给一个签不出可用链接的表单。
 */
export default {
  id: "edge-invite-entry",
  feature: "settings",
  lane: "isolated",
  description:
    "Open the invite panel from the page-top entry, keep the center row and add-connection inside a 1440x900 viewport with owner-scale repository rows, and turn the entry into the missing-certificate explanation when the login service cannot be used.",
  async run({ page, app, fixture, shot }) {
    // 26 个本机仓库是业主机器上的规模;这里只追加 registry 行(停用,不启动 cell),
    // 用来复现「仓库很多时中心行被挤出视口」的布局条件。
    const registryPath = path.join(fixture.userRoot, "registry.json"),
      registry = JSON.parse(readFileSync(registryPath, "utf8")),
      sample = registry.repos.find((repo) => repo.repoId === fixture.repoId);
    for (let index = 2; index <= 26; index += 1) {
      const suffix = String(index).padStart(2, "0");
      registry.repos.push({
        ...sample,
        repoId: `layout-repo-${suffix}`,
        displayName: `Layout repo ${suffix}`,
        state: "disabled",
      });
    }
    const temporary = `${registryPath}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(registry, null, 2)}\n`);
    renameSync(temporary, registryPath);

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900));
    // 页面启动时已经读过一次 system status;重载后才会带上刚追加的 registry 行。
    await page.reload();
    await page.getByTestId("app-sidebar").waitFor({ timeout: 30_000 });
    const later = page.getByRole("dialog", { name: "Harness Anything 首次启动" }).getByRole("button", { name: "稍后" });
    await later.click({ timeout: 10_000 }).catch(() => undefined);

    const openRepositories = async () => {
      await page.getByRole("button", { name: /^(?:设置|Settings)$/u }).click();
      await page.getByTestId("settings-content").waitFor();
      await page.getByRole("button", { name: /仓库与连接|Repos & connections/u }).click();
      await page.getByTestId("repositories-connections-view").waitFor();
    };
    const viewport = await page.evaluate(() => ({ width: globalThis.innerWidth, height: globalThis.innerHeight }));
    assert.deepEqual(viewport, { width: 1440, height: 900 });

    await openRepositories();
    const inside = async (testId) => {
      const box = await page.getByTestId(testId).evaluate((node) => {
        const rect = node.getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom, height: rect.height };
      });
      return box.height > 0 && box.top >= 0 && box.bottom <= 900;
    };
    assert.equal(await inside("invite-entry-open"), true, "邀请入口在首屏内");
    assert.equal(await inside("connection-node-center"), true, "中心节点行在首屏内");
    assert.equal(await inside("connection-node-count-center"), true, "中心节点计数在首屏内");
    assert.equal(await inside("connection-add-open"), true, "添加连接在首屏内");
    assert.equal(await page.getByTestId("connection-node-count-local").innerText(), "26");
    // 长仓库列表在自己的滚动区里;中心行与添加连接在滚动区外,才不会被滚走。
    assert.equal(
      await page.locator('[data-testid="connection-tree-scroll"] [data-testid="connection-node-center"]').count(),
      0,
    );
    assert.equal(
      await page.locator('[data-testid="connection-tree-scroll"] [data-testid="connection-add-open"]').count(),
      0,
    );
    const scroll = await page.getByTestId("connection-tree-scroll").evaluate((node) => ({
      overflowY: globalThis.getComputedStyle(node).overflowY,
      scrollHeight: node.scrollHeight,
      clientHeight: node.clientHeight,
    }));
    assert.equal(scroll.overflowY, "auto");
    assert.ok(scroll.scrollHeight > scroll.clientHeight, JSON.stringify(scroll));
    await shot("edge-invite-entry-default");

    await page.getByTestId("invite-entry-open").click();
    await page.getByTestId("edge-invite-person-select").waitFor();
    assert.equal(await page.getByTestId("center-connection-panel").count(), 0);
    await shot("edge-invite-entry-form");

    // 缺证书:把夹具的登录服务配置改成 managed 但没有 listener —— 这是「还当不了中心」的
    // 真实读面,renderer 走同一个 harness:center:settings → listener 读取后显示阻断说明。
    const rbacConfigPath = path.join(fixture.userRoot, "rbac", "config.json"),
      rbac = JSON.parse(readFileSync(rbacConfigPath, "utf8")),
      rbacTemporary = `${rbacConfigPath}.tmp`;
    writeFileSync(
      rbacTemporary,
      `${JSON.stringify({ ...rbac, mode: "managed", postgresPort: 15432, managementPort: 15900 }, null, 2)}\n`,
    );
    renameSync(rbacTemporary, rbacConfigPath);

    await page.reload();
    await page.getByTestId("app-sidebar").waitFor({ timeout: 30_000 });
    await openRepositories();
    await page.getByTestId("invite-entry-open").click();
    const blocked = page.getByTestId("invite-entry-blocked");
    await blocked.waitFor();
    assert.match(await blocked.innerText(), /证书|certificate/u);
    assert.equal(await page.getByTestId("edge-invite-issue").count(), 0);
    await shot("edge-invite-entry-blocked");

    await page.getByTestId("invite-entry-configure").click();
    await page.getByTestId("center-certificate-save").waitFor();

    const windows = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((window) => ({ visible: window.isVisible(), focused: window.isFocused() })),
    );
    assert.ok(windows.length > 0 && windows.every(({ visible, focused }) => !visible && !focused));
  },
};
