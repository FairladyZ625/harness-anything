import assert from "node:assert/strict";
import { bridgeReady, nav } from "./helpers.mjs";

// 重构区第一个页面「今天」(dec_C612E69B7C7E3480A5F9D2CAD3 CH1):侧栏在现有四组之外
// 新增「重构」组(带「试用」小标),进入后页面回答三件事——等你处理 / 正在跑 / 刚交付,
// 每块一个数;空态写人话。区域页脚的「议程 / 会话」出口离开重构区回旧页面。
// 本场景在 isolated lane 独立可跑:空仓下三块都是空态,结构断言不依赖真实台账数据。
export default {
  id: "redesign-today",
  feature: "redesign-zone",
  lane: "isolated",
  description:
    "Redesign zone sidebar group (trial tag) opens the Today page answering three questions with empty-state honesty.",
  async run({ page, shot }) {
    await bridgeReady(page);
    // 侧栏重构组:组头带「试用」小标,旧四组仍在其上。
    const group = page.getByTestId("sidebar-redesign-group");
    await group.waitFor();
    assert.match(await group.innerText(), /(?:重构|Redesign)/u);
    assert.match(await group.innerText(), /(?:试用|trial)/u);
    // 进入「今天」:三块区域各就位。
    await nav(page, /^(?:今天|Today)$/u, "today-view");
    const board = page.getByTestId("today-board");
    await board.waitFor();
    const text = await board.innerText();
    for (const label of [/(?:等你处理|Waiting on you)/u, /(?:正在跑|Running now)/u, /(?:刚交付|Just delivered)/u])
      assert.match(text, label, `today board must answer all three questions, got: ${text}`);
    // 等你处理每行带一个首要动作按钮(答复就地去面板,其余开单层抽屉);行首屏不出 ID。
    const waitingRows = await board.locator('[data-testid^="today-waiting-row-"]').count();
    const primaryActions = await board
      .locator('[data-testid^="today-handle-"], [data-testid^="today-answer-"]')
      .count();
    assert.equal(primaryActions, waitingRows, "every waiting row carries exactly one primary action");
    // 非空数据下抽屉可开、给「打开完整详情」出口(空仓时这段自然跳过,空态由 vitest 覆盖)。
    if (waitingRows > 0) {
      await board.locator('[data-testid^="today-handle-"]').first().click();
      await page.getByTestId("today-drawer-open").waitFor();
      await shot("redesign-today-drawer");
      await page.keyboard.press("Escape");
    }
    await shot("redesign-today");
    // 页脚出口:离开重构区回旧页面(议程),「今天」不再占主区。
    await page.getByTestId("today-waiting-open-agenda").click();
    await page.getByTestId("agenda-view").waitFor();
    assert.equal(await page.getByTestId("today-view").count(), 0);
    await shot("redesign-today-exit-to-agenda");
    // 再次进入后,「会话」出口同样离开重构区。
    await nav(page, /^(?:今天|Today)$/u, "today-view");
    await page.getByTestId("today-running-open-sessions").click();
    await page.getByTestId("sessions-view").waitFor();
    assert.equal(await page.getByTestId("today-view").count(), 0);
  },
};
