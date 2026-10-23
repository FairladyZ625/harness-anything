// harness-test-tier: integration
// --scroll-to 的命中选择必须在真实渲染页面上验:本文件的页面就是 2026-10-23 CEO 验收 #3924
// 时的撞词形状——页头说明「显示此刻正在干活的会话。」在页顶、节标题「在干活」在页底,两者
// 都可见。旧实现取第一个可见文字匹配,于是三张分节截图全是页顶。
// 断言两面:阴性(旧取法确实命中页头说明,缺陷可复现)与阳性(梯度取节标题且把它对齐到顶部)。
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { prepareE2EProbeGui, resolveE2EProbeElectronForTest } from "../e2e-probe.mjs";
import { resolveScrollTarget, scrollTargetToTop } from "./capture-scroll.mjs";

const workspaceRoot = path.resolve(import.meta.dirname, "../..");

// 与现场页同一形状:页头 h1 + 含目标词的说明 span,正文很长,节标题落在首屏下缘、
// 但整块都已在视口内。
const COLLIDING_PAGE = `<!doctype html><html><body style="margin:0;font:16px system-ui">
<header style="padding:8px 20px">
  <h1 style="margin:0">现场</h1>
  <span id="page-note">按工作分组，显示此刻正在干活的会话。</span>
</header>
<div style="height:690px"></div>
<h2 id="section-running" style="margin:8px 20px">在干活</h2>
<p style="padding:0 20px">10 个活跃会话</p>
<div style="height:2000px"></div>
</body></html>`;

// 没有标题元素的页面(整卡是一个按钮标题、或标题在 span 里):梯度要能退到文字层继续工作。
const TEXT_ONLY_PAGE = `<!doctype html><html><body style="margin:0;font:16px system-ui">
<p style="padding:20px">页头说明</p>
<div style="height:1200px"></div>
<span id="section-label" style="display:block;padding:0 20px">刚交付</span>
<div style="height:2000px"></div>
</body></html>`;

// 节标题比页面晚出现:现场页的节标题依赖 daemon 读面,导航后一秒内可能还没渲染。
// 旧实现的 10s 重试窗是这个能力;梯度解析不能把它换成一次 count()。
// 延迟插入由 Node 侧计时(页面 CSP 是 `script-src 'self'`,内联脚本会被拦)。
const LATE_HEADING_PAGE = `<!doctype html><html><body style="margin:0;font:16px system-ui">
<header style="padding:8px 20px"><span id="page-note">显示此刻正在干活的会话。</span></header>
<div style="height:690px"></div>
<div id="section-slot"></div>
<div style="height:2000px"></div>
</body></html>`;

// 最后一节后面没有足够内容:它物理上到不了滚动口顶部。此时工具必须如实报「差多少」,
// 而不是假定「滚到最大 = 这一节在顶部」——现场页的「流水线」就是这个位置(实测差 485px)。
const LAST_SECTION_PAGE = `<!doctype html><html><body style="margin:0;font:16px system-ui">
<div style="height:400px"></div>
<h2 id="section-pipeline" style="margin:8px 20px">流水线</h2>
<p style="padding:0 20px">84 个任务</p>
<div style="height:40px"></div>
</body></html>`;

const insertHeadingAfter = (page, delayMs) =>
  page.evaluate(
    ({ delay }) =>
      new Promise((resolve) =>
        globalThis.setTimeout(() => {
          const heading = globalThis.document.createElement("h2");
          heading.id = "section-running";
          heading.textContent = "在干活";
          globalThis.document.getElementById("section-slot").append(heading);
          resolve();
        }, delay),
      ),
    { delay: delayMs },
  );

const rectOf = (locator) =>
  locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { top: Math.round(rect.top), bottom: Math.round(rect.bottom), viewport: globalThis.innerHeight };
  });

