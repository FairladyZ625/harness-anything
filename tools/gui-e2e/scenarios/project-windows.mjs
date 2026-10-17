import assert from "node:assert/strict";
import path from "node:path";
import { requestDaemonJsonRpcAt } from "../../../packages/daemon/src/client/local-json-rpc-client.ts";
import { bridgeReady, nav } from "./helpers.mjs";

// 一个项目一个窗口(task_ca1ee6b9e8f83c89cb376e5f07):在真实 Electron 壳里走完约束链——
//   ① 切换器「在新窗口打开」开出第二个窗口,初始项目经 additionalArguments 传入,
//     侧栏头部/窗口标题都落在第二个仓上;
//   ② 同项目重复「在新窗口打开」不重复建窗(headless 下聚焦不改变可见性,以窗口计数
//     与 window 事件缺席为准);
//   ③ 两窗口互不影响:窗口 1 切看板,窗口 2 仍停在自己的总览;
//   ④ 同项目两窗并存(⌘⇧N 的产物状态,CEO 2026-10-17 裁定):窗口 1 在本窗内切到第二
//     项目(headless 无焦点,菜单无法带种子,等价走切换器行点击),随后再点「在新窗口
//     打开」同一项目仍不建第三窗;
//   ⑤ 同项目两窗导航历史各自持有(task_48399f09c1673b4be25faed452):窗口 1 停看板、
//     窗口 2 停产物页,窗口 1 切走再切回仍停自己的看板(修前:读到他窗写入的共享
//     localStorage 键,跳去产物页),后退互不影响;关掉窗口 2 后重开的新窗口恢复
//     最后关闭窗口(窗口 2)的位置——运行期栈在 sessionStorage(Electron 每窗独立),
//     关闭时写回 localStorage 兜底;
//   ⑥ darwin 真菜单:evaluate 里点应用菜单「新建窗口」,必须总是新增一窗。
// 第二个仓在本场景内经 daemon.repo.bootstrap 自建(permit 在 lanes.mjs keycloakSetup
// 里登记);新窗口的 renderer console 错误单独收集——driver 只监听首个窗口。
// 坑:headless 运行里全部窗口必须保持隐藏(driver.assertBackground),新窗口的
// show/focus 已由主进程注册表按 backgroundTest 关闭,勿在场景里调 show()。
// 截图:切换器入口截图必须在面板展开时拍(打回教训:面板收起后拍到的只是看板页)。

const SWITCHER_TITLE = /快速切换项目|Quickly switch projects/u;
const SECOND_REPO_ID = "gui-e2e-windows";
const SECOND_PROJECT_NAME = "repo-window";
// 主夹具仓:lanes.mjs 写死 repoId「gui-e2e-catalog」(行内第二行的精确文本),displayName
// 由 rootDir 派生成「repo」(头部触发按钮显示的名字)。
const MAIN_REPO_ID = "gui-e2e-catalog";
const MAIN_PROJECT_NAME = "repo";

async function openSwitcher(page) {
  await page.getByTitle(SWITCHER_TITLE).click();
  const panel = page.getByTestId("quick-switcher-panel");
  await panel.waitFor({ timeout: 5_000 });
  return panel;
}

async function closeSwitcher(page) {
  await page.getByTitle(SWITCHER_TITLE).click();
  await page.getByTestId("quick-switcher-panel").waitFor({ state: "hidden", timeout: 5_000 });
}

async function windowCount(app) {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
}

async function noWindowAppears(app, expectedCount) {
  const appeared = await app.waitForEvent("window", { timeout: 1_500 }).then(
    () => true,
    () => false,
  );
  assert.equal(appeared, false, `window count must stay at ${expectedCount}, not spawn a new window`);
  assert.equal(await windowCount(app), expectedCount);
}

async function headerShowsProject(page, projectName) {
  await page.getByTitle(SWITCHER_TITLE).getByText(projectName, { exact: true }).waitFor({ timeout: 20_000 });
}

