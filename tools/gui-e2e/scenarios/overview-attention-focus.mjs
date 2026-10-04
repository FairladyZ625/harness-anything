import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { requestDaemonJsonRpcAt } from "../../../packages/daemon/src/client/local-json-rpc-client.ts";
import { createRealizedTaskPlanFixture } from "../../fixtures/task-plan.mjs";
import { nav } from "./helpers.mjs";

/**
 * #task_ac9665e4b3d0400b34e851b1c4 CEO 视觉返工的验收场景(2026-10-04):真实 daemon 数据
 * 下的注意力布局——至少 3 条置顶关注工作、多条机器返工(task-adjudicate --return 打回)、
 * 多条真实人工决策(awaits 问句 + 夹具自带的待点头决策)。隐藏 Electron 在默认宽
 * (1440)/1120/900 三档窗口截屏:决策带默认只铺三条并可一键展开,关注工作是首屏主体,
 * 执行下钻是底部紧凑工具带,不再独占整列空容器。全部数据走真实写路(repo.task.create/
 * run/pin、relation-relate),断言与截图不写死 daemon 侧数值。
 */

const WATCHED_WORKS = [
  { root: "task-att-watch-a", member: "task-att-watch-a1", title: "关注工作甲·投影读面" },
  { root: "task-att-watch-b", member: "task-att-watch-b1", title: "关注工作乙·评审闸门" },
  { root: "task-att-watch-c", member: "task-att-watch-c1", title: "关注工作丙·交付节奏" },
];

// 机器返工住关注工作乙/丙名下:评审打回的成员任务,返工由执行方再派,不是用户裁决。
const REWORK_TASKS = [
  { taskId: "task-att-watch-b1", executionId: "exec-att-rework-b" },
  { taskId: "task-att-watch-c1", executionId: "exec-att-rework-c" },
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

/** 三段布局的实测几何:决策带在上、工作主体居中、下钻工具带在底部同列。 */
async function attentionGeometry(page) {
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
      band: box("overview-decisions-band"),
      works: box("overview-region-works"),
      drill: box("overview-region-drill"),
      decisionRows: globalThis.document.querySelectorAll('[data-testid="overview-decisions-band"] [data-decision]')
        .length,
      workCards: globalThis.document.querySelectorAll("[data-work-card]").length,
    };
  });
}

function assertAttentionLayout(geometry) {
  const { viewport, band, works, drill } = geometry;
  assert.ok(
    band !== null && works !== null && drill !== null,
    `all three sections must exist: ${JSON.stringify(geometry)}`,
  );
  // 紧凑决策带:默认 ≤3 行,且不占首屏的大头(高度低于工作主体)。
  assert.ok(geometry.decisionRows <= 3, `compact band must show at most 3 rows, saw ${geometry.decisionRows}`);
  assert.ok(
    band.height < works.height,
    `watched works must be the main body: band ${band.height} vs works ${works.height}`,
  );
  assert.ok(
    band.height < viewport.height * 0.42,
    `band must stay a compact strip: ${band.height} of ${viewport.height}`,
  );
  // 单列注意力漏斗:决策带在上,工作主体接其下,下钻工具带与工作同列(不另立空列)。
  assert.ok(band.bottom <= works.top + 1, `band must sit above the works body: ${JSON.stringify(geometry)}`);
  assert.ok(
    Math.abs(drill.left - works.left) <= 2 && Math.abs(drill.right - works.right) <= 2,
    `drill must share the works column instead of owning an empty column: ${JSON.stringify(geometry)}`,
  );
  assert.ok(geometry.workCards >= 3, `at least three watched works must render, saw ${geometry.workCards}`);
}