test(
  "--scroll-to prefers the section heading over a page-header note and aligns it to the top",
  { timeout: 180_000 },
  async (t) => {
    const runtime = resolveE2EProbeElectronForTest(workspaceRoot);
    if (!runtime.available) {
      t.skip(runtime.reason);
      return;
    }
    t.after(runtime.close);
    prepareE2EProbeGui(workspaceRoot, runtime.env);
    const { startGuiDriver } = await import("./driver.mjs");
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const runRoot = mkdtempSync(path.join(tmpdir(), "capture-scroll-it-"));
    const driver = await startGuiDriver({ workspaceRoot, rootDir: workspaceRoot, env: runtime.env, runRoot });
    try {
      const { page } = driver;

      await page.setContent(COLLIDING_PAGE);
      // 阴性对照:旧取法(第一个可见文字匹配)命中的是页头说明,不是节标题——缺陷的机制证明。
      const legacy = page.getByText("在干活").filter({ visible: true }).first();
      assert.equal(
        await legacy.getAttribute("id"),
        "page-note",
        "the legacy first-visible match must be the page note",
      );
      assert.equal(await legacy.scrollIntoViewIfNeeded().then(() => page.evaluate(() => globalThis.scrollY)), 0);

      const resolved = await resolveScrollTarget(page, "在干活");
      assert.equal(resolved.tier, "标题精确");
      assert.equal(await resolved.locator.getAttribute("id"), "section-running");
      // 命中节标题时它本来就在视口里(下缘),这正是旧实现「已可见就不滚」失效的位置。
      const atMatch = await rectOf(resolved.locator);
      assert.ok(
        atMatch.top > 0 && atMatch.bottom <= atMatch.viewport,
        `the section heading must already be visible when matched, got top=${atMatch.top} viewport=${atMatch.viewport}`,
      );
      const alignment = await scrollTargetToTop(resolved.locator);
      assert.equal(alignment.gapPx, 0, "an aligned section reports a zero gap");
      assert.equal(alignment.atMaxScroll, false);
      const aligned = await rectOf(resolved.locator);
      assert.ok(Math.abs(aligned.top) <= 1, `section heading must sit at the viewport top, got top=${aligned.top}`);

      // 没有标题元素时退到文字精确,而不是报「找不到」。
      await page.setContent(TEXT_ONLY_PAGE);
      const fallback = await resolveScrollTarget(page, "刚交付");
      assert.equal(fallback.tier, "文字精确");
      assert.equal(await fallback.locator.getAttribute("id"), "section-label");
      await scrollTargetToTop(fallback.locator);
      assert.ok(Math.abs((await rectOf(fallback.locator)).top) <= 1);

      // 最后一节到不了口顶时如实报 gap:这是页面长度限制,不是「滚过了就等于在顶部」。
      await page.setContent(LAST_SECTION_PAGE);
      const last = await resolveScrollTarget(page, "流水线");
      assert.equal(last.tier, "标题精确");
      const lastAlignment = await scrollTargetToTop(last.locator);
      assert.ok(lastAlignment.gapPx > 0, `a last short section cannot reach the top, got gap=${lastAlignment.gapPx}`);
      assert.equal(lastAlignment.atMaxScroll, true);

      // 节标题晚于页面出现时仍在标题层命中:不能因为首轮还没渲染就退到「文字包含」。
      await page.setContent(LATE_HEADING_PAGE);
      const inserting = insertHeadingAfter(page, 1_200);
      const late = await resolveScrollTarget(page, "在干活");
      await inserting;
      assert.equal(late.tier, "标题精确", `late heading must still resolve at the heading tier, got ${late.tier}`);
      assert.equal(await late.locator.getAttribute("id"), "section-running");

      // 找不到时失败要能区分「没有这个词」和「这个词到处都有」:报错带每级匹配数。
      await page.setContent(COLLIDING_PAGE);
      await assert.rejects(
        resolveScrollTarget(page, "不存在的节", { timeoutMs: 300 }),
        /标题精确=0, 文字精确=0, 标题包含=0, 文字包含=0/,
      );
      await assert.rejects(resolveScrollTarget(page, "不存在的节", { timeoutMs: 300 }), /在 300ms 内找不到可见目标/);
    } finally {
      await driver.close();
      rmSync(runRoot, { recursive: true, force: true });
    }
  },
);
