import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { requestDaemonJsonRpcAt } from "../../../packages/daemon/src/client/local-json-rpc-client.ts";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";
import { bridgeReady } from "./helpers.mjs";

/**
 * 最近进展状态链组件内横滚(DayDigest/StepChain 契约):长状态链单行、在链内部横向
 * 滚动,外部行高不随步骤数增长;滚动滚轮不误触行导航;窄面板(<32rem)标题与状态链
 * 转上下两行,链占满整行;正文页面无横向溢出。
 * 断言面是工作页「最近进展」时间线:总览 2026-10-04 注意力返工只给每工作一行「最近」
 * 摘要,详细密度(原总览 DayDigest 区域)住在工作页;夹具让根任务带一个子任务成为
 * 工作根,工作页才存在。
 * 数据面:真实返工循环——start → submit → adjudicate return 每轮产生
 * start/submit/returned 三个交错步骤(workDayGroups 连续同类收成一步,交错才增长),
 * 全部经 daemon 聚合写口(repo.task.run 的 task-start/task-submit/task-adjudicate),
 * 不造前端夹具。提交所需的 delivery commit 与 closeout.md 也是真实 daemon 校验路径
 * (doc-submit 接受的 closeout、main 上带 first parent 的交付 commit)。
 */
const ROUNDS = 14;
const LONG_TASK = "task-gui-smoke";
const SHORT_TASK = "task-chain-short";

function repoRpc(endpoint, repoId, method, payload) {
  return requestDaemonJsonRpcAt(endpoint, method, { repo: { repoId }, payload }, 2_000, 30_000);
}

/** 每轮回执必须 applied:任何一轮被拒都直接失败,链长不足会让几何断言失去分辨力。 */
async function mustApply(endpoint, repoId, action, label) {
  const receipt = await repoRpc(endpoint, repoId, "repo.task.run", { action });
  assert.equal(receipt.outcome, "applied", `${label} receipt: ${JSON.stringify(receipt).slice(0, 400)}`);
  return receipt;
}

