import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { requestDaemonJsonRpcAt } from "../../../packages/daemon/src/client/local-json-rpc-client.ts";
import { bridgeReady } from "./helpers.mjs";

/**
 * 时间线实体引用可导航(task 详情概况时间线):事件行尾的 execution 编号在
 * 真实 Electron 里可点、可键盘激活(聚焦 + Enter),落点是收口页签里该
 * execution 的记录行(不是任务概况),回概况后时间线原样;正文无横向溢出。
 * 数据面:经 daemon 聚合写口(repo.task.run 的 task-start 动作)造真实
 * execution,时间线与收口行都来自真实投影(不造前端夹具)。
 * 滚动验收:详情滚动区被约束成矮视口,引用行的自然位置必然在可视范围之外;
 * 导航后必须由滚动把它带进可视范围。renderer 真实挂 StrictMode,这里同时
 * 钉住 effect 重放下滚动不丢(review R1)。
 */
const TASK_ID = "task-gui-smoke";
const EXECUTION_ID = "execution-gui-timeline-e2e";
const PANEL_SCROLL_TESTID = "task-detail-panel-scroll";

export default {
  id: "task-timeline-record-navigation",
  feature: "board",
  lane: "isolated",
  description: "Timeline record refs open the matching closeout record row via click and keyboard.",
  async run({ page, fixture, shot, runRoot }) {
    // 真实 execution:task-start 记 claimedAt(创建 execution 记录;聚合对重复
    // start 不叠加 execution 行,垫高靠矮视口完成),task-submit 在同一
    // execution 上补 submittedAt;submit 受收口就绪门约束,拒收也不影响本
    // 场景(时间线与收口行只依赖 start 建立的 execution)。
    const receipts = {};
    for (const action of [
      { kind: "task-start", taskId: TASK_ID, executionId: EXECUTION_ID },
      { kind: "task-submit", taskId: TASK_ID },
    ]) {
      receipts[action.kind] = await requestDaemonJsonRpcAt(
        fixture.endpoint,
        "repo.task.run",
        { repo: { repoId: fixture.repoId }, payload: { action } },
        1_000,
        10_000,
      );
    }
    assert.equal(receipts["task-start"].ok, true, `task-start receipt: ${JSON.stringify(receipts["task-start"])}`);
    const read = await requestDaemonJsonRpcAt(
      fixture.endpoint,
      "repo.tasks.list",
      { repo: { repoId: fixture.repoId }, payload: {} },
      1_000,
      5_000,
    );
    writeFileSync(
      path.join(runRoot, "task-timeline-record-navigation-readback.json"),
      `${JSON.stringify({ receipts, tasks: read.rows?.map((row) => row.taskId) }, null, 2)}\n`,
    );
    const row = read.rows?.find((task) => task.taskId === TASK_ID);
    assert.ok(
      row?.snapshot?.task &&
        Array.isArray(row.snapshot.executions) &&
        row.snapshot.executions.some((execution) => execution.executionId === EXECUTION_ID),
      `projection must carry the seeded execution: ${JSON.stringify(row?.snapshot?.executions ?? null)}`,
    );

    await bridgeReady(page);
    await page.getByRole("button", { name: /^(?:看板|Board)$/u }).click();
    await page.getByTestId("board-task-card").first().click();
    await page
      .locator('aside [title^="task_"]')
      .or(page.getByRole("button", { name: /打开完整详情|Open full details/u }))
      .first()
      .click();
    await page.getByTestId("task-detail-view").waitFor();

    // 矮视口:约束详情滚动区高度,引用行的自然位置必然在可视范围外——
    // 「滚入视野」断言才有分辨力,不是本来就可见。
    await page.getByTestId(PANEL_SCROLL_TESTID).evaluate((node) => {
      node.style.height = "360px";
    });

    // 时间线行尾的 execution 编号是可激活路径(EntityRefLink 原生 button)。
    const refLink = page.locator('[data-testid="task-progress-timeline"] button', { hasText: EXECUTION_ID }).first();
    await refLink.waitFor();
    await shot("task-timeline-record-navigation-1-overview");

    // 键盘激活:聚焦后 Enter,与点击同一条打开路径。
    await refLink.focus();
    assert.equal(await refLink.evaluate((node) => globalThis.document.activeElement === node), true);
    await page.keyboard.press("Enter");
    await page.getByTestId("task-closeout-tab").waitFor();
    const focusedRow = page.getByTestId(`task-execution-${EXECUTION_ID}`);
    await focusedRow.waitFor();
    assert.match(await focusedRow.getAttribute("class"), /accent/u, "focused record row carries the accent highlight");

    // 滚动真实发生:行相对其滚动区(而非窗口)断言。rAF 驱动,先有界等待
    // 落定,再断言最终落点;随后把滚动区复位到顶部量自然位置——引用行必须
    // 在可视范围之外,证明是导航的滚动把它带进来的。
    const readPlacement = () =>
      focusedRow.evaluate((node, panelTestId) => {
        const panel = node.closest(`[data-testid="${panelTestId}"]`);
        const box = node.getBoundingClientRect();
        const frame = (panel ?? node.parentElement).getBoundingClientRect();
        return { top: box.top, bottom: box.bottom, frameTop: frame.top, frameBottom: frame.bottom };
      }, PANEL_SCROLL_TESTID);
    await page.waitForFunction(
      ({ rowId, panelId }) => {
        const row = document.querySelector(`[data-testid="${rowId}"]`);
        const panel = row?.closest(`[data-testid="${panelId}"]`) ?? row?.parentElement;
        if (!row || !panel) return false;
        const box = row.getBoundingClientRect(),
          frame = panel.getBoundingClientRect();
        return box.top >= frame.top && box.bottom <= frame.bottom;
      },
      { rowId: `task-execution-${EXECUTION_ID}`, panelId: PANEL_SCROLL_TESTID },
      { polling: "raf", timeout: 5_000 },
    );
    const placement = await readPlacement();
    assert.ok(
      placement.top >= placement.frameTop && placement.bottom <= placement.frameBottom,
      `focused row must sit inside the scroll viewport after navigation (top=${placement.top}, bottom=${placement.bottom}, frame=${placement.frameTop}..${placement.frameBottom})`,
    );
    await shot("task-timeline-record-navigation-2-closeout-focused");

    await page.getByTestId(PANEL_SCROLL_TESTID).evaluate((node) => {
      node.scrollTop = 0;
    });
    const natural = await readPlacement();
    assert.ok(
      natural.top >= natural.frameBottom,
      `focused row must start below the scroll viewport at natural position (top=${natural.top}, frameBottom=${natural.frameBottom}) — otherwise the in-view assertion had no discriminating power`,
    );

    // 返回概况:任务上下文原样(同一详情页、时间线仍在),正文无横向溢出。
    await page.getByRole("tab", { name: /概况|Overview/u }).click();
    await page.getByTestId("task-progress-timeline").waitFor();
    assert.equal(
      await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.window.innerWidth),
      true,
      "task detail body must not overflow horizontally",
    );
    await shot("task-timeline-record-navigation-3-back-to-overview");
  },
};
