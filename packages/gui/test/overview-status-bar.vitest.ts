// harness-test-tier: fast
// @vitest-environment happy-dom
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { LedgerStatusBar } from "../src/renderer/components/sidebar/SystemStatusPanel.tsx";
import { OverviewStatsBar } from "../src/renderer/components/overview/OverviewStatsBar.tsx";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";
import type { WorkspaceSummaryRead } from "../src/renderer/../api/renderer-dto.ts";

/**
 * task_b2fb4bc7:一行实时状态栏取代侧栏统计块,统计数字搬到总览底部折叠条。
 * 2026-08-31 收纳后状态栏随系统运行区住在侧栏左下角(components/sidebar/
 * SystemStatusPanel.tsx)。`real-task-summary` 这个 testid 是读基线工具与两条 e2e
 * 的就绪探针,必须继续由状态栏承载 —— 这里专门锁住这条契约。
 */

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  setActiveLocale("zh-CN");
});

// 折叠态是持久偏好,用例之间必须归零,否则上一条的展开态泄进下一条。
beforeEach(() => {
  window.localStorage.clear();
});

async function mount(element: ReturnType<typeof createElement>) {
  const div = document.createElement("div");
  document.body.appendChild(div);
  const root = createRoot(div);
  await act(async () => {
    root.render(element);
  });
  return { div, root: root as Root };
}

describe("LedgerStatusBar(侧栏系统运行区第三行)", () => {
  it("单行,带事件总数、相对刷新时间、刷新按钮与绿点,并承载 real-task-summary", async () => {
    const onRefresh = vi.fn();
    const { div, root } = await mount(
      createElement(LedgerStatusBar, {
        status: { revision: 46_240, refreshedAgoSec: 4, connected: true, refreshing: false, empty: false, error: null },
        onRefresh,
      }),
    );
    const bar = div.querySelector('[data-testid="real-task-summary"]') as HTMLElement;
    expect(bar).not.toBeNull();
    expect(bar.className).not.toContain("block");
    expect(bar.textContent).toContain("46,240");
    expect(bar.textContent).toContain("刚刚");
    expect(div.querySelector('[data-testid="ledger-refresh-button"]')).not.toBeNull();
    expect(div.querySelector('[data-testid="ledger-connection-dot"]')?.className).toContain("bg-success");
    await act(async () => {
      (div.querySelector('[data-testid="ledger-refresh-button"]') as HTMLButtonElement).click();
    });
    expect(onRefresh).toHaveBeenCalledTimes(1);
    await act(async () => {
      root.unmount();
    });
  });

  it("读失败时圆点变红并保留 e2e 的 task-error-state 出口", async () => {
    const { div, root } = await mount(
      createElement(LedgerStatusBar, {
        status: {
          revision: null,
          refreshedAgoSec: null,
          connected: false,
          refreshing: false,
          empty: false,
          error: "boom",
        },
        onRefresh: () => undefined,
      }),
    );
    expect(div.querySelector('[data-testid="task-error-state"]')?.textContent).toContain("boom");
    await act(async () => {
      root.unmount();
    });
  });

  it("空台账保留 task-empty-state 出口;刷新中按钮禁用", async () => {
    const { div, root } = await mount(
      createElement(LedgerStatusBar, {
        status: { revision: 0, refreshedAgoSec: 30, connected: true, refreshing: true, empty: true, error: null },
        onRefresh: () => undefined,
      }),
    );
    expect(div.querySelector('[data-testid="task-empty-state"]')).not.toBeNull();
    expect((div.querySelector('[data-testid="ledger-refresh-button"]') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      root.unmount();
    });
  });
});

const summary = {
  tasks: {
    total: 91,
    byStatus: { planned: 3, active: 48, blocked: 12, in_review: 8, done: 18, cancelled: 2, unknown: 0 },
  },
  decisions: {
    total: 7,
    inboxCount: 1,
    byState: { proposed: 1, in_effect: 2, rejected: 1, deferred: 1, superseded: 1, outcome_retired: 1 },
    groups: [],
  },
} as unknown as WorkspaceSummaryRead;

describe("OverviewStatsBar(总览底部折叠统计条)", () => {
  it("默认折叠成一行统计,点开显示任务/决策分状态与版本对,折叠态记 localStorage", async () => {
    const { div, root } = await mount(
      createElement(OverviewStatsBar, {
        summary,
        revision: { watermark: 100, sourceRevision: 104 },
        anomalies: [],
      }),
    );
    expect(div.querySelector('[data-testid="overview-stats-toggle"]')?.textContent).toContain("统计");
    expect(div.textContent).toContain("91");
    expect(div.textContent).toContain("7");
    expect(div.querySelector('[data-testid="overview-stats-detail"]')).toBeNull();
    await act(async () => {
      (div.querySelector('[data-testid="overview-stats-toggle"]') as HTMLButtonElement).click();
    });
    expect(div.querySelector('[data-testid="overview-stats-detail"]')).not.toBeNull();
    expect(div.textContent).toContain("104");
    expect(JSON.parse(window.localStorage.getItem("harness:gui:overview-stats-expanded") ?? "null")).toBe(true);
    await act(async () => {
      root.unmount();
    });
  });

  it("任一异常指标时折叠态整条变红并点名异常项", async () => {
    const { div, root } = await mount(
      createElement(OverviewStatsBar, {
        summary,
        revision: { watermark: 100, sourceRevision: 104 },
        anomalies: [
          { code: "daemon", label: "daemon 无响应" },
          { code: "projection", label: "投影落后 4" },
        ],
      }),
    );
    const section = div.querySelector('[data-testid="overview-stats-bar"]') as HTMLElement;
    expect(section.className).toContain("bg-danger/10");
    expect(div.querySelector('[data-testid="overview-stats-anomaly"]')?.textContent).toContain("投影落后 4");
    // 异常只改色与文案,不替用户展开。
    expect(div.querySelector('[data-testid="overview-stats-detail"]')).toBeNull();
    await act(async () => {
      root.unmount();
    });
  });
});
