// harness-test-tier: fast
// @vitest-environment happy-dom
import { act } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentRuntimeOverviewResult } from "@harness-anything/daemon/protocol";
import {
  AT,
  setupOverviewBoardEnvironment,
  mountOverview as mount,
  historyOf,
  textOf,
  flushUntil,
  unmountOverview as unmount,
} from "./overview-board.fixtures.ts";

/**
 * 总览左列最新 HTML 产物速览架(task_8a83698;2026-10-11 业主意见 1)的行为面:速览架
 * 限 6 条、外跳走 openArtifactExternally 的 preload 通道;行点击或「查看全部产物」进
 * 产物二级页——接近全屏、左窄列表(全部产物行)、右大预览默认选中最新(或被点的那
 * 条),「跳到所属 task」保留 task_15b1bb96 的落点。阴性对照:无产物给整洁空态。
 */

beforeAll(() => {
  setupOverviewBoardEnvironment();
});

describe("总览:最新产物速览架与产物二级页", () => {
  interface ArtifactRow {
    readonly taskId: string | null;
    readonly taskTitle: string | null;
    readonly packagePath: string | null;
    readonly path: string;
  }

  const artifactRow = (overrides: Partial<ArtifactRow> & { path: string }): ArtifactRow => ({
    taskId: "task_art_owner",
    taskTitle: "产物所属工作",
    packagePath: "tasks/task_art_owner-slug",
    ...overrides,
  });

  /** 桥接复刻产物页同一契约:listArtifacts 是 harness 直挂方法,openExternal 在 artifacts 命名空间下。 */
  function stubShelfBridge(handlers: {
    runtime?: AgentRuntimeOverviewResult;
    listArtifacts?: () => unknown;
    openExternal?: (input: unknown) => Promise<unknown>;
  }): () => void {
    const previous = (globalThis as { harness?: unknown }).harness;
    vi.stubGlobal("harness", {
      request: (method: string) =>
        method === "getAgentRuntimeOverview" && handlers.runtime !== undefined
          ? Promise.resolve(handlers.runtime)
          : Promise.reject(new Error("no bridge in test")),
      ...(handlers.listArtifacts !== undefined ? { listArtifacts: handlers.listArtifacts } : {}),
      artifacts: { openExternal: handlers.openExternal ?? (async () => ({})) },
    });
    return () => vi.stubGlobal("harness", previous);
  }

  it("产物速览架铺最新 HTML 产物:限 6 条、计数并进标题小字、外跳走 IPC、行点击进二级页", async () => {
    const onOpenTask = vi.fn();
    const openExternal = vi.fn(async () => ({ ok: true, openedPath: "/tmp/materialized.html", error: null }));
    const rows: ArtifactRow[] = [
      ...Array.from({ length: 5 }, (_, index) => artifactRow({ path: `artifacts/reports/report-${index}.html` })),
      artifactRow({ taskId: "task_unmapped", packagePath: null, path: "artifacts/reports/unmapped.html" }),
      artifactRow({ path: "artifacts/reports/overflow-6.html" }),
      artifactRow({ taskId: null, taskTitle: null, path: "artifacts/reports/taskless.html" }),
    ];
    const restore = stubShelfBridge({
      listArtifacts: async () => ({
        ok: true,
        status: "ready",
        repoId: "probe-repo",
        kind: "html",
        artifacts: rows.map((row) => ({
          taskId: row.taskId,
          taskTitle: row.taskTitle,
          packagePath: row.packagePath,
          path: row.path,
          kind: "html",
          mediaType: "text/html",
          sizeBytes: 128,
          time: AT,
          timeSource: "ledger",
        })),
        counts: { html: 9, md: 5729, raw: 3 },
        watermark: 12,
        sourceRevision: 12,
      }),
      openExternal,
    });
    const container = mount({ onOpenTask });
    await flushUntil(
      () =>
        container.querySelector('[data-testid="overview-region-artifacts"]')?.textContent?.includes("report-0") ===
        true,
    );
    const region = container.querySelector('[data-testid="overview-region-artifacts"]')!;
    // 速览架只裁条数不重排:前 6 条在架;计数并进标题小字(意见 2:不再单独占大号数字位)。
    expect(region.querySelectorAll("[data-shelf-artifact]")).toHaveLength(6);
    expect(textOf(region)).toContain("最新 6/9 件 HTML 产物");
    expect(textOf(region)).toContain("共 9 件");
    expect(textOf(region)).toContain("report-0.html");
    expect(textOf(region)).not.toContain("overflow-6.html");
    expect(textOf(region)).not.toContain("taskless.html");
    // 外跳按钮走 openArtifactExternally 的 preload 通道,参数是 repo 相对路径与归属任务。
    act(() =>
      (region.querySelector('[data-testid="overview-artifact-open-task_art_owner"]') as HTMLButtonElement).click(),
    );
    await flushUntil(() => openExternal.mock.calls.length > 0);
    expect(openExternal).toHaveBeenCalledWith({
      repoId: "probe-repo",
      path: "tasks/task_art_owner-slug/artifacts/reports/report-0.html",
      taskId: "task_art_owner",
    });
    // 未映射产物(packagePath 缺失)的外跳按钮如实禁用,不给一个必失败的按钮。
    const unmapped = region.querySelector<HTMLButtonElement>('[data-testid="overview-artifact-open-task_unmapped"]');
    expect(unmapped).not.toBeNull();
    expect(unmapped!.disabled).toBe(true);
    // 行点击进产物二级页(意见 1):接近全屏的 dialog,左窄列表是全部产物行(不止架上
    // 的 6 条),右大预览直接选中被点的这条;「跳到所属 task」保留任务页落点。
    act(() => (region.querySelector("[data-shelf-artifact]")!.querySelector("button") as HTMLButtonElement).click());
    const page = document.body.querySelector('[data-testid="overview-artifacts-page"]');
    expect(page).not.toBeNull();
    expect(page!.getAttribute("role")).toBe("dialog");
    expect(page!.querySelectorAll('[data-testid="overview-artifacts-page-list"] [data-dense-row]')).toHaveLength(8);
    expect(textOf(page)).toContain("overflow-6.html");
    const detail = page!.querySelector('[data-testid="overview-artifact-detail"]')!;
    expect(textOf(detail)).toContain("report-0.html");
    expect(textOf(detail)).toContain("产物所属工作");
    act(() =>
      (detail.querySelector('[data-testid="overview-artifact-detail-open-task"]') as HTMLButtonElement).click(),
    );
    expect(onOpenTask).toHaveBeenCalledWith("task_art_owner", "artifacts/reports/report-0.html");
    unmount();
    restore();
  });

  it("「查看全部产物」默认选中最新一条;Esc 收起;↑↓ 在列表内换预览", async () => {
    const rows = Array.from({ length: 3 }, (_, index) => artifactRow({ path: `artifacts/reports/r-${index}.html` }));
    const restore = stubShelfBridge({
      listArtifacts: async () => ({
        ok: true,
        status: "ready",
        repoId: "probe-repo",
        kind: "html",
        artifacts: rows.map((row) => ({
          taskId: row.taskId,
          taskTitle: row.taskTitle,
          packagePath: row.packagePath,
          path: row.path,
          kind: "html",
          mediaType: "text/html",
          sizeBytes: 128,
          time: AT,
          timeSource: "ledger",
        })),
        counts: { html: 3, md: 0, raw: 0 },
        watermark: 12,
        sourceRevision: 12,
      }),
    });
    const container = mount();
    await flushUntil(
      () =>
        container.querySelector('[data-testid="overview-region-artifacts"]')?.textContent?.includes("r-0.html") ===
        true,
    );
    act(() => (container.querySelector('[data-testid="overview-artifacts-open-all"]') as HTMLButtonElement).click());
    const page = document.body.querySelector('[data-testid="overview-artifacts-page"]')!;
    // 默认直接选中并展示最新一个产物(daemon 倒序首行),不是又一个待选的列表。
    expect(textOf(page.querySelector('[data-testid="overview-artifact-detail"]'))).toContain("r-0.html");
    expect(
      page.querySelector('[data-testid="overview-artifacts-page-list"] [data-dense-row][data-selected]')!.textContent,
    ).toContain("r-0.html");
    // ↑↓ 在列表内移动选中,右栏跟着换预览。
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    });
    expect(textOf(page.querySelector('[data-testid="overview-artifact-detail"]'))).toContain("r-1.html");
    // Esc 收起二级页。
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(document.body.querySelector('[data-testid="overview-artifacts-page"]')).toBeNull();
    unmount();
    restore();
  });

  it("产物速览架阴性对照:无 HTML 产物给空态提示,「查看全部」开二级页如实给空列表", async () => {
    const restore = stubShelfBridge({
      listArtifacts: async () => ({
        ok: true,
        status: "ready",
        repoId: "probe-repo",
        kind: "html",
        artifacts: [],
        counts: { html: 0, md: 5729, raw: 3 },
        watermark: 12,
        sourceRevision: 12,
      }),
    });
    const container = mount();
    await flushUntil(
      () =>
        container
          .querySelector('[data-testid="overview-artifacts-empty"]')
          ?.textContent?.includes("还没有 HTML 产物") === true,
    );
    expect(textOf(container.querySelector('[data-testid="overview-artifacts-empty"]'))).toContain(
      "还没有 HTML 产物:任务交付的报告会出现在这里。",
    );
    act(() => (container.querySelector('[data-testid="overview-artifacts-open-all"]') as HTMLButtonElement).click());
    const page = document.body.querySelector('[data-testid="overview-artifacts-page"]')!;
    expect(textOf(page)).toContain("共 0 件");
    expect(textOf(page)).toContain("还没有 HTML 产物");
    unmount();
    restore();
  });

  it("产物二级页走全局历史:开页推栈,页内换选中原地改,后退收页前进原路返回", async () => {
    // 业主 2026-10-11 全局导航返工:二级页不再各持 useState,层位置进 AppLocation——
    // 与「进行中的任务」下钻放大层同一条推栈路径,Esc/X 收页即弹栈。
    const rows = Array.from({ length: 3 }, (_, index) => artifactRow({ path: `artifacts/reports/h-${index}.html` }));
    const restore = stubShelfBridge({
      listArtifacts: async () => ({
        ok: true,
        status: "ready",
        repoId: "probe-repo",
        kind: "html",
        artifacts: rows.map((row) => ({
          taskId: row.taskId,
          taskTitle: row.taskTitle,
          packagePath: row.packagePath,
          path: row.path,
          kind: "html",
          mediaType: "text/html",
          sizeBytes: 128,
          time: AT,
          timeSource: "ledger",
        })),
        counts: { html: 3, md: 0, raw: 0 },
        watermark: 12,
        sourceRevision: 12,
      }),
    });
    const container = mount();
    // 二级页挂在 document.body:断言中途失败也要卸载,泄出去会顶掉下一例的页查询。
    try {
      await flushUntil(
        () =>
          container.querySelector('[data-testid="overview-region-artifacts"]')?.textContent?.includes("h-0.html") ===
          true,
      );
      expect(historyOf().location.overviewArtifactId ?? null).toBeNull();
      // 点速览架行开页 = 推栈:被点行键进位置。
      act(() =>
        (container.querySelector("[data-shelf-artifact]")!.querySelector("button") as HTMLButtonElement).click(),
      );
      expect(historyOf().location.overviewArtifactId).toBe("task_art_owner/artifacts/reports/h-0.html");
      expect(historyOf().canBack).toBe(true);
      // 页内点列表换预览是原地精修:后退必须直接回总览(页关掉),而不是上一个产物。
      // (列表行无 action,DenseRow 整行即 button。)
      const other = document.body.querySelector(
        '[data-testid="overview-artifacts-page-list"] [data-dense-row]:not([data-selected])',
      )! as HTMLButtonElement;
      act(() => other.click());
      expect(historyOf().location.overviewArtifactId).toBe("task_art_owner/artifacts/reports/h-1.html");
      // Esc 收页 = 弹栈:位置回到无层的总览;前进原路返回,页与最后选中的产物一起还原。
      act(() => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      });
      expect(historyOf().location.overviewArtifactId ?? null).toBeNull();
      expect(document.body.querySelector('[data-testid="overview-artifacts-page"]')).toBeNull();
      act(() => historyOf().forward());
      expect(historyOf().location.overviewArtifactId).toBe("task_art_owner/artifacts/reports/h-1.html");
      expect(textOf(document.body.querySelector('[data-testid="overview-artifact-detail"]'))).toContain("h-1.html");
    } finally {
      unmount();
      restore();
    }
  });

  it("产物页「跳到所属 task」推栈后,后退回到带着产物页的总览位置", async () => {
    const rows = [artifactRow({ path: "artifacts/reports/back.html" })];
    const onOpenTask = vi.fn();
    const restore = stubShelfBridge({
      listArtifacts: async () => ({
        ok: true,
        status: "ready",
        repoId: "probe-repo",
        kind: "html",
        artifacts: rows.map((row) => ({
          taskId: row.taskId,
          taskTitle: row.taskTitle,
          packagePath: row.packagePath,
          path: row.path,
          kind: "html",
          mediaType: "text/html",
          sizeBytes: 128,
          time: AT,
          timeSource: "ledger",
        })),
        counts: { html: 1, md: 0, raw: 0 },
        watermark: 12,
        sourceRevision: 12,
      }),
    });
    const container = mount({ onOpenTask });
    try {
      await flushUntil(
        () =>
          container.querySelector('[data-testid="overview-region-artifacts"]')?.textContent?.includes("back.html") ===
          true,
      );
      act(() =>
        (container.querySelector("[data-shelf-artifact]")!.querySelector("button") as HTMLButtonElement).click(),
      );
      const page = document.body.querySelector('[data-testid="overview-artifacts-page"]')!;
      // 跳任务走 App 的实体导航(真实 App 里推栈);夹具里回调被记录,位置留在产物页条目。
      act(() =>
        (page.querySelector('[data-testid="overview-artifact-detail-open-task"]') as HTMLButtonElement).click(),
      );
      expect(onOpenTask).toHaveBeenCalledWith("task_art_owner", "artifacts/reports/back.html");
      // 产物页条目仍带着层位置:真实 App 后退即回到产物页(此处直接断言位置未被动过)。
      expect(historyOf().location.overviewArtifactId).toBe("task_art_owner/artifacts/reports/back.html");
    } finally {
      unmount();
      restore();
    }
  });
});
