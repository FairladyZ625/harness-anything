import assert from "node:assert/strict";
import { requestDaemonJsonRpcAt } from "../../../packages/daemon/src/client/local-json-rpc-client.ts";
import { createRealizedTaskPlanFixture } from "../../fixtures/task-plan.mjs";
import { nav } from "./helpers.mjs";

// Dialog detachment precedes the source region's shared-layout return animation.
// Wait for actual projection transforms to settle before measuring or capturing it.
export async function settledWipGeometry(page) {
  await page.waitForFunction(() => {
    const region = globalThis.document.querySelector('[data-testid="overview-region-wip"]');
    return (
      region !== null &&
      [...region.querySelectorAll("section, section > div")].every(
        (node) => globalThis.getComputedStyle(node).transform === "none",
      )
    );
  });
  const geometry = await page.getByTestId("overview-region-wip").evaluate((region) => {
    const box = (node) => {
      const rect = node.getBoundingClientRect();
      return { x: rect.x, right: rect.right, width: rect.width, scrollLeft: node.scrollLeft };
    };
    const section = region.querySelector("section");
    const title = section.querySelector("h2");
    return {
      viewport: { width: globalThis.innerWidth, height: globalThis.innerHeight },
      region: box(region),
      section: box(section),
      title: box(title),
      titleFits: title.scrollWidth <= title.clientWidth,
      rows: [...region.querySelectorAll("[data-dense-row]")].map(box),
      scrollLefts: [
        ...region.querySelectorAll(
          "section, section > div, [data-region-scroll], [data-testid=overview-task-wip-list]",
        ),
      ].map((node) => node.scrollLeft),
    };
  });
  assertWipGeometry(geometry);
  return geometry;
}

export function assertWipGeometry(geometry) {
  for (const box of [geometry.section, geometry.title, ...geometry.rows]) {
    assert.ok(
      box.x >= geometry.region.x - 1 && box.right <= geometry.region.right + 1,
      `WIP content must stay inside its region: ${JSON.stringify(geometry)}`,
    );
  }
  assert.ok(geometry.titleFits, "WIP title must be fully readable");
  assert.ok(
    geometry.scrollLefts.every((left) => left === 0),
    "WIP must not scroll horizontally",
  );
}

/**
 * #task_fa84b041ed175ce8e81160eea1 总览常驻 WIP 占用区:占用/上限、名单与 daemon 的
 * repo.tasks.wip 快照逐 ID 一致(顺序按状态重排,不比顺序),行点击进放大层并保持该行
 * 选中(不冒泡回首行),放大层搜索过滤后 ↑↓ 只在可见集合移动,详情「打开任务」落到真实
 * 任务详情。占用数、上限、名单长度全部从 daemon 快照读出,不在场景里写死。夹具任务经
 * repo.task.start 真实写路占位(planned 不占位,先启动)。
 */
export default {
  id: "overview-wip-region",
  feature: "overview",
  lane: "isolated",
  description:
    "The resident WIP occupancy region matches the daemon snapshot id-by-id, keeps the clicked row selected, " +
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
    const region = page.getByTestId("overview-region-wip");
    await region.waitFor();
    // 名单容器只在快照落地且 counted>0 时出现:等它出现再读,避开首读 pending 的「…」。
    const list = region.getByTestId("overview-task-wip-list");
    await list.waitFor();

    // 与 daemon 同一条读面独立取一份:页面名单必须与它逐 ID 一致(占用=N/上限=M 在标题行)。
    // 页面经台账探针失效扇出跟随 daemon(秒级收敛):像 canonical 相一样收敛重试——同一
    // 时刻两边一致即过,不是对产品缺陷的兜底重试。
    let snapshot = null,
      pageIds = null;
    for (let round = 0; round < 10; round += 1) {
      snapshot = await requestDaemonJsonRpcAt(
        fixture.endpoint,
        "repo.tasks.wip",
        { repo: { repoId: fixture.repoId } },
        2_000,
        10_000,
      );
      const header = await region.locator("section").first().innerText();
      pageIds = await list.locator("[data-dense-row]").evaluateAll((rows) =>
        rows.map((row) => {
          const ref = row.querySelector("button[title*='task/']");
          const title = ref?.getAttribute("title") ?? "";
          return title.slice(title.lastIndexOf("task/") + "task/".length);
        }),
      );
      const expected = snapshot.counted.map((entry) => entry.taskId).sort();
      if (
        new RegExp(`(^|\\s)${snapshot.counted.length}/${snapshot.limit}(\\s|$)`).test(header) &&
        JSON.stringify([...pageIds].sort()) === JSON.stringify(expected)
      ) {
        break;
      }
      await page.waitForTimeout(1_000);
    }
    const header = await region.locator("section").first().innerText();
    assert.match(
      header,
      new RegExp(`(^|\\s)${snapshot.counted.length}/${snapshot.limit}(\\s|$)`),
      `occupancy header should read ${snapshot.counted.length}/${snapshot.limit}`,
    );
    assert.deepEqual(
      [...pageIds].sort(),
      snapshot.counted.map((entry) => entry.taskId).sort(),
      "rendered WIP rows must match daemon counted id-by-id",
    );

    // 条面点第 N 行(末行)进放大层并保持该行选中:行点击不冒泡回首行(返工 2 第 1 点)。
    await list.locator("[data-dense-row]").last().click();
    const dialog = page.locator('[role="dialog"]');
    await dialog.waitFor();
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
    const kept = await selectionStateOf();
    assert.equal(kept.filter(({ selected }) => selected).length, 1, "exactly one selected row after row click");
    assert.equal(kept.at(-1)?.selected, true, "the clicked (last) row must stay selected, not the first");

    // 放大层过滤后 ↑↓ 只在可见集合移动(返工 2 第 2 点):搜索把首行藏起,选中收敛到首个
    // 可见行;↓ 移到下一个可见行,被隐藏的行不可被键盘选中。
    await dialog.getByTestId("overview-task-wip-search").fill("占位导航");
    let visible = await selectionStateOf();
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
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });

    await settledWipGeometry(page);
    await shot("overview-wip-settled");

    // 行点击 → 放大层(分组/搜索接管过滤)→ 详情「打开任务」→ 真实任务详情。
    await list.locator("[data-dense-row]").last().click();
    await dialog.waitFor();
    await dialog.getByTestId("overview-task-wip-search").waitFor();
    await dialog.getByRole("button", { name: /打开任务|Open task/u }).click();
    await page.getByTestId("task-detail-view").waitFor();
    await shot("overview-wip-task-detail");
  },
};
