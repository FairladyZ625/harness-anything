import assert from "node:assert/strict";
import { bridgeReady, nav } from "./helpers.mjs";

// 重构区「你交代的事」页(task_a3ffd5ceb;dec_C612E69B7C7E3480A5F9D2CAD3 CH1):侧栏
// 「重构」组的第二个 tab。每行一件业主交代的事(一个工作根):标题、状态、一句由
// daemon 读面算出的人话说明;首屏不出现 ID;点行进单层抽屉看任务、PR 与评审。
// 本场景在 isolated lane 独立可跑:夹具仓的工作根归属按读者过滤,行集可能为空,
// 结构断言(组头、页面、行/空态、首屏无 ID、抽屉)不依赖真实台账数据。
export default {
  id: "redesign-my-asks",
  feature: "redesign-zone",
  lane: "isolated",
  description:
    "Redesign zone sidebar group opens the Your-asks page: one row per work root, daemon-derived status sentence, no IDs on the first screen, single-level drawer.",
  async run({ page, shot }) {
    await bridgeReady(page);
    // 桌面首启引导是启动面(与本页无关):出现时点「稍后」让出主区;不出现则跳过。
    const guide = page.getByRole("dialog", { name: /首次启动/u });
    if ((await guide.count()) > 0) await guide.getByRole("button", { name: "稍后" }).click();
    const group = page.getByTestId("sidebar-redesign-group");
    await group.waitFor();
    assert.match(await group.innerText(), /(?:重构|Redesign)/u);
    assert.match(await group.innerText(), /(?:试用|trial)/u);
    await nav(page, /^(?:你交代的事|Your asks)$/u, "my-asks-view");
    const board = page.getByTestId("my-asks-board");
    await board.waitFor();
    const text = await board.innerText();
    // 空仓/夹具仓都成立:要么诚实的空态,要么至少一行带状态与一句话说明。
    if (/(?:现在没有挂着的事|Nothing you asked for is open)/u.test(text)) {
      assert.doesNotMatch(text, /task_/u, "the empty first screen must not leak task IDs");
    } else {
      assert.match(text, /(?:进行中的事|In flight)/u, `the open region must be present, got: ${text}`);
      const rows = await board.locator('[data-testid^="my-asks-row-"]').count();
      assert.ok(rows > 0, "a non-empty board must render at least one row");
      assert.doesNotMatch(text, /task_/u, "the first screen must not leak task IDs");
      // 状态桶与人话说明由 daemon 推导;行可点开单层抽屉。
      assert.match(
        text,
        /(?:等你|卡住|在做|状态不明|已完成|Waiting on you|Stuck|Running|Unclear|Delivered)/u,
        "every row carries a status bucket",
      );
      await board.locator('[data-testid^="my-asks-row-"] button').first().click();
      await page.getByTestId("my-asks-drawer").waitFor();
      await shot("redesign-my-asks-drawer");
      await page.keyboard.press("Escape");
    }
    await shot("redesign-my-asks");
    // 亮色同页复拍:主题是本机偏好(localStorage),切换后重载再导航,两种主题都留证。
    await page.evaluate(() => globalThis.localStorage.setItem("harness-theme", "light"));
    await page.reload();
    await bridgeReady(page);
    const guideLight = page.getByRole("dialog", { name: /首次启动/u });
    if ((await guideLight.count()) > 0) await guideLight.getByRole("button", { name: "稍后" }).click();
    await nav(page, /^(?:你交代的事|Your asks)$/u, "my-asks-view");
    await page.getByTestId("my-asks-board").waitFor();
    await shot("redesign-my-asks-light");
    // 已完成区只在有近 7 天交付时出现;出现时默认折叠,展开后才见行。
    const toggle = page.getByTestId("my-asks-done-toggle");
    if ((await toggle.count()) > 0) {
      assert.equal(await page.locator('[data-testid="my-asks-done-rows"]').count(), 0, "delivered rows start folded");
      await toggle.click();
      await page.getByTestId("my-asks-done-rows").waitFor();
      await shot("redesign-my-asks-done-expanded");
    }
  },
};
