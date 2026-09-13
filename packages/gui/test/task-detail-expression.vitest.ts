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

    // 概况:时间线并入分区/右侧 inspector,不再独占整列。
    const overview = byTestId("task-overview-tab");
    expect(overview.className).toContain("@min-[1600px]:grid-cols-[minmax(0,1fr)_19rem]");
    expect(byTestId("task-progress-timeline").closest("aside")).toBe(overview.querySelector("aside"));
    // 密度(task_9f39e256):分区标题(eyebrow/标题/描述)压成单行 inline 条,信息不删。
    const heading = byTestId("task-section-heading");
    expect(heading.className).toContain("items-baseline");
    expect(heading.textContent).toContain("PLAN");
    expect(heading.textContent).toContain("任务计划");
    expect(heading.textContent).toContain("目标、验收与边界的完整原文");
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