export default {
  id: "project-windows",
  feature: "project-windows",
  lane: "isolated",
  description:
    "Opening a project from the switcher in a new window lands that window on the project with a matching window title, reopening the same project focuses the existing window instead of creating one, two windows may rest on the same project (menu New Window ruling) without a third being spawned, and the two windows navigate independently.",
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
    await headerShowsProject(secondPage, SECOND_PROJECT_NAME);
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
    await noWindowAppears(app, 2);

    // 交付截图素材:切换器展开、「在新窗口打开」入口在画面里(悬停高亮)时拍窗口 1。
    await panel.getByTestId(`quick-switcher-open-window-${SECOND_REPO_ID}`).hover();
    await shot("project-windows-switcher-entry");

    // 图标按钮不收面板;显式收起再导航(与 project-switch-restore 同款收起路径)。
    await closeSwitcher(page);

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
    await page.screenshot({ path: path.join(runRoot, "project-windows-window-1-board.png"), fullPage: true });
    await secondPage.screenshot({ path: path.join(runRoot, "project-windows-window-2-overview.png"), fullPage: true });

    // ④ 同项目两窗并存(⌘⇧N 产物状态):headless 无聚焦窗口,菜单种子必为 null,等价地
    //    把窗口 1 在本窗内切到第二项目(设计允许的窗内切换),此后两窗同停第二项目。
    const switchPanel = await openSwitcher(page);
    await switchPanel.getByText(SECOND_PROJECT_NAME, { exact: true }).click();
    await headerShowsProject(page, SECOND_PROJECT_NAME);
    await headerShowsProject(secondPage, SECOND_PROJECT_NAME);
    // 选定项目会收起面板(onProjectOpened);重开后再点「在新窗口打开」同一项目,
    // 两窗同停该项目时仍必须是去重聚焦,不开第三窗。
    const dedupPanel = await openSwitcher(page);
    await dedupPanel.getByTestId(`quick-switcher-open-window-${SECOND_REPO_ID}`).click();
    await noWindowAppears(app, 2);
    await closeSwitcher(page);
    await page.screenshot({ path: path.join(runRoot, "project-windows-same-project-window-1.png"), fullPage: true });
    await secondPage.screenshot({
      path: path.join(runRoot, "project-windows-same-project-window-2.png"),
      fullPage: true,
    });

    // ⑤ 同项目两窗导航历史各自持有:窗口 1 → 看板,窗口 2 → 产物页。
    await nav(page, /^(?:看板|Board)$/u, "board-header-summary");
    await nav(secondPage, /^(?:产物|Artifacts)$/u, "artifacts-view");
    // 机制实测:Electron 每 BrowserWindow 的 sessionStorage 独立,同键各自持有自己的栈顶。
    const sessionTopView = (target) =>
      target.evaluate(() => {
        const raw = globalThis.sessionStorage.getItem("harness-view-history:gui-e2e-windows");
        if (raw === null) return null;
        const history = JSON.parse(raw).history;
        return history.entries[history.index].view;
      });
    assert.equal(await sessionTopView(page), "board");
    assert.equal(await sessionTopView(secondPage), "artifacts");
    // 窗口 1 切走再切回:仍停自己的看板(修前重读共享键会跳去窗口 2 的产物页)。
    const awayPanel = await openSwitcher(page);
    await awayPanel.getByText(MAIN_REPO_ID, { exact: true }).click();
    await headerShowsProject(page, MAIN_PROJECT_NAME);
    const returnPanel = await openSwitcher(page);
    await returnPanel.getByText(SECOND_PROJECT_NAME, { exact: true }).click();
    await headerShowsProject(page, SECOND_PROJECT_NAME);
    await page.getByTestId("board-header-summary").waitFor({ timeout: 10_000 });
    // 后退互不影响:窗口 1 退回自己的总览,窗口 2 原地不动。
    await page
      .getByTestId("nav-history-bar")
      .getByRole("button", { name: /(?:后退|Back)/u })
      .click();
    await page.getByTestId("overview-view").waitFor({ timeout: 10_000 });
    await secondPage.getByTestId("artifacts-view").waitFor({ timeout: 10_000 });
    await page.screenshot({ path: path.join(runRoot, "project-windows-history-window-1-back.png"), fullPage: true });
    await secondPage.screenshot({
      path: path.join(runRoot, "project-windows-history-window-2-unaffected.png"),
      fullPage: true,
    });

    // 重开恢复「最后关闭的同项目窗口」:窗口 1 先切回主项目(标题随之区分),再关掉停
    // 产物页的窗口 2——BrowserWindow.close() 走正常关闭序列,renderer 的 pagehide 写回
    // 在这里落地(Playwright 的 page.close() 不保证经过 unload)——然后「在新窗口打开」
    // 第二项目 → 新窗恢复产物页,不是窗口 1 的看板/总览。
    assert.deepEqual(secondConsole, [], `second window renderer errors: ${secondConsole.join("\n")}`);
    const leavePanel = await openSwitcher(page);
    await leavePanel.getByText(MAIN_REPO_ID, { exact: true }).click();
    await headerShowsProject(page, MAIN_PROJECT_NAME);
    const secondClosed = secondPage.waitForEvent("close", { timeout: 10_000 });
    await app.evaluate(({ BrowserWindow }, expectedTitle) => {
      const matches = BrowserWindow.getAllWindows().filter((window) => window.title === expectedTitle);
      if (matches.length !== 1) throw new Error(`expected exactly one window titled ${expectedTitle}`);
      matches[0].close();
    }, `${SECOND_PROJECT_NAME} — Harness Anything`);
    await secondClosed;
    const reopenPanel = await openSwitcher(page);
    const reopenConsole = [];
    const [reopenedPage] = await Promise.all([
      app.waitForEvent("window"),
      reopenPanel.getByTestId(`quick-switcher-open-window-${SECOND_REPO_ID}`).click(),
    ]);
    reopenedPage.on("pageerror", (error) => reopenConsole.push(error.message));
    await bridgeReady(reopenedPage);
    await headerShowsProject(reopenedPage, SECOND_PROJECT_NAME);
    await reopenedPage.getByTestId("artifacts-view").waitFor({ timeout: 15_000 });
    assert.deepEqual(reopenConsole, [], `reopened window renderer errors: ${reopenConsole.join("\n")}`);
    await reopenedPage.screenshot({
      path: path.join(runRoot, "project-windows-history-reopened-last-closed.png"),
      fullPage: true,
    });

    // ⑥ darwin 真菜单「新建窗口」:headless 下聚焦为空 → 种子 null,但必须总是新增一窗
    //    (修复前菜单会把当前项目交给去重的 openProjectWindow,什么都开不出来)。
    if (process.platform === "darwin") {
      const [thirdPage] = await Promise.all([
        app.waitForEvent("window"),
        app.evaluate(({ Menu }) => {
          const menu = Menu.getApplicationMenu();
          const fileMenu = menu?.items.find((item) => item.label === "文件");
          const newItem = fileMenu?.submenu?.items.find((item) => item.label === "新建窗口");
          if (newItem === undefined || newItem.click === null) throw new Error("新建窗口 menu item missing");
          newItem.click(newItem, undefined, undefined);
        }),
      ]);
      const thirdConsole = [];
      thirdPage.on("pageerror", (error) => thirdConsole.push(error.message));
      await bridgeReady(thirdPage);
      assert.equal(await windowCount(app), 3, "menu New Window must always create a window");
      assert.deepEqual(thirdConsole, [], `third window renderer errors: ${thirdConsole.join("\n")}`);
    }

    assert.deepEqual(secondConsole, [], `second window renderer errors: ${secondConsole.join("\n")}`);
  },
};
