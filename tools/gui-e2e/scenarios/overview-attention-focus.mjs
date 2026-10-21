import assert from "node:assert/strict";
import { requestDaemonJsonRpcAt } from "../../../packages/daemon/src/client/local-json-rpc-client.ts";
import { createRealizedTaskPlanFixture } from "../../fixtures/task-plan.mjs";
import { nav } from "./helpers.mjs";

/**
 * #task_ac9665e4b3d0400b34e851b1c4 CEO 视觉返工的验收场景(2026-10-04;2026-10-21
 * 四块定案后重排):真实 daemon 数据下的任务列表形态——左上「在跑的任务」窄行名单、
 * 右上「置顶与议程」、左下「关注的工作」、右下「等你处理的事」,全局泳道与最新产物
 * 不再进总览首屏。隐藏 Electron 在默认宽(1440)/1120/最小窗宽三档窗口截屏:待办签发
 * 默认只铺三条并可一键展开,三条置顶关注工作直接可见。全部数据走真实写路
 * (repo.task.create/run/pin、relation-relate),断言与截图不写死 daemon 侧数值。
 */

const WATCHED_WORKS = [
  { root: "task-att-watch-a", member: "task-att-watch-a1", title: "关注工作甲·投影读面" },
  { root: "task-att-watch-b", member: "task-att-watch-b1", title: "关注工作乙·评审闸门" },
  { root: "task-att-watch-c", member: "task-att-watch-c1", title: "关注工作丙·交付节奏" },
];

// 真实人工决策:指向读者(person-gui)的 awaits 问句,只有本人能答。
const HUMAN_ASKS = [
  { source: "task-att-watch-a1", question: "关注工作甲的读面口径要不要冻结 v1?" },
  { source: "task-att-watch-b", question: "评审闸门是否允许低风险自动放行?" },
];

async function rpc(endpoint, repoId, method, payload) {
  const receipt = await requestDaemonJsonRpcAt(endpoint, method, { repo: { repoId }, payload }, 2_000, 30_000);
  return receipt;
}

async function setSize(app, page, width, height) {
  const actual = await app.evaluate(
    ({ BrowserWindow }, size) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.setSize(size.width, size.height);
      return window.getContentSize();
    },
    { width, height },
  );
  // Hidden Electron may not resize its renderer; match the real, min-width-clamped content size.
  await page.setViewportSize({ width: actual[0], height: actual[1] });
  await page.waitForFunction(([w, h]) => globalThis.innerWidth === w && globalThis.innerHeight === h, actual);
}

/** 四块布局的实测几何(2026-10-21 定案):左列 running 上 works 下,右列 pins 上
 *  awaits 下;右列整体在左列右侧,同列两块左对齐且上下相接。 */
async function fourBlockGeometry(page) {
  return page.evaluate(() => {
    const box = (testId) => {
      const node = globalThis.document.querySelector(`[data-testid="${testId}"]`);
      if (node === null) return null;
      const rect = node.getBoundingClientRect();
      return {
        top: rect.top,
        bottom: rect.bottom,
        left: rect.left,
        right: rect.right,
        width: rect.width,
        height: rect.height,
      };
    };
    return {
      viewport: { width: globalThis.innerWidth, height: globalThis.innerHeight },
      running: box("overview-region-running"),
      pins: box("overview-region-pins"),
      works: box("overview-region-works"),
      awaits: box("overview-region-awaits"),
      lanes: globalThis.document.querySelector('[data-testid="overview-agent-lanes"]') !== null,
      artifacts: box("overview-region-artifacts"),
      awaitRows: globalThis.document.querySelectorAll('[data-testid="overview-awaits"] [data-awaits-row]').length,
      workCards: globalThis.document.querySelectorAll("[data-work-card]").length,
    };
  });
}

function assertFourBlockLayout(geometry) {
  const { viewport, running, pins, works, awaits } = geometry;
  assert.ok(
    running !== null && works !== null && pins !== null && awaits !== null,
    `all four blocks must exist: ${JSON.stringify(geometry)}`,
  );
  // 左列:running 上格、works 下格,同列左对齐且上下相接。
  assert.ok(
    Math.abs(running.left - works.left) <= 2 && running.bottom <= works.top + 1,
    `running must be the top-left cell with works stacked below: ${JSON.stringify(geometry)}`,
  );
  // 右列:pins 上格、awaits 下格,整体在左列右侧。
  assert.ok(
    Math.abs(pins.left - awaits.left) <= 2 &&
      pins.bottom <= awaits.top + 1 &&
      pins.left >= running.right - 1 &&
      awaits.left >= works.right - 1,
    `pins/awaits must own the right column: ${JSON.stringify(geometry)}`,
  );
  // 泳道与最新产物已移出总览(2026-10-21 定案)。
  assert.ok(!geometry.lanes, "the global AgentLanes swimlane must not render on the overview");
  assert.ok(geometry.artifacts === null, "the artifacts shelf must not render on the overview");
  // 待办签发默认紧凑 ≤3 行。
  assert.ok(geometry.awaitRows <= 3, `compact awaits must show at most 3 rows, saw ${geometry.awaitRows}`);
  assert.ok(geometry.workCards >= 3, `at least three watched works must render, saw ${geometry.workCards}`);
  // 四块都不挤压成不可读的细条:每块至少保持区域板的最小可用尺寸。
  for (const [name, block] of [
    ["running", running],
    ["works", works],
    ["pins", pins],
    ["awaits", awaits],
  ]) {
    assert.ok(
      block.width >= 200 && block.height >= 120,
      `${name} must stay usable (${block.width}x${block.height}) at ${viewport.width}x${viewport.height}`,
    );
  }
}

