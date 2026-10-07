// harness-test-tier: fast
// @vitest-environment happy-dom
import { act } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentRuntimeOverviewResult } from "@harness-anything/daemon/protocol";
import type { TaskWipRead } from "../../src/api/renderer-dto.ts";
import {
  AT,
  setupOverviewBoardEnvironment,
  mountOverview as mount,
  textOf,
  flushUntil,
  unmountOverview as unmount,
} from "./overview-board.fixtures.ts";

/**
 * 总览左列(task_8a83698)的行为面:在飞任务流(repo.tasks.wip 的 active/submitted/
 * in_review 三态平铺,执行者来自 runtime overview 的 live 会话,blocked 住「跟进与
 * 返工」)与最新 HTML 产物速览架(repo.artifacts.list,与产物页同一缓存;外跳走
 * openArtifactExternally 的 preload 通道;2026-10-07 起行点击弹产物详情层原地预览,
 * 不离开总览)。阴性对照:三态全空与无产物都是整洁空态。
 */

beforeAll(() => {
  setupOverviewBoardEnvironment();
});

describe("总览:左列在飞任务流与最新产物速览架(task_8a83698)", () => {
  type WipEntry = TaskWipRead["counted"][number];

  const inflightWip = (counted: readonly WipEntry[]): TaskWipRead =>
    ({
      ok: true,
      limit: 30,
      limitLabel: "settings.tasks.wipLimit",
      counted: [...counted],
      roots: [],
      threshold: 3,
    }) as TaskWipRead;

  /** 在飞三态 + 一个 blocked:blocked 是注意力状态,必须留在「跟进与返工」,不进流。 */
  const inflightCounted = (): WipEntry[] => [
    { taskId: "task_inf_active", status: "active", title: "在飞任务·活跃" },
    { taskId: "task_inf_submitted", status: "submitted", title: "在飞任务·已提交" },
    { taskId: "task_inf_review", status: "in_review", title: "在飞任务·评审中" },
    { taskId: "task_inf_blocked", status: "blocked", title: "占位任务·被阻塞" },
  ];

  const runtimeWithSession = (): AgentRuntimeOverviewResult =>
    ({
      ok: true,
      status: "ready",
      installations: [],
      instances: [],
      sessions: [
        {
          runtimeSessionId: "rs_inf",
          kindId: "codex",
          liveness: "live",
          definitionSnapshot: { model: "glm-5.3" },
          associations: [{ taskId: "task_inf_active" }],
          activity: { lastObservedAt: AT },
        },
      ],
      watermark: 7,
      sourceRevision: 7,
    }) as unknown as AgentRuntimeOverviewResult;

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
    wip?: TaskWipRead;
    runtime?: AgentRuntimeOverviewResult;
    listArtifacts?: () => unknown;
    openExternal?: (input: unknown) => Promise<unknown>;
  }): () => void {
    const previous = (globalThis as { harness?: unknown }).harness;
    vi.stubGlobal("harness", {
      request: (method: string) =>
        method === "getTaskWip" && handlers.wip !== undefined
          ? Promise.resolve(handlers.wip)
          : method === "getAgentRuntimeOverview" && handlers.runtime !== undefined
            ? Promise.resolve(handlers.runtime)
            : Promise.reject(new Error("no bridge in test")),
      ...(handlers.listArtifacts !== undefined ? { listArtifacts: handlers.listArtifacts } : {}),
      artifacts: { openExternal: handlers.openExternal ?? (async () => ({})) },
    });
    return () => vi.stubGlobal("harness", previous);
  }

  it("在飞任务流平铺三态占位:blocked 不进流,执行者与无会话如实分两行可读", async () => {
    const onOpenTask = vi.fn();
    const restore = stubShelfBridge({ wip: inflightWip(inflightCounted()), runtime: runtimeWithSession() });
    const container = mount({ onOpenTask });
    await flushUntil(() => container.querySelector('[data-testid="overview-inflight"]') !== null);
    const region = container.querySelector('[data-testid="overview-region-inflight"]')!;
    const text = textOf(region);
    expect(text).toContain("在飞任务·活跃");
    expect(text).toContain("在飞任务·已提交");
    expect(text).toContain("在飞任务·评审中");
    // blocked 住「跟进与返工」,不在飞流里重复占行。
    expect(text).not.toContain("占位任务·被阻塞");
    // 有 live 会话的行给执行者;没有的如实标注,不造执行者。
    expect(text).toContain("codex · glm-5.3");
    expect(text).toContain("在飞任务无 agent 在跑");
    // 左列是窄流:行体取 relaxed 两行档(标题一行、执行者弱色第二行),单行档会把
    // 执行者挤成「agen…」式截断。两行档的标题与原因各占一个 block 行。
    for (const row of region.querySelectorAll("[data-inflight-task]")) {
      const lines = [...row.querySelectorAll("span")].filter((span) => span.classList.contains("block"));
      expect(lines.length).toBeGreaterThanOrEqual(2);
    }
    const firstRow = region.querySelector('[data-inflight-task="task_inf_active"]')!;
    act(() => (firstRow.querySelector("button") as HTMLButtonElement).click());
    expect(onOpenTask).toHaveBeenCalledWith("task_inf_active");
    unmount();
    restore();
  });

  it("在飞任务流阴性对照:三态全空时给整洁空态,不是破壳或空白", async () => {
    const restore = stubShelfBridge({
      wip: inflightWip([{ taskId: "task_inf_blocked", status: "blocked", title: "占位任务·被阻塞" } as WipEntry]),
    });
    const container = mount();
    await flushUntil(() => container.querySelector('[data-testid="overview-inflight-empty"]') !== null);
    expect(textOf(container.querySelector('[data-testid="overview-inflight-empty"]'))).toContain(
      "没有在飞任务:active/submitted/in_review 均无占位。",
    );
    unmount();
    restore();
  });

  it("在飞任务流读面失败:错误条如实给失败信息,不冒充空态", async () => {
    const container = mount();
    await flushUntil(() => container.querySelector('[data-testid="overview-inflight-error"]') !== null);
    expect(textOf(container.querySelector('[data-testid="overview-inflight-error"]'))).toContain(
      "在飞任务读取失败(不是空)",
    );
    unmount();
  });

  it("产物速览架铺最新 HTML 产物:限 6 条、页脚计数、外跳走 IPC、行点击弹详情层", async () => {
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
    // 速览架只裁条数不重排:前 6 条在架、其余走产物页;页脚计数同源。
    expect(region.querySelectorAll("[data-shelf-artifact]")).toHaveLength(6);
    expect(textOf(region)).toContain("最新 6/9 件 HTML 产物");
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
    // 行点击不再离开总览:弹产物详情层,左列表是全部产物行(不止架上的 6 条),
    // 右栏「跳到所属 task」保留 task_15b1bb96 的落点(任务页直接选中该产物文档)。
    act(() => (region.querySelector("[data-shelf-artifact]")!.querySelector("button") as HTMLButtonElement).click());
    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(textOf(dialog)).toContain("最新产物");
    expect(dialog!.querySelectorAll("[data-focus-list] [data-dense-row]")).toHaveLength(8);
    expect(textOf(dialog)).toContain("overflow-6.html");
    const detail = dialog!.querySelector('[data-testid="overview-artifact-detail"]')!;
    expect(textOf(detail)).toContain("report-0.html");
    expect(textOf(detail)).toContain("产物所属工作");
    act(() =>
      (detail.querySelector('[data-testid="overview-artifact-detail-open-task"]') as HTMLButtonElement).click(),
    );
    expect(onOpenTask).toHaveBeenCalledWith("task_art_owner", "artifacts/reports/report-0.html");
    unmount();
    restore();
  });

  it("产物速览架阴性对照:无 HTML 产物给空态提示与产物页入口", async () => {
    const onOpenArtifacts = vi.fn();
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
    const container = mount({ onOpenArtifacts });
    await flushUntil(
      () =>
        container
          .querySelector('[data-testid="overview-artifacts-empty"]')
          ?.textContent?.includes("还没有 HTML 产物") === true,
    );
    const region = container.querySelector('[data-testid="overview-region-artifacts"]')!;
    expect(textOf(container.querySelector('[data-testid="overview-artifacts-empty"]'))).toContain(
      "还没有 HTML 产物:任务交付的报告会出现在这里。",
    );
    act(() => (region.querySelector('[data-testid="overview-artifacts-open-all"]') as HTMLButtonElement).click());
    expect(onOpenArtifacts).toHaveBeenCalledTimes(1);
    unmount();
    restore();
  });
});
