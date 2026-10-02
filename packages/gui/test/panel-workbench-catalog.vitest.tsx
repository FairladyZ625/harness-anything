// harness-test-tier: fast
// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PanelWorkbenchView } from "../src/renderer/views/PanelWorkbenchView.tsx";
import {
  DEFAULT_WORKBENCH_PANEL_IDS,
  WORKBENCH_PANEL_CATALOG,
  workbenchPresetGeometry,
} from "../src/renderer/panel-workspace/workbench-panels.tsx";
import {
  readPanelWorkspaceSelection,
  writePanelWorkspaceSelection,
  type PanelWorkspaceStorage,
} from "../src/renderer/panel-workspace/panel-workspace-layout.ts";
import { deriveRuntimeHealth } from "../src/renderer/model/runtime-health.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";

/**
 * 工作台面板目录与自由组合(task_48fe291624e06a2e9ad9496c81)的行为面:
 * 有限目录(原三块默认 + 五个可选)、添加/移除(目录开关与面板标签关闭钮)、
 * 选择集合按工作区分槽持久化、重置回默认、空画布可找回、存储失败可见。
 * 面板读面在 happy-dom 中无传输层,查询按真实错误路径落进面板内的错误显示——
 * 这正是「保留真实交互和错误显示」的断言对象,不用静态摘要桩掉。
 */
const noop = () => undefined;
const mounted: { root: Root; container: HTMLElement }[] = [];

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  setActiveLocale("zh-CN");
});

afterEach(() => {
  while (mounted.length > 0) {
    const { root, container } = mounted.pop()!;
    act(() => {
      root.unmount();
    });
    container.remove();
  }
});

function mapStorage(
  seed: Record<string, string> = {},
): PanelWorkspaceStorage & { readonly store: Map<string, string> } {
  const store = new Map(Object.entries(seed));
  return {
    store,
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
  };
}

function failingWriteStorage(): PanelWorkspaceStorage {
  const disk = mapStorage();
  return {
    getItem: disk.getItem,
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
    removeItem: disk.removeItem,
  };
}

const WORKBENCH_BASE_PROPS = {
  repoId: "repo-wb",
  tasks: [],
  relations: [],
  decisions: [],
  facts: [],
  onNavigateEntity: noop,
  onOpenPalette: noop,
  agenda: undefined,
  works: undefined,
  titles: new Map<string, string>(),
  workspaceSummary: null,
  workspaceSummaryError: null,
  health: deriveRuntimeHealth({
    daemon: null,
    repo: null,
    projection: null,
    lastSnapshotAt: null,
    now: "2026-10-03T00:00:00.000Z",
  }),
  onOpenTask: noop,
  onOpenSessions: noop,
  onUnpinTask: noop,
};

/** 离散 flush:让 dockview 增删、面板读面的失败落定(不是墙钟等待)。 */
async function settle(): Promise<void> {
  for (let round = 0; round < 3; round += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function mountWorkbench(storage: PanelWorkspaceStorage, workspaceKey = "local/repo-wb") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(PanelWorkbenchView, {
          ...WORKBENCH_BASE_PROPS,
          workspaceKey,
          storage,
        }),
      ),
    );
  });
  await settle();
  return container;
}

function mountedPanelIds(container: HTMLElement): string[] {
  // 面板宿主(floating-panel-body)是唯一权威;标签头上的放大/关闭钮也带 data-panel-id,不计。
  return [...container.querySelectorAll<HTMLElement>('[data-testid="floating-panel-body"][data-panel-id]')].map(
    (node) => node.dataset.panelId!,
  );
}

function click(scope: HTMLElement, testId: string): void {
  // 目录气泡的面板 portal 到 body,不在挂载容器里;统一从 body 查。
  const target = (scope === document.body ? scope : document.body).querySelector<HTMLElement>(
    `[data-testid="${testId}"]`,
  );
  if (target === null) throw new Error(`missing ${testId}`);
  act(() => {
    target.click();
  });
}

