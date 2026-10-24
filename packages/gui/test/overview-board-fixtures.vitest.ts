// harness-test-tier: fast
// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { flushUntil } from "./overview-board.fixtures.ts";

/**
 * overview-board 夹具族共用的等待件 flushUntil 的行为面(2026-10-23 gui-build 偶发红的
 * 根因件):条件不满足必须抛带条件描述的错误,不再静默返回把「行还没渲染」推迟成后续
 * 断言的误导性报红;等待按真实时间计,晚于固定微任务轮成立的条件(定时器/慢渲染)也
 * 能等到。挂载无关,直接点各分支。
 */
describe("总览夹具 flushUntil 等待件", () => {
  it("条件不成立时超时抛错,错误带条件描述而不是静默返回", async () => {
    await expect(flushUntil(() => false, 80)).rejects.toThrow("条件未在 80ms 内成立");
    // 条件描述来自谓词源码,报红时能直接读到在等什么。
    await expect(flushUntil(() => false, 80)).rejects.toThrow("() => false");
  });

  it("条件晚于微任务轮成立(真实定时器路径)也能等到", async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    let held = false;
    setTimeout(() => {
      held = true;
    }, 60);
    const startedAt = Date.now();
    await flushUntil(() => held);
    expect(held).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });
});
