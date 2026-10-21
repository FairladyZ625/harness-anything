/* global document */
import assert from "node:assert/strict";
import { bridgeReady, nav } from "./helpers.mjs";

// 重构区「你交代的事」页(task_a3ffd5ceb;dec_C612E69B7C7E3480A5F9D2CAD3 CH1;
// W3-T2 task_26aae3adfea4acfc71a9763dad 接入 AgentInbox):侧栏「重构」组的第二个 tab。
// 每行一件业主交代的事(一个工作根),按注意力分到 Needs you / Running / Done 三栏,
// 行上带 daemon 读面算出的人话说明;首屏不出现 ID;点行进单层抽屉看提问、任务、PR 与评审。
// 本场景在 isolated lane 独立可跑:夹具仓的工作根归属按读者过滤,行集可能为空,
// 结构断言(组头、页面、三栏、行/空态、首屏无 ID、抽屉)不依赖真实台账数据。
export default {
  id: "redesign-my-asks",
  feature: "redesign-zone",
  lane: "isolated",
  description:
    "Redesign zone sidebar group opens the Your-asks page: AgentInbox attention lanes (Needs you / Running / Done), honest empty states, no IDs on the first screen, single-level drawer.",
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
    // 三栏注意力分区(needs-you/running/done)无论行集是否为空都渲染。
    assert.match(text, /(?:等你拍板|Needs you)/u, `the needs-you lane must be present, got: ${text}`);
    assert.match(text, /(?:运行中|Running)/u, `the running lane must be present, got: ${text}`);
    assert.match(text, /(?:已完成|Done)/u, `the done lane must be present, got: ${text}`);
    const rows = await board.locator('[data-testid^="my-asks-row-"]').count();
    if (rows === 0) {
      // 空仓诚实空态:每个分区给出人话空文案,首屏不泄漏任务 ID。
      assert.match(
        text,
        /(?:没有等你拍板的任务|Nothing is waiting on you)/u,
        `an empty board must keep honest lane empty states, got: ${text}`,
      );
      assert.doesNotMatch(text, /task_/u, "the empty first screen must not leak task IDs");
    } else {
      assert.doesNotMatch(text, /task_/u, "the first screen must not leak task IDs");
      // 行的折叠头按钮同时触发 onSelect:点开单层抽屉。
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
    // 已完成区只在有交付时出现;出现时默认折叠,展开后 done 行进入收件箱(done 栏行数增加)。
    const toggle = page.getByTestId("my-asks-done-toggle");
    if ((await toggle.count()) > 0) {
      const before = await page.locator('[data-testid^="my-asks-row-"]').count();
      await toggle.click();
      await page.waitForFunction(
        (before) => document.querySelectorAll('[data-testid^="my-asks-row-"]').length > before,
        before,
      );
      await shot("redesign-my-asks-done-expanded");
    }
  },
};
