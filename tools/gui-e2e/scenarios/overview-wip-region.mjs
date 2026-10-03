import assert from "node:assert/strict";
import { requestDaemonJsonRpcAt } from "../../../packages/daemon/src/client/local-json-rpc-client.ts";
import { createRealizedTaskPlanFixture } from "../../fixtures/task-plan.mjs";
import { nav } from "./helpers.mjs";

// The WIP drill entry collapses to one compact chip on the overview tool strip; the full
// list lives in the focus layer. Dialog detachment precedes the entry's return to the
// compact chip — wait for actual projection transforms to settle before measuring.
export async function settledWipGeometry(page) {
  await page.waitForFunction(() => {
    const drill = globalThis.document.querySelector('[data-testid="overview-region-drill"]');
    return (
      drill !== null &&
      [...drill.querySelectorAll("section, section > div")].every(
        (node) => globalThis.getComputedStyle(node).transform === "none",
      )
    );
  });
  const geometry = await page.getByTestId("overview-region-drill").evaluate((region) => {
    const box = (node) => {
      const rect = node.getBoundingClientRect();
      return { x: rect.x, right: rect.right, width: rect.width, scrollLeft: node.scrollLeft };
    };
    const section = region.querySelector("section");
    const title = section.querySelector("h2");
    const entry = region.querySelector('[data-testid="overview-drill-wip"]');
    return {
      viewport: { width: globalThis.innerWidth, height: globalThis.innerHeight },
      region: box(region),
      section: box(section),
      title: box(title),
      titleFits: title.scrollWidth <= title.clientWidth,
      entry: entry === null ? null : box(entry),
      scrollLefts: [...region.querySelectorAll("section, section > div, [data-region-scroll]")].map(
        (node) => node.scrollLeft,
      ),
    };
  });
  assertWipGeometry(geometry);
  return geometry;
}

export function assertWipGeometry(geometry) {
  for (const box of [geometry.section, geometry.title, ...(geometry.entry ? [geometry.entry] : [])]) {
    assert.ok(
      box.x >= geometry.region.x - 1 && box.right <= geometry.region.right + 1,
      `WIP entry must stay inside its region: ${JSON.stringify(geometry)}`,
    );
  }
  assert.ok(geometry.titleFits, "drill region title must be fully readable");
  assert.ok(
    geometry.scrollLefts.every((left) => left === 0),
    "drill region must not scroll horizontally",
  );
}

/**
 * #task_fa84b041ed175ce8e81160eea1 总览 WIP 常驻观察面(2026-10-04 视觉返工后):占用/上限
 * 收成底部工具带的紧凑芯片,名单与分组/搜索住在放大层;占用数、上限、名单长度全部从
 * daemon 快照读出,不在场景里写死。夹具任务经 repo.task.start 真实写路占位(planned 不
 * 占位,先启动)。
 */
