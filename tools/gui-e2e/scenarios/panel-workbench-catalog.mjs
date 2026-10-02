import assert from "node:assert/strict";
import { bridgeReady } from "./helpers.mjs";

/**
 * 工作台面板目录与自由组合(task_48fe291624e06a2e9ad9496c81)的真实交互旅程:
 * 默认三面板 → 目录逐个添加五个可选面板(总览/会话/定时计划/产物/Provider,各自的
 * 真实功能体挂进画板)→ 面板标签关闭钮摘下面板 → 关闭全部后空画布可找回 → reload
 * 恢复所选集合 → 重置回默认三块。断言只认 data-testid 钩子;等待一律 waitFor/
 * locator.waitFor 的离散条件,不用墙钟 sleep。
 */
const BODY = "[data-testid='floating-panel-body']";
const CATALOG_ENTRY = (id) => `[data-testid='panel-catalog-entry-${id}']`;

async function openPanelIds(page) {
  const ids = await page.locator(BODY).evaluateAll((nodes) => nodes.map((node) => node.dataset.panelId));
  return [...ids].sort();
}

async function pressedEntries(page) {
  return page
    .locator("[aria-pressed='true'][data-testid^='panel-catalog-entry-']")
    .evaluateAll((nodes) => nodes.map((node) => node.dataset.testid.replace("panel-catalog-entry-", "")).sort());
}

async function waitForPanelBody(page, panelId, bodySelector) {
  await page.locator(`${BODY}[data-panel-id='${panelId}'] ${bodySelector}`).first().waitFor();
}

/** 目录气泡在画板上有任何点击(如面板关闭钮)后会被 outside-mousedown 收起;
 * 每轮目录操作前先把它带到确定打开态。 */
async function ensureCatalogOpen(page) {
  const open = await page.getByTestId("panel-catalog-list").isVisible();
  if (!open) await page.getByTestId("panel-catalog-button").click();
  await page.getByTestId("panel-catalog-list").waitFor();
}

export default {
  id: "panel-workbench-catalog",
  feature: "panel-workspace",
  lane: "isolated",
  description:
    "The workbench catalog adds and removes real feature panels; selection persists per workspace, the empty canvas stays recoverable, and reset returns the default three.",
  async run({ page, shot }) {
    await bridgeReady(page);
    await page.getByRole("button", { name: /^(?:面板工作台|Panel Workbench)$/u }).click();
    await page.locator("[data-testid='floating-panel-grid']").waitFor();
    await page.locator(BODY).first().waitFor();
    // 同一 lane 的场景共享同一个 app 实例(前一场景可能留下放大的面板/残存几何):
    // 先重置,把画板固定到本场景的前提状态——默认三块 + 预设平铺,不依赖执行顺序。
    await page.getByTestId("panel-workbench-reset").click();
    await page.waitForFunction(() => {
      const ids = [...globalThis.document.querySelectorAll("[data-testid='floating-panel-body']")].map(
        (node) => node.dataset.panelId,
      );
      return ids.length === 3 && ["documents", "graph", "timeline"].every((id) => ids.includes(id));
    });
    assert.deepEqual(
      await openPanelIds(page),
      ["documents", "graph", "timeline"],
      "workbench opens on the preset three",
    );

    // 目录是有限清单:八个条目,默认三个呈按下态。
    await page.getByTestId("panel-catalog-button").click();
    await page.getByTestId("panel-catalog-list").waitFor();
    assert.equal(
      await page.locator("[data-testid^='panel-catalog-entry-']").count(),
      8,
      "catalog lists exactly the eight panel types",
    );
    assert.deepEqual(await pressedEntries(page), ["documents", "graph", "timeline"]);

    // 逐个添加五个可选面板:每个面板挂的是真实功能体,不是静态摘要。
    for (const id of ["overview", "sessions", "schedules", "artifacts", "providers"]) {
      await page.locator(CATALOG_ENTRY(id)).click();
    }
    await waitForPanelBody(page, "overview", "[data-testid='overview-view']");
    await waitForPanelBody(page, "sessions", "[data-testid='sessions-view']");
    await waitForPanelBody(page, "schedules", "[data-testid='workbench-schedules-panel']");
    await waitForPanelBody(page, "artifacts", "[data-testid='artifacts-drawer']");
    await waitForPanelBody(page, "providers", "[data-testid='providers-view']");
    assert.deepEqual(await openPanelIds(page), [
      "artifacts",
      "documents",
      "graph",
      "overview",
      "providers",
      "schedules",
      "sessions",
      "timeline",
    ]);
    // 每个面板标签都有放大与关闭钮;关闭只是摘下面板,目录随时可加回。
    assert.equal(
      await page.getByTestId("floating-panel-close").count(),
      8,
      "every floating panel exposes a close button",
    );
    await shot("panel-catalog-all-eight");

    // 面板标签上的关闭钮摘下 documents;目录同步回未按下态(关闭钮的点击会收起气泡,重开)。
    await page.locator("[data-testid='floating-panel-close'][data-panel-id='documents']").first().click();
    await page.locator(`${BODY}[data-panel-id='documents']`).waitFor({ state: "detached" });
    assert.equal((await openPanelIds(page)).includes("documents"), false);
    await ensureCatalogOpen(page);
    assert.deepEqual(await pressedEntries(page), [
      "artifacts",
      "graph",
      "overview",
      "providers",
      "schedules",
      "sessions",
      "timeline",
    ]);

    // 目录开关摘下其余面板:空画布给出可找回的空态。
    for (const id of ["artifacts", "graph", "overview", "providers", "schedules", "sessions", "timeline"]) {
      await page.locator(CATALOG_ENTRY(id)).click();
    }
    await page.getByTestId("panel-workbench-empty").waitFor();
    assert.equal(await page.locator(BODY).count(), 0, "closing every panel empties the canvas");
    await shot("panel-catalog-empty-canvas");

    // 空画布上加回一块;面板内容(关系图的领地块)真实挂载。
    await ensureCatalogOpen(page);
    await page.locator(CATALOG_ENTRY("graph")).click();
    await waitForPanelBody(page, "graph", "[data-testid='territory-chip']");

    // 所选集合落盘:reload(同一临时 profile)后恢复「只有关系图」。
    await page.reload();
    await page.getByRole("button", { name: /^(?:面板工作台|Panel Workbench)$/u }).click();
    await page.locator(BODY).first().waitFor();
    assert.deepEqual(await openPanelIds(page), ["graph"], "selection restores across reload");
    await shot("panel-catalog-selection-restored");

    // 重置布局:选择集合与几何一起回默认三块。
    await page.getByTestId("panel-workbench-reset").click();
    await page.waitForFunction(() => {
      const panels = [...globalThis.document.querySelectorAll("[data-testid='floating-panel-body']")].map(
        (node) => node.dataset.panelId,
      );
      return (
        panels.length === 3 && panels.includes("documents") && panels.includes("graph") && panels.includes("timeline")
      );
    });
    await shot("panel-catalog-reset-defaults");
  },
};
