import assert from "node:assert/strict";
import { nav } from "./helpers.mjs";

/**
 * #task_15b1bb96 总览产物速览架的落点:点一行 HTML 产物,任务详情直接停在文件页签
 * 并选中该产物的隔离 webview 预览,不用再在左侧文件列表里点一次。产物文件由夹具
 * lanes.mjs 写进 task-gui-smoke 的包(顶层无子任务,不是工作根,落普通任务详情)。
 */
export default {
  id: "overview-artifacts-shelf",
  feature: "overview",
  lane: "isolated",
  description: "Clicking an overview shelf HTML row opens the owning task detail directly at that artifact preview.",
  async run({ page, shot }) {
    await nav(page, /^(?:总览|Overview)$/u, "overview-view");
    const row = page.locator('[data-shelf-artifact="artifacts/preview-height.html"]');
    await row.waitFor();
    await shot("overview-shelf-before-click");
    // 行主点击面是包住内容列的内层 button(「在浏览器打开」动作在它右侧)。
    await row.getByRole("button").first().click();
    await page.getByTestId("task-detail-view").waitFor();
    // 页签断言用 id 精确锚定:dockview 分区 tab 同样带 role=tab + aria-selected。
    await page.locator('#task-tab-files[aria-selected="true"]').waitFor();
    assert.equal(
      await page.getByTestId("html-artifact-webview").getAttribute("data-artifact-path"),
      "artifacts/preview-height.html",
      "the clicked artifact must be the selected document",
    );
    await shot("overview-shelf-opens-html");
  },
};