/** 打开页头的面板目录气泡(点外不关,条目点击走同一 DOM 路径)。 */
function openCatalog(container: HTMLElement): void {
  click(container, "panel-catalog-button");
}

describe("workbench panel catalog composition (task_48fe291624e06a2e9ad9496c81)", () => {
  it("offers a finite catalog of eight real panels with the PR3253 three as defaults", () => {
    expect(WORKBENCH_PANEL_CATALOG.map((entry) => entry.id)).toEqual([
      "documents",
      "graph",
      "timeline",
      "overview",
      "sessions",
      "schedules",
      "artifacts",
      "providers",
    ]);
    expect(DEFAULT_WORKBENCH_PANEL_IDS).toEqual(["documents", "graph", "timeline"]);
  });

  it("mounts only the default three panels on first entry", async () => {
    const container = await mountWorkbench(mapStorage());
    expect(mountedPanelIds(container)).toEqual(["documents", "graph", "timeline"]);
  });

  it("catalog popover lists all eight entries and marks the open ones", async () => {
    const container = await mountWorkbench(mapStorage());
    openCatalog(container);
    const entries = [...document.body.querySelectorAll<HTMLElement>('[data-testid^="panel-catalog-entry-"]')];
    expect(entries.map((node) => node.dataset.testid)).toEqual(
      WORKBENCH_PANEL_CATALOG.map((entry) => `panel-catalog-entry-${entry.id}`),
    );
    for (const entry of WORKBENCH_PANEL_CATALOG) {
      const node = document.body.querySelector<HTMLElement>(`[data-testid="panel-catalog-entry-${entry.id}"]`);
      expect(node?.getAttribute("aria-pressed")).toBe(entry.defaultOpen ? "true" : "false");
    }
  });

  it("adds a panel from the catalog, mounts its real body, and persists the selection", async () => {
    const disk = mapStorage();
    const container = await mountWorkbench(disk);
    openCatalog(container);
    click(container, "panel-catalog-entry-schedules");
    await settle();
    expect(mountedPanelIds(container)).toContain("schedules");
    // 真实功能体:计划面板读 repo.schedules.list,读失败走面板内错误显示,不是静态摘要。
    expect(container.querySelector('[data-testid="schedules-read-error"]')).not.toBeNull();
    expect(readPanelWorkspaceSelection(disk, "local/repo-wb")).toEqual(["documents", "graph", "timeline", "schedules"]);
  });

  it("close button on a panel tab removes the panel and updates the stored selection", async () => {
    const disk = mapStorage();
    const container = await mountWorkbench(disk);
    const closeButton = container.querySelector<HTMLElement>(
      '[data-testid="floating-panel-close"][data-panel-id="documents"]',
    );
    expect(closeButton).not.toBeNull();
    act(() => {
      closeButton!.click();
    });
    await settle();
    expect(mountedPanelIds(container)).not.toContain("documents");
    expect(readPanelWorkspaceSelection(disk, "local/repo-wb")).toEqual(["graph", "timeline"]);
  });

  it("closing every panel shows the findable empty state and panels can be added back", async () => {
    const disk = mapStorage();
    const container = await mountWorkbench(disk);
    expect(container.querySelector('[data-testid="panel-workbench-empty"]')).toBeNull();
    openCatalog(container);
    for (const id of ["documents", "graph", "timeline"]) {
      click(container, `panel-catalog-entry-${id}`);
    }
    await settle();
    expect(mountedPanelIds(container)).toEqual([]);
    expect(container.querySelector('[data-testid="panel-workbench-empty"]')).not.toBeNull();
    expect(readPanelWorkspaceSelection(disk, "local/repo-wb")).toEqual([]);
    click(container, "panel-catalog-entry-graph");
    await settle();
    expect(mountedPanelIds(container)).toEqual(["graph"]);
  });

  it("reset restores the default three and clears the stored slot", async () => {
    const disk = mapStorage();
    writePanelWorkspaceSelection(disk, "local/repo-wb", ["graph", "providers"]);
    const container = await mountWorkbench(disk);
    expect(mountedPanelIds(container)).toEqual(["graph", "providers"]);
    click(container, "panel-workbench-reset");
    await settle();
    expect(mountedPanelIds(container)).toEqual(["documents", "graph", "timeline"]);
    expect(readPanelWorkspaceSelection(disk, "local/repo-wb")).toBeNull();
  });

  it("keeps selections isolated per workspace (connection target + repo)", async () => {
    const disk = mapStorage();
    writePanelWorkspaceSelection(disk, "local/repo-wb", ["timeline"]);
    const otherRepo = await mountWorkbench(disk, "local/repo-other");
    expect(mountedPanelIds(otherRepo)).toEqual(["documents", "graph", "timeline"]);
    const otherEdge = await mountWorkbench(disk, "center-1/repo-wb");
    expect(mountedPanelIds(otherEdge)).toEqual(["documents", "graph", "timeline"]);
    expect(readPanelWorkspaceSelection(disk, "local/repo-wb")).toEqual(["timeline"]);
  });

  it("surfaces selection persistence failure instead of pretending it was saved", async () => {
    const container = await mountWorkbench(failingWriteStorage());
    expect(container.querySelector('[data-testid="panel-selection-persist-status"]')).toBeNull();
    openCatalog(container);
    click(container, "panel-catalog-entry-overview");
    await settle();
    // 本会话排布照常生效(面板挂上),失败状态可见。
    expect(mountedPanelIds(container)).toContain("overview");
    expect(container.querySelector('[data-testid="panel-selection-persist-status"]')).not.toBeNull();
  });
});

