import assert from "node:assert/strict";
import { requestDaemonJsonRpcAt } from "../../../packages/daemon/src/client/local-json-rpc-client.ts";
import { assertUnfilteredOverlayState, waitForEntrySettled } from "./helpers.mjs";

// 浮层玻璃透底(task_2e9dedde,业主 2026-10-18 三轮截图):浮在内容之上的面——快速切换
// 浮层与新建 Provider/Agent/定时计划对话框——曾共用常驻面板档 .glass 的 0.7 半透明底,
// 下方密集文字透出与浮层文字叠读。统一浮层表面档 .glass-overlay 靠不透明面色(≥0.9)
// 保可读,不依赖 backdrop-filter(减弱动态效果/不支持环境同样可读)。
//
// 断言面两件事:每个浮层面板计算样式的背景 alpha ≥ 0.9(alpha 是本任务的交付契约;
// blur 不可作为断言,渲染环境差异大);且断言/截图前先等入场动画 settle——面板计算
// 样式 opacity 回到 "1"。返工根因(task_2e9dedde iteration 0):Modal 面板自身是
// motion 入场元素(opacity 0→1),截图取在动画中途时面板渲染半透明而声明 alpha 不变,
// 只断言声明背景 alpha 对此零分辨力、假绿。读渲染器实际合成的同一通道(计算 opacity)
// 才能让本场景对这种失败红;不选像素采样——阈值依赖截图背后的具体内容,计算 opacity
// 精确、确定,且「减弱动态效果」(入场仍有 100ms 纯淡入)与全动效两种设置下同样成立。
// 截图面:深/浅主题 × 四个浮层 + 一张减弱动态效果下的定时计划对话框,供业主直接目验。
// 夹具先种 4 条定时计划:快速切换浮层打开时下方才有密集文字,对齐业主截图的失败条件。
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
  const settled = await page
    .locator(selector)
    .first()
    .evaluate((node) => globalThis.getComputedStyle(node).opacity);
  assert.equal(
    settled,
    "1",
    `${label} 计算样式 opacity=${settled} ≠ 1:入场动画未完成,此刻面板仍半透明(返工要防的失败形态)`,
  );
}

async function assertReadableModal(page, selector, label) {
  await assertReadableOverlay(page, selector, label);
  const state = await page
    .locator(selector)
    .first()
    .evaluate((panel) => {
      const dialog = panel.closest("dialog");
      const scrim = dialog?.querySelector(".glass-scrim");
      const ancestorFilters = [];
      for (let ancestor = panel.parentElement; ancestor !== null; ancestor = ancestor.parentElement) {
        const style = globalThis.getComputedStyle(ancestor);
        if (style.filter !== "none" || style.backdropFilter !== "none") {
          ancestorFilters.push({ tag: ancestor.tagName, filter: style.filter, backdropFilter: style.backdropFilter });
        }
      }
      const panelStyle = globalThis.getComputedStyle(panel);
      const scrimStyle = scrim === null ? null : globalThis.getComputedStyle(scrim);
      return {
        panelFilter: panelStyle.filter,
        panelBackdropFilter: panelStyle.backdropFilter,
        ancestorFilters,
        scrimFilter: scrimStyle?.filter ?? "missing",
        scrimBackdropFilter: scrimStyle?.backdropFilter ?? "missing",
        dialogBackdropFilter:
          dialog === null ? "missing" : globalThis.getComputedStyle(dialog, "::backdrop").backdropFilter,
      };
    });
  assertUnfilteredOverlayState(state, label);
  assert.match(state.dialogBackdropFilter, /blur\(/u, `${label} blur 必须只出现在 dialog::backdrop`);
}

export default {
  id: "overlay-glass",
  feature: "overlay-glass",
  lane: "isolated",
  description:
    "Overlay surfaces (quick switcher, new Provider/Agent/schedule dialogs) stay readable in both themes: " +
    "computed surface alpha ≥ 0.9 over dense list text with the entry animation settled (computed opacity 1) " +
    "before every assertion/capture, per the unified .glass-overlay tier.",
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
    //    system 档)。每个浮层:打开 → 等可见 → 等入场 settle → 断言面板 alpha 与
    //    settled opacity → 截图 → 关闭。
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
      await waitForEntrySettled(page, '[data-testid="quick-switcher-panel"]');
      await assertReadableOverlay(page, '[data-testid="quick-switcher-panel"]', "快速切换浮层");
      await shot(`overlay-switcher-${theme}`);
      await page.locator('button[title="快速切换项目"]').click();

      // 3b. 新建定时计划对话框。
      await page.getByTestId("schedule-action-create").click();
      await page.getByTestId("schedule-form-dialog").waitFor();
      await waitForEntrySettled(page, '[data-testid="schedule-form-dialog"] .glass-overlay');
      await assertReadableModal(page, '[data-testid="schedule-form-dialog"] .glass-overlay', "新建定时计划");
      await shot(`overlay-schedule-${theme}`);
      await page.keyboard.press("Escape");

      // 3c. 新建 Agent 对话框。
      await page.getByRole("button", { name: /^(?:Agent · 含 Squad|Agents · Squads)$/u }).click();
      await page.getByTestId("agent-squad-view").waitFor();
      await page.getByTestId("runtime-new-agents").click();
      await page.getByTestId("new-agent-dialog").waitFor();
      await waitForEntrySettled(page, '[data-testid="new-agent-dialog"] .glass-overlay');
      await assertReadableModal(page, '[data-testid="new-agent-dialog"] .glass-overlay', "新建 Agent");
      await shot(`overlay-agent-${theme}`);
      await page.keyboard.press("Escape");

      // 3d. 新建 Provider 对话框。入口先是类型选择(PR #3760):选 LLM 才进表单。
      await page.getByRole("button", { name: /^(?:Provider|Providers)$/u }).click();
      await page.getByTestId("providers-view").waitFor();
      await page.getByTestId("runtime-new-runtimes").click();
      await page.getByTestId("provider-type-dialog").waitFor();
      await page.getByTestId("provider-type-llm").click();
      await page.getByTestId("new-runtime-dialog").waitFor();
      await waitForEntrySettled(page, '[data-testid="new-runtime-dialog"] .glass-overlay');
      await assertReadableModal(page, '[data-testid="new-runtime-dialog"] .glass-overlay', "新建 Provider");
      await shot(`overlay-provider-${theme}`);
      await page.keyboard.press("Escape");
    }

    // 4. 业主开着「减弱动态效果」:该偏好下 Modal 入场不取消,只是退为 100ms 纯淡入
    //    (Modal.tsx 的 reduced 分支)——settle 契约与可读断言在该设置下必须同样成立。
    //    循环停在浅色主题,直接复用。emulate 先例:collaboration-view。
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByRole("button", { name: /^(?:定时计划|Schedules)$/u }).click();
    await page.getByTestId("schedules-view").waitFor();
    await page.getByTestId("schedule-action-create").click();
    await page.getByTestId("schedule-form-dialog").waitFor();
    await waitForEntrySettled(page, '[data-testid="schedule-form-dialog"] .glass-overlay');
    await assertReadableModal(
      page,
      '[data-testid="schedule-form-dialog"] .glass-overlay',
      "新建定时计划(减弱动态效果)",
    );
    await shot("overlay-schedule-light-reduced");
    await page.keyboard.press("Escape");
  },
};
