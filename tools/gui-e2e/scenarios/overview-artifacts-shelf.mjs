import assert from "node:assert/strict";
import { nav } from "./helpers.mjs";

/**
 * #task_88003efc 总览产物速览架的落点(2026-10-07 三块区域返工):点一行 HTML 产物,
 * 原地弹产物详情层——层内直接渲染该 HTML 的隔离 webview 预览(不离开总览);层内
 * 「跳到所属 task」保留 #task_15b1bb96 的行为(任务详情直接停在文件页签并选中该产物)。
 * 产物文件由夹具 lanes.mjs 写进 task-gui-smoke 的包(顶层无子任务,不是工作根,落普通
 * 任务详情)。
 */
export default {
  id: "overview-artifacts-shelf",
  feature: "overview",
  lane: "isolated",
  description:
    "Clicking an overview shelf HTML row opens an in-place artifact detail layer rendering that HTML's isolated " +
    "webview without leaving the overview; the layer's open-task action lands on the owning task detail directly " +
    "at that artifact preview.",
  async run({ page, shot }) {
    await nav(page, /^(?:总览|Overview)$/u, "overview-view");
    const row = page.locator('[data-shelf-artifact="artifacts/preview-height.html"]');
    await row.waitFor();
    await shot("overview-shelf-before-click");
    // 行主点击面是包住内容列的内层 button(「在浏览器打开」动作在它右侧)。
    await row.getByRole("button").first().click();
    const dialog = page.locator('[role="dialog"]');
    await dialog.waitFor();
    // 详情层右栏直接渲染被点产物的隔离预览:同一行 HTML,不离开总览。
    await dialog.locator('[data-testid="html-artifact-webview"]').waitFor();
    assert.equal(
      await dialog.getByTestId("html-artifact-webview").getAttribute("data-artifact-path"),
      "artifacts/preview-height.html",
      "the clicked artifact must render in the detail layer",
    );
    await shot("overview-shelf-opens-html");

    // 「跳到所属 task」(#task_15b1bb96 落点):任务详情停在文件页签并选中该产物文档。
    await dialog.getByTestId("overview-artifact-detail-open-task").click();
    await page.getByTestId("task-detail-view").waitFor();
    // 页签断言用 id 精确锚定:dockview 分区 tab 同样带 role=tab + aria-selected。
    await page.locator('#task-tab-files[aria-selected="true"]').waitFor();
    assert.equal(
      await page.getByTestId("html-artifact-webview").getAttribute("data-artifact-path"),
      "artifacts/preview-height.html",
      "opening the owning task must still select the clicked artifact",
    );
    await shot("overview-shelf-opens-task-detail");
  },
};
