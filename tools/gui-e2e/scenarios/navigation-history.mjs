import assert from "node:assert/strict";
import { bridgeReady, nav } from "./helpers.mjs";

// 全局导航历史(业主 2026-10-11「有的页面能退能进,有的不能」):在真实 Electron 壳里
// 验证三条后退/前进触发路径落同一个历史栈——
//   ① 顶栏 ← / → 按钮(既有);
//   ② 鼠标侧键 3/4:CDP Input.dispatchMouseEvent 的 back/forward 走真实输入管线,
//     即 macOS/Linux 的 DOM 投递路径;
//   ③ 主进程 app-command browser-backward/forward(Windows 侧键被 OS 转
//      WM_APPCOMMAND,DOM 拿不到):在 main 进程对窗口发同名事件,验证
//      主进程转发 → preload 订阅 → renderer 历史弹栈的完整接线。
// 含业主实例:任务详情 → 会话 → 后退回任务详情。抽屉与详情同栈推入,原路返回。

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
  async run({ page, app, shot }) {
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
  },
};
