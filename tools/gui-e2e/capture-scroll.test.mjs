// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { SCROLL_MATCH_TIERS } from "./capture-scroll.mjs";

// 本文件只锁梯度形状:标题必须排在文字之前,且每一级都先于下一级。真实 DOM 上的分辨力由
// capture-scroll.integration.test.mjs 证明(它能构造「页头说明 + 节标题」的真实撞词页面)。
test("scroll tiers resolve headings before plain text, exact before substring", () => {
  assert.deepEqual(
    SCROLL_MATCH_TIERS.map(({ role, exact }) => ({ role, exact })),
    [
      { role: "heading", exact: true },
      { role: null, exact: true },
      { role: "heading", exact: false },
      { role: null, exact: false },
    ],
  );
});
