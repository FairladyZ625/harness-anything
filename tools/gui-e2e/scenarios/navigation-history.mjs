import assert from "node:assert/strict";
import { requestDaemonJsonRpcAt } from "../../../packages/daemon/src/client/local-json-rpc-client.ts";
import { bridgeReady, nav } from "./helpers.mjs";

// 全局导航历史(业主 2026-10-11「有的页面能退能进,有的不能」):在真实 Electron 壳里
// 验证三条后退/前进触发路径落同一个历史栈——
//   ① 顶栏 ← / → 按钮(既有);
//   ② 鼠标侧键 3/4:CDP Input.dispatchMouseEvent 的 back/forward 走真实输入管线,
//     即 macOS/Linux 的 DOM 投递路径;
//   ③ 主进程 app-command browser-backward/forward(Windows 侧键被 OS 转
//      WM_APPCOMMAND,DOM 拿不到):在 main 进程对窗口发同名事件,验证
//      主进程转发 → preload 订阅 → renderer 历史弹栈的完整接线。
// 含业主实例:任务详情 → 会话 → 后退回任务详情。抽屉开抽屉推栈一次、层内换卡
// 原地替换(2026-10-17 单抽屉),后退一次关抽屉回列表、原路前进重开。

async function sideButton(cdp, button, neutral) {
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", button, clicks: 1, ...neutral });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", button, clicks: 1, ...neutral });
}

const emitAppCommand = (app, command) =>
  app.evaluate(({ BrowserWindow }, cmd) => {
    const target = BrowserWindow.getAllWindows()[0];
    if (!target) throw new Error("main window must exist");
    target.emit("app-command", { preventDefault: () => undefined }, cmd);
  }, command);

