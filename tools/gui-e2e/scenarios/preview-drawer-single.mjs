import assert from "node:assert/strict";
import { requestDaemonJsonRpcAt } from "../../../packages/daemon/src/client/local-json-rpc-client.ts";
import { bridgeReady, nav } from "./helpers.mjs";

// 任务预览抽屉单层语义(业主 2026-10-17「点了之后右边只有一个……前面点了很多,
// 要关掉好几次,一直关」):连点不同卡片,历史栈只留一条预览条目(换卡替换当前条目),
// 一次 Esc 直回看板列表,后退栈里没有中间预览。
// 卡片点击走真实输入管线:抽屉开着时 mousedown 先落「点外部关闭」(弹回列表),
// 随后的 click 再推新卡(仍是一条);抽屉内换卡(关联任务/成员行)不经过外压,
// 靠 openTaskPreview 原地替换避免堆栈——那一半在 navigation-global-history vitest
// 挂真实 hook 覆盖。

async function createTask(endpoint, repoId, taskId, title) {
  const created = await requestDaemonJsonRpcAt(
    endpoint,
    "repo.task.create",
    { repo: { repoId }, payload: { taskId, title } },
    5_000,
    30_000,
  );
  assert.equal(created.ok, true, `task create ${taskId}: ${JSON.stringify(created).slice(0, 300)}`);
}

export default {
  id: "preview-drawer-single",
  feature: "board",
  lane: "isolated",
  description:
    "Clicking several task cards in a row keeps a single preview drawer entry; one Escape returns to the board and the history stack holds no intermediate previews.",
  async run({ page, fixture, shot }) {
    await bridgeReady(page);
    await createTask(fixture.endpoint, fixture.repoId, "task-preview-a", "预览抽屉单层 A");
    await createTask(fixture.endpoint, fixture.repoId, "task-preview-b", "预览抽屉单层 B");
    // 种子发生在 GUI 挂载之后:重载让读面重新拉取,不吃 stale 缓存。
    await page.reload();
    await bridgeReady(page);
    await nav(page, /^(?:看板|Board)$/u, "board-task-card");
    const cardOf = (title) => page.getByTestId("board-task-card").filter({ hasText: title }).first();

    // 连点三张卡:屏幕上始终只有一个抽屉。
    for (const title of ["Render the real triadic projection", "预览抽屉单层 A", "预览抽屉单层 B"]) {
      await cardOf(title).waitFor({ timeout: 20_000 });
      await cardOf(title).click();
      await page.locator("aside[role=dialog]").waitFor({ state: "visible" });
    }
    assert.equal(await page.locator("aside[role=dialog]").count(), 1, "连点三张卡,屏幕上只有一个抽屉");
    await shot("preview-drawer-single-open");

    // 一次 Esc 直回看板列表。
    await page.keyboard.press("Escape");
    await page.locator("aside[role=dialog]").waitFor({ state: "hidden" });
    await page.getByTestId("board-task-card").first().waitFor();
    await shot("preview-drawer-single-esc-back-to-board");

    // 历史栈整栈只剩最后一张卡的预览条目,没有中间预览。运行期栈写在每窗口的
    // sessionStorage(PR #3686);localStorage 只在 pagehide 交接时才有内容。
    const previews = await page.evaluate(() =>
      Object.entries(globalThis.sessionStorage)
        .filter(([key]) => key.startsWith("harness-view-history:"))
        .flatMap(([, raw]) =>
          JSON.parse(raw)
            .history.entries.filter((entry) => entry.previewId !== null)
            .map((entry) => entry.previewId),
        ),
    );
    assert.deepEqual(previews, ["task-preview-b"], `历史栈应只保留最后一张卡的预览条目: ${JSON.stringify(previews)}`);
  },
};
