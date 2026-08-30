// harness-test-tier: integration
// @vitest-environment happy-dom
import { beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ArtifactsWorkspace } from "../src/renderer/views/ArtifactsView.tsx";
import type { ArtifactGuiRowDto, ArtifactsListResult } from "../../daemon/src/protocol/artifacts-gui-contract.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";

beforeAll(() => {
  setActiveLocale("en-US");
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => vi.restoreAllMocks());

const mounted: { root: Root; container: HTMLElement }[] = [];

function row(overrides: Partial<ArtifactGuiRowDto> = {}): ArtifactGuiRowDto {
  return {
    taskId: "task_weathering",
    taskTitle: "Weathering escalation",
    packagePath: "tasks/task_weathering-slug",
    path: "artifacts/reports/weathering.html",
    kind: "html",
    time: "2026-08-28T10:00:00.000Z",
    timeSource: "ledger",
    ...overrides,
  };
}

function dto(overrides: Partial<ArtifactsListResult> = {}): ArtifactsListResult {
  return {
    ok: true,
    status: "ready",
    repoId: "repo-a",
    kind: "html",
    artifacts: [row()],
    counts: { html: 2, md: 5729 },
    watermark: 12,
    sourceRevision: 12,
    ...overrides,
  };
}

const noop = () => undefined;

async function renderSurface(element: ReturnType<typeof createElement>): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client: new QueryClient() }, element));
  });
  mounted.push({ root, container });
  return container;
}

afterEach(async () => {
  for (const { root } of mounted.splice(0)) await act(async () => root.unmount());
  document.body.innerHTML = "";
});

async function click(container: HTMLElement, testId: string): Promise<void> {
  const target = container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
  if (target === null) throw new Error(`missing ${testId}`);
  await act(async () => {
    target.click();
  });
}

/** react-query 的文档读取是异步状态更新:让微任务与一次渲染 tick 落定后再断言。 */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

function stubDocumentBridge(body: string, kind: "html" | "committed" = "html"): ReturnType<typeof vi.fn> {
  const getTaskDocument = vi.fn(async () => ({
    ok: true,
    status: "ready",
    taskId: "task_weathering",
    path: "artifacts/reports/weathering.html",
    body: kind === "html" ? body : "# Committed body\n",
    blobSha256: "sha256:committed",
    worktreeBody: kind === "html" ? null : body,
    uncommitted: kind === "committed" ? false : false,
    watermark: 12,
    sourceRevision: 12,
  }));
  vi.stubGlobal("window", { harness: { getTaskDocument } });
  return getTaskDocument;
}

describe("artifacts timeline — list, preview, and task jump", () => {
  it("renders the daemon DTO as a time-desc timeline with the time source labeled", async () => {
    const container = await renderSurface(
      createElement(ArtifactsWorkspace, {
        repoId: "repo-a",
        data: dto(),
        pending: false,
        kind: "html",
        onKindChange: noop,
        onNavigateTask: noop,
      }),
    );
    const text = container.textContent ?? "";
    expect(text).toContain("weathering.html");
    expect(text).toContain("Weathering escalation");
    expect(text).toContain("tasks/task_weathering-slug/artifacts/reports/weathering.html");
    expect(text).toContain("ledger");
    expect(text).toMatch(/2026-08-28 \d{2}:\d{2}/u);
    expect(container.querySelector('[data-testid="artifacts-timeline"]')).not.toBeNull();
    // 两种 kind 的计数都来自 daemon DTO,筛选 chip 展示全量计数而非本页行数。
    expect(text).toContain("HTML · 2");
    expect(text).toContain("Markdown · 5729");
  });

  it("previews a selected HTML artifact through the isolated webview path", async () => {
    const getTaskDocument = stubDocumentBridge("<h1>Weathering escalation</h1>");
    const container = await renderSurface(
      createElement(ArtifactsWorkspace, {
        repoId: "repo-a",
        data: dto(),
        pending: false,
        kind: "html",
        onKindChange: noop,
        onNavigateTask: noop,
      }),
    );
    await click(container, "artifact-focus-task_weathering-artifacts/reports/weathering.html");
    await settle();
    expect(getTaskDocument).toHaveBeenCalledWith({
      repoId: "repo-a",
      taskId: "task_weathering",
      path: "artifacts/reports/weathering.html",
    });
    expect(container.querySelector('[data-testid="html-artifact-preview"]')).not.toBeNull();
    // webview 安全属性来自 HtmlArtifactPreview 常量,不得放宽(sandbox/javascript 仍禁)。
    const webview = container.querySelector('[data-testid="html-artifact-webview"]');
    expect(webview?.getAttribute("webpreferences")).toContain("sandbox=yes");
    expect(webview?.getAttribute("webpreferences")).toContain("javascript=no");
    expect(String(webview?.getAttribute("src")).startsWith("data:text/html;charset=utf-8,")).toBe(true);
  });

  it("renders a Markdown artifact with the shared markdown reader, not a webview", async () => {
    stubDocumentBridge("# Markdown report\n\nBody.");
    const markdown = row({ path: "artifacts/report.md", kind: "md" });
    const container = await renderSurface(
      createElement(ArtifactsWorkspace, {
        repoId: "repo-a",
        data: dto({ kind: "md", artifacts: [markdown], counts: { html: 2, md: 1 } }),
        pending: false,
        kind: "md",
        onKindChange: noop,
        onNavigateTask: noop,
      }),
    );
    await click(container, "artifact-focus-task_weathering-artifacts/report.md");
    await settle();
    expect(container.querySelector('[data-testid="html-artifact-webview"]')).toBeNull();
    expect(container.textContent).toContain("Markdown report");
  });

  it("jumps to the owning task from the row and the preview header", async () => {
    stubDocumentBridge("<h1>Weathering</h1>");
    const onNavigateTask = vi.fn();
    const container = await renderSurface(
      createElement(ArtifactsWorkspace, {
        repoId: "repo-a",
        data: dto(),
        pending: false,
        kind: "html",
        onKindChange: noop,
        onNavigateTask,
      }),
    );
    await click(container, "artifact-task-task_weathering");
    await click(container, "artifact-focus-task_weathering-artifacts/reports/weathering.html");
    await settle();
    await click(container, "artifact-open-task");
    expect(onNavigateTask).toHaveBeenCalledWith("task_weathering");
    expect(onNavigateTask).toHaveBeenCalledTimes(2);
  });

  it("switches the kind facet through the filter, and an unmapped row keeps no task link", async () => {
    const onKindChange = vi.fn();
    const container = await renderSurface(
      createElement(ArtifactsWorkspace, {
        repoId: "repo-a",
        data: dto({
          artifacts: [row({ taskId: null, taskTitle: null, packagePath: null, timeSource: "mtime" })],
        }),
        pending: false,
        kind: "html",
        onKindChange,
        onNavigateTask: noop,
      }),
    );
    await click(container, "artifacts-filter-md");
    expect(onKindChange).toHaveBeenCalledWith("md");
    expect(container.textContent).toContain("file mtime");
    // 投影无归属 task:不渲染跳转,时间来源仍标明。
    expect(container.querySelector('[data-testid="artifact-task-null"]')).toBeNull();
  });
});
