import assert from "node:assert/strict";
import { nav } from "./helpers.mjs";

/**
 * 总览产物速览架的落点(2026-10-11 业主意见 1):点一行 HTML 产物(或「查看全部产物」)
 * 进产物二级页——接近全屏,左窄列表是全部产物行,右大预览直接渲染被点产物(或最新
 * 一条)的隔离 webview;页内「跳到所属 task」保留 #task_15b1bb96 的行为(任务详情直接
 * 停在文件页签并选中该产物)。产物文件由夹具 lanes.mjs 写进 task-gui-smoke 的包
 * (顶层无子任务,不是工作根,落普通任务详情)。
 */
export default {
  id: "overview-artifacts-shelf",
  feature: "overview",
  lane: "isolated",
  description:
    "Clicking an overview shelf HTML row (or the open-all footer) opens the near-fullscreen artifacts page: " +
    "a narrow list of every artifact beside a large preview rendering the clicked artifact's isolated webview, " +
    "with the page's open-task action landing on the owning task detail directly at that artifact preview.",
  async run({ page, shot }) {
    await nav(page, /^(?:总览|Overview)$/u, "overview-view");
    const row = page.locator('[data-shelf-artifact="artifacts/preview-height.html"]');
    await row.waitFor();
    await shot("overview-shelf-before-click");
    // 行主点击面是包住内容列的内层 button(「在浏览器打开」动作在它右侧)。
    await row.getByRole("button").first().click();
    const dialog = page.locator('[data-testid="overview-artifacts-page"]');
    await dialog.waitFor();
    // 二级页右栏直接渲染被点产物的隔离预览:同一行 HTML,左窄列表全部产物行可见。
    await dialog.locator('[data-testid="html-artifact-webview"]').waitFor();
    assert.equal(
      await dialog.getByTestId("html-artifact-webview").getAttribute("data-artifact-path"),
      "artifacts/preview-height.html",
      "the clicked artifact must render in the secondary page's preview",
    );
    const listRows = await dialog.locator('[data-testid="overview-artifacts-page-list"] [data-dense-row]').count();
    assert.ok(listRows >= 1, "the narrow list must carry the artifact rows");
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