export default {
  id: "work-progress-chain",
  feature: "overview",
  lane: "isolated",
  description:
    "Long progress step chains stay single-line and scroll inside the chain; row height does not grow with step count.",
  async run({ page, fixture, shot }) {
    await bridgeReady(page);

    // ——— 数据面:真实返工循环 ———
    // 提交前置:main 上先落一个基底 commit,再落交付 commit(交付 commit 需要 first
    // parent 才有可比 cut);closeout.md 走 doc-submit 的真实接受路径。
    writeFileSync(path.join(fixture.rootDir, "chain-base.txt"), "chain base marker");
    execFileSync("git", ["-C", fixture.rootDir, "add", "chain-base.txt"], { stdio: "pipe" });
    execFileSync(
      "git",
      [
        "-C",
        fixture.rootDir,
        "-c",
        "user.name=gui-e2e",
        "-c",
        "user.email=gui-e2e@local",
        "commit",
        "-m",
        "chain base",
      ],
      { stdio: "pipe" },
    );
    writeFileSync(path.join(fixture.rootDir, "chain-delivery.txt"), "chain delivery marker");
    execFileSync("git", ["-C", fixture.rootDir, "add", "chain-delivery.txt"], { stdio: "pipe" });
    execFileSync(
      "git",
      [
        "-C",
        fixture.rootDir,
        "-c",
        "user.name=gui-e2e",
        "-c",
        "user.email=gui-e2e@local",
        "commit",
        "-m",
        "chain delivery",
      ],
      { stdio: "pipe" },
    );
    execFileSync("git", ["-C", fixture.rootDir, "branch", "-M", "main"], { stdio: "pipe" });
    const commitSha = execFileSync("git", ["-C", fixture.rootDir, "rev-parse", "HEAD"], { stdio: "pipe" })
      .toString()
      .trim();
    writeFileSync(
      path.join(fixture.rootDir, "harness", fixture.packagePath, "closeout.md"),
      [
        "## Summary",
        "Delivered the progress chain e2e fixture through the real rework loop.",
        "",
        "## Verification",
        "- Real daemon receipts observed for every loop round.",
        "",
        "## Residual Risk",
        "- Accepted risk: fixture-only delivery commit.",
        "",
        "## Same Mechanism Elsewhere",
        "- No sibling surface drives this loop.",
        "",
      ].join("\n"),
    );
    await mustApply(fixture.endpoint, fixture.repoId, { kind: "doc-submit", taskId: LONG_TASK }, "doc-submit");

    const created = await repoRpc(fixture.endpoint, fixture.repoId, "repo.task.create", {
      taskId: SHORT_TASK,
      title: "短链对照任务",
      // 子任务让夹具根任务成为工作根:详细进展密度住在工作页时间线(总览 2026-10-04
      // 注意力返工后只留每工作一行「最近」摘要,原 DayDigest 区域已删)。
      parentTaskId: LONG_TASK,
    });
    assert.equal(created.ok, true, `short task create: ${JSON.stringify(created).slice(0, 300)}`);
    // 与 fixture 自建任务同序:等发布落地(worktree 可见、脚手架已写出)再实化计划。
    const visible = await repoRpc(fixture.endpoint, fixture.repoId, "repo.task.read", {
      action: {
        kind: "receipt-show",
        opId: created.opId,
        waitFor: ["git_verified", "worktree_visible"],
        timeoutMs: 5000,
      },
    });
    assert.equal(visible.wait?.state, "satisfied", `short task publication: ${JSON.stringify(visible).slice(0, 300)}`);
    // 新任务的 plan 脚手架是占位,task-start 会被 plan_placeholder 拒;先走夹具的
    // 计划实化器(与 fixture 自建任务同一路径)再占租。
    await realizeTaskPlanFixture(
      fixture.rootDir,
      String(created.packagePath),
      async (planPath) =>
        await repoRpc(fixture.endpoint, fixture.repoId, "repo.task.run", {
          action: { kind: "doc-submit", paths: [planPath] },
        }),
      "短链对照任务",
    );
    await mustApply(
      fixture.endpoint,
      fixture.repoId,
      { kind: "task-start", taskId: SHORT_TASK, executionId: "exec-chain-short" },
      "short start",
    );

    for (let round = 1; round <= ROUNDS; round++) {
      const executionId = `exec-chain-${round}`;
      await mustApply(
        fixture.endpoint,
        fixture.repoId,
        { kind: "task-start", taskId: LONG_TASK, executionId },
        `round ${round} start`,
      );
      await mustApply(
        fixture.endpoint,
        fixture.repoId,
        { kind: "task-submit", taskId: LONG_TASK, executionId, commitSha },
        `round ${round} submit`,
      );
      // worker-mode none(9ceab8bb1 起 return 必须显式选续派模式):夹具只要返工状态
      // 转移落账增长链,不派发真实 worker。
      await mustApply(
        fixture.endpoint,
        fixture.repoId,
        {
          kind: "task-adjudicate",
          taskId: LONG_TASK,
          return: true,
          reason: `chain rework round ${round}`,
          workerMode: "none",
        },
        `round ${round} return`,
      );
    }

    // 种子发生在 GUI 挂载之后:重载让读面全部重新拉取,不吃 30s stale 缓存。
    await page.reload();
    await bridgeReady(page);

    // ——— 断言面:工作页「最近进展」里的真实 DayDigest ———
    // (总览 2026-10-04 注意力返工删掉了首屏 DayDigest 区域;同一原语住在工作页时间线。)
    const openWorkProgress = async () => {
      await page.getByRole("button", { name: /^(?:看板|Board)$/u }).click();
      const card = page
        .getByTestId("board-task-card")
        .filter({ hasText: "Render the real triadic projection" })
        .first();
      await card.waitFor({ timeout: 20_000 });
      // 工作根卡片直接路由进工作页(workspace,根任务详情只是其中一个分区),不走预览抽屉。
      await card.click();
      // 概况首屏不再内嵌时间线(2026-10-21 业主 13:50 降密度);DayDigest 密度住「进展」页签。
      const progressTab = page.getByRole("tab", { name: /^(?:进展|Progress)$/u });
      await progressTab.waitFor({ timeout: 20_000 });
      await progressTab.click();
      await page.locator("#workspace-panel [data-day]").first().waitFor({ timeout: 20_000 });
    };
    await openWorkProgress();
    const region = page.locator("#workspace-panel");
    const longChain = region.getByTestId("step-chain").filter({ hasText: "退回" }).last();
    await longChain.waitFor();

    const geometry = await longChain.evaluate((node) => {
      const rows = [...node.closest("[data-day]").querySelectorAll(":scope > div > *")];
      return {
        scrollWidth: node.scrollWidth,
        clientWidth: node.clientWidth,
        scrollHeight: node.scrollHeight,
        clientHeight: node.clientHeight,
        rows: rows.map((row) => row.offsetHeight),
      };
    });
    // 长链溢出且单行:横滚容器承担宽度,行高只由字号档决定。
    assert.ok(geometry.scrollWidth > geometry.clientWidth, `chain must overflow: ${JSON.stringify(geometry)}`);
    assert.ok(
      geometry.scrollHeight <= geometry.clientHeight + 1,
      `chain must stay single-line: ${JSON.stringify(geometry)}`,
    );
    // 外部行高不随步骤数增长:42 步链的行与 1 步对照行同高(容 1px 取整差)。
    const rowHeights = geometry.rows.map((height) => height).sort((left, right) => left - right);
    assert.ok(
      rowHeights.at(-1) - rowHeights[0] <= 1,
      `row heights must not grow with step count: ${JSON.stringify(geometry.rows)}`,
    );

    // 滚到末项可达;横向滚轮不误触行导航;键盘平移同理(工作页行是导航,不是选择)。
    const onWorkPage = () => page.getByTestId("workspace-view").isVisible();
    const endState = await longChain.evaluate((node) => {
      node.scrollLeft = node.scrollWidth;
      const tags = [...node.querySelectorAll("[data-status-tone]")];
      const last = tags.at(-1);
      const chainBox = node.getBoundingClientRect();
      const lastBox = last.getBoundingClientRect();
      return {
        scrollLeft: node.scrollLeft,
        lastReached: lastBox.right <= chainBox.right + 1,
      };
    });
    assert.ok(endState.scrollLeft > 0, "chain must be scrollable to the end");
    assert.ok(endState.lastReached, "the last step tag must be reachable by scrolling");
    // A4 渐隐契约(scroll-fade-x 注册变量,替代已删除的「›」提示):到头一侧羽化归零、
    // 未到头一侧保持。scroll-driven 动画的计算值在滚动后的下一渲染帧才更新,等待落定。
    await page.waitForFunction(
      (node) => Number.parseFloat(globalThis.getComputedStyle(node).getPropertyValue("--scroll-fade-after")) < 0.5,
      await longChain.elementHandle(),
    );
    const tailFade = await longChain.evaluate((node) => {
      const style = globalThis.getComputedStyle(node);
      return {
        before: Number.parseFloat(style.getPropertyValue("--scroll-fade-before")),
        after: Number.parseFloat(style.getPropertyValue("--scroll-fade-after")),
      };
    });
    assert.ok(tailFade.before > 0.5, `the unreached head edge must stay faded: ${JSON.stringify(tailFade)}`);
    assert.ok(tailFade.after < 0.5, `the reached tail edge must not fade: ${JSON.stringify(tailFade)}`);
    const chainBox = await longChain.boundingBox();
    await page.mouse.move(chainBox.x + chainBox.width / 2, chainBox.y + chainBox.height / 2);
    await page.mouse.wheel(600, 0);
    const afterWheel = await longChain.evaluate((node) => ({ scrollLeft: node.scrollLeft }));
    assert.ok(afterWheel.scrollLeft > 0, "horizontal wheel must scroll the chain");
    assert.ok(await onWorkPage(), "scrolling must not navigate the row");

    // ——— 键盘可达:溢出链是可焦点组(tabindex/role 落在外层 data-chain-strip——渐隐
    // mask 会裁掉滚动区自身的焦点环),方向键平移且不误触导航 ———
    // 标题按钮与链是兄弟元素:从标题用真实 Tab 进入链组，验证独立焦点
    // 可键盘到达(Chromium 行为,不以另一详情页替代)。
    await longChain.evaluate((node) => {
      node.scrollLeft = 0;
      node.closest("[data-day-path]").querySelector("button").focus();
    });
    await page.waitForFunction(
      (node) => Number.parseFloat(globalThis.getComputedStyle(node).getPropertyValue("--scroll-fade-before")) < 0.5,
      await longChain.elementHandle(),
    );
    const headFade = await longChain.evaluate((node) => {
      const style = globalThis.getComputedStyle(node);
      return {
        before: Number.parseFloat(style.getPropertyValue("--scroll-fade-before")),
        after: Number.parseFloat(style.getPropertyValue("--scroll-fade-after")),
      };
    });
    assert.ok(headFade.before < 0.5, `the reached head edge must not fade: ${JSON.stringify(headFade)}`);
    assert.ok(headFade.after > 0.5, `the unreached tail edge must stay faded: ${JSON.stringify(headFade)}`);
    let stripFocused = false;
    for (let step = 0; step < 8 && !stripFocused; step += 1) {
      await page.keyboard.press("Tab");
      stripFocused = await longChain.evaluate(
        (node) => globalThis.document.activeElement === node.closest("[data-chain-strip]"),
      );
    }
    assert.ok(stripFocused, "Tab must reach the overflowing chain group after the title button");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    const afterArrows = await longChain.evaluate((node) => ({ scrollLeft: node.scrollLeft }));
    assert.ok(afterArrows.scrollLeft > 0, "ArrowRight on the focused chain must scroll it in place");
    assert.ok(await onWorkPage(), "keyboard scrolling must not navigate the row");
    await page.keyboard.press("Space");
    assert.ok(await onWorkPage(), "Space in the scroll region must not navigate the row");
    await page.keyboard.press("End");
    const endReached = await longChain.evaluate((node) => {
      const tags = [...node.querySelectorAll("[data-status-tone]")];
      return {
        atEnd: node.scrollLeft + node.clientWidth >= node.scrollWidth - 1,
        lastVisible: tags.at(-1).getBoundingClientRect().right <= node.getBoundingClientRect().right + 1,
      };
    });
    assert.ok(
      endReached.atEnd && endReached.lastVisible,
      `End must bring the last step into view: ${JSON.stringify(endReached)}`,
    );
    // 短链对照:不溢出的链时间线不激活,渐隐变量回落 0px、外层链组不进 tab 序。
    const shortChain = region.getByTestId("step-chain").filter({ hasText: "开始" }).first();
    if ((await shortChain.count()) > 0) {
      const shortState = await shortChain.evaluate((node) => {
        const style = globalThis.getComputedStyle(node);
        return {
          overflow: node.scrollWidth > node.clientWidth,
          before: Number.parseFloat(style.getPropertyValue("--scroll-fade-before")),
          after: Number.parseFloat(style.getPropertyValue("--scroll-fade-after")),
          tabindex: node.closest("[data-chain-strip]")?.getAttribute("tabindex") ?? null,
        };
      });
      if (!shortState.overflow) {
        assert.ok(
          shortState.before < 0.5 && shortState.after < 0.5,
          `a non-overflowing chain must not fade either edge: ${JSON.stringify(shortState)}`,
        );
        assert.equal(shortState.tabindex, null, "a non-overflowing chain must stay out of the tab order");
      }
    }

    // 页面正文不横向溢出(先于任何点击:行点击会导航去任务详情)。
    const pageOverflow = await page.evaluate(() => ({
      scrollWidth: globalThis.document.scrollingElement.scrollWidth,
      clientWidth: globalThis.document.scrollingElement.clientWidth,
    }));
    assert.ok(
      pageOverflow.scrollWidth <= pageOverflow.clientWidth + 1,
      `page must not overflow horizontally: ${JSON.stringify(pageOverflow)}`,
    );
    await shot("work-progress-chain-wide");

    // 行点击是真实导航:从时间线行进入对应任务详情。
    await longChain.locator("xpath=ancestor::*[@data-day-path]").locator("button").first().click();
    await page.getByTestId("task-detail-view").waitFor();

    // ——— 窄面板:重载回到工作页时间线,区域容器收到 260px,标题/状态链转上下两行 ———
    await page.reload();
    await bridgeReady(page);
    await openWorkProgress();
    const narrowChain = region.getByTestId("step-chain").filter({ hasText: "退回" }).last();
    await narrowChain.waitFor();
    await region.evaluate((node) => {
      node.style.width = "260px";
    });
    await page.waitForFunction(
      (node) => {
        const row = node.parentElement.parentElement;
        return (
          node.closest("[data-day]").clientWidth < 512 &&
          Math.abs(node.parentElement.getBoundingClientRect().width - row.getBoundingClientRect().width) <= 1 &&
          Number.parseFloat(globalThis.getComputedStyle(node).getPropertyValue("--scroll-fade-after")) > 0.5
        );
      },
      await narrowChain.elementHandle(),
    );
    const narrow = await narrowChain.evaluate((node) => {
      const row = node.parentElement.parentElement;
      const style = globalThis.getComputedStyle(node);
      return {
        dayWidth: node.closest("[data-day]").clientWidth,
        stripWidth: node.parentElement.getBoundingClientRect().width,
        rowWidth: row.getBoundingClientRect().width,
        stillSingleLine: node.scrollHeight <= node.clientHeight + 1,
        stillScrollable: node.scrollWidth > node.clientWidth,
        fadeBefore: Number.parseFloat(style.getPropertyValue("--scroll-fade-before")),
        fadeAfter: Number.parseFloat(style.getPropertyValue("--scroll-fade-after")),
      };
    });
    assert.ok(narrow.dayWidth < 512, `narrow panel must trigger the stacked layout: ${JSON.stringify(narrow)}`);
    assert.ok(
      Math.abs(narrow.stripWidth - narrow.rowWidth) <= 1,
      `stacked chain row must span the full row width: ${JSON.stringify(narrow)}`,
    );
    assert.ok(narrow.stillSingleLine, `narrow chain must stay single-line: ${JSON.stringify(narrow)}`);
    assert.ok(narrow.stillScrollable, `narrow chain must still scroll inside: ${JSON.stringify(narrow)}`);
    assert.ok(
      narrow.fadeBefore < 0.5 && narrow.fadeAfter > 0.5,
      `narrow chain at the head must fade only the unreached tail edge: ${JSON.stringify(narrow)}`,
    );
    await shot("work-progress-chain-narrow");
  },
};
