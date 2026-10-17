// harness-test-tier: fast
// @vitest-environment happy-dom
import { beforeAll, afterEach, describe, expect, it } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";
import { HomeOverviewView } from "../src/renderer/views/home/HomeOverviewView.tsx";
import { homeOverviewQueryKeys } from "../src/renderer/views/home/home-overview-data.ts";
import type { DaemonHomeOverviewResult } from "@harness-anything/daemon/protocol";

/**
 * 重构区「主页」(dec_C612E69B7C7E3480A5F9D2CAD3):跨仓聚合一屏的行为判据。
 * 数据由 daemon.gui.home.read 单点算好,这里锁住展示契约:
 * 活跃仓一仓一行三数字、离线仓数字显 — 不显 0、静止仓折叠收纳、点击事项带 taskId 跳转。
 */

const OVERVIEW: DaemonHomeOverviewResult = {
  schema: "daemon.gui.home-overview/v1",
  ok: true,
  observedAt: "2026-10-18T02:00:00.000Z",
  repos: [
    {
      repoId: "harness-anything",
      displayName: "harness-anything",
      canonicalRoot: "/repo/harness-anything",
      authoredBranch: "main",
      registrationState: "enabled",
      mode: "local",
      cellState: "attached",
      status: "online",
      unavailableReason: null,
      waitingCount: 2,
      runningCount: 1,
      deliveredCount: 1,
      topMatters: [
        {
          key: "await-rel-1",
          tag: "等你",
          text: "待确认设计方案 · 需要你确认主页布局",
          tone: "danger",
          taskId: "task_123",
        },
        { key: "group-running-1", tag: "在跑", text: "后台索引重建 · Worker 正在执行", tone: "active" },
      ],
      isQuiet: false,
      lastActivityAt: "2026-10-18T01:59:00.000Z",
    },
    {
      repoId: "drg-hospital-platform",
      displayName: "drg-hospital-platform",
      canonicalRoot: null,
      authoredBranch: null,
      registrationState: "enabled",
      mode: "remote-edge",
      cellState: "unavailable",
      status: "unavailable",
      unavailableReason: "边缘节点未连接 (replica_unavailable)",
      waitingCount: null,
      runningCount: null,
      deliveredCount: null,
      topMatters: [{ key: "offline-drg", tag: "不可达", text: "边缘节点未连接 (replica_unavailable)", tone: "danger" }],
      isQuiet: false,
      lastActivityAt: null,
    },
    {
      repoId: "quiet-notes",
      displayName: "quiet-notes",
      canonicalRoot: "/repo/quiet-notes",
      authoredBranch: "main",
      registrationState: "enabled",
      mode: "local",
      cellState: "attached",
      status: "online",
      unavailableReason: null,
      waitingCount: 0,
      runningCount: 0,
      deliveredCount: 0,
      topMatters: [{ key: "ready-quiet", tag: "就绪", text: "全部就绪无待办", tone: "neutral" }],
      isQuiet: true,
      lastActivityAt: null,
    },
  ],
};

function mountView(
  host: HTMLElement,
  onOpenProject: (repoId: string, targetView?: "agenda" | "work" | "overview", taskId?: string) => void,
): Root {
  const queryClient = new QueryClient();
  queryClient.setQueryData(homeOverviewQueryKeys.all(), OVERVIEW);
  const root = createRoot(host);
  act(() => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(HomeOverviewView, {
          currentRepoId: "harness-anything",
          onOpenProject,
          onOpenProjectInNewWindow: () => {},
        }),
      ),
    );
  });
  return root;
}

describe("重构区主页(跨仓聚合)", () => {
  beforeAll(() => setActiveLocale("zh-CN"));
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("活跃仓一仓一行:仓库名 + 三数字横排 + 事项,当前仓有标记", () => {
    const host = document.createElement("div");
    const root = mountView(host, () => {});
    document.body.append(host);
    const row = host.querySelector('[data-testid="home-repo-row-harness-anything"]');
    expect(row).not.toBeNull();
    const metrics = row!.querySelector('[data-testid="home-repo-metrics-harness-anything"]')!;
    expect(metrics.textContent).toContain("2");
    expect(metrics.textContent).toContain("1");
    expect(row!.querySelector('[data-testid="home-repo-current-harness-anything"]')).not.toBeNull();
    expect(row!.textContent).toContain("需要你确认主页布局");
    act(() => root.unmount());
  });

  it("离线仓数字显示 — 而不是 0,并给出原因", () => {
    const host = document.createElement("div");
    const root = mountView(host, () => {});
    document.body.append(host);
    const metrics = host.querySelector('[data-testid="home-repo-metrics-drg-hospital-platform"]')!;
    expect(metrics.querySelectorAll(".font-mono.font-semibold")[0]!.textContent).toBe("—");
    expect(host.textContent).toContain("离线/不可达");
    expect(host.textContent).toContain("边缘节点未连接");
    act(() => root.unmount());
  });

  it("静止仓默认折叠,点开才列出", () => {
    const host = document.createElement("div");
    const root = mountView(host, () => {});
    document.body.append(host);
    const section = host.querySelector('[data-testid="home-overview-quiet-section"]')!;
    expect(section.querySelector('[data-testid="home-repo-row-quiet-notes"]')).toBeNull();
    act(() => {
      section.querySelector<HTMLButtonElement>('[data-testid="home-overview-quiet-toggle"]')!.click();
    });
    expect(section.querySelector('[data-testid="home-repo-row-quiet-notes"]')).not.toBeNull();
    act(() => root.unmount());
  });

  it("点事项带 taskId 回调跳转,点仓库名进入该仓", () => {
    const opened: { repoId: string; targetView?: string; taskId?: string }[] = [];
    const host = document.createElement("div");
    const root = mountView(host, (repoId, targetView, taskId) => {
      opened.push({ repoId, targetView, taskId });
    });
    document.body.append(host);
    act(() => {
      host.querySelector<HTMLButtonElement>('[data-testid="home-repo-row-harness-anything"] .ui-micro button')!.click();
    });
    act(() => {
      host.querySelector<HTMLButtonElement>('[data-testid="home-repo-name-drg-hospital-platform"]')!.click();
    });
    expect(opened[0]).toEqual({ repoId: "harness-anything", targetView: "work", taskId: "task_123" });
    expect(opened[1]).toEqual({ repoId: "drg-hospital-platform" });
    act(() => root.unmount());
  });
});
