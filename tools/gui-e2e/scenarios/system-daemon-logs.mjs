import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import path from "node:path";

/**
 * #2224 系统 tab 常驻日志面板 + #2227 的「面板被 flex 压成 0 高」回归。
 *
 * 三层断言,全部对着真实夹具 daemon(不 mock 任何读面):
 *   1. 高度:日志区是页面主正文,flex-1 吃满剩余高度(chrome 收敛 S6,替代旧的固定
 *      24rem/55cqb 封顶)。探针两半:机制上 flex-grow 必须是 1;几何上面板底边贴
 *      页面滚动容器底边——固定封顶时下方会留出整段空白,这里就是抓它的探针。
 *      阈值不许为了变绿放宽。
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
    "The System tab fills the remaining page height with its resident daemon log panel, shows real lifecycle rows, and the request kind switch does not fail.",
  async run({ page, fixture, shot }) {
    // Replay observed durations through the real daemon log reader, in this fixture's namespace.
    // Move timestamps into its current observation window; this is a replay, not a performance run.
    const now = Date.now(),
      at = new Date(now - 30_000).toISOString();
    const samples = [
      { method: "repo.agentRuntime.sessions.await", durationMs: 1_067_342, code: "provider_exit" },
      { method: "repo.task.run", durationMs: 22_049, code: null },
      { method: "repo.task.run", durationMs: 12_023, code: null },
    ].map((sample) => ({
      schema: "daemon-conn-log/v1",
      daemonId: fixture.daemonId,
      event: "request",
      at,
      ok: true,
      ...sample,
    }));
    await page.getByRole("button", { name: /^(?:Daemon 状态|Daemon status)$/u }).click();
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

    // 1. 撑满剩余高度:flex-grow 机制 + 底边几何(面板贴页面底,无固定封顶留白)。
    const geometry = await panel.evaluate((node) => {
      const root = node.parentElement;
      return {
        flexGrow: globalThis.getComputedStyle(node).flexGrow,
        panelBottom: node.getBoundingClientRect().bottom,
        rootBottom: root.getBoundingClientRect().bottom,
      };
    });
    assert.equal(geometry.flexGrow, "1", "the log panel must grow into the remaining page height");
    assert.ok(
      Math.abs(geometry.panelBottom - geometry.rootBottom) < 2,
      `log panel bottom ${geometry.panelBottom}px must meet the page bottom ${geometry.rootBottom}px, not a fixed cap`,
    );

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

    // Open the full observation route so the replay's execution and wait groups are readable together.
    await page.getByTestId("system-repo-observe").first().click();
    await page.getByTestId("daemon-observe-content").waitFor();
    await page.getByTestId("observe-kind-daemon-log").click();
    await page.getByTestId("observe-analytics-toggle-daemon-log").click();
    await page.getByTestId("observe-tab-ops-daemon-log").click();
    const board = page.getByTestId("observe-slowops-daemon-log");
    await board.waitFor();
    appendFileSync(
      path.join(
        fixture.userRoot,
        "logs",
        `daemon-${fixture.daemonId}-conn-${new Date(now).toISOString().slice(0, 10).replaceAll("-", "")}.jsonl`,
      ),
      samples.map((sample) => JSON.stringify(sample)).join("\n") + "\n",
    );
    await board.getByTestId("observe-slowops-daemon-log-waits").waitFor();
    const execution = board.getByTestId("observe-slowops-daemon-log-execution");
    assert.ok((await execution.textContent()).includes("repo.task.run"));
    assert.ok(!(await execution.textContent()).includes("sessions.await"));
    assert.ok((await board.getByTestId("observe-slowops-daemon-log-waits").textContent()).includes("17m 47s"));
    const sniffer = page.getByTestId("observe-sniffer-daemon-log");
    assert.match(await sniffer.textContent(), /慢写请求|slow write requests/u);
    assert.doesNotMatch(await sniffer.textContent(), /慢锁|锁争用|Contended/u);
    assert.match(
      await sniffer.getByTestId("observe-sniffer-daemon-log-writes").getAttribute("title"),
      /原因未知|cause unknown/u,
    );
    await shot("observe-wait-vs-execution");
    await execution.getByRole("button", { name: "repo.task.run", exact: true }).click();
    await page.getByTestId("observe-row").filter({ hasText: "22049ms" }).first().waitFor();
    await page.getByTestId("observe-row").filter({ hasText: "12023ms" }).first().waitFor();
    await shot("observe-slow-run-drilldown");
  },
};
