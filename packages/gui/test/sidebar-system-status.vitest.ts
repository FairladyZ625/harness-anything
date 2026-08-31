// harness-test-tier: fast
// @vitest-environment happy-dom
import { beforeAll, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { AppSidebar } from "../src/renderer/components/AppSidebar.tsx";
import {
  LedgerStatusBar,
  SystemStatusPanel,
  systemHealthDetail,
} from "../src/renderer/components/sidebar/SystemStatusPanel.tsx";
import { deriveRuntimeHealth } from "../src/renderer/model/runtime-health.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";
import { NAV_GROUPS } from "../src/renderer/navigation/navConfig.tsx";

/**
 * 2026-08-31 泽宇反馈两条缺陷的回归面:
 *  ① 侧栏矮窗口无滚动、导航项互相重叠 —— 旧 aside 是 `md:overflow-visible` 且没有
 *     内部滚动容器,内容高(≈830px)超过视口时既不裁切也不滚动。
 *  ② 总览「运行时健康」区块 + 左上角事件刷新条分居两处 —— 现在合并为侧栏左下角
 *     常驻紧凑系统运行区。
 *
 * happy-dom 不做真实布局,无法直接断言「不重叠」;这里锁住的是造成重叠的结构不变量:
 * aside 自己不滚动(overflow-hidden)+ 导航全部在唯一的 `overflow-y-auto` 滚动容器里
 * + 系统运行区/账号区在滚动容器之外(shrink-0 固定底部)。破坏任一条,矮窗口就会
 * 回到「溢出压主区 / 双滚动条」两种坏形之一。
 */

const NOW = "2026-08-31T12:00:00.000Z";

const healthy = deriveRuntimeHealth({
  daemon: { ok: true, observedAt: "2026-08-31T11:59:55.000Z", uptimeMs: 3_600_000 },
  repo: { cellState: "attached", queueDepth: 0, lastError: null, unavailableReason: null },
  projection: { watermark: 100, sourceRevision: 100, status: "ready" },
  lastSnapshotAt: "2026-08-31T11:00:00.000Z",
  now: NOW,
});

const degraded = deriveRuntimeHealth({
  daemon: { ok: true, observedAt: "2026-08-31T11:30:00.000Z", uptimeMs: null },
  repo: { cellState: "unavailable", queueDepth: 3, lastError: null, unavailableReason: "cell crashed during scan" },
  projection: { watermark: 90, sourceRevision: 97, status: "pending" },
  lastSnapshotAt: null,
  now: NOW,
});

const ledgerStatus = {
  revision: 42_120,
  refreshedAgoSec: 4,
  connected: true,
  refreshing: false,
  empty: false,
  error: null,
};

const project = {
  id: "repo",
  name: "harness-anything",
  path: "/repo",
  preset: "software/coding",
  engines: [],
  watermarkAt: NOW,
};

function sidebarMarkup() {
  return renderToStaticMarkup(
    createElement(AppSidebar, {
      project,
      repos: [],
      activeRepoId: "repo",
      view: "overview",
      hasSelection: false,
      inboxCount: 0,
      projectSwitcherOpen: false,
      onProjectSwitcherToggle: () => undefined,
      onOpenProject: () => undefined,
      onOpenProjectManager: () => undefined,
      onNavigate: () => undefined,
      ledgerStatus,
      onRefreshLedger: () => undefined,
      health: healthy,
      onOpenSystem: () => undefined,
    }),
  );
}

beforeAll(() => {
  setActiveLocale("zh-CN");
});

describe("sidebar scrolling structure (short-window overlap fix)", () => {
  // 取标记放在用例内:locale 必须先切到 zh-CN,模块顶层的求值会抢在 beforeAll 之前。
  const markup = () => sidebarMarkup();

  it("keeps the aside itself from scrolling and puts every nav group in one scroll container", () => {
    const markupText = markup();
    const aside = markupText.match(/<aside[^>]*>/u)![0]!;
    expect(aside).toContain("overflow-hidden");
    // 旧缺陷根因:md+ 关掉裁切让内容溢出压主区。
    expect(aside).not.toContain("md:overflow-visible");
    expect(aside).not.toContain("overflow-y-auto");

    const scroll = markupText.match(/data-testid="app-sidebar-scroll"[^>]*/u)![0]!;
    expect(scroll).toContain("overflow-y-auto");
    expect(scroll).toContain("min-h-0");
    expect(scroll).toContain("flex-1");
    // 滚动容器在标记里只出现一次:侧栏内不产生第二条纵向滚动条。
    expect(markupText.match(/app-sidebar-scroll/gu)).toHaveLength(1);

    const scrollStart = markupText.indexOf('data-testid="app-sidebar-scroll"');
    const navs = [...markupText.matchAll(/<nav[\s>]/gu)].map((found) => found.index ?? -1);
    // 每个分组各渲染一个 nav,且全部开在滚动容器之内 → 都能被滚到,而不是固定溢出。
    expect(navs).toHaveLength(NAV_GROUPS.length);
    for (const at of navs) expect(at).toBeGreaterThan(scrollStart);
  });

  it("pins the system status area and the account row below the scroll region, not inside it", () => {
    const markupText = markup();
    // 滚动容器的关闭在最后一个导航分组之后;固定底部区在那之后才开始。
    const lastNav = markupText.lastIndexOf("</nav>");
    const scrollClose = markupText.indexOf("</div>", lastNav);
    const statusAt = markupText.indexOf('data-testid="sidebar-system-status"');
    const accountAt = markupText.indexOf("md:block");
    expect(lastNav).toBeGreaterThan(-1);
    expect(statusAt).toBeGreaterThan(scrollClose);
    expect(accountAt).toBeGreaterThan(statusAt);
    // 固定底部区自身不引入第二条纵向滚动条(侧栏只有导航区一个滚动容器)。
    const pinned = markupText.slice(scrollClose, markupText.indexOf("</aside>"));
    expect(pinned).not.toContain("overflow-y-auto");
    expect(pinned).not.toContain("overflow-y-scroll");
    // 账号区与系统状态区都是 shrink-0,矮窗口下不会把导航区挤没,也不会互相重叠。
    expect(pinned).toContain("shrink-0");
  });
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

describe("SystemStatusPanel(侧栏左下角紧凑系统运行区)", () => {
  it("keeps every migrated fact visible: events, refresh time, health lamp, revisions, system exit", async () => {
    const onRefresh = vi.fn();
    const onOpenSystem = vi.fn();
    const { div, root } = await mount(
      createElement(SystemStatusPanel, { status: ledgerStatus, health: healthy, onRefresh, onOpenSystem }),
    );
    const panel = div.querySelector('[data-testid="sidebar-system-status"]') as HTMLElement;
    expect(panel).not.toBeNull();
    // 事件水位 + 刷新时间(原左上角状态栏)与 e2e 就绪探针 testid 一起搬来。
    expect(panel.querySelector('[data-testid="real-task-summary"]')?.textContent).toContain("42,120");
    expect(panel.textContent).toContain("刚刚");
    expect(panel.querySelector('[data-testid="ledger-refresh-button"]')).not.toBeNull();
    // 运行健康:灯色词 + 观测年龄 + 投影落后 revisions。
    expect(panel.textContent).toContain("运行正常");
    expect(panel.textContent).toContain("观测于");
    expect(panel.querySelector('[data-testid="sidebar-system-status-projection"]')?.textContent).toContain(
      "落后 0 revisions",
    );
    expect(panel.querySelector('[data-testid="sidebar-system-status-lamp"]')?.className).toContain("bg-success");
    // 系统页入口仍在本区(不新开页面,详情走既有「系统」页)。
    await act(async () => {
      (div.querySelector('[data-testid="sidebar-system-status-open"]') as HTMLButtonElement).click();
    });
    expect(onOpenSystem).toHaveBeenCalledTimes(1);
    await act(async () => {
      (div.querySelector('[data-testid="ledger-refresh-button"]') as HTMLButtonElement).click();
    });
    expect(onRefresh).toHaveBeenCalledTimes(1);
    await act(async () => {
      root.unmount();
    });
  });

  it("carries the four health signals that left the overview into the hover tooltip", () => {
    const detail = systemHealthDetail(healthy);
    expect(detail).toContain("台账服务");
    expect(detail).toContain("响应正常");
    expect(detail).toContain("1h 0m 0s");
    expect(detail).toContain("attached");
    expect(detail).toContain("落后 0 revisions");
    expect(detail).toContain("最新台账变化");
    // 绝对时刻按显示时区格式化,这里只锁「相对年龄 + 绝对时刻」两段都在。
    expect(detail).toMatch(/最新台账变化: 60 分钟前 · \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/u);
  });

  it("turns the lamp red and still names every degraded signal instead of hiding it", async () => {
    const { div, root } = await mount(
      createElement(SystemStatusPanel, {
        status: { ...ledgerStatus, connected: false, error: "bridge down" },
        health: degraded,
        onRefresh: () => undefined,
        onOpenSystem: () => undefined,
      }),
    );
    const panel = div.querySelector('[data-testid="sidebar-system-status"]') as HTMLElement;
    expect(panel.textContent).toContain("不可用");
    expect(panel.querySelector('[data-testid="sidebar-system-status-lamp"]')?.className).toContain("bg-danger");
    expect(panel.querySelector('[data-testid="sidebar-system-status-projection"]')?.textContent).toContain(
      "落后 7 revisions",
    );
    expect(panel.textContent).toContain("bridge down");
    const detail = systemHealthDetail(degraded);
    expect(detail).toContain("无响应");
    expect(detail).toContain("unavailable");
    expect(detail).toContain("队列深度 3");
    expect(detail).toContain("cell crashed during scan");
    expect(detail).toContain("投影追赶中");
    expect(detail).toContain("本会话未观察到台账变化");
    await act(async () => {
      root.unmount();
    });
  });

  it("still exposes the empty/error/summary testids e2e uses as readiness probes", async () => {
    const empty = renderToStaticMarkup(
      createElement(LedgerStatusBar, {
        status: { ...ledgerStatus, revision: 0, empty: true, refreshing: true },
        onRefresh: () => undefined,
      }),
    );
    expect(empty).toContain('data-testid="task-empty-state"');
    const errored = renderToStaticMarkup(
      createElement(LedgerStatusBar, {
        status: { ...ledgerStatus, connected: false, error: "boom" },
        onRefresh: () => undefined,
      }),
    );
    expect(errored).toContain('data-testid="task-error-state"');
  });
});