export default {
  id: "overview-wip-region",
  feature: "overview",
  lane: "isolated",
  description:
    "The compact WIP drill chip shows the daemon occupancy, the focus layer lists every counted task id-by-id, " +
    "keeps arrow-key navigation inside the filtered visible set, and navigates a row to task detail.",
  async run({ page, fixture, shot }) {
    const started = await requestDaemonJsonRpcAt(
      fixture.endpoint,
      "repo.task.start",
      { repo: { repoId: fixture.repoId }, payload: { taskId: "task-gui-smoke", executionId: "exec-overview-wip-e2e" } },
      2_000,
      10_000,
    );
    assert.equal(started.ok, true, "fixture task must start through the real write path");
    // 两条导航用占位:让「点第 N 行保持 N」与「过滤后键盘只在可见集合」在 ≥3 行的名单上可判。
    for (const [taskId, title] of [
      ["task-wip-nav-a", "占位导航甲"],
      ["task-wip-nav-b", "占位导航乙"],
    ]) {
      await createRealizedTaskPlanFixture(
        fixture.rootDir,
        () =>
          requestDaemonJsonRpcAt(
            fixture.endpoint,
            "repo.task.create",
            { repo: { repoId: fixture.repoId }, payload: { taskId, title } },
            2_000,
            30_000,
          ),
        (planPath) =>
          requestDaemonJsonRpcAt(
            fixture.endpoint,
            "repo.task.run",
            { repo: { repoId: fixture.repoId }, payload: { action: { kind: "doc-submit", paths: [planPath] } } },
            2_000,
            30_000,
          ),
        title,
      );
      const occupied = await requestDaemonJsonRpcAt(
        fixture.endpoint,
        "repo.task.start",
        { repo: { repoId: fixture.repoId }, payload: { taskId, executionId: `exec-${taskId}` } },
        2_000,
        10_000,
      );
      assert.equal(occupied.ok, true, `${taskId} must start through the real write path`);
    }
    await nav(page, /^(?:总览|Overview)$/u, "overview-view");
    const drill = page.getByTestId("overview-region-drill");
    await drill.waitFor();

    // The fixture is stable: wait for the page to render its authoritative snapshot.
    const snapshot = await requestDaemonJsonRpcAt(
      fixture.endpoint,
      "repo.tasks.wip",
      { repo: { repoId: fixture.repoId } },
      2_000,
      10_000,
    );
    const wipChip = drill.getByTestId("overview-drill-wip");
    await wipChip.waitFor({ timeout: 10_000 });
    // 芯片上的占用数必须来自 daemon 快照,不写死。
    await page.waitForFunction(
      ([count, limit]) => {
        const chip = globalThis.document.querySelector('[data-testid="overview-drill-wip"]');
        return chip !== null && chip.textContent.includes(`${count}/${limit}`);
      },
      [snapshot.counted.length, snapshot.limit],
      { timeout: 10_000 },
    );

    // The board stays compact: no dense WIP rows on the first screen; the chip carries occupancy.
    const boardRows = await drill.locator("[data-testid='overview-task-wip-list'] [data-dense-row]").count();
    assert.equal(boardRows, 0, "the WIP list must live in the focus layer, not on the board");
    await wipChip.click();
    const dialog = page.locator('[role="dialog"]');
    await dialog.waitFor();
    const list = dialog.getByTestId("overview-task-wip-list");
    await list.waitFor();

    // 放大层名单与 daemon 快照逐 ID 一致(顺序按状态重排,不比顺序)。
    await page.waitForFunction(
      ({ ids }) => {
        const rows = [...globalThis.document.querySelectorAll("[data-focus-list] [data-dense-row]")];
        const actual = rows
          .map((row) => {
            const title = row.querySelector("button[title*='task/']")?.getAttribute("title") ?? "";
            return title.slice(title.lastIndexOf("task/") + "task/".length);
          })
          .sort();
        return rows.length > 0 && JSON.stringify(actual) === JSON.stringify(ids);
      },
      { ids: snapshot.counted.map((entry) => entry.taskId).sort() },
      { timeout: 10_000 },
    );

    // 入口开放大层落选首行;放大层过滤后 ↑↓ 只在可见集合移动(隐藏的行不可被键盘选中)。
    const selectionStateOf = () =>
      dialog.locator("[data-focus-list] [data-dense-row]").evaluateAll((rows) =>
        rows.map((row) => ({
          selected: row.hasAttribute("data-selected"),
          id: (() => {
            const title = row.querySelector("button[title*='task/']")?.getAttribute("title") ?? "";
            return title.slice(title.lastIndexOf("task/") + "task/".length);
          })(),
        })),
      );
    let visible = await selectionStateOf();
    assert.equal(visible.filter(({ selected }) => selected).length, 1, "exactly one selected row after opening");
    assert.equal(visible[0]?.selected, true, "opening from the entry selects the first row");

    // 搜索把首行藏起,选中收敛到首个可见行;↓ 只在可见集合移动。
    await dialog.getByTestId("overview-task-wip-search").fill("占位导航");
    visible = await selectionStateOf();
    let visibleIds = visible.map(({ id }) => id);
    assert.deepEqual(visibleIds, ["task-wip-nav-a", "task-wip-nav-b"], "search must hide the non-matching row");
    await dialog.getByTestId("overview-task-wip-search").fill("导航甲");
    visible = await selectionStateOf();
    visibleIds = visible.map(({ id }) => id);
    assert.deepEqual(visibleIds, ["task-wip-nav-a"], "narrowing search must leave one visible row");
    assert.equal(visible[0]?.selected, true, "selection must clamp to the first visible row when hidden");
    await dialog.getByTestId("overview-task-wip-search").fill("占位导航");
    await page.keyboard.press("ArrowDown");
    const keyed = (await selectionStateOf()).filter(({ selected }) => selected).map(({ id }) => id);
    assert.deepEqual(keyed, ["task-wip-nav-b"], "arrow key must move to the next visible row");
    assert.notEqual(keyed[0], "task-gui-smoke", "a row hidden by the filter must not be selectable via keyboard");

    // 行点击 → 详情「打开任务」→ 真实任务详情;从详情页头的「总览」返回路径回到总览,
    // 再量紧凑入口的几何(侧栏也有同名「总览」按钮,nav helper 的严格定位会撞二义)。
    await dialog.getByTestId("overview-task-wip-search").fill("导航甲");
    await dialog.getByRole("button", { name: /打开任务|Open task/u }).click();
    await page.getByTestId("task-detail-view").waitFor();
    await shot("overview-wip-task-detail");

    await page
      .getByTestId("task-detail-header")
      .getByRole("button", { name: /^(?:总览|Overview)$/u })
      .click();
    await page.getByTestId("overview-region-drill").waitFor();
    await settledWipGeometry(page);
    await shot("overview-wip-settled");
  },
};