describe("workbench preset geometry", () => {
  it("keeps the PR3253 tiling for the default three on a wide canvas", () => {
    const preset = workbenchPresetGeometry({ width: 1600, height: 900 });
    const column = Math.floor((1600 - 64) / 4);
    expect(preset.documents).toEqual({ x: 16, y: 16, width: column, height: 900 - 32 });
    expect(preset.graph).toEqual({ x: 32 + column, y: 16, width: column * 2, height: 900 - 32 });
    expect(preset.timeline).toEqual({ x: 48 + column * 3, y: 16, width: column, height: 900 - 32 });
  });

  it("gives every optional panel a deterministic cascade spot inside the canvas", () => {
    const preset = workbenchPresetGeometry({ width: 1200, height: 800 });
    for (const entry of WORKBENCH_PANEL_CATALOG) {
      const geometry = preset[entry.id];
      expect(geometry, entry.id).toBeDefined();
      expect(geometry!.x).toBeGreaterThanOrEqual(16);
      expect(geometry!.y).toBeGreaterThanOrEqual(16);
      expect(geometry!.x + geometry!.width).toBeLessThanOrEqual(1200);
      expect(geometry!.y + geometry!.height).toBeLessThanOrEqual(800);
    }
    // 目录序错位级联:后一个可选面板比前一个更靠右下。
    expect(preset.sessions!.x).toBeGreaterThan(preset.overview!.x);
    expect(preset.providers!.x).toBeGreaterThan(preset.artifacts!.x);
  });

  it("never prescribes an optional panel wider or taller than a narrow canvas", () => {
    // 默认三块沿用 PR3253 平铺公式(窄画布下列宽有下限,允许出画布,由 dockview 的
    // 视口最小保留拉回 + 重置兜底);新增可选面板的级联预设不引入同类出画布。
    const preset = workbenchPresetGeometry({ width: 360, height: 320 });
    for (const entry of WORKBENCH_PANEL_CATALOG.filter((candidate) => !candidate.defaultOpen)) {
      const geometry = preset[entry.id]!;
      expect(geometry.x + geometry.width, entry.id).toBeLessThanOrEqual(360);
      expect(geometry.y + geometry.height, entry.id).toBeLessThanOrEqual(320);
    }
  });
});
