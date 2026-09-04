import assert from "node:assert/strict";
import { requestDaemonJsonRpcAt } from "../../../packages/daemon/src/client/local-json-rpc-client.ts";

// Schedule 运行历史详情页(task: schedule-gui-report-md-occurrence-fact-decision-rollup)。
//
// 夹具路径:隔离仓没有任何已安装的 agent runtime,所以「立即运行」会在派工处真实失败——
// 这恰好是一次**确定性的失败 occurrence**:claim → spawn(runtime_instance_not_found)→
// settle failed,detail 是真实错误原因。种数据走隔离 daemon 的 schedule 写 RPC(与 CLI
// `ha schedule create` 同一条写路;GUI 表单桥今天发不出 mode 字段——preload 的 create
// 载荷闭集没有 mode,而 daemon 动作要求它——那是表单在飞任务的修复面,不在本场景)。
//
// 断言面:失败详情可见、无派工/无报告/无产出都是真实空态、健康度 rollup 直接渲染、
// 页面上没有任何「待后端投影 / 执行体接线后」占位句。报告内嵌(markdown/JSON)与
// fact/decision/task 产出互链在 schedule-detail-view.vitest 中用 daemon 形状覆盖——
// 隔离 lane 起不了真实 agent,产不出带报告的成功 occurrence。
const REPO_ID = "gui-e2e-catalog";
const SCHEDULE_ID = "gui-e2e-run-history";

export default {
  id: "schedule-run-history",
  feature: "schedules",
  lane: "isolated",
  description:
    "A failed schedule occurrence shows its real failure detail, empty states, and health rollup — no placeholders.",
  async run({ page, app, shot }) {
    // 1. 种数据:从 electron 主进程拿隔离 daemon endpoint,建计划并立即运行。
    //    (run-now 内联 claim→spawn→settle,RPC 返回时 occurrence 已落账。)
    const endpoint = await app.evaluate(() => process.env.HARNESS_DAEMON_ENDPOINT);
    assert.ok(endpoint, "the isolated daemon endpoint must reach the electron main process");
    const rpc = (method, payload) =>
      requestDaemonJsonRpcAt(endpoint, method, { repo: { repoId: REPO_ID }, payload }, 30_000);
    const created = await rpc("repo.schedule.create", {
      scheduleId: SCHEDULE_ID,
      name: "GUI e2e run history",
      mode: "detect",
      everyMs: 3_600_000,
      agentId: "e2e-probe",
      runtimeInstanceId: "gui-e2e-instance",
      mission: "Probe the schedule run-history detail page.",
      idempotencyKey: "gui-e2e:schedule-run-history:create",
    });
    assert.equal(created.ok, true, `schedule create failed: ${JSON.stringify(created)}`);
    const run = await rpc("repo.schedule.runNow", {
      scheduleId: SCHEDULE_ID,
      idempotencyKey: "gui-e2e:schedule-run-history:run-now",
    });
    assert.equal(run.ok, true, `schedule run-now failed: ${JSON.stringify(run)}`);

    // 2. 打开定时计划列表与详情 hub。列表查询与关系图/实体页共享缓存
    //    (["schedules", repoId],staleTime 2s):前一个场景若挂过图,缓存里是种子前的
    //    空表——等过 stale 窗口,页面挂载才会真正重读。
    await page.waitForTimeout(2_500);

    // 2b. 打开定时计划列表与详情 hub。
    await page.getByRole("button", { name: /^(?:定时计划|Schedules)$/u }).click();
    await page.getByTestId("schedules-view").waitFor();
    await page.getByTestId(`schedule-row-${SCHEDULE_ID}`).waitFor();
    await page.getByTestId(`schedule-focus-${SCHEDULE_ID}`).click();
    await page.getByTestId("schedule-detail").waitFor();

    // 3. 健康度 rollup 是 daemon 投影:失败 occurrence 让 spark 与失败计数直接出现。
    await page.getByTestId("schedule-health-spark").waitFor();
    const healthText = await page.getByTestId("schedule-overview-health").innerText();
    assert.match(healthText, /1 failed|失败 1/u, "the failed occurrence must show up in the health rollup");

    // 4. 打开失败 occurrence 的内嵌详情(run-now 的 occurrence 是 manual_ 前缀)。
    await page.getByTestId("schedule-tab-runs").click();
    const row = page
      .locator('[data-testid^="schedule-run-row-occurrence_"], [data-testid^="schedule-run-row-manual_"]')
      .first();
    await row.waitFor();
    await row.getByRole("button").click();
    await page.getByTestId("schedule-run-detail").waitFor();

    // 5. 失败详情是 settle 的真实原因,不是模板句。
    const failure = await page.getByTestId("schedule-run-failure-detail").innerText();
    assert.match(
      failure,
      /e2e-probe|gui-e2e-instance/u,
      "the failure detail must name the unresolvable agent or runtime instance",
    );

    // 6. 无派工/无报告/无产出都是真实空态。
    await page.getByTestId("schedule-run-session-empty").waitFor();
    await page.getByTestId("schedule-run-report-empty").waitFor();
    await page.getByTestId("schedule-run-outputs-empty").waitFor();

    // 7. 全页没有占位句(中英两份词表都不允许再出现)。
    const bodyText = await page.evaluate(() => globalThis.document.body.innerText);
    for (const marker of ["待后端", "接线后", "{squadRunId}", "pending the backend", "once wired"]) {
      assert.ok(!bodyText.includes(marker), `placeholder marker "${marker}" must not appear on the run detail page`);
    }

    // 8. 返回运行历史(位置补丁,不推栈)。
    await page.getByTestId("schedule-detail-back").click();
    await page.getByTestId("schedule-runs-timeline").waitFor();
    await shot("schedule-run-history-detail");
  },
};