export default {
  id: "navigation-history",
  feature: "navigation-history",
  lane: "isolated",
  description:
    "Global back/forward across board, preview drawer, task detail and sessions via bar buttons, real mouse side buttons, and the main-process app-command path.",
  async run({ page, app, fixture, shot }) {
    await bridgeReady(page);
    // preload 面暴露侧键订阅(Windows 投递路径的 renderer 半边)。
    assert.equal(
      await page.evaluate(() => typeof globalThis.harness?.appCommand?.onNavigationCommand),
      "function",
      "preload must expose appCommand.onNavigationCommand",
    );
    const cdp = await page.context().newCDPSession(page);
    // 侧键事件落在页面标题(非交互区),避免 pressed/released 对误触按钮。
    const heading = await page.locator("main h1, main h2").first().boundingBox();
    assert.ok(heading, "page heading must exist as a neutral mouse target");
    const neutral = { x: heading.x + heading.width / 2, y: heading.y + heading.height / 2 };
    const sideBack = () => sideButton(cdp, "back", neutral);
    const sideForward = () => sideButton(cdp, "forward", neutral);

    // 看板 → 点卡片:预览抽屉推栈(开着抽屉按侧键后退 = 回列表)。
    await nav(page, /^(?:看板|Board)$/u, "board-task-card");
    await page.getByTestId("board-task-card").first().click();
    await page.locator("aside[role=dialog]").waitFor({ state: "visible" });
    await shot("navigation-history-drawer-open");
    await sideBack();
    await page.locator("aside[role=dialog]").waitFor({ state: "hidden" });
    await page.getByTestId("board-task-card").first().waitFor();
    await shot("navigation-history-drawer-side-back");
    await sideForward();
    await page.locator("aside[role=dialog]").waitFor({ state: "visible" });

    // 抽屉 → 完整详情 → 会话(业主实例的下钻链)。
    await page.getByRole("button", { name: /打开完整详情|Open full details/u }).click();
    await page.getByTestId("task-detail-view").waitFor();
    await page.getByTestId("task-open-sessions").click();
    await page.getByTestId("sessions-view").waitFor();
    await shot("navigation-history-sessions");

    // ① 顶栏按钮:会话 → 后退回任务详情(业主点名的实例)。
    const history = page.getByTestId("nav-history-bar");
    await history.getByRole("button", { name: /(?:后退|Back)/u }).click();
    await page.getByTestId("task-detail-view").waitFor();
    await shot("navigation-history-back-to-task");

    // ② 鼠标侧键:详情 → 再退一步回预览抽屉(原路返回的完整链)。
    await sideBack();
    await page.locator("aside[role=dialog]").waitFor({ state: "visible" });

    // ——— F-9280B707:抽屉开着时顶栏前进/后退恰好一步 ———
    // 修前:非模态抽屉的「点外部关闭」挂在 window mousedown,顶栏按钮按下瞬间先
    // onClose→back() 弹一次栈,click 里按钮自己的前进/后退再动一次——前进净位移
    // 为零(页面停在抽屉),后退两步。侧键同族:App 级 button 3/4 监听与外压在
    // 同一次按下各弹一次。
    await history.getByRole("button", { name: /(?:前进|Forward)/u }).click();
    await page.getByTestId("task-detail-view").waitFor();
    await shot("navigation-history-bar-forward-from-drawer");
    // 先回抽屉,再在抽屉开着时点顶栏后退:恰好一步回看板。
    await history.getByRole("button", { name: /(?:后退|Back)/u }).click();
    await page.locator("aside[role=dialog]").waitFor({ state: "visible" });
    await history.getByRole("button", { name: /(?:后退|Back)/u }).click();
    await page.getByTestId("board-task-card").first().waitFor();
    await page.locator("aside[role=dialog]").waitFor({ state: "hidden" });
    await shot("navigation-history-bar-back-from-drawer");
    // 前进回到抽屉条目,把位置还原给 ③ 的 app-command 路径。
    await history.getByRole("button", { name: /(?:前进|Forward)/u }).click();
    await page.locator("aside[role=dialog]").waitFor({ state: "visible" });

    // ③ 主进程 app-command:抽屉 → 后退回看板;前进两次原路回到任务详情。
    await emitAppCommand(app, "browser-backward");
    await page.locator("aside[role=dialog]").waitFor({ state: "hidden" });
    await page.getByTestId("board-task-card").first().waitFor();
    await shot("navigation-history-app-command-back");
    await emitAppCommand(app, "browser-forward");
    await page.locator("aside[role=dialog]").waitFor({ state: "visible" });
    await emitAppCommand(app, "browser-forward");
    await page.getByTestId("task-detail-view").waitFor();
    await shot("navigation-history-app-command-forward-detail");

    // ——— 返工 F1(评审 2026-10-11):工作页任务抽屉与根任务下钻走同一条全局历史 ——
    // 种一个子任务让夹具根任务成为工作根(与 work-progress-chain 同一判定面),再回看板。
    const created = await requestDaemonJsonRpcAt(
      fixture.endpoint,
      "repo.task.create",
      {
        repo: { repoId: fixture.repoId },
        payload: { taskId: "task-nav-work-child", title: "导航历史工作页成员", parentTaskId: "task-gui-smoke" },
      },
      5_000,
      30_000,
    );
    assert.equal(created.ok, true, `work child create: ${JSON.stringify(created).slice(0, 300)}`);
    await requestDaemonJsonRpcAt(
      fixture.endpoint,
      "repo.task.read",
      {
        repo: { repoId: fixture.repoId },
        payload: {
          action: {
            kind: "receipt-show",
            opId: created.opId,
            waitFor: ["git_verified", "worktree_visible"],
            timeoutMs: 5_000,
          },
        },
      },
      5_000,
      30_000,
    );
    // 种子发生在 GUI 挂载之后:重载让读面重新拉取,不吃 stale 缓存。
    await page.reload();
    await bridgeReady(page);
    // 任务详情头部也有同名「看板」面包屑,导航点限定侧栏。
    await page
      .getByTestId("app-sidebar-scroll")
      .getByRole("button", { name: /^(?:看板|Board)$/u })
      .click();
    const workCard = page
      .getByTestId("board-task-card")
      .filter({ hasText: "Render the real triadic projection" })
      .first();
    await workCard.waitFor({ timeout: 20_000 });
    // 工作根卡片路由进工作页(workspace)。
    await workCard.click();
    await page.getByTestId("workspace-view").waitFor({ timeout: 20_000 });
    await shot("navigation-history-workspace");

    // 任务页签:成员行进预览抽屉(App 级 previewId 推栈)——侧键后退关抽屉留在工作页,前进重开。
    await page.locator("#workspace-tab-tasks").click();
    const memberRow = page.locator("[data-task-row] button").first();
    await memberRow.waitFor({ timeout: 20_000 });
    await memberRow.click();
    await page.locator("aside[role=dialog]").waitFor({ state: "visible" });
    await shot("navigation-history-workspace-drawer");
    await sideBack();
    await page.locator("aside[role=dialog]").waitFor({ state: "hidden" });
    await page.getByTestId("workspace-view").waitFor();
    await shot("navigation-history-workspace-drawer-side-back");
    await sideForward();
    await page.locator("aside[role=dialog]").waitFor({ state: "visible" });
    await sideBack();

    // 根任务页签:下钻推栈(selectedId 落在工作根)——侧键后退回工作页页签,前进重开根任务分区。
    await page.locator("#workspace-tab-root").click();
    await page.getByTestId("workspace-root-task").waitFor({ timeout: 20_000 });
    await shot("navigation-history-workspace-root");
    await sideBack();
    await page.getByTestId("workspace-root-task").waitFor({ state: "detached" });
    await page.getByTestId("workspace-view").waitFor();
    await sideForward();
    await page.getByTestId("workspace-root-task").waitFor({ timeout: 20_000 });
    await shot("navigation-history-workspace-root-forward");
  },
};
