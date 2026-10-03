import assert from "node:assert/strict";
import { requestDaemonJsonRpcAt } from "../../../packages/daemon/src/client/local-json-rpc-client.ts";
import { nav } from "./helpers.mjs";

/**
 * #task_fa84b041ed175ce8e81160eea1 总览常驻 WIP 占用区:占用/上限、名单与 daemon 的
 * repo.tasks.wip 快照逐 ID 一致(顺序按状态重排,不比顺序),行点击进放大层给分组/搜索,
 * 详情「打开任务」落到真实任务详情。占用数、上限、名单长度全部从 daemon 快照读出,
 * 不在场景里写死。夹具任务经 repo.task.start 真实写路占位(planned 不占位,先启动)。
 */
export default {
  id: "overview-wip-region",
  feature: "overview",
  lane: "isolated",
  description:
    "The resident WIP occupancy region matches the daemon snapshot id-by-id and navigates a row to task detail.",
  async run({ page, fixture, shot }) {
    const started = await requestDaemonJsonRpcAt(
      fixture.endpoint,
      "repo.task.start",
      { repo: { repoId: fixture.repoId }, payload: { taskId: "task-gui-smoke", executionId: "exec-overview-wip-e2e" } },
      2_000,
      10_000,
    );
    assert.equal(started.ok, true, "fixture task must start through the real write path");
    await nav(page, /^(?:总览|Overview)$/u, "overview-view");
    const region = page.getByTestId("overview-region-wip");
    await region.waitFor();
    // 名单容器只在快照落地且 counted>0 时出现:等它出现再读,避开首读 pending 的「…」。
    const list = region.getByTestId("overview-task-wip-list");
    await list.waitFor();

    // 与 daemon 同一条读面独立取一份:页面名单必须与它逐 ID 一致(占用=N/上限=M 在标题行)。
    const snapshot = await requestDaemonJsonRpcAt(
      fixture.endpoint,
      "repo.tasks.wip",
      { repo: { repoId: fixture.repoId } },
      2_000,
      10_000,
    );
    const header = await region.locator("section").first().innerText();
    assert.match(
      header,
      new RegExp(`(^|\\s)${snapshot.counted.length}/${snapshot.limit}(\\s|$)`),
      `occupancy header should read ${snapshot.counted.length}/${snapshot.limit}`,
    );
    const pageIds = await list.locator("[data-dense-row]").evaluateAll((rows) =>
      rows.map((row) => {
        const ref = row.querySelector("button[title*='task/']");
        const title = ref?.getAttribute("title") ?? "";
        return title.slice(title.lastIndexOf("task/") + "task/".length);
      }),
    );
    assert.deepEqual(
      [...pageIds].sort(),
      snapshot.counted.map((entry) => entry.taskId).sort(),
      "rendered WIP rows must match daemon counted id-by-id",
    );

    // 行点击 → 放大层(分组/搜索接管过滤)→ 详情「打开任务」→ 真实任务详情。
    await list.locator("[data-dense-row]").last().click();
    const dialog = page.locator('[role="dialog"]');
    await dialog.waitFor();
    await dialog.getByTestId("overview-task-wip-search").waitFor();
    await dialog.getByRole("button", { name: /打开任务|Open task/u }).click();
    await page.getByTestId("task-detail-view").waitFor();
    await shot("overview-wip-task-detail");
  },
};
