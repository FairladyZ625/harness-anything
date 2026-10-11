import assert from "node:assert/strict";
import path from "node:path";
import { requestDaemonJsonRpcAt } from "../../../packages/daemon/src/client/local-json-rpc-client.ts";
import { bridgeReady, nav } from "./helpers.mjs";

// 切仓恢复位置(业主 2026-10-11:切回项目直接回到它上次停留的页面):在真实
// Electron 壳里用两个项目仓走完整约束链 ——
//   ① A 仓下钻任务详情 → 切到从未打开的 B 仓(落 B 总览)→ 切回 A 仓回到任务详情;
//   ② 全局后退在恢复出的栈上原路返回(回看板);
//   ③ 清空会话存储后 reload(= 重启丢了 sessionStorage):位置仍从 localStorage 恢复;
//   ④ 切换器置顶:B 仓置顶后排到第一行,取消置顶还原。
// 夹具只带一个仓,第二个仓在场景内经 daemon.repo.bootstrap 自建(person-gui 的
// keycloak 许可在 lanes.mjs keycloakSetup 里登记)。

const SWITCHER_TITLE = /快速切换项目|Quickly switch projects/u;

async function openSwitcher(page) {
  const switcher = page.getByTitle(SWITCHER_TITLE);
  await switcher.click();
  const panel = page.getByTestId("quick-switcher-panel");
  await panel.waitFor({ timeout: 5_000 });
  return panel;
}

async function switchTo(page, projectName) {
  const panel = await openSwitcher(page);
  // 显示名与目录基名一致("repo" 是 "repo-restore" 的子串),必须整词匹配。
  const entry = panel
    .locator("button span.font-semibold")
    .filter({ hasText: new RegExp(`^${projectName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`, "u") })
    .first();
  await entry.waitFor({ timeout: 20_000 });
  await entry.click();
  // 侧栏头部显示新项目名 = 切仓已被应用层接受。
  await page.getByTitle(SWITCHER_TITLE).getByText(projectName, { exact: true }).waitFor({ timeout: 15_000 });
  await page.waitForTimeout(1_000);
}

export default {
  id: "project-switch-restore",
  feature: "project-switch",
  lane: "isolated",
  description:
    "Switching to another project and back restores the first project's task detail, back returns along the restored stack, a reload without session storage keeps the position, and the switcher pins favorites first.",
  async run({ page, fixture, shot }) {
    await bridgeReady(page);

    // 第二个项目仓:bootstrap + 种一个可下钻的任务(与夹具主仓同一条 RPC 面)。
    const secondRoot = path.join(path.dirname(fixture.rootDir), "repo-restore"),
      secondRepoId = "gui-e2e-restore";
    const bootstrapped = await requestDaemonJsonRpcAt(
      fixture.endpoint,
      "daemon.repo.bootstrap",
      { rootDir: secondRoot, repoId: secondRepoId, displayName: "Restore Probe" },
      5_000,
      60_000,
    );
    assert.equal(bootstrapped.ok, true, `second repo bootstrap: ${JSON.stringify(bootstrapped).slice(0, 300)}`);
    const created = await requestDaemonJsonRpcAt(
      fixture.endpoint,
      "repo.task.create",
      { repo: { repoId: secondRepoId }, payload: { taskId: "task-restore-probe", title: "Restore probe task" } },
      5_000,
      30_000,
    );
    assert.equal(created.ok, true, `second repo task create: ${JSON.stringify(created).slice(0, 300)}`);

    // ① 主仓(显示名 = 目录基名 "repo")下钻任务详情。
    await switchTo(page, "repo");
    await nav(page, /^(?:看板|Board)$/u, "board-task-card");
    await page.getByTestId("board-task-card").first().click();
    await page.locator("aside[role=dialog]").waitFor({ state: "visible" });
    await page.getByRole("button", { name: /打开完整详情|Open full details/u }).click();
    await page.getByTestId("task-detail-view").waitFor();
    await shot("project-switch-restore-catalog-task-detail");

    // ② 切到从未打开的 repo-restore:落它的总览(项目主页)。
    await switchTo(page, "repo-restore");
    await page.getByTestId("overview-view").waitFor({ timeout: 15_000 });
    await shot("project-switch-restore-second-overview");

    // ③ 切换器里置顶 repo-restore:它排到第一行;取消置顶还原;显式收起面板。
    const switcherButton = page.getByTitle(SWITCHER_TITLE);
    const panel = await openSwitcher(page);
    await panel.locator('[data-testid="quick-switcher-pin-gui-e2e-restore"]').click();
    const firstName = await panel.locator("button span.font-semibold").first().textContent();
    assert.equal(firstName?.trim(), "repo-restore", `pinned row must lead the switcher, got ${firstName}`);
    await shot("project-switch-restore-pinned-first");
    await panel.locator('[data-testid="quick-switcher-pin-gui-e2e-restore"]').click();
    await panel
      .locator("button span.font-semibold")
      .filter({ hasText: /^repo$/u })
      .first()
      .waitFor({ timeout: 5_000 });
    // pin 不关面板;用切换器按钮显式收起,再走 ④ 的打开路径。
    await switcherButton.click();
    await page.getByTestId("quick-switcher-panel").waitFor({ state: "hidden", timeout: 5_000 });

    // ④ 切回主仓:直接回到任务详情(业主场景),不是总览。
    await switchTo(page, "repo");
    await page.getByTestId("task-detail-view").waitFor({ timeout: 15_000 });
    await shot("project-switch-restore-back-restored");

    // ⑤ 恢复出的栈原路返回:后退一步回预览抽屉,抽屉内「打开完整详情」再回任务详情。
    // (工具栏按钮在非模态抽屉开着时有既有怪癖:window mousedown 的「点外面即
    // back()」先吃掉一次弹栈,再到的 click 才是按钮自己的动作——前进/后退净位移
    // 为零。这里只用面板内交互验证同一条栈,怪癖本身记 fact 交上游裁决。)
    await page
      .getByTestId("nav-history-bar")
      .getByRole("button", { name: /(?:后退|Back)/u })
      .click();
    await page.locator("aside[role=dialog]").waitFor({ state: "visible", timeout: 10_000 });
    await shot("project-switch-restore-back-once");
    await page.getByRole("button", { name: /打开完整详情|Open full details/u }).click();
    await page.getByTestId("task-detail-view").waitFor();
    await shot("project-switch-restore-forward-again");

    // ⑥ 重启模拟:清掉会话存储再 reload,位置仍从 localStorage 恢复。
    await page.evaluate(() => globalThis.sessionStorage.clear());
    await page.reload();
    await bridgeReady(page);
    await page.getByTestId("task-detail-view").waitFor({ timeout: 20_000 });
    await shot("project-switch-restore-after-reload");
  },
};
