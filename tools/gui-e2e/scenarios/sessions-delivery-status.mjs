import assert from "node:assert/strict";
import path from "node:path";
import { nav } from "./helpers.mjs";
import {
  DELIVERY_TASK,
  STALLED_TASK,
  deliveryRound,
  stalledRound,
  driveDeliveryTaskLifecycle,
} from "./sessions-delivery-status.support.mjs";

/**
 * 会话页交付真相(task_10e4cd6f09ee0317ae06c641fd):一个 artifacts-only 提交
 * (空公共 manifest,commitSha=null)的 stopped 轮次必须显示「已成功」,一个真未提交的
 * stopped 轮次必须保持「已停手·未交付」。数据经真实 RPC 生命周期
 * (task-start → doc-submit → task-submit)+ 停机窗口种的 runtime 事件(生产同形)。
 * 截图先落盘再断言:修前代码上跑本场景会红,同时留下「已停手·未交付」的修前证据图。
 */
export default {
  id: "sessions-delivery-status",
  feature: "sessions",
  lane: "isolated",
  description:
    "A stopped round whose execution submitted an artifacts-only delivery reads as delivered, while a stopped round without a submission stays stopped-without-delivery; element shots land before the assertions.",
  async run({ page, app, fixture, shot, runRoot }) {
    const windows = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().some((window) => window.isVisible() || window.isFocused()),
    );
    assert.equal(windows, false, "the sessions delivery scenario must stay hidden");
    const submission = await driveDeliveryTaskLifecycle(fixture);
    assert.equal(
      submission.commitSha,
      null,
      `fixture submission must be artifacts-only (empty public manifest): ${JSON.stringify(submission)}`,
    );
    assert.ok(
      (submission.artifacts ?? []).length > 0,
      `fixture submission must freeze at least one artifact: ${JSON.stringify(submission)}`,
    );

    await nav(page, /^(?:会话|Sessions)$/u, "sessions-view");
    const deliveryGroup = page.getByTestId(`session-group-${DELIVERY_TASK}`),
      stalledGroup = page.getByTestId(`session-group-${STALLED_TASK}`);
    await deliveryGroup.waitFor();
    await stalledGroup.waitFor();
    await page.getByTestId(`session-group-toggle-${DELIVERY_TASK}`).click();
    await page.getByTestId(`session-group-toggle-${STALLED_TASK}`).click();

    const deliveryRow = page.getByTestId(`rail-session-${deliveryRound.runtimeSessionId}`),
      stalledRow = page.getByTestId(`rail-session-${stalledRound.runtimeSessionId}`);
    // 元素截图先落盘(可见性等待即取景守卫),断言放后:修前跑红也能拿到修前证据图。
    await deliveryRow.waitFor();
    await stalledRow.waitFor();
    await deliveryRow.screenshot({ path: path.join(runRoot, "sessions-delivery-delivered-row.png") });
    await stalledRow.screenshot({ path: path.join(runRoot, "sessions-delivery-stalled-row.png") });
    await shot("sessions-delivery-status");

    assert.match(
      (await deliveryRow.textContent()) ?? "",
      /已成功|Succeeded/u,
      "an artifacts-only submission must read as delivered",
    );
    assert.match(
      (await stalledRow.textContent()) ?? "",
      /已停手·未交付|Stopped · not delivered/u,
      "a round without a submission must stay stopped-without-delivery",
    );
  },
};
