// harness-test-tier: fast
// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { AppSidebar } from "../src/renderer/components/AppSidebar.tsx";
import { NavigationHistoryBar } from "../src/renderer/components/NavigationHistoryBar.tsx";
import { applyWindowChromePlatformMarker } from "../src/renderer/platform.ts";

// macOS 去系统标题栏(task_e2786fc223f0a039317cc649d2):窗口成为 hiddenInset 后,应用
// 自己的两处顶行(主区前进/后退行、侧栏 HARNESS 行)必须自带拖拽区类,行内交互件摘出
// no-drag,侧栏顶行给红绿灯让位。组件无条件带类,CSS 按 html[data-platform="mac"] 生效,
// 所以非 mac 平台行为不变。

it("主区前进/后退行是拖拽区,两个按钮摘出 no-drag", async () => {
  const host = document.createElement("div"),
    root = createRoot(host);
  await act(async () =>
    root.render(<NavigationHistoryBar canBack onBack={() => {}} canForward={false} onForward={() => {}} />),
  );

  const bar = host.querySelector('[data-testid="nav-history-bar"]')!;
  expect(bar.className).toContain("titlebar-drag");
  const buttons = bar.querySelectorAll("button");
  expect(buttons).toHaveLength(2);
  for (const button of buttons) expect(button.className).toContain("titlebar-no-drag");

  // 按钮照常可点:拖拽类不得吞掉行内交互件的点击。
  const onBack = vi.fn();
  await act(async () =>
    root.render(<NavigationHistoryBar canBack onBack={onBack} canForward={false} onForward={() => {}} />),
  );
  await act(async () => bar.querySelectorAll("button")[0]!.click());
  expect(onBack).toHaveBeenCalledOnce();

  act(() => root.unmount());
});

it("侧栏顶行(HARNESS 行)是拖拽区并在顶部给红绿灯让位,主题切换摘出 no-drag", async () => {
  const host = document.createElement("div"),
    root = createRoot(host),
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <AppSidebar
          project={{ name: "harness-anything", preset: "standard-task" } as never}
          repos={[]}
          activeRepoId={null}
          view="home"
          hasSelection={false}
          poolBadgeCount={undefined}
          projectSwitcherOpen={false}
          onProjectSwitcherToggle={() => {}}
          onOpenProject={() => {}}
          onOpenProjectManager={() => {}}
          onNavigate={() => {}}
          pinnedWork={[]}
          onOpenPinned={() => {}}
          onUnpinWork={() => {}}
          ledgerStatus={{
            revision: 1,
            refreshedAgoSec: 0,
            connected: true,
            refreshing: false,
            empty: false,
            error: null,
          }}
          health={
            {
              daemon: { state: "responsive", observedAgeSec: 0, uptimeMs: 0 },
              cell: { state: "loaded", queueDepth: 0, problem: null },
              projection: { lag: 0, status: "ready" },
              ledgerChange: { at: null, ageSec: null },
            } as never
          }
          onOpenSystem={() => {}}
        />
      </QueryClientProvider>,
    ),
  );

  const topRow = host.querySelector('[data-testid="app-sidebar-head"] > div')!;
  expect(topRow.className).toContain("titlebar-drag");
  expect(topRow.className).toContain("titlebar-traffic-top");
  // 行内唯一交互件(主题切换)整棵子树摘出拖拽。
  const toggleWrap = topRow.querySelector(".ml-auto")!;
  expect(toggleWrap.className).toContain("titlebar-no-drag");

  act(() => root.unmount());
  client.clear();
});

it("平台标记是窗口 chrome 的唯一判断点:mac 打 mac 并按缩放换算红绿灯留白,其余只打 other", () => {
  applyWindowChromePlatformMarker(document, { platform: "MacIntel", userAgent: "any" });
  expect(document.documentElement.dataset.platform).toBe("mac");
  // 留白 = (圆底 27.5pt + 8pt 呼吸位) × 点/px 比率,happy-dom 下比率为 1 → 36px。
  expect(document.documentElement.style.getPropertyValue("--titlebar-top-inset")).toBe("36px");

  applyWindowChromePlatformMarker(document, { platform: "Win32", userAgent: "Windows NT" });
  expect(document.documentElement.dataset.platform).toBe("other");
  expect(document.documentElement.style.getPropertyValue("--titlebar-top-inset")).toBe("");

  // 判定仍复用 ⌘ 快捷键那条 navigator 判据:platform 与 userAgent 任一命中 Mac 即 mac。
  applyWindowChromePlatformMarker(document, { platform: "Linux x86_64", userAgent: "Macintosh" });
  expect(document.documentElement.dataset.platform).toBe("mac");
});
