// harness-test-tier: integration
// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { TaskControlPanel } from "../src/renderer/components/TaskControlPanel.tsx";
import type { TaskRow } from "../src/renderer/model/types.ts";
import { projectedTaskFields } from "./task-projection-fields.ts";
import {
  byTestId,
  cleanupMountedDetail,
  clickTab,
  flushEffects,
  installBridge,
  mounted,
  mount,
  prepareDetailEnvironment,
  setDetailOpenTerminal,
  task,
} from "./task-detail.fixtures.ts";

beforeAll(prepareDetailEnvironment);

afterEach(cleanupMountedDetail);

describe("Task detail expression", () => {
  it("submits the authored closeout without a packet form", async () => {
    const container = document.createElement("div"),
      root = createRoot(container),
      client = new QueryClient(),
      onSubmit = vi.fn(async () => undefined);
    document.body.append(container);
    mounted.push({ root, client });
    await act(async () => {
      root.render(
        createElement(TaskControlPanel, {
          task: { ...task, ...projectedTaskFields("active", { can: ["progress", "submit"] }) },
          onSubmit,
        }),
      );
    });
    const form = container.querySelectorAll("form")[1]!;
    expect(form.querySelectorAll("input, textarea")).toHaveLength(0);
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith();
  });
  it("offers an open-terminal action in the header only when the app wires one", async () => {
    await mount();
    expect(document.querySelector('[data-testid="task-detail-open-terminal"]')).toBeNull();
    const opened: TaskRow[] = [];
    setDetailOpenTerminal((row) => opened.push(row));
    try {
      await mount();
      const button = document.querySelector<HTMLButtonElement>('[data-testid="task-detail-open-terminal"]');
      expect(button?.textContent).toContain("打开终端");
      await act(async () => button!.click());
      expect(opened.map((row) => row.taskId)).toEqual([task.taskId]);
    } finally {
      setDetailOpenTerminal(undefined);
    }
  });

  it("renders compact task identity, six task-first tabs and a permanent document tree", async () => {
    const bridge = installBridge();
    await mount();

    expect(byTestId("task-identity-strip").textContent).toContain("person-owner · standard");
    expect(byTestId("task-identity-strip").textContent).toContain("plt-gui · software-coding");
    expect(byTestId("task-detail-view").textContent).toContain("Task 表达重做");
    expect([...document.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent?.trim())).toEqual([
      "概况",
      "派工",
      "证据",
      "关系",
      "收口",
      "文件",
    ]);
    // 密度(task_9f39e256):顶部元数据压成两行——tab 并入头部,不再独占整行;
    // 标题与徽标同行且徽标不换行,长标题只截断(overflow)不撑高。
    const header = byTestId("task-detail-header");
    expect(byTestId("task-detail-tabs").closest("header")).toBe(header);
    expect(header.className).not.toMatch(/min-h-14/u);
    const title = header.querySelector("h1")!;
    expect(title.className).toContain("truncate");
    expect(title.nextElementSibling?.className).toContain("whitespace-nowrap");
    expect(title.nextElementSibling?.className).toContain("shrink-0");
    // 会话组入口随头部重排仍可寻址(原在 tab 行尾部)。
    expect(byTestId("task-open-sessions").closest("header")).toBe(header);
    expect(byTestId("task-document-tree").textContent).toContain("artifacts");
    expect(byTestId("task-overview-tab").textContent).toContain("Canonical plan body");
    expect(byTestId("task-progress-timeline").textContent).toContain("Review review-w3: approved");
    expect(bridge.getTaskDocument).toHaveBeenCalledWith({ repoId: "repo-a", taskId: "task-w3", path: "task_plan.md" });
    expect(bridge.getTaskDocument.mock.calls.some(([payload]) => payload.path === "task-contract.json")).toBe(false);
  });

  it("renders structured dispatch, facts, relations, closeout and projected files", async () => {
    const bridge = installBridge();
    await mount();
    expect(bridge.getTaskCompletion).not.toHaveBeenCalled();

    await clickTab("派工");
    expect(byTestId("task-dispatch-tab").textContent).toContain("Codex Worker");
    expect(byTestId("task-dispatch-tab").textContent).toContain("Rendered runtime report");
    expect(byTestId("task-dispatch-tab").textContent).toContain("runtime_session_exited");

    await clickTab("证据");
    expect(byTestId("task-evidence-tab").textContent).toContain("Frontend consumes structured projections only");
    expect(byTestId("task-evidence-tab").textContent).toContain("source: review/dom");
    expect(byTestId("task-evidence-tab").textContent).toContain("standing");
    // W5:事实分诊并入——低置信 fact 带 triage 信号 badge 且排到 healthy fact 之前。
    expect(byTestId("task-evidence-tab").textContent).toContain("低 confidence");
    expect(byTestId("task-evidence-tab").textContent).toContain("1 条带信号 · 1 healthy");
    expect(byTestId("task-evidence-tab").textContent.indexOf("Confidence is low, needs a human recheck")).toBeLessThan(
      byTestId("task-evidence-tab").textContent.indexOf("Frontend consumes structured projections only"),
    );
    expect(document.querySelector("[data-testid='task-fact-detail-F-LOW']")).toBeInstanceOf(HTMLButtonElement);

    await clickTab("关系");
    expect(byTestId("task-relations-tab").textContent).toContain("PLT GUI UX");
    expect(byTestId("task-relations-tab").textContent).toContain("runtime-w3");
    await clickTab("收口");
    expect(bridge.getTaskCompletion).toHaveBeenCalledTimes(1);
    expect(bridge.getTaskCompletion).toHaveBeenCalledWith({ repoId: "repo-a", taskId: "task-w3" });
    expect(byTestId("task-completion-next").textContent).toContain("Center completion action");
    expect(byTestId("task-closeout-tab").textContent).toContain("review-w3");
    expect(byTestId("task-closeout-tab").textContent).toContain("consent-w3");
    expect(byTestId("task-closeout-tab").textContent).toContain("local-check");
    // W5:执行证据并入——execution 输出与回执按 execution 对齐展示。
    expect(byTestId("task-closeout-tab").textContent).toContain("Execution 输出");
    expect(byTestId("task-execution-execution-w3").textContent).toContain("execution-w3");
    expect(byTestId("task-execution-execution-w3").textContent).toContain("evidence_111111111111111111111111");
    expect(byTestId("task-execution-execution-w3").textContent).toContain("receipt-dom");
    expect(byTestId("task-execution-execution-w3").textContent).toContain("1 passing");

    await clickTab("文件");
    expect(byTestId("task-document-tree").textContent).toContain("INDEX.md");
    expect(byTestId("task-document-tree").textContent).toContain("artifacts");
    expect(byTestId("task-files-tab").textContent).toContain("Canonical plan body");
  });

  it("renders live worktree content and marks an unsynced task document", async () => {
    installBridge({ uncommittedPlan: true });
    await mount();

    await clickTab("文件");
    expect(byTestId("task-files-tab").textContent).toContain("Live worktree plan body");
    expect(byTestId("task-files-tab").textContent).not.toContain("Canonical plan body");
    expect(byTestId("task-document-uncommitted").textContent).toContain("工作树内容尚未提交");
    expect(byTestId("doc-uncommitted-task_plan.md").textContent).toContain("未提交");
  });

  it("shows a raw artifact as binary with its real metadata and read route, not a blank reader", async () => {
    installBridge();
    await mount();

    await clickTab("文件");
    const reports = [...byTestId("task-document-tree").querySelectorAll("button")].find((button) =>
      button.textContent?.includes("reports/"),
    )!;
    await act(async () => {
      reports.click();
    });
    const pdf = [...byTestId("task-document-tree").querySelectorAll("button")].find((button) =>
      button.textContent?.includes("dossier.pdf"),
    )!;
    expect(pdf).toBeInstanceOf(HTMLButtonElement);
    await act(async () => {
      pdf.click();
    });
    await flushEffects();

    // 白页缺陷的判别控制:PDF 走二进制面板,不进 DocReader,也不留一张空正文。
    const panel = byTestId("task-document-binary");
    expect(panel.textContent).toContain("二进制产物,不是文本");
    expect(panel.textContent).toContain("application/octet-stream");
    expect(panel.textContent).toContain("4096");
    expect(panel.textContent).toContain("harness/tasks/task-w3-night/artifacts/reports/dossier.pdf");
    expect(byTestId("task-document-binary-open")).toBeInstanceOf(HTMLButtonElement);
    expect(byTestId("task-files-tab").querySelector(".prose-harness")).toBeNull();
  });

  it("renders the §2.2 doc-type header: split title, goal line, lifecycle progress, underline tabs", async () => {
    installBridge({
      planBody:
        "# 任务与实体详情按基线重做\n\n## Brief\n\n把任务与实体详情页升级到视觉基线 v1,用共享原语组合。\n\n## Goal\n\n- 结构断言\n",
    });
    await mount();
    const header = byTestId("task-detail-header");
    // 标题经 TitleText:冒号后补充段染弱(faint span)。
    const title = header.querySelector("h1")!;
    expect(title.textContent).toContain("Task 表达重做");
    // 一行目标(可展开):来自 task_plan 的 Brief,收起时一行截断。
    const goal = byTestId("task-goal-line");
    expect(goal.textContent).toContain("把任务与实体详情页升级到视觉基线 v1");
    expect(goal.className).toContain("line-clamp-1");
    // 生命周期进度在页头:阶段步进条 + 关键数字(门禁/文档/子任务)。
    expect(header.textContent).toContain("门禁 1/1");
    expect(header.textContent).toContain("子任务 0/1");
    // 标签栏是下划线式共享 Tabs(§4),六个页签带 role=tab。
    const tabsNav = byTestId("task-detail-tabs").querySelector('[role="tablist"]')!;
    expect(tabsNav.className).toContain("border-b");
    expect([...tabsNav.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent?.trim())).toEqual([
      "概况",
      "派工",
      "证据",
      "关系",
      "收口",
      "文件",
    ]);
  });

  it("头部按内容换行,不靠写死的行宽与最小宽(原则 9②,C4)", async () => {
    installBridge();
    setDetailOpenTerminal(() => undefined);
    try {
      await mount();
      const header = byTestId("task-detail-header");
      // 面包屑行允许换行:窄屏下动作钮折到面包屑下一行,不再整行挤出视口。
      const strip = header.firstElementChild as HTMLElement;
      expect(strip.className).toContain("flex-wrap");
      // 动作钮组可收缩、逐钮换行,不再整组 shrink-0。
      const cluster = header.querySelector('[data-testid="task-detail-open-terminal"]')!.parentElement!;
      expect(cluster.className).toContain("flex-wrap");
      expect(cluster.className).toContain("min-w-0");
      expect(cluster.className).not.toContain("shrink-0");
      // 阶段步进条的最小宽由内容决定,不再写死 240px。
      const phase = header.querySelector('[data-testid="task-detail-phase"]')!;
      expect(phase.className).toContain("min-w-0");
      expect(phase.className).not.toMatch(/min-w-\[\d+px\]/u);
    } finally {
      setDetailOpenTerminal(undefined);
    }
  });

  it("overview answers 要做什么/进展到哪/卡在哪: hero for awaiting owner, warn rows for stuck causes, both vanish when empty", async () => {
    installBridge();
    // in_review ⇒ 需要人动手的 hero 块;无真正的阻塞 ⇒ 卡在哪整块不渲染(空了就消失)。
    await mount();
    const hero = byTestId("task-overview-hero");
    expect(hero.textContent).toContain("等你裁决");
    expect(document.querySelector('[data-testid="task-overview-stuck"]')).toBeNull();
    // 事件按天收束(§1.4):天分组 + 事件行,全部渲染。
    const timeline = byTestId("task-progress-timeline");
    expect(timeline.querySelector("[data-day]")?.textContent).toContain("1 条记录");
    expect(timeline.textContent).toContain("Review review-w3: approved");

    await cleanupMountedDetail();
    installBridge();
    await mount({
      task: {
        ...task,
        title: "Task 表达重做:补一版徽标",
        coordinationStatus: "active",
        gates: [
          { name: "local-check", ok: true },
          { name: "lint", ok: false, detail: "G05 rethrow required" },
        ],
        docs: [
          {
            path: "closeout.md",
            title: "收口报告",
            group: "收口",
            required: true,
            present: false,
            presence: "missing",
          },
        ],
        events: [
          {
            projectId: "repo-a",
            taskId: "task-w3",
            at: "2026-08-23T10:20:00.000Z",
            summary: "Review review-w3: approved",
          },
          { projectId: "repo-a", taskId: "task-w3", at: "2026-08-22T09:00:00.000Z", summary: "Execution submitted" },
        ],
      },
    });
    // active 未提交 ⇒ hero 消失;提交前的完成门/缺失文档是「完成前还需要」,
    // 不是卡点(rework-1 裁决)——卡在哪整块不渲染,完成门在收口页签逐门列出。
    expect(document.querySelector('[data-testid="task-overview-hero"]')).toBeNull();
    expect(document.querySelector('[data-testid="task-overview-stuck"]')).toBeNull();
    // 标题经 TitleText:冒号后的补充段染弱(§2.3)。
    const supplement = byTestId("task-detail-header").querySelector("h1 span")!;
    expect(supplement.className).toContain("text-text-faint");
    expect(supplement.textContent).toContain(":补一版徽标");
    // 两天两组,各自成组(收束),事件都在 DOM 里(完整渲染不分批)。
    const days = [...byTestId("task-progress-timeline").querySelectorAll("[data-day]")];
    expect(days.length).toBe(2);
    expect(days[0]?.textContent).toContain("Review review-w3: approved");
    expect(days[1]?.textContent).toContain("Execution submitted");
  });

  it("卡在哪只收真正的阻塞:submit 后未过的门才进,原因是人话不是机器码", async () => {
    installBridge();
    await mount({
      task: {
        ...task,
        coordinationStatus: "submitted",
        gates: [
          { name: "local-check", ok: true },
          { name: "ci", ok: false, status: "missing", detail: "current execution cut has no gate witness" },
          { name: "code-doc-reconciliation", ok: false, status: "missing", detail: "no submitted execution cut" },
        ],
      },
    });
    const stuck = byTestId("task-overview-stuck");
    // 已 submit ⇒ 未过的门是卡点;两行 bad 底色状态标签。
    expect(stuck.querySelectorAll('[data-status-tone="bad"]')).toHaveLength(2);
    expect(stuck.textContent).toContain("ci");
    // 原因映射成中文人话;机器 reason 码只在 title 提示里,不占一级位置。
    expect(stuck.textContent).toContain("本次提交还没有这道门的见证");
    expect(stuck.textContent).toContain("台账里还没有可评估的已提交执行切面");
    expect(stuck.textContent).not.toContain("no submitted execution cut");
    expect(stuck.querySelector('[title="no submitted execution cut"]')).not.toBeNull();

    await cleanupMountedDetail();
    installBridge();
    // blocked:依赖未完成与等人答复是卡点,原因来自 blockers。
    await mount({
      task: {
        ...task,
        coordinationStatus: "blocked",
        gates: [{ name: "local-check", ok: true }],
        blocking: "blocked",
        blockingLabel: "relations",
        blockers: [
          {
            relationId: "rel-dep",
            kind: "depends-on",
            sourceTaskId: "task-w3",
            targetTaskId: "task-upstream",
            rationale: "上游切片先合入",
          },
          {
            relationId: "rel-await",
            kind: "awaits",
            sourceTaskId: "task-w3",
            personId: "person-zeyu",
            askKind: "question",
            question: "走哪条路线?",
          },
        ],
      },
    });
    const blocked = byTestId("task-overview-stuck");
    expect(blocked.textContent).toContain("依赖未完成");
    expect(blocked.textContent).toContain("task-upstream");
    expect(blocked.textContent).toContain("上游切片先合入");
    expect(blocked.textContent).toContain("person-zeyu");
    expect(blocked.textContent).toContain("走哪条路线?");

    await cleanupMountedDetail();
    installBridge();
    // 打回待返工:上一轮 changes_requested、新一轮无人认领 ⇒ 待返工行;提交前的门不进。
    await mount({
      task: {
        ...task,
        coordinationStatus: "active",
        iteration: 1,
        gates: [{ name: "ci", ok: false, status: "missing", detail: "no submitted execution cut" }],
        executions: [
          {
            ...task.executions[0],
            state: "changes_requested",
            closedAt: "2026-08-23T11:00:00.000Z",
          },
        ],
      },
    });
    const rework = byTestId("task-overview-stuck");
    expect(rework.textContent).toContain("待返工");
    expect(rework.textContent).toContain("上一轮提交被打回");
    expect(rework.textContent).toContain("等待第 1 轮认领");
    expect(rework.textContent).not.toContain("门禁未过");
  });

  it("adapts the detail card and reader to container width; manual layout controls still override", async () => {
    installBridge();
    await mount();

    // 详情卡铺满可用宽度:不再有 max-w 居中收口;main 是容器量尺,断带挂在卡片网格上。
    const scrollPanel = byTestId("task-detail-panel-scroll");
    const card = scrollPanel.parentElement!;
    expect(card.className).not.toMatch(/max-w-|mx-auto/u);
    expect(card.className).toContain("grid-cols-1");
    expect(card.className).toContain("@min-[1100px]:grid-cols-[14rem_minmax(0,1fr)]");
    expect(scrollPanel.closest("main")?.className).toContain("@container");
    // 叠放带里文件树是 auto 行:量高 18rem 内部滚动,文件多的任务包不会挤死正文。
    expect(byTestId("task-document-tree").className).toContain("@max-[1100px]:max-h-72");

    // 概况是区域板(标准 §2.1):面板自己是板的容器量尺,板上每块都是 Region。
    expect(scrollPanel.className).toContain("@container");
    const overview = byTestId("task-overview-tab");
    const regions = [...overview.querySelectorAll<HTMLElement>("[data-region]")];
    expect(regions.map((region) => region.dataset.region)).toEqual(["mine", "plan", "progress"]);
    for (const region of regions) {
      const section = region.querySelector(":scope > section.glass")!;
      expect(section.querySelector("h2")).not.toBeNull();
      expect(section.children[1]!.firstElementChild!.className).toContain("overflow-y-auto");
    }
    // 没有散排:标题、行、按天进展、计划正文都在某个区域框里;旧的 aside 右栏已删除。
    for (const element of overview.querySelectorAll("h2, [data-dense-row], [data-day], .prose-harness"))
      expect(element.closest("section.glass")).not.toBeNull();
    expect(overview.querySelector("aside")).toBeNull();
    // 时间线是板上独立的最后一列,不混在主区里。
    const timeline = byTestId("task-progress-timeline");
    expect(timeline.parentElement).toBe(overview);
    expect(overview.lastElementChild).toBe(timeline);
    // 任务计划是整篇文档:占满主区剩余高度(不按「三条」量下限),正文带边距并在区内滚动。
    const plan = byTestId("task-overview-plan");
    expect(plan.className).toContain("@[900px]:flex-[1_1_100%]");
    expect(plan.style.minHeight).toBe("");
    expect(plan.querySelector("h2")?.textContent).toBe("任务计划");
    expect(plan.textContent).toContain("目标、验收与边界的完整原文");
    expect(plan.querySelector("section")!.children[1]!.firstElementChild!.className).toContain("px-3.5");
    expect(plan.querySelector(".prose-harness")).not.toBeNull();
    // 区域标题行不放动作:「去处理」在等你裁决的页脚。
    const hero = byTestId("task-overview-hero");
    const go = [...hero.querySelectorAll("button")].find((button) => button.textContent === "去处理")!;
    expect(go.closest("section")!.lastElementChild!.contains(go)).toBe(true);
    // 主内容外衬收窄:正文更早进入首屏。
    expect(scrollPanel.className).toContain("py-4");
    expect(scrollPanel.closest("main")?.className).toContain("py-2");

    // 阅读栏数默认「自适应」:容器查询驱动(styles.css 的 .doc-flow),无需点击。
    const toolbar = byTestId("reader-floating-toolbar");
    const layoutButton = (label: string) =>
      [...toolbar.querySelectorAll("button")].find((button) => button.textContent === label)!;
    expect(document.querySelector(".prose-harness")?.getAttribute("data-layout")).toBe("auto");
    expect(document.querySelector(".doc-flow")?.contains(document.querySelector(".prose-harness"))).toBe(true);

    // 单栏/双栏控件保留:手动选择覆盖自适应,并可切回。
    await act(async () => {
      layoutButton("双栏").click();
    });
    expect(layoutButton("双栏").getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector(".prose-harness")?.getAttribute("data-layout")).toBe("double");
    await act(async () => {
      layoutButton("单栏").click();
    });
    expect(document.querySelector(".prose-harness")?.getAttribute("data-layout")).toBe("single");
    await act(async () => {
      layoutButton("自适应").click();
    });
    expect(document.querySelector(".prose-harness")?.getAttribute("data-layout")).toBe("auto");

    const font = toolbar.querySelector("select")!;
    await act(async () => {
      font.value = "serif";
      font.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(document.querySelector(".prose-harness")?.getAttribute("data-font")).toBe("serif");

    const reports = [...byTestId("task-document-tree").querySelectorAll("button")].find((button) =>
      button.textContent?.includes("reports/"),
    )!;
    expect(reports).toBeInstanceOf(HTMLButtonElement);
    await act(async () => {
      reports.click();
    });
    const html = [...byTestId("task-document-tree").querySelectorAll("button")].find((button) =>
      button.textContent?.includes("night.html"),
    )!;
    expect(html).toBeInstanceOf(HTMLButtonElement);
    await act(async () => {
      html.click();
    });
    await flushEffects();

    expect(document.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain("文件");
    expect(reports.getAttribute("aria-expanded")).toBe("true");
    const preview = byTestId("html-artifact-preview");
    expect(preview.textContent).toContain("脚本 / 外联已禁用");
    const webview = byTestId("html-artifact-webview");
    expect(webview.getAttribute("partition")).toBe("html-artifact-preview");
    expect(webview.getAttribute("preload")).toBeNull();
    expect(webview.getAttribute("src")).toMatch(/^data:text\/html;charset=utf-8,/u);
    // 非 fill 布局:host 必须是定高(h-[42rem]),webview 的 height:100% 才有可解析的
    // 百分比基准;只给 min-height 时 webview 会落回 150px 默认高(task_419dc330)。
    const host = byTestId("html-artifact-host");
    expect(host.classList.contains("h-[42rem]")).toBe(true);
    expect(webview.classList.contains("html-artifact-webview")).toBe(true);
  });
});
