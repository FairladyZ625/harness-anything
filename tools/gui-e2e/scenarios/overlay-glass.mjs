import assert from "node:assert/strict";
import { requestDaemonJsonRpcAt } from "../../../packages/daemon/src/client/local-json-rpc-client.ts";

// 浮层玻璃透底(task_2e9dedde,业主 2026-10-18 三轮截图):浮在内容之上的面——快速切换
// 浮层与新建 Provider/Agent/定时计划对话框——曾共用常驻面板档 .glass 的 0.7 半透明底,
// 下方密集文字透出与浮层文字叠读。统一浮层表面档 .glass-overlay 靠不透明面色(≥0.9)
// 保可读,不依赖 backdrop-filter(减弱动态效果/不支持环境同样可读)。
//
// 断言面:每个浮层面板计算样式的背景 alpha ≥ 0.9(alpha 是本任务的交付契约;blur 不可
// 作为断言,渲染环境差异大)。截图面:深/浅主题 × 四个浮层,供业主直接目验。夹具先种
// 4 条定时计划:快速切换浮层打开时下方才有密集文字,对齐业主截图的失败条件。
const REPO_ID = "gui-e2e-catalog";

async function overlayAlpha(page, selector) {
  return page
    .locator(selector)
    .first()
    .evaluate((node) => {
      const color = globalThis.getComputedStyle(node).backgroundColor;
      const slash = /\/\s*([\d.]+)\s*\)\s*$/u.exec(color);
      if (slash) return Number(slash[1]);
      const rgba = /^rgba\([^)]*,\s*([\d.]+)\)$/u.exec(color);
      if (rgba) return Number(rgba[1]);
      return color.startsWith("rgb(") ? 1 : Number.NaN;
    });
}

async function assertReadableOverlay(page, selector, label) {
  const alpha = await overlayAlpha(page, selector);
  assert.ok(alpha >= 0.9, `${label} 的浮层表面 alpha=${alpha} 必须 ≥0.9(可读性靠面色不透明度,不靠 blur)`);
}

export default {
  id: "overlay-glass",
  feature: "overlay-glass",
  lane: "isolated",
  description:
    "Overlay surfaces (quick switcher, new Provider/Agent/schedule dialogs) stay readable in both themes: " +
    "computed surface alpha ≥ 0.9 over dense list text, per the unified .glass-overlay tier.",
  async run({ page, app, shot }) {
    // 1. 种密集文字:4 条定时计划行,快速切换浮层打开时的下方内容。
    const endpoint = await app.evaluate(() => process.env.HARNESS_DAEMON_ENDPOINT);
    assert.ok(endpoint, "the isolated daemon endpoint must reach the electron main process");
    const rpc = (method, payload) =>
      requestDaemonJsonRpcAt(endpoint, method, { repo: { repoId: REPO_ID }, payload }, 30_000);
    for (let index = 1; index <= 4; index += 1) {
      const created = await rpc("repo.schedule.create", {
        scheduleId: `gui-e2e-overlay-${index}`,
        name: `浮层验收计划 ${index} · dense overlay row`,
        mode: "detect",
        everyMs: 3_600_000 * index,
        agentId: "e2e-probe",
        mission: "Dense row behind the overlay acceptance screenshots.",
        idempotencyKey: `gui-e2e:overlay-glass:create:${index}`,
      });
      assert.equal(created.ok, true, `schedule create ${index} failed: ${JSON.stringify(created)}`);
    }

    // 2. 界面切到中文再截图(业主验收语言;空夹具默认回放 en-US)。
    await page.getByRole("button", { name: /^(?:设置|Settings)$/u }).click();
    await page.getByTestId("settings-content").waitFor();
    await page.getByRole("button", { name: /语言|Language/u }).click();
    await page.getByLabel(/^语言$|^Language$/).selectOption("zh-CN");

    // 3. 四个浮层 × 深浅主题。主题切换走设置外观页的显式亮/暗按钮(确定性,不经
    //    system 档)。每个浮层:打开 → 等可见 → 断言面板 alpha → 截图 → 关闭。
    for (const theme of ["dark", "light"]) {
      // 对话框流程会把页面带到 Provider 页:每轮先回设置页再进外观页签;
      // 页签名带副标题(「外观 主题与状态色」),按前缀匹配。
      await page.getByRole("button", { name: /^(?:设置|Settings)$/u }).click();
      await page.getByTestId("settings-content").waitFor();
      await page.getByRole("button", { name: /^外观|^Appearance/u }).click();
      await page.getByRole("button", { name: theme === "dark" ? /暗色|Dark/u : /亮色|Light/u }).click();
      assert.equal(await page.locator("html").getAttribute("data-theme"), theme);

      // 3a. 快速切换浮层:定时计划页打开(下方是计划行 + 侧栏,密集文字在场)。
      await page.getByRole("button", { name: /^(?:定时计划|Schedules)$/u }).click();
      await page.getByTestId("schedules-view").waitFor();
      await page.getByTestId("schedule-row-gui-e2e-overlay-4").waitFor();
      await page.locator('button[title="快速切换项目"]').click();
      await page.getByTestId("quick-switcher-panel").waitFor();
      await assertReadableOverlay(page, '[data-testid="quick-switcher-panel"]', "快速切换浮层");
      await shot(`overlay-switcher-${theme}`);
      await page.locator('button[title="快速切换项目"]').click();

      // 3b. 新建定时计划对话框。
      await page.getByTestId("schedule-action-create").click();
      await page.getByTestId("schedule-form-dialog").waitFor();
      await assertReadableOverlay(page, '[data-testid="schedule-form-dialog"] .glass-overlay', "新建定时计划");
      await shot(`overlay-schedule-${theme}`);
      await page.keyboard.press("Escape");

      // 3c. 新建 Agent 对话框。
      await page.getByRole("button", { name: /^(?:Agent · 含 Squad|Agents · Squads)$/u }).click();
      await page.getByTestId("agent-squad-view").waitFor();
      await page.getByTestId("runtime-new-agents").click();
      await page.getByTestId("new-agent-dialog").waitFor();
      await assertReadableOverlay(page, '[data-testid="new-agent-dialog"] .glass-overlay', "新建 Agent");
      await shot(`overlay-agent-${theme}`);
      await page.keyboard.press("Escape");

      // 3d. 新建 Provider 对话框。
      await page.getByRole("button", { name: /^(?:Provider|Providers)$/u }).click();
      await page.getByTestId("providers-view").waitFor();
      await page.getByTestId("runtime-new-runtimes").click();
      await page.getByTestId("new-runtime-dialog").waitFor();
      await assertReadableOverlay(page, '[data-testid="new-runtime-dialog"] .glass-overlay', "新建 Provider");
      await shot(`overlay-provider-${theme}`);
      await page.keyboard.press("Escape");
    }
  },
};
