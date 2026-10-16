import assert from "node:assert/strict";
import path from "node:path";
import { requestDaemonJsonRpcAt } from "../../../packages/daemon/src/client/local-json-rpc-client.ts";
import { bridgeReady, nav } from "./helpers.mjs";

// 一个项目一个窗口(task_ca1ee6b9e8f83c89cb376e5f07):在真实 Electron 壳里走完约束链——
//   ① 切换器「在新窗口打开」开出第二个窗口,初始项目经 additionalArguments 传入,
//     侧栏头部/窗口标题都落在第二个仓上;
//   ② 同项目重复「在新窗口打开」不重复建窗(headless 下聚焦不改变可见性,以窗口计数
//     与 window 事件缺席为准);
//   ③ 两窗口互不影响:窗口 1 切看板,窗口 2 仍停在自己的总览。
// 第二个仓在本场景内经 daemon.repo.bootstrap 自建(permit 在 lanes.mjs keycloakSetup
// 里登记);新窗口的 renderer console 错误单独收集——driver 只监听首个窗口。
// 坑:headless 运行里全部窗口必须保持隐藏(driver.assertBackground),新窗口的
// show/focus 已由主进程注册表按 backgroundTest 关闭,勿在场景里调 show()。

const SWITCHER_TITLE = /快速切换项目|Quickly switch projects/u;
const SECOND_REPO_ID = "gui-e2e-windows";
const SECOND_PROJECT_NAME = "repo-window";

async function openSwitcher(page) {
  await page.getByTitle(SWITCHER_TITLE).click();
  const panel = page.getByTestId("quick-switcher-panel");
  await panel.waitFor({ timeout: 5_000 });
  return panel;
}

async function windowCount(app) {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
}

export default {
  id: "project-windows",
  feature: "project-windows",
  lane: "isolated",
  description:
    "Opening a project from the switcher in a new window lands that window on the project with a matching window title, reopening the same project focuses the existing window instead of creating one, and the two windows navigate independently.",
  async run({ app, page, fixture, shot, runRoot }) {
    await bridgeReady(page);

    // 第二个项目仓:bootstrap + 种一个任务(与夹具主仓同一条 RPC 面)。
    const secondRoot = path.join(path.dirname(fixture.rootDir), "repo-window");
    const bootstrapped = await requestDaemonJsonRpcAt(
      fixture.endpoint,
      "daemon.repo.bootstrap",
      { rootDir: secondRoot, repoId: SECOND_REPO_ID, displayName: SECOND_PROJECT_NAME },
      5_000,
      60_000,
    );
    assert.equal(bootstrapped.ok, true, `second repo bootstrap: ${JSON.stringify(bootstrapped).slice(0, 300)}`);
    const created = await requestDaemonJsonRpcAt(
      fixture.endpoint,
      "repo.task.create",
      { repo: { repoId: SECOND_REPO_ID }, payload: { taskId: "task-window-probe", title: "Window probe task" } },
      5_000,
      30_000,
    );
    assert.equal(created.ok, true, `second repo task create: ${JSON.stringify(created).slice(0, 300)}`);

    // ① 「在新窗口打开」:先挂 window 事件等待再点击,拿到新窗口的 page。
    const panel = await openSwitcher(page);
    const secondConsole = [];
    const [secondPage] = await Promise.all([
      app.waitForEvent("window"),
      panel.getByTestId(`quick-switcher-open-window-${SECOND_REPO_ID}`).click(),
    ]);
    secondPage.on("pageerror", (error) => secondConsole.push(error.message));
    // 新窗口停在指定项目:侧栏头部(切换器按钮)显示项目名 = 初始项目已生效。
    await secondPage
      .getByTitle(SWITCHER_TITLE)
      .getByText(SECOND_PROJECT_NAME, { exact: true })
      .waitFor({ timeout: 20_000 });
    // 窗口标题「项目名 — Harness Anything」(document.title 由 Electron 同步为原生标题)。
    await secondPage.waitForFunction(
      (expected) => globalThis.document.title === expected,
      `${SECOND_PROJECT_NAME} — Harness Anything`,
      { timeout: 10_000 },
    );
    // 该项目从未在本窗口打开过 → 落总览;bridge 就绪。
    await bridgeReady(secondPage);
    await secondPage.getByTestId("overview-view").waitFor({ timeout: 15_000 });
    assert.equal(await windowCount(app), 2, "two native windows after opening the second project");

    // ② 同项目重复「在新窗口打开」:已开即聚焦,不再建窗(窗口事件缺席 + 计数不变)。
    await panel.getByTestId(`quick-switcher-open-window-${SECOND_REPO_ID}`).click();
    const duplicate = await app.waitForEvent("window", { timeout: 1_500 }).then(
      () => true,
      () => false,
    );
    assert.equal(duplicate, false, "reopening the same project must focus the existing window, not create one");
    assert.equal(await windowCount(app), 2, "window count stays at two after reopening the same project");

    // 图标按钮不收面板;显式收起再导航(与 project-switch-restore 同款收起路径)。
    await page.getByTitle(SWITCHER_TITLE).click();
    await page.getByTestId("quick-switcher-panel").waitFor({ state: "hidden", timeout: 5_000 });

    // ③ 两窗口互不影响:窗口 1 切看板,窗口 2 仍停在自己的总览与项目上。
    await nav(page, /^(?:看板|Board)$/u, "board-header-summary");
    await secondPage.waitForFunction(
      () => globalThis.document.querySelector('[data-testid="overview-view"]') !== null,
      null,
      { timeout: 10_000 },
    );
    assert.match(
      await secondPage.getByTitle(SWITCHER_TITLE).innerText(),
      new RegExp(SECOND_PROJECT_NAME, "u"),
      "second window still rests on its own project",
    );

    // 交付截图素材:两个窗口分别停在不同项目(正文截图由本任务的截图步骤发布)。
    await page.screenshot({ path: path.join(runRoot, "project-windows-window-1-board.png"), fullPage: true });
    await secondPage.screenshot({ path: path.join(runRoot, "project-windows-window-2-overview.png"), fullPage: true });
    await shot("project-windows-switcher-entry");

    assert.deepEqual(secondConsole, [], `second window renderer errors: ${secondConsole.join("\n")}`);
  },
};