export default {
  id: "overview-attention-focus",
  feature: "overview",
  lane: "isolated",
  description:
    "Compact decision band (few rows by default, one-click expand), watched works as the first-screen body, " +
    "and a bottom drill tool strip, verified against a real daemon seeded with 3+ pinned works, machine reworks " +
    "and human decisions at 1440/1120/900 hidden windows.",
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
      const member = await createRealizedTaskPlanFixture(
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
      work.packagePath = member.packagePath;
      const pinned = await rpc(endpoint, repoId, "repo.task.pin", { taskId: work.root });
      assert.equal(pinned.ok, true, `pin ${work.root}: ${JSON.stringify(pinned).slice(0, 300)}`);
    }

    // 机器返工:成员任务走 真实提交→初审打回,落 awaitingRework(owning CEO 的机器双闸)。
    writeFileSync(path.join(rootDir, "attention-focus-delivery.txt"), "attention focus fixture delivery\n");
    execFileSync("git", ["-C", rootDir, "add", "attention-focus-delivery.txt"], { stdio: "pipe" });
    execFileSync(
      "git",
      [
        "-C",
        rootDir,
        "-c",
        "user.name=gui-e2e",
        "-c",
        "user.email=gui-e2e@local",
        "commit",
        "-m",
        "test: attention focus delivery",
      ],
      { stdio: "pipe" },
    );
    const commitSha = execFileSync("git", ["-C", rootDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    for (const rework of REWORK_TASKS) {
      const memberPath = WATCHED_WORKS.find((work) => work.member === rework.taskId)?.packagePath;
      writeFileSync(
        path.join(rootDir, "harness", memberPath, "closeout.md"),
        [
          "## Summary",
          "Delivered the attention-focus rework fixture round.",
          "",
          "## Verification",
          "- Real daemon receipts for submit and adjudicate return.",
          "",
          "## Residual Risk",
          "- Fixture-only content.",
          "",
          "## Same Mechanism Elsewhere",
          "- No sibling surface.",
          "",
        ].join("\n"),
      );
      const submitted = await rpc(endpoint, repoId, "repo.task.run", {
        action: { kind: "doc-submit", paths: [`${memberPath}/closeout.md`] },
      });
      assert.equal(submitted.ok, true, `doc-submit closeout: ${JSON.stringify(submitted).slice(0, 300)}`);
      const started = await rpc(endpoint, repoId, "repo.task.run", {
        action: { kind: "task-start", taskId: rework.taskId, executionId: rework.executionId },
      });
      assert.equal(started.ok, true, `task-start: ${JSON.stringify(started).slice(0, 300)}`);
      const sent = await rpc(endpoint, repoId, "repo.task.run", {
        action: { kind: "task-submit", taskId: rework.taskId, executionId: rework.executionId, commitSha },
      });
      assert.equal(sent.ok, true, `task-submit: ${JSON.stringify(sent).slice(0, 300)}`);
      const returned = await rpc(endpoint, repoId, "repo.task.run", {
        action: {
          kind: "task-adjudicate",
          taskId: rework.taskId,
          executionId: rework.executionId,
          return: true,
          reason: "attention focus fixture: machine rework round",
        },
      });
      assert.equal(returned.ok, true, `task-adjudicate return: ${JSON.stringify(returned).slice(0, 300)}`);
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

    // 决策带:默认紧凑 ≤3 行;人工问句在带内,机器返工不在带内。
    const band = page.getByTestId("overview-decisions-band");
    await band.waitFor();
    await page.waitForFunction(
      () => globalThis.document.querySelectorAll('[data-testid="overview-decisions-band"] [data-decision]').length > 0,
    );
    const bandText = await band.innerText();
    assert.ok(bandText.includes(HUMAN_ASKS[0].question), "the human ask must be in the band");
    // 机器行不冒充用户决策:带内行只有「等你答复/决策待点头」两档,没有待初审/评审打回。
    const rowKinds = await page.evaluate(() =>
      [...globalThis.document.querySelectorAll('[data-testid="overview-decisions-band"] [data-decision]')].map(
        (row) => row.textContent,
      ),
    );
    assert.ok(
      rowKinds.length > 0 && rowKinds.every((row) => !row.includes("待初审") && !row.includes("评审打回")),
      `machine rows must not pose as user decisions in the band: ${JSON.stringify(rowKinds)}`,
    );
    const expand = band.getByTestId("overview-decisions-expand");
    if (await expand.count()) {
      await expand.click();
      const expandedRows = await page.evaluate(
        () => globalThis.document.querySelectorAll('[data-testid="overview-decisions-band"] [data-decision]').length,
      );
      assert.ok(expandedRows > 3, "expanding must reveal the remaining decisions");
      await shot("overview-attention-expanded");
      await band.getByTestId("overview-decisions-collapse").click();
    }

    // 跟进与返工工具带:机器返工计数在,放大层名单可见打回行。
    const followChip = page.getByTestId("overview-drill-followups");
    await followChip.waitFor();
    await followChip.click();
    const followDialog = page.locator('[role="dialog"]');
    await followDialog.waitFor();
    await page.waitForFunction(
      () => globalThis.document.querySelector("[data-focus-list]")?.textContent.includes("关注工作乙"),
      null,
      { timeout: 10_000 },
    );
    await page.keyboard.press("Escape");
    await followDialog.waitFor({ state: "detached" });

    // 三档窗口实测几何 + 截屏:默认宽(1440)→1120→900。
    await setSize(app, page, 1440, 900);
    let geometry = await attentionGeometry(page);
    assertAttentionLayout(geometry);
    await shot("overview-attention-wide-1440");

    await setSize(app, page, 1120, 800);
    geometry = await attentionGeometry(page);
    assertAttentionLayout(geometry);
    await shot("overview-attention-1120");

    await setSize(app, page, 900, 800);
    geometry = await attentionGeometry(page);
    assertAttentionLayout(geometry);
    await shot("overview-attention-900");
  },
};
