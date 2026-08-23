// REQ-GUI 最小 first-usable e2e(参考老 main 线 p3-first-usable.e2e.mjs):
// 真实投影到位前壳不算可用;到位后总览可交互(下钻→看板),
// 视图级后退/前进历史可用,图例可展开。不追求全覆盖。
import assert from "node:assert/strict";
import { once } from "node:events";
import { resolve } from "node:path";
import test from "node:test";
import electronPath from "electron";
import { _electron as electron } from "playwright-core";
import { startGuiResidentDaemonFixture } from "../test-support/resident-daemon.mjs";
import { seedTriadicEvents, writeTriadicLedger } from "../test-support/triadic-ledger.mjs";

const repoRoot = resolve(import.meta.dirname, "../../..");
const guiRoot = resolve(repoRoot, "packages/gui");

test("Overview is first-usable only with real interactive projection content", { timeout: 90_000 }, async (t) => {
  const daemonFixture = await startGuiResidentDaemonFixture({
    prefix: "ha-gui-usable-",
    daemonId: "gui-e2e-usable",
    repoId: "gui-e2e-usable",
    task: { taskId: "task-gui-smoke", title: "Render the real triadic projection" },
    beforeRestart: seedTriadicEvents
  });
  const ledgerRoot = daemonFixture.rootDir;
  let electronApp;
  t.after(async () => {
    if (electronApp) await closeElectronApp(electronApp);
    await daemonFixture.stop();
  });
  writeTriadicLedger(ledgerRoot);

  electronApp = await electron.launch({
    executablePath: electronPath,
    args: [resolve(guiRoot, "src/main/electron-main.ts")],
    cwd: repoRoot,
    env: { ...process.env, ...daemonFixture.env, HARNESS_GUI_ROOT: ledgerRoot }
  });
  const page = await electronApp.firstWindow();
  page.setDefaultTimeout(20_000);
  const consoleFailures = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleFailures.push(message.text());
  });
  page.on("pageerror", (error) => consoleFailures.push(error.message));
  await page.waitForLoadState("domcontentloaded");

  // 空壳不算可用:preload bridge 必须就位,任务投影必须出现真实行或真实空态。
  assert.equal(await page.evaluate(() => typeof globalThis.harness), "object", "preload bridge failed to load");
  const taskSurface = page.getByTestId("real-task-summary").or(page.getByTestId("task-empty-state"));
  const taskError = page.getByTestId("task-error-state");
  await taskSurface.or(taskError).first().waitFor({ timeout: 20_000 });
  if (await taskError.isVisible()) throw new Error(`GUI task bridge failed:\n${await taskError.innerText()}`);

  // 总览决策流:真实 proposed decision 出现(事件台账派生,非 mock)。
  // 点击行 = 开预览抽屉(抽屉头带 decisionId),不是跳页 —— Esc 关闭。
  const decisionRow = page.getByRole("button", { name: /Expose the triadic projection to the GUI/u }).first();
  await decisionRow.waitFor({ timeout: 20_000 });
  await decisionRow.click();
  await page.getByText("dec_gui_smoke").first().waitFor({ timeout: 10_000 });
  await page.keyboard.press("Escape");
  await page.getByTestId("real-task-summary").waitFor({ timeout: 20_000 });

  // 总览任务流:状态切换是就地筛选(2026-08-21 泽宇反馈)。fixture 任务经
  // repo.task.create 进 planned;从默认 active 页签切到 planned,本页数据换源、
  // 路由不动(仍在总览);显式「去看板」才是路由出口。
  const activeTab = page.getByTestId("overview-status-active");
  await activeTab.waitFor();
  const plannedTab = page.getByTestId("overview-status-planned");
  await plannedTab.click();
  await page.getByTestId("task-stream-rows").getByText("Render the real triadic projection").first().waitFor({ timeout: 10_000 });
  await page.getByText("一屏四问").waitFor({ timeout: 10_000 });
  await page.getByRole("button", { name: "去看板" }).click();
  await page.getByText("Render the real triadic projection").first().waitFor({ timeout: 10_000 });

  // 视图级后退/前进历史:back 回总览,forward 回看板。
  const navBar = page.getByTestId("nav-history-bar");
  await navBar.waitFor();
  await navBar.getByRole("button", { name: /后退/u }).click();
  await page.getByText("一屏四问").waitFor({ timeout: 10_000 });
  await navBar.getByRole("button", { name: /前进/u }).click();
  await page.getByText("Render the real triadic projection").first().waitFor({ timeout: 10_000 });

  // 关系图图例(REQ-GUI-04):可折叠展开,词表来自真实视觉常量。
  await page.getByRole("button", { name: "关系图" }).click();
  await page.locator(".react-flow").waitFor({ timeout: 10_000 });
  const legendToggle = page.getByRole("button", { name: "图例" });
  await legendToggle.waitFor();
  await legendToggle.click();
  await page.getByTestId("graph-legend-body").waitFor({ timeout: 5_000 });

  // W4:领地 chip → 聚光灯(抽出的 ego 组件在关系图页仍按旧行为工作)。
  await page.locator("[data-testid='territory-chip'][data-nav-ref='decision/dec_gui_smoke']").click();
  await page.locator("[data-testid='ego-card'][data-entity='decision']").waitFor({ timeout: 5_000 });
  await page.locator("[data-testid='ego-chip'][data-entity='fact']").waitFor({ timeout: 5_000 });
  await page.getByText("聚光灯 ·", { exact: false }).first().waitFor({ timeout: 5_000 });

  // W4 可寻址路由:聚光灯里展开 fact 卡,「详情」直达 fact 详情页(不落列表页),
  // 详情页邻域(复用同一 ego 组件)再跳 decision 详情,导航历史原路回撤。
  await page.locator("[data-testid='ego-chip'][data-entity='fact']").click();
  await page.locator("[data-testid='ego-card'][data-entity='fact'] button[aria-label='详情']").click();
  await page.getByTestId("fact-detail-view").waitFor({ timeout: 5_000 });
  await page.getByText("The GUI renderer received event-backed triadic rows.").first().waitFor({ timeout: 5_000 });
  await page.locator("[data-testid='fact-detail-view'] .react-flow").waitFor({ timeout: 5_000 });

  await page.locator("[data-testid='fact-detail-view'] [data-testid='ego-chip'][data-entity='decision']").click();
  await page.locator("[data-testid='fact-detail-view'] [data-testid='ego-card'][data-entity='decision'] button[aria-label='详情']").click();
  await page.getByTestId("decision-detail-view").waitFor({ timeout: 5_000 });
  await page.getByText("Expose the triadic projection to the GUI").first().waitFor({ timeout: 5_000 });

  // 回撤:decision 详情 → fact 详情 → 关系图聚光灯(焦点仍是 decision,未退化)。
  await page.getByTestId("nav-history-bar").getByRole("button", { name: /后退/u }).click();
  await page.getByTestId("fact-detail-view").waitFor({ timeout: 5_000 });
  await page.getByTestId("nav-history-bar").getByRole("button", { name: /后退/u }).click();
  await page.locator("[data-testid='ego-card'][data-entity='decision']").waitFor({ timeout: 5_000 });
  await page.locator("[data-testid='focus-history-bar']").waitFor({ timeout: 5_000 });

  assert.deepEqual(consoleFailures, [], "renderer emitted console errors");
});

async function closeElectronApp(electronApp) {
  const child = electronApp.process();
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await Promise.race([exited, sleep(5_000)]);
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
