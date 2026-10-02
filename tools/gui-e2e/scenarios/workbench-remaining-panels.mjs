import assert from "node:assert/strict";
import { bridgeReady } from "./helpers.mjs";

/**
 * 剩余功能面板(task_d87e6982658ceccc5f26c80f30)的真实交互旅程:
 * 工作列表/议程/看板/研发态势/失真预警/待办签发/任务·事实·决策详情/实体/预设/
 * 引擎适配器/Agent·Squad/Token/系统/Daemon观察/设置/账号访问控制/终端/浏览器。
 * 每个面板挂真实功能体(自带读面按 repoId 走,失败如实显示);核心交互覆盖:
 * 任务详情面板的本地任务选择与真实详情体、看板面板的本地预览抽屉(portal 出浮窗)、
 * 终端面板的挂载与关闭(会话不删,资源语义与离页一致)。断言只认 data-testid;
 * 等待一律 waitFor 的离散条件,不用墙钟 sleep。
 */
const BODY = "[data-testid='floating-panel-body']";
const CATALOG_ENTRY = (id) => `[data-testid='panel-catalog-entry-${id}']`;

async function ensureCatalogOpen(page) {
  const open = await page.getByTestId("panel-catalog-list").isVisible();
  if (!open) await page.getByTestId("panel-catalog-button").click();
  await page.getByTestId("panel-catalog-list").waitFor();
}

async function addPanel(page, id) {
  await ensureCatalogOpen(page);
  await page.locator(CATALOG_ENTRY(id)).click();
}

async function waitForPanelBody(page, panelId, bodySelector) {
  await page.locator(`${BODY}[data-panel-id='${panelId}'] ${bodySelector}`).first().waitFor();
}

export default {
  id: "workbench-remaining-panels",
  feature: "panel-workspace",
  lane: "isolated",
  description:
    "The workbench mounts the remaining real-route panels (work/agenda/board/cadence/pool/details/entities/presets/adapters/agentSquad/token/system/observe/settings/identity/terminal/browser) with their real bodies, local entity selection, and page-parity resource lifecycle for the terminal.",
  async run({ page, shot }) {
    await bridgeReady(page);
    await page.getByRole("button", { name: /^(?:面板工作台|Panel Workbench)$/u }).click();
    await page.locator("[data-testid='floating-panel-grid']").waitFor();
    await page.getByTestId("panel-workbench-reset").click();
    await page.waitForFunction(() => {
      const ids = [...globalThis.document.querySelectorAll("[data-testid='floating-panel-body']")].map(
        (node) => node.dataset.panelId,
      );
      return ids.length === 3 && ["documents", "graph", "timeline"].every((id) => ids.includes(id));
    });

    // 台账域:工作列表(开始一项工作主动作在面板动作条)、议程(筛选行)、看板(筛选条)。
    await addPanel(page, "works");
    await waitForPanelBody(page, "works", "[data-testid='work-view']");
    await waitForPanelBody(page, "works", "[data-testid='work-start-work']");
    await addPanel(page, "agenda");
    await waitForPanelBody(page, "agenda", "[data-testid='agenda-view']");
    await waitForPanelBody(page, "agenda", "[data-testid='agenda-filter-chips']");
    await addPanel(page, "board");
    await waitForPanelBody(page, "board", "[data-testid='board-filter-bar']");
    // 看板面板:卡片点击开面板本地预览抽屉;抽屉壳 portal 到 body,不在浮窗容器里。
    // 级联预设下面板互相叠放——先点拖条把看板浮窗抬到顶层再点卡。
    const boardWindow = page
      .locator(".dv-resize-container")
      .filter({ has: page.locator(`${BODY}[data-panel-id='board']`) });
    await boardWindow.locator(".dv-floating-titlebar").click();
    const card = page.locator(`${BODY}[data-panel-id='board'] [data-testid='board-task-card']`).first();
    await card.waitFor();
    await card.click();
    const drawer = page.locator("body > aside[role='dialog']");
    await drawer.waitFor();
    const drawerInPanel = await page.locator(`${BODY}[data-panel-id='board'] aside[role='dialog']`).count();
    assert.equal(drawerInPanel, 0, "preview drawer portals out of the floating panel");
    await shot("workbench-board-local-preview");
    await page.keyboard.press("Escape");

    await addPanel(page, "cadence");
    // cadence 的模式/扫描计数在被卸下的页头里;面板内以真实区域板为钩子。
    await waitForPanelBody(page, "cadence", "[data-testid='cadence-board'], [data-testid='cadence-unavailable']");
    await addPanel(page, "freshness");
    await waitForPanelBody(page, "freshness", "[data-testid='freshness-view']");

    // 治理域:待办签发总池(域 Tab)、任务详情(本地选择 + 真实详情体)。
    await addPanel(page, "decisionPool");
    await waitForPanelBody(page, "decisionPool", "[data-testid='attestation-pool-view']");
    await addPanel(page, "taskDetail");
    await waitForPanelBody(page, "taskDetail", "[data-testid='workbench-task-detail-task']");
    await waitForPanelBody(page, "taskDetail", "[data-testid='task-detail-view']");
    await shot("workbench-task-detail-panel");

    // 系统域:预设/适配器/实体/Agent·Squad/Token/系统/Daemon观察/设置/账号访问控制。
    for (const [id, body] of [
      ["presets", "[data-testid='presets-content'], [data-testid^='preset']"],
      [
        "adapters",
        "[data-testid='adapters-content'], [data-testid='workbench-adapters-panel'] p, [data-testid='adapters-content']",
      ],
      ["entities", "[data-testid='entities-view'], section"],
      ["agentSquad", "[data-testid='agent-squad-view']"],
      ["tokenUsage", "[data-testid='token-usage-view']"],
      ["system", "[data-testid='system-conclusion']"],
      ["daemonObserve", "[data-testid='daemon-observe-content']"],
      ["settings", "[data-testid='settings-content']"],
      ["identityAccess", "[data-testid='identity-access-view'], [role='alert']"],
    ]) {
      await addPanel(page, id);
      await waitForPanelBody(page, id, body);
    }
    await shot("workbench-system-domain-panels");

    // 终端面板:挂载真实终端工作台(terminal-view 是终端页同一功能体的根);关闭面板
    // = 离开终端页语义(停流 + detach,会话保留),不产生重复会话资源。
    await addPanel(page, "terminal");
    await waitForPanelBody(page, "terminal", "[data-testid='terminal-view']");
    const terminalBodies = await page.locator(`${BODY}[data-panel-id='terminal']`).count();
    assert.equal(terminalBodies, 1, "one terminal panel instance");
    await shot("workbench-terminal-panel");
    // 面板众多时互相叠放:先抬层再点关闭钮,点击不被邻居浮窗截走。
    const terminalWindow = page
      .locator(".dv-resize-container")
      .filter({ has: page.locator(`${BODY}[data-panel-id='terminal']`) });
    await terminalWindow.locator(".dv-floating-titlebar").click();
    await terminalWindow.locator("[data-testid='floating-panel-close']").first().click();
    await page.locator(`${BODY}[data-panel-id='terminal']`).waitFor({ state: "detached" });

    // 浏览器面板:地址栏 + webview 宿主挂载。
    await addPanel(page, "browser");
    await waitForPanelBody(page, "browser", "[data-testid='browser-view']");
    await shot("workbench-browser-panel");
  },
};
