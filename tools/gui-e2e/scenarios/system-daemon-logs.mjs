import assert from "node:assert/strict";

/**
 * #2224 系统 tab 常驻日志面板 + #2227 的「面板被 flex 压成 0 高」回归。
 *
 * 三层断言,全部对着真实夹具 daemon(不 mock 任何读面):
 *   1. 高度:面板声明 h-[24rem](384px),断言 getBoundingClientRect().height >= 300 是
 *      该声明的下界。SystemView 的父级是 overflow-y-auto 的 flex 列,面板自身带
 *      min-h-0——没有 shrink-0 时(#2227 之前)上方内容一满,这个 section 就会被
 *      压到远小于 24rem,这里就是抓它的探针。阈值不许为了变绿放宽。
 *   2. 「生命周期」kind:observe.tail 读 daemon 的 lifecycle JSONL,夹具 daemon 启动、
 *      挂仓本身就是真实事件源,至少 1 行。
 *   3. 「请求」kind:切换不报读取失败(observe-error-* / observe-unavailable-* 都算红)。
 *
 * 已知坑(SKILL):首次运行会让 driver 重建 renderer/preload;面板轮询 1s 一拍,
 * 行断言用默认 20s 超时足够。
 */
export default {
  id: "system-daemon-logs",
  feature: "system",
  lane: "isolated",
  description:
    "The System tab keeps its resident daemon log panel at the declared 24rem height, shows real lifecycle rows, and the request kind switch does not fail.",
  async run({ page }) {
    await page.getByRole("button", { name: /^(?:系统|System)$/u }).click();
    const panel = page.getByTestId("system-daemon-logs");
    await panel.waitFor();
    await page.getByTestId("system-daemon-logs-scope").waitFor();
    // 仓刚起时先处于 warming:面板会短暂呈现「无路由」说明,挂载完成后必须换成真面板。
    await page.getByTestId("observe-pane-lifecycle").waitFor();
    assert.equal(
      await page.getByTestId("system-daemon-logs-unavailable").count(),
      0,
      "an attached repo must route observe.tail for the system log panel",
    );

    // 1. 声明高度下界:24rem = 384px,断言 >= 300 抓 flex 塌陷(#2227)。
    const height = await panel.evaluate((node) => node.getBoundingClientRect().height);
    assert.ok(height >= 300, `system-daemon-logs height ${height}px is below the 24rem lower bound 300px`);

    // 2. 生命周期 kind:夹具 daemon 的真实 lifecycle 事件,至少一行。
    await page.getByTestId("observe-kind-lifecycle").click();
    await page.getByTestId("observe-pane-lifecycle").waitFor();
    await page.getByTestId("observe-row").first().waitFor();

    // 3. 「请求」kind 切换:读面不得失败(失败会渲染 error/unavailable 横幅)。
    await page.getByTestId("observe-kind-daemon-log").click();
    await page.getByTestId("observe-pane-daemon-log").waitFor();
    assert.equal(
      await page.getByTestId("observe-error-daemon-log").count(),
      0,
      "the request-kind log pane must not report a read error",
    );
    assert.equal(
      await page.getByTestId("observe-unavailable-daemon-log").count(),
      0,
      "the request-kind log pane must not be unavailable",
    );
  },
};