export default {
  id: "overview-attention-focus",
  feature: "overview",
  lane: "isolated",
  description:
    "The 2026-10-21 four-block overview (running tasks top-left, pins & agenda top-right, watched works " +
    "bottom-left, waiting-for-you bottom-right) verified against a real daemon seeded with 3+ pinned works and " +
    "human decisions; the global swimlane and artifacts shelf stay off the overview, and the compact awaiting " +
    "list expands in place. Hidden windows at 1440/1120/minimum width.",
  async run({ page, app, fixture, shot }) {
    const { endpoint, repoId, rootDir } = fixture;

    // 3 条关注工作:根任务 + 成员任务(有子任务即工作根),计划经真实 doc-submit 实化。
    for (const work of WATCHED_WORKS) {
      await createRealizedTaskPlanFixture(
        rootDir,
        () => rpc(endpoint, repoId, "repo.task.create", { taskId: work.root, title: work.title }),
        (planPath) => rpc(endpoint, repoId, "repo.task.run", { action: { kind: "doc-submit", paths: [planPath] } }),
        work.title,
      );
      await createRealizedTaskPlanFixture(
        rootDir,
        () =>
          rpc(endpoint, repoId, "repo.task.create", {
            taskId: work.member,
            title: `${work.title}·成员任务`,
            parentTaskId: work.root,
          }),
        (planPath) => rpc(endpoint, repoId, "repo.task.run", { action: { kind: "doc-submit", paths: [planPath] } }),
        `${work.title}·成员任务`,
      );
      const pinned = await rpc(endpoint, repoId, "repo.task.pin", { taskId: work.root });
      assert.equal(pinned.ok, true, `pin ${work.root}: ${JSON.stringify(pinned).slice(0, 300)}`);
    }

    // 真实人工决策:两条指向读者的 awaits 问句(relation-relate 真实写路)。
    for (const ask of HUMAN_ASKS) {
      const related = await rpc(endpoint, repoId, "repo.task.run", {
        action: {
          kind: "relation-relate",
          sourceRef: `task/${ask.source}`,
          targetRef: "person/person-gui",
          relationType: "awaits",
          rationale: `question: ${ask.question}`,
          expectedVersion: 0,
        },
      });
      assert.equal(related.ok, true, `relation-relate: ${JSON.stringify(related).slice(0, 300)}`);
    }

    // 种子发生在 GUI 挂载之后:重载让读面重新拉取,不吃 stale 缓存。
    await page.reload();
    await nav(page, /^(?:总览|Overview)$/u, "overview-view");

    // 关注工作卡:三张卡都在,来源标签如实说「置顶 3 项」。
    const worksRegion = page.getByTestId("overview-region-works");
    await worksRegion.waitFor();
    for (const work of WATCHED_WORKS) {
      await worksRegion.locator(`[data-work-card="${work.root}"]`).waitFor({ timeout: 20_000 });
    }
    await worksRegion.getByText("置顶 3 项").waitFor({ timeout: 20_000 });

    // 等你处理的事:默认紧凑 ≤3 行;人工问句在块内,机器行不冒充用户决策。
    const awaits = page.getByTestId("overview-awaits");
    await awaits.waitFor();
    await page.waitForFunction(
      () => globalThis.document.querySelectorAll('[data-testid="overview-awaits"] [data-awaits-row]').length > 0,
    );
    const awaitsText = await awaits.innerText();
    assert.ok(awaitsText.includes(HUMAN_ASKS[0].question), "the human ask must be in the awaiting block");
    const rowTexts = await page.evaluate(() =>
      [...globalThis.document.querySelectorAll('[data-testid="overview-awaits"] [data-awaits-row]')].map(
        (row) => row.textContent,
      ),
    );
    assert.ok(
      rowTexts.length > 0 && rowTexts.every((row) => !row.includes("待初审") && !row.includes("评审打回")),
      `machine rows must not pose as user decisions in the awaiting block: ${JSON.stringify(rowTexts)}`,
    );
    const expand = awaits.getByTestId("overview-awaits-expand");
    if (await expand.count()) {
      await expand.click();
      const expandedRows = await page.evaluate(
        () => globalThis.document.querySelectorAll('[data-testid="overview-awaits"] [data-awaits-row]').length,
      );
      assert.ok(expandedRows > 3, "expanding must reveal the remaining decisions");
      await shot("overview-attention-expanded");
      await awaits.getByTestId("overview-awaits-collapse").click();
    }

    // 三档窗口实测几何 + 截屏:默认宽(1440)→1120→最小窗宽。
    await setSize(app, page, 1440, 900);
    let geometry = await fourBlockGeometry(page);
    assertFourBlockLayout(geometry);
    await shot("overview-attention-wide-1440");

    await setSize(app, page, 1120, 800);
    geometry = await fourBlockGeometry(page);
    assertFourBlockLayout(geometry);
    await shot("overview-attention-1120");

    // 900 宽是 Electron 最小窗宽以下的值:窗口被主进程夹到 1120,断言用实测视口而不是
    // 请求值,否则会把「最小窗宽」误判成布局失败。
    await setSize(app, page, 900, 800);
    geometry = await fourBlockGeometry(page);
    assertFourBlockLayout(geometry);
    await shot("overview-attention-min-width");
  },
};
