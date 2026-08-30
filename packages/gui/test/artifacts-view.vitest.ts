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
    // 全路径进抽屉行与预览头的 title(抽屉行宽度有限,不与文件名抢正文)。
    expect(
      container
        .querySelector<HTMLElement>('[data-testid="artifact-row-task_weathering-artifacts/reports/weathering.html"]')
        ?.getAttribute("title"),
    ).toBe("tasks/task_weathering-slug/artifacts/reports/weathering.html");
    // 相对时间是主显;绝对时间与时间来源(ledger)进 tooltip。
    expect(text).not.toMatch(/2026-08-28 \d{2}:\d{2}/u);
    const rowTime = container.querySelector<HTMLElement>(
      '[data-testid="artifact-row-task_weathering-artifacts/reports/weathering.html"] [title*="2026-08-28"]',
    );
    expect(rowTime?.getAttribute("title")).toContain("ledger");
    expect(container.querySelector('[data-testid="artifacts-timeline"]')).not.toBeNull();
    // 两种 kind 的计数都来自 daemon DTO,筛选 chip 展示全量计数而非本页行数。
    expect(text).toContain("HTML · 2");
    expect(text).toContain("Markdown · 5729");
  });

  it("lays out as a left drawer plus full-width preview on one row axis, never a stacked split", async () => {
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
    const row = container.querySelector<HTMLElement>('[data-testid="artifacts-drawer-row"]');
    expect(row).not.toBeNull();
    expect(row?.classList.contains("flex-row")).toBe(true);
    expect(row?.classList.contains("flex-col")).toBe(false);
    // 预览吃剩余宽度与整高:flex-1 且不是定宽。
    const preview = container.querySelector<HTMLElement>('[data-testid="artifact-preview-pane"]');
    expect(preview?.classList.contains("flex-1")).toBe(true);
    expect(preview?.className).not.toMatch(/w-\[/u);
    const drawer = container.querySelector<HTMLElement>('[data-testid="artifacts-drawer"]');
    expect(drawer).not.toBeNull();
    expect(drawer?.style.width).toBe("420px");
    expect(container.querySelector('[data-testid="artifacts-drawer-resize"]')).not.toBeNull();
  });

  it("collapses the drawer to a rail and restores it, remembering the state in localStorage", async () => {
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
    await click(container, "artifacts-drawer-collapse");
    expect(container.querySelector('[data-testid="artifacts-drawer"]')).toBeNull();
    expect(container.querySelector('[data-testid="artifact-preview-pane"]')).not.toBeNull();
    expect(JSON.parse(window.localStorage.getItem("harness:gui:artifacts-drawer") ?? "null")).toEqual({
      width: 420,
      collapsed: true,
    });
    await click(container, "artifacts-drawer-expand");
    expect(container.querySelector('[data-testid="artifacts-drawer"]')).not.toBeNull();
    expect(JSON.parse(window.localStorage.getItem("harness:gui:artifacts-drawer") ?? "null")).toEqual({
      width: 420,
      collapsed: false,
    });
  });

  it("asks the preload artifacts channel to open the selected artifact in the system viewer", async () => {
    stubDocumentBridge("<h1>Weathering</h1>");
    const openExternal = vi.fn(async () => ({ ok: true, openedPath: "/repo/harness/tasks/p/a.html", error: null }));
    vi.stubGlobal("window", { harness: { getTaskDocument: async () => ({ ok: true }), artifacts: { openExternal } } });
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
    await click(container, "artifact-open-external");
    expect(openExternal).toHaveBeenCalledWith({
      repoId: "repo-a",
      path: "tasks/task_weathering-slug/artifacts/reports/weathering.html",
    });
  });

  it("surfaces an open failure inline instead of throwing into the renderer", async () => {
    stubDocumentBridge("<h1>Weathering</h1>");
    const openExternal = vi.fn(async () => {
      throw new Error("Artifact path escapes the repository harness directory.");
    });
    vi.stubGlobal("window", { harness: { getTaskDocument: async () => ({ ok: true }), artifacts: { openExternal } } });
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
    await click(container, "artifact-open-external");
    expect(container.querySelector('[data-testid="artifact-open-external-error"]')?.textContent).toContain(
      "escapes the repository harness directory",
    );
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

  it("jumps to the owning task from the task, path, and preview header links", async () => {
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
    // 左抽屉的行不再带独立的路径链接(路径进 title,预览头仍显示全路径):
    // 跳任务的两条出口是抽屉行与预览头。
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
    // 时间来源是 daemon 事实:mtime 的行把它显形在正文里,ledger 的留在 tooltip。
    expect(container.textContent).toContain("file mtime");
    // 投影无归属 task:不渲染跳转,时间来源仍标明。
    expect(container.querySelector('[data-testid="artifact-task-null"]')).toBeNull();
  });
});
